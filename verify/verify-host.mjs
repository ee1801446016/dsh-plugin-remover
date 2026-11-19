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
import { createHash } from 'node:crypto'
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
  // Every route the plugin registers, so the tests can drive the real HTTP
  // surface instead of calling buildPlan directly. A field the route forgets to
  // forward is invisible to a unit test and invisible in the UI at the same
  // time — which is exactly how the `changed` group shipped broken.
  const routes = new Map()
  services.set('webServer', {
    register(spec) {
      routes.set(spec.path, spec)
      return () => { routes.delete(spec.path) }
    },
  })
  const interruptions = []
  services.set('subagents', {
    interrupt(sessionId, options) {
      interruptions.push({ sessionId, options })
    },
  })
  const archived = []
  const attached = []
  const unarchived = []
  const created = []
  // A mutable Workspace registry stub. The plugin talks to this interface in two
  // places: `buildPlan` reads `list()` to record which workspace a conversation
  // belongs to, and a restore re-attaches/unarchives/creates. Both need to be
  // observable, or the restore path could silently do nothing and still pass.
  const workspaces = []
  const workspaceRegistry = {
    list() {
      return workspaces
    },
    get(id) {
      return workspaces.find(row => row.id === id)
    },
    async resolveByPath(path) {
      let canonical
      try {
        canonical = realpathSync(path)
      } catch {
        return undefined
      }
      return workspaces.find(row => internals.samePath(row.path, canonical))
    },
    async create(path, title) {
      const row = {
        id: `workspace-made-${String(workspaces.length + 1)}`,
        path,
        title: title ?? 'made',
        sessionIds: [],
        async attachSession(sessionId) {
          this.sessionIds.push(sessionId)
          attached.push({ workspaceId: this.id, sessionId })
        },
        async detachSession(sessionId) {
          this.sessionIds = this.sessionIds.filter(id => id !== sessionId)
        },
      }
      workspaces.push(row)
      created.push({ path, title })
      return row
    },
    async archiveSession(sessionId, options) {
      archived.push({ sessionId, options })
    },
    async unarchiveSession(sessionId) {
      unarchived.push(sessionId)
    },
  }
  /**
   * Add one already-existing workspace whose directory is `path`.
   * @param path - existing directory.
   * @param title - display title.
   * @returns the added row.
   */
  const addWorkspace = (path, title) => {
    const row = {
      id: `workspace-${String(workspaces.length + 1)}`,
      path,
      title,
      sessionIds: [],
      async attachSession(sessionId) {
        this.sessionIds.push(sessionId)
        attached.push({ workspaceId: this.id, sessionId })
      },
      async detachSession(sessionId) {
        this.sessionIds = this.sessionIds.filter(id => id !== sessionId)
      },
    }
    workspaces.push(row)
    return row
  }
  services.set('workspaceRegistry', workspaceRegistry)
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
    attached,
    unarchived,
    created,
    workspaces,
    addWorkspace,
    live,
    routes,
    // `apply` reads the web server off the context property, not through `get`.
    webServer: services.get('webServer'),
    // `apply` registers routes inside ctx.effect callbacks; without this the
    // route layer cannot be mounted at all.
    effect(fn) {
      const dispose = fn()
      return () => { if (typeof dispose === 'function') dispose() }
    },
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
  // Since 1.3.0 a file outside the working directory is listed, but marked as
  // outside so the dialog can keep it collapsed and unticked. It used to be
  // refused outright, which made a file the conversation genuinely read in
  // another directory impossible to delete from this dialog at all.
  check('a file outside the working directory is allowed', allowedPaths.includes(realpathSync(files.outside)))
  equal('it is marked as outside the working directory',
    allowed.find(row => row.path === realpathSync(files.outside))?.scope, 'outside')
  equal('a file inside is marked as inside',
    allowed.find(row => row.path === realpathSync(files.produced))?.scope, 'inside')
  equal('nothing is refused on the working-directory rule alone', refused.length, 0)
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
  // Referenced files are one flat list now, because none of them is deletable:
  // the working directory a read file sat under no longer changes anything the
  // reader can do, so splitting the list would only imply a decision exists.
  equal('the referenced group is explicitly marked non-deletable', plan.referenced.deletable, false)
  check('a read file outside the working directory is listed in the same group',
    read.includes(realpathSync(files.outside)))
  equal('there is no separate outside list for read files', plan.referenced.outside, undefined)
  check('the byte total covers both', plan.referenced.totalBytes >= statSync(files.outside).size)
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
  childIds: [SESSIONS.childA, SESSIONS.childB],
})

