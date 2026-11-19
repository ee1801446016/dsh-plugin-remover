/**
 * Live verification: the bundle the Web Host actually serves to the browser.
 *
 * The offline suites prove the source registers the plugin-page section and that
 * the Host routes answer. Neither proves the *served* bytes contain it — a stale
 * bundle, a disabled bundle, or a build step that did not run all leave the
 * source correct while the user still sees nothing at all. This checks the
 * artifact the browser downloads, and then exercises the routes against the real
 * DSH home.
 *
 *   node verify/verify-served.mjs
 *
 * Requires a running DSH Web instance; reads DSH_WEB_URL. Prints SKIP and exits
 * 0 when none is reachable, so it is safe in a suite that may run offline.
 */

import { existsSync, readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'

const base = process.env.DSH_WEB_URL

/** The version this checkout ships; the running Host is compared against it. */
const LOCAL_VERSION = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')).version

/**
 * Read this package's manifest and the two exported resources.
 *
 * The plugin manager resolves `./locale/en.json` and `./icon` through the
 * manifest's `exports` map, then lists the locale directory. A manifest that
 * drops either export makes the Host report a metadata error and the plugin row
 * loses its name, description, and icon — so both exports, and the files they
 * name, are checked here before anything that depends on them.
 */
function inspectManifest() {
  const root = join(import.meta.dirname, '..')
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const exported = manifest.exports ?? {}
  return {
    name: manifest.name,
    version: manifest.version,
    files: manifest.files ?? [],
    localeExport: String(exported['./locale/*.json'] ?? ''),
    iconExport: String(exported['./icon'] ?? ''),
    localeEnglish: existsSync(join(root, 'locale', 'en.json')),
    localeChinese: existsSync(join(root, 'locale', 'zh.json')),
    icon: existsSync(join(root, 'icon.svg')),
    declaredIcon: String(manifest.icon ?? ''),
  }
}

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

/** One plain GET. */
function get(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const request = httpRequest({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'GET',
    }, (response) => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    request.on('error', reject)
    request.end()
  })
}

/** One POST to this plugin's own route, with the marker header it requires. */
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

/** Read the client graph from the SSE channel and return one plugin's entry. */
function graphEntry(id) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(`${base}/plugins/events`)
    const request = httpRequest({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'GET',
      headers: { accept: 'text/event-stream' },
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume()
        resolve(null)
        return
      }
      let buffer = ''
      response.on('data', (chunk) => {
        buffer += chunk.toString('utf8')
        const marker = buffer.indexOf('data: ')
        if (marker === -1) return
        let frame
        try {
          frame = JSON.parse(buffer.slice(marker + 6).split('\n\n')[0])
        } catch {
          return
        }
        if (frame.type !== 'graph') return
        response.destroy()
        resolve(frame.graph.entries.find(entry => entry.id === id) ?? null)
      })
      setTimeout(() => {
        response.destroy()
        resolve(null)
      }, 5000)
    })
    request.on('error', reject)
    request.end()
  })
}

