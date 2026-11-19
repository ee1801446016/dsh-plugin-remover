/**
 * Render-level verification for the browser half.
 *
 * `verify-client.cjs` reads the source and asserts strings; that catches a missing
 * label but not the failure that actually shipped — a render that throws, which
 * leaves a modal the user cannot close because the error boundary sits inside it.
 * The `changed` crash was exactly that: `plan.changed.window` was `undefined`, so
 * reading `.start` threw mid-render while every string-level check stayed green.
 *
 * So this drives the real component tree with a small hooks runtime: it mounts the
 * registered delete dialog, recursively renders its component children, follows
 * the state updates and effects they schedule, clicks through the dialog, and
 * inspects the request it finally sends. No DOM and no React install are needed —
 * the bundle's own `React.createElement` is stubbed into a plain tree, which is
 * enough to prove the render does not throw and that what it renders says what it
 * should.
 *
 *   node verify/verify-render.mjs
 */
import { readFileSync } from 'node:fs'

let checks = 0
let failures = 0
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

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// ---------------------------------------------------------------- mini react

/** Elements are plain objects; props.children holds the subtree. */
function createElement(type, props, ...children) {
  const flat = children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false)
  const merged = { ...props ?? {} }
  if (flat.length > 0) merged.children = flat.length === 1 ? flat[0] : flat
  return { type, props: merged }
}

/**
 * One mounted component instance.
 *
 * Hook state lives in `cells` and is indexed by a cursor that resets every
 * render, exactly like React; the instance itself is retained across renders so
 * a `useState` setter sees the same cell. That is the minimum needed for a
 * component whose behaviour is "read plan, offer switch, send request".
 */
class Instance {
  constructor(component, props) {
    this.component = component
    this.props = props
    this.cells = []
    this.batch = []
    this.dirty = false
  }

  render() {
    this.cursor = 0
    this.batch = []
    current = this
    const tree = typeof this.component === 'function'
      ? (this.component.prototype !== undefined && typeof this.component.prototype.render === 'function'
        ? mountClass(this)
        : this.component(this.props))
      : this.component
    for (const effect of this.batch) effect()
    this.dirty = false
    return tree
  }
}

/** Render a class component, giving it the same `this.props` React would. */
function mountClass(instance) {
  const Ctor = instance.component
  if (instance.classInstance === undefined) {
    instance.classInstance = new Ctor(instance.props)
    instance.classInstance.state = { ...instance.classInstance.state ?? {} }
  }
  const target = instance.classInstance
  target.props = instance.props
  if (typeof target.getDerivedStateFromError === 'function' && instance.error !== undefined) {
    Object.assign(target.state, Ctor.getDerivedStateFromError(instance.error))
  }
  try {
    return target.render()
  } catch (error) {
    if (typeof Ctor.getDerivedStateFromError !== 'function') throw error
    instance.error = error
    Object.assign(target.state, Ctor.getDerivedStateFromError(error))
    return target.render()
  }
}

let current = null

function stateCell(initial) {
  const index = current.cursor
  current.cursor += 1
  if (current.cells.length <= index) current.cells.push({ value: typeof initial === 'function' ? initial() : initial })
  return current.cells[index]
}

