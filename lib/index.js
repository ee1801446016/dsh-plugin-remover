/**
 * dsh-plugin-remover — Host half.
 *
 * One contributed capability, in two halves:
 *
 *   1. Deleting one Session *conversation*: its durable log directories, its
 *      subagent descendants' logs, the files it produced, the files it read,
 *      the projection-cache row, and attachment objects nobody else references.
 *   2. A recycle bin, so a deletion is reversible: every removed file is moved
 *      into one per-deletion group under `<DSH_HOME>/dsh-plugin-remover/trash`,
 *      where it can be restored as a whole or one file at a time, and expires
 *      after a configurable number of days.
 *
 * DSH has no deletion API anywhere: `@deepseek-ai/dsh-session-persistence`
 * documents "No deletion or retention API — pruning stored sessions is
 * out-of-band backend maintenance", and the JSONL backend documents "Nothing
 * deletes session files". This plugin is that out-of-band maintenance, done from
 * inside the process so it can use the backend's own reader instead of
 * re-implementing Zstandard frame handling.
 *
 * Surfaces (all `POST`, all requiring this plugin's own request marker):
 *
 *   /api/health          liveness
 *   /api/scan            build the deletion plan for one Session
 *   /api/purge           execute a plan, into the recycle bin or permanently
 *   /api/hidden          subagent Sessions the harness hides from the sidebar
 *   /api/trash/list      recycle-bin groups and settings
 *   /api/trash/restore   restore a group or individual files
 *   /api/trash/delete    permanently delete groups or individual files
 *   /api/trash/sweep     drop groups past their retention
 *   /api/trash/settings  read or write retention days and size cap
 *
 * Safety invariants, all enforced here rather than in the browser:
 *
 *   * A Session id is validated as a single safe path segment before it is used
 *     to locate anything; no request value is ever concatenated into a path.
 *   * A recycle-bin group key and an item path are validated the same way, so a
 *     tampered request cannot address a file outside the trash root.
 *   * A produced or read file is touched only when its real path is strictly
 *     inside the recorded `cwd` of a Session being deleted, and never when it
 *     lies inside the DSH home.
 *   * The browser sends ids and booleans only. The Host re-derives the whole
 *     plan from the stored logs, so a tampered request cannot widen what is
 *     removed, and an id the Host did not itself produce resolves to nothing.
 *   * An attachment object is removed only after every other stored Session has
 *     been read and none references it; any read failure keeps it.
 *   * A file that cannot be moved into the recycle bin is never half-removed:
 *     the move copies, verifies the byte count, and only then drops the source.
 */

import { cp, mkdir, readdir, readFile, realpath, rename, rm, stat as fsStat, writeFile } from 'node:fs/promises'
import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** Package name the loader mounts this row as; also the browser module id. */
export const name = 'dsh-plugin-remover'

/** Version reported by `/health` and by the browser half's footer. */
export const version = '1.4.0'

/**
 * Services this half requires. `webServer` carries the routes; the persistence
 * seam is the only supported reader of a stored Session log, and it is never
 * absent from a composition that can list Sessions at all.
 */
export const inject = ['webServer', 'sessionPersistence']

/** Route prefix for this plugin's own JSON endpoints. */
const ROUTE = '/plugins/dsh-plugin-remover/api'

/**
 * A Session id is one path segment: letters, digits, dot, underscore, dash.
 * Every id DSH produces today (`<uuid>` and `session-<uuid>`) matches, and the
 * shape check is what makes joining it onto the sessions root safe.
 */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/

/** A recycle-bin group key or item path: one safe relative path segment chain. */
const GROUP_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/

/** Tools that write their target path, and the argument keys that carry it. */
const WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor', 'create_file'])

/** Tools that only read their target path. Their targets are reported, and are
 * deletable only when the user ticks them: reading a file is not producing it. */
const READ_TOOLS = new Set(['read', 'read_image'])

/** Argument keys that carry the target path, per writing/reading tool. */
const PATH_KEYS = ['file_path', 'path']

/** Largest request body this plugin accepts; a 500-row selection fits easily. */
const MAX_BODY_BYTES = 512 * 1024

/** How many artifact/attachment/group rows one response may carry. */
const MAX_REPORTED_ROWS = 500

/** Provenance caps, so one busy file cannot bloat a scan response. */
const MAX_SOURCES_PER_FILE = 16
const MAX_TOOLS_PER_FILE = 8

/**
 * How many refused paths the scan response carries.
 *
 * A refusal is a file the conversation named that this plugin will not delete,
 * and the reason matters more than the count: "outside the workspace" and "no
 * longer on disk" need completely different reactions from the reader. The list
 * is capped only so one pathological log cannot bloat the response.
 */
const MAX_REFUSED_ROWS = 200

/** How many candidates the attachment-mirror check will hash in one plan. */
const MIRROR_MAX_CANDIDATES = 64

/** Files larger than this are not hashed while looking for an attachment copy. */
const MIRROR_MAX_BYTES = 64 * 1024 * 1024

/** Recycle-bin defaults, overridable through `/trash/settings`. */
const DEFAULT_SETTINGS = {
  formatVersion: 1,
  retentionDays: 30,
  maxBytes: 2 * 1024 * 1024 * 1024,
  // The sidebar-foot shortcut is on by default: it is the fastest way back into
  // the recycle bin, and the plugin page keeps its own entry either way.
  showSidebarTrash: true,
}

/** Accepted bounds for the two numeric settings; `0` disables the rule it belongs to. */
const RETENTION_MAX_DAYS = 3650
const MAX_BYTES_CEILING = 1024 * 1024 * 1024 * 1024

/** How deep a subagent tree this plugin will walk. */
const MAX_DEPTH = 8

/** Resolve the DSH home exactly as the rest of the harness does. */
async function resolveHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  if (fromEnv !== '') return fromEnv
  try {
    // Present in every shipped composition; a dynamic import keeps this half
    // loadable even where the library cannot be resolved.
    const library = await import('@deepseek-ai/dsh-home-paths')
    if (typeof library.resolveDshHome === 'function') return library.resolveDshHome()
  } catch {
    // Fall through to the documented default.
  }
  return join(homedir(), '.dsh')
}

/** One short human-readable line for a caught value. */
function describe(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Whether `child` is strictly inside `parent`, comparing real paths. */
function inside(parent, child) {
  if (parent === child) return false
  const prefix = parent.endsWith(sep) ? parent : parent + sep
  return child.startsWith(prefix)
}

/**
 * Compare two filesystem paths the way a Windows identity check does.
 *
 * Case and separator folding, nothing else: this is used to answer "the same
 * directory?" and "inside this directory?", both of which are exact questions
 * once case is folded. It never resolves symlinks — callers pass real paths.
 *
 * @param left - one absolute path.
 * @param right - the other.
 * @returns whether they name the same location.
 */
function foldPath(value) {
  const slashed = String(value).replace(/[\\/]+/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed
}

/**
 * Whether `child` is at or inside `parent`, with case folded.
 * @param parent - directory that must contain the child.
 * @param child - candidate path.
 * @returns `true` when the child sits under the parent.
 */
function insideFolded(parent, child) {
  const outer = foldPath(parent)
  const inner = foldPath(child)
  if (outer === '') return false
  return inner === outer || inner.startsWith(`${outer}/`)
}

/**
 * Directories this plugin will never delete from, whatever a conversation says.
 *
 * A conversation can name any path it likes, and since 1.3.0 a path outside the
 * working directory is deletable. That makes the operating system's own tree the
 * one boundary that has to be drawn explicitly: an `edit` call against
 * `C:\Windows\...` in a log is far more likely to be a mistaken path than an
 * instruction to remove part of Windows.
 *
 * The DSH home is checked separately, because deleting it would take the plugin's
 * own recycle bin and the Session logs with it.
 *
 * @returns absolute directory paths, folded for comparison by the caller.
 */
function blockedRoots() {
  const roots = []
  const add = (value) => {
    if (typeof value === 'string' && value.trim() !== '') roots.push(value.trim())
  }
  if (process.platform === 'win32') {
    add(process.env.SystemRoot)
    add(process.env.windir)
    add(process.env.ProgramFiles)
    add(process.env['ProgramFiles(x86)'])
    add(process.env.ProgramData)
    // A machine with these unset is not a machine worth guessing about.
    add('C:\\Windows')
    add('C:\\Program Files')
    add('C:\\Program Files (x86)')
  } else {
    for (const root of ['/etc', '/usr', '/bin', '/sbin', '/lib', '/boot', '/System', '/Library', '/Applications']) add(root)
  }
  return roots
}

/**
 * Whether one resolved path sits inside an operating-system directory.
 * @param real - resolved absolute path.
 * @returns the matching root, or null when the path is ordinary user data.
 */
function blockingRootOf(real) {
  for (const root of blockedRoots()) {
    if (insideFolded(root, real)) return root
  }
  return null
}

/** Sum the bytes of every regular file under one directory, missing paths read as 0. */
async function directoryBytes(directory) {
  let total = 0
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const child = join(directory, entry.name)
    if (entry.isDirectory()) total += await directoryBytes(child)
    else if (entry.isFile()) {
      try {
        total += (await fsStat(child)).size
      } catch {
        // A file that vanished mid-walk contributes nothing.
      }
    }
  }
  return total
}

/**
 * Read a full request body as JSON.
 * @param req - incoming Node request.
 * @returns the parsed body; an absent body parses as `{}`.
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  return JSON.parse(text)
}

/** Answer one JSON response. */
function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Refuse anything that did not come from this plugin's own page.
 *
 * `/plugins` routes answer without the shell's session authorization, so a bare
 * endpoint here would let any local page or process trigger a deletion. The
 * marker header cannot be set by a cross-origin form or simple request (it
 * forces a preflight the web server does not answer), and the origin check
 * rejects a same-shape request from another page's origin.
 *
 * @param req - incoming request.
 */
function requireOwnPage(req) {
  if (req.headers?.['x-dsh-plugin-remover'] !== '1') throw new Error('缺少插件请求标记')
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '' || origin === 'null') return
  let originHost = null
  try {
    originHost = new URL(origin).host
  } catch {
    throw new Error('请求来源不合法')
  }
  const host = req.headers.host
  if (typeof host === 'string' && host !== '' && originHost !== host) throw new Error('已拒绝跨站请求')
}

/**
 * The Session creation header, whatever shape the backend's snapshot uses.
 * @param snapshot - result of `sessionPersistence.stat`.
 * @returns the header record, or null when the snapshot carries none.
 */
function headerOf(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object') return null
  const nested = snapshot.header
  if (nested !== null && typeof nested === 'object' && typeof nested.id === 'string') return nested
  if (typeof snapshot.id === 'string' && typeof snapshot.version === 'number') return snapshot
  return null
}

/**
 * Read one Session's stored events through the persistence seam.
 * @param persistence - the `sessionPersistence` service.
 * @param sessionId - validated Session id.
 * @returns the event list, plus a warning when the log could not be read.
 */
async function readEvents(persistence, sessionId) {
  let handle
  try {
    handle = await persistence.open(sessionId, 'read')
    const result = await handle.read()
    const events = Array.isArray(result?.events) ? result.events : []
    return { events, warning: undefined }
  } catch (error) {
    return { events: [], warning: `读取会话日志失败：${describe(error)}` }
  } finally {
    try {
      await handle?.close?.()
    } catch {
      // A close failure never changes the plan.
    }
  }
}

/**
 * Every attachment id any nested value in one event names.
 * @param value - event payload to walk.
 * @param into - accumulator.
 */
function collectAttachmentIds(value, into) {
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) collectAttachmentIds(item, into)
    return
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === 'attachmentId' && typeof child === 'string' && child !== '') into.add(child)
    else collectAttachmentIds(child, into)
  }
}

/**
 * Attachment ids plus the display metadata stored beside them.
 *
 * The id alone is a sha256 digest, which tells a person nothing: two images
 * pasted into the same conversation are two identical-looking hashes. The log
 * also records the original name, size and media type next to the id, so they
 * are collected here and shown in the dialog. Only the id is ever used to locate
 * bytes on disk; the rest is presentation.
 *
 * @param value - event payload to walk.
 * @param into - Map from attachment id to `{ id, name, bytes, mediaType }`.
 */
function collectAttachmentMeta(value, into) {
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) collectAttachmentMeta(item, into)
    return
  }
  const id = value.attachmentId
  if (typeof id === 'string' && id !== '') {
    const known = into.get(id)
    if (known === undefined) {
      into.set(id, {
        id,
        name: typeof value.name === 'string' && value.name !== '' ? value.name : null,
        bytes: typeof value.bytes === 'number' && value.bytes >= 0 ? value.bytes : null,
        mediaType: typeof value.mediaType === 'string' ? value.mediaType : null,
      })
    }
  }
  for (const child of Object.values(value)) collectAttachmentMeta(child, into)
}

/**
 * The file targets one Session's own tool calls named, with provenance.
 *
 * Written and read targets are kept apart: a written target is what the
 * conversation *produced*, a read target is only what it *looked at*. Both may
 * be deleted, but only after the user ticks them, and the dialog shows which is
 * which. A target whose relative path cannot be resolved (no recorded `cwd`)
 * is dropped rather than guessed.
 *
 * @param events - stored Session events.
 * @param cwd - the Session's recorded working directory, if any.
 * @returns `{ written, read }`, each a Map from absolute candidate path to
 *   `{ ops, tools: Set<string> }`.
 */
function collectToolPaths(events, cwd) {
  const written = new Map()
  const read = new Map()
  for (const event of events) {
    if (event?.type !== 'tool/call') continue
    const data = event.data ?? {}
    const tool = data.name
    if (typeof tool !== 'string') continue
    const target = WRITE_TOOLS.has(tool) ? written : READ_TOOLS.has(tool) ? read : null
    if (target === null) continue
    let args
    try {
      args = JSON.parse(typeof data.arguments === 'string' ? data.arguments : '{}')
    } catch {
      continue
    }
    if (args === null || typeof args !== 'object') continue
    const raw = PATH_KEYS.map(key => args[key]).find(value => typeof value === 'string' && value.trim() !== '')
    if (raw === undefined) continue
    const absolute = isAbsolute(raw) ? raw : cwd === undefined ? undefined : resolve(cwd, raw)
    if (absolute === undefined) continue
    const existing = target.get(absolute)
    if (existing === undefined) target.set(absolute, { ops: 1, tools: new Set([tool]) })
    else {
      existing.ops += 1
      existing.tools.add(tool)
    }
  }
  return { written, read }
}

