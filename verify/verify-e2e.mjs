/**
 * End-to-end proof against the live Host: delete a real conversation into the
 * recycle bin, read it back, restore it, and confirm the files are where they
 * were. Then delete again and clear it for good.
 *
 * This is the check the offline suites cannot make: it runs against the real
 * DSH home, the real persisted logs, and the real attachment store.
 *
 *   node verify/verify-e2e.mjs <sessionId> [--keep]
 *
 * Without `--keep` the temporary group it creates is permanently removed at the
 * end, so running it leaves the recycle bin as it found it minus one test
 * conversation. Pass a conversation you actually want gone.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'

const base = process.env.DSH_WEB_URL
const HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const sessionId = process.argv[2]
const keep = process.argv.includes('--keep')

let failures = 0
let checks = 0

function check(label, condition, detail) {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

function equal(label, actual, expected) {
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

/** One POST to this plugin's own route. */
function post(path, payload) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(`${base}/plugins/dsh-plugin-remover/api${path}`)
    const body = Buffer.from(JSON.stringify(payload ?? {}), 'utf8')
    const request = httpRequest({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(body.byteLength),
        'x-dsh-plugin-remover': '1',
        origin: base,
      },
    }, (response) => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        let parsedBody = null
        try {
          parsedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          parsedBody = null
        }
        resolve({ status: response.statusCode, payload: parsedBody })
      })
    })
    request.on('error', reject)
    request.write(body)
    request.end()
  })
}

/** Every session directory on disk for one Session id. */
function sessionDirs(id) {
  const root = join(HOME, 'sessions')
  const found = []
  try {
    for (const project of readdirSync(root)) {
      const candidate = join(root, project, id)
      try {
        if (statSync(candidate).isDirectory()) found.push(candidate)
      } catch {
        // Not this project.
      }
    }
  } catch {
    // No sessions root at all.
  }
  return found
}

/** The projection-cache document for one Session. */
function cacheFile(id) {
  return join(HOME, 'storages', 'session_projcache', 'sessions', `${id}.json`)
}

/** A recursive size, 0 for a missing path. */
function sizeOf(path) {
  try {
    const info = statSync(path)
    if (info.isFile()) return info.size
    let total = 0
    for (const entry of readdirSync(path)) total += sizeOf(join(path, entry))
    return total
  } catch {
    return 0
  }
}