await group('purge result', () => {
  equal('the purge succeeds', first.ok, true)
  check('it went into the recycle bin', typeof first.trash?.groupKey === 'string' && first.trash.groupKey.length > 0)
  equal('the recorded directories are reported', first.removed.directories.length, 3)
  equal('both children are reported', first.removed.children.length, 2)
  equal('one produced file is reported', first.removed.artifacts.length, 1)
  // There is no counter for them at all now: a referenced file cannot enter the
  // deletion, so a field recording how many did would be a field that is always
  // zero and never means anything.
  equal('no referenced counter exists on the result', first.removed.referenced, undefined)
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
  // Referenced files are listed for context and never deleted. The rule exists
  // because the log cannot tell a file the conversation generated and re-read
  // from one that was already on disk: both produce the same `read` call, so a
  // delete control on the second kind would occasionally destroy the user's
  // work. What still has to hold is that asking for one is refused by name —
  // a page from 1.3.0 sends these ids, and answering "done" while leaving the
  // file alone is precisely the silent lie this plugin exists to remove.
  mkdirSync(join(HOME, 'sessions', PROJECT, 'session-ref-0006'), { recursive: true })
  writeFileSync(join(HOME, 'sessions', PROJECT, 'session-ref-0006', 'session.v4.jsonl.zstd'), 'ref\n', 'utf8')
  headers['session-ref-0006'] = { version: 4, id: 'session-ref-0006', createdAt: 1700, cwd: WORKSPACE }
  events['session-ref-0006'] = [readCall(files.readOnly)]
  refreshStored()

  const planRef = await internals.buildPlan(ctx, 'session-ref-0006')
  equal('the read file is reported as referenced', planRef.referenced.items.length, 1)
  equal('nothing is reported as produced', planRef.artifacts.items.length, 0)
  equal('the group says it is not deletable', planRef.referenced.deletable, false)
  const readId = planRef.referenced.items[0].id

  // Not asking: the file must not be touched, and the conversation still goes.
  const untouched = await internals.purge(ctx, {
    sessionId: 'session-ref-0006',
    include: { record: true, cache: true, children: true, attachments: false },
    artifactIds: [],
  })
  equal('a purge that does not name them succeeds', untouched.ok, true)
  check('the read file is untouched', existsSync(files.readOnly))
  equal('the result has no referenced counter', untouched.removed.referenced, undefined)

  // Asking: refused, and nothing moves.
  mkdirSync(join(HOME, 'sessions', PROJECT, 'session-ref-0007'), { recursive: true })
  writeFileSync(join(HOME, 'sessions', PROJECT, 'session-ref-0007', 'session.v4.jsonl.zstd'), 'ref\n', 'utf8')
  headers['session-ref-0007'] = { version: 4, id: 'session-ref-0007', createdAt: 1800, cwd: WORKSPACE }
  events['session-ref-0007'] = [readCall(files.readOnly)]
  refreshStored()
  const planRef2 = await internals.buildPlan(ctx, 'session-ref-0007')
  equal('the id is stable across plans', planRef2.referenced.items[0].id, readId)

  const asked = await internals.purge(ctx, {
    sessionId: 'session-ref-0007',
    include: { record: true, cache: true, children: true, attachments: false },
    artifactIds: [],
    referencedIds: [readId],
  })
  equal('asking to delete a referenced file is refused', asked.ok, false)
  equal('the refusal names the reason', asked.code, 'referenced-not-deletable')
  equal('it counts what was asked for', asked.referencedRequested, 1)
  equal('and what the fresh plan still recognises', asked.referencedRecognised, 1)
  check('the refusal explains itself in words', typeof asked.error === 'string' && asked.error.length > 0)
  check('the read file is still there', existsSync(files.readOnly))
  equal('the read file is byte-identical', fingerprint(files.readOnly).bytes, before.readOnly.bytes)
  check('the conversation was not touched either', existsSync(join(HOME, 'sessions', PROJECT, 'session-ref-0007')))
})