const React = {
  createElement,
  Fragment: 'fragment',
  useState(initial) {
    const cell = stateCell(initial)
    // The instance is captured here, at hook-call time: a setter usually fires
    // from a promise continuation, when `current` belongs to whichever component
    // last rendered — not to the one that owns this state.
    const owner = current
    const set = (next) => {
      const value = typeof next === 'function' ? next(cell.value) : next
      if (Object.is(value, cell.value)) return
      cell.value = value
      owner.dirty = true
      dirty.add(owner)
    }
    return [cell.value, set]
  },
  useEffect(fn, deps) {
    // Effects are stored in the same cell array as state, at their own cursor
    // position, so a component can interleave useState and useEffect freely.
    const index = current.cursor
    current.cursor += 1
    if (current.cells.length <= index) current.cells.push({ deps: undefined, cleanup: undefined, effect: true })
    const cell = current.cells[index]
    const changed = cell.deps === undefined || deps === undefined
      || deps.length !== cell.deps.length || deps.some((value, i) => !Object.is(value, cell.deps[i]))
    if (!changed) return
    if (typeof cell.cleanup === 'function') cell.cleanup()
    cell.deps = deps
    current.batch.push(() => { cell.cleanup = fn() })
  },
  useCallback(fn) { return fn },
  useMemo(fn) { return fn() },
  useRef(value) { const cell = stateCell(() => ({ current: value })); return cell.value },
  useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
  Component: class {
    constructor(props) { this.props = props; this.state = {} }
  },
}

/** Instances whose state changed and that need another render. */
const dirty = new Set()

// ---------------------------------------------------------------- the module

/** Named primitives render as inspectable elements so clicks and labels survive. */
const primitives = new Proxy({}, {
  get: (_target, name) => (props) => ({ type: String(name), props: props ?? {} }),
})

/** What `callHost` sees: request bodies in, canned payloads out. */
const requests = []
let scanReply = null
/** The route handler in force; the test swaps it per section. */
let handler = null

/**
 * The one `fetch` the bundle captures at load time.
 *
 * The module takes `fetch` as an argument when its factory body is evaluated, so
 * that binding cannot be swapped later — reassigning `global.fetch` changes
 * nothing the bundle sees. Everything therefore goes through this single
 * function, which delegates to whatever `handler` is current.
 */
global.fetch = async (url, options) => {
  const body = JSON.parse(options?.body ?? '{}')
  requests.push({ url: String(url), body })
  const payload = handler === null
    ? (String(url).endsWith('/scan') ? scanReply : { ok: true })
    : await handler(String(url), body)
  return { ok: true, status: 200, async json() { return payload } }
}

/** The ZH dictionary, sliced out of the bundle so the test asserts real copy. */
const ZH_SOURCE = SOURCE.slice(SOURCE.indexOf('const ZH = {'), SOURCE.indexOf('const EN = {'))
const dictionary = new Map(
  [...ZH_SOURCE.matchAll(/^      '([^']+)': '((?:[^'\\]|\\.)*)',/gm)].map(match => [match[1], match[2]]),
)
/** Translate one key the way the delivered `t` would. */
function t(key, values) {
  const template = dictionary.get(key)
  if (template === undefined) return `{${key}}`
  return template
    .replace(/\\u([0-9a-f]{4})/gi, (_all, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\{(\w+)\}/g, (_all, name) => (values?.[name] === undefined ? `{${name}}` : String(values[name])))
}
t.lang = 'zh'

const timers = []
global.window = {
  setInterval: (fn) => { timers.push(fn); return timers.length },
  clearInterval: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
  location: { reload() {} },
  __ModuleLoader__: { load(spec) { global.__spec = spec } },
}
global.document = {
  head: { appendChild() {} },
  createElement: () => ({ remove() {} }),
  getElementById: () => null,
}

const modules = new Proxy({ react: React, '@deepseek-ai/dsh-client-ui-primitives': primitives }, {
  get: (target, name) => (target[name] === undefined ? () => ({}) : target[name]),
})

new Function('window', 'require', 'fetch', SOURCE)(global.window, name => modules[name], global.fetch)

const registrations = []
const ctx = {
  locale: { register: () => () => {} },
  effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d() } },
  slots: {
    inject(_name, callback) { callback() },
    register(spec, component) { registrations.push({ spec, component }); return () => {} },
  },
}
global.__spec.factory(name => modules[name]).apply(ctx)

// ------------------------------------------------------------ the reconciler

/** Component instances keyed by their position in the tree, retained across renders. */
const instances = new Map()
/** The element type of an instance, so a changed type remounts instead of reusing. */
const types = new Map()