/**
 * Directory names never worth walking while looking for changed files.
 *
 * These are dependency stores, version-control internals and build output. They
 * are not conversation products even when the conversation changed them, they
 * appear in enormous numbers, and listing them would bury the files a person
 * actually wants to see under thousands of rows. The walk is also depth- and
 * count-limited; this set is the cheap first filter.
 */
const NOISE_DIRECTORIES = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', '.next', '.nuxt',
  '__pycache__', '.venv', 'venv', 'target', '.idea', '.vscode', '.cache', 'coverage',
])

/** How deep the changed-file walk descends below each working directory. */
const CHANGED_MAX_DEPTH = 6

/** How many files one changed-file scan will report before truncating. */
const CHANGED_MAX_FILES = 2000

/** Slack added to each end of the window to absorb filesystem timestamp skew. */
const CHANGED_WINDOW_SLACK_MS = 5000

/**
 * The wall-clock span a Session's stored events cover.
 *
 * This is the only honest evidence of *when* a conversation could have touched
 * a file: the log records an event time, not a write time. A window is therefore
 * a candidate filter, never proof of authorship.
 *
 * @param events - stored Session events.
 * @returns `{ start, end }` in epoch milliseconds, or null when the log carries
 *   no usable timestamps.
 */
function collectTimeWindow(events) {
  let start = Infinity
  let end = -Infinity
  for (const event of events) {
    const time = event?.time
    if (typeof time !== 'number' || !Number.isFinite(time)) continue
    if (time < start) start = time
    if (time > end) end = time
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  return { start: start - CHANGED_WINDOW_SLACK_MS, end: end + CHANGED_WINDOW_SLACK_MS }
}

/**
 * Walk one directory, reporting regular files whose mtime falls inside a window.
 *
 * @param root - directory to walk; already known to be a real path.
 * @param window - `{ start, end }` from {@link collectTimeWindow}.
 * @param out - accumulator of absolute candidate paths.
 * @param depth - current recursion depth.
 * @param budget - mutable `{ left }` count so one huge tree cannot run forever.
 */
async function walkWindow(root, window, out, depth, budget) {
  if (depth > CHANGED_MAX_DEPTH || budget.left <= 0) return
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (budget.left <= 0) return
    const child = join(root, entry.name)
    if (entry.isDirectory()) {
      if (NOISE_DIRECTORIES.has(entry.name)) continue
      await walkWindow(child, window, out, depth + 1, budget)
      continue
    }
    if (!entry.isFile()) continue
    let info
    try {
      info = await fsStat(child)
    } catch {
      continue
    }
    if (info.mtimeMs < window.start || info.mtimeMs > window.end) continue
    budget.left -= 1
    out.push({ path: child, bytes: info.size, mtimeMs: info.mtimeMs })
  }
}

/**
 * Files that changed inside a working directory during a Session's time window.
 *
 * This exists because a conversation often does not write its products with a
 * tool that names a path: it runs a script through `pwsh`, or hands work to an
 * office tool, and the file appears without any `file_path` ever being recorded.
 * Those files are real and a person deleting the conversation wants to see them,
 * but the log cannot prove the conversation made them — so they are reported in
 * their own group, unselected by default, never folded into the produced list.
 *
 * Excluded by construction: anything already named by a tool call (so no path is
 * reported twice), anything under the DSH home, and anything outside the working
 * directory after resolving symlinks.
 *
 * @param cwds - real working directories of the Sessions being deleted.
 * @param window - `{ start, end }` from {@link collectTimeWindow}.
 * @param home - resolved DSH home.
 * @param known - absolute paths already reported by tool calls.
 * @returns `{ rows, truncated }` with rows shaped like {@link classifyItems}.
 */
async function scanChangedInWindow(cwds, window, home, known) {
  const rows = []
  if (window === null || cwds.length === 0) return { rows, truncated: false }
  let realHome = home
  try {
    realHome = await realpath(home)
  } catch {
    // An absent home cannot contain anything that exists.
  }
  const budget = { left: CHANGED_MAX_FILES }
  const seen = new Set()
  for (const cwd of cwds) {
    const found = []
    await walkWindow(cwd, window, found, 0, budget)
    for (const candidate of found) {
      let real
      try {
        real = await realpath(candidate.path)
      } catch {
        continue
      }
      if (seen.has(real)) continue
      if (!inside(cwd, real)) continue
      if (inside(realHome, real)) continue
      if (known.has(real)) continue
      seen.add(real)
      rows.push({
        id: artifactId(real),
        path: real,
        displayPath: candidate.path,
        dir: dirname(real),
        bytes: candidate.bytes,
        ops: 1,
        kind: 'changed',
        mtime: candidate.mtimeMs,
        tools: [],
        // Deliberately empty: nothing in the log attributes this file to a
        // conversation, and inventing a source would make the group look proven.
        sources: [],
      })
    }
  }
  rows.sort((left, right) => (right.mtime ?? 0) - (left.mtime ?? 0))
  return { rows, truncated: budget.left <= 0 }
}

/**
 * Merge one Session's targets into the tree-wide map, remembering who named it.
 * @param into - Map from absolute path to `{ ops, tools, sources }`.
 * @param from - that Session's targets from {@link collectToolPaths}.
 * @param source - the Session that reported them.
 */
function mergeProvenance(into, from, source) {
  for (const [path, row] of from) {
    let entry = into.get(path)
    if (entry === undefined) {
      entry = { ops: 0, tools: new Set(), sources: new Map() }
      into.set(path, entry)
    }
    entry.ops += row.ops
    for (const tool of row.tools) entry.tools.add(tool)
    const known = entry.sources.get(source.sessionId)
    if (known === undefined) {
      entry.sources.set(source.sessionId, { sessionId: source.sessionId, ops: row.ops, tools: new Set(row.tools), ...source })
    } else {
      known.ops += row.ops
      for (const tool of row.tools) known.tools.add(tool)
    }
  }
}

/**
 * A stable, path-independent id for one on-disk file.
 *
 * The browser selects files by id, never by path: the Host re-derives the same
 * ids from the stored logs on the purge request, so a tampered or stale
 * selection can only ever match files this conversation actually names.
 *
 * @param real - resolved absolute path.
 * @returns `a` plus the first 12 hex digits of its SHA-1.
 */
function artifactId(real) {
  return `a${createHash('sha1').update(real).digest('hex').slice(0, 12)}`
}

/**
 * Resolve which of the named paths may actually be deleted.
 *
 * A path is deletable when it is a regular file outside the DSH home (the app's
 * own data is never a conversation artifact) and outside the operating system's
 * own directories. Everything else is reported with the reason it was refused,
 * so the dialog can show why a file the conversation mentioned is not on the
 * list — a refusal the reader cannot see is indistinguishable from a bug.
 *
 * Each surviving row records its `scope`: `inside` when the file sits under a
 * working directory of a Session being deleted, `outside` otherwise. Files
 * outside used to be refused outright, which made a file the conversation
 * genuinely read in another directory impossible to delete from this dialog.
 * They are kept now, reported separately, and still have to be ticked one by
 * one: a path the log names is evidence that the conversation touched it, never
 * permission to remove a whole directory tree the user never looked at.
 *
 * @param paths - merged target map from {@link mergeProvenance}.
 * @param cwds - real paths of the working directories of the Sessions deleted.
 * @param home - resolved DSH home.
 * @param kind - `'artifact'` or `'referenced'`, recorded on each row.
 * @returns `allowed` rows and `refused` rows with a reason.
 */
async function classifyItems(paths, cwds, home, kind) {
  const allowed = []
  const refused = []
  if (cwds.length === 0) {
    for (const path of paths.keys()) refused.push({ path, reason: '会话未记录可用的工作目录，无法确认来源' })
    return { allowed, refused }
  }
  let realHome = home
  try {
    realHome = await realpath(home)
  } catch {
    // An absent home cannot contain anything that exists.
  }
  for (const [path, row] of paths) {
    let info
    try {
      info = await fsStat(path)
    } catch {
      refused.push({ path, reason: '文件已不存在' })
      continue
    }
    if (!info.isFile()) {
      refused.push({ path, reason: '不是普通文件，已跳过' })
      continue
    }
    let real
    try {
      real = await realpath(path)
    } catch {
      refused.push({ path, reason: '无法解析真实路径，已跳过' })
      continue
    }
    const scope = cwds.some(cwd => inside(cwd, real)) ? 'inside' : 'outside'
    if (scope === 'outside') {
      const blocking = blockingRootOf(real)
      if (blocking !== null) {
        refused.push({ path, reason: `位于系统目录内（${blocking}），已跳过` })
        continue
      }
    }
    if (inside(realHome, real)) {
      refused.push({ path, reason: '位于 DSH 数据目录内，已跳过' })
      continue
    }
    const sources = []
    for (const source of row.sources.values()) {
      if (sources.length >= MAX_SOURCES_PER_FILE) break
      sources.push({
        sessionId: source.sessionId,
        title: source.title,
        origin: source.origin,
        parentSession: source.parentSession,
        ops: source.ops,
        tools: [...source.tools].slice(0, MAX_TOOLS_PER_FILE),
      })
    }
    allowed.push({
      id: artifactId(real),
      path: real,
      displayPath: path,
      // The directory the file came from, which is what a person needs in order
      // to recognize a generated file among many similarly named ones.
      dir: dirname(real),
      bytes: info.size,
      ops: row.ops,
      kind,
      // Whether the file lived under a working directory of the conversation, or
      // merely somewhere the log named. The second kind is deletable, but only
      // ever by an explicit tick, and the dialog says so.
      scope,
      tools: [...row.tools].slice(0, MAX_TOOLS_PER_FILE),
      sources,
    })
  }
  return { allowed, refused }
}

/**
 * Locate this Session's storage directories under the sessions root.
 *
 * The backend escapes a Session id into one safe path segment and nests it under
 * a readable project directory; the id itself is already a safe segment for
 * every id DSH produces, so the search is an exact directory-name match across
 * every project directory. Nothing is joined from an unvalidated value.
 *
 * @param home - resolved DSH home.
 * @param sessionId - validated Session id.
 * @returns absolute session directories, plus any legacy one-file generation.
 */
async function findSessionDirectories(home, sessionId) {
  const root = join(home, 'sessions')
  const found = []
  if (!existsSync(root)) return found
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const candidate = join(root, project.name, sessionId)
    if (!existsSync(candidate)) continue
    try {
      if (!(await fsStat(candidate)).isDirectory()) continue
    } catch {
      continue
    }
    found.push(candidate)
  }
  return found
}

/**
 * The projection-cache document this Session's state is checkpointed into.
 *
 * `@deepseek-ai/dsh-session-projection-cache` keeps one version-stamped document
 * per Session on the `session_projcache` storage domain; the shipped JSON
 * backend stores it at `<home>/storages/session_projcache/sessions/<id>.json`.
 * It is derived data, but it is *this* Session's derived data: with the log gone
 * it can never be reconciled again, and it keeps the id alive in every
 * cache-driven listing path.
 *
 * @param home - resolved DSH home.
 * @param sessionId - validated Session id.
 * @returns the document path, whether or not it exists.
 */
function projectionCacheFile(home, sessionId) {
  return join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
}

/**
 * The title the projection cache recorded for one Session, best effort.
 *
 * Only used to label a row in a report; a missing or unreadable cache document
 * just means the caller shows the id.
 *
 * @param home - resolved DSH home.
 * @param sessionId - Session id.
 * @returns the title, or null.
 */
function cachedTitle(home, sessionId) {
  try {
    const file = projectionCacheFile(home, sessionId)
    if (!existsSync(file)) return null
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const title = parsed?.record?.rows?.title?.val
    return typeof title === 'string' && title !== '' ? title : null
  } catch {
    return null
  }
}

/**
 * Every Session header the persistence seam reports, keyed by id.
 *
 * A single unreadable log can make the backend's `list()` reject outright, which
 * would otherwise hide every Session from this plugin at once: the hidden list
 * would come back empty, and a parent's subagent tree would look childless while
 * the children sit on disk. When that happens — or when the seam reports fewer
 * Sessions than there are directories — the missing headers are recovered from
 * disk, which is what every other reader of the sessions root does anyway.
 *
 * The disk pass is skipped in the normal case, so a healthy profile pays only
 * one cheap directory count per request.
 *
 * @param persistence - the `sessionPersistence` service.
 * @param home - resolved DSH home.
 * @returns a Map from Session id to header, empty only when nothing is stored.
 */
async function headerMap(persistence, home) {
  const headers = new Map()
  let listed = false
  if (typeof persistence.list === 'function') {
    try {
      const snapshots = await persistence.list()
      listed = true
      for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
        const header = headerOf(snapshot)
        if (header !== null && typeof header.id === 'string') headers.set(header.id, header)
      }
    } catch {
      // Fall through to the disk pass below.
    }
  }
  const stored = await countSessionDirectories(home)
  if (listed && headers.size >= stored) return headers
  for (const header of await readHeadersFromDisk(home)) {
    if (!headers.has(header.id)) headers.set(header.id, header)
  }
  return headers
}

/**
 * How many Session directories the sessions root holds.
 * @param home - resolved DSH home.
 * @returns the count; 0 when the root cannot be read.
 */
async function countSessionDirectories(home) {
  const root = join(home, 'sessions')
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const project of projects) {
    if (!project.isDirectory()) continue
    try {
      const entries = await readdir(join(root, project.name), { withFileTypes: true })
      total += entries.filter(entry => entry.isDirectory()).length
    } catch {
      // An unreadable project directory contributes nothing.
    }
  }
  return total
}

