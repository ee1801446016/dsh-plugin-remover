/**
 * Seed one synthetic Session into the live DSH home, for the end-to-end check.
 *
 * It is a real Session as far as the backend is concerned — a log in the
 * backend's own physical format, a projection-cache row, and a couple of
 * produced files in a scratch workspace — so the end-to-end run exercises the
 * real code paths instead of a stub. Nothing the user owns is touched.
 *
 * The physical format is a concatenated-frame container: the first Zstandard
 * frame holds exactly the one header line, and later frames hold the event
 * lines. The backend refuses a log whose first frame carries anything else, so
 * seeding it correctly is part of validating that this plugin reads what the
 * backend actually writes.
 *
 *   node verify/seed-e2e.mjs
 *
 * Prints the Session id it created. Delete it with verify-e2e.mjs, which removes
 * it for good at the end.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

const HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')

/**
 * The backend's directory name for one working directory.
 *
 * A stored Session is only accepted when the directory it sits in round-trips to
 * its header's `cwd`, so a seeded log has to be placed under the escaped name
 * rather than a readable one. The shape is read off the logs already on this
 * machine: `--` + the path with `:` dropped, `\` turned into `-`, a space written
 * as `~0020`, and any non-ASCII character as `~XXXX` in upper-case hex, then `--`.
 *
 * @param cwd - the working directory the Session records.
 * @returns the directory name the backend expects under `<home>/sessions`.
 */
function escapedProject(cwd) {
  let out = ''
  for (const character of cwd) {
    if (/[A-Za-z0-9._-]/.test(character)) out += character
    else if (character === ':') continue
    else if (character === '\\' || character === '/') out += '-'
    else if (character === ' ') out += '~0020'
    else out += `~${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`
  }
  return `--${out}--`
}

// A workspace the Session claims as its `cwd`; the produced files live inside it.
const workspace = join(HOME, '..', 'dsh-plugin-remover-e2e', 'scratch')
const project = escapedProject(workspace)
const sessionId = `session-${randomUUID()}`
const directory = join(HOME, 'sessions', project, sessionId)
mkdirSync(directory, { recursive: true })
mkdirSync(join(workspace, 'out'), { recursive: true })

// Two produced files and one file the Session only reads.
const producedA = join(workspace, 'out', 'report.md')
const producedB = join(workspace, 'out', 'notes.txt')
const readOnly = join(workspace, 'input.json')
writeFileSync(producedA, '# report\n\nseeded for the end-to-end check\n', 'utf8')
writeFileSync(producedB, 'notes from a synthetic conversation\n', 'utf8')
writeFileSync(readOnly, '{"seeded":true}\n', 'utf8')

// The header the backend's guard accepts: `type` plus the required keys.
const header = {
  type: 'session',
  version: 4,
  id: sessionId,
  createdAt: Date.now(),
  cwd: workspace,
  isSeeded: false,
  delegationDepth: 0,
}

// Events carry `seq` and `time`; a `tool/call` also has to sit inside an open
// turn and step. The backend validates every event against its own schema and
// its own ordering rules, so a seeded log has to match what the writer produces
// rather than a simplified guess.
const now = Date.now()

/**
 * One assistant message that advertises a tool call.
 *
 * The v4 reader tracks a tool lifecycle: a `tool/call` event is only legal after
 * an `assistant/message` has advertised that exact `callId`, name, and argument
 * string. Seeding a call without its advertisement is what the reader calls
 * "no advertised tool lifecycle", so both go in together.
 *
 * @param id - the call id, shared by the advertisement and the call.
 * @param name - tool name.
 * @param args - its arguments, serialised once and reused verbatim.
 */
function advertise(id, name, args) {
  return {
    type: 'assistant/message',
    // A message is a surface node; without `append` the reader expects a
    // replacement range object and rejects the event.
    surfaceOp: 'append',
    seq: 0,
    time: now,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        // Every message carries its own id; the reader refuses an event whose
        // message has none, because a surface node has to be addressable.
        id: randomUUID(),
        content: [{ type: 'tool-call', id, name, arguments: JSON.stringify(args) }],
        source: { kind: 'model', provider: 'seeded', model: 'seeded' },
      },
    },
  }
}

/** One `tool/call` for a call that was advertised just before it. */
function call(id, name, args) {
  return {
    type: 'tool/call',
    seq: 0,
    time: now,
    data: { turn: 1, step: 1, callId: id, name, arguments: JSON.stringify(args) },
  }
}

const callIds = ['call_seed_0001', 'call_seed_0002', 'call_seed_0003', 'call_seed_0004']
const calls = [
  ['write', { file_path: producedA, content: '# report' }],
  ['edit', { file_path: producedA, old_string: 'a', new_string: 'b' }],
  ['write', { file_path: producedB, content: 'notes' }],
  ['read', { file_path: readOnly }],
]

const events = [
  { type: 'permission/preset', seq: 0, time: now, data: { preset: 'workspace-write' } },
  { type: 'sandbox/mode', seq: 0, time: now, data: { mode: 'workspace-write' } },
  { type: 'approval/policy', seq: 0, time: now, data: { policy: 'ask' } },
  { type: 'turn/start', seq: 0, time: now, data: { turn: 1 } },
  { type: 'step/start', seq: 0, time: now, data: { turn: 1, step: 1 } },
  ...calls.flatMap(([name, args], index) => [
    advertise(callIds[index], name, args),
    call(callIds[index], name, args),
  ]),
]
// `seq` is dense and starts at 0; the reader checks the contiguous prefix.
events.forEach((event, index) => { event.seq = index })
// `seq` is dense and starts at 0; the reader checks the contiguous prefix.
events.forEach((event, index) => { event.seq = index })

// Frame 1: exactly the header line. Frames 2..n: the event lines. A reader that
// only wants metadata stops after frame 1, which is why it must be separate.
const headerFrame = zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`, 'utf8'))
const eventFrame = zstdCompressSync(Buffer.from(`${events.map(event => JSON.stringify(event)).join('\n')}\n`, 'utf8'))
writeFileSync(join(directory, 'session.v4.jsonl.zstd'), Buffer.concat([headerFrame, eventFrame]))

// The projection cache, so the plan reports a cache row and the title resolves.
const cacheFile = join(HOME, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
mkdirSync(join(HOME, 'storages', 'session_projcache', 'sessions'), { recursive: true })
writeFileSync(cacheFile, `${JSON.stringify({ record: { rows: { title: { val: '端到端验证用的合成对话' } } } })}\n`, 'utf8')

console.log(sessionId)
console.log(`workspace: ${workspace}`)
console.log(`produced:  ${producedA}`)
console.log(`produced:  ${producedB}`)
console.log(`read-only: ${readOnly}`)