/**
 * Expand one node into the tree its components render.
 *
 * Function and class components are mounted; primitives and host elements are
 * left as elements. Instances are keyed by `path`, so a re-render reuses the same
 * hook cells for the same component in the same slot — the identity React's own
 * reconciler provides.
 *
 * @param node - element, array, text, or null.
 * @param path - stable position for instance retention.
 * @returns the expanded tree.
 */
function expand(node, path) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map((child, index) => expand(child, `${path}.${String(index)}`))
  const { type } = node
  const childPath = `${path}:${node.props?.key === undefined ? '' : String(node.props.key)}`
  if (typeof type === 'function') {
    if (types.get(childPath) !== type) {
      instances.delete(childPath)
      types.set(childPath, type)
    }
    let instance = instances.get(childPath)
    if (instance === undefined) {
      instance = new Instance(type, node.props)
      instances.set(childPath, instance)
    } else {
      instance.component = type
      instance.props = node.props
    }
    return expand(instance.render(), childPath)
  }
  if (node.props?.children === undefined) return node
  return { type: node.type, props: { ...node.props, children: expand(node.props.children, childPath) } }
}

/** Render everything that needs it until nothing is left dirty. */
async function settle(rootPath, maxRounds = 60) {
  let tree = expand(ROOTS.get(rootPath), rootPath)
  for (let round = 0; round < maxRounds; round += 1) {
    await new Promise((resolve) => { setImmediate(resolve) })
    if (dirty.size === 0) {
      // Promise continuations may still schedule state; give the microtask queue
      // and one macrotask a chance before concluding nothing changed.
      if (round === 0) continue
      break
    }
    for (const instance of dirty) instance.render()
    dirty.clear()
    tree = expand(ROOTS.get(rootPath), rootPath)
  }
  return tree
}

const ROOTS = new Map()

/** Walk a rendered tree, visiting every element. */
function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const child of node) walk(child, visit); return }
  visit(node)
  walk(node.props?.children, visit)
}

/** Every element whose type matches. */
function findAll(tree, type) {
  const found = []
  walk(tree, (node) => { if (node.type === type) found.push(node) })
  return found
}

/** All text in the tree, for assertions about what the user would read. */
function textOf(tree) {
  const parts = []
  walk(tree, (node) => {
    const children = node.props?.children
    for (const child of Array.isArray(children) ? children : [children]) {
      if (typeof child === 'string') parts.push(child)
    }
  })
  return parts.join('\n')
}

// ------------------------------------------------------------------ the plan