/**
 * Session headers read straight off disk, for Sessions the seam could not report.
 *
 * The log's first Zstandard frame holds exactly the header line, so only that
 * frame is decompressed — the event frames of a multi-megabyte log are never
 * touched. A file that cannot be read is skipped: this pass exists to recover
 * what is recoverable, so one bad log must not abort it.
 *
 * @param home - resolved DSH home.
 * @returns every header it could decode.
 */
async function readHeadersFromDisk(home) {
  const root = join(home, 'sessions')
  const found = []
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    let entries
    try {
      entries = await readdir(join(root, project.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const file = join(root, project.name, entry.name, 'session.v4.jsonl.zstd')
      let header
      try {
        const bytes = await readFile(file)
        // Only the first frame is needed: the format puts the header there alone.
        const firstFrame = firstZstdFrame(bytes)
        const text = zstdDecompressSync(bytes.subarray(0, firstFrame)).toString('utf8')
        header = JSON.parse(text.slice(0, text.indexOf('\n')))
      } catch {
        continue
      }
      if (header !== null && typeof header === 'object' && typeof header.id === 'string') {
        found.push({
          ...header,
          // The seam reports the decoded header with the current format version;
          // an on-disk line carries `type` and no inherited count.
          version: typeof header.version === 'number' ? header.version : 4,
        })
      }
    }
  }
  return found
}

/**
 * The byte length of the first Zstandard frame in one buffered log.
 *
 * The container is a plain concatenation of frames, so the boundary is the next
 * frame's magic number. A log whose first frame is also its last returns its
 * whole length, which is correct for a header-only Session.
 *
 * @param bytes - the whole file.
 * @returns the end offset of the first frame.
 */
function firstZstdFrame(bytes) {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const next = bytes.indexOf(magic, 4)
  return next === -1 ? bytes.length : next
}

/**
 * One Session's stored size, best effort.
 * @param home - resolved DSH home.
 * @param sessionId - Session id.
 * @returns the total bytes of its stored directories.
 */
async function sessionBytes(home, sessionId) {
  const directories = await findSessionDirectories(home, sessionId)
  let total = 0
  for (const directory of directories) total += await directoryBytes(directory)
  return total
}

/**
 * One Session as the plan and the panels describe it.
 * @param home - resolved DSH home.
 * @param header - that Session's stored header.
 * @param ctx - Host plugin context, used only to report the running state.
 * @returns the row, with its size and cached title filled in.
 */
async function sessionRow(home, header, ctx) {
  return {
    sessionId: header.id,
    parentSession: typeof header.parentSession === 'string' ? header.parentSession : null,
    cwd: typeof header.cwd === 'string' ? header.cwd : null,
    createdAt: typeof header.createdAt === 'number' ? header.createdAt : null,
    origin: header.origin === 'subagent' ? 'subagent' : 'session',
    running: isLive(ctx, header.id),
    title: cachedTitle(home, header.id),
    bytes: await sessionBytes(home, header.id),
    directories: await findSessionDirectories(home, header.id),
  }
}

/**
 * Every stored Session the product's own Session list hides from the user.
 *
 * A Session whose header says `origin: 'subagent'` is filtered out of the
 * sidebar by the harness itself — `sessionVisible()` in the Workspace browser
 * returns false for it before any pin/archive/blank rule runs, and
 * `session.list` drops it on the Host side too. So it never renders a Session
 * row, and therefore never gets the row menu this plugin's "delete
 * conversation" entry hangs from. That is true whether or not its parent still
 * exists: a live parent only exposes the child through the Conversation
 * header's subagent switcher, which has no delete affordance either.
 *
 * @param persistence - the `sessionPersistence` service.
 * @param ctx - Host plugin context, used only to report the running state.
 * @param home - resolved DSH home.
 * @returns one row per hidden Session, most recent first.
 */
async function findHiddenSessions(persistence, ctx, home) {
  const headers = await headerMap(persistence, home)
  const rows = []
  for (const header of headers.values()) {
    if (header.origin !== 'subagent') continue
    const parent = typeof header.parentSession === 'string' ? header.parentSession : null
    rows.push({
      ...await sessionRow(home, header, ctx),
      // A parent that is gone can never surface the child again through its
      // subagent switcher; one that survives still can, for use.
      parentPresent: parent !== null && headers.has(parent),
      parentTitle: parent === null ? null : cachedTitle(home, parent),
    })
  }
  rows.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0) || left.sessionId.localeCompare(right.sessionId))
  return rows
}

/**
 * Every subagent descendant of one Session, breadth first, capped in depth.
 *
 * A conversation's children are not stored inside its own record: each is a
 * separate Session whose header names `parentSession`. Deleting a conversation
 * therefore has to walk that relation, or the children outlive their parent as
 * rows nothing in the UI can ever reach again.
 *
 * @param headers - the full Session header map.
 * @param sessionId - the Session whose descendants to collect.
 * @returns descendant headers, parents before their own children.
 */
function descendantsOf(headers, sessionId) {
  const children = new Map()
  for (const header of headers.values()) {
    const parent = typeof header.parentSession === 'string' ? header.parentSession : null
    if (parent === null) continue
    const list = children.get(parent)
    if (list === undefined) children.set(parent, [header])
    else list.push(header)
  }
  const found = []
  const seen = new Set([sessionId])
  let frontier = [sessionId]
  for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth += 1) {
    const next = []
    for (const id of frontier) {
      for (const header of children.get(id) ?? []) {
        if (seen.has(header.id)) continue
        seen.add(header.id)
        found.push(header)
        next.push(header.id)
      }
    }
    frontier = next
  }
  return found
}

/**
 * Attachment object paths implied by one attachment id.
 *
 * `@deepseek-ai/attachment-local` stores images at
 * `<home>/attachments/v1/objects/<sha256-prefix>/<sha256>`, generic file bytes at
 * `file-objects/...`, and one read-only hard-link directory per stored file name
 * at `files/<sha256-prefix>/<sha256>/`. An id this plugin does not recognize
 * resolves to nothing, and therefore deletes nothing.
 *
 * @param home - resolved DSH home.
 * @param attachmentId - id as stored in the Session log.
 * @returns candidate paths, most specific first.
 */
function attachmentPaths(home, attachmentId) {
  const raw = typeof attachmentId === 'string' ? attachmentId : ''
  const hash = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw
  if (!/^[0-9a-fA-F]{16,128}$/.test(hash)) return []
  const digest = hash.toLowerCase()
  const prefix = digest.slice(0, 2)
  const base = join(home, 'attachments', 'v1')
  return [
    { path: join(base, 'objects', prefix, digest), kind: 'image-object' },
    { path: join(base, 'file-objects', prefix, digest), kind: 'file-object' },
    { path: join(base, 'files', prefix, digest), kind: 'file-reference' },
  ]
}

/**
 * The SHA-256 of one file's bytes, streamed.
 *
 * Streaming rather than a single read keeps a large attached file from being
 * loaded into memory just to decide whether the dialog should show it twice.
 *
 * @param path - existing regular file.
 * @returns the lowercase hex digest.
 */
async function hashFile(path) {
  const hash = createHash('sha256')
  await new Promise((settle, fail) => {
    const stream = createReadStream(path)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('error', fail)
    stream.on('end', settle)
  })
  return hash.digest('hex')
}

/**
 * Which listed files are byte-identical to an attachment object.
 *
 * An image pasted into a conversation is stored twice on this machine: once as
 * the file the user had, and once in the attachment store under its digest. The
 * dialog listed both, so the same picture appeared under "referenced files" and
 * under "attachment objects", and ticking the attachment removed the copy nobody
 * could see while the visible file stayed. Deciding identity by content is the
 * only honest answer; a name is not unique and a byte count alone is a guess.
 *
 * Candidates are pre-filtered by byte count (the store records it) and by name,
 * then confirmed by hashing. Nothing is guessed: a file whose digest cannot be
 * read is simply not merged, which costs one duplicate row and never a file.
 *
 * @param rows - every file row the plan reports (inside and outside).
 * @param attachments - attachment metadata rows, each with `id` and `bytes`.
 * @param home - resolved DSH home.
 * @returns `{attachmentId, path}` pairs, empty when nothing matches.
 */
async function findAttachmentMirrors(rows, attachments, home) {
  const known = new Map()
  for (const row of attachments) {
    if (typeof row?.id !== 'string') continue
    known.set(row.id, row)
  }
  if (known.size === 0 || rows.length === 0) return []
  const storeBytes = (id) => {
    const digest = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id
    const candidate = attachmentPaths(home, id).find(entry => existsSync(entry.path))
    return candidate === undefined ? null : digest
  }
  const found = []
  let budget = MIRROR_MAX_CANDIDATES
  for (const row of rows) {
    if (budget <= 0) break
    if (!Number.isFinite(row.bytes) || row.bytes > MIRROR_MAX_BYTES) continue
    // Only an attachment whose recorded size matches can be the same bytes.
    const candidates = [...known.values()].filter(meta =>
      typeof meta.bytes === 'number' && meta.bytes === row.bytes)
    if (candidates.length === 0) continue
    budget -= 1
    let digest
    try {
      digest = await hashFile(row.path)
    } catch {
      continue
    }
    for (const meta of candidates) {
      const stored = storeBytes(meta.id)
      if (stored === null || stored !== digest) continue
      found.push({ attachmentId: meta.id, path: row.path })
    }
  }
  return found
}

/**
 * Attachment ids some *other* stored Session references.
 *
 * Conservative by construction: every other Session is read, and a read failure
 * marks every still-unresolved id as shared. Sessions being deleted together
 * are excluded from the reader set, so two files of the same conversation
 * cannot protect each other's attachments.
 *
 * @param persistence - the `sessionPersistence` service.
 * @param deleted - ids of every Session the current deletion removes.
 * @param ids - candidate attachment ids.
 * @returns the ids at least one surviving Session references.
 */
async function idsReferencedElsewhere(persistence, deleted, ids) {
  const shared = new Set()
  const pending = new Set(ids)
  if (pending.size === 0) return shared
  const headers = await headerMap(persistence, await resolveHome())
  if (headers.size === 0) return new Set(ids)
  for (const other of headers.keys()) {
    if (pending.size === 0) break
    if (deleted.has(other)) continue
    const { events, warning } = await readEvents(persistence, other)
    if (warning !== undefined) {
      for (const id of pending) shared.add(id)
      pending.clear()
      break
    }
    const found = new Set()
    collectAttachmentIds(events, found)
    for (const id of [...pending]) {
      if (found.has(id)) {
        shared.add(id)
        pending.delete(id)
      }
    }
  }
  return shared
}

// ---------------------------------------------------------------------------
// Recycle bin
// ---------------------------------------------------------------------------

/** The recycle-bin root: `<DSH_HOME>/dsh-plugin-remover/trash`. */
function trashRoot(home) {
  return join(home, 'dsh-plugin-remover', 'trash')
}

/** The groups directory inside the recycle bin. */
function trashGroups(home) {
  return join(trashRoot(home), 'groups')
}

/** The settings document of the recycle bin. */
function trashSettingsFile(home) {
  return join(trashRoot(home), 'settings.json')
}

/**
 * Clamp one settings value into its accepted range.
 * @param value - candidate from a request or a stored document.
 * @param fallback - value to use when the candidate is not a number.
 * @param max - inclusive ceiling.
 * @returns the clamped integer.
 */
function clampSetting(value, fallback, max) {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.min(Math.max(number, 0), max)
}

/**
 * Read one stored setting, falling back when the document does not carry the
 * type the setting needs.
 * @param value - candidate from a stored document or a request.
 * @param fallback - value to use when the candidate is not a boolean.
 * @returns the boolean.
 */
function booleanSetting(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Read the recycle-bin settings, repairing the document when it is missing or
 * out of range. A missing file is created, so the trash panel always has
 * concrete numbers to show.
 *
 * @param home - resolved DSH home.
 * @returns the effective settings.
 */
async function readTrashSettings(home) {
  const file = trashSettingsFile(home)
  let stored = null
  try {
    stored = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    stored = null
  }
  const settings = {
    formatVersion: 1,
    retentionDays: clampSetting(stored?.retentionDays, DEFAULT_SETTINGS.retentionDays, RETENTION_MAX_DAYS),
    maxBytes: clampSetting(stored?.maxBytes, DEFAULT_SETTINGS.maxBytes, MAX_BYTES_CEILING),
    showSidebarTrash: booleanSetting(stored?.showSidebarTrash, DEFAULT_SETTINGS.showSidebarTrash),
  }
  return settings
}

/**
 * Persist the recycle-bin settings atomically, creating the trash root.
 *
 * This is a patch, not a replacement: a field the request does not carry keeps
 * the value already stored. A replacement would let the panel's sidebar toggle
 * silently reset the retention and the cap, which are not on screen when it is
 * flipped.
 *
 * @param home - resolved DSH home.
 * @param candidate - requested values; each is clamped before it is stored.
 * @returns the values actually stored.
 */
async function writeTrashSettings(home, candidate) {
  const current = await readTrashSettings(home)
  const settings = {
    formatVersion: 1,
    retentionDays: candidate?.retentionDays === undefined
      ? current.retentionDays
      : clampSetting(candidate.retentionDays, current.retentionDays, RETENTION_MAX_DAYS),
    maxBytes: candidate?.maxBytes === undefined
      ? current.maxBytes
      : clampSetting(candidate.maxBytes, current.maxBytes, MAX_BYTES_CEILING),
    showSidebarTrash: candidate?.showSidebarTrash === undefined
      ? current.showSidebarTrash
      : booleanSetting(candidate.showSidebarTrash, current.showSidebarTrash),
  }
  await mkdir(trashRoot(home), { recursive: true })
  const file = trashSettingsFile(home)
  const temporary = `${file}.tmp`
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  await rename(temporary, file)
  return settings
}

/**
 * Validate a `/`-free relative item path inside one group.
 * @param value - candidate from a manifest or a request.
 * @returns the path, or null when it could escape the group directory.
 */
function safeItemPath(value) {
  if (typeof value !== 'string' || value === '' || value.includes('\\') || value.includes('\0')) return null
  const segments = value.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return null
  if (isAbsolute(value)) return null
  return value
}

/**
 * Read one group's manifest.
 * @param home - resolved DSH home.
 * @param key - validated group key.
 * @returns the manifest, or null when it is absent or malformed.
 */
async function readManifest(home, key) {
  try {
    const parsed = JSON.parse(await readFile(join(trashGroups(home), key, 'manifest.json'), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.items)) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Write one group's manifest atomically.
 * @param home - resolved DSH home.
 * @param key - validated group key.
 * @param manifest - the document to store.
 */
async function writeManifest(home, key, manifest) {
  const file = join(trashGroups(home), key, 'manifest.json')
  const temporary = `${file}.tmp`
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await rename(temporary, file)
}

/**
 * Every group the recycle bin currently holds, newest first.
 *
 * A `<key>.partial` directory is a deletion that never finished publishing. It
 * normally means a crash or a rename failure, and the older behaviour was to
 * skip it as "not a group" — which was wrong in the one case that matters: those
 * files have already left their original directories, so a partial that cannot
 * be seen is data the user can never get back. Partials whose manifest is
 * readable are therefore reported, with `recovery: true`, and the panel offers to
 * restore them; the `.partial` suffix happens to be legal in a group key, so the
 * existing restore path can finish the job unchanged.
 */
async function listManifests(home) {
  const root = trashGroups(home)
  if (!existsSync(root)) return []
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const manifests = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !GROUP_KEY.test(entry.name)) continue
    const partial = entry.name.endsWith('.partial')
    // A partial still being written has no manifest yet; skipping it is right,
    // because there is nothing to restore from until the manifest lands.
    const manifest = await readManifest(home, entry.name)
    if (manifest === null) continue
    // The directory name is the key every other operation addresses a group by.
    // A manifest whose own `groupKey` predates the `.partial` suffix would send
    // a restore to a directory that does not exist, so the name wins.
    const row = { ...manifest, groupKey: entry.name }
    manifests.push(partial ? { ...row, recovery: true } : row)
  }
  manifests.sort((left, right) => (right.deletedAt ?? 0) - (left.deletedAt ?? 0))
  return manifests
}

/** Total bytes the recycle bin holds, from the manifests rather than a fresh walk. */
function trashUsedBytes(manifests) {
  let total = 0
  for (const manifest of manifests) {
    const bytes = typeof manifest.bytes === 'number' ? manifest.bytes : manifest.items.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0)
    total += bytes
  }
  return total
}