async function main() {
  console.log('# package metadata')
  const manifest = inspectManifest()
  equal('the package is the renamed one', manifest.name, 'dsh-plugin-remover')
  // Read the expected version instead of pinning it here: a version bump is a
  // release decision, not a served-bundle regression, and hardcoding it turned
  // every bump into a red suite that said nothing about the running Host.
  equal('the installed revision matches package.json', manifest.version, LOCAL_VERSION)
  // The regression guard for the ENOENT this suite was extended after: without
  // these two exports the Host cannot read the plugin's own display metadata.
  equal('it exports its locale dictionaries', manifest.localeExport, './locale/*.json')
  equal('it exports its icon', manifest.iconExport, './icon.svg')
  check('the English dictionary exists', manifest.localeEnglish)
  check('the Chinese dictionary exists', manifest.localeChinese)
  check('the icon exists', manifest.icon)
  equal('the manifest names the icon', manifest.declaredIcon, './icon.svg')
  for (const entry of ['lib', 'locale', 'icon.svg', 'cordis.patch.yml']) {
    check(`the published file list keeps ${entry}`, manifest.files.includes(entry))
  }
  const english = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'locale', 'en.json'), 'utf8'))
  check('the English dictionary carries a title', typeof english.meta?.title === 'string' && english.meta.title !== '')
  check('the English dictionary carries a description', typeof english.meta?.description === 'string' && english.meta.description !== '')

  if (typeof base !== 'string' || base === '') {
    console.log('SKIP no DSH_WEB_URL in this environment')
    return
  }

  console.log('# live instance')
  let health
  try {
    health = await get(`${base}/plugins/dsh-plugin-remover/api/health`)
  } catch (error) {
    console.log(`SKIP DSH is not reachable at ${base}: ${error.message}`)
    return
  }
  check('the plugin answers health', health.status === 200)
  check('the plugin reports itself', health.body.includes('"plugin":"dsh-plugin-remover"'))
  check('the Host half is the installed revision', health.body.includes(`"version":"${LOCAL_VERSION}"`))

  console.log('# client bundle')
  const entry = await graphEntry('dsh-plugin-remover')
  check('the plugin is in the browser module graph', entry !== null)
  if (entry === null) {
    console.log(`\n${String(checks - failures)}/${String(checks)} checks passed`)
    process.exitCode = 1
    return
  }
  check('the graph entry carries a revision URL', typeof entry.url === 'string' && entry.url !== '')

  // The graph URL is deliberately relative to the page root.
  const bundle = await get(new URL(entry.url, base.endsWith('/') ? base : `${base}/`).toString())
  check('the served bundle is available', bundle.status === 200, `status ${String(bundle.status)}`)
  check('the served bundle is JavaScript', bundle.body.length > 1000)

  // The assertions that make this suite worth running: the artifact the browser
  // actually executes contains the surface that reaches hidden conversations,
  // and it calls the routes that exist.
  check('the served bundle registers the plugin-page section', bundle.body.includes("id: 'remover-trash'"))
  check('the section targets the plugin detail page', bundle.body.includes("name: 'plugins.detail.section'"))
  check('the served bundle registers the recycle-bin panel', bundle.body.includes("id: 'remover-trash-dialog'"))
  check('it reads the recycle-bin list route', bundle.body.includes("'/trash/list'"))
  check('it restores through the recycle-bin route', bundle.body.includes("'/trash/restore'"))
  check('it permanently deletes through the recycle-bin route', bundle.body.includes("'/trash/delete'"))
  check('it writes the recycle-bin settings', bundle.body.includes("'/trash/settings'"))
  check('it reads the hidden report', bundle.body.includes("'/hidden'"))
  check('it deletes through the purge route', bundle.body.includes("'/purge'"))
  check('it offers the per-file details panel', bundle.body.includes("'detail.dir'"))
  // The sidebar shortcut is back, on purpose, and must be the new entry rather
  // than the previous revision's eye-icon button.
  check('the served bundle registers the sidebar recycle-bin entry', bundle.body.includes("id: 'remover-trash-foot'"))
  check('the sidebar entry uses the footer-action slot', bundle.body.includes("name: 'sidebar.footer.action'"))
  check('the sidebar entry obeys the showSidebarTrash setting', bundle.body.includes('showSidebarTrash'))
  check('the previous eye-icon footer button did not return', !bundle.body.includes('HiddenSessionsTrigger'))
  // Without the injected stylesheet the dialog's footer can leave the viewport.
  check('the served bundle carries the dialog stylesheet', bundle.body.includes('dsh-plugin-remover-styles'))
  check('the served bundle caps the dialog height', bundle.body.includes('max-height: calc(100vh - 48px)'))
  check('the served bundle scrolls the dialog body', bundle.body.includes('overflow-y: auto'))
  // 1.2.0: the compact sectioned dialog, the keep-the-conversation switch, and
  // the batch recycle bin. Each is a served artifact the browser must actually
  // receive, not just a source file that has it.
  check('the served bundle folds the sections', bundle.body.includes('section-head'))
  check('the served bundle keeps the conversation switch', bundle.body.includes('includeRecord'))
  check('the served bundle labels recycle-bin roles', bundle.body.includes("trash.roles"))
  check('the served bundle marks files-only groups', bundle.body.includes("trash.filesOnly"))
  check('the served bundle supports a batch restore', bundle.body.includes("trash.restoreSelection"))
  check('the served bundle supports a batch delete', bundle.body.includes("trash.deleteSelection"))
  // 1.3.0: files outside the working directory, the attachment-copy fold, and the
  // refused-row list. All three are browser-side features, so a Host-only upgrade
  // would leave them invisible while every offline Host check stayed green.
  check('the served bundle has the outside-the-workspace section', bundle.body.includes('section.outside'))
  check('the served bundle folds a duplicated attachment', bundle.body.includes('mirrorOf'))
  check('the served bundle names the store copy in the file details', bundle.body.includes('detail.mirror'))
  check('the served bundle lists refused rows with their reason', bundle.body.includes('refusedList'))
  check('the served bundle reports the copies it took', bundle.body.includes('done.mirrors'))

  console.log('# routes')
  const trash = await post('/trash/list', {})
  check('the recycle-bin list answers', trash.status === 200)
  check('the list reports settings', typeof trash.payload?.settings?.retentionDays, 'number')
  check('the list reports its byte total', typeof trash.payload?.bytes, 'number')
  check('the list reports groups', Array.isArray(trash.payload?.groups))
  check('the list reports the retention cap', typeof trash.payload?.maxBytes, 'number')
  check('the list reports the sidebar-entry switch', typeof trash.payload?.settings?.showSidebarTrash, 'boolean')
  // 1.3.0 routes surface: a group row carries whether its files all came from
  // outside the working directory, and whether the group is an unfinished delete.
  check('the list marks unfinished groups',
    (trash.payload?.groups ?? []).every(row => typeof row.recovery === 'boolean'))
  check('the list marks outside-only groups',
    (trash.payload?.groups ?? []).every(row => typeof row.outsideOnly === 'boolean'))

  // The switch is a patch: flipping it must leave the two numeric settings as
  // they were. It is restored afterwards so the suite does not leave the user's
  // sidebar without its entry.
  const before = trash.payload?.settings ?? {}
  const flipped = await post('/trash/settings', { showSidebarTrash: false })
  check('the switch can be written', flipped.status === 200, `status ${String(flipped.status)}`)
  equal('the switch reads back off', flipped.payload?.settings?.showSidebarTrash, false)
  equal('flipping it keeps the retention', flipped.payload?.settings?.retentionDays, before.retentionDays)
  equal('flipping it keeps the cap', flipped.payload?.settings?.maxBytes, before.maxBytes)
  const restored = await post('/trash/settings', { showSidebarTrash: before.showSidebarTrash !== false })
  equal('the switch is restored', restored.payload?.settings?.showSidebarTrash, before.showSidebarTrash !== false)
  equal('restoring it keeps the retention', restored.payload?.settings?.retentionDays, before.retentionDays)

  const hidden = await post('/hidden', {})
  check('the hidden route answers', hidden.status === 200)
  check('the hidden route returns rows', Array.isArray(hidden.payload?.rows))
  check('the hidden route reports a total', typeof hidden.payload?.total, 'number')
  const hiddenRow = hidden.payload?.rows?.[0]
  if (hiddenRow !== undefined) {
    check('a hidden row reports its origin', hiddenRow.origin === 'subagent')
    check('a hidden row reports its byte size', typeof hiddenRow.bytes, 'number')
  }

  // A scan against a row the Host reported proves the plan deriver runs on real
  // stored logs, including the per-file provenance the details panel shows.
  const target = hiddenRow?.sessionId
  if (typeof target === 'string') {
    const scan = await post('/scan', { sessionId: target })
    check('the scan route answers for a real hidden Session', scan.status === 200)
    check('the scan reports the Session origin', scan.payload?.origin === 'subagent')
    check('the scan reports its trash headroom', typeof scan.payload?.trash?.usedBytes, 'number')
    check('the scan reports a children list', Array.isArray(scan.payload?.children))
    check('the scan reports produced files', Array.isArray(scan.payload?.artifacts?.items))
    check('the scan reports referenced files', Array.isArray(scan.payload?.referenced?.items))
    // The contract a stale page depends on: whatever this Host reports as
    // referenced cannot be deleted, and it says so instead of leaving the reader
    // to discover it by watching nothing happen.
    check('the scan marks referenced files non-deletable',
      scan.payload?.referenced?.deletable === false)
    const firstFile = scan.payload?.artifacts?.items?.[0] ?? scan.payload?.referenced?.items?.[0]
    if (firstFile !== undefined) {
      check('a file row carries its source directory', typeof firstFile.dir === 'string' && firstFile.dir !== '')
      check('a file row carries a stable id', /^a[0-9a-f]{12}$/.test(String(firstFile.id)))
      check('a file row carries provenance', Array.isArray(firstFile.sources))
    }
  }

  // A permanent delete without the acknowledgement must be refused. This is the
  // guard that keeps an irreversible request from being one forgotten flag away.
  const unconfirmed = await post('/purge', { sessionId: 'session-does-not-exist', permanent: true })
  check('an unconfirmed permanent delete is refused', unconfirmed.status !== 200)

  const deleted = await post('/trash/delete', { groupKeys: [] })
  check('a recycle-bin delete without confirmation is refused', deleted.status !== 200)

  // `requireOwnPage` is the only thing standing between another local page and a
  // deletion; the marker header must be load-bearing.
  const unmarked = await new Promise((resolve, reject) => {
    const parsed = new URL(`${base}/plugins/dsh-plugin-remover/api/trash/list`)
    const body = Buffer.from('{}', 'utf8')
    const request = httpRequest({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(body.byteLength) },
    }, (response) => {
      response.resume()
      resolve({ status: response.statusCode })
    })
    request.on('error', reject)
    request.write(body)
    request.end()
  })
  check('a request without the marker header is refused', unmarked.status !== 200)

  console.log(`\n${String(checks - failures)}/${String(checks)} checks passed`)
  if (failures > 0) process.exitCode = 1
}

await main()