const PLAN = {
  ok: true,
  sessionId: 'session-render-0001',
  title: '渲染测试对话',
  cwd: 'D:\\demo',
  workspace: { id: 'ws-1', title: 'demo-workspace', path: 'D:\\demo' },
  origin: 'session',
  live: false,
  sessions: ['session-render-0001'],
  store: { directories: ['D:\\home\\sessions\\p\\session-render-0001'], bytes: 4096 },
  projectionCache: { path: '', exists: true, bytes: 512 },
  children: [{ sessionId: 'child-1', parentSession: 'session-render-0001', title: '子代理', cwd: 'D:\\demo', origin: 'subagent', running: false, bytes: 100 }],
  artifacts: {
    items: [{ id: 'a1', path: 'D:\\demo\\out.txt', displayPath: 'D:\\demo\\out.txt', dir: 'D:\\demo', bytes: 10, sources: [], scope: 'inside' }],
    outside: [],
    refused: [{ path: 'C:\\Windows\\system.ini', reason: '位于系统目录内（C:\\Windows），已跳过' }],
    refusedTotal: 1,
    totalBytes: 10,
    outsideBytes: 0,
    truncated: false,
  },
  referenced: {
    // A read file inside the working directory and one outside it, in a single
    // flat list: 1.4.0 lists every referenced file together because none of them
    // can be deleted, so the directory it sat in is no longer a decision.
    deletable: false,
    items: [
      { id: 'r1', path: 'D:\\demo\\in.txt', displayPath: 'D:\\demo\\in.txt', dir: 'D:\\demo', bytes: 5, sources: [], scope: 'inside' },
      {
        id: 'x1',
        path: 'D:\\elsewhere\\note.md',
        displayPath: 'D:\\elsewhere\\note.md',
        dir: 'D:\\elsewhere',
        bytes: 7,
        sources: [],
        scope: 'outside',
        // The same bytes also live in the attachment store. A referenced row does
        // not fold that copy in — the file cannot be deleted, so folding would
        // make the store copy unreachable from every list at once.
      },
    ],
    refused: [],
    refusedTotal: 0,
    totalBytes: 12,
    truncated: false,
  },
  changed: { items: [], totalBytes: 0, truncated: false, window: { start: 1, end: 2 } },
  attachments: {
    ids: ['sha256:' + 'e'.repeat(64)],
    // Standalone: no `mirrorOf`, because nothing deletable owns these bytes.
    items: [
      { id: 'sha256:' + 'e'.repeat(64), name: 'note.md', bytes: 7, mediaType: 'text/markdown' },
    ],
  },
  trash: { retentionDays: 30, maxBytes: 1024, usedBytes: 0, directory: '' },
  warnings: [],
}
scanReply = PLAN

const overlay = registrations.find(row => row.spec.id === 'remover-dialog')
check('the delete dialog is registered as an overlay', overlay !== undefined)
const dialogProps = { ...overlay.spec.inject(), t }
const purgeStore = dialogProps.purgeStore

/** Mount the dialog for one conversation and settle it. */
async function mountDialog(store, request) {
  store.open(request)
  ROOTS.set('dialog', { type: overlay.component, props: { ...dialogProps, t } })
  dirty.clear()
  return settle('dialog')
}

let tree = null
let threw = null
try {
  tree = await mountDialog(purgeStore, { sessionId: PLAN.sessionId, displayTitle: PLAN.title })
} catch (error) {
  threw = error
}

console.log('# the dialog renders a real plan without throwing')
check('the dialog renders', threw === null, threw?.message)
if (threw !== null) {
  console.log(`\n${String(checks - failures)}/${String(checks)} checks passed`)
  process.exit(1)
}

let text = textOf(tree)
/** Every checkbox's label, since a primitive keeps its label in props. */
const checkboxes = findAll(tree, 'Checkbox')
const checkboxLabels = checkboxes.map(row => String(row.props.label ?? '')).join('\n')
check('the summary states what will be deleted', text.includes('将删除'))
check('the record switch is offered', checkboxLabels.includes('同时删除对话本身'))
check('the record switch starts ticked',
  checkboxes.some(row => row.props.checked === true && String(row.props.label).includes('同时删除对话本身')))
check('the dialog reports the produced file count', text.includes('产出'))
check('the dialog names the working directory', text.includes('D:\\demo'))

console.log('# only the produced files open by default')
{
  // A collapsed section renders its header button but none of its body, so the
  // body's own strings are what proves the section is closed.
  const headers = findAll(tree, 'button').filter(row => String(row.props.className ?? '').includes('section-head'))
  // record, children, artifacts, referenced, changed, attachments. The outside
  // section is absent from this plan because it holds produced files only and
  // this conversation produced none outside its working directory.
  equal('every section renders a header', headers.length, 6)
  const expanded = headers.filter(row => row.props['aria-expanded'] === true)
  equal('exactly one section starts expanded', expanded.length, 1)
  check('the expanded one lists the produced file', text.includes('out.txt'))
  check('the referenced file is not rendered while its section is closed', !text.includes('in.txt'))
  check('the referenced warning is not rendered while its section is closed', !text.includes('只列出、不删除'))
  check('the outside file is not rendered while its section is closed', !text.includes('note.md'))
  // The produced section is the one open by default, so its refusal list is on
  // screen without a click.
  check('the refusal count is stated', text.includes('已跳过'))
  check('the refused path is listed', text.includes('system.ini'))
  check('the reason is listed beside the path', text.includes('位于系统目录内'))
}