/** When one group expires under the current retention, or null when it never does. */
function expiresAt(manifest, settings) {
  if (settings.retentionDays === 0) return null
  const deletedAt = typeof manifest.deletedAt === 'number' ? manifest.deletedAt : 0
  return deletedAt + settings.retentionDays * 24 * 60 * 60 * 1000
}

/**
 * Which of the two things one recycle-bin item is.
 *
 * A group holds both the conversation's own stored log (`store`, `cache`) and
 * the working-directory files it produced or read. Keeping them apart is what
 * lets a group say "the conversation itself is in here" without parsing kinds
 * in the browser, and it is what decides whether a restore has a conversation
 * to hand back to a workspace.
 *
 * @param kind - the item kind as the manifest records it.
 * @returns `record` for the conversation's own storage, `file` for everything else.
 */
function roleOfKind(kind) {
  return kind === 'store' || kind === 'cache' ? 'record' : 'file'
}

/**
 * One group as the recycle-bin panel lists it.
 * @param manifest - stored manifest.
 * @param settings - current recycle-bin settings.
 * @param withItems - whether to include the per-file rows.
 * @returns the row.
 */
function groupRow(manifest, settings, withItems) {
  const expires = expiresAt(manifest, settings)
  const items = Array.isArray(manifest.items) ? manifest.items : []
  const roles = { record: 0, file: 0 }
  let fileBytes = 0
  for (const item of items) {
    if (roleOfKind(item.kind) === 'record') roles.record += 1
    else {
      roles.file += 1
      fileBytes += Number(item.bytes) || 0
    }
  }
  const row = {
    groupKey: manifest.groupKey,
    sessionId: manifest.sessionId,
    title: manifest.title ?? null,
    origin: manifest.origin ?? 'session',
    parentSession: manifest.parentSession ?? null,
    deletedAt: typeof manifest.deletedAt === 'number' ? manifest.deletedAt : null,
    expiresAt: expires,
    bytes: typeof manifest.bytes === 'number' ? manifest.bytes : 0,
    itemCount: items.length,
    // A group written by 1.1.0 carries no role counts; deriving them from the
    // item kinds means an older group still renders its labels correctly.
    roles,
    // Whether the conversation itself went into the bin. Without this the panel
    // cannot tell "deleted a conversation" from "deleted only files it produced".
    recordIncluded: manifest.recordIncluded === true || roles.record > 0,
    fileCount: roles.file,
    fileBytes,
    // Where the conversation lived when it was deleted, so a restore can find
    // the same workspace even after the workspace was renamed.
    workspace: manifest.workspace ?? null,
    // A group whose publish never finished. Its files already left their
    // directories, so the panel surfaces it instead of hiding it.
    recovery: manifest.recovery === true,
    // True when every file in the group lived outside the conversation's working
    // directory, which is the case a reader is most likely to want flagged.
    outsideOnly: roles.file > 0 && items.filter(item => roleOfKind(item.kind) === 'file')
      .every(item => item.scope === 'outside'),
  }
  if (withItems) {
    row.items = items.map(item => ({
      path: item.path,
      kind: item.kind,
      role: roleOfKind(item.kind),
      scope: item.scope ?? null,
      mirror: item.mirror === true,
      originalPath: item.originalPath,
      dir: dirname(item.originalPath),
      bytes: Number(item.bytes) || 0,
      sessionId: item.sessionId ?? null,
      sources: Array.isArray(item.sources) ? item.sources : [],
    }))
  }
  return row
}

/**
 * Copy one file or directory, verify the copy, then drop the source.
 *
 * The only reason this exists is that `rename` cannot cross volumes, and the
 * recycle bin lives under the DSH home while the files it takes in usually live
 * on another drive. The verification is the point: a copy that silently
 * truncated would otherwise be reported as a successful delete.
 *
 * @param source - existing file or directory.
 * @param destination - path that does not exist yet.
 * @returns the transfer mode that succeeded.
 */
async function copyThenRemove(source, destination) {
  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination, { recursive: true, force: false, errorOnExist: true })
  const sourceBytes = await directoryBytes(source)
  const destinationBytes = await directoryBytes(destination)
  if (sourceBytes !== destinationBytes) {
    // Keep the source: a partial copy must never become a deletion.
    throw new Error(`复制校验失败（源 ${sourceBytes} 字节，目标 ${destinationBytes} 字节），已保留源文件`)
  }
  await rm(source, { recursive: true, force: true })
  return 'copy'
}

/**
 * Move one file or directory into place, across volumes when necessary.
 * @param source - existing path.
 * @param destination - target path; its parent directory is created first, so
 *   a nested group layout (`store/<project>/<session>`) needs no pre-pass.
 * @returns the transfer mode that succeeded.
 */
async function moveItem(source, destination) {
  await mkdir(dirname(destination), { recursive: true })
  try {
    await rename(source, destination)
    return 'rename'
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
  }
  return copyThenRemove(source, destination)
}

/**
 * Move one file or directory back to its original location.
 * @param source - path inside the group.
 * @param destination - its recorded original path.
 */
async function restoreItem(source, destination) {
  if (existsSync(destination)) throw new Error('目标已存在，未覆盖')
  await mkdir(dirname(destination), { recursive: true })
  return moveItem(source, destination)
}

/**
 * Put a restored conversation back where it came from.
 *
 * The order matters and is not negotiable: the log has to be on disk before the
 * workspace will take the conversation back, because `attachSession` validates
 * the stored header's `cwd` against the workspace directory and refuses an id
 * the persistence seam cannot report.
 *
 * Three outcomes, and the caller reports which one happened rather than
 * claiming success unconditionally:
 *
 *   * `re-attached` — a workspace already owns the recorded directory.
 *   * `created` — the directory is back but its registration was deleted, so a
 *     workspace for that same directory is recreated and the conversation is
 *     attached to it.
 *   * `ungrouped` — the directory itself is gone, so it is impossible to
 *     validate the conversation against any workspace. Rewriting the stored
 *     `cwd` to force it into another workspace would change the conversation's
 *     recorded working directory permanently, which a restore must never do;
 *     it stays in the browser's Ungrouped bucket instead.
 *
 * Subagent conversations are skipped: they never appear in a workspace list, and
 * their parent owns the grouping.
 *
 * Everything here is best effort. Files are already back by the time this runs,
 * so a registry failure is reported as a warning against that conversation and
 * never rolls the restore back.
 *
 * @param ctx - Host plugin context.
 * @param manifest - the group's manifest, which records what was deleted.
 * @param restoredPaths - item paths that this restore actually moved back.
 * @returns `{ archived, workspace }` plus warnings, per conversation.
 */
async function reattachConversation(ctx, manifest, restoredPaths) {
  const sessionId = manifest.sessionId
  const warnings = []
  const restoredRecord = (manifest.items ?? []).some(item =>
    roleOfKind(item.kind) === 'record' && restoredPaths.includes(item.path))
  const result = {
    sessionId,
    // False when the group held only files: there is no conversation to hand back.
    conversationRestored: manifest.recordIncluded === true || restoredRecord,
    archived: false,
    workspace: null,
  }
  if (!result.conversationRestored) return { ...result, warnings }
  // The whole conversation is only really back when its own log is; a group that
  // recorded the log but could not move it is reported as incomplete.
  if (!restoredRecord) {
    warnings.push(`${sessionId}: 对话日志未恢复，未重新挂回工作区`)
    return { ...result, warnings }
  }

  const registry = (() => {
    try {
      return ctx.get('workspaceRegistry')
    } catch {
      return undefined
    }
  })()
  if (registry === undefined || registry === null) {
    result.workspace = { status: 'ungrouped', reason: '没有工作区服务，无法挂回原工作区', path: manifest.cwd ?? null }
    return { ...result, warnings }
  }

  // Leaving the archive set is not optional: an archived conversation stays
  // grayed out and unopenable even though its log is back, which makes the
  // restore look like it did nothing.
  try {
    if (typeof registry.unarchiveSession === 'function') {
      await registry.unarchiveSession(sessionId)
      result.archived = true
    }
  } catch (error) {
    warnings.push(`${sessionId}: 未能解除归档：${describe(error)}`)
  }

  if (manifest.origin === 'subagent') {
    result.workspace = { status: 'subagent', reason: '子代理对话不进工作区列表', path: manifest.cwd ?? null }
    return { ...result, warnings }
  }

  // Prefer the workspace recorded at deletion time; the directory it was found
  // by is the fallback for groups written before that field existed.
  const recorded = manifest.workspace
  const candidatePath = typeof recorded?.path === 'string' && recorded.path !== ''
    ? recorded.path
    : (typeof manifest.cwd === 'string' && manifest.cwd !== '' ? manifest.cwd : null)
  if (candidatePath === null) {
    result.workspace = { status: 'ungrouped', reason: '删除时没有记录工作目录', path: null }
    return { ...result, warnings }
  }

  let directoryExists = false
  try {
    directoryExists = (await fsStat(candidatePath)).isDirectory()
  } catch {
    directoryExists = false
  }
  if (!directoryExists) {
    result.workspace = {
      status: 'ungrouped',
      reason: `原工作区目录已不存在（${candidatePath}），对话已恢复到「未分组」`,
      path: candidatePath,
    }
    return { ...result, warnings }
  }

  const attach = async (workspace) => {
    if (typeof workspace?.attachSession !== 'function') throw new Error('工作区服务不支持挂载对话')
    await workspace.attachSession(sessionId)
    result.workspace = {
      status: 're-attached',
      workspaceId: typeof workspace.id === 'string' ? workspace.id : String(workspace.id ?? ''),
      title: typeof workspace.title === 'string' ? workspace.title : null,
      path: candidatePath,
    }
  }

  try {
    let workspace
    if (typeof registry.resolveByPath === 'function') {
      workspace = await registry.resolveByPath(candidatePath).catch(() => undefined)
    }
    if (workspace === undefined && typeof registry.list === 'function') {
      workspace = registry.list().find(row => samePath(row?.path, candidatePath))
    }
    if (workspace !== undefined) {
      await attach(workspace)
      return { ...result, warnings }
    }
    // The directory is back but its registration is not, so recreate the same
    // workspace instead of dropping the conversation into Ungrouped.
    if (typeof registry.create !== 'function') {
      result.workspace = { status: 'ungrouped', reason: '原工作区记录已不存在，且无法重建', path: candidatePath }
      return { ...result, warnings }
    }
    const created = await registry.create(candidatePath, recorded?.title ?? undefined)
    await attach(created)
    result.workspace = { ...result.workspace, status: 'created' }
    return { ...result, warnings }
  } catch (error) {
    // The conversation is on disk; only its grouping failed. Say which and why.
    result.workspace = {
      status: 'ungrouped',
      reason: `已恢复但未能挂回原工作区：${describe(error)}`,
      path: candidatePath,
    }
    warnings.push(`${sessionId}: 未能挂回原工作区：${describe(error)}`)
    return { ...result, warnings }
  }
}

/**
 * Restore one or more recycle-bin groups, or a selection of their items.
 *
 * Batch-shaped on purpose: the panel lets several groups be ticked at once, and
 * doing them one request at a time would let a failure in the middle leave the
 * panel's selection meaning something the user cannot see. Every group is still
 * isolated — one that fails does not stop the others.
 *
 * Inside one group, the item move rules are unchanged from the single-group
 * version this replaces: a destination that already exists is never overwritten,
 * a failed item stays in the group, and the group directory is dropped only when
 * nothing is left in it.
 *
 * @param ctx - Host plugin context.
 * @param home - resolved DSH home.
 * @param request - `{groups: Array<{groupKey, itemPaths}>, groupKeys: string[]}`.
 * @returns the per-group outcomes and a flattened report.
 */