async function main() {
  if (typeof base !== 'string' || base === '') throw new Error('DSH_WEB_URL is not set')
  if (typeof sessionId !== 'string' || sessionId === '') throw new Error('usage: verify-e2e.mjs <sessionId> [--keep]')

  console.log(`# target ${sessionId}`)

  const dirs = sessionDirs(sessionId)
  check('the target conversation exists on disk', dirs.length > 0, `looked under ${join(HOME, 'sessions')}`)
  if (dirs.length === 0) {
    console.log(`\n${String(checks - failures)}/${String(checks)} checks passed`)
    process.exitCode = 1
    return
  }
  const storeBytes = dirs.reduce((sum, dir) => sum + sizeOf(dir), 0)
  console.log(`  (${String(dirs.length)} directories, ${String(storeBytes)} bytes)`)

  console.log('# scan')
  const scan = await post('/scan', { sessionId })
  equal('the scan answers', scan.status, 200)
  const plan = scan.payload
  check('it reports the conversation title', typeof plan.title === 'string' || plan.title === null)
  equal('it reports no children for a leaf', Array.isArray(plan.children), true)
  check('it reports the trash headroom', typeof plan.trash.usedBytes === 'number')
  const artifactIds = (plan.artifacts.items ?? []).map(row => row.id)
  const referencedIds = []
  console.log(`  artifacts: ${String(artifactIds.length)}, referenced: ${String((plan.referenced.items ?? []).length)}`)
  for (const row of plan.artifacts.items ?? []) {
    check(`artifact ${sessionId} reports a source directory`, typeof row.dir === 'string' && row.dir !== '')
    check('artifact reports provenance', Array.isArray(row.sources) && row.sources.length > 0)
    if (failures > 8) break
  }

  console.log('# purge into the recycle bin')
  const purge = await post('/purge', {
    sessionId,
    include: { record: true, cache: true, children: true, attachments: false },
    artifactIds,
    referencedIds,
    childIds: (plan.children ?? []).map(row => row.sessionId),
  })
  equal('the purge answers', purge.status, 200)
  check('it moved the conversation to the bin', purge.payload?.toTrash === true)
  const groupKey = purge.payload?.trash?.groupKey
  check('it reports a group key', typeof groupKey === 'string' && groupKey !== '')
  equal('it reports no errors', (purge.payload?.errors ?? []).length, 0)
  check('the conversation directory is gone',
    sessionDirs(sessionId).length === 0)
  check('the projection cache is gone', !existsSync(cacheFile(sessionId)))
  for (const row of plan.artifacts.items ?? []) {
    if (row.displayPath === undefined) continue
    check(`the ticked file left its directory: ${row.displayPath}`, !existsSync(row.displayPath))
    if (failures > 8) break
  }

  console.log('# recycle bin')
  const grouped = await post('/trash/list', { groupKey })
  equal('the bin lists the group', grouped.status, 200)
  const group = (grouped.payload?.groups ?? []).find(row => row.groupKey === groupKey)
  check('the group is present', group !== undefined)
  equal('the group names the conversation', group?.sessionId, sessionId)
  check('the group reports its items', Array.isArray(group?.items) && group.items.length > 0)
  check('every item reports its original path',
    (group?.items ?? []).every(item => typeof item.originalPath === 'string' && item.originalPath !== ''))
  check('every item reports its directory',
    (group?.items ?? []).every(item => typeof item.dir === 'string' && item.dir !== ''))
  check('the group reports an expiry or none', group?.expiresAt === null || typeof group?.expiresAt === 'number')
  const itemCount = group?.items?.length ?? 0
  console.log(`  group ${groupKey}: ${String(itemCount)} items, ${String(group?.bytes ?? 0)} bytes`)

  console.log('# restore the whole group')
  const restore = await post('/trash/restore', { groupKey })
  equal('the restore answers', restore.status, 200)
  equal('every item is restored', (restore.payload?.failed ?? []).length, 0)
  check('the group is dropped once empty', restore.payload?.groupRemoved === true)
  check('the conversation directory is back', sessionDirs(sessionId).length > 0)
  equal('the conversation directory is the same size',
    sessionDirs(sessionId).reduce((sum, dir) => sum + sizeOf(dir), 0), storeBytes)
  check('the projection cache is back', existsSync(cacheFile(sessionId)))
  for (const row of plan.artifacts.items ?? []) {
    if (row.displayPath === undefined) continue
    check(`the ticked file is back: ${row.displayPath}`, existsSync(row.displayPath))
    if (failures > 8) break
  }
  const emptied = await post('/trash/list', {})
  check('the bin no longer holds that group',
    !(emptied.payload?.groups ?? []).some(row => row.groupKey === groupKey))

  console.log('# delete again, then clear for good')
  const again = await post('/purge', {
    sessionId,
    include: { record: true, cache: true, children: true, attachments: false },
    artifactIds,
    referencedIds,
    childIds: (plan.children ?? []).map(row => row.sessionId),
  })
  equal('the second purge answers', again.status, 200)
  const secondKey = again.payload?.trash?.groupKey
  check('it created a new group', typeof secondKey === 'string' && secondKey !== groupKey)
  if (keep) {
    console.log(`  (--keep: leaving group ${String(secondKey)} in the bin)`)
  } else {
    const cleared = await post('/trash/delete', { groupKeys: [secondKey], confirm: true })
    equal('the permanent delete answers', cleared.status, 200)
    check('it reports the group removed',
      (cleared.payload?.removed ?? []).some(row => row.groupKey === secondKey))
    const final = await post('/trash/list', {})
    check('the group is gone from the bin',
      !(final.payload?.groups ?? []).some(row => row.groupKey === secondKey))
    check('the conversation stays deleted', sessionDirs(sessionId).length === 0)
  }

  console.log(`\n${String(checks - failures)}/${String(checks)} checks passed`)
  if (failures > 0) process.exitCode = 1
}

await main()
