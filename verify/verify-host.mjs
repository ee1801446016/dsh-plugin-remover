/**
 * Offline verification for dsh-plugin-remover's Host half.
 *
 * Drives the real module against a stub `sessionPersistence`, a stub Host
 * context, and a scratch DSH home under the OS temp directory. Nothing here
 * touches the real `~/.dsh`, needs a running Harness, or opens a port.
 *
 * What is actually being checked, in order of how badly it would hurt:
 *
 *   1. Only what was ticked is removed. A file the user left unselected must be
 *      byte-for-byte untouched, including its modification time.
 *   2. A deletion is reversible. Every item lands in one group with a manifest
 *      that can put it back exactly where it came from, and a restore does.
 *   3. The capacity question never loses data. An overflow is refused before
 *      anything moves, and both answers (permanent, empty-then-retry) work.
 *   4. The safe-path rules hold: nothing outside a Session's recorded `cwd`,
 *      nothing inside the DSH home, no traversal through a group key or item
 *      path, no cross-site request.
 *   5. Provenance is right: a file reports the directory it came from and the
 *      conversations that wrote or read it.
 *
 *   node verify/verify-host.mjs
 */

import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, normalize } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import { internals } from '../lib/index.js'

let checks = 0
let failures = 0

function check(label, condition, detail) {
  checks += 1
  if (condition) return
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

function equal(label, actual, expected) {
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function group(label, fn) {
  console.log(`# ${label}`)
  return fn()
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-plugin-remover-'))
const HOME = join(ROOT, 'home')
const WORKSPACE = join(ROOT, 'workspace')
const OUTSIDE = join(ROOT, 'outside')

/** The paths each Session's events will claim to have written or read. */
const files = {
  produced: join(WORKSPACE, 'src', 'produced.ts'),
  produced2: join(WORKSPACE, 'docs', 'guide.md'),
  shared: join(WORKSPACE, 'src', 'shared.ts'),
  readOnly: join(WORKSPACE, 'src', 'vendor-lib.ts'),
  outside: join(OUTSIDE, 'elsewhere.ts'),
  untracked: join(WORKSPACE, 'src', 'untouched.ts'),
}

for (const path of Object.values(files)) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `// ${path}\nexport const value = 1\n`, 'utf8')
}

// One Session directory per Session id, each with a plausible log file.
const SESSIONS = {
  parent: 'session-parent-0000',
  childA: 'child-a-1111',
  childB: 'child-b-2222',
  grandchild: 'grandchild-3333',
  orphan: 'orphan-4444',
  other: 'session-other-5555',
}
const PROJECT = '--scratch-workspace--'

/** The attachment object one Session references. */
const ATTACHMENT_HEX = 'a'.repeat(64)
const ATTACHMENT_PATH = join(HOME, 'attachments', 'v1', 'objects', 'aa', ATTACHMENT_HEX)
mkdirSync(dirname(ATTACHMENT_PATH), { recursive: true })
writeFileSync(ATTACHMENT_PATH, 'binary-image-bytes', 'utf8')

/** The attachment object two Sessions share. */
const SHARED_ATTACHMENT_HEX = 'b'.repeat(64)
const SHARED_ATTACHMENT_PATH = join(HOME, 'attachments', 'v1', 'objects', 'bb', SHARED_ATTACHMENT_HEX)
mkdirSync(dirname(SHARED_ATTACHMENT_PATH), { recursive: true })
writeFileSync(SHARED_ATTACHMENT_PATH, 'shared-bytes', 'utf8')

/** One write-call event. */
function writeCall(name, path, extra = {}) {
  return { type: 'tool/call', data: { name, arguments: JSON.stringify({ file_path: path, ...extra }) } }
}

/** One read-call event. */
function readCall(path) {
  return { type: 'tool/call', data: { name: 'read', arguments: JSON.stringify({ file_path: path }) } }
}

/** The events each Session reports. */
const events = {
  [SESSIONS.parent]: [
    writeCall('write', files.produced),
    writeCall('edit', files.produced),
    writeCall('write', files.shared),
    readCall(files.readOnly),
    readCall(files.outside),
    { type: 'user/message', data: { content: [{ type: 'image', attachment: { attachmentId: `sha256:${ATTACHMENT_HEX}` } }] } },
    { type: 'user/message', data: { content: [{ type: 'file', attachment: { attachmentId: `sha256:${SHARED_ATTACHMENT_HEX}` } }] } },
  ],
  [SESSIONS.childA]: [
    writeCall('write', files.shared),
    writeCall('write', files.untracked),
    readCall(files.readOnly),
  ],
  [SESSIONS.childB]: [],
  [SESSIONS.grandchild]: [],
  [SESSIONS.orphan]: [],
  [SESSIONS.other]: [
    { type: 'user/message', data: { content: [{ type: 'file', attachment: { attachmentId: `sha256:${SHARED_ATTACHMENT_HEX}` } }] } },
  ],
}

/** The headers the stub persistence reports. */
const headers = {
  [SESSIONS.parent]: { version: 4, id: SESSIONS.parent, createdAt: 1000, cwd: WORKSPACE, isSeeded: false },
  [SESSIONS.childA]: { version: 4, id: SESSIONS.childA, createdAt: 1100, cwd: WORKSPACE, origin: 'subagent', parentSession: SESSIONS.parent, delegationDepth: 1 },
  [SESSIONS.childB]: { version: 4, id: SESSIONS.childB, createdAt: 1200, cwd: WORKSPACE, origin: 'subagent', parentSession: SESSIONS.parent, delegationDepth: 1 },
  [SESSIONS.grandchild]: { version: 4, id: SESSIONS.grandchild, createdAt: 1300, cwd: WORKSPACE, origin: 'subagent', parentSession: SESSIONS.childA, delegationDepth: 2 },
  [SESSIONS.orphan]: { version: 4, id: SESSIONS.orphan, createdAt: 1400, cwd: WORKSPACE, origin: 'subagent', parentSession: 'session-does-not-exist', delegationDepth: 1 },
  [SESSIONS.other]: { version: 4, id: SESSIONS.other, createdAt: 1500, cwd: WORKSPACE, isSeeded: false },
}

/** A replayable persistence stub: `stored` shrinks as Sessions are deleted. */
let stored = []

/**
 * Rebuild the stub's visible world from what is on disk, so a deleted Session
 * stops being reported exactly as the real backend would.
 */
function refreshStored() {
  stored = Object.keys(headers).filter(id => existsSync(join(HOME, 'sessions', PROJECT, id)))
}

function seedSessions() {
  mkdirSync(join(HOME, 'sessions', PROJECT), { recursive: true })
  for (const id of Object.keys(headers)) {
    const directory = join(HOME, 'sessions', PROJECT, id)
    mkdirSync(directory, { recursive: true })
    // A log in the backend's real physical shape: a first frame holding only the
    // header line, then a frame of events. The degraded-persistence checks read
    // this file directly, so it has to be a log the backend would accept rather
    // than a placeholder.
    const header = headers[id]
    const line = {
      type: 'session',
      version: 4,
      id: header.id,
      createdAt: header.createdAt,
      isSeeded: header.isSeeded ?? false,
      delegationDepth: header.delegationDepth ?? 0,
      ...header.cwd === undefined ? {} : { cwd: header.cwd },
      ...header.parentSession === undefined ? {} : { parentSession: header.parentSession },
      ...header.origin === undefined ? {} : { origin: header.origin },
      ...header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset },
    }
    const bytes = Buffer.concat([
      zstdCompressSync(Buffer.from(`${JSON.stringify(line)}\n`, 'utf8')),
      zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } })}\n`, 'utf8')),
    ])
    writeFileSync(join(directory, 'session.v4.jsonl.zstd'), bytes)
  }
  for (const id of Object.keys(headers)) {
    const cacheFile = join(HOME, 'storages', 'session_projcache', 'sessions', `${id}.json`)
    mkdirSync(dirname(cacheFile), { recursive: true })
    writeFileSync(cacheFile, `${JSON.stringify({ record: { rows: { title: { val: `title-${id}` } } } })}\n`, 'utf8')
  }
}

function fakePersistence() {
  return {
    async list() {
      refreshStored()
      return stored.map(id => ({ header: headers[id], eventCount: (events[id] ?? []).length, sizeBytes: 100 }))
    },
    async stat(id) {
      refreshStored()
      if (!stored.includes(id)) throw new Error(`unknown session ${id}`)
      return { header: headers[id], eventCount: (events[id] ?? []).length, sizeBytes: 100 }
    },
    async open(id) {
      refreshStored()
      if (!stored.includes(id)) throw new Error(`unknown session ${id}`)
      return {
        async read() {
          return { events: JSON.parse(JSON.stringify(events[id] ?? [])) }
        },
        async close() {},
      }
    },
  }
}

/** A Host context stub with the services this plugin reaches for. */
function fakeContext() {
  const emitted = []
  const services = new Map()
  services.set('sessionPersistence', fakePersistence())
  const interruptions = []
  services.set('subagents', {
    interrupt(sessionId, options) {
      interruptions.push({ sessionId, options })
    },
  })
  const archived = []
  services.set('workspaceRegistry', {
    list() {
      return []
    },
    async archiveSession(sessionId, options) {
      archived.push({ sessionId, options })
    },
  })
  // Sessions this process considers open; `isLive` reads this map.
  const live = new Set()
  services.set('sessions', {
    get(sessionId) {
      return live.has(sessionId) ? { id: sessionId } : undefined
    },
  })
  const root = {
    emitted,
    interruptions,
    archived,
    live,
    sessionPersistence: services.get('sessionPersistence'),
    get(name) {
      return services.get(name)
    },
    emit(name, payload) {
      emitted.push({ name, payload })
    },
    logger: { info() {}, warn() {} },
  }
  return root
}

process.env.DSH_HOME = HOME
seedSessions()
refreshStored()

const ctx = fakeContext()
const HOME_REAL = realpathSync(HOME)
const WORKSPACE_REAL = realpathSync(WORKSPACE)

/** Read one file's bytes and mtime, so "untouched" can be asserted precisely. */
function fingerprint(path) {
  return { bytes: readFileSync(path, 'utf8'), mtime: statSync(path).mtimeMs }
}

// ---------------------------------------------------------------------------
// Provenance and classification
// ---------------------------------------------------------------------------

await group('provenance', async () => {
  const collected = internals.collectToolPaths(events[SESSIONS.parent], WORKSPACE)
  check('a written path is collected', collected.written.has(files.produced))
  equal('its call count is summed', collected.written.get(files.produced).ops, 2)
  check('both writing tools are remembered', [...collected.written.get(files.produced).tools].sort().join(',') === 'edit,write')
  check('a read path is collected separately', collected.read.has(files.readOnly))
  check('a written path is not in the read map', !collected.read.has(files.produced))
})

await group('classification', async () => {
  const paths = new Map()
  const collected = internals.collectToolPaths(events[SESSIONS.parent], WORKSPACE)
  /** Build the provenance entry a single-Session path carries. */
  const entry = (row) => ({
    ops: row.ops,
    tools: row.tools,
    sources: new Map([[SESSIONS.parent, {
      sessionId: SESSIONS.parent,
      title: 'parent title',
      origin: 'session',
      ops: row.ops,
      tools: row.tools,
    }]]),
  })
  for (const [path, row] of collected.written) paths.set(path, entry(row))
  // A file the conversation named that lives outside its working directory.
  paths.set(files.outside, entry({ ops: 1, tools: new Set(['write']) }))

  const { allowed, refused } = await internals.classifyItems(paths, [WORKSPACE_REAL], HOME, 'artifact')
  const allowedPaths = allowed.map(row => row.path)
  check('a produced file is allowed', allowedPaths.includes(realpathSync(files.produced)))
  check('a file outside the working directory is refused', !allowedPaths.includes(realpathSync(files.outside)))
  const reason = refused.find(row => row.path === files.outside)?.reason
  equal('the refusal names the working-directory rule', reason, '不在该对话的工作目录内，已跳过')
  const row = allowed.find(item => item.path === realpathSync(files.produced))
  equal('the row reports its source directory', row.dir, realpathSync(dirname(files.produced)))
  equal('the row reports its byte size', row.bytes, statSync(files.produced).size)
  check('the row carries a stable id', /^a[0-9a-f]{12}$/.test(row.id))
  equal('the id is the hash of the real path', row.id, internals.artifactId(realpathSync(files.produced)))
  check('the row carries provenance', Array.isArray(row.sources) && row.sources.length === 1)
  equal('the provenance names the Session', row.sources[0].sessionId, SESSIONS.parent)
})

await group('no working directory', async () => {
  const paths = new Map([[files.produced, { ops: 1, tools: new Set(['write']), sources: new Map() }]])
  const { allowed, refused } = await internals.classifyItems(paths, [], HOME, 'artifact')
  equal('nothing is allowed without a working directory', allowed.length, 0)
  equal('and it is reported', refused.length, 1)
})

await group('attachment paths', () => {
  const found = internals.attachmentPaths(HOME, `sha256:${ATTACHMENT_HEX}`)
  equal('three candidate paths are implied', found.length, 3)
  equal('the image object is first', found[0].path, ATTACHMENT_PATH)
  equal('malformed ids resolve to nothing', internals.attachmentPaths(HOME, 'not-a-hash').length, 0)
})

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

const plan = await internals.buildPlan(ctx, SESSIONS.parent)

await group('plan shape', () => {
  equal('the root Session is reported', plan.sessionId, SESSIONS.parent)
  equal('its working directory is reported', plan.cwd, WORKSPACE)
  equal('the cached title is read', plan.title, `title-${SESSIONS.parent}`)
  // The whole subtree goes: a grandchild under a deleted child has no entry
  // point left either, so it is part of the same footprint.
  equal('the plan lists the Session and all three descendants', plan.sessions.length, 4)
  equal('every descendant is listed as a child', plan.children.map(row => row.sessionId).sort().join(','),
    [SESSIONS.childA, SESSIONS.childB, SESSIONS.grandchild].sort().join(','))
  equal('an orphan child is not adopted', plan.children.some(row => row.sessionId === SESSIONS.orphan), false)
  check('a child reports its own byte size', plan.children.every(row => row.bytes > 0))
  equal('a grandchild reports its parent', plan.children.find(row => row.sessionId === SESSIONS.grandchild).parentSession, SESSIONS.childA)
})

await group('plan selection', () => {
  const produced = plan.artifacts.items.map(row => row.path)
  check('the produced file is in the artifacts', produced.includes(realpathSync(files.produced)))
  check('the shared file written by parent and child appears once', produced.filter(path => path === realpathSync(files.shared)).length === 1)
  equal('the shared file reports both sources', plan.artifacts.items.find(row => row.path === realpathSync(files.shared)).sources.length, 2)
  equal('the artifact byte total is the sum', plan.artifacts.totalBytes, plan.artifacts.items.reduce((sum, row) => sum + row.bytes, 0))
  const read = plan.referenced.items.map(row => row.path)
  check('the read-only file is in `referenced`', read.includes(realpathSync(files.readOnly)))
  check('a written file is not also listed as read', !read.includes(realpathSync(files.produced)))
  check('a read file outside the working directory is refused', !read.includes(realpathSync(files.outside)))
  equal('the two attachments are reported', plan.attachments.ids.length, 2)
  equal('the projection cache is found', plan.projectionCache.exists, true)
})

await group('plan caps', () => {
  // The cap is a response-size guard, not a deletion limit: the Host rebuilds
  // the plan on purge, so an unticked-but-listed file is still not deleted.
  check('provenance is capped per file', plan.artifacts.items.every(row => row.sources.length <= 16))
  check('tools are capped per file', plan.artifacts.items.every(row => row.tools.length <= 8))
})

// ---------------------------------------------------------------------------
// Purge into the recycle bin
// ---------------------------------------------------------------------------

const before = {
  produced: fingerprint(files.produced),
  produced2: fingerprint(files.produced2),
  readOnly: fingerprint(files.readOnly),
  outside: fingerprint(files.outside),
  untracked: fingerprint(files.untracked),
}

const artifactIds = [plan.artifacts.items.find(row => row.path === realpathSync(files.produced)).id]

// Both children count as open here, so the interrupt branch runs; the parent is
// left closed so the archive branch is asserted separately below.
ctx.live.add(SESSIONS.childA)
ctx.live.add(SESSIONS.childB)

const first = await internals.purge(ctx, {
  sessionId: SESSIONS.parent,
  include: { record: true, cache: true, children: true, attachments: true },
  artifactIds,
  referencedIds: [],
  childIds: [SESSIONS.childA, SESSIONS.childB],
})

await group('purge result', () => {
  equal('the purge succeeds', first.ok, true)
  check('it went into the recycle bin', typeof first.trash?.groupKey === 'string' && first.trash.groupKey.length > 0)
  equal('the recorded directories are reported', first.removed.directories.length, 3)
  equal('both children are reported', first.removed.children.length, 2)
  equal('one produced file is reported', first.removed.artifacts.length, 1)
  equal('no referenced file is reported', first.removed.referenced.length, 0)
  check('the projection cache is reported', first.removed.projectionCache !== null)
  equal('there are no errors', first.errors.length, 0)
})

await group('purge moved only what was ticked', () => {
  check('the ticked produced file is gone from its directory', !existsSync(files.produced))
  check('the unticked produced file is still there', existsSync(files.produced2))
  equal('the unticked produced file is byte-identical', fingerprint(files.produced2).bytes, before.produced2.bytes)
  equal('the unticked produced file keeps its mtime', fingerprint(files.produced2).mtime, before.produced2.mtime)
  check('the unticked referenced file is still there', existsSync(files.readOnly))
  equal('the unticked referenced file is byte-identical', fingerprint(files.readOnly).bytes, before.readOnly.bytes)
  check('a file outside the working directory is untouched', existsSync(files.outside))
  equal('a file outside the working directory is byte-identical', fingerprint(files.outside).bytes, before.outside.bytes)
  check('the Session log directory is gone', !existsSync(join(HOME, 'sessions', PROJECT, SESSIONS.parent)))
  check('the child log directory is gone', !existsSync(join(HOME, 'sessions', PROJECT, SESSIONS.childA)))
  check('the grandchild was not deleted', existsSync(join(HOME, 'sessions', PROJECT, SESSIONS.grandchild)))
  check('the orphan was not deleted', existsSync(join(HOME, 'sessions', PROJECT, SESSIONS.orphan)))
  check('the other Session survives', existsSync(join(HOME, 'sessions', PROJECT, SESSIONS.other)))
  check('the projection cache is gone', !existsSync(join(HOME, 'storages', 'session_projcache', 'sessions', `${SESSIONS.parent}.json`)))
})

await group('attachments', () => {
  check('the unshared attachment moved out of the store', !existsSync(ATTACHMENT_PATH))
  check('the shared attachment is kept', existsSync(SHARED_ATTACHMENT_PATH))
  equal('one attachment path is reported', first.removed.attachments.length, 1)
})

await group('group manifest', async () => {
  const key = first.trash.groupKey
  const manifestPath = join(internals.trashGroups(HOME), key, 'manifest.json')
  check('a manifest is written', existsSync(manifestPath))
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  equal('the manifest records the Session', manifest.sessionId, SESSIONS.parent)
  equal('the manifest records the origin', manifest.origin, 'session')
  equal('the manifest records a deletion time', typeof manifest.deletedAt, 'number')
  equal('the manifest byte total matches the items', manifest.bytes, manifest.items.reduce((sum, item) => sum + item.bytes, 0))
  const kinds = new Set(manifest.items.map(item => item.kind))
  check('it holds the conversation files', kinds.has('store'))
  check('it holds the projection cache', kinds.has('cache'))
  check('it holds the produced file', kinds.has('artifact'))
  check('it holds the attachment', kinds.has('attachment'))
  check('every item records its original absolute path', manifest.items.every(item => typeof item.originalPath === 'string' && item.originalPath.length > 0))
  check('every item path is group-relative', manifest.items.every(item => internals.safeItemPath(item.path) !== null))
  const artifactItem = manifest.items.find(item => item.kind === 'artifact')
  check('the produced file is stored under its own name', artifactItem.path.endsWith('produced.ts'))
  equal('the stored file is actually on disk', existsSync(join(internals.trashGroups(HOME), key, ...artifactItem.path.split('/'))), true)
  check('no half-written group is left behind', !existsSync(join(internals.trashGroups(HOME), `${key}.partial`)))
})

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/**
 * Restore through the exported internals, mirroring what the route does.
 * @param groupKey - the group to restore.
 * @param only - item paths to restore, or an empty list for all of them.
 */
async function runRestore(groupKey, only) {
  const manifest = JSON.parse(readFileSync(join(internals.trashGroups(HOME), groupKey, 'manifest.json'), 'utf8'))
  const chosen = only.length === 0 ? manifest.items.map(item => item.path) : only
  const restored = []
  const remaining = []
  for (const item of manifest.items) {
    if (!chosen.includes(item.path)) {
      remaining.push(item)
      continue
    }
    try {
      await internals.moveItem(join(internals.trashGroups(HOME), groupKey, ...item.path.split('/')), item.originalPath)
      restored.push(item)
    } catch {
      remaining.push(item)
    }
  }
  return { restored, remaining }
}

await group('single-file restore', async () => {
  const key = first.trash.groupKey
  const manifest = JSON.parse(readFileSync(join(internals.trashGroups(HOME), key, 'manifest.json'), 'utf8'))
  const artifactItem = manifest.items.find(item => item.kind === 'artifact')
  const outcome = await runRestore(key, [artifactItem.path])
  equal('one item is restored', outcome.restored.length, 1)
  check('the produced file is back at its original path', existsSync(files.produced))
  equal('and is byte-identical', readFileSync(files.produced, 'utf8'), before.produced.bytes)
  equal('the other items stay in the group', outcome.remaining.length, manifest.items.length - 1)
})

// ---------------------------------------------------------------------------
// Emptying, retention, settings
// ---------------------------------------------------------------------------

await group('settings', async () => {
  const defaults = await internals.readTrashSettings(HOME)
  equal('the default retention is 30 days', defaults.retentionDays, 30)
  equal('the default cap is 2 GiB', defaults.maxBytes, 2 * 1024 * 1024 * 1024)
  equal('the sidebar entry is on by default', defaults.showSidebarTrash, true)
  const written = await internals.writeTrashSettings(HOME, { retentionDays: 7, maxBytes: 1024 })
  equal('a written retention is stored', written.retentionDays, 7)
  equal('a written cap is stored', written.maxBytes, 1024)
  equal('a partial write leaves the sidebar entry alone', written.showSidebarTrash, true)
  const clamped = await internals.writeTrashSettings(HOME, { retentionDays: -5, maxBytes: 2 ** 50 })
  equal('a negative retention clamps to zero', clamped.retentionDays, 0)
  equal('an oversized cap clamps to the ceiling', clamped.maxBytes, 1024 ** 4)
  const reread = await internals.readTrashSettings(HOME)
  equal('the clamped values survive a reread', `${reread.retentionDays}:${reread.maxBytes}`, '0:1099511627776')

  // Writes are patches. A replacement would let the plugin page's sidebar
  // toggle wipe the retention and the cap it does not show.
  const off = await internals.writeTrashSettings(HOME, { showSidebarTrash: false })
  equal('the sidebar entry can be switched off', off.showSidebarTrash, false)
  equal('switching it off keeps the retention', off.retentionDays, 0)
  equal('switching it off keeps the cap', off.maxBytes, 1024 ** 4)
  const onlyRetention = await internals.writeTrashSettings(HOME, { retentionDays: 12 })
  equal('writing the retention keeps the switch off', onlyRetention.showSidebarTrash, false)
  equal('writing the retention stores it', onlyRetention.retentionDays, 12)
  const nonBoolean = await internals.writeTrashSettings(HOME, { showSidebarTrash: 'yes' })
  equal('a non-boolean switch falls back to the stored value', nonBoolean.showSidebarTrash, false)
  const backOn = await internals.writeTrashSettings(HOME, { showSidebarTrash: true })
  equal('the sidebar entry can be switched back on', backOn.showSidebarTrash, true)
  // Back to the defaults, so the next assertions are meaningful.
  await internals.writeTrashSettings(HOME, { retentionDays: 30, maxBytes: 2 * 1024 * 1024 * 1024 })
})

await group('expiry', async () => {
  const settings = { retentionDays: 30, maxBytes: 0 }
  const fresh = { deletedAt: Date.now() }
  const stale = { deletedAt: Date.now() - 31 * 24 * 60 * 60 * 1000 }
  check('a fresh group does not expire', internals.expiresAt(fresh, settings) > Date.now())
  check('a stale group has expired', internals.expiresAt(stale, settings) < Date.now())
  equal('retention 0 means never', internals.expiresAt(stale, { retentionDays: 0 }), null)
})

await group('sweep', async () => {
  // Age the group we still hold, then sweep.
  const key = first.trash.groupKey
  const manifestPath = join(internals.trashGroups(HOME), key, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.deletedAt = Date.now() - 40 * 24 * 60 * 60 * 1000
  writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8')
  const swept = await internals.sweepTrash(HOME, true)
  equal('the expired group is swept', swept.removed.length, 1)
  check('its directory is gone', !existsSync(join(internals.trashGroups(HOME), key)))
  // The sweep is a deletion, not a restore: what it still held does not come back.
  // The produced file was already restored above, so it must survive the sweep —
  // it is no longer in the group.
  check('a file restored earlier is untouched by the sweep', existsSync(files.produced))
  check('the conversation log it still held stays gone', !existsSync(join(HOME, 'sessions', PROJECT, SESSIONS.childA)))
})

// ---------------------------------------------------------------------------
// Overflow: refusal, then both answers
// ---------------------------------------------------------------------------

await group('overflow refusal loses nothing', async () => {
  await internals.writeTrashSettings(HOME, { retentionDays: 30, maxBytes: 1 })
  const small = await internals.purge(ctx, {
    sessionId: SESSIONS.other,
    include: { record: true, cache: true, children: true, attachments: false },
  })
  equal('the purge is refused', small.ok, false)
  equal('the refusal is coded', small.code, 'trash-overflow')
  check('the refusal reports the incoming size', small.incomingBytes > 0)
  check('the refusal is flagged as impossible to fit', small.onlyPurge === true)
  check('the refused Session log is untouched', existsSync(join(HOME, 'sessions', PROJECT, SESSIONS.other)))
  check('no group was created', (await internals.listManifests(HOME)).length === 0)
})

await group('overflow answered with a permanent delete', async () => {
  // An ordinary Session that is open must be archived, not interrupted.
  ctx.live.clear()
  ctx.live.add(SESSIONS.other)
  const result = await internals.purge(ctx, {
    sessionId: SESSIONS.other,
    permanent: true,
    include: { record: true, cache: true, children: true, attachments: true },
  })
  equal('the purge succeeds', result.ok, true)
  equal('it was not put in the recycle bin', result.toTrash, false)
  equal('it is marked permanent', result.removed.direct, true)
  equal('an open ordinary Session is archived', ctx.archived.length, 1)
  equal('the archive stops its activity', ctx.archived[0]?.options?.stopActivity, true)
  equal('it was not interrupted', ctx.interruptions.filter(row => row.sessionId === SESSIONS.other).length, 0)
  check('the log directory is gone', !existsSync(join(HOME, 'sessions', PROJECT, SESSIONS.other)))
  ctx.live.clear()
})

await group('overflow answered by emptying the bin', async () => {
  // A second group, so the bin is not empty when we need it full.
  await internals.writeTrashSettings(HOME, { retentionDays: 30, maxBytes: 0 })
  const seeded = await internals.purge(ctx, {
    sessionId: SESSIONS.orphan,
    include: { record: true, cache: true, children: true, attachments: false },
  })
  equal('a group is created with no cap', seeded.ok, true)
  const before = (await internals.listManifests(HOME)).length
  check('the bin holds a group', before > 0)

  // Now the cap cannot hold the grandchild, and the bin is full.
  await internals.writeTrashSettings(HOME, { retentionDays: 30, maxBytes: 1 })
  const refused = await internals.purge(ctx, {
    sessionId: SESSIONS.grandchild,
    include: { record: true, cache: true, children: true, attachments: false },
  })
  equal('the second purge is refused', refused.ok, false)

  const emptied = await internals.emptyTrash(HOME)
  equal('the bin is emptied', emptied.removed.length, before)
  equal('the bin is now empty', (await internals.listManifests(HOME)).length, 0)

  await internals.writeTrashSettings(HOME, { retentionDays: 30, maxBytes: 0 })
  const retried = await internals.purge(ctx, {
    sessionId: SESSIONS.grandchild,
    include: { record: true, cache: true, children: true, attachments: false },
  })
  equal('the retry succeeds', retried.ok, true)
  equal('and it is in the bin', retried.toTrash, true)
})

await group('subagent interrupt', () => {
  // A running subagent must go through `subagents.interrupt`, never
  // `archiveSession`: a subagent has no Workspace row to archive, and archiving
  // an ordinary Session is what the other branch is for.
  check('a running subagent is interrupted', ctx.interruptions.length > 0,
    `interruptions: ${String(ctx.interruptions.length)}`)
  check('every interrupt names a subagent Session', ctx.interruptions.every(row => row.sessionId.startsWith('child-')))
  check('every interrupt is a user cancellation', ctx.interruptions.every(row => row.options?.kind === 'user'))
  check('no subagent was archived',
    !ctx.archived.some(row => row.sessionId === SESSIONS.childA || row.sessionId === SESSIONS.childB || row.sessionId === SESSIONS.grandchild))
})

await group('cross-volume copy', async () => {
  // `rename` cannot cross volumes, and the recycle bin usually lives on a
  // different drive from the workspace. `copyThenRemove` is that path; it is
  // exercised directly because a real EXDEV cannot be provoked on one volume.
  const source = join(ROOT, 'exdev-source.txt')
  const destination = join(ROOT, 'exdev-destination', 'nested', 'copy.txt')
  writeFileSync(source, 'cross-volume payload', 'utf8')
  const mode = await internals.copyThenRemove(source, destination)
  equal('the copy reports its mode', mode, 'copy')
  check('the destination exists', existsSync(destination))
  equal('the copy is byte-identical', readFileSync(destination, 'utf8'), 'cross-volume payload')
  check('the source is removed only after the copy verified', !existsSync(source))

  // A directory moves the same way.
  const directory = join(ROOT, 'exdev-dir')
  mkdirSync(join(directory, 'inner'), { recursive: true })
  writeFileSync(join(directory, 'inner', 'a.txt'), 'aaa', 'utf8')
  writeFileSync(join(directory, 'b.txt'), 'bbbb', 'utf8')
  await internals.copyThenRemove(directory, join(ROOT, 'exdev-dir-copy'))
  check('a directory is copied recursively', existsSync(join(ROOT, 'exdev-dir-copy', 'inner', 'a.txt')))
  equal('a copied directory keeps its bytes', readFileSync(join(ROOT, 'exdev-dir-copy', 'b.txt'), 'utf8'), 'bbbb')
  check('the source directory is removed', !existsSync(directory))
})

await group('referenced selection', async () => {
  // Deleting a file the conversation merely read is opt-in, one id at a time.
  const readPlan = await internals.buildPlan(ctx, SESSIONS.other)
  void readPlan
  // Re-seed a parent with a readable file, so the selection can be asserted.
  mkdirSync(join(HOME, 'sessions', PROJECT, 'session-ref-0006'), { recursive: true })
  writeFileSync(join(HOME, 'sessions', PROJECT, 'session-ref-0006', 'session.v4.jsonl.zstd'), 'ref\n', 'utf8')
  headers['session-ref-0006'] = { version: 4, id: 'session-ref-0006', createdAt: 1700, cwd: WORKSPACE }
  events['session-ref-0006'] = [readCall(files.readOnly)]
  refreshStored()

  const planRef = await internals.buildPlan(ctx, 'session-ref-0006')
  equal('the read file is reported as referenced', planRef.referenced.items.length, 1)
  equal('nothing is reported as produced', planRef.artifacts.items.length, 0)
  const readId = planRef.referenced.items[0].id

  // Unticked: the file must not be touched.
  const untouched = await internals.purge(ctx, {
    sessionId: 'session-ref-0006',
    include: { record: true, cache: true, children: true, attachments: false },
    artifactIds: [],
    referencedIds: [],
  })
  equal('a purge with no referenced ids succeeds', untouched.ok, true)
  check('the read file is untouched', existsSync(files.readOnly))
  equal('and no referenced file is reported', untouched.removed.referenced.length, 0)

  // Ticked: it moves into the group.
  mkdirSync(join(HOME, 'sessions', PROJECT, 'session-ref-0007'), { recursive: true })
  writeFileSync(join(HOME, 'sessions', PROJECT, 'session-ref-0007', 'session.v4.jsonl.zstd'), 'ref\n', 'utf8')
  headers['session-ref-0007'] = { version: 4, id: 'session-ref-0007', createdAt: 1800, cwd: WORKSPACE }
  events['session-ref-0007'] = [readCall(files.readOnly)]
  refreshStored()
  const planRef2 = await internals.buildPlan(ctx, 'session-ref-0007')
  const moved = await internals.purge(ctx, {
    sessionId: 'session-ref-0007',
    include: { record: true, cache: true, children: true, attachments: false },
    artifactIds: [],
    referencedIds: [planRef2.referenced.items[0].id],
  })
  equal('the ticked referenced file is removed', moved.removed.referenced.length, 1)
  check('it left its directory', !existsSync(files.readOnly))
  equal('the id it was addressed by is the plan id', planRef2.referenced.items[0].id, readId)
})

await group('stale id', async () => {
  // An id the Host did not produce resolves to nothing: the selection is a
  // filter over a freshly rebuilt plan, not a list of paths to trust.
  const other = await internals.purge(ctx, {
    sessionId: 'session-ref-0007',
    include: { record: false, cache: false, children: false, attachments: false },
    artifactIds: ['adeadbeefcafe'],
    referencedIds: ['ffffffffffff'],
  })
  equal('a purge with only stale ids still succeeds', other.ok, true)
  equal('and removes nothing', other.removed.artifacts.length, 0)
})

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

await group('path traversal', async () => {
  const root = internals.trashRoot(HOME)
  equal('a traversal group key is rejected', internals.safeItemPath('../../etc/passwd'), null)
  equal('an absolute item path is rejected', internals.safeItemPath('/etc/passwd'), null)
  equal('a backslash item path is rejected', internals.safeItemPath('..\\..\\evil'), null)
  equal('a dotted item path is rejected', internals.safeItemPath('./a/b'), null)
  equal('an empty segment is rejected', internals.safeItemPath('a//b'), null)
  equal('a normal item path is accepted', internals.safeItemPath('artifacts/0/produced.txt'), 'artifacts/0/produced.txt')
  check('the trash root is under the DSH home', root.startsWith(HOME_REAL) || root.startsWith(HOME))
  // The directory is named after this package. A rename that updates the module
  // name but not this path would leave the plugin writing into the previous
  // package's directory — which is exactly what a bulk find-and-replace missed
  // once, because the source names the directory separately.
  equal('the trash root is named after this package',
    normalize(root), normalize(join(HOME, 'dsh-plugin-remover', 'trash')))
})

await group('symlink escape', async () => {
  const linkDir = join(WORKSPACE, 'linked')
  mkdirSync(linkDir, { recursive: true })
  const target = join(OUTSIDE, 'outside.txt')
  writeFileSync(target, 'secret', 'utf8')
  const link = join(linkDir, 'escape.txt')
  try {
    symlinkSync(target, link)
  } catch {
    // A host without symlink permission cannot run this check.
    return
  }
  const paths = new Map([[link, { ops: 1, tools: new Set(['write']), sources: new Map() }]])
  const { allowed, refused } = await internals.classifyItems(paths, [WORKSPACE_REAL], HOME, 'artifact')
  equal('a symlink out of the working directory is refused', allowed.length, 0)
  equal('and it is reported', refused.length, 1)
})

await group('degraded persistence', async () => {
  // A single unreadable log can make the backend's `list()` reject outright.
  // Before the disk fallback, that emptied the hidden list and made a parent's
  // subagent tree look childless while the children sat on disk — the exact
  // situation this plugin exists to clean up.
  //
  // Earlier groups deleted most Sessions, so one is written here in the real
  // physical shape; the fallback has to find it by reading the log itself.
  const survivor = SESSIONS.childB
  mkdirSync(join(HOME, 'sessions', PROJECT, survivor), { recursive: true })
  const line = {
    type: 'session',
    version: 4,
    id: survivor,
    createdAt: headers[survivor].createdAt,
    cwd: WORKSPACE,
    isSeeded: false,
    delegationDepth: 1,
    origin: 'subagent',
    parentSession: SESSIONS.parent,
  }
  writeFileSync(join(HOME, 'sessions', PROJECT, survivor, 'session.v4.jsonl.zstd'), Buffer.concat([
    zstdCompressSync(Buffer.from(`${JSON.stringify(line)}\n`, 'utf8')),
    zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } })}\n`, 'utf8')),
  ]))
  refreshStored()
  const broken = {
    ...fakePersistence(),
    async list() {
      // Reject the whole listing, exactly as a corrupt log does upstream.
      throw new Error('stored log is corrupt: complete frame contains a torn JSONL record')
    },
  }
  const rows = await internals.findHiddenSessions(broken, ctx, HOME)
  check('the hidden list survives a failing list()', rows.length > 0)
  check('it still finds the subagent conversation', rows.some(row => row.sessionId === survivor))

  const recovered = await internals.headerMap(broken, HOME)
  check('the disk fallback recovers headers', recovered.size > 0)
  for (const header of recovered.values()) check('a recovered header carries an id', typeof header.id === 'string')
  equal('the recovered header carries its parent', recovered.get(survivor)?.parentSession, SESSIONS.parent)

  // A partial listing must not hide the Sessions it dropped either.
  const partial = {
    ...fakePersistence(),
    async list() {
      return [{ header: headers[survivor] }]
    },
  }
  const partialMap = await internals.headerMap(partial, HOME)
  check('a short listing is completed from disk', partialMap.size >= 1)

  // The fast path stays cheap: a healthy seam that reports every stored Session
  // returns without decompressing any log.
  const healthy = await internals.headerMap(fakePersistence(), HOME)
  check('a healthy listing still returns every header', healthy.size >= 1)
})