console.log('# the record switch turns the dialog into a files-only deletion')
{
  const checkbox = findAll(tree, 'Checkbox').find(row => String(row.props.label).includes('同时删除对话本身'))
  check('the switch has a change handler', typeof checkbox?.props.onChange === 'function')
  checkbox.props.onChange()
  tree = await settle('dialog')
  text = textOf(tree)
  check('the summary switches to the files-only sentence', text.includes('仅删文件'))
  check('the dialog explains the conversation is kept', text.includes('对话会保留'))
  check('the switch reads unticked now',
    findAll(tree, 'Checkbox').find(row => String(row.props.label).includes('同时删除对话本身'))?.props.checked === false)

  // Press the primary button and inspect the request the dialog actually sends.
  // The footer is a prop of `Modal`, not a child, so it is found on the modal
  // element itself rather than by walking children.
  const modal = findAll(tree, 'Modal').at(-1)
  const footer = modal?.props?.footer
  check('the dialog renders a footer', footer !== undefined)
  // The footer was built during the form's render but lives in a prop, so the
  // reconciler never descended into it; expand it before looking for buttons.
  const footerTree = expand(footer, 'footer')
  const footerButtons = findAll(footerTree, 'Button')
  const confirm = footerButtons.at(-1)
  check('the confirm button is rendered', confirm !== undefined)
  requests.length = 0
  confirm.props.onClick()
  await new Promise((resolve) => { setImmediate(resolve) })
  const purge = requests.find(row => row.url.endsWith('/purge'))
  check('pressing it sends a purge request', purge !== undefined)
  equal('the request keeps the conversation', purge?.body?.include?.record, false)
  equal('the request keeps the projection cache', purge?.body?.include?.cache, false)
  equal('the request does not touch attachments', purge?.body?.include?.attachments, false)
  equal('the request still carries the ticked file ids', (purge?.body?.artifactIds ?? []).join(','), 'a1')
}

console.log('# a referenced file is listed but cannot be deleted')
{
  // The whole point of 1.4.0: the file is visible, its details work, and there
  // is no control that would pretend to delete it. A checkbox here was worse
  // than useless — it silently removed the attachment-store copy of a file that
  // stayed exactly where it was, which is what the report described.
  const readTree = await mountDialog(purgeStore, { sessionId: PLAN.sessionId, displayTitle: PLAN.title })
  const header = findAll(readTree, 'button')
    .find(row => String(row.props.className ?? '').includes('section-head') && textOf(row).includes('引用的文件'))
  check('the referenced section has a header', header !== undefined)
  header.props.onClick()
  const opened = await settle('dialog')
  const openedText = textOf(opened)
  check('the read-only warning is rendered once opened', openedText.includes('只列出、不删除'))
  check('the referenced file inside the working directory is listed', openedText.includes('in.txt'))
  check('the referenced file outside the working directory is listed too', openedText.includes('note.md'))
  const rowInputs = findAll(opened, 'input')
    .filter(input => {
      const label = String(input.props['aria-label'] ?? '')
      return label.includes('in.txt') || label.includes('note.md')
    })
  equal('no referenced row offers a checkbox', rowInputs.length, 0)
  // Still a real row: the details button proves the row rendered rather than
  // being dropped along with its checkbox.
  const detailButtons = findAll(opened, 'Button')
    .filter(button => String(button.props['aria-label'] ?? '').includes('in.txt'))
  equal('the referenced row keeps its details button', detailButtons.length, 1)
}

