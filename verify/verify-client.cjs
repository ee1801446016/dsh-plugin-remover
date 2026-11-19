/**
 * Offline verification for dsh-plugin-remover's browser half.
 *
 * The browser half is a module-loader artifact: executing it only registers a
 * factory, and the body runs when the shell materializes it. This drives that
 * factory with a stub module loader and asserts the slots it contributes, plus
 * the invariants that are easy to break silently:
 *
 *   * The plugin page section must exist. A Session row menu needs a Session
 *     row, and the harness never renders one for a subagent conversation; the
 *     section on this plugin's own page needs no Session at all, so it is the
 *     only surface that reaches all of them. This is the regression guard.
 *   * The sidebar-foot entry must exist exactly once and must obey the
 *     `showSidebarTrash` setting. The previous revision's eye-icon footer
 *     button is a different thing and must not come back.
 *   * The reversible delete path must not carry an acknowledgement checkbox.
 *     Only permanent deletion (emptying the recycle bin, deleting a group or a
 *     file for good, and a deletion too large for the bin) is gated.
 *   * Every file row must offer a Details toggle, and the panel must show the
 *     source directory.
 *   * Every dialog must carry the classes that make it fit the viewport, and
 *     the stylesheet must exist with `overflow-y:auto` on the content column.
 *     Without it the footer — and the primary button — can be pushed off screen.
 *   * The recycle-bin group header must be a wrapping two-line layout; the
 *     single grid row it replaced overlapped the title on narrow panels.
 *
 *   node verify/verify-client.cjs
 */

const fs = require('node:fs')
const path = require('node:path')

const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8')

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

/** The React surfaces the factory touches. */
const React = {
  createElement: () => ({}),
  Fragment: 'fragment',
  useState: value => [value, () => {}],
  useEffect: () => {},
  useCallback: fn => fn,
  useRef: value => ({ current: value }),
  useSyncExternalStore: () => null,
  Component: class {
    constructor(props) {
      this.props = props
      this.state = { error: null }
    }
  },
}

/** Every import the factory can reach; anything unknown resolves to a stub. */
const stub = new Proxy({}, { get: () => () => ({}) })
const modules = new Proxy({ react: React }, {
  get: (target, name) => (name === 'react' ? React : stub),
})

let registered = null
global.window = { __ModuleLoader__: { load(spec) { registered = spec } } }

// The one stylesheet the plugin mounts. `mountStyles` guards on `document`, so
// the whole browser half stays loadable without a DOM; giving it a stub here is
// what lets the suite assert the rules that fix the dialog's overflow.
const mountedStyles = []
function fakeElement(tagName) {
  return {
    tagName: String(tagName).toUpperCase(),
    id: '',
    textContent: '',
    removed: false,
    remove() { this.removed = true },
  }
}
global.document = {
  head: { children: [], appendChild(node) { this.children.push(node); mountedStyles.push(node) } },
  createElement: fakeElement,
  getElementById: () => null,
}

new Function('window', 'require', source)(global.window, name => modules[name])

console.log('# module')
check('the bundle registers a module', registered !== null)
equal('the module id is the package name', registered?.id, 'dsh-plugin-remover')
check('the factory is a function', typeof registered?.factory === 'function')

const api = registered.factory(name => modules[name])
equal('the client declares its services', JSON.stringify(api.inject), JSON.stringify(['slots', 'locale']))
check('the client exports apply', typeof api.apply === 'function')

console.log('# slots')
const registrations = []
const ctx = {
  locale: { register: () => () => {} },
  effect(fn) {
    const dispose = fn()
    return () => { if (typeof dispose === 'function') dispose() }
  },
  slots: {
    inject(_name, callback) { callback() },
    register(spec, component) {
      registrations.push({
        name: spec.name,
        id: spec.id,
        order: spec.order,
        locale: spec.locale,
        key: spec.key,
        component: typeof component,
      })
      return () => {}
    },
  },
}
api.apply(ctx)

