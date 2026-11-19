/**
 * End-to-end proof of the 1.2.0 behaviours against a scratch DSH home.
 *
 * The offline suites drive internals and the route table; this drives the real
 * HTTP routes in-process, then inspects the filesystem, so the wiring between
 * route -> helper -> manifest -> disk is exercised as one path. It covers the
 * four things the release is about:
 *
 *   1. A files-only deletion keeps the conversation and drops the attachments.
 *   2. A restore puts the conversation back into its workspace.
 *   3. A restore recreates a deleted workspace.
 *   4. A batch restore handles several groups in one request.
 *
 *   node verify/verify-routes-120.mjs
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdir, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-remover-routes-'))
const HOME = join(ROOT, 'home')
const WORKSPACE = join(ROOT, 'workspace')
const ATTACH_DIR = join(HOME, 'attachments', 'v1', 'objects', 'aa')
const ATTACH_HEX = 'a'.repeat(64)
const ATTACH_PATH = join(ATTACH_DIR, ATTACH_HEX)

mkdirSync(WORKSPACE, { recursive: true })
mkdirSync(ATTACH_DIR, { recursive: true })
writeFileSync(ATTACH_PATH, 'attachment-bytes', 'utf8')

const files = {
  produced: join(WORKSPACE, 'out.txt'),
  read: join(WORKSPACE, 'input.txt'),
  // A file the log names outside the working directory. Since 1.3.0 this is
  // deletable, but only when the request ticks it explicitly.
  outside: join(ROOT, 'elsewhere', 'note.md'),
}
mkdirSync(dirname(files.outside), { recursive: true })
writeFileSync(files.produced, 'produced\n', 'utf8')
writeFileSync(files.read, 'input\n', 'utf8')
writeFileSync(files.outside, 'outside-note\n', 'utf8')

// The attachment object holding the same bytes as the outside file, so the
// mirror check has something real to find.
const OUTSIDE_HEX = createHash('sha256').update(readFileSync(files.outside)).digest('hex')
const OUTSIDE_OBJECT = join(HOME, 'attachments', 'v1', 'objects', OUTSIDE_HEX.slice(0, 2), OUTSIDE_HEX)
mkdirSync(dirname(OUTSIDE_OBJECT), { recursive: true })
writeFileSync(OUTSIDE_OBJECT, readFileSync(files.outside))

const PROJECT = '--scratch--'
const SESSIONS = {
  keep: 'session-keep-0001',
  gone: 'session-gone-0002',
  batchA: 'session-batch-a-0003',
  batchB: 'session-batch-b-0004',
  outside: 'session-outside-0005',
  mirror: 'session-mirror-0006',
}

/** One write or read call event. */
const call = (name, path) => ({ type: 'tool/call', time: 1, data: { name, arguments: JSON.stringify({ file_path: path }) } })

const events = {
  [SESSIONS.keep]: [
    call('write', files.produced),
    call('read', files.read),
    { type: 'user/message', data: { content: [{ type: 'image', attachment: { attachmentId: `sha256:${ATTACH_HEX}`, name: 'pic.png' } }] } },
  ],
  [SESSIONS.gone]: [call('write', files.produced)],
  [SESSIONS.batchA]: [call('write', files.produced)],
  [SESSIONS.batchB]: [call('read', files.read)],
  [SESSIONS.outside]: [call('read', files.outside)],
  // The attachment object is a byte-for-byte copy of the file this one reads:
  // the store has no digest of its own, so the mirror is found by hashing.
  [SESSIONS.mirror]: [
    call('read', files.outside),
    { type: 'user/message', data: { content: [{ type: 'file', attachment: { attachmentId: `sha256:${OUTSIDE_HEX}`, name: 'note.md', bytes: statSync(files.outside).size } }] } },
  ],
}

const headers = {}
for (const id of Object.keys(events)) {
  headers[id] = { version: 4, id, createdAt: 1000, cwd: WORKSPACE, isSeeded: false }
}