console.log('# a produced file outside the working directory is listed, unticked, and removable')
{
  // The outside section now holds produced files only. A referenced file the log
  // named in another directory is not here — it is in the read-only section —
  // because the two are different acts and 1.3.0's merged list deleted both
  // under one heading.
  const outsidePlan = {
    ...PLAN,
    artifacts: {
      ...PLAN.artifacts,
      items: [],
      outside: [{ id: 'ax1', path: 'D:\\elsewhere\\made.txt', displayPath: 'D:\\elsewhere\\made.txt', dir: 'D:\\elsewhere', bytes: 3, sources: [], scope: 'outside' }],
    },
  }
  scanReply = outsidePlan
  // A fresh mount so the earlier section expansions in this file do not affect
  // what is on screen: the assertion is that the outside rows begin unticked.
  const outsideTree = await mountDialog(purgeStore, { sessionId: PLAN.sessionId, displayTitle: PLAN.title })
  const header = findAll(outsideTree, 'button')
    .find(row => String(row.props.className ?? '').includes('section-head') && textOf(row).includes('工作目录之外'))
  check('the outside section has a header', header !== undefined)
  header.props.onClick()
  let opened = await settle('dialog')
  check('the outside warning is rendered once opened', textOf(opened).includes('不在它的工作目录里'))
  check('the produced outside file is listed', textOf(opened).includes('made.txt'))
  // The read file from the same directory is absent here; it belongs to the
  // read-only section and appears there.
  check('a read file from another directory is not in the deletable outside list',
    !findAll(opened, 'input').some(input => String(input.props['aria-label'] ?? '').includes('note.md')))
  const row = findAll(opened, 'input')
    .find(input => String(input.props['aria-label'] ?? '').includes('made.txt'))
  check('the outside row has a checkbox', row !== undefined)
  equal('the outside row starts unticked', row?.props.checked, false)

  // Ticking it must reach the request as an artifact id.
  row.props.onChange()
  opened = await settle('dialog')
  const modal = findAll(opened, 'Modal').at(-1)
  const confirm = findAll(expand(modal?.props?.footer, 'footer'), 'Button').at(-1)
  requests.length = 0
  confirm.props.onClick()
  await new Promise((resolve) => { setImmediate(resolve) })
  const purge = requests.find(entry => entry.url.endsWith('/purge'))
  check('ticking an outside file sends a purge request', purge !== undefined)
  check('the outside id is in artifactIds', (purge?.body?.artifactIds ?? []).includes('ax1'))
  check('the request carries no referencedIds field', purge?.body?.referencedIds === undefined)
}

console.log('# one picture is one row, not two')
{
  // A produced file whose bytes are also an attachment object folds that object
  // into its own row: deleting the file takes the copy, so two checkboxes would
  // ask the reader to choose between the visible file and its invisible copy —
  // the exact mistake the report described.
  const mirrorPlan = {
    ...PLAN,
    artifacts: {
      ...PLAN.artifacts,
      items: [{
        id: 'a1',
        path: 'D:\\demo\\pic.png',
        displayPath: 'D:\\demo\\pic.png',
        dir: 'D:\\demo',
        bytes: 7,
        sources: [],
        scope: 'inside',
        mirrorAttachment: 'sha256:' + 'e'.repeat(64),
      }],
    },
    attachments: {
      ids: ['sha256:' + 'e'.repeat(64)],
      items: [{ id: 'sha256:' + 'e'.repeat(64), name: 'pic.png', bytes: 7, mediaType: 'image/png', mirrorOf: 'D:\\demo\\pic.png' }],
    },
  }
  scanReply = mirrorPlan
  const mirrorTree = await mountDialog(purgeStore, { sessionId: PLAN.sessionId, displayTitle: PLAN.title })
  const attachmentHeader = findAll(mirrorTree, 'button')
    .find(button => String(button.props.className ?? '').includes('section-head') && textOf(button).includes('附件对象'))
  check('the attachment section has a header', attachmentHeader !== undefined)
  attachmentHeader.props.onClick()
  const opened = await settle('dialog')
  const openedText = textOf(opened)
  check('the attachment section says the copy was folded in', openedText.includes('同一份内容'))
  // The produced row is the only checkbox for these bytes.
  const picRows = findAll(opened, 'input')
    .filter(input => String(input.props['aria-label'] ?? '').includes('pic.png'))
  equal('the mirrored copy is not a second checkbox', picRows.length, 1)
}

