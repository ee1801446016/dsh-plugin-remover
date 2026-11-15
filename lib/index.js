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
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** Package name the loader mounts this row as; also the browser module id. */
export const name = 'dsh-plugin-remover'

/** Version reported by `/health` and by the browser half's footer. */
export const version = '1.0.0'

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
 * A path is deletable when it is a regular file whose real path lies strictly
 * inside the recorded working directory of at least one Session being deleted,
 * and outside the DSH home (the app's own data is never a conversation
 * artifact). Everything else is reported with the reason it was refused, so the
 * dialog can show why a file the conversation mentioned is not on the list.
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
    for (const path of paths.keys()) refused.push({ path, reason: '会话未记录可用的工作目录，无法安全定位' })
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
    if (!cwds.some(cwd => inside(cwd, real))) {
      refused.push({ path, reason: '不在该对话的工作目录内，已跳过' })
      continue
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

/** Every group the recycle bin currently holds, newest first. */
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
    // A half-written group is not a group: only the atomic rename publishes one.
    if (entry.name.endsWith('.partial')) continue
    const manifest = await readManifest(home, entry.name)
    if (manifest !== null) manifests.push(manifest)
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
 * One group as the recycle-bin panel lists it.
 * @param manifest - stored manifest.
 * @param settings - current recycle-bin settings.
 * @param withItems - whether to include the per-file rows.
 * @returns the row.
 */
function groupRow(manifest, settings, withItems) {
  const expires = expiresAt(manifest, settings)
  const row = {
    groupKey: manifest.groupKey,
    sessionId: manifest.sessionId,
    title: manifest.title ?? null,
    origin: manifest.origin ?? 'session',
    parentSession: manifest.parentSession ?? null,
    deletedAt: typeof manifest.deletedAt === 'number' ? manifest.deletedAt : null,
    expiresAt: expires,
    bytes: typeof manifest.bytes === 'number' ? manifest.bytes : 0,
    itemCount: manifest.items.length,
  }
  if (withItems) {
    row.items = manifest.items.map(item => ({
      path: item.path,
      kind: item.kind,
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

  const directories = await findSessionDirectories(home, sessionId)
  const storeBytes = (await Promise.all(directories.map(directoryBytes))).reduce((a, b) => a + b, 0)

  const cacheFile = projectionCacheFile(home, sessionId)
  const cacheBytes = existsSync(cacheFile) ? await fsStat(cacheFile).then(info => info.size).catch(() => 0) : 0

  const settings = await readTrashSettings(home)
  const usedBytes = trashUsedBytes(await listManifests(home))

  return {
    home,
    sessionId,
    title: cachedTitle(home, sessionId),
    cwd,
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
      items: produced.allowed.slice(0, MAX_REPORTED_ROWS),
      refused: produced.refused.slice(0, MAX_REPORTED_ROWS),
      totalBytes: produced.allowed.reduce((sum, row) => sum + row.bytes, 0),
      truncated: produced.allowed.length > MAX_REPORTED_ROWS,
    },
    referenced: {
      items: referenced.allowed.slice(0, MAX_REPORTED_ROWS),
      refused: referenced.refused.slice(0, MAX_REPORTED_ROWS),
      totalBytes: referenced.allowed.reduce((sum, row) => sum + row.bytes, 0),
      truncated: referenced.allowed.length > MAX_REPORTED_ROWS,
    },
    attachments: { ids: [...attachmentIds].slice(0, MAX_REPORTED_ROWS) },
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
  return {
    record: include.record !== false,
    cache: include.cache !== false,
    children: include.children !== false,
    attachments: include.attachments !== false,
    // An absent list means the user ticked nothing, not "everything".
    artifactIds: Array.isArray(body?.artifactIds) ? idList(body.artifactIds) : [],
    referencedIds: Array.isArray(body?.referencedIds) ? idList(body.referencedIds) : [],
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
  const wantedReferenced = new Set(selection.referencedIds)
  const pushFiles = (rows, kind, prefix, wanted) => {
    rows.forEach((row, index) => {
      if (wanted !== null && !wanted.has(row.id)) return
      items.push({
        source: row.path,
        // Two files can share a name in different directories, so the index keeps
        // each destination unique without flattening the name out of the path.
        path: `${prefix}/${index}/${basename(row.path)}`,
        kind,
        originalPath: row.displayPath,
        bytes: row.bytes,
        sessionId: plan.sessionId,
        sources: row.sources,
      })
    })
  }
  pushFiles(plan.artifacts.items, 'artifact', 'artifacts', wantedArtifacts)
  pushFiles(plan.referenced.items, 'referenced', 'referenced', wantedReferenced)

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
 * manifest is written, so a crash mid-delete leaves an invisible partial
 * directory rather than a group that looks restorable but is not.
 *
 * @param home - resolved DSH home.
 * @param plan - freshly rebuilt plan.
 * @param items - items to move, from {@link collectSelection}.
 * @param meta - what the manifest records about the deletion.
 * @returns the group, its bytes, and the per-item errors.
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
    return { groupKey: null, bytes: 0, items: [], errors }
  }
  const manifest = {
    formatVersion: 1,
    groupKey: key,
    sessionId: plan.sessionId,
    title: plan.title,
    origin: plan.origin,
    parentSession: plan.parentSession,
    cwd: plan.cwd ?? null,
    deletedAt: Date.now(),
    mode: meta.mode,
    bytes,
    items: stored.map(item => ({
      path: item.path,
      kind: item.kind,
      originalPath: item.originalPath,
      bytes: item.bytes,
      sessionId: item.sessionId,
      ...item.sources === undefined ? {} : { sources: item.sources },
    })),
  }
  await writeManifest(home, `${key}.partial`, manifest)
  await rename(partial, final)
  return { groupKey: key, bytes, items: manifest.items, errors }
}

/**
 * Execute one plan.
 *
 * Two destinations: the recycle bin (default, reversible) or permanent deletion
 * (`permanent`, only reachable from the dialog's overflow question, from the
 * recycle-bin panel, or from an explicit permanent request).
 *
 * @param ctx - Host plugin context.
 * @param request - `{sessionId, toTrash, permanent, include, artifactIds, referencedIds, childIds}`.
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
    referenced: [],
    referencedBytes: 0,
    attachments: [],
    projectionCache: null,
    archived: false,
    interrupted: [],
    detached: [],
    children: [],
    groupKey: null,
    direct: false,
  }

  const { items, attachmentItems, sessions } = collectSelection(plan, selection, home)

  // How many attachment objects may actually go: shared ones stay.
  let deletableAttachments = []
  if (selection.attachments && attachmentItems.length > 0) {
    const shared = await idsReferencedElsewhere(ctx.sessionPersistence, sessions, plan.attachments.ids)
    deletableAttachments = attachmentItems.filter(item => {
      const id = basename(item.source)
      return !shared.has(`sha256:${id}`) && !shared.has(id)
    })
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

  const all = await quiesce(ctx, plan, [...sessions])
  removed.archived = all.removed.archived
  removed.interrupted = all.removed.interrupted
  removed.detached = all.removed.detached
  errors.push(...all.errors)

  // An empty selection is a no-op, not a failure: the user may have unticked
  // everything while the dialog still offers the button.
  if (items.length === 0 && deletableAttachments.length === 0) {
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
    const group = await placeGroup(home, plan, [...items, ...deletableAttachments], { mode: 'custom' })
    removed.groupKey = group.groupKey
    errors.push(...group.errors)
    if (group.groupKey === null) {
      return {
        ok: false,
        error: '没有文件被移入回收站：所有条目都移动失败，源文件都还在。',
        sessionId,
        errors,
      }
    }
    for (const item of group.items) account(removed, item, sessionId)
  }

  // Best-effort removal notice. The archived set and the removed log are the
  // durable truth; this only lets an open page drop the row without a reload.
  try {
    ctx.emit('api-session/removed', sessionId)
  } catch {
    // Not every composition relays this event to the browser.
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
      referencedCount: plan.referenced.items.length,
      attachmentsSelected: deletableAttachments.length,
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
  if (item.kind === 'referenced') {
    removed.referenced.push(item.originalPath)
    removed.referencedBytes += Number(item.bytes) || 0
    return
  }
  if (item.kind === 'attachment') removed.attachments.push(item.originalPath)
}

/** Total bytes of everything one purge accounted for. */
function accountTotal(removed) {
  return removed.directoryBytes + removed.artifactBytes + removed.referencedBytes
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
    const groupKey = body?.groupKey
    if (typeof groupKey !== 'string' || !GROUP_KEY.test(groupKey)) throw new Error('回收组 id 不合法')
    const wanted = Array.isArray(body?.itemPaths)
      ? body.itemPaths.map(safeItemPath).filter(path => path !== null)
      : null
    const home = await resolveHome()
    const result = await withTrashLock(async () => {
      const manifest = await readManifest(home, groupKey)
      if (manifest === null) throw new Error('未找到该回收组')
      const restored = []
      const failed = []
      const remaining = []
      for (const item of manifest.items) {
        const itemPath = safeItemPath(item.path)
        if (itemPath === null) {
          remaining.push(item)
          failed.push({ path: String(item.path), reason: '回收组记录里的路径不合法' })
          continue
        }
        if (wanted !== null && !wanted.includes(itemPath)) {
          remaining.push(item)
          continue
        }
        try {
          await restoreItem(join(trashGroups(home), groupKey, ...itemPath.split('/')), item.originalPath)
          restored.push({ path: itemPath, originalPath: item.originalPath, bytes: item.bytes })
        } catch (error) {
          remaining.push(item)
          failed.push({ path: itemPath, reason: describe(error) })
        }
      }
      const next = { ...manifest, items: remaining }
      if (remaining.length === 0) await rm(join(trashGroups(home), groupKey), { recursive: true, force: true })
      else await writeManifest(home, groupKey, next)
      return { restored, failed, groupRemoved: remaining.length === 0 }
    })
    sendJson(res, 200, { ok: true, groupKey, ...result })
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
  artifactId,
  attachmentPaths,
  buildPlan,
  cachedTitle,
  classifyItems,
  collectAttachmentIds,
  collectSelection,
  collectToolPaths,
  copyThenRemove,
  countSessionDirectories,
  descendantsOf,
  dropProjectionCache,
  emptyTrash,
  emptyTrashUnlocked,
  expiresAt,
  findHiddenSessions,
  findSessionDirectories,
  firstZstdFrame,
  groupRow,
  headerMap,
  headerOf,
  listManifests,
  moveItem,
  newGroupKey,
  placeGroup,
  projectionCacheFile,
  purge,
  readTrashSettings,
  requireOwnPage,
  resolveHome,
  safeItemPath,
  selectionOf,
  sweepTrash,
  trashGroups,
  trashRoot,
  trashUsedBytes,
  writeTrashSettings,
}