async function restoreGroups(ctx, home, request) {
  // Normalize three accepted request shapes into one group -> wanted-items map.
  // `null` means "every item in this group".
  const wanted = new Map()
  const addWanted = (key, itemPaths) => {
    if (typeof key !== 'string' || !GROUP_KEY.test(key)) return
    const paths = Array.isArray(itemPaths)
      ? itemPaths.map(safeItemPath).filter(path => path !== null)
      : null
    // "The whole group" wins over any item list for the same key: asking for a
    // group and also for one of its files must restore it whole, not twice.
    if (paths === null) {
      wanted.set(key, null)
      return
    }
    const current = wanted.get(key)
    if (current === null) return
    if (current === undefined) {
      wanted.set(key, new Set(paths))
      return
    }
    for (const path of paths) current.add(path)
  }
  if (Array.isArray(request?.groups)) {
    for (const group of request.groups) addWanted(group?.groupKey, group?.itemPaths)
  }
  if (Array.isArray(request?.groupKeys)) {
    for (const key of request.groupKeys) addWanted(key, null)
  }
  // The pre-1.2 request shape, kept working: one group, optional item list.
  if (typeof request?.groupKey === 'string') addWanted(request.groupKey, request.itemPaths)
  if (wanted.size === 0) throw new Error('没有指定要恢复的回收组')

  return withTrashLock(async () => {
    const restored = []
    const failed = []
    const warnings = []
    const groups = []
    for (const [groupKey, chosen] of wanted) {
      const manifest = await readManifest(home, groupKey)
      if (manifest === null) {
        failed.push({ groupKey, path: null, reason: '未找到该回收组' })
        groups.push({ groupKey, restored: [], failed: [{ path: null, reason: '未找到该回收组' }], groupRemoved: false, sessions: [] })
        continue
      }
      const groupRestored = []
      const groupFailed = []
      const remaining = []
      const restoredPaths = []
      for (const item of manifest.items ?? []) {
        const itemPath = safeItemPath(item.path)
        if (itemPath === null) {
          remaining.push(item)
          groupFailed.push({ path: String(item.path), reason: '回收组记录里的路径不合法' })
          continue
        }
        if (chosen !== null && !chosen.has(itemPath)) {
          remaining.push(item)
          continue
        }
        try {
          await restoreItem(join(trashGroups(home), groupKey, ...itemPath.split('/')), item.originalPath)
          restoredPaths.push(itemPath)
          groupRestored.push({ path: itemPath, originalPath: item.originalPath, bytes: item.bytes, kind: item.kind, role: roleOfKind(item.kind) })
        } catch (error) {
          remaining.push(item)
          groupFailed.push({ path: itemPath, reason: describe(error) })
        }
      }

      // The conversation goes back to its workspace after its log is on disk.
      let sessions = []
      if (restoredPaths.length > 0) {
        const outcome = await reattachConversation(ctx, manifest, restoredPaths)
        warnings.push(...outcome.warnings)
        sessions = [{
          sessionId: outcome.sessionId,
          conversationRestored: outcome.conversationRestored,
          workspace: outcome.workspace,
        }]
      }

      const next = { ...manifest, items: remaining }
      const groupRemoved = remaining.length === 0
      if (groupRemoved) await rm(join(trashGroups(home), groupKey), { recursive: true, force: true })
      else await writeManifest(home, groupKey, next)

      restored.push(...groupRestored.map(row => ({ groupKey, ...row })))
      failed.push(...groupFailed.map(row => ({ groupKey, ...row })))
      groups.push({ groupKey, sessionId: manifest.sessionId, restored: groupRestored, failed: groupFailed, groupRemoved, sessions })
    }
    return { restored, failed, warnings, groups }
  })
}

/**
 * A group key that sorts by deletion time and carries the Session id.
 * @param sessionId - the deleted Session.
 * @returns the key, unique enough to stand alone.
 */
function newGroupKey(sessionId) {
  const stamp = new Date().toISOString().replace(/[-:.Z]/g, '')
  return `${stamp}-${sessionId}`.slice(0, 180)
}

/** Everything the recycle bin writes, serialized: restoring while sweeping is a data race. */
let trashQueue = Promise.resolve()

/**
 * Run one recycle-bin mutation after every earlier one settled.
 * @param work - the mutation.
 * @returns its result.
 */
function withTrashLock(work) {
  const next = trashQueue.then(work, work)
  // The queue tail must stay fulfilled, so one failure cannot strand later work.
  trashQueue = next.then(() => {}, () => {})
  return next
}

/** When the last automatic retention sweep ran; `sweepTrash` is throttled by it. */
let lastSweepAt = 0
const SWEEP_MIN_INTERVAL_MS = 60 * 1000

/**
 * Drop the groups whose retention has elapsed.
 *
 * Only retention is enforced here. The size cap is deliberately *not* applied
 * silently: exceeding it is a question for the user at deletion time, because
 * quietly deleting the oldest recycle groups to make room is exactly the
 * behaviour a recycle bin exists to prevent.
 *
 * @param home - resolved DSH home.
 * @param force - bypass the throttling, for the explicit `/trash/sweep` route.
 * @returns what was dropped, and the bytes it held.
 */
async function sweepTrash(home, force) {
  const now = Date.now()
  if (!force && now - lastSweepAt < SWEEP_MIN_INTERVAL_MS) return { removed: [], bytes: 0, skipped: true }
  lastSweepAt = now
  return withTrashLock(async () => {
    const settings = await readTrashSettings(home)
    if (settings.retentionDays === 0) return { removed: [], bytes: 0 }
    const removed = []
    let bytes = 0
    for (const manifest of await listManifests(home)) {
      // An unfinished deletion is never expired away: it is the only record of
      // where those files came from, and the retention clock never applied to it.
      if (manifest.recovery === true) continue
      const expires = expiresAt(manifest, settings)
      if (expires === null || expires > now) continue
      const groupBytes = typeof manifest.bytes === 'number' ? manifest.bytes : 0
      try {
        await rm(join(trashGroups(home), manifest.groupKey), { recursive: true, force: true })
        removed.push({ groupKey: manifest.groupKey, reason: 'expired', expiresAt: expires })
        bytes += groupBytes
      } catch (error) {
        removed.push({ groupKey: manifest.groupKey, reason: `failed: ${describe(error)}` })
      }
    }
    return { removed, bytes }
  })
}

/**
 * Delete every group the recycle bin holds, assuming the caller already holds
 * the trash lock.
 *
 * Split from {@link emptyTrash} because two callers run inside that lock
 * already: taking it twice would wait on itself forever.
 *
 * @param home - resolved DSH home.
 * @returns what was dropped.
 */
async function emptyTrashUnlocked(home) {
  const removed = []
  let bytes = 0
  for (const manifest of await listManifests(home)) {
    const groupBytes = typeof manifest.bytes === 'number' ? manifest.bytes : 0
    try {
      await rm(join(trashGroups(home), manifest.groupKey), { recursive: true, force: true })
      removed.push(manifest.groupKey)
      bytes += groupBytes
    } catch {
      // A group that cannot be removed is simply still there; the panel reloads.
    }
  }
  return { removed, bytes }
}

/**
 * Permanently delete every group the recycle bin holds.
 * @param home - resolved DSH home.
 * @returns what was dropped.
 */
async function emptyTrash(home) {
  return withTrashLock(() => emptyTrashUnlocked(home))
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/**
 * Compare two directory paths the way a Workspace identity check does.
 *
 * Windows paths are case-insensitive and accept either separator, so a plain
 * string comparison would miss a workspace whose stored path differs only in
 * case or in `/` versus `\` — which is exactly what a path typed by hand in the
 * Workspace picker can produce.
 *
 * @param left - one absolute path.
 * @param right - the other.
 * @returns whether they name the same directory.
 */
function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const fold = (value) => {
    const slashed = value.replace(/[\\/]+/g, '/').replace(/\/+$/, '')
    return process.platform === 'win32' ? slashed.toLowerCase() : slashed
  }
  return fold(left) === fold(right)
}

/**
 * The Workspace one conversation currently belongs to, as a restore hint.
 *
 * Everything here is best effort: the workspace registry is optional in a
 * composition, its methods can throw, and a conversation outside every
 * workspace is a normal state. None of that may fail a scan, so every failure
 * path returns `null` and the caller treats it as "no workspace".
 *
 * @param ctx - Host plugin context.
 * @param cwd - the conversation's recorded working directory, if any.
 * @returns `{id, title, path}`, or `null` when no workspace owns that directory.
 */
function workspaceSlotOf(ctx, cwd) {
  if (typeof cwd !== 'string' || cwd === '') return null
  const registry = (() => {
    try {
      return ctx.get('workspaceRegistry')
    } catch {
      return undefined
    }
  })()
  if (registry === undefined || registry === null) return null
  const slot = (workspace) => ({
    id: typeof workspace?.id === 'string' ? workspace.id : String(workspace?.id ?? ''),
    title: typeof workspace?.title === 'string' ? workspace.title : null,
    path: typeof workspace?.path === 'string' ? workspace.path : cwd,
  })
  try {
    if (typeof registry.list === 'function') {
      const found = registry.list().find(workspace => samePath(workspace?.path, cwd))
      if (found !== undefined) return slot(found)
    }
  } catch {
    // Fall through: the registry is advisory here.
  }
  return null
}

/**
 * Build the complete deletion plan for one Session.
 * @param ctx - Host plugin context.
 * @param sessionId - validated Session id.
 * @returns the plan the browser renders and the purge route re-derives.
 */
async function buildPlan(ctx, sessionId) {
  const home = await resolveHome()
  const persistence = ctx.sessionPersistence
  const warnings = []

  const headers = await headerMap(persistence, home)
  const header = headers.get(sessionId) ?? headerOf(await persistence.stat(sessionId).catch(() => null))
  const cwd = typeof header?.cwd === 'string' ? header.cwd : undefined

  // The conversation tree: the Session itself plus every subagent it spawned.
  const childHeaders = descendantsOf(headers, sessionId)
  const tree = [
    {
      sessionId,
      origin: header?.origin === 'subagent' ? 'subagent' : 'session',
      parentSession: typeof header?.parentSession === 'string' ? header.parentSession : null,
      title: cachedTitle(home, sessionId),
      cwd,
      header,
    },
    ...childHeaders.map(child => ({
      sessionId: child.id,
      origin: child.origin === 'subagent' ? 'subagent' : 'session',
      parentSession: typeof child.parentSession === 'string' ? child.parentSession : null,
      title: cachedTitle(home, child.id),
      cwd: typeof child.cwd === 'string' ? child.cwd : undefined,
      header: child,
    })),
  ]

  // Every working directory the deleted tree reported, resolved once.
  const cwds = []
  for (const node of tree) {
    if (node.cwd === undefined) continue
    try {
      const real = await realpath(node.cwd)
      if (!cwds.includes(real)) cwds.push(real)
    } catch {
      // A working directory that no longer exists authorizes nothing.
    }
  }

  const written = new Map()
  const read = new Map()
  const attachmentIds = new Set()
  const attachments = new Map()
  // The union of every Session's event span, so one subagent that ran for two
  // minutes does not shrink the window its own parent opened an hour earlier.
  let windowStart = Infinity
  let windowEnd = -Infinity
  const children = []
  for (const node of tree) {
    const { events, warning } = await readEvents(persistence, node.sessionId)
    if (warning !== undefined) warnings.push(`${node.sessionId}: ${warning}`)
    const paths = collectToolPaths(events, node.cwd)
    mergeProvenance(written, paths.written, {
      sessionId: node.sessionId,
      title: node.title,
      origin: node.origin,
      parentSession: node.parentSession,
    })
    mergeProvenance(read, paths.read, {
      sessionId: node.sessionId,
      title: node.title,
      origin: node.origin,
      parentSession: node.parentSession,
    })
    collectAttachmentIds(events, attachmentIds)
    collectAttachmentMeta(events, attachments)
    const span = collectTimeWindow(events)
    if (span !== null) {
      if (span.start < windowStart) windowStart = span.start
      if (span.end > windowEnd) windowEnd = span.end
    }
    if (node.sessionId === sessionId) continue
    children.push({
      sessionId: node.sessionId,
      parentSession: node.parentSession,
      title: node.title,
      cwd: node.cwd ?? null,
      origin: node.origin,
      running: isLive(ctx, node.sessionId),
      bytes: await sessionBytes(home, node.sessionId),
      directories: await findSessionDirectories(home, node.sessionId),
    })
  }

  // A path some Session both wrote and read is a produced file: reporting it
  // twice would let the dialog show the same file under two headings.
  for (const path of written.keys()) read.delete(path)

  const produced = await classifyItems(written, cwds, home, 'artifact')
  const referenced = await classifyItems(read, cwds, home, 'referenced')

  // Outside files are reported under their own heading because deleting one is a
  // different act from deleting a product of the conversation: the dialog keeps
  // them collapsed and unticked, and a reader who wants one has to say so.
  const splitScope = (rows) => ({
    inside: rows.filter(row => row.scope === 'inside'),
    outside: rows.filter(row => row.scope === 'outside'),
  })
  const artifactScope = splitScope(produced.allowed)
  const referencedScope = splitScope(referenced.allowed)

  // Files the conversation changed without ever naming a path in a tool call.
  // `known` carries every path already reported so nothing appears twice, and
  // the window spans the whole Session tree rather than one node.
  const knownPaths = new Set()
  for (const row of [...produced.allowed, ...referenced.allowed]) knownPaths.add(row.path)
  for (const path of [...written.keys(), ...read.keys()]) knownPaths.add(path)
  const window = Number.isFinite(windowStart) && Number.isFinite(windowEnd)
    ? { start: windowStart, end: windowEnd }
    : null
  const changed = await scanChangedInWindow(cwds, window, home, knownPaths)

  const directories = await findSessionDirectories(home, sessionId)
  const storeBytes = (await Promise.all(directories.map(directoryBytes))).reduce((a, b) => a + b, 0)

  const cacheFile = projectionCacheFile(home, sessionId)
  const cacheBytes = existsSync(cacheFile) ? await fsStat(cacheFile).then(info => info.size).catch(() => 0) : 0

  const settings = await readTrashSettings(home)
  const usedBytes = trashUsedBytes(await listManifests(home))

  const attachmentIdsList = [...attachmentIds]
  const attachmentRows = [...attachments.values()]
  // Which attachment objects are byte-identical to a *produced* file. Only those
  // rows take part, and for the opposite reason the 1.3.0 rule applied to all of
  // them: folding is a promise that deleting the file also takes the copy. A
  // referenced row cannot be deleted, so folding its copy would leave that copy
  // reachable from nowhere — visible in neither list, removable from neither.
  // Such a copy stays its own row in the attachment list, where it can be
  // deleted on its own terms.
  const mirrors = await findAttachmentMirrors(
    [...artifactScope.inside, ...artifactScope.outside],
    attachmentRows,
    home,
  )
  const mirrorOf = new Map(mirrors.map(row => [row.attachmentId, row.path]))

  const withMirror = (row) => {
    const attached = [...mirrorOf.entries()].find(([, path]) => path === row.path)
    return attached === undefined ? row : { ...row, mirrorAttachment: attached[0] }
  }

  return {
    home,
    sessionId,
    title: cachedTitle(home, sessionId),
    cwd,
    // The Workspace this conversation is grouped under right now. A restore
    // records it, so putting the conversation back does not depend on the
    // workspace still being named after the same path.
    workspace: workspaceSlotOf(ctx, cwd),
    origin: header?.origin === 'subagent' ? 'subagent' : 'session',
    parentSession: typeof header?.parentSession === 'string' ? header.parentSession : null,
    createdAt: typeof header?.createdAt === 'number' ? header.createdAt : null,
    live: isLive(ctx, sessionId),
    // Every Session this deletion removes, so callers can reason about the
    // whole footprint instead of the root record alone.
    sessions: tree.map(node => node.sessionId),
    store: { directories, bytes: storeBytes },
    children,
    projectionCache: { path: cacheFile, exists: cacheBytes > 0, bytes: cacheBytes },
    artifacts: {
      items: artifactScope.inside.slice(0, MAX_REPORTED_ROWS).map(withMirror),
      outside: artifactScope.outside.slice(0, MAX_REPORTED_ROWS).map(withMirror),
      refused: produced.refused.slice(0, MAX_REFUSED_ROWS),
      refusedTotal: produced.refused.length,
      totalBytes: artifactScope.inside.reduce((sum, row) => sum + row.bytes, 0),
      outsideBytes: artifactScope.outside.reduce((sum, row) => sum + row.bytes, 0),
      truncated: artifactScope.inside.length > MAX_REPORTED_ROWS,
    },
    referenced: {
      // Listed, never deleted. The dialog shows what the conversation read so
      // the reader can see its footprint, but no request can remove one of
      // these: a file that was only read belongs to whatever the reader was
      // doing, not to the conversation, and there is no way for this plugin to
      // tell "I generated this and read it back" from "this was already here".
      deletable: false,
      // One list rather than inside/outside: with no deletion decision left to
      // make, which working directory a file sat under no longer changes what
      // the reader can do. The absolute path is on every row.
      items: [...referencedScope.inside, ...referencedScope.outside]
        .slice(0, MAX_REPORTED_ROWS)
        .map(withMirror),
      refused: referenced.refused.slice(0, MAX_REFUSED_ROWS),
      refusedTotal: referenced.refused.length,
      totalBytes: referencedScope.inside.reduce((sum, row) => sum + row.bytes, 0)
        + referencedScope.outside.reduce((sum, row) => sum + row.bytes, 0),
      truncated: referencedScope.inside.length + referencedScope.outside.length > MAX_REPORTED_ROWS,
    },
    changed: {
      items: changed.rows.slice(0, MAX_REPORTED_ROWS),
      totalBytes: changed.rows.reduce((sum, row) => sum + row.bytes, 0),
      truncated: changed.truncated || changed.rows.length > MAX_REPORTED_ROWS,
      window: window === null ? null : { start: window.start, end: window.end },
    },
    attachments: {
      ids: attachmentIdsList.slice(0, MAX_REPORTED_ROWS),
      // Ids stay the contract for deleting; this is only what the dialog shows.
      // A row carries `mirrorOf` when the same bytes are already listed as a
      // workspace file, so the panel can fold it into that row.
      items: attachmentRows.slice(0, MAX_REPORTED_ROWS).map(row => (
        mirrorOf.has(row.id) ? { ...row, mirrorOf: mirrorOf.get(row.id) } : row
      )),
    },
    trash: {
      retentionDays: settings.retentionDays,
      maxBytes: settings.maxBytes,
      usedBytes,
      directory: trashRoot(home),
    },
    warnings,
  }
}