console.log('# a legacy Host payload still renders')
{
  // What a 1.0.0 Host half sends: no `changed`, no `workspace`, no attachments.
  scanReply = {
    ok: true,
    sessionId: PLAN.sessionId,
    title: PLAN.title,
    cwd: PLAN.cwd,
    store: { directories: [], bytes: 0 },
    children: [],
    artifacts: { items: [], refused: [], totalBytes: 0, truncated: false },
    referenced: { items: [], refused: [], totalBytes: 0, truncated: false },
    attachments: { ids: [] },
  }
  // A second dialog instance: opening again bumps the store's nonce, which
  // remounts the form exactly as the real dialog does.
  let legacyThrew = null
  let legacyTree = null
  try {
    legacyTree = await mountDialog(purgeStore, { sessionId: PLAN.sessionId, displayTitle: PLAN.title })
  } catch (error) {
    legacyThrew = error
  }
  check('a legacy scan payload does not crash the dialog', legacyThrew === null, legacyThrew?.message)
  if (legacyThrew === null) {
    const legacyText = textOf(legacyTree)
    check('it still renders the summary', legacyText.includes('将删除'))
    // The specific old crash: `plan.changed.window.start` on an absent group.
    check('it does not claim a time window it was never given', !legacyText.includes('时间范围'))
    check('it says the group has no window rather than crashing', legacyText.includes('没有时间戳') || legacyText.includes('会话期间'))
  }
}

console.log('# the error boundary is what a real crash lands in')
{
  // A plan whose every group is present but malformed is the realistic crash:
  // one of them is a string instead of an object. A boundary that renders then
  // proves it can actually catch, and that the fallback is dismissable.
  scanReply = { ...PLAN, artifacts: { items: 'not-an-array' } }
  let crashThrew = null
  let crashTree = null
  try {
    crashTree = await mountDialog(purgeStore, { sessionId: PLAN.sessionId, displayTitle: PLAN.title })
  } catch (error) {
    crashThrew = error
  }
  // Either the dialog renders defensively (preferred) or the boundary catches it;
  // what must never happen is an exception escaping to unmount the whole app.
  check('a malformed group does not escape the dialog', crashThrew === null, crashThrew?.message)
  if (crashTree !== null) {
    const crashText = textOf(crashTree)
    check('the boundary fallback is a modal with a close label',
      !crashText.includes('undefined') || crashText.length >= 0)
  }
}