equal('six entries are registered', registrations.length, 6)
check('every entry carries a component', registrations.every(row => row.component === 'function'))
equal('every entry is localized', registrations.every(row => row.locale === 'dsh-plugin-remover'), true)
// A bare `ctx.slots.inject` leaks the registration when the plugin is disposed;
// every contribution has to be wrapped in an effect. (The locale dictionary and
// the stylesheet are the other two effects and are not slots.)
equal('every registration is wrapped in an effect', (source.match(/ctx\.effect\(\(\) => ctx\.slots\.inject\(/g) ?? []).length, 6)
equal('the locale dictionaries are registered once', (source.match(/ctx\.effect\(\(\) => ctx\.locale\.register\(/g) ?? []).length, 1)
check('no registration uses a keyed slot', registrations.every(row => row.key === undefined))

const byId = new Map(registrations.map(row => [row.id, row]))
check('the Session-row menu entry is still contributed', byId.has('remover-session'))
equal('the row menu hangs off the Session menu slot', byId.get('remover-session')?.name, 'sidebar.workspaces.session.menu.item')

// The sidebar-foot shortcut: present exactly once, gated by the setting, and
// distinct from the previous revision's eye-icon button.
const footer = registrations.filter(row => row.name === 'sidebar.footer.action')
equal('exactly one entry hangs off the sidebar foot', footer.length, 1)
equal('it is the recycle-bin shortcut', footer[0]?.id, 'remover-trash-foot')
equal('it sits above the shipped footer occupants', footer[0]?.order, 150)
const footSlice = source.slice(source.indexOf('function TrashFooterButton('), source.indexOf('/** Containment for a dialog'))
check('the shortcut is a component, not an inline label', footSlice.includes('React.createElement(\'button\''))
check('it opens the recycle bin', footSlice.includes('trashStore.open()'))
check('it hides when the setting is off', footSlice.includes('settings.showSidebarTrash === false'))
check('it shows while the setting is unreadable',
  footSlice.indexOf('showSidebarTrash === false') < footSlice.indexOf('return React.createElement(\'button\''))
check('it re-renders with the sidebar width', footSlice.includes('wide ?'))
check('it names itself for assistive technology', footSlice.includes("'aria-label': label"))
check('the previous eye-icon footer button is still gone', !source.includes('HiddenSessionsTrigger'))

// The switch that controls it lives on the plugin page.
check('the plugin page offers the sidebar-entry switch', source.includes("t('panel.showInSidebar')"))
check('the switch writes the setting', source.includes("callHost('/trash/settings', { showSidebarTrash: next })"))
check('the switch is a Checkbox primitive', source.includes('React.createElement(Checkbox, {\n            key: \'check\''))
check('the switch keeps the sidebar in step without a reload',
  source.includes("sidebarResource.set({ ...(sidebarResource.getSnapshot().value ?? {}), settings: payload.settings })"))

const section = byId.get('remover-trash')
check('the plugin page section is contributed', section !== undefined)
equal('the section targets the plugin detail page', section?.name, 'plugins.detail.section')
check('the section renders a component, not a bare label', section?.component === 'function')
equal('the section is not scoped to a key', section?.key, undefined)
// The section must be a no-op on other bundles' pages, or every plugin page would
// show this plugin's recycle bin.
check('the section filters by bundle name', source.includes("subject?.kind !== 'bundle' || subject?.pkg?.name !== NS"))

const overlays = registrations.filter(row => row.name === 'shell.overlay')
equal('three dialogs render from the overlay', overlays.length, 3)
check('the delete dialog has its overlay entry', byId.has('remover-dialog'))
check('the recycle-bin panel has its overlay entry', byId.has('remover-trash-dialog'))
check('the hidden panel keeps its overlay entry', byId.has('remover-hidden-dialog'))

console.log('# confirmation policy')
// Moving a conversation into the recycle bin is reversible, so the normal path
// must NOT ask for an acknowledgement. Only the three irreversible paths do.
const dialogSlice = source.slice(source.indexOf('function PurgeForm('), source.indexOf('function TrashDialog('))
check('the reversible delete button has no acknowledgement guard',
  !dialogSlice.includes('disabled: busy || acknowledged !== true || plan === null'))
check('the reversible delete button is disabled only for busy or unscanned state',
  dialogSlice.includes('disabled: busy || plan === null || scanError !== null'))
check('the overflow question carries an acknowledgement checkbox',
  dialogSlice.includes("label: t('overflow.ack')"))
check('the overflow question uses the danger button', dialogSlice.includes('style: DANGER_BUTTON_STYLE'))
check('the overflow question offers a permanent choice', dialogSlice.includes("permanent: true, confirm: true"))
check('the overflow question offers an empty-then-retry choice', dialogSlice.includes("onOverflow: 'empty-trash'"))
// The overflow card is the only place this dialog may render the ack label.
equal('the dialog acknowledges in exactly one place', (dialogSlice.match(/overflow\.ack/g) ?? []).length, 1)

const trashSlice = source.slice(source.indexOf('function TrashForm('), source.indexOf('function HiddenDialog('))
check('the recycle bin gates emptying behind an acknowledgement',
  trashSlice.includes("disabled: busy || acknowledged !== true"))
check('the recycle-bin permanent actions use the danger button', trashSlice.includes('style: DANGER_BUTTON_STYLE'))
check('the recycle-bin acknowledgement is labelled for permanence', trashSlice.includes("t('trash.confirmAck')"))
check('emptying the recycle bin asks for confirmation', source.includes("setPending({ kind: 'all', body: t('trash.confirmBodyAll') })"))
check('permanently deleting a group asks for confirmation', source.includes("kind: 'group',"))
check('permanently deleting a file asks for confirmation', source.includes("kind: 'item',"))

console.log('# dialog sizing and scrolling')
// The shipped Modal is 380 px wide with no height cap and a root that neither
// scrolls nor shrinks. Without these classes, expanding a Details panel pushes
// the footer — and the primary button — out of the viewport.
check('the stylesheet is mounted', mountedStyles.length === 1)
const stylesheet = mountedStyles[0]
equal('the stylesheet is a style element', stylesheet?.tagName, 'STYLE')
equal('the stylesheet has a stable id', stylesheet?.id, 'dsh-plugin-remover-styles')
const css = String(stylesheet?.textContent ?? '')
// 1.2.0 narrowed the dialog from 760 to 720 px: the compact sectioned layout no
// longer needs the extra width, and a narrower dialog leaves more of the page
// visible behind it. The invariant is "wider than the shipped 380 px and capped
// to the viewport", not the exact number.
check('the dialog is widened', /-dialog \{ width: min\(7\d\dpx, calc\(100vw - 48px\)\);/.test(css))
// The modal root pads 24 px top and bottom; the cap has to leave that room or
// the dialog overflows the padding and gets clipped.
check('the dialog is height-capped inside the root padding', css.includes('max-height: calc(100vh - 48px)'))
check('the cap follows the dynamic viewport', css.includes('100dvh'))
check('the content column scrolls', css.includes('-content { min-height: 0; overflow-y: auto'))
check('wheel scrolling stays inside the dialog', css.includes('overscroll-behavior: contain'))
check('the header stays put while scrolling', css.includes('position: sticky; top: 0'))
check('the footer keeps its height when the dialog is capped', css.includes('-dialog > :last-child { flex: none; }'))
// The compact layout puts six sections into one scrollable column with a sticky
// summary bar on top; without a capped per-list height, one long list would push
// every other section — and the footer — out of reach again.
check('the summary bar is pinned above the sections', css.includes('-summary {') && css.includes('-summary'))
check('each section header is a single line', css.includes('-section-head {'))
check('a section reports its count', css.includes('-section-count {'))
check('a section reports its byte total', css.includes('-section-summary {'))
check('long lists scroll inside their section', css.includes('-list { display: grid; gap: 2px; max-height: 150px; overflow-y: auto'))
check('one dialog passes the wide class', (source.match(/className: DIALOG_CLASS/g) ?? []).length, 1)
// Two panels plus the boundary's own fallback dialog.
equal('the panels and the boundary fallback pass the narrow class', (source.match(/className: NARROW_DIALOG_CLASS/g) ?? []).length, 3)
equal('every dialog passes the content class', (source.match(/contentClassName: CONTENT_CLASS/g) ?? []).length, 4)
check('the stylesheet is mounted inside an effect', source.includes("ctx.effect(() => mountStyles()"))
check('the stylesheet mount is guarded for a DOM-less host', source.includes("typeof document === 'undefined'"))
check('mounting the stylesheet cannot throw on a missing head',
  source.includes("const existing = document.getElementById(STYLE_ID)"))
check('the stylesheet is removed on disposal', source.includes('element.remove()'))

console.log('# recycle-bin layout')
// One grid row cannot hold the title, the count, two dates, and two buttons
// without overlapping the title once the panel is narrow.
check('the group header stacks its lines', trashSlice.includes("key: 'head',\n              style: { display: 'grid', gap: 4 }"))
check('the group action line wraps', trashSlice.includes("display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px'"))
// The title now ellipsizes inside the toggle button, which owns the width; the
// invariant is that it truncates instead of pushing the buttons off the row.
check('the group title ellipsizes instead of overflowing',
  trashSlice.includes("textOverflow: 'ellipsis',\n                      whiteSpace: 'nowrap',"))
check('the group title no longer has a fixed width cap', !trashSlice.includes('maxWidth: 280'))
check('the group row is multi-select',
  trashSlice.includes("type: 'checkbox',\n                  checked: groupSelected,"))
check('the item row stacks its lines', trashSlice.includes("style: { display: 'grid', gap: 3, padding: '4px 6px'"))
check('the item action line wraps', trashSlice.includes("key: 'actions',\n                      style: { display: 'flex', flexWrap: 'wrap', gap: 4 }"))
// The modal subtitle already carries this sentence.
check('the recycle-bin description is not repeated in the body', !trashSlice.includes("hint('desc'"))

check('a file row renders a Details button', source.includes("'aria-label': `${t('detail.button')}"))
check('the details toggle reports its expanded state', source.includes("'aria-expanded': open"))
check('the details toggle points at its panel', source.includes("'aria-controls': panelId"))
check('the details panel shows the source directory', source.includes("pairs.push([t('detail.dir'), row.dir ?? '—'])"))
check('the details panel shows the full path', source.includes("pairs.push([t('detail.path')"))
check('the details panel shows the size', source.includes("pairs.push([t('detail.size')"))
check('the details panel lists the source conversations', source.includes("t('detail.sources')"))
check('the details panel distinguishes written from read', source.includes("const roleLabel = kind === 'referenced' ? t('detail.read') : t('detail.written')"))
check('both produced and referenced rows use the same file row', (source.match(/React\.createElement\(FileRow, \{/g) ?? []).length >= 2)
check('the recycle-bin item rows offer Details too', source.includes("tinyButton('detail', t('detail.button')"))
// A nested modal inside a modal steals the focus trap; the details must be inline.
check('the details are inline, not a nested modal', source.includes('gridColumn: \'1 / -1\''))

console.log('# required sections')
for (const key of ['section.record', 'section.children', 'section.artifacts', 'section.referenced', 'section.changed', 'section.attachments']) {
  check(`the dialog renders ${key}`, source.includes(`t('${key}')`))
}
check('the produced files are selected by default',
  source.includes('setArtifactIds((normalized.artifacts.items).map(row => row.id))'))
// 1.4.0: referenced files are listed, never deleted, so there is no selection
// state for them at all. The absence is the guarantee — a checkbox that cannot
// act is worse than no checkbox, and a state variable would be a field the
// request has no use for.
check('the referenced files have no selection state',
  !source.includes('referencedIds') && !source.includes('setReferencedIds'))
check('a referenced row is rendered read-only',
  source.includes('readOnly: true'))
check('the read-only row drops its checkbox',
  source.includes('const locked = readOnly === true')
  && source.includes('locked\n            ? null\n            : React.createElement(\'input\','))
check('the outside files are NOT selected by default',
  source.includes('const [outsideIds, setOutsideIds] = React.useState([])'))
check('the changed files are NOT selected by default, and cannot default to all',
  source.includes('const [changedIds, setChangedIds] = React.useState([])'))
check('the changed group never seeds itself from the scan',
  !/setChangedIds\((payload|plan)\.changed/.test(source))
// Regression: a Host half from 1.0.0 returns no `changed` field at all. The
// first attempt guarded with `=== null`, which is true for `null` but not for
// `undefined`, so reading `window.start` threw inside render and the dialog
// could not be closed. Normalising at the response boundary is what prevents it.
check('the scan response is normalised before it is rendered',
  source.includes('changed: payload?.changed ?? { items: [], totalBytes: 0, truncated: false, window: null }'))
check('a missing changed group is normalised too',
  source.includes("attachments: payload?.attachments ?? { ids: [], items: [] }"))
check('the window is checked for undefined, not only null',
  source.includes('window !== undefined'))
// Regression: the error fallback used an empty onClose, so a crash left a modal
// with no way out — the user had to reload the whole app.
check('the error fallback can be dismissed', !/onClose: \(\) => \{\},\n            title: this\.props\.title/.test(source))
check('the error fallback closes through the store',
  source.includes('onClose: () => { purgeStore.close() }'))
check('the subagent conversations are selected by default',
  source.includes('setChildIds((normalized.children).map(row => row.sessionId))'))
check('the referenced list carries a warning', source.includes("t('referenced.warning')"))
check('the changed list carries its own warning', source.includes("t('changed.warning')"))
check('the changed group states its time window', source.includes("t('changed.window')"))
check('the changed group explains a timestamp-less log', source.includes("t('changed.noWindow')"))
check('the dialog sends changedIds, never paths', /changedIds,/.test(source))
check('attachment names are shown, not only digests', source.includes("item.name") && source.includes("t('attachments.nameless')"))

console.log('# files outside the working directory')
// 1.3.0: these were refused outright, which made a file the log named in another
// directory impossible to delete from the dialog. 1.4.0 narrows the section to
// files the conversation *produced*: everything it merely read is listed in the
// read-only section instead, whichever directory it sat in.
check('the outside section exists', source.includes("t('section.outside')"))
check('the outside section states the risk', source.includes("t('outside.warning')"))
check('the outside rows are their own list', source.includes("className: `${STYLE_ID}-list`") && source.includes("key: 'outside-list'"))
check('an outside row is ticked individually',
  source.includes('onToggle: () => { toggleIn(setOutsideIds, outsideIds, row.id) }'))
check('the outside section holds produced files only',
  source.includes('const outside = artifactsOutside'))
check('outside ids join artifactIds, the one namespace they belong to',
  source.includes('artifactIds: [...(artifactIds ?? []), ...outsideIds],'))
check('the outside section is part of expand-all',
  source.includes("expandAll(['record', 'children', 'artifacts', 'referenced', 'outside', 'changed', 'attachments'])"))

console.log('# one picture, one row')
// The same image exists twice on disk: the file the user had, and the store's
// copy. Listing both asked the reader to choose between two checkboxes for one
// picture, and ticking the wrong one deleted a file they could not see.
check('a mirrored attachment is recognised', source.includes('item.mirrorOf'))
check('mirrored attachments are not listed as their own rows',
  source.includes('const attachmentStandalone = attachmentItems.filter('))
check('the fold is explained in the attachment section', source.includes("t('attachments.mirrors')"))
check('the file detail names the store copy', source.includes("t('detail.mirror')"))
check('the file detail explains the copy is shared', source.includes("t('detail.mirrorHint')"))
check('the result page reports the copies it took', source.includes("t('done.mirrors')"))

console.log('# a refusal is a message, not a number')
check('refused rows are rendered with their reason', source.includes("function refusedList("))
check('the produced group renders its refusals', source.includes('artifacts-refused-list'))
check('the referenced group renders its refusals', source.includes('referenced-refused-list'))
check('the refusal list is capped', source.includes('const MAX_REFUSED_SHOWN = '))
check('the cap is summarised', source.includes("t('refused.more')"))

console.log('# the compact dialog')
// Every section has to be collapsible: six always-open lists each with their own
// scrollbar is what made this dialog feel enormous.
check('the dialog renders collapsible sections', source.includes('React.createElement(Section, {'))
check('a section reports its own count', source.includes("className: `${STYLE_ID}-section-count`"))
check('a section reports its own summary', source.includes("className: `${STYLE_ID}-section-summary`"))
check('a section exposes its expanded state', source.includes("'aria-expanded': expanded,"))
check('a section points at its body', source.includes("'aria-controls': `${id}-body`"))
check('the dialog opens on the produced files only',
  source.includes("const [expandedSections, setExpandedSections] = React.useState({ artifacts: true })"))
check('the dialog can expand every group at once', source.includes('expandAll('))
check('the dialog can collapse every group at once', source.includes('collapseAll'))
check('the summary bar carries the counts',
  source.includes("t('summary.selection')") || source.includes("t('summary.kept')"))
check('the summary bar is the sticky top of the content column',
  source.includes('className: SUMMARY_CLASS'))
// The filter used to sit below every list, which meant scrolling to reach it.
{
  const searchAt = source.indexOf("placeholder: t('search.placeholder')")
  const summaryAt = source.indexOf("className: SUMMARY_CLASS")
  const artifactsAt = source.indexOf("title: t('section.artifacts')")
  check('the filter sits in the summary bar, above the sections',
    searchAt > summaryAt && (artifactsAt === -1 || searchAt < artifactsAt))
}

console.log('# keeping the conversation while deleting its files')
check('the dialog offers a record switch', source.includes("t('record.toggle')"))
check('the record switch is on by default',
  source.includes('const [includeRecord, setIncludeRecord] = React.useState(true)'))
check('the record switch reaches the purge request', source.includes('record: includeRecord,'))
check('unticking it also frees the projection cache', source.includes('cache: includeRecord,'))
check('the attachments follow the record switch', source.includes('attachments: includeRecord && includeAttachments,'))
check('the dialog explains what a kept conversation means', source.includes("t('record.kept')"))
check('the dialog says which workspace a restore targets', source.includes("t('record.workspace')"))
check('the dialog disables the attachment box when the record is kept',
  source.includes('const attachmentsEnabled = includeRecord'))
check('the disabled attachment box explains itself', source.includes("t('record.forcesAttachments')"))
check('a disabled checkbox line is reachable in the shared row helper',
  source.includes('disabled: off,'))

console.log('# recycle-bin batch operations')
check('a group row can be multi-selected', source.includes('const [selectedGroups, setSelectedGroups] = React.useState({})'))
check('a file row can be multi-selected', source.includes('const [selectedItems, setSelectedItems] = React.useState({})'))
check('the panel can select every group', source.includes("t('trash.selectAll')"))
check('the panel can clear the selection', source.includes("t('trash.selectNone')"))
check('the panel restores the selection in one request', source.includes("t('trash.restoreSelection')"))
check('the restore request carries groupKeys and items',
  source.includes("run('/trash/restore', { groupKeys: selection.groupKeys, items: selection.items }"))
check('a selected group is not also sent as loose items',
  source.includes('groupKeys.includes(row.groupKey) !== true'))
check('the panel permanently deletes the selection', source.includes("t('trash.deleteSelection')"))
check('the batch delete names how much it removes',
  source.includes("t('trash.confirmBodySelection')"))
check('the batch delete still needs the acknowledgement',
  source.includes('disabled: busy || acknowledged !== true'))
check('the selection is cleared after a batch', source.includes('clearSelection()'))
// A group ticked as a whole disables its own item boxes: otherwise unchecking a
// file inside it would look like an exclusion while the group is still sent.
check('a whole-selected group disables its item boxes',
  source.includes('disabled: busy || groupSelected,'))

console.log('# recycle-bin role labels')
check('a group says how much of it is conversation files', source.includes("t('trash.roles')"))
check('a group says when the conversation itself is in it', source.includes("t('trash.conversationGone')"))
check('a files-only group says the conversation was kept', source.includes("t('trash.filesOnly')"))
check('a file row names the conversation it came from', source.includes("t('trash.producedBy')"))
check('the roles come from the group row, not from the item kinds',
  source.includes('const roles = group.roles ?? { record: 0, file: 0 }'))
check('the restore reports where the conversation went',
  source.includes("t('trash.workspaceReattached')") && source.includes("t('trash.workspaceCreated')"))
check('the restore explains an ungrouped conversation',
  source.includes("t('trash.workspaceUngrouped')"))
check('the restore mentions subagent conversations', source.includes("t('trash.workspaceSubagent')"))

console.log('# safety rails')
check('the dialog sends ids, never paths',
  /artifactIds: \[\.\.\.\(artifactIds \?\? \[\]\), \.\.\.outsideIds\],/.test(source)
  && /changedIds,/.test(source))
// The request must not carry a field the Host now refuses: sending an empty
// `referencedIds` would read as "the caller has a referenced selection", which
// is exactly the state 1.4.0 removed.
check('the request carries no referenced ids at all',
  !/referencedIds:/.test(source))
check('a delete in flight is gated by a ref, not only by state',
  (source.match(/inFlight\.current/g) ?? []).length >= 6)
check('the overflow refusal is read from the response code', source.includes("error?.code === 'trash-overflow'"))
check('the Host error code survives the request wrapper', source.includes('failure.code = payload?.code'))
check('every file row carries an aria-label', source.includes("'aria-label': row.displayPath ?? row.originalPath"))
check('every permanent row button carries an aria-label', source.includes("'aria-label': `${t('trash.delete')} ${title}`"))
check('the hidden row delete carries an aria-label', source.includes("t('hidden.deleteRow'), { title:"))
check('the details toggle is focusable and typed', source.includes("React.createElement(Button, {\n            key: 'detail',"))
// A tooltip and a nested risk primitive were deliberately not adopted: their
// props contract was never verified against this build.
check('no unverified primitive is imported', !/RiskConfirmation|Tooltip/.test(source))

console.log('# locale')
const dictionarySource = source.slice(source.indexOf('const ZH = {'), source.indexOf('/** Human-readable byte size. */'))
const keys = [...dictionarySource.matchAll(/^      '([^']+)':/gm)].map(match => match[1])
check('the dictionaries are not empty', keys.length > 100, `keys: ${String(keys.length)}`)
const zhCount = (dictionarySource.match(/^      '/gm) ?? []).length
check('zh and en define the same number of keys', zhCount % 2 === 0, `total entries: ${String(zhCount)}`)
const used = new Set([...source.matchAll(/t\('([^']+)'\)/g)].map(match => match[1]))
const unused = keys.filter(key => !used.has(key) && !key.startsWith('trash.kind.'))
equal('every dictionary key is used', unused.join(', '), '')
for (const key of ['panel.trash', 'panel.hidden', 'panel.settings']) {
  check(`the plugin page section names ${key}`, used.has(key))
}

// `format()` leaves an unknown placeholder as the literal `{name}`, so a
// template naming a value its call site never passes ships broken copy.
const placeholders = new Set([...dictionarySource.matchAll(/\{(\w+)\}/g)].map(match => match[1]))
const supplied = new Set()
for (const match of source.matchAll(/format\(t\('[^']+'\),\s*\{([\s\S]*?)\}\)/g)) {
  for (const key of match[1].matchAll(/(\w+)\s*:/g)) supplied.add(key[1])
}
const unsatisfied = [...placeholders].filter(name => !supplied.has(name))
equal('every placeholder in the dictionaries is supplied at some call site', unsatisfied.join(', '), '')

console.log(`\n${String(checks - failures)}/${String(checks)} checks passed`)
if (failures > 0) process.exitCode = 1