/** Whether the Session is currently live in this process. */
function isLive(ctx, sessionId) {
  try {
    const sessions = ctx.get('sessions')
    if (sessions === undefined || typeof sessions.get !== 'function') return false
    return sessions.get(sessionId) !== undefined
  } catch {
    return false
  }
}

/**
 * Normalize a purge request into the selection the plan is filtered by.
 *
 * Everything defaults to "the whole conversation", which is what the dialog
 * shows pre-ticked. The request names ids, never paths: the Host re-derives the
 * plan from the stored logs, so a stale or tampered page cannot widen a delete.
 *
 * A `mode` field is deliberately ignored rather than honoured. It belonged to an
 * earlier dialog that could only pick one of three scopes; accepting it would let
 * a request widen the deletion past the per-file selection this plugin now uses.
 *
 * @param body - parsed request body.
 * @returns selection flags plus the id lists the caller ticked.
 */
function selectionOf(body) {
  const include = body?.include ?? {}
  const idList = (value) => (Array.isArray(value) ? value.filter(id => typeof id === 'string' && id !== '').slice(0, MAX_REPORTED_ROWS * 4) : [])
  // A kept conversation keeps its attachment objects. The log records them only
  // as `sha256:` digests, so deleting one while the conversation survives leaves
  // every image and file in it pointing at nothing — silent corruption the user
  // never asked for, and cannot undo. The client disables the checkbox in the
  // same state; this is the half that actually enforces it.
  const record = include.record !== false
  return {
    record,
    cache: include.cache !== false && record,
    children: include.children !== false,
    // Reporting the forced-off state lets the dialog explain the disabled
    // checkbox instead of showing a tick that does nothing.
    attachments: include.attachments !== false && record,
    attachmentsForcedOff: include.attachments !== false && !record,
    // An absent list means the user ticked nothing, not "everything".
    artifactIds: Array.isArray(body?.artifactIds) ? idList(body.artifactIds) : [],
    // A stale page from 1.3.0 or earlier can still send this. It is counted so
    // the request can be refused by name instead of quietly doing less than it
    // said: referenced files are listed, never deleted, and a caller that asked
    // for one must be told that rather than shown a success page.
    referencedIds: Array.isArray(body?.referencedIds) ? idList(body.referencedIds) : [],
    // Same rule as the two above: these are never implied by a missing field,
    // because their provenance is uncertain and defaulting them to "all" would
    // turn a page that failed to send the field into a much larger deletion.
    changedIds: Array.isArray(body?.changedIds) ? idList(body.changedIds) : [],
    childIds: Array.isArray(body?.childIds) ? idList(body.childIds) : null,
  }
}

/**
 * Stop whatever is writing to the Sessions this deletion is about to move.
 *
 * A subagent has no Workspace row to archive, and `archiveSession` describes the
 * archive set of ordinary Sessions; the Subagent runtime owns its cancellation
 * instead. Interrupting first means a child mid-turn stops writing to the log
 * that is about to be moved into the recycle bin.
 *
 * @param ctx - Host plugin context.
 * @param plan - the plan being executed.
 * @param targets - the Sessions being removed.
 * @returns the steps that succeeded, and the errors.
 */
async function quiesce(ctx, plan, targets) {
  const errors = []
  const removed = { archived: false, interrupted: [], detached: [] }
  for (const sessionId of targets) {
    const child = plan.children.find(row => row.sessionId === sessionId)
    const origin = child === undefined ? plan.origin : child.origin
    if (!isLive(ctx, sessionId)) continue
    if (origin === 'subagent') {
      try {
        const subagents = ctx.get('subagents')
        if (subagents !== undefined && typeof subagents.interrupt === 'function') {
          subagents.interrupt(sessionId, { kind: 'user' })
          removed.interrupted.push(sessionId)
        }
      } catch (error) {
        errors.push({ step: 'interrupt', path: sessionId, message: describe(error) })
      }
    } else {
      try {
        const registry = ctx.get('workspaceRegistry')
        if (registry !== undefined && typeof registry.archiveSession === 'function') {
          await registry.archiveSession(sessionId, { stopActivity: true })
          removed.archived = true
        }
      } catch (error) {
        errors.push({ step: 'archive', path: sessionId, message: describe(error) })
      }
    }
  }
  // Detach every target from its Workspace accounting so no stale grouping row
  // survives the reload.
  try {
    const registry = ctx.get('workspaceRegistry')
    if (registry !== undefined && typeof registry.list === 'function') {
      const targetSet = new Set(targets)
      for (const workspace of registry.list()) {
        const ids = Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : []
        for (const id of ids) {
          if (!targetSet.has(id)) continue
          await workspace.detachSession(id)
          removed.detached.push(id)
        }
      }
    }
  } catch (error) {
    errors.push({ step: 'detach', path: null, message: describe(error) })
  }
  return { removed, errors }
}

/**
 * Drop one Session's projection-cache row through the open storage domain.
 *
 * The preferred path goes through the *open* `session_projcache` domain, so the
 * in-memory table and the medium move together and the cache service cannot
 * serve, or later rewrite, a row this plugin just deleted.
 *
 * @param ctx - Host plugin context.
 * @param home - resolved DSH home.
 * @param sessionId - validated Session id.
 * @returns what was removed and how.
 */
async function dropProjectionCache(ctx, home, sessionId) {
  const file = projectionCacheFile(home, sessionId)
  try {
    const facility = ctx.get('storageDomain')
    const domain = typeof facility?.get === 'function' ? facility.get('session_projcache') : undefined
    const table = typeof domain?.table === 'function' ? domain.table('sessions') : undefined
    if (table !== undefined && typeof table.delete === 'function') {
      const existed = await table.delete(sessionId)
      return { path: file, removed: existed, via: 'domain' }
    }
  } catch (error) {
    if (!existsSync(file)) return { path: file, removed: false, via: 'domain', warning: describe(error) }
    return { path: file, removed: false, via: 'domain', warning: describe(error), fallback: true }
  }
  try {
    if (!existsSync(file)) return { path: file, removed: false, via: 'file' }
    await rm(file, { force: true })
    return { path: file, removed: true, via: 'file' }
  } catch (error) {
    return { path: file, removed: false, via: 'file', warning: describe(error) }
  }
}

/**
 * The items one purge request removes, grouped for the recycle bin.
 *
 * Every entry carries the absolute source path and one relative destination
 * inside the group. Nothing here is derived from a request value other than the
 * ids resolved against the freshly rebuilt plan.
 *
 * @param plan - freshly rebuilt plan.
 * @param selection - normalized selection from {@link selectionOf}.
 * @param home - resolved DSH home.
 * @returns the item list and the ids of every Session the deletion removes.
 */
function collectSelection(plan, selection, home) {
  const items = []
  const sessions = new Set([plan.sessionId])

  if (selection.children) {
    for (const child of plan.children) {
      if (selection.childIds !== null && !selection.childIds.includes(child.sessionId)) continue
      sessions.add(child.sessionId)
      for (const directory of child.directories) {
        items.push({
          source: directory,
          // The backend nests a Session under a readable project directory; the
          // same shape inside the group keeps a restore trivially reversible.
          path: `store/${basename(dirname(directory))}/${basename(directory)}`,
          kind: 'store',
          originalPath: directory,
          bytes: child.bytes,
          sessionId: child.sessionId,
        })
      }
    }
  }

  if (selection.record) {
    for (const directory of plan.store.directories) {
      items.push({
        source: directory,
        path: `store/${basename(dirname(directory))}/${basename(directory)}`,
        kind: 'store',
        originalPath: directory,
        bytes: plan.store.bytes,
        sessionId: plan.sessionId,
      })
    }
    if (plan.projectionCache.exists && selection.cache) {
      items.push({
        source: plan.projectionCache.path,
        path: `cache/${plan.sessionId}.json`,
        kind: 'cache',
        originalPath: plan.projectionCache.path,
        bytes: plan.projectionCache.bytes,
        sessionId: plan.sessionId,
      })
    }
  }

  const wantedArtifacts = selection.artifactIds === null ? null : new Set(selection.artifactIds)
  const wantedChanged = new Set(selection.changedIds)
  const pushFiles = (rows, kind, prefix, wanted) => {
    rows.forEach((row) => {
      if (wanted !== null && !wanted.has(row.id)) return
      items.push({
        source: row.path,
        // Two files can share a name in different directories, so a counter keeps
        // each destination unique without flattening the name out of the path.
        path: `${prefix}/${items.filter(item => item.path.startsWith(`${prefix}/`)).length}/${basename(row.path)}`,
        kind,
        // `inside` or `outside` the conversation's working directory. The bin
        // reports which, because restoring a file that was never part of the
        // project is a different kind of surprise.
        scope: row.scope ?? 'inside',
        // The attachment object holding the same bytes, when the plan found one.
        // Removing the file without its copy would leave the store holding a
        // picture the user just deleted, and the dialog would still list it.
        mirrorAttachment: row.mirrorAttachment ?? null,
        originalPath: row.displayPath,
        bytes: row.bytes,
        sessionId: plan.sessionId,
        sources: row.sources,
      })
    })
  }
  pushFiles(plan.artifacts.items ?? [], 'artifact', 'artifacts', wantedArtifacts)
  pushFiles(plan.artifacts.outside ?? [], 'artifact', 'artifacts-outside', wantedArtifacts)
  pushFiles(plan.changed.items ?? [], 'changed', 'changed', wantedChanged)

  const attachmentItems = []
  if (selection.attachments) {
    for (const id of plan.attachments.ids) {
      for (const candidate of attachmentPaths(home, id)) {
        if (!existsSync(candidate.path)) continue
        attachmentItems.push({
          source: candidate.path,
          path: `attachments/${attachmentItems.length}/${id.includes(':') ? id.slice(id.indexOf(':') + 1) : id}`,
          kind: 'attachment',
          originalPath: candidate.path,
          bytes: 0,
          sessionId: plan.sessionId,
        })
      }
    }
  }

  return { items, attachmentItems, sessions }
}