await group('request marker', () => {
  const expectsThrow = (headers) => {
    try {
      internals.requireOwnPage({ headers })
      return false
    } catch {
      return true
    }
  }
  check('a request without the marker is refused', expectsThrow({}))
  check('a request with the marker is accepted', !expectsThrow({ 'x-dsh-plugin-remover': '1' }))
  check('a cross-origin request is refused', expectsThrow({
    'x-dsh-plugin-remover': '1',
    origin: 'http://evil.example',
    host: '127.0.0.1:1234',
  }))
  check('a same-origin request is accepted', !expectsThrow({
    'x-dsh-plugin-remover': '1',
    origin: 'http://127.0.0.1:1234',
    host: '127.0.0.1:1234',
  }))
  check('a malformed origin is refused', expectsThrow({ 'x-dsh-plugin-remover': '1', origin: 'not a url' }))
})

await group('selection normalization', () => {
  // A `mode` field is ignored, not honoured: it belonged to an earlier
  // single-scope dialog, and accepting it would let a request widen the deletion
  // past the per-file selection this plugin uses. Silence is the safe answer.
  const legacy = internals.selectionOf({ mode: 'everything' })
  equal('a legacy mode selects no produced files', legacy.artifactIds.length, 0)
  equal('a legacy mode selects no referenced files', legacy.referencedIds.length, 0)
  equal('a legacy mode does not tick attachments on its own', legacy.attachments, true)
  const record = internals.selectionOf({ mode: 'record' })
  equal('a legacy record mode is not widened either', record.artifactIds.length, 0)
  const unticked = internals.selectionOf({ include: { attachments: false }, artifactIds: [] })
  equal('an empty id list selects nothing', unticked.artifactIds.length, 0)
  equal('the attachments flag is honoured', unticked.attachments, false)
  const named = internals.selectionOf({ artifactIds: ['a1111111111111'] })
  equal('a named id is kept', named.artifactIds.join(','), 'a1111111111111')
})