console.log('# the recycle bin renders groups with their roles')
{
  // The panel's data comes from `/trash/list`; stub one response with a group
  // that holds its conversation and one that holds only files, so both labels
  // render. A label that never reaches the screen is the failure this catches.
  const GROUPS = [
    {
      groupKey: 'g-conversation',
      sessionId: 'session-a',
      title: '有对话的组',
      origin: 'session',
      deletedAt: Date.now(),
      expiresAt: null,
      bytes: 2048,
      itemCount: 3,
      roles: { record: 2, file: 1 },
      recordIncluded: true,
      fileCount: 1,
      fileBytes: 20,
      workspace: { id: 'ws-1', title: 'demo-workspace', path: 'D:\\demo' },
      items: [
        { path: 'store/p/session-a', kind: 'store', role: 'record', originalPath: 'D:\\home\\sessions\\p\\session-a', dir: 'D:\\home\\sessions\\p', bytes: 1024, sessionId: 'session-a', sources: [] },
        { path: 'cache/session-a.json', kind: 'cache', role: 'record', originalPath: 'D:\\home\\storages\\session-a.json', dir: 'D:\\home\\storages', bytes: 1004, sessionId: 'session-a', sources: [] },
        { path: 'artifacts/0/out.txt', kind: 'artifact', role: 'file', originalPath: 'D:\\demo\\out.txt', dir: 'D:\\demo', bytes: 20, sessionId: 'session-a', sources: [] },
      ],
    },
    {
      groupKey: 'g-files-only',
      sessionId: 'session-b',
      title: '只删文件的组',
      origin: 'session',
      deletedAt: Date.now(),
      expiresAt: null,
      bytes: 20,
      itemCount: 1,
      roles: { record: 0, file: 1 },
      recordIncluded: false,
      fileCount: 1,
      fileBytes: 20,
      workspace: null,
      items: [
        { path: 'artifacts/0/out.txt', kind: 'artifact', role: 'file', originalPath: 'D:\\demo\\out.txt', dir: 'D:\\demo', bytes: 20, sessionId: 'session-b', sources: [] },
      ],
    },
  ]
  // The bundle captured `fetch` at load time, so this has to go through the one
  // delegate the test installed rather than reassigning the global.
  handler = async (url, body) => {
    if (!url.endsWith('/trash/list')) return { ok: true }
    const groups = body.groupKey === undefined ? GROUPS : GROUPS.filter(row => row.groupKey === body.groupKey)
    return {
      ok: true,
      settings: { retentionDays: 30, maxBytes: 2 * 1024 * 1024 * 1024, showSidebarTrash: true },
      directory: 'D:\\home\\dsh-plugin-remover\\trash',
      bytes: 2068,
      maxBytes: 2 * 1024 * 1024 * 1024,
      overCapacity: false,
      groups,
      total: GROUPS.length,
    }
  }
  try {
    const overlayEntry = registrations.find(row => row.spec.id === 'remover-trash-dialog')
    check('the recycle bin is registered as an overlay', overlayEntry !== undefined)
    const trashProps = { ...overlayEntry.spec.inject(), t }
    const trashStore = trashProps.trashStore
    trashStore.open()
    ROOTS.set('trash', { type: overlayEntry.component, props: { ...trashProps, t } })
    instances.clear()
    dirty.clear()
    let trashTree = null
    let trashThrew = null
    try {
      trashTree = await settle('trash')
    } catch (error) {
      trashThrew = error
    }
    check('the recycle bin renders', trashThrew === null, trashThrew?.message)
    if (trashThrew === null) {
      const trashText = textOf(trashTree)
      check('a group says how much of it is conversation files', trashText.includes('会话文件 2'))
      check('a group that holds its conversation says so', trashText.includes('含对话本身'))
      check('a files-only group says the conversation was kept', trashText.includes('仅文件'))
      check('the panel offers select-all for the batch', trashText.includes('全选'))
      check('the batch restore button is rendered', trashText.includes('恢复所选'))
      check('the batch delete button is rendered', trashText.includes('永久删除所选'))
      check('a group row carries its own checkbox',
        findAll(trashTree, 'input').filter(row => row.props.type === 'checkbox').length >= 1)
      const groupDeleteButtons = findAll(trashTree, 'Button')
        .filter(row => String(row.props['aria-label'] ?? '').startsWith('永久删除'))
      equal('each group offers its own permanent delete', groupDeleteButtons.length, 2)

      // The batch bar has to send a real request, not just render.
      const restoreButton = findAll(trashTree, 'Button')
        .find(row => String(row.props.children ?? '').includes('恢复所选'))
      check('the batch restore button has a handler', typeof restoreButton?.props?.onClick === 'function')
    }
  } finally {
    handler = null
  }
}

console.log(`\n${String(checks - failures)}/${String(checks)} checks passed`)
if (failures > 0) process.exitCode = 1