/**
 * Write one plan into the recycle bin: move every item, then publish the group.
 *
 * The group is built under `<key>.partial` and renamed into place only once its
 * manifest is written, so a crash mid-delete leaves a partial directory rather
 * than a group that looks restorable but is not.
 *
 * The publish step is the part that has to be defended. `rename` fails whenever
 * something holds a handle on the directory being moved — on Windows that
 * includes the Harness itself while the Session log is open, and any file the
 * page is still displaying. When it fails the items are *already* in the partial
 * directory, so letting the error escape would strand them: gone from where the
 * user can see them, invisible to the recycle bin, and never swept. So a failed
 * publish rolls every moved item back to where it came from, and only items that
 * cannot be moved back are left in a partial directory that the panel does list.
 *
 * @param home - resolved DSH home.
 * @param plan - freshly rebuilt plan.
 * @param items - items to move, from {@link collectSelection}.
 * @param meta - what the manifest records about the deletion.
 * @returns the group, its bytes, the per-item errors, and whether it published.
 */
async function placeGroup(home, plan, items, meta) {
  const key = newGroupKey(plan.sessionId)
  const partial = join(trashGroups(home), `${key}.partial`)
  const final = join(trashGroups(home), key)
  await mkdir(partial, { recursive: true })
  const errors = []
  const stored = []
  let bytes = 0
  for (const item of items) {
    const destination = join(partial, ...item.path.split('/'))
    try {
      const mode = await moveItem(item.source, destination)
      const size = Number(item.bytes) || await directoryBytes(destination)
      stored.push({ ...item, path: item.path, bytes: size, via: mode })
      bytes += size
    } catch (error) {
      errors.push({ step: item.kind, path: item.originalPath, message: describe(error) })
    }
  }
  if (stored.length === 0) {
    await rm(partial, { recursive: true, force: true })
    return { groupKey: null, published: false, rolledBack: 0, bytes: 0, items: [], errors }
  }
  const manifest = {
    formatVersion: 1,
    groupKey: key,
    sessionId: plan.sessionId,
    title: plan.title,
    origin: plan.origin,
    parentSession: plan.parentSession,
    cwd: plan.cwd ?? null,
    // The workspace the conversation was grouped under at deletion time. The
    // restore prefers this over `cwd` because a workspace whose directory moved
    // is still the same workspace, while its stored path no longer matches.
    workspace: plan.workspace ?? null,
    deletedAt: Date.now(),
    mode: meta.mode,
    // Whether the conversation's own log went with it. A files-only deletion
    // leaves this false, and the panel says so instead of implying the
    // conversation is gone.
    recordIncluded: stored.some(item => roleOfKind(item.kind) === 'record'),
    bytes,
    items: stored.map(item => ({
      path: item.path,
      kind: item.kind,
      role: roleOfKind(item.kind),
      scope: item.scope ?? null,
      // Set when this attachment object was taken because the file it duplicates
      // was deleted. The bin says so instead of implying the user ticked it.
      ...item.mirror === true ? { mirror: true } : {},
      originalPath: item.originalPath,
      bytes: item.bytes,
      sessionId: item.sessionId,
      ...item.sources === undefined ? {} : { sources: item.sources },
    })),
  }
  await writeManifest(home, `${key}.partial`, manifest)
  try {
    // `meta.publish` is a fault-injection seam for the offline suite: the real
    // publish is one `rename`, and the only way to test that a failed publish
    // rolls back is to make it fail on purpose.
    if (typeof meta?.publish === 'function') await meta.publish(partial, final)
    else await rename(partial, final)
    return { groupKey: key, published: true, rolledBack: 0, bytes, items: manifest.items, errors }
  } catch (publishError) {
    // Nothing may be lost to a rename failure: put every item back first.
    const stranded = []
    let rolledBack = 0
    for (const item of stored) {
      try {
        await restoreItem(join(partial, ...item.path.split('/')), item.source)
        rolledBack += 1
      } catch (rollbackError) {
        stranded.push({
          step: item.kind,
          path: item.originalPath,
          message: `发布失败后无法放回原处（${describe(rollbackError)}），条目仍在回收站未完成的删除里`,
        })
      }
    }
    errors.push(...stranded, {
      step: 'publish',
      path: key,
      message: `${describe(publishError)}；已回滚 ${rolledBack} 个条目`,
    })
    if (stranded.length === 0) {
      // Everything is back where it was, so the partial directory is just litter.
      await rm(partial, { recursive: true, force: true })
      return { groupKey: null, published: false, rolledBack, bytes: 0, items: [], errors }
    }
    // Something could not go back. Publishing the recoverable remainder is the
    // difference between "visible in the bin" and "gone without a trace".
    try {
      await rename(partial, final)
    } catch {
      // Leaving the `.partial` is still recoverable: `listManifests` reports it.
    }
    return { groupKey: key, published: true, rolledBack, bytes, items: manifest.items, errors }
  }
}

/**
 * Execute one plan.
 *
 * Two destinations: the recycle bin (default, reversible) or permanent deletion
 * (`permanent`, only reachable from the dialog's overflow question, from the
 * recycle-bin panel, or from an explicit permanent request).
 *
 * @param ctx - Host plugin context.
 * @param request - `{sessionId, toTrash, permanent, include, artifactIds, changedIds, childIds}`.
 * @returns a per-step report, or the overflow refusal, which never touches a file.
 */
async function purge(ctx, request) {
  const sessionId = request.sessionId
  const selection = selectionOf(request)
  const plan = await buildPlan(ctx, sessionId)
  const home = plan.home
  const toTrash = request.permanent !== true
  const errors = []
  const removed = {
    directories: [],
    directoryBytes: 0,
    artifacts: [],
    artifactBytes: 0,
    changed: [],
    changedBytes: 0,
    attachments: [],
    attachmentCopies: 0,
    projectionCache: null,
    archived: false,
    interrupted: [],
    detached: [],
    children: [],
    groupKey: null,
    direct: false,
  }

  const { items, attachmentItems, sessions } = collectSelection(plan, selection, home)

  // Referenced files are listed, never deleted. A page from 1.3.0 or earlier
  // still offers the tick, so a request can arrive asking for one; answering
  // "done" while leaving the file in place is the silent success this plugin
  // exists to avoid. The refusal comes before anything is moved, so it costs
  // nothing and cannot half-apply.
  if (selection.referencedIds.length > 0) {
    const known = new Set((plan.referenced.items ?? []).map(row => row.id))
    const asked = selection.referencedIds.filter(id => known.has(id))
    return {
      ok: false,
      code: 'referenced-not-deletable',
      error: '引用的文件现在只作展示，不会被删除。它们不属于这次对话的产出，删掉可能影响你在别处的工作；如需清理请直接到资源管理器处理。',
      sessionId,
      toTrash,
      removed: null,
      trash: null,
      // Which ids the request named that the fresh plan still recognises. Ids
      // that resolve to nothing are already covered by the stale-page case.
      referencedRequested: selection.referencedIds.length,
      referencedRecognised: asked.length,
      errors,
    }
  }

  // How many attachment objects may actually go: shared ones stay.
  let deletableAttachments = []
  if (selection.attachments && attachmentItems.length > 0) {
    const shared = await idsReferencedElsewhere(ctx.sessionPersistence, sessions, plan.attachments.ids)
    deletableAttachments = attachmentItems.filter(item => {
      const id = basename(item.source)
      return !shared.has(`sha256:${id}`) && !shared.has(id)
    })
  }

  // A file whose bytes are also an attachment object takes the object with it.
  // Only while the conversation itself goes: a kept conversation reads its images
  // back from the store, so removing the object would turn them into dead links.
  // The object is subject to the same "another conversation still uses it" check
  // as an explicitly ticked attachment.
  const mirroredIds = new Map()
  if (selection.record) {
    for (const item of items) {
      if (typeof item.mirrorAttachment === 'string' && item.mirrorAttachment !== '') {
        mirroredIds.set(item.mirrorAttachment, item.originalPath)
      }
    }
  }
  if (mirroredIds.size > 0) {
    const shared = await idsReferencedElsewhere(ctx.sessionPersistence, sessions, [...mirroredIds.keys()])
    const already = new Set(deletableAttachments.map(item => item.source))
    for (const id of mirroredIds.keys()) {
      if (shared.has(id) || shared.has(`sha256:${id.slice(id.indexOf(':') + 1)}`)) continue
      for (const candidate of attachmentPaths(home, id)) {
        if (!existsSync(candidate.path) || already.has(candidate.path)) continue
        already.add(candidate.path)
        deletableAttachments.push({
          source: candidate.path,
          path: `attachments-mirror/${deletableAttachments.length}/${basename(candidate.path)}`,
          kind: 'attachment',
          role: 'file',
          mirror: true,
          originalPath: candidate.path,
          bytes: 0,
          sessionId: plan.sessionId,
        })
      }
    }
  }

  const incomingBytes = [...items, ...deletableAttachments].reduce((sum, item) => sum + (Number(item.bytes) || 0), 0)

  // The capacity check runs before anything is touched: a deletion that cannot
  // be made reversible must be an explicit decision, never a silent fallback.
  if (toTrash && plan.trash.maxBytes > 0) {
    const wouldExceed = plan.trash.usedBytes + incomingBytes > plan.trash.maxBytes
    if (wouldExceed) {
      return {
        ok: false,
        code: 'trash-overflow',
        sessionId,
        incomingBytes,
        usedBytes: plan.trash.usedBytes,
        maxBytes: plan.trash.maxBytes,
        // Even an emptied recycle bin could not hold this deletion.
        onlyPurge: incomingBytes > plan.trash.maxBytes,
        plan: { artifactCount: plan.artifacts.items.length, referencedCount: plan.referenced.items.length },
      }
    }
  }

  // Which conversations actually lose their stored log. Unticking the record
  // group keeps the conversation, so nothing may be archived, interrupted, or
  // detached for it: `archiveSession` would hide a conversation that still
  // exists, and `detachSession` would drop it out of its workspace slot.
  const quiesceTargets = [...new Set(
    items.filter(item => item.kind === 'store').map(item => item.sessionId),
  )]
  const all = await quiesce(ctx, plan, quiesceTargets)
  removed.archived = all.removed.archived
  removed.interrupted = all.removed.interrupted
  removed.detached = all.removed.detached
  errors.push(...all.errors)

  // How much was asked for. `items` already reflects the per-file selection, so a
  // request that ticked things which the fresh plan no longer resolves to (the
  // file vanished, the id came from a stale page) otherwise lands here looking
  // exactly like "the user unticked everything".
  const requested = (selection.artifactIds === null ? 0 : selection.artifactIds.length)
    + selection.changedIds.length
    + (selection.record ? 1 : 0)
    + (selection.attachments ? 1 : 0)

  // An empty selection is a no-op, not a failure: the user may have unticked
  // everything while the dialog still offers the button. A request that named
  // something and matched nothing is a different thing entirely, and saying
  // "done" to it is the silent success this branch used to print.
  if (items.length === 0 && deletableAttachments.length === 0) {
    if (requested > 0) {
      return {
        ok: false,
        code: 'nothing-matched',
        error: '选中的条目已不在磁盘上（可能已被删除或移动），本次没有移动任何文件。',
        sessionId,
        toTrash,
        removed,
        trash: null,
        plan: { sessionId, cwd: plan.cwd, sessions: [...sessions], warnings: plan.warnings },
        errors,
      }
    }
    return {
      ok: true,
      sessionId,
      toTrash,
      empty: true,
      removed,
      trash: null,
      plan: { sessionId, cwd: plan.cwd, sessions: [...sessions], warnings: plan.warnings },
      errors,
    }
  }

  if (!toTrash) {
    // Permanent: remove in place, reporting every step.
    removed.direct = true
    for (const item of [...items, ...deletableAttachments]) {
      try {
        if (item.kind === 'cache') {
          const drop = await dropProjectionCache(ctx, home, item.sessionId)
          if (drop.removed) removed.projectionCache = { path: drop.path, bytes: item.bytes, via: drop.via }
          else if (drop.warning !== undefined) errors.push({ step: 'projection-cache', path: drop.path, message: drop.warning })
          continue
        }
        await rm(item.source, { recursive: true, force: true })
        account(removed, item, sessionId)
      } catch (error) {
        errors.push({ step: item.kind, path: item.originalPath, message: describe(error) })
      }
    }
  } else {
    // A function can only be supplied by an in-process caller, never by the
    // route: a JSON body has no way to encode one. This is the offline suite's
    // way to make the publish step fail, which cannot be provoked portably.
    const publish = typeof request?.publish === 'function' ? request.publish : undefined
    const group = await placeGroup(home, plan, [...items, ...deletableAttachments], { mode: 'custom', publish })
    removed.groupKey = group.groupKey
    errors.push(...group.errors)
    removed.rolledBack = group.rolledBack ?? 0
    if (group.groupKey === null) {
      // Two ways to land here: nothing could be moved at all, or the publish step
      // failed and every item was put back. Both mean the same thing to the
      // reader — nothing was lost — and both must not look like success.
      return {
        ok: false,
        code: 'publish-failed',
        error: group.rolledBack > 0
          ? `回收站未能登记这次删除，已把 ${String(group.rolledBack)} 个条目放回原处，文件都还在。`
          : '没有文件被移入回收站：所有条目都移动失败，源文件都还在。',
        sessionId,
        rolledBack: group.rolledBack ?? 0,
        errors,
      }
    }
    for (const item of group.items) account(removed, item, sessionId)
  }

  // Best-effort removal notice. The archived set and the removed log are the
  // durable truth; this only lets an open page drop the row without a reload.
  // A kept conversation must not be dropped from the page, so this fires only
  // when its own log left.
  if (quiesceTargets.includes(sessionId)) {
    try {
      ctx.emit('api-session/removed', sessionId)
    } catch {
      // Not every composition relays this event to the browser.
    }
  }

  return {
    ok: true,
    sessionId,
    toTrash,
    removed,
    trash: removed.groupKey === null ? null : { groupKey: removed.groupKey, bytes: accountTotal(removed) },
    plan: {
      sessionId,
      cwd: plan.cwd,
      sessions: [...sessions],
      artifactCount: plan.artifacts.items.length,
      // Listed for context, never subtracted from: a referenced file is not part
      // of this deletion even when the conversation is.
      referencedCount: plan.referenced.items.length,
      referencedDeletable: false,
      attachmentsSelected: deletableAttachments.filter(item => item.mirror !== true).length,
      // Attachment objects removed only because the file they duplicate was
      // deleted. Reported separately so the result page can say so.
      attachmentCopies: removed.attachmentCopies,
      warnings: plan.warnings,
    },
    errors,
  }
}