await group('hidden report', async () => {
  // Re-seed a child so the hidden report has something to describe.
  mkdirSync(join(HOME, 'sessions', PROJECT, SESSIONS.childA), { recursive: true })
  writeFileSync(join(HOME, 'sessions', PROJECT, SESSIONS.childA, 'session.v4.jsonl.zstd'), 'x\n', 'utf8')
  const rows = await internals.findHiddenSessions(ctx.sessionPersistence, ctx, HOME)
  check('the hidden report includes the child', rows.some(row => row.sessionId === SESSIONS.childA))
  check('every hidden row is a subagent Session', rows.every(row => row.parentSession !== null))
  const child = rows.find(row => row.sessionId === SESSIONS.childA)
  equal('a hidden row reports whether its parent survives', typeof child.parentPresent, 'boolean')
  equal('a hidden row reports its byte size', typeof child.bytes, 'number')
  check('hidden rows are sorted newest first', rows.every((row, index) => index === 0 || (rows[index - 1].createdAt ?? 0) >= (row.createdAt ?? 0)))
})

await group('descendants', async () => {
  const map = new Map(Object.entries(headers))
  const children = internals.descendantsOf(map, SESSIONS.parent).map(header => header.id).sort()
  equal('the whole subtree is found', children.join(','), [SESSIONS.childA, SESSIONS.childB, SESSIONS.grandchild].sort().join(','))
  const deep = internals.descendantsOf(map, SESSIONS.childA).map(header => header.id)
  equal('a grandchild is found from its own parent', deep.join(','), SESSIONS.grandchild)
  equal('a leaf has no descendants', internals.descendantsOf(map, SESSIONS.grandchild).length, 0)
  equal('a sibling is not a descendant', internals.descendantsOf(map, SESSIONS.childB).length, 0)
})

await group('error paths', async () => {
  const missing = await internals.buildPlan(ctx, SESSIONS.other)
  check('a plan for an unknown Session still returns a shape', typeof missing.sessionId === 'string')
  const rows = await internals.findHiddenSessions(ctx.sessionPersistence, ctx, HOME)
  check('the hidden report never throws', Array.isArray(rows))
})

await group('storage accounting', async () => {
  const manifests = await internals.listManifests(HOME)
  const total = internals.trashUsedBytes(manifests)
  check('the bin reports a byte total', typeof total === 'number' && total >= 0)
  for (const manifest of manifests) {
    const row = internals.groupRow(manifest, { retentionDays: 30, maxBytes: 0 }, true)
    equal('a group row carries its item count', row.itemCount, manifest.items.length)
    check('a group row carries its items when asked', Array.isArray(row.items))
    check('each item row reports a source directory', row.items.every(item => typeof item.dir === 'string'))
  }
})

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

rmSync(ROOT, { recursive: true, force: true })

console.log(`\n${String(checks - failures)}/${String(checks)} checks passed`)
if (failures > 0) process.exitCode = 1
