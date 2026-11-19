// Regression suite for the scan gap found in session-ebf76e11.
//
// The bug: a conversation produced nine documents by writing Python scripts and
// running them through `pwsh`. The scanner only read `file_path` out of
// `write`/`edit`/`read`/`read_image`, so it saw the seven scripts and none of the
// nine products — and the user, deleting the conversation, was told there was
// nothing else to remove.
//
// The fixture is derived from that real log: same event timing and tool shapes,
// with paths replaced by <WORKSPACE>/<HOME>. Offline; no DSH and no network.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { internals } from '../lib/index.js'

const {
  CHANGED_MAX_FILES,
  NOISE_DIRECTORIES,
  collectAttachmentMeta,
  collectTimeWindow,
  collectToolPaths,
  scanChangedInWindow,
  selectionOf,
} = internals

let passed = 0
const failures = []

function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`)
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

function equal(label, actual, expected) {
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

async function group(label, fn) {
  console.log(`\n# ${label}`)
  return fn()
}

// ---------------------------------------------------------------- fixture

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/ebf76e11-events.json', import.meta.url), 'utf8'))
const WORKSPACE = mkdtempSync(join(tmpdir(), 'dsh-scan-ws-'))
const HOME = mkdtempSync(join(tmpdir(), 'dsh-scan-home-'))

/** Re-expand the fixture's tokens onto this run's scratch directories. */
function expand(text) {
  return text.split('<WORKSPACE>').join(WORKSPACE).split('<HOME>').join(HOME)
}

/** The fixture's events with tokens resolved. */
const events = FIXTURE.events.map((event) => {
  if (event.type !== 'tool/call') return event
  let args
  try {
    args = JSON.parse(event.data.arguments)
  } catch {
    args = {}
  }
  const resolved = {}
  for (const [key, value] of Object.entries(args)) {
    resolved[key] = typeof value === 'string' ? expand(value) : value
  }
  return { type: event.type, time: event.time, data: { name: event.data.name, arguments: JSON.stringify(resolved) } }
})

const window = collectTimeWindow(events)
const SPAN = { start: Math.min(...events.map((e) => e.time)), end: Math.max(...events.map((e) => e.time)) }

// Materialise the workspace exactly as the real run left it: nine deliverables,
// seven scripts, and one image that predates the conversation.
function seedWorkspace() {
  for (const name of [...FIXTURE.deliverables, ...FIXTURE.scripts]) {
    const target = join(WORKSPACE, name)
    writeFileSync(target, `fixture content for ${name}`, 'utf8')
    // Mid-window, so it looks produced during the conversation.
    const when = new Date((SPAN.start + SPAN.end) / 2)
    utimesSync(target, when, when)
  }
  for (const name of FIXTURE.outsideWindow) {
    const target = join(WORKSPACE, name)
    writeFileSync(target, 'old image', 'utf8')
    const old = new Date(SPAN.start - 22 * 24 * 3600 * 1000) // ~3 weeks earlier
    utimesSync(target, old, old)
  }
}

seedWorkspace()

// ---------------------------------------------------------------- the window

await group('the time window comes from the log', async () => {
  check('a window is recovered', window !== null)
  if (window === null) return
  check('the window covers the fixture span',
    window.start <= SPAN.start && window.end >= SPAN.end,
    `${new Date(window.start).toISOString()} .. ${new Date(window.end).toISOString()}`)
  check('the window is slack, not the exact span',
    SPAN.start - window.start >= 5000 && window.end - SPAN.end >= 5000)
})

await group('a log without timestamps yields no window', async () => {
  equal('no timestamps, no window', collectTimeWindow([{ type: 'x' }, { type: 'y' }]), null)
  equal('an empty log yields no window', collectTimeWindow([]), null)
})

// ---------------------------------------------------------------- what the old scanner saw

await group('what path-keyed scanning alone still finds', async () => {
  const { written, read } = collectToolPaths(events, WORKSPACE)
  const writtenNames = [...written.keys()].map((p) => p.split(/[\\/]/).pop())
  const readNames = [...read.keys()].map((p) => p.split(/[\\/]/).pop())

  equal('the seven scripts are found as produced files', writtenNames.length, FIXTURE.scripts.length)
  for (const script of FIXTURE.scripts) {
    check(`${script} is reported as produced`, writtenNames.includes(script))
  }
  equal('only the one read_image target is reported as referenced', readNames.length, 1)

  // This is the bug, stated as a fact so a regression that hides it shows up.
  // One deliverable — the image — happened to be visible already, because the
  // conversation passed it to `read_image`. The other eight were invisible.
  const missed = FIXTURE.deliverables.filter((name) => !writtenNames.includes(name) && !readNames.includes(name))
  equal('the deliverables are almost entirely invisible to path-keyed scanning', missed.length, 8)
  check('the one visible deliverable is the image the conversation read', readNames.includes('测试图片.png'))
})