/** Write one stored log the backend's own reader accepts. */
function seedLog(id) {
  const directory = join(HOME, 'sessions', PROJECT, id)
  mkdirSync(directory, { recursive: true })
  const header = headers[id]
  const line = {
    type: 'session',
    version: 4,
    id,
    createdAt: header.createdAt,
    isSeeded: false,
    delegationDepth: 0,
    cwd: header.cwd,
  }
  writeFileSync(join(directory, 'session.v4.jsonl.zstd'), Buffer.concat([
    zstdCompressSync(Buffer.from(`${JSON.stringify(line)}\n`, 'utf8')),
    zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } })}\n`, 'utf8')),
  ]))
  const cache = join(HOME, 'storages', 'session_projcache', 'sessions', `${id}.json`)
  mkdirSync(dirname(cache), { recursive: true })
  writeFileSync(cache, `${JSON.stringify({ record: { rows: { title: { val: `title-${id}` } } } })}\n`, 'utf8')
}

for (const id of Object.keys(events)) seedLog(id)

process.env.DSH_HOME = HOME

// The workspace registry the routes will talk to.
const workspaces = []
const calls = { attached: [], unarchived: [], created: [], archived: [], interrupted: [], emitted: [] }
const makeWorkspace = (path, title) => {
  const row = {
    id: `workspace-${String(workspaces.length + 1)}`,
    path,
    title,
    sessionIds: [],
    async attachSession(sessionId) {
      this.sessionIds.push(sessionId)
      calls.attached.push({ workspaceId: this.id, sessionId })
    },
    async detachSession(sessionId) {
      this.sessionIds = this.sessionIds.filter(id => id !== sessionId)
    },
  }
  workspaces.push(row)
  return row
}
const workspace = makeWorkspace(realpathSync(WORKSPACE), 'scratch')

const routes = new Map()
const services = new Map()
services.set('sessionPersistence', {
  async list() {
    const stored = Object.keys(headers).filter(id => existsSync(join(HOME, 'sessions', PROJECT, id)))
    return stored.map(id => ({ header: headers[id], eventCount: (events[id] ?? []).length, sizeBytes: 100 }))
  },
  async stat(id) {
    if (!existsSync(join(HOME, 'sessions', PROJECT, id))) throw new Error('unknown session')
    return { header: headers[id], eventCount: (events[id] ?? []).length, sizeBytes: 100 }
  },
  async open(id) {
    return {
      async read() { return { events: JSON.parse(JSON.stringify(events[id] ?? [])) } },
      async close() {},
    }
  },
})
services.set('webServer', {
  register(spec) {
    routes.set(spec.path, spec)
    return () => { routes.delete(spec.path) }
  },
})
services.set('subagents', { interrupt: (sessionId, options) => { calls.interrupted.push({ sessionId, options }) } })
services.set('workspaceRegistry', {
  list: () => workspaces,
  async resolveByPath(path) {
    let canonical
    try { canonical = realpathSync(path) } catch { return undefined }
    return workspaces.find(row => row.path === canonical)
  },
  async create(path, title) {
    calls.created.push({ path, title })
    return makeWorkspace(realpathSync(path), title ?? 'made')
  },
  async archiveSession(sessionId, options) { calls.archived.push({ sessionId, options }) },
  async unarchiveSession(sessionId) { calls.unarchived.push(sessionId) },
})
const live = new Set()
services.set('sessions', { get: id => (live.has(id) ? { id } : undefined) })

const ctx = {
  webServer: services.get('webServer'),
  sessionPersistence: services.get('sessionPersistence'),
  effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d() } },
  get(name) { return services.get(name) },
  emit(name, payload) { calls.emitted.push({ name, payload }) },
  logger: { info() {}, warn() {} },
}

const { apply } = await import('../lib/index.js')
apply(ctx)

let checks = 0
let failures = 0
function check(label, condition, detail) {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` 鈥?${detail}`}`)
}
function equal(label, actual, expected) {
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

/** Drive one registered route and return its parsed JSON body. */
async function post(path, body) {
  const route = routes.get(`/plugins/dsh-plugin-remover/api${path}`)
  if (route === undefined) throw new Error(`no route ${path}`)
  const req = {
    method: 'POST',
    headers: { 'x-dsh-plugin-remover': '1' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body ?? {}), 'utf8') },
  }
  const done = Promise.withResolvers()
  const res = {
    headersSent: false,
    status: null,
    setHeader() {},
    writeHead(status) { this.status = status; this.headersSent = true },
    // `sendJson` ends the response with a Buffer, so decode before parsing.
    end(text) {
      if (text === undefined) { done.resolve(null); return }
      const text_ = Buffer.isBuffer(text) ? text.toString('utf8') : String(text)
      done.resolve(text_ === '' ? null : JSON.parse(text_))
    },
  }
  route.handler(req, res)
  const payload = await done.promise
  return { status: res.status, payload }
}

const sessionDir = id => join(HOME, 'sessions', PROJECT, id)