/**
 * Record one removed item under the right counter.
 * @param removed - the report being built.
 * @param item - the item that was removed.
 * @param root - the Session the deletion was requested for; its own log counts
 *   as the record, not as a child conversation.
 */
function account(removed, item, root) {
  if (item.kind === 'store') {
    removed.directories.push(item.originalPath)
    removed.directoryBytes += Number(item.bytes) || 0
    if (item.sessionId !== undefined && item.sessionId !== root) removed.children.push(item.sessionId)
    return
  }
  if (item.kind === 'cache') {
    removed.projectionCache = { path: item.originalPath, bytes: item.bytes, via: 'trash' }
    return
  }
  if (item.kind === 'artifact') {
    removed.artifacts.push(item.originalPath)
    removed.artifactBytes += Number(item.bytes) || 0
    return
  }
  if (item.kind === 'changed') {
    removed.changed.push(item.originalPath)
    removed.changedBytes += Number(item.bytes) || 0
    return
  }
  if (item.kind === 'attachment') {
    removed.attachments.push(item.originalPath)
    // A copy removed because the file it duplicated went with it. Counting it
    // apart lets the result page distinguish "you ticked the attachments" from
    // "this was the same picture you just deleted".
    if (item.mirror === true) removed.attachmentCopies += 1
  }
}

/** Total bytes of everything one purge accounted for. */
function accountTotal(removed) {
  return removed.directoryBytes + removed.artifactBytes + (removed.changedBytes ?? 0)
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * Mount this plugin's routes.
 * @param ctx - Host plugin context, with `webServer` and `sessionPersistence`.
 */
export function apply(ctx) {
  const server = ctx.webServer

  /** Route bodies share one shape: validate, run, answer, never throw out. */
  const wrap = (handler) => (req, res) => {
    void (async () => {
      try {
        await handler(req, res)
      } catch (error) {
        if (!res.headersSent) sendJson(res, 400, { ok: false, error: describe(error) })
        else res.end()
      }
    })()
  }

  /** Parse and validate one request body's Session id. */
  const sessionIdOf = (body) => {
    const sessionId = body?.sessionId
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId) || sessionId === '.' || sessionId === '..') {
      throw new Error('会话 id 不合法')
    }
    return sessionId
  }

  /** One POST-only, same-page-only route. */
  const post = (path, label, handler) => ctx.effect(() => server.register({
    kind: 'exact',
    path: `${ROUTE}${path}`,
    handler: wrap(async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '只接受 POST' })
        return
      }
      requireOwnPage(req)
      await handler(await readJsonBody(req), res)
    }),
  }), `dsh-plugin-remover: ${label} route`)

  ctx.effect(() => server.register({
    kind: 'exact',
    path: `${ROUTE}/health`,
    handler: wrap((req, res) => {
      sendJson(res, 200, { ok: true, plugin: name, version })
    }),
  }), 'dsh-plugin-remover: health route')

  post('/scan', 'scan', async (body, res) => {
    const sessionId = sessionIdOf(body)
    const plan = await buildPlan(ctx, sessionId)
    sendJson(res, 200, {
      ok: true,
      sessionId,
      title: plan.title,
      cwd: plan.cwd,
      // The dialog tells the user where a restore will put the conversation, so
      // this is part of the plan the browser must see, not a Host detail.
      workspace: plan.workspace,
      origin: plan.origin,
      parentSession: plan.parentSession,
      createdAt: plan.createdAt,
      live: plan.live,
      sessions: plan.sessions,
      store: { directories: plan.store.directories, bytes: plan.store.bytes },
      children: plan.children.map(child => ({
        sessionId: child.sessionId,
        parentSession: child.parentSession,
        title: child.title,
        cwd: child.cwd,
        origin: child.origin,
        running: child.running,
        bytes: child.bytes,
      })),
      artifacts: plan.artifacts,
      referenced: plan.referenced,
      // Without this line buildPlan computes the group and the dialog never sees
      // it, so the whole feature is invisible while every unit test is green.
      changed: plan.changed,
      attachments: plan.attachments,
      projectionCache: plan.projectionCache,
      trash: plan.trash,
      warnings: plan.warnings,
    })
  })

  // Hidden report: subagent Sessions the harness excludes from the sidebar, so
  // it never renders a Session row and this plugin's row menu can never be
  // reached for them. The panel under Plugins is the only surface that lists
  // them, and each row goes through the same delete dialog as any other.
  post('/hidden', 'hidden', async (_body, res) => {
    const home = await resolveHome()
    const rows = await findHiddenSessions(ctx.sessionPersistence, ctx, home)
    sendJson(res, 200, {
      ok: true,
      rows: rows.slice(0, MAX_REPORTED_ROWS),
      total: rows.length,
      orphans: rows.filter(row => row.parentPresent !== true).length,
    })
  })

  post('/purge', 'purge', async (body, res) => {
    const sessionId = sessionIdOf(body)
    const permanent = body?.permanent === true
    const onOverflow = body?.onOverflow
    // A permanent deletion is irreversible by definition; it is only ever
    // executed after the dialog's overflow question was acknowledged.
    if (permanent && body?.confirm !== true) throw new Error('永久删除需要确认')

    let result = await purge(ctx, { ...body, sessionId, permanent })

    if (result.ok === false && result.code === 'trash-overflow' && !permanent && body?.confirm === true) {
      if (onOverflow === 'empty-trash') {
        await emptyTrash(await resolveHome())
        result = await purge(ctx, { ...body, sessionId, permanent: false })
      } else if (onOverflow === 'purge') {
        result = await purge(ctx, { ...body, sessionId, permanent: true })
      }
    }

    if (result.ok === false) {
      const status = result.code === 'trash-overflow' ? 409 : 400
      ctx.logger?.info?.(`dsh-plugin-remover: refused session ${sessionId}: ${result.code ?? result.error}`)
      sendJson(res, status, result)
      return
    }

    ctx.logger?.info?.(
      `dsh-plugin-remover: deleted session ${sessionId} (toTrash=${String(result.toTrash)}, `
      + `dirs=${String(result.removed.directories.length)}, files=${String(result.removed.artifacts.length)}, `
      + `errors=${String(result.errors.length)})`,
    )
    sendJson(res, 200, result)
  })

  post('/trash/list', 'trash list', async (body, res) => {
    const home = await resolveHome()
    await sweepTrash(home, false)
    const settings = await readTrashSettings(home)
    const manifests = await listManifests(home)
    // A discarded sweep leaves expired groups on disk; reporting them is honest.
    const wanted = typeof body?.groupKey === 'string' && GROUP_KEY.test(body.groupKey) ? body.groupKey : null
    const groups = manifests.map(manifest => groupRow(manifest, settings, wanted === manifest.groupKey))
    sendJson(res, 200, {
      ok: true,
      settings,
      directory: trashRoot(home),
      bytes: trashUsedBytes(manifests),
      maxBytes: settings.maxBytes,
      overCapacity: settings.maxBytes > 0 && trashUsedBytes(manifests) > settings.maxBytes,
      groups: groups.slice(0, MAX_REPORTED_ROWS),
      total: groups.length,
    })
  })

  post('/trash/restore', 'trash restore', async (body, res) => {
    // Three accepted shapes: `{groupKey, itemPaths}` for one group (the pre-1.2
    // form, still used by single-row buttons), `{groups: [{groupKey, itemPaths}]}`
    // and `{groupKeys: [...]}` for a multi-selection. `restoreGroups` normalizes
    // all three and isolates each group's failure.
    const single = typeof body?.groupKey === 'string' ? body.groupKey : null
    if (single !== null && !GROUP_KEY.test(single)) throw new Error('回收组 id 不合法')
    const home = await resolveHome()
    const result = await restoreGroups(ctx, home, body ?? {})
    // The single-group answer keeps its old top-level fields, because the panel's
    // per-row buttons read `groupRemoved` from it directly.
    const group = single === null ? undefined : result.groups.find(row => row.groupKey === single)
    sendJson(res, 200, {
      ok: true,
      ...(single === null ? {} : { groupKey: single, groupRemoved: group?.groupRemoved === true }),
      ...result,
    })
  })

  post('/trash/delete', 'trash delete', async (body, res) => {
    // Deleting for good is the one place this plugin insists on an explicit
    // acknowledgement; the client sends it only after the checkbox was ticked.
    if (body?.confirm !== true) throw new Error('永久删除需要确认')
    const home = await resolveHome()
    const all = body?.all === true
    const groupKeys = Array.isArray(body?.groupKeys)
      ? body.groupKeys.filter(key => typeof key === 'string' && GROUP_KEY.test(key))
      : []
    const items = Array.isArray(body?.items)
      ? body.items
        .map(row => ({ groupKey: row?.groupKey, path: safeItemPath(row?.path) }))
        .filter(row => typeof row.groupKey === 'string' && GROUP_KEY.test(row.groupKey) && row.path !== null)
      : []
    if (!all && groupKeys.length === 0 && items.length === 0) throw new Error('没有指定要删除的内容')

    const result = await withTrashLock(async () => {
      const removed = []
      const errors = []
      let bytes = 0
      if (all) {
        const emptied = await emptyTrashUnlocked(home)
        return { removed: emptied.removed.map(key => ({ kind: 'group', groupKey: key })), bytes: emptied.bytes, errors }
      }
      for (const key of groupKeys) {
        const manifest = await readManifest(home, key)
        if (manifest === null) {
          errors.push({ step: 'group', path: key, message: '未找到该回收组' })
          continue
        }
        try {
          await rm(join(trashGroups(home), key), { recursive: true, force: true })
          removed.push({ kind: 'group', groupKey: key })
          bytes += typeof manifest.bytes === 'number' ? manifest.bytes : 0
        } catch (error) {
          errors.push({ step: 'group', path: key, message: describe(error) })
        }
      }
      const byGroup = new Map()
      for (const row of items) {
        const list = byGroup.get(row.groupKey)
        if (list === undefined) byGroup.set(row.groupKey, [row.path])
        else list.push(row.path)
      }
      for (const [key, paths] of byGroup) {
        const manifest = await readManifest(home, key)
        if (manifest === null) {
          errors.push({ step: 'group', path: key, message: '未找到该回收组' })
          continue
        }
        const remaining = []
        for (const item of manifest.items) {
          const itemPath = safeItemPath(item.path)
          if (itemPath === null || !paths.includes(itemPath)) {
            remaining.push(item)
            continue
          }
          try {
            await rm(join(trashGroups(home), key, ...itemPath.split('/')), { recursive: true, force: true })
            removed.push({ kind: 'item', groupKey: key, path: itemPath })
            bytes += Number(item.bytes) || 0
          } catch (error) {
            remaining.push(item)
            errors.push({ step: 'item', path: itemPath, message: describe(error) })
          }
        }
        if (remaining.length === 0) await rm(join(trashGroups(home), key), { recursive: true, force: true })
        else await writeManifest(home, key, { ...manifest, items: remaining })
      }
      return { removed, bytes, errors }
    })
    sendJson(res, 200, { ok: true, ...result })
  })

  post('/trash/sweep', 'trash sweep', async (_body, res) => {
    const home = await resolveHome()
    const result = await sweepTrash(home, true)
    sendJson(res, 200, { ok: true, ...result })
  })

  post('/trash/settings', 'trash settings', async (body, res) => {
    const home = await resolveHome()
    // A request with no field at all is a read; that keeps the panel's first
    // paint, and the sidebar's own probe, to one endpoint without a second route.
    const written = body?.retentionDays !== undefined
      || body?.maxBytes !== undefined
      || body?.showSidebarTrash !== undefined
    const settings = written ? await writeTrashSettings(home, body) : await readTrashSettings(home)
    sendJson(res, 200, { ok: true, settings, directory: trashRoot(home) })
  })
}

// Re-exported for the offline verification suite, which drives the plan, the
// purge, and the recycle bin against a stub Host context and a scratch home.
export const internals = {
  CHANGED_MAX_FILES,
  MIRROR_MAX_CANDIDATES,
  MIRROR_MAX_BYTES,
  NOISE_DIRECTORIES,
  artifactId,
  attachmentPaths,
  blockedRoots,
  blockingRootOf,
  buildPlan,
  cachedTitle,
  classifyItems,
  collectAttachmentIds,
  collectAttachmentMeta,
  collectSelection,
  collectTimeWindow,
  collectToolPaths,
  copyThenRemove,
  countSessionDirectories,
  descendantsOf,
  dropProjectionCache,
  emptyTrash,
  emptyTrashUnlocked,
  expiresAt,
  findAttachmentMirrors,
  findHiddenSessions,
  findSessionDirectories,
  firstZstdFrame,
  foldPath,
  groupRow,
  hashFile,
  headerMap,
  headerOf,
  insideFolded,
  listManifests,
  moveItem,
  newGroupKey,
  placeGroup,
  projectionCacheFile,
  purge,
  readTrashSettings,
  reattachConversation,
  requireOwnPage,
  resolveHome,
  restoreGroups,
  roleOfKind,
  safeItemPath,
  samePath,
  scanChangedInWindow,
  selectionOf,
  sweepTrash,
  trashGroups,
  trashRoot,
  trashUsedBytes,
  workspaceSlotOf,
  writeTrashSettings,
}