// ---------------------------------------------------------------- the fix

const known = new Set()
const scanned = await scanChangedInWindow([WORKSPACE], window, HOME, known)

await group('the window scan finds the deliverables', async () => {
  const names = scanned.rows.map((row) => row.path.split(/[\\/]/).pop())
  for (const name of FIXTURE.deliverables) {
    check(`${name} is found`, names.includes(name))
  }
  check('all nine deliverables are recovered', FIXTURE.deliverables.every((n) => names.includes(n)))
})

await group('the window scan does not over-reach', async () => {
  const names = scanned.rows.map((row) => row.path.split(/[\\/]/).pop())
  for (const name of FIXTURE.outsideWindow) {
    check(`${name} (predates the conversation) is excluded`, !names.includes(name))
  }
  equal('nothing was truncated', scanned.truncated, false)
})

await group('every changed row is shaped like the other file rows', async () => {
  const row = scanned.rows.find((r) => r.kind === 'changed')
  check('a row exists', row !== undefined)
  if (row === undefined) return
  equal('kind is changed', row.kind, 'changed')
  check('id is an artifact id', /^a[0-9a-f]{12}$/.test(row.id))
  check('path is absolute', row.path.startsWith(WORKSPACE))
  check('dir is the containing directory', row.dir === WORKSPACE)
  check('bytes is a number', typeof row.bytes === 'number' && row.bytes > 0)
  check('sources is empty, because nothing attributes the file', Array.isArray(row.sources) && row.sources.length === 0)
  check('mtime is recorded', typeof row.mtime === 'number')
})

await group('a path already named by a tool call is not reported twice', async () => {
  const { written } = collectToolPaths(events, WORKSPACE)
  const already = new Set([...written.keys()])
  const once = await scanChangedInWindow([WORKSPACE], window, HOME, already)
  const names = once.rows.map((row) => row.path.split(/[\\/]/).pop())
  for (const script of FIXTURE.scripts) {
    check(`${script} is not duplicated into the changed group`, !names.includes(script))
  }
  check('the deliverables are still found alongside the exclusion', FIXTURE.deliverables.every((n) => names.includes(n)))
})

await group('noise directories are skipped', async () => {
  for (const dir of ['node_modules', '.git', 'dist', '__pycache__', '.venv']) {
    const target = join(WORKSPACE, dir)
    mkdirSync(target, { recursive: true })
    const file = join(target, 'artifact.bin')
    writeFileSync(file, 'noise', 'utf8')
    const when = new Date((SPAN.start + SPAN.end) / 2)
    utimesSync(file, when, when)
  }
  const after = await scanChangedInWindow([WORKSPACE], window, HOME, new Set())
  const names = after.rows.map((row) => row.path)
  for (const dir of ['node_modules', '.git', 'dist', '__pycache__', '.venv']) {
    check(`${dir} is not walked`, !names.some((p) => p.includes(`${dir}${require_sep()}`)))
  }
  check('the noise set is non-empty', NOISE_DIRECTORIES.size >= 10)
})

function require_sep() {
  return process.platform === 'win32' ? '\\' : '/'
}

await group('the DSH home is never scanned', async () => {
  const inside = join(HOME, 'dsh-plugin-remover', 'trash', 'stray.txt')
  mkdirSync(join(HOME, 'dsh-plugin-remover', 'trash'), { recursive: true })
  writeFileSync(inside, 'not a conversation product', 'utf8')
  const when = new Date((SPAN.start + SPAN.end) / 2)
  utimesSync(inside, when, when)
  const after = await scanChangedInWindow([WORKSPACE], window, HOME, new Set())
  check('nothing under the DSH home is reported',
    !after.rows.some((row) => row.path.startsWith(HOME)),
    after.rows.map((r) => r.path).join(', '))
})

await group('a file outside the working directory is not reported', async () => {
  const outsideDir = mkdtempSync(join(tmpdir(), 'dsh-scan-outside-'))
  const outsideFile = join(outsideDir, 'elsewhere.txt')
  writeFileSync(outsideFile, 'outside', 'utf8')
  const when = new Date((SPAN.start + SPAN.end) / 2)
  utimesSync(outsideFile, when, when)
  const after = await scanChangedInWindow([WORKSPACE], window, HOME, new Set())
  check('a file in another tree is not reported',
    !after.rows.some((row) => row.path === outsideFile),
    outsideFile)
  rmSync(outsideDir, { recursive: true, force: true })
})

await group('degraded inputs report nothing instead of guessing', async () => {
  const noWindow = await scanChangedInWindow([WORKSPACE], null, HOME, new Set())
  equal('no window means no rows', noWindow.rows.length, 0)
  const noCwd = await scanChangedInWindow([], window, HOME, new Set())
  equal('no working directory means no rows', noCwd.rows.length, 0)
  const missing = await scanChangedInWindow([join(WORKSPACE, 'does-not-exist')], window, HOME, new Set())
  equal('a missing directory yields no rows', missing.rows.length, 0)
})