await group('stale id', async () => {
  // An id the Host did not produce resolves to nothing: the selection is a
  // filter over a freshly rebuilt plan, not a list of paths to trust. That used
  // to be reported as success with nothing moved, which reads exactly like a
  // completed deletion in the dialog; naming something that matched nothing is
  // now a refusal with a reason.
  const other = await internals.purge(ctx, {
    sessionId: 'session-ref-0007',
    include: { record: false, cache: false, children: false, attachments: false },
    artifactIds: ['adeadbeefcafe'],
  })
  equal('a purge with only stale ids is refused', other.ok, false)
  equal('the refusal says nothing matched', other.code, 'nothing-matched')
  equal('and removes nothing', other.removed.artifacts.length, 0)
  // A request that genuinely ticked nothing is still a harmless no-op, because
  // the dialog can leave that state on screen without the user doing anything.
  const untouched = await internals.purge(ctx, {
    sessionId: 'session-ref-0007',
    include: { record: false, cache: false, children: false, attachments: false },
    artifactIds: [],
  })
  equal('ticking nothing is still a no-op', untouched.ok, true)
  equal('and it is marked empty', untouched.empty, true)
  // A stale *referenced* id is refused by the rule that owns it rather than as a
  // generic miss: the caller asked to delete a referenced file, and that is the
  // fact worth reporting back.
  const staleReference = await internals.purge(ctx, {
    sessionId: 'session-ref-0007',
    include: { record: false, cache: false, children: false, attachments: false },
    artifactIds: [],
    referencedIds: ['ffffffffffff'],
  })
  equal('a stale referenced id is refused by the referenced rule', staleReference.code, 'referenced-not-deletable')
  equal('and it recognises none of them', staleReference.referencedRecognised, 0)
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

await group('a refused path says why', async () => {
  // The three refusals that matter, each provoked for real. A count without a
  // reason is what made "the file is not on the list" indistinguishable from a
  // bug; every one of these rows carries a sentence a reader can act on.
  const missing = join(WORKSPACE, 'gone.txt')
  const dshOwned = join(HOME, 'attachments', 'v1', 'objects', 'zz', 'owned.txt')
  mkdirSync(dirname(dshOwned), { recursive: true })
  writeFileSync(dshOwned, 'plugin data', 'utf8')
  const paths = new Map([
    [missing, { ops: 1, tools: new Set(['write']), sources: new Map() }],
    [dshOwned, { ops: 1, tools: new Set(['write']), sources: new Map() }],
  ])
  const { allowed, refused } = await internals.classifyItems(paths, [WORKSPACE_REAL], HOME, 'artifact')
  equal('neither refused path is allowed', allowed.length, 0)
  equal('a missing file says it is missing', refused.find(row => row.path === missing)?.reason, '文件已不存在')
  equal('a DSH-owned file says where it lives', refused.find(row => row.path === dshOwned)?.reason, '位于 DSH 数据目录内，已跳过')
})

await group('an operating-system directory is never deletable', async () => {
  // A conversation can name any path, and since 1.3.0 naming one outside the
  // working directory is enough to make it deletable. The OS tree is the one
  // boundary that has to be explicit: an `edit` call against the Windows
  // directory in a log is a mistaken path, not an instruction.
  const roots = internals.blockedRoots()
  check('some system roots are known on this platform', roots.length > 0)
  check('the Windows directory is among them',
    process.platform !== 'win32' || roots.some(root => /windows/i.test(root)))
  const windowsFile = process.platform === 'win32'
    ? join(process.env.SystemRoot ?? 'C:\\Windows', 'system.ini')
    : '/etc/hostname'
  check('a path inside it is blocked', internals.blockingRootOf(windowsFile) !== null)
  check('a path under the temporary directory is not blocked',
    internals.blockingRootOf(join(ROOT, 'workspace', 'out.txt')) === null)
  // Case and separator folding, because a log can name the same directory either way.
  check('the block is case-insensitive', internals.insideFolded('C:\\Windows', 'c:/windows/system32/x.dll'))
  check('the block does not match a sibling', !internals.insideFolded('C:\\Windows', 'C:\\Windows.old\\x.dll'))
})

await group('an attachment copy is recognised by its bytes', async () => {
  const payload = 'the-same-bytes-everywhere'
  const file = join(WORKSPACE, 'mirror-source.png')
  writeFileSync(file, payload, 'utf8')
  const digest = createHash('sha256').update(payload).digest('hex')
  const object = join(HOME, 'attachments', 'v1', 'objects', digest.slice(0, 2), digest)
  mkdirSync(dirname(object), { recursive: true })
  writeFileSync(object, payload, 'utf8')

  equal('the digest matches the file', await internals.hashFile(file), digest)
  const rows = [{ path: file, bytes: statSync(file).size }]
  const attachments = [{ id: `sha256:${digest}`, bytes: statSync(file).size }]
  const mirrors = await internals.findAttachmentMirrors(rows, attachments, HOME)
  equal('the copy is found', mirrors.length, 1)
  equal('it points at the file that holds the same bytes', mirrors[0].path, file)
  equal('and at the attachment id', mirrors[0].attachmentId, `sha256:${digest}`)

  // A different size cannot be the same bytes, and a different digest cannot either.
  const wrongSize = await internals.findAttachmentMirrors([{ path: file, bytes: 1 }], attachments, HOME)
  equal('a differing byte count is not a match', wrongSize.length, 0)
  const otherPayload = 'different-bytes-entirely'
  const otherFile = join(WORKSPACE, 'other.png')
  writeFileSync(otherFile, otherPayload, 'utf8')
  const sameSize = Buffer.byteLength(otherPayload) === Buffer.byteLength(payload)
  const wrongBytes = await internals.findAttachmentMirrors(
    [{ path: otherFile, bytes: Buffer.byteLength(otherPayload) }],
    sameSize ? attachments : [{ ...attachments[0], bytes: Buffer.byteLength(otherPayload) }],
    HOME,
  )
  equal('an equal byte count alone is not a match', wrongBytes.length, 0)
})

await group('a failed publish puts everything back', async () => {
  // The dangerous case: every item moved into `<key>.partial`, then the final
  // rename fails — on Windows that is what happens while the Harness holds the
  // Session log open. Letting the error escape would strand the files: gone from
  // their directories, invisible to the bin, never swept.
  mkdirSync(join(HOME, 'sessions', PROJECT, 'session-publish-0008'), { recursive: true })
  writeFileSync(join(HOME, 'sessions', PROJECT, 'session-publish-0008', 'session.v4.jsonl.zstd'), 'publish\n', 'utf8')
  headers['session-publish-0008'] = { version: 4, id: 'session-publish-0008', createdAt: 1900, cwd: WORKSPACE }
  const original = join(WORKSPACE, 'publish-target.txt')
  mkdirSync(dirname(original), { recursive: true })
  writeFileSync(original, 'publish me', 'utf8')
  events['session-publish-0008'] = [writeCall('write', original)]
  refreshStored()

  const planPublish = await internals.buildPlan(ctx, 'session-publish-0008')
  equal('the file is in the plan', planPublish.artifacts.items.length, 1)
  const failed = await internals.purge(ctx, {
    sessionId: 'session-publish-0008',
    include: { record: true, cache: true, children: false, attachments: false },
    artifactIds: planPublish.artifacts.items.map(row => row.id),
    referencedIds: [],
    // The seam that makes the publish throw, exactly as a busy handle does.
    publish: async () => { throw new Error('EPERM: simulated busy handle') },
  })
  equal('a failed publish is not reported as success', failed.ok, false)
  equal('the refusal names the stage', failed.code, 'publish-failed')
  check('it reports how much was rolled back', failed.rolledBack >= 1)
  check('the file is back in its directory', existsSync(original))
  equal('and its bytes are intact', readFileSync(original, 'utf8'), 'publish me')
  check('the Session log is back too', existsSync(join(HOME, 'sessions', PROJECT, 'session-publish-0008')))
  // Nothing may be left in a hidden partial when every item made it back.
  const leftovers = await internals.listManifests(HOME)
  equal('nothing is left in an unfinished group', leftovers.filter(row => row.recovery === true).length, 0)
})

await group('sweep leaves an unfinished deletion alone', async () => {
  // Retention must never delete the only record of where those files came from.
  const key = internals.newGroupKey('session-sweep-test')
  const partial = join(internals.trashGroups(HOME), `${key}.partial`)
  mkdirSync(join(partial, 'artifacts', '0'), { recursive: true })
  writeFileSync(join(partial, 'artifacts', '0', 'x.txt'), 'x', 'utf8')
  writeFileSync(join(partial, 'manifest.json'), JSON.stringify({
    formatVersion: 1,
    groupKey: key,
    sessionId: 'session-sweep-test',
    deletedAt: 1,
    bytes: 1,
    items: [{ path: 'artifacts/0/x.txt', kind: 'artifact', role: 'file', originalPath: join(WORKSPACE, 'x.txt'), bytes: 1, sessionId: 'session-sweep-test' }],
  }), 'utf8')
  const swept = await internals.sweepTrash(HOME, true)
  check('the sweep does not drop it', !swept.removed.some(row => row.groupKey === `${key}.partial`))
  check('it is still on disk', existsSync(partial))
  rmSync(partial, { recursive: true, force: true })
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
// The HTTP surface.
//
// Everything above drives buildPlan directly, which is a blind spot: a field
// buildPlan computes but the `/scan` route forgets to forward is invisible here
// and invisible in the dialog at the same time. The `changed` group shipped in
// exactly that state — computed, tested, and never sent.

await group('the routes are registered', async () => {
  const { apply } = await import('../lib/index.js')
  apply(ctx)
  check('the scan route is mounted', ctx.routes.has('/plugins/dsh-plugin-remover/api/scan'))
  check('the health route is mounted', ctx.routes.has('/plugins/dsh-plugin-remover/api/health'))
  check('the purge route is mounted', ctx.routes.has('/plugins/dsh-plugin-remover/api/purge'))
})

/**
 * Drive one registered route and return the parsed JSON body.
 *
 * The route wrapper is deliberately fire-and-forget (`void (async () => ...)()`),
 * so awaiting the handler returns before the response is written. Wait on the
 * response itself instead — the same way the web server does.
 */
async function callRoute(path, body) {
  const route = ctx.routes.get(path)
  if (route === undefined) throw new Error(`no route ${path}`)
  const req = {
    method: 'POST',
    headers: { 'x-dsh-plugin-remover': '1' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body ?? {}), 'utf8')
    },
  }
  const done = Promise.withResolvers()
  const res = {
    headersSent: false,
    status: null,
    setHeader() {},
    writeHead(status) {
      this.status = status
      this.headersSent = true
    },
    end(text) {
      done.resolve(text === undefined ? null : JSON.parse(String(text)))
    },
  }
  route.handler(req, res)
  const payload = await done.promise
  return { status: res.status, payload }
}

await group('the scan route forwards every group it computes', async () => {
  const { payload } = await callRoute('/plugins/dsh-plugin-remover/api/scan', { sessionId: SESSIONS.parent })
  check('the route answers', payload !== null && payload.ok === true)
  for (const key of ['artifacts', 'referenced', 'changed', 'attachments', 'store', 'children', 'projectionCache', 'trash']) {
    check(`the response carries ${key}`, payload[key] !== undefined)
  }
  // The specific regression: the group must carry its shape, not just exist.
  check('the changed group carries an item list', Array.isArray(payload.changed.items))
  check('the changed group carries a byte total', typeof payload.changed.totalBytes === 'number')
  check('the changed group carries a truncation flag', typeof payload.changed.truncated === 'boolean')
  check('the changed group declares a window slot', 'window' in payload.changed)
  // And it must agree with what buildPlan computed, not be an empty stub.
  const direct = await internals.buildPlan(ctx, SESSIONS.parent)
  equal('the route forwards the same item count buildPlan computed',
    payload.changed.items.length, direct.changed.items.length)
})

// ---------------------------------------------------------------------------
// Keeping the conversation while deleting its files
// ---------------------------------------------------------------------------

/**
 * Seed one extra Session with a working directory of its own.
 *
 * The groups above destroyed most of the original fixture, and these checks need
 * a conversation that is still there to keep. Seeding a fresh one also proves
 * the keep-the-conversation path starts from a healthy plan rather than from a
 * half-deleted leftover.
 *
 * @param id - Session id.
 * @param cwd - working directory its header records.
 * @param produced - absolute path one `write` call names.
 * @returns the Session id.
 */
function seedExtra(id, cwd, produced) {
  headers[id] = { version: 4, id, createdAt: 2000, cwd, isSeeded: false }
  events[id] = [writeCall('write', produced)]
  mkdirSync(join(HOME, 'sessions', PROJECT, id), { recursive: true })
  const line = {
    type: 'session', version: 4, id, createdAt: 2000, isSeeded: false, delegationDepth: 0, cwd,
  }
  writeFileSync(join(HOME, 'sessions', PROJECT, id, 'session.v4.jsonl.zstd'), Buffer.concat([
    zstdCompressSync(Buffer.from(`${JSON.stringify(line)}\n`, 'utf8')),
    zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } })}\n`, 'utf8')),
  ]))
  const cacheFile = join(HOME, 'storages', 'session_projcache', 'sessions', `${id}.json`)
  mkdirSync(dirname(cacheFile), { recursive: true })
  writeFileSync(cacheFile, `${JSON.stringify({ record: { rows: { title: { val: `title-${id}` } } } })}\n`, 'utf8')
  refreshStored()
  return id
}

const KEEP_DIR = join(ROOT, 'keep-workspace')
mkdirSync(KEEP_DIR, { recursive: true })
const keepFile = join(KEEP_DIR, 'kept-output.txt')
writeFileSync(keepFile, 'produced while the conversation is kept\n', 'utf8')
const KEEP = seedExtra('session-keep-6666', KEEP_DIR, keepFile)
const keepWorkspace = ctx.addWorkspace(realpathSync(KEEP_DIR), 'keep')

await group('a conversation can be kept while its files are deleted', async () => {
  const scan = await internals.buildPlan(ctx, KEEP)
  equal('the plan finds the produced file', scan.artifacts.items.length, 1)
  equal('the plan records the owning workspace', scan.workspace?.id, keepWorkspace.id)

  const emittedBefore = ctx.emitted.length
  const kept = await internals.purge(ctx, {
    sessionId: KEEP,
    include: { record: false, cache: false, children: false, attachments: true },
    artifactIds: scan.artifacts.items.map(row => row.id),
  })

  equal('the purge succeeds', kept.ok, true)
  check('it went into the recycle bin', typeof kept.trash?.groupKey === 'string')
  equal('the produced file left its directory', existsSync(keepFile), false)
  check('the conversation log is still there', existsSync(join(HOME, 'sessions', PROJECT, KEEP)))
  check('the projection cache is still there',
    existsSync(join(HOME, 'storages', 'session_projcache', 'sessions', `${KEEP}.json`)))
  equal('no directory is reported as removed', kept.removed.directories.length, 0)
  // A kept conversation must not be archived, detached, or dropped from the page:
  // all three would hide a conversation that still exists.
  equal('a kept conversation is not archived', ctx.archived.filter(row => row.sessionId === KEEP).length, 0)
  equal('a kept conversation is not detached', kept.removed.detached.length, 0)
  equal('no removal event is emitted for a kept conversation',
    ctx.emitted.slice(emittedBefore).filter(row => row.name === 'api-session/removed').length, 0)

  const manifest = JSON.parse(readFileSync(
    join(internals.trashGroups(HOME), kept.trash.groupKey, 'manifest.json'), 'utf8'))
  equal('the manifest says the conversation was kept', manifest.recordIncluded, false)
  check('the manifest records no conversation file', manifest.items.every(item => item.role !== 'record'))
  check('the manifest records the file as a file', manifest.items.some(item => item.role === 'file'))
  // The restore has to know this group holds no conversation to hand back.
  const group = internals.groupRow(manifest, { retentionDays: 30, maxBytes: 0 }, true)
  equal('the group row says the conversation was kept', group.recordIncluded, false)
  equal('the group row counts its files', group.fileCount, 1)
  equal('the group row counts no conversation items', group.roles.record, 0)
  check('each item row carries its role', group.items.every(item => item.role === 'file'))
  equal('the group row keeps the workspace it was deleted from',
    group.workspace?.id, keepWorkspace.id)
})

await group('attachments are forced off when the conversation is kept', () => {
  const kept = internals.selectionOf({ include: { record: false, attachments: true } })
  equal('attachments cannot be deleted with a kept conversation', kept.attachments, false)
  equal('the forcing is reported so the dialog can explain it', kept.attachmentsForcedOff, true)
  const both = internals.selectionOf({ include: { record: true, attachments: false } })
  equal('an explicit opt-out is still an opt-out', both.attachments, false)
  equal('an explicit opt-out is not reported as forced', both.attachmentsForcedOff, false)
  const plain = internals.selectionOf({})
  equal('the default still takes the record', plain.record, true)
  equal('the default still takes attachments', plain.attachments, true)
})

// ---------------------------------------------------------------------------
// Restoring a conversation to its workspace
// ---------------------------------------------------------------------------

await group('a restore re-attaches the conversation to its workspace', async () => {
  const scan = await internals.buildPlan(ctx, KEEP)
  // Nothing is left to delete for this conversation, so delete the record to
  // give the restore something to put back.
  const purge = await internals.purge(ctx, {
    sessionId: KEEP,
    include: { record: true, cache: true, children: false, attachments: false },
  })
  equal('the purge succeeds', purge.ok, true)
  const groupKey = purge.trash.groupKey
  check('the conversation log left', !existsSync(join(HOME, 'sessions', PROJECT, KEEP)))
  const manifest = JSON.parse(readFileSync(join(internals.trashGroups(HOME), groupKey, 'manifest.json'), 'utf8'))
  equal('the manifest says the conversation went', manifest.recordIncluded, true)
  check('the manifest records the workspace', manifest.workspace?.id === keepWorkspace.id)

  const before = { attached: ctx.attached.length, unarchived: ctx.unarchived.length, created: ctx.created.length }
  const restored = await internals.restoreGroups(ctx, HOME, { groupKey })
  equal('nothing failed', restored.failed.length, 0)
  equal('one group is reported', restored.groups.length, 1)
  equal('the group is dropped once empty', restored.groups[0].groupRemoved, true)
  equal('the group is marked restored whole', restored.groups[0].sessionId, KEEP)
  check('the conversation log is back', existsSync(join(HOME, 'sessions', PROJECT, KEEP)))
  // Re-attaching only works after the log is on disk, so this also proves the order.
  equal('it is attached to the workspace again', ctx.attached.length, before.attached + 1)
  equal('it is attached to the workspace it was deleted from', ctx.attached.at(-1)?.workspaceId, keepWorkspace.id)
  equal('it is taken out of the archive set', ctx.unarchived.length, before.unarchived + 1)
  equal('no workspace had to be recreated', ctx.created.length, before.created)
  const session = restored.groups[0].sessions[0]
  equal('the restore reports where it went', session.workspace.status, 're-attached')
  equal('the restore names the workspace', session.workspace.workspaceId, keepWorkspace.id)
})

await group('a restore recreates a workspace whose record is gone', async () => {
  // Same directory, but the registration was deleted: the conversation must land
  // in a workspace for that directory rather than in Ungrouped.
  const gone = ctx.workspaces.findIndex(row => row.id === keepWorkspace.id)
  ctx.workspaces.splice(gone, 1)
  const purge = await internals.purge(ctx, {
    sessionId: KEEP,
    include: { record: true, cache: true, children: false, attachments: false },
  })
  equal('the second purge succeeds', purge.ok, true)
  const before = ctx.created.length
  const restored = await internals.restoreGroups(ctx, HOME, { groupKey: purge.trash.groupKey })
  equal('nothing failed', restored.failed.length, 0)
  equal('a workspace is recreated for the directory', ctx.created.length, before + 1)
  equal('the restored group reports the recreation',
    restored.groups[0].sessions[0].workspace.status, 'created')
  check('the conversation log is back', existsSync(join(HOME, 'sessions', PROJECT, KEEP)))
})

await group('a restore with a missing directory leaves the conversation ungrouped', async () => {
  const PURGE_DIR = join(ROOT, 'vanishing-workspace')
  mkdirSync(PURGE_DIR, { recursive: true })
  const file = join(PURGE_DIR, 'gone.txt')
  writeFileSync(file, 'will be deleted with its directory\n', 'utf8')
  const id = seedExtra('session-vanishing-7777', PURGE_DIR, file)
  const workspace = ctx.addWorkspace(realpathSync(PURGE_DIR), 'vanishing')
  // Only the conversation itself: the group must hold nothing that would
  // recreate the working directory, or the "directory is gone" branch cannot run.
  const purge = await internals.purge(ctx, {
    sessionId: id,
    include: { record: true, cache: true, children: false, attachments: false },
  })
  equal('the purge succeeds', purge.ok, true)
  rmSync(PURGE_DIR, { recursive: true, force: true })
  const index = ctx.workspaces.indexOf(workspace)
  if (index !== -1) ctx.workspaces.splice(index, 1)

  const createdBefore = ctx.created.length
  const restored = await internals.restoreGroups(ctx, HOME, { groupKey: purge.trash.groupKey })
  equal('nothing failed', restored.failed.length, 0)
  check('the conversation log is back', existsSync(join(HOME, 'sessions', PROJECT, id)))
  const slot = restored.groups[0].sessions[0].workspace
  // Rewriting the stored cwd to force it into some other workspace would change
  // the conversation permanently, so the honest answer is Ungrouped plus a reason.
  equal('the conversation is left ungrouped', slot.status, 'ungrouped')
  check('the reason names the missing directory', String(slot.reason).includes(PURGE_DIR))
  equal('no workspace was invented for a missing directory', ctx.created.length, createdBefore)
})

await group('a restore handles several groups at once', async () => {
  const A_DIR = join(ROOT, 'batch-a')
  const B_DIR = join(ROOT, 'batch-b')
  mkdirSync(A_DIR, { recursive: true })
  mkdirSync(B_DIR, { recursive: true })
  const fileA = join(A_DIR, 'a.txt')
  const fileB = join(B_DIR, 'b.txt')
  writeFileSync(fileA, 'a\n', 'utf8')
  writeFileSync(fileB, 'b\n', 'utf8')
  const idA = seedExtra('session-batch-a-8888', A_DIR, fileA)
  const idB = seedExtra('session-batch-b-9999', B_DIR, fileB)
  const purgeA = await internals.purge(ctx, { sessionId: idA, include: { record: true, cache: true, children: false, attachments: false }, artifactIds: (await internals.buildPlan(ctx, idA)).artifacts.items.map(row => row.id) })
  const purgeB = await internals.purge(ctx, { sessionId: idB, include: { record: true, cache: true, children: false, attachments: false }, artifactIds: (await internals.buildPlan(ctx, idB)).artifacts.items.map(row => row.id) })
  equal('both purges succeeded', `${String(purgeA.ok)}:${String(purgeB.ok)}`, 'true:true')
  check('both groups are distinct', purgeA.trash.groupKey !== purgeB.trash.groupKey)

  const restored = await internals.restoreGroups(ctx, HOME, {
    groupKeys: [purgeA.trash.groupKey, purgeB.trash.groupKey],
  })
  equal('nothing failed', restored.failed.length, 0)
  equal('both groups are reported', restored.groups.length, 2)
  check('both groups are dropped once empty', restored.groups.every(row => row.groupRemoved === true))
  check('both conversations are back',
    existsSync(join(HOME, 'sessions', PROJECT, idA)) && existsSync(join(HOME, 'sessions', PROJECT, idB)))
  check('both files are back', existsSync(fileA) && existsSync(fileB))

  // A mixed request: one whole group through `groups`, and one item of another
  // group through the legacy single-group shape. Both must land in one pass.
  const againA = await internals.purge(ctx, { sessionId: idA, include: { record: true, cache: true, children: false, attachments: false }, artifactIds: (await internals.buildPlan(ctx, idA)).artifacts.items.map(row => row.id) })
  const againB = await internals.purge(ctx, { sessionId: idB, include: { record: true, cache: true, children: false, attachments: false }, artifactIds: (await internals.buildPlan(ctx, idB)).artifacts.items.map(row => row.id) })
  const manifestB = JSON.parse(readFileSync(join(internals.trashGroups(HOME), againB.trash.groupKey, 'manifest.json'), 'utf8'))
  const fileItem = manifestB.items.find(item => item.role === 'file')
  check('the second group holds a produced file', fileItem !== undefined)

  const wholeOnly = await internals.restoreGroups(ctx, HOME, {
    groups: [{ groupKey: againA.trash.groupKey }],
  })
  equal('the groups-shaped request restores its group', wholeOnly.groups.length, 1)
  equal('and that group is dropped once empty', wholeOnly.groups[0].groupRemoved, true)

  const single = await internals.restoreGroups(ctx, HOME, {
    groupKey: againB.trash.groupKey,
    itemPaths: [fileItem.path],
  })
  equal('one item is restored', single.restored.length, 1)
  equal('the group survives while its conversation stays in the bin',
    single.groups[0].groupRemoved, false)
  check('the conversation of the partial group stays deleted',
    !existsSync(join(HOME, 'sessions', PROJECT, idB)))
})

await group('a restore refuses a request that names nothing', async () => {
  let threw = null
  try {
    await internals.restoreGroups(ctx, HOME, {})
  } catch (error) {
    threw = error
  }
  check('an empty restore request is rejected', threw !== null)
  let rejected = null
  try {
    await internals.restoreGroups(ctx, HOME, { groupKeys: ['../escape'] })
  } catch (error) {
    rejected = error
  }
  check('a traversal-shaped group key is rejected', rejected !== null)
})

await group('the group row derives roles from an older manifest', () => {
  // A group written by 1.1.0 has neither `roles` nor `recordIncluded`. The panel
  // still has to label it, so both are derived from the item kinds.
  const legacy = {
    groupKey: 'legacy-group',
    sessionId: 'session-legacy',
    cwd: WORKSPACE,
    deletedAt: Date.now(),
    bytes: 10,
    items: [
      { path: 'store/p/s', kind: 'store', originalPath: join(WORKSPACE, 'store'), bytes: 5 },
      { path: 'artifacts/0/f.ts', kind: 'artifact', originalPath: files.produced2, bytes: 5 },
    ],
  }
  const row = internals.groupRow(legacy, { retentionDays: 30, maxBytes: 0 }, true)
  equal('an old group is still recognised as holding its conversation', row.recordIncluded, true)
  equal('its conversation items are counted', row.roles.record, 1)
  equal('its produced files are counted', row.roles.file, 1)
  equal('its produced bytes are counted', row.fileBytes, 5)
  equal('its items carry a derived role', row.items.map(item => item.role).join(','), 'record,file')
  equal('an old group with no workspace snapshot reports none', row.workspace, null)
})

await group('the scan route reports the workspace slot', async () => {
  const slot = ctx.addWorkspace(realpathSync(WORKSPACE), 'scan-workspace')
  headers[SESSIONS.other] = { version: 4, id: SESSIONS.other, createdAt: 1500, cwd: WORKSPACE, isSeeded: false }
  mkdirSync(join(HOME, 'sessions', PROJECT, SESSIONS.other), { recursive: true })
  refreshStored()
  const { payload } = await callRoute('/plugins/dsh-plugin-remover/api/scan', { sessionId: SESSIONS.other })
  check('the response carries the workspace slot', 'workspace' in payload)
  equal('the slot names the owning workspace', payload.workspace?.id, slot.id)
  const direct = await internals.buildPlan(ctx, SESSIONS.other)
  equal('the route forwards the same slot buildPlan computed', payload.workspace?.id, direct.workspace?.id)
})

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

rmSync(ROOT, { recursive: true, force: true })

console.log(`\n${String(checks - failures)}/${String(checks)} checks passed`)
if (failures > 0) process.exitCode = 1