try {
  console.log('# a files-only deletion keeps the conversation')
  {
    const scan = await post('/scan', { sessionId: SESSIONS.keep })
    equal('the scan answers', scan.status, 200)
    equal('the scan reports the workspace slot', scan.payload.workspace?.id, workspace.id)
    const purge = await post('/purge', {
      sessionId: SESSIONS.keep,
      include: { record: false, cache: false, children: false, attachments: true },
      artifactIds: (scan.payload.artifacts.items ?? []).map(row => row.id),
      childIds: [],
    })
    equal('the purge answers', purge.status, 200)
    equal('it went to the bin', purge.payload.trash !== null, true)
    check('the conversation log is still on disk', existsSync(sessionDir(SESSIONS.keep)))
    check('the projection cache is still on disk',
      existsSync(join(HOME, 'storages', 'session_projcache', 'sessions', `${SESSIONS.keep}.json`)))
    check('the produced file left', !existsSync(files.produced))
    check('the attachment object was NOT removed', existsSync(ATTACH_PATH))
    equal('the conversation was not archived', calls.archived.filter(row => row.sessionId === SESSIONS.keep).length, 0)
    equal('no removal event was emitted',
      calls.emitted.filter(row => row.name === 'api-session/removed' && row.payload === SESSIONS.keep).length, 0)

    const list = await post('/trash/list', { groupKey: purge.payload.trash.groupKey })
    const group = (list.payload.groups ?? [])[0]
    equal('the group says the conversation was kept', group.recordIncluded, false)
    equal('the group counts no conversation items', group.roles.record, 0)
    check('the group holds files', group.roles.file > 0)
    check('every item carries a role', (group.items ?? []).every(item => item.role === 'file'))

    // Put the produced file back so later cases start from a full workspace.
    await post('/trash/restore', { groupKey: purge.payload.trash.groupKey })
    check('the produced file is back', existsSync(files.produced))
  }

  console.log('# a restore returns the conversation to its workspace')
  {
    const scan = await post('/scan', { sessionId: SESSIONS.keep })
    const purge = await post('/purge', {
      sessionId: SESSIONS.keep,
      include: { record: true, cache: true, children: false, attachments: false },
      artifactIds: (scan.payload.artifacts.items ?? []).map(row => row.id),
      childIds: [],
    })
    equal('the purge answers', purge.status, 200)
    check('the conversation log left', !existsSync(sessionDir(SESSIONS.keep)))
    equal('the conversation was archived or detached away', calls.archived.filter(row => row.sessionId === SESSIONS.keep).length, 0)

    const before = { attached: calls.attached.length, unarchived: calls.unarchived.length }
    const restored = await post('/trash/restore', { groupKey: purge.payload.trash.groupKey })
    equal('the restore answers', restored.status, 200)
    check('the group is dropped once empty', restored.payload.groupRemoved, true)
    check('the conversation log is back', existsSync(sessionDir(SESSIONS.keep)))
    equal('it was re-attached to its workspace', calls.attached.length, before.attached + 1)
    equal('it was taken out of the archive set', calls.unarchived.length, before.unarchived + 1)
    const session = restored.payload.groups[0].sessions[0]
    equal('the restore reports where it went', session.workspace.status, 're-attached')
    equal('the reported workspace is the original one', session.workspace.workspaceId, workspace.id)
  }

  console.log('# a restore recreates a deleted workspace')
  {
    const scan = await post('/scan', { sessionId: SESSIONS.gone })
    const purge = await post('/purge', {
      sessionId: SESSIONS.gone,
      include: { record: true, cache: true, children: false, attachments: false },
      artifactIds: (scan.payload.artifacts.items ?? []).map(row => row.id),
      childIds: [],
    })
    // Delete the workspace registration while the conversation is in the bin.
    const index = workspaces.indexOf(workspace)
    if (index !== -1) workspaces.splice(index, 1)
    const before = calls.created.length
    const restored = await post('/trash/restore', { groupKey: purge.payload.trash.groupKey })
    equal('the restore answers', restored.status, 200)
    equal('a workspace was recreated', calls.created.length, before + 1)
    equal('the restore reports the recreation', restored.payload.groups[0].sessions[0].workspace.status, 'created')
    check('the conversation log is back', existsSync(sessionDir(SESSIONS.gone)))
  }

  console.log('# a batch restore handles several groups')
  {
    const keys = []
    for (const id of [SESSIONS.batchA, SESSIONS.batchB]) {
      const scan = await post('/scan', { sessionId: id })
      const purge = await post('/purge', {
        sessionId: id,
        include: { record: true, cache: true, children: false, attachments: false },
        artifactIds: (scan.payload.artifacts.items ?? []).map(row => row.id),
        childIds: [],
      })
      keys.push(purge.payload.trash.groupKey)
    }
    equal('two groups exist', keys.length, 2)
    check('both conversations are gone', !existsSync(sessionDir(SESSIONS.batchA)) && !existsSync(sessionDir(SESSIONS.batchB)))
    const restored = await post('/trash/restore', { groupKeys: keys })
    equal('the batch restore answers', restored.status, 200)
    equal('both groups are reported', restored.payload.groups.length, 2)
    check('both groups are dropped', restored.payload.groups.every(group => group.groupRemoved === true))
    check('both conversations are back', existsSync(sessionDir(SESSIONS.batchA)) && existsSync(sessionDir(SESSIONS.batchB)))
  }

  console.log('# a referenced file is listed but cannot be deleted')
  {
    const scan = await post('/scan', { sessionId: SESSIONS.outside })
    equal('the scan answers', scan.status, 200)
    // 1.4.0: one flat list. A file the conversation read in another directory is
    // reported with the rest, because none of them can be deleted and the
    // directory it sat in no longer informs any decision.
    equal('the read file is reported in the referenced group', scan.payload.referenced.items.length, 1)
    equal('the group says it is not deletable', scan.payload.referenced.deletable, false)
    equal('there is no separate outside list for read files', scan.payload.referenced.outside, undefined)
    equal('the row still records where it sat', scan.payload.referenced.items[0].scope, 'outside')
    const outsideId = scan.payload.referenced.items[0].id

    // A stale page sends the id: the route must refuse, not report success.
    const refused = await post('/purge', {
      sessionId: SESSIONS.outside,
      include: { record: false, cache: false, children: false, attachments: false },
      artifactIds: [],
      referencedIds: [outsideId],
      childIds: [],
    })
    equal('a request to delete a referenced file is refused', refused.status, 400)
    equal('the refusal names the reason', refused.payload.code, 'referenced-not-deletable')
    equal('it says how many were asked for', refused.payload.referencedRequested, 1)
    check('the file is still on disk', existsSync(files.outside))

    // Nothing at all: still a harmless no-op, and the file stays.
    const untouched = await post('/purge', {
      sessionId: SESSIONS.outside,
      include: { record: false, cache: false, children: false, attachments: false },
      artifactIds: [],
      childIds: [],
    })
    equal('a request naming nothing is still a no-op', untouched.status, 200)
    equal('and it is marked empty', untouched.payload.empty, true)
    check('the file survives an unticked delete', existsSync(files.outside))
  }

  console.log('# an attachment copy folds into the produced file that has the same bytes')
  {
    // Folding is only offered for a *produced* file, because folding is a promise
    // that deleting the file also takes the copy. The mirror fixture reads the
    // file, so a second session is used that writes it instead: same bytes, same
    // attachment object, but now the copy is reachable through a row that can act.
    const producedPath = join(ROOT, 'elsewhere', 'written.md')
    // Deliberately different bytes from the read-only fixture: identical content
    // would share one digest, and the read-only session (which survives) would
    // then legitimately protect the object as "referenced elsewhere".
    writeFileSync(producedPath, 'written-outside\n', 'utf8')
    const producedHex = createHash('sha256').update(readFileSync(producedPath)).digest('hex')
    const producedObject = join(HOME, 'attachments', 'v1', 'objects', producedHex.slice(0, 2), producedHex)
    mkdirSync(dirname(producedObject), { recursive: true })
    writeFileSync(producedObject, readFileSync(producedPath))

    const sid = 'session-mirror-0008'
    const dir = join(HOME, 'sessions', PROJECT, sid)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([
      zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session', version: 4, id: sid, cwd: WORKSPACE })}\n`, 'utf8')),
      zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } })}\n`, 'utf8')),
    ]))
    headers[sid] = { version: 4, id: sid, createdAt: 1, cwd: WORKSPACE }
    events[sid] = [
      call('write', producedPath),
      { type: 'user/message', data: { content: [{ type: 'file', attachment: { attachmentId: `sha256:${producedHex}`, name: 'written.md', bytes: statSync(producedPath).size } }] } },
    ]

    const scan = await post('/scan', { sessionId: sid })
    equal('the scan answers', scan.status, 200)
    equal('the produced outside file is reported', scan.payload.artifacts.outside.length, 1)
    equal('and it carries its attachment mirror',
      scan.payload.artifacts.outside[0].mirrorAttachment, `sha256:${producedHex}`)
    equal('the attachment row is folded into that file',
      scan.payload.attachments.items.find(row => row.id === `sha256:${producedHex}`)?.mirrorOf, producedPath)
    // A referenced row never folds: its copy stays its own selectable row.
    const readScan = await post('/scan', { sessionId: SESSIONS.mirror })
    equal('a read file carries no mirror', readScan.payload.referenced.items[0].mirrorAttachment, undefined)
    check('its attachment row is standalone instead',
      readScan.payload.attachments.items.find(row => row.id === `sha256:${OUTSIDE_HEX}`)?.mirrorOf === undefined)

    // Deleting the produced file takes both: the file the user sees and the copy
    // the store kept. Ticking only the file must be enough.
    const purged = await post('/purge', {
      sessionId: sid,
      include: { record: true, cache: true, children: false, attachments: false },
      artifactIds: [scan.payload.artifacts.outside[0].id],
      childIds: [],
    })
    equal('the purge answers', purged.status, 200)
    check('the file is gone', !existsSync(producedPath))
    check('the attachment copy is gone too', !existsSync(producedObject))
    equal('the copy is reported separately from ticked attachments',
      purged.payload.removed.attachmentCopies, 1)
    await post('/trash/restore', { groupKey: purged.payload.trash.groupKey })
    check('the file comes back', existsSync(producedPath))
    check('the attachment copy comes back', existsSync(producedObject))
  }

  console.log('# an outside file the conversation produced is deletable too')
  {
    // The outside section now holds produced rows only, and the Host resolves
    // every one of them through `artifactIds` — the same namespace as the
    // produced-inside rows, because a produced id is a produced id wherever the
    // file landed. This drives that through the real route.
    const producedOutside = join(ROOT, 'elsewhere', 'made.txt')
    writeFileSync(producedOutside, 'made-outside\n', 'utf8')
    const sid = 'session-outside-produced-0007'
    const dir = join(HOME, 'sessions', PROJECT, sid)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([
      zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session', version: 4, id: sid, cwd: WORKSPACE })}\n`, 'utf8')),
      zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } })}\n`, 'utf8')),
    ]))
    headers[sid] = { version: 4, id: sid, createdAt: 1, cwd: WORKSPACE }
    events[sid] = [call('write', producedOutside)]

    const scan = await post('/scan', { sessionId: sid })
    equal('the scan answers', scan.status, 200)
    equal('the produced outside file is in its own list', scan.payload.artifacts.outside.length, 1)
    equal('and not in the normal produced list', scan.payload.artifacts.items.length, 0)
    const id = scan.payload.artifacts.outside[0].id

    // Ticking nothing must not delete it.
    const untouched = await post('/purge', {
      sessionId: sid,
      include: { record: false, cache: false, children: false, attachments: false },
      artifactIds: [], childIds: [],
    })
    check('the produced outside file survives an unticked delete', existsSync(producedOutside))
    void untouched

    // Ticking it as a produced id must delete it.
    const purged = await post('/purge', {
      sessionId: sid,
      include: { record: false, cache: false, children: false, attachments: false },
      artifactIds: [id],
      childIds: [],
    })
    equal('the purge answers', purged.status, 200)
    check('the produced outside file is gone', !existsSync(producedOutside))
    await post('/trash/restore', { groupKey: purged.payload.trash.groupKey })
    check('and a restore puts it back', existsSync(producedOutside))
    rmSync(producedOutside, { force: true })
  }

  console.log('# a stale selection is refused instead of reported as done')
  {
    // The dialog scanned, the file was removed by something else, then the user
    // pressed the button. Saying "done" here is the lie this refusal replaces.
    const stale = await post('/purge', {
      sessionId: SESSIONS.keep,
      include: { record: false, cache: false, children: false, attachments: false },
      artifactIds: ['adeadbeefcafe'],
      childIds: [],
    })
    equal('the refusal is an error status', stale.status, 400)
    equal('the code says nothing matched', stale.payload.code, 'nothing-matched')
    check('the conversation log is untouched', existsSync(sessionDir(SESSIONS.keep)))
  }

  console.log('# safety rails still hold')
  {
    const unconfirmed = await post('/trash/delete', { groupKeys: [] })
    check('a delete without confirmation is refused', unconfirmed.status !== 200)
    const emptyRestore = await post('/trash/restore', {})
    check('a restore naming nothing is refused', emptyRestore.status === 400)
    const traversal = await post('/trash/restore', { groupKeys: ['../etc'] })
    check('a traversal-shaped group key is refused', traversal.status === 400)
  }
} finally {
  rmSync(ROOT, { recursive: true, force: true })
}

console.log(`\n${String(checks - failures)}/${String(checks)} checks passed`)
if (failures > 0) process.exitCode = 1