await group('the walk is bounded', async () => {
  const deep = join(WORKSPACE, 'deep')
  let cursor = deep
  for (let i = 0; i < 9; i += 1) {
    cursor = join(cursor, `l${String(i)}`)
    mkdirSync(cursor, { recursive: true })
  }
  const deepFile = join(cursor, 'too-deep.txt')
  writeFileSync(deepFile, 'deep', 'utf8')
  const when = new Date((SPAN.start + SPAN.end) / 2)
  utimesSync(deepFile, when, when)
  const after = await scanChangedInWindow([WORKSPACE], window, HOME, new Set())
  check('a file beyond the depth limit is not reported',
    !after.rows.some((row) => row.path === deepFile))
  check('the file cap is a positive number', CHANGED_MAX_FILES > 0)
})

// ---------------------------------------------------------------- selection

await group('the changed group is never selected by default', async () => {
  const bare = selectionOf({})
  check('a request with no changedIds selects nothing', Array.isArray(bare.changedIds) && bare.changedIds.length === 0)
  const withArtifacts = selectionOf({ artifactIds: ['a1'], referencedIds: ['r1'] })
  equal('supplying other lists does not imply changed ids', withArtifacts.changedIds.length, 0)
  const explicit = selectionOf({ changedIds: ['c1', 'c2'] })
  equal('explicit ids are honoured', explicit.changedIds.length, 2)
  const junk = selectionOf({ changedIds: [1, null, '', 'ok'] })
  equal('non-string ids are dropped', junk.changedIds.length, 1)
})

await group('a changed row reaches the deletion only when it was ticked', async () => {
  // The plan shape collectSelection consumes, with one row per group so the
  // three groups can be told apart by whether they appear in `items`.
  const row = (id, name, kind) => ({
    id,
    path: join(WORKSPACE, name),
    displayPath: join(WORKSPACE, name),
    dir: WORKSPACE,
    bytes: 10,
    ops: 1,
    kind,
    tools: [],
    sources: [],
  })
  const CHANGED_ID = 'c'.padEnd(13, '0')
  const plan = {
    sessionId: 'session-synthetic',
    cwd: WORKSPACE,
    store: { directories: [], bytes: 0 },
    artifacts: { items: [row('a'.padEnd(13, '0'), 'made.txt', 'artifact')] },
    referenced: { items: [row('r'.padEnd(13, '0'), 'read.txt', 'referenced')] },
    changed: { items: [row(CHANGED_ID, 'changed.txt', 'changed')] },
    projectionCache: { path: join(HOME, 'cache.json'), exists: false, bytes: 0 },
    children: [],
    sessions: ['session-synthetic'],
    attachments: { ids: [], items: [] },
  }

  const none = internals.collectSelection(plan, selectionOf({ artifactIds: [] }), HOME)
  check('unticked: the changed row is not in the deletion',
    !none.items.some((item) => item.kind === 'changed'),
    none.items.map((i) => i.kind).join(','))

  const ticked = internals.collectSelection(plan, selectionOf({ changedIds: [CHANGED_ID] }), HOME)
  const changedItems = ticked.items.filter((item) => item.kind === 'changed')
  equal('ticked: exactly one changed row is in the deletion', changedItems.length, 1)
  equal('ticked: it carries the original path', changedItems[0].originalPath, join(WORKSPACE, 'changed.txt'))
  equal('ticked: an unticked group stays out',
    ticked.items.filter((item) => item.kind === 'artifact').length, 0)
})

// ---------------------------------------------------------------- attachments

await group('attachments carry their names', async () => {
  const into = new Map()
  collectAttachmentMeta(events, into)
  const named = [...into.values()].filter((item) => typeof item.name === 'string' && item.name !== '')
  check('at least one attachment has a name', named.length >= 1, `${into.size} attachments, ${named.length} named`)
  for (const item of named) {
    check(`${item.name} carries a size`, typeof item.bytes === 'number' && item.bytes > 0)
    check(`${item.name} carries a media type`, item.mediaType === 'image/png')
  }
  const ids = [...into.keys()]
  check('every id is a sha256 reference', ids.every((id) => /^sha256:[0-9a-f]{64}$/.test(id)))
  equal('no attachment is counted twice', into.size, ids.length)
})

// ---------------------------------------------------------------- verdict

rmSync(WORKSPACE, { recursive: true, force: true })
rmSync(HOME, { recursive: true, force: true })

console.log('')
if (failures.length > 0) {
  console.log(`${String(passed)}/${String(passed + failures.length)} checks passed, ${String(failures.length)} failed:`)
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
console.log(`${String(passed)}/${String(passed)} checks passed`)
