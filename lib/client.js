/**
 * dsh-plugin-remover — browser half.
 *
 * Hand-written bundle in the module-loader format the shell expects: executing
 * it only registers a factory; the body runs at materialization.
 *
 * Five entries:
 *
 *   * `sidebar.workspaces.session.menu.item` — "删除对话…" on a Session row,
 *     right below the shipped Archive row.
 *   * `plugins.detail.section` — the plugin's own section on its page in
 *     Plugins: the recycle bin, the hidden-conversation list, and the size /
 *     retention settings. This is the surface that reaches *every* deletable
 *     conversation, including the subagent ones the sidebar never renders.
 *   * `shell.overlay` × 3 — the delete dialog, the recycle-bin panel, and the
 *     hidden-conversation panel.
 *
 * Nothing here decides what is deletable. The dialog posts a Session id, the
 * ids of the files the user ticked, and booleans; the Host re-derives the whole
 * plan from the stored logs, so a stale or tampered page cannot widen a delete.
 *
 * Confirmation policy:
 *
 *   * Moving a conversation into the recycle bin is reversible and therefore
 *     has no acknowledgement checkbox: the dialog's primary button does it.
 *   * Emptying the recycle bin, deleting a file or group for good, and the
 *     overflow path ("this deletion cannot fit in the recycle bin") all end in
 *     irreversible loss, and each is gated by an explicit checkbox plus a
 *     danger-coloured button.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-remover',
  factory: (require) => {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    const {
      Button,
      Checkbox,
      IconChevronDownOutlineRegular,
      IconChevronRightOutlineRegular,
      IconTrashOutlineRegular,
      IconWarningOutlineRegular,
      MenuItemButton,
      Modal,
    } = primitives

    /** Locale namespace; equals the package name by convention. */
    const NS = 'dsh-plugin-remover'

    /** This plugin's Host endpoints, served by the same web server as the page. */
    const API = '/plugins/dsh-plugin-remover/api'

    /** How long a successful purge stays on screen before the page reloads. */
    const RELOAD_DELAY_MS = 1800

    /** How many rows of one file list are rendered at once. */
    const MAX_LISTED = 300

    /**
     * The shipped destructive-button style.
     *
     * Rather than painting a red background inline (which beats the theme's own
     * hover rule and pins a literal foreground that is wrong in light mode), the
     * shipped `dangerButton` pattern re-points the primary Button's two fill
     * tokens at the error colour and keeps `variant="primary"` — so the theme
     * still supplies the foreground and the hover state.
     */
    const DANGER_BUTTON_STYLE = {
      '--dsw-alias-button-primary-fill': 'var(--dsw-alias-state-error-primary)',
      '--dsw-alias-button-primary-hover': 'var(--dsw-alias-state-error-primary)',
    }

    /** Shared row/path styling. */
    const PATH_STYLE = {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 11,
      lineHeight: 1.5,
      wordBreak: 'break-all',
      minWidth: 0,
    }

    /** The id of the one `<style>` element this plugin puts in the document head. */
    const STYLE_ID = 'dsh-plugin-remover-styles'

    /**
     * The shipped Modal's own limits, worked around from the outside.
     *
     * `Modal` renders `root > dialog > (content > header, body) + footer`, and it
     * accepts only class names — no `style` — so its geometry cannot be changed
     * from JSX. Out of the box the dialog is `width:min(380px,100%)` with no
     * height constraint at all: a body tall enough to list every section pushes
     * the footer off the bottom of the viewport, and since the root neither
     * scrolls nor shrinks, the primary button becomes unreachable. That is
     * exactly what happens the moment one file row is expanded.
     *
     * So: widen the dialog, cap it to the viewport, and turn the content column
     * into the scroller. The dialog is a column flexbox whose two children are
     * `content` (a flex item with `min-height:0`) and `footer`; capping the
     * dialog and letting only `content` scroll keeps the footer pinned in view.
     * `overscroll-behavior` stops a wheel gesture at the end of the list from
     * scrolling the page behind the modal.
     *
     * The 48 px subtracted from the viewport is the modal root's own vertical
     * padding (24 px top and bottom), which the shipped confirmation dialog also
     * subtracts for its own `max-height`; capping to the full viewport height
     * instead would make the dialog overflow that padding and get clipped.
     *
     * The `:first-child` rule pins the header row so the title and the close
     * button stay reachable while scrolling. It is a `>` child of `content` by
     * construction; if a future build inserts a wrapper the rule stops applying
     * and the header merely scrolls instead — it cannot break the dialog.
     *
     * The `:last-child` rule is the mirror image for the footer. Both children of
     * the dialog are flex items with the default `flex-shrink: 1`, so when the
     * dialog hits its cap the footer would be squeezed too and its buttons would
     * be clipped by the dialog's own `overflow: hidden`. Pinning the footer at its
     * natural height leaves the whole shrink to the content column, which scrolls.
     */
    const STYLE_TEXT = `
.${STYLE_ID}-dialog { width: min(760px, calc(100vw - 48px)); max-height: calc(100vh - 48px); }
.${STYLE_ID}-narrow { width: min(600px, calc(100vw - 48px)); }
@supports (height: 100dvh) {
  .${STYLE_ID}-dialog { max-height: calc(100dvh - 48px); }
}
.${STYLE_ID}-content { min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.${STYLE_ID}-content > :first-child { position: sticky; top: 0; z-index: 1; background: var(--dsw-alias-bg-layer-2); }
.${STYLE_ID}-dialog > :last-child { flex: none; }
`

    /** The class names `STYLE_TEXT` defines, for the three dialogs to use. */
    const DIALOG_CLASS = `${STYLE_ID}-dialog`
    const NARROW_DIALOG_CLASS = `${STYLE_ID}-dialog ${STYLE_ID}-narrow`
    const CONTENT_CLASS = `${STYLE_ID}-content`

    const ZH = {
      'menu.purge': '删除对话…',
      'dialog.title': '删除对话',
      'dialog.subtitle': '「{title}」',
      'dialog.scanning': '正在读取该对话的存储与文件…',
      'dialog.scanFailed': '无法读取该对话的删除计划：{reason}',
      'dialog.close': '关闭',
      'dialog.cancel': '取消',
      'dialog.cwd': '工作目录：{path}',
      'dialog.noCwd': '该对话没有记录工作目录。',
      'dialog.live': '该对话正在运行：删除会先停止它，再移动文件。',
      'section.record': '对话文件',
      'record.summary': '{dirs} 个存储目录 · {bytes}',
      'record.none': '未找到该对话的存储目录（可能已被删除）。',
      'record.cache': '投影缓存 {bytes}（随对话文件一起移动）',
      'record.cacheNone': '没有该对话的投影缓存。',
      'section.children': '子代理对话',
      'children.hint': '删除父对话后，这些子代理对话也会没有入口；默认一起删除。',
      'children.running': '运行中',
      'children.bytes': '{bytes}',
      'section.artifacts': '产出的文件',
      'artifacts.summary': '已选 {count} 个 · {bytes}',
      'artifacts.none': '没有扫描到由该对话写入的文件。',
      'artifacts.more': '另有 {count} 个文件未在此列出。',
      'artifacts.refused': '已跳过 {count} 个不安全或已不存在的条目。',
      'section.referenced': '引用的文件',
      'referenced.warning': '这些是该对话读过、但没有写过的文件。默认不删除；勾选后会一起进入回收站。',
      'referenced.summary': '已选 {count} 个 · {bytes}',
      'referenced.none': '该对话没有读取过工作目录内的文件。',
      'referenced.more': '另有 {count} 个文件未在此列出。',
      'referenced.refused': '已跳过 {count} 个不在工作目录内或不存在的条目。',
      'select.all': '全选',
      'select.none': '全不选',
      'search.placeholder': '按路径筛选…',
      'search.none': '没有匹配的文件。',
      'detail.button': '详细信息',
      'detail.dir': '来源目录',
      'detail.path': '完整路径',
      'detail.size': '大小',
      'detail.sources': '来源对话',
      'detail.written': '写入方式',
      'detail.read': '读取方式',
      'detail.parent': '父对话',
      'detail.subagent': '子代理',
      'section.attachments': '附件对象',
      'attachments.summary': '该对话引用了 {count} 个附件对象；无其他对话引用的会一起删除。',
      'attachments.none': '该对话没有引用附件。',
      'trash.summary': '回收站已用 {used} / {cap}，保留 {days} 天。',
      'trash.summaryUnlimited': '回收站已用 {used}，容量与保留时间未设上限。',
      'confirm.trash': '移入回收站',
      'confirm.deleting': '正在移入回收站…',
      'confirm.recoverHint': '删除后可在「插件 → 对话移除与回收站 → 回收站」中恢复。',
      'failed': '操作失败：{reason}',
      'done.title': '已删除',
      'done.record': '已移入 {dirs} 个存储目录（{bytes}）。',
      'done.children': '已连带 {count} 个子代理对话。',
      'done.cache': '已移入投影缓存（{bytes}）。',
      'done.artifacts': '已移入 {count} 个产出文件（{bytes}）。',
      'done.referenced': '已移入 {count} 个引用文件（{bytes}）。',
      'done.attachments': '已移入 {count} 个附件路径。',
      'done.trash': '都放在回收站里，可以随时恢复。',
      'done.direct': '已永久删除，无法恢复。',
      'done.errors': '有 {count} 项未能处理，详见下方。',
      'done.reload': '页面将在 {seconds} 秒后重新加载以刷新列表。',
      'done.reloadNow': '立即重新加载',
      'overflow.title': '回收站放不下这次删除',
      'overflow.body': '本次要移入 {incoming}，但回收站上限是 {cap}（当前已用 {used}）。',
      'overflow.onlyPurge': '即使清空回收站也放不下，只能永久删除。',
      'overflow.option.purge': '永久删除本次内容',
      'overflow.option.purgeHint': '不经过回收站，删除后无法恢复。',
      'overflow.option.empty': '先清空回收站，再重试',
      'overflow.option.emptyHint': '回收站里现有的内容会被永久删除，然后本次删除照常进入回收站。',
      'overflow.ack': '我已知晓：永久删除后无法恢复',
      'overflow.confirm.purge': '永久删除',
      'overflow.confirm.empty': '清空回收站并重试',
      'trash.title': '回收站',
      'trash.description': '每次删除的对话文件与产出文件都存在同一组里，可以整组或单个恢复。',
      'trash.loading': '正在读取回收站…',
      'trash.failed': '无法读取回收站：{reason}',
      'trash.empty': '回收站是空的。',
      'trash.group.meta': '{count} 项 · 删除于 {date}',
      'trash.group.expires': '{date} 自动清除',
      'trash.group.never': '不会自动清除',
      'trash.restore': '恢复',
      'trash.delete': '永久删除',
      'trash.refresh': '刷新',
      'trash.close': '关闭',
      'trash.used': '已用 {used} / {cap}',
      'trash.usedUnlimited': '已用 {used}（不限容量）',
      'trash.emptyAll': '清空回收站',
      'trash.settings': '设置',
      'trash.retention': '保留天数',
      'trash.retentionHint': '超过天数自动清除；0 表示不自动清除。',
      'trash.maxBytes': '容量上限（MB）',
      'trash.maxBytesHint': '超过上限时删除会先询问；0 表示不限。',
      'trash.save': '保存设置',
      'trash.saved': '已保存。',
      'trash.confirmTitle': '永久删除',
      'trash.confirmBodyAll': '永久删除回收站里的全部内容？回收站会清空，无法恢复。',
      'trash.confirmBodyGroup': '永久删除这一组内容？该组共 {count} 项，无法恢复。',
      'trash.confirmBodyRow': '永久删除这一项？无法恢复。',
      'trash.confirmAck': '我已知晓：永久删除后无法恢复',
      'trash.confirmed': '已永久删除。',
      'trash.restored': '已恢复 {count} 项。',
      'trash.truncated': '另有 {count} 组未在此列出。',
      'trash.overCapacity': '回收站已超过容量上限（{used} / {cap}），请清空或调高上限。',
      'trash.kind.store': '对话文件',
      'trash.kind.cache': '投影缓存',
      'trash.kind.artifact': '产出文件',
      'trash.kind.referenced': '引用文件',
      'trash.kind.attachment': '附件对象',
      'hidden.title': '隐藏的子代理对话',
      'hidden.description': '子代理对话不会出现在侧栏，这里列出全部；删除会进入回收站。',
      'hidden.loading': '正在读取子代理对话…',
      'hidden.failed': '无法读取子代理对话：{reason}',
      'hidden.none': '没有隐藏的子代理对话。',
      'hidden.count': '{count} 个隐藏子代理对话',
      'hidden.orphan': '父对话已删除',
      'hidden.parent': '父对话「{title}」',
      'hidden.running': '运行中',
      'hidden.bytes': '{bytes}',
      'hidden.delete': '删除',
      'hidden.deleteRow': '删除「{title}」',
      'hidden.refresh': '刷新',
      'hidden.close': '关闭',
      'hidden.truncated': '另有 {count} 个未在此列出。',
      'panel.title': '对话移除与回收站',
      'panel.hint': '一次性清掉对话本身、它的子代理、它产出的文件，或把它们先放进回收站。',
      'panel.trash': '回收站',
      'panel.trashValue': '{count} 组 · {bytes}',
      'panel.trashEmpty': '空的',
      'panel.hidden': '隐藏的子代理对话',
      'panel.hiddenValue': '{count} 个',
      'panel.settings': '回收站设置',
      'panel.settingsValue': '保留 {days} 天 · 上限 {cap}',
      'panel.settingsValueUnlimited': '未设上限',
      'panel.open': '打开',
      'panel.refresh': '刷新',
      'panel.loading': '正在读取…',
      'panel.failed': '读取失败：{reason}',
      'panel.overflow': '回收站已超过容量上限。',
      'panel.showInSidebar': '在侧边栏显示回收站入口',
      'panel.showInSidebarHint': '入口出现在侧边栏右下角、设置行上方；关掉后仍可从这里打开回收站。',
      'foot.trash': '回收站',
    }

    const EN = {
      'menu.purge': 'Delete conversation…',
      'dialog.title': 'Delete conversation',
      'dialog.subtitle': '"{title}"',
      'dialog.scanning': 'Reading this conversation\u2019s storage and files…',
      'dialog.scanFailed': 'Could not read the deletion plan: {reason}',
      'dialog.close': 'Close',
      'dialog.cancel': 'Cancel',
      'dialog.cwd': 'Working directory: {path}',
      'dialog.noCwd': 'This conversation recorded no working directory.',
      'dialog.live': 'This conversation is running: deletion stops it before moving files.',
      'section.record': 'Conversation files',
      'record.summary': '{dirs} storage directories · {bytes}',
      'record.none': 'No storage directory found for this conversation (it may already be gone).',
      'record.cache': 'Projection cache {bytes} (moved with the conversation files)',
      'record.cacheNone': 'No projection cache for this conversation.',
      'section.children': 'Subagent conversations',
      'children.hint': 'Once the parent is gone these have no entry point left; they are selected by default.',
      'children.running': 'running',
      'children.bytes': '{bytes}',
      'section.artifacts': 'Files it produced',
      'artifacts.summary': '{count} selected · {bytes}',
      'artifacts.none': 'No file written by this conversation was found.',
      'artifacts.more': '{count} more files are not listed here.',
      'artifacts.refused': '{count} unsafe or missing entries were skipped.',
      'section.referenced': 'Files it referenced',
      'referenced.warning': 'These files were read, not written, by this conversation. They are unselected by default; ticking one moves it into the recycle bin too.',
      'referenced.summary': '{count} selected · {bytes}',
      'referenced.none': 'This conversation read no file inside its working directory.',
      'referenced.more': '{count} more files are not listed here.',
      'referenced.refused': '{count} entries outside the working directory or missing were skipped.',
      'select.all': 'Select all',
      'select.none': 'Select none',
      'search.placeholder': 'Filter by path…',
      'search.none': 'No matching file.',
      'detail.button': 'Details',
      'detail.dir': 'Source directory',
      'detail.path': 'Full path',
      'detail.size': 'Size',
      'detail.sources': 'From',
      'detail.written': 'Written by',
      'detail.read': 'Read by',
      'detail.parent': 'parent',
      'detail.subagent': 'subagent',
      'section.attachments': 'Attachment objects',
      'attachments.summary': 'This conversation references {count} attachment objects; those no other conversation references are removed too.',
      'attachments.none': 'This conversation references no attachments.',
      'trash.summary': 'Recycle bin {used} / {cap}, kept {days} days.',
      'trash.summaryUnlimited': 'Recycle bin {used}; no size or retention limit.',
      'confirm.trash': 'Move to recycle bin',
      'confirm.deleting': 'Moving to recycle bin…',
      'confirm.recoverHint': 'Restore it later under Plugins → Conversation remover and recycle bin → Recycle bin.',
      'failed': 'Failed: {reason}',
      'done.title': 'Deleted',
      'done.record': 'Moved {dirs} storage directories ({bytes}) to the recycle bin.',
      'done.children': 'Included {count} subagent conversations.',
      'done.cache': 'Moved the projection cache ({bytes}).',
      'done.artifacts': 'Moved {count} produced files ({bytes}).',
      'done.referenced': 'Moved {count} referenced files ({bytes}).',
      'done.attachments': 'Moved {count} attachment paths.',
      'done.trash': 'Everything is in the recycle bin and can be restored.',
      'done.direct': 'Permanently deleted; this cannot be undone.',
      'done.errors': '{count} items could not be handled; see below.',
      'done.reload': 'The page reloads in {seconds}s to refresh the list.',
      'done.reloadNow': 'Reload now',
      'overflow.title': 'The recycle bin cannot hold this deletion',
      'overflow.body': 'This deletion would move {incoming}, but the recycle-bin cap is {cap} (currently {used}).',
      'overflow.onlyPurge': 'Even an emptied recycle bin could not hold it, so only permanent deletion is possible.',
      'overflow.option.purge': 'Delete this permanently',
      'overflow.option.purgeHint': 'Skips the recycle bin; this cannot be undone.',
      'overflow.option.empty': 'Empty the recycle bin, then retry',
      'overflow.option.emptyHint': 'What the recycle bin holds now is deleted for good, then this deletion is stored as usual.',
      'overflow.ack': 'I understand permanent deletion cannot be undone',
      'overflow.confirm.purge': 'Delete permanently',
      'overflow.confirm.empty': 'Empty and retry',
      'trash.title': 'Recycle bin',
      'trash.description': 'One group per deletion, holding its conversation files and produced files; restore a whole group or a single file.',
      'trash.loading': 'Reading the recycle bin…',
      'trash.failed': 'Could not read the recycle bin: {reason}',
      'trash.empty': 'The recycle bin is empty.',
      'trash.group.meta': '{count} items · deleted {date}',
      'trash.group.expires': 'cleared automatically {date}',
      'trash.group.never': 'never cleared automatically',
      'trash.restore': 'Restore',
      'trash.delete': 'Delete permanently',
      'trash.refresh': 'Refresh',
      'trash.close': 'Close',
      'trash.used': '{used} / {cap} used',
      'trash.usedUnlimited': '{used} used (no cap)',
      'trash.emptyAll': 'Empty the recycle bin',
      'trash.settings': 'Settings',
      'trash.retention': 'Keep for (days)',
      'trash.retentionHint': 'Groups older than this are cleared automatically; 0 never clears.',
      'trash.maxBytes': 'Size cap (MB)',
      'trash.maxBytesHint': 'A deletion over the cap asks first; 0 means no cap.',
      'trash.save': 'Save settings',
      'trash.saved': 'Saved.',
      'trash.confirmTitle': 'Delete permanently',
      'trash.confirmBodyAll': 'Permanently delete everything in the recycle bin? It is emptied and cannot be recovered.',
      'trash.confirmBodyGroup': 'Permanently delete this group? It holds {count} items and cannot be recovered.',
      'trash.confirmBodyRow': 'Permanently delete this file? It cannot be recovered.',
      'trash.confirmAck': 'I understand permanent deletion cannot be undone',
      'trash.confirmed': 'Permanently deleted.',
      'trash.restored': 'Restored {count} items.',
      'trash.truncated': '{count} more groups are not listed here.',
      'trash.overCapacity': 'The recycle bin is over its cap ({used} / {cap}); empty it or raise the cap.',
      'trash.kind.store': 'conversation files',
      'trash.kind.cache': 'projection cache',
      'trash.kind.artifact': 'produced file',
      'trash.kind.referenced': 'referenced file',
      'trash.kind.attachment': 'attachment object',
      'hidden.title': 'Hidden subagent conversations',
      'hidden.description': 'Subagent conversations never appear in the sidebar; this lists every one. Deleting moves them to the recycle bin.',
      'hidden.loading': 'Reading subagent conversations…',
      'hidden.failed': 'Could not read subagent conversations: {reason}',
      'hidden.none': 'No hidden subagent conversations.',
      'hidden.count': '{count} hidden subagent conversations',
      'hidden.orphan': 'parent already deleted',
      'hidden.parent': 'parent "{title}"',
      'hidden.running': 'running',
      'hidden.bytes': '{bytes}',
      'hidden.delete': 'Delete',
      'hidden.deleteRow': 'Delete "{title}"',
      'hidden.refresh': 'Refresh',
      'hidden.close': 'Close',
      'hidden.truncated': '{count} more are not listed here.',
      'panel.title': 'Conversation remover and recycle bin',
      'panel.hint': 'Remove a conversation together with its subagents and the files it produced — or park them in the recycle bin first.',
      'panel.trash': 'Recycle bin',
      'panel.trashValue': '{count} groups · {bytes}',
      'panel.trashEmpty': 'empty',
      'panel.hidden': 'Hidden subagent conversations',
      'panel.hiddenValue': '{count}',
      'panel.settings': 'Recycle-bin settings',
      'panel.settingsValue': 'kept {days} days · cap {cap}',
      'panel.settingsValueUnlimited': 'no cap',
      'panel.open': 'Open',
      'panel.refresh': 'Refresh',
      'panel.loading': 'Reading…',
      'panel.failed': 'Could not read: {reason}',
      'panel.overflow': 'The recycle bin is over its cap.',
      'panel.showInSidebar': 'Show a recycle-bin entry in the sidebar',
      'panel.showInSidebarHint': 'The entry sits at the foot of the sidebar, above Settings; switching it off still leaves the recycle bin reachable from here.',
      'foot.trash': 'Recycle bin',
    }

    /** Human-readable byte size. */
    function formatBytes(bytes) {
      const value = typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : 0
      if (value < 1024) return `${String(value)} B`
      const units = ['KB', 'MB', 'GB', 'TB']
      let size = value / 1024
      let unit = 0
      while (size >= 1024 && unit < units.length - 1) {
        size /= 1024
        unit += 1
      }
      return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`
    }

    /** A date the user can read, in their own locale. */
    function formatDate(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      try {
        return new Date(value).toLocaleString()
      } catch {
        return '—'
      }
    }

    /** Interpolate `{name}` placeholders. */
    function format(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (match, key) => (
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
      ))
    }

    /** One cancelable request to a Host endpoint. */
    async function callHost(path, body) {
      const response = await fetch(`${API}${path}`, {
        method: 'POST',
        // The marker header identifies this plugin's own page to the Host route;
        // a cross-origin page cannot set it without a preflight the server does
        // not answer.
        headers: { 'content-type': 'application/json', 'x-dsh-plugin-remover': '1' },
        body: JSON.stringify(body ?? {}),
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok || payload === null || payload.ok !== true) {
        const reason = payload?.error ?? `${response.status} ${response.statusText}`
        const failure = new Error(String(reason))
        // The caller has to tell an ordinary failure from "the recycle bin
        // cannot hold this", which is a question rather than an error.
        failure.code = payload?.code
        failure.payload = payload
        throw failure
      }
      return payload
    }

    /**
     * The one piece of shared state: which Session the delete dialog is open for.
     * Module-local rather than a Cordis service, because both entries are
     * registered by this same plugin and nothing else reads it.
     */
    function createStore() {
      let value = null
      // A clock is not a usable key: two opens in the same millisecond would
      // produce the same nonce, so the fresh dialog would not remount and would
      // inherit the previous open's rows and errors.
      let sequence = 0
      const listeners = new Set()
      return {
        getSnapshot: () => value,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        open(request) {
          sequence += 1
          value = request === undefined ? { nonce: sequence } : { ...request, nonce: sequence }
          for (const listener of [...listeners]) listener()
        },
        close() {
          value = null
          for (const listener of [...listeners]) listener()
        },
      }
    }

    /**
     * A lazily loaded snapshot of one Host read, shared by the sidebar entry and
     * the plugin page.
     *
     * Both surfaces have to agree on whether the sidebar entry is shown, and the
     * sidebar entry exists on every page — so it cannot be given the answer by
     * whoever happens to have loaded the plugin page. The first subscriber
     * triggers the read; later ones share it. A failed read keeps the last good
     * value rather than blanking the surface.
     */
    function createResource(load) {
      let snapshot = { status: 'idle', value: null }
      let started = false
      const listeners = new Set()
      const emit = () => { for (const listener of [...listeners]) listener() }
      const set = (next) => {
        snapshot = next
        emit()
      }
      const refresh = () => {
        if (snapshot.status === 'loading') return
        set({ status: 'loading', value: snapshot.value })
        load()
          .then(value => { set({ status: 'ready', value }) })
          .catch(() => { set({ status: 'failed', value: snapshot.value }) })
      }
      return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          if (!started) {
            started = true
            refresh()
          }
          return () => { listeners.delete(listener) }
        },
        /** Publish a value the caller already has, so both surfaces update at once. */
        set: (value) => { set({ status: 'ready', value }) },
        refresh,
      }
    }

    /** Small muted line. */
    function hint(key, text) {
      return React.createElement('p', {
        key,
        style: { margin: '4px 0', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      }, text)
    }

    /** One scrollable monospace path list. */
    function pathList(key, paths) {
      return React.createElement('div', {
        key,
        style: {
          maxHeight: 150,
          overflowY: 'auto',
          margin: '6px 0 2px',
          padding: '6px 8px',
          borderRadius: 6,
          background: 'var(--dsw-alias-bg-layer-2)',
          border: '1px solid var(--dsw-alias-border-l1)',
          ...PATH_STYLE,
        },
      }, paths.map((path, index) => React.createElement('div', { key: `${index}:${path}` }, path)))
    }

    /** A section heading inside a dialog body. */    function section(key, title) {
      return React.createElement('h3', {
        key,
        style: { margin: '12px 0 2px', fontSize: 13 },
      }, title)
    }

    /** A row of controls above a file list. */
    function toolbar(key, children) {
      return React.createElement('div', {
        key,
        style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', margin: '4px 0 6px' },
      }, children)
    }

    /** One flat secondary button with a small size and no border. */
    function tinyButton(key, label, onClick, extra) {
      return React.createElement(Button, {
        key,
        variant: 'outline',
        size: 'sm',
        onClick,
        ...extra ?? {},
      }, label)
    }

    /**
     * The per-file details panel.
     *
     * The single fact that makes a generated file recognizable is where it came
     * from, so the source directory leads; the full path, size, and the
     * conversations that wrote or read it follow. It is an inline panel rather
     * than a nested modal: a modal inside a modal steals the focus trap, and the
     * list is exactly what the user is comparing against.
     *
     * @param props - the row, its kind, and the translator.
     */
    function FileDetail({ row, kind, t }) {
      const pairs = []
      pairs.push([t('detail.dir'), row.dir ?? '—'])
      pairs.push([t('detail.path'), row.path ?? row.originalPath ?? row.displayPath ?? '—'])
      pairs.push([t('detail.size'), formatBytes(row.bytes)])
      const sources = Array.isArray(row.sources) ? row.sources : []
      const roleLabel = kind === 'referenced' ? t('detail.read') : t('detail.written')
      const sourceLines = sources.map((source, index) => {
        const label = source.title ?? source.sessionId
        const role = source.origin === 'subagent' ? t('detail.subagent') : t('detail.parent')
        const tools = Array.isArray(source.tools) && source.tools.length > 0
          ? ` · ${roleLabel} ${source.tools.join(' / ')} ×${String(source.ops ?? 1)}`
          : ''
        return React.createElement('div', { key: `${index}:${source.sessionId}` }, `「${label}」(${role})${tools}`)
      })
      const body = []
      body.push(React.createElement('dl', {
        key: 'grid',
        style: {
          display: 'grid',
          gridTemplateColumns: 'auto minmax(0, 1fr)',
          gap: '2px 10px',
          margin: 0,
          fontSize: 11,
        },
      }, pairs.flatMap(([label, value], index) => [
        React.createElement('dt', {
          key: `k${String(index)}`,
          style: { color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' },
        }, label),
        React.createElement('dd', { key: `v${String(index)}`, style: { margin: 0, ...PATH_STYLE } }, String(value)),
      ])))
      if (sourceLines.length > 0) {
        body.push(React.createElement('div', {
          key: 'sources',
          style: { marginTop: 6, fontSize: 11, color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-word' },
        }, [
          React.createElement('div', { key: 'label', style: { marginBottom: 1 } }, t('detail.sources')),
          ...sourceLines,
        ]))
      }
      return React.createElement('div', {
        style: {
          gridColumn: '1 / -1',
          marginTop: 4,
          padding: '6px 8px',
          borderRadius: 6,
          background: 'var(--dsw-alias-bg-layer-2)',
          border: '1px solid var(--dsw-alias-border-l1)',
        },
      }, body)
    }

    /**
     * One selectable file row with a details toggle.
     *
     * @param props - selection state, the row, the open set, and the callbacks.
     */
    function FileRow({ row, kind, checked, onToggle, open, onToggleDetail, t, idPrefix }) {
      const panelId = `${idPrefix}-detail-${row.id}`
      return React.createElement(React.Fragment, null, [
        React.createElement('div', {
          key: 'row',
          style: {
            display: 'grid',
            gridTemplateColumns: '18px minmax(0, 1fr) auto auto',
            gap: 8,
            alignItems: 'center',
            padding: '3px 4px',
            borderRadius: 5,
          },
        }, [
          React.createElement('input', {
            key: 'check',
            type: 'checkbox',
            checked,
            onChange: onToggle,
            'aria-label': row.displayPath ?? row.originalPath,
            style: { margin: 0 },
          }),
          React.createElement('span', {
            key: 'path',
            style: { ...PATH_STYLE, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            title: row.displayPath ?? row.originalPath,
          }, row.displayPath ?? row.originalPath ?? ''),
          React.createElement('span', {
            key: 'bytes',
            style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' },
          }, formatBytes(row.bytes)),
          React.createElement(Button, {
            key: 'detail',
            variant: 'outline',
            size: 'sm',
            'aria-expanded': open,
            'aria-controls': panelId,
            // The label never changes: a toggle that renames itself makes the
            // accessible name flicker between two states for no benefit.
            'aria-label': `${t('detail.button')} ${row.displayPath ?? row.originalPath ?? ''}`,
            onClick: onToggleDetail,
          }, t('detail.button')),
        ]),
        open
          ? React.createElement('div', { key: 'detail', id: panelId }, React.createElement(FileDetail, { row, kind, t }))
          : null,
      ])
    }

    /**
     * One checkbox-and-label line.
     * @param props - the checked state, the label, and the change handler.
     */
    function checkLine({ key, checked, onChange, label, hintText }) {
      return React.createElement('label', {
        key,
        style: { display: 'grid', gridTemplateColumns: '18px minmax(0, 1fr)', gap: 8, alignItems: 'start', cursor: 'pointer', padding: '3px 0' },
      }, [
        React.createElement('input', {
          key: 'c',
          type: 'checkbox',
          checked,
          onChange,
          style: { marginTop: 3 },
        }),
        React.createElement('span', { key: 't' }, [
          React.createElement('span', { key: 'l', style: { display: 'block', fontSize: 12 } }, label),
          hintText === undefined
            ? null
            : React.createElement('span', {
              key: 'h',
              style: { display: 'block', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
            }, hintText),
        ]),
      ])
    }

    /** The Session-row menu entry, placed directly after the shipped Archive row. */
    function PurgeMenuItem({ sessionId, displayTitle, useMenuOpenState, purgeStore, t }) {
      // The owner (WorkspaceBrowser) publishes this hook for every entry of the
      // menu list, exactly as it does for its own archive row. The guard is
      // static per mount, so the conditional call cannot change between renders;
      // a missing hook costs only the auto-dismiss.
      const openState = typeof useMenuOpenState === 'function' ? useMenuOpenState() : null
      const setMenuOpen = Array.isArray(openState) ? openState[1] : () => {}
      return React.createElement(MenuItemButton, {
        danger: true,
        icon: React.createElement(IconTrashOutlineRegular, { size: 14 }),
        onSelect: () => {
          if (typeof setMenuOpen === 'function') setMenuOpen(false)
          // The store stamps the nonce; passing one here would defeat the
          // monotonic counter that keeps two opens from colliding.
          purgeStore.open({ sessionId, displayTitle })
        },
      }, t('menu.purge'))
    }

    /**
     * The sidebar-foot shortcut to the recycle bin.
     *
     * The sidebar renders this beside Settings on every page, so it is the one
     * entry that does not depend on a Session row being visible. Whether it
     * shows is the user's choice, stored with the recycle-bin settings and
     * shared with the plugin page through `sidebarResource`.
     *
     * While that setting is still loading, or if reading it failed, the entry
     * shows: an unreadable preference must not hide the only always-present
     * entry point.
     */
    function TrashFooterButton({ wide, trashStore, sidebarResource, t }) {
      const snapshot = React.useSyncExternalStore(sidebarResource.subscribe, sidebarResource.getSnapshot)
      const request = React.useSyncExternalStore(trashStore.subscribe, trashStore.getSnapshot)
      const settings = snapshot?.value?.settings
      if (settings !== undefined && settings !== null && settings.showSidebarTrash === false) return null
      const active = request !== null
      const label = t('foot.trash')
      return React.createElement('button', {
        type: 'button',
        'aria-haspopup': 'dialog',
        'aria-expanded': active,
        'aria-label': label,
        title: label,
        onClick: () => { trashStore.open() },
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          height: 28,
          padding: wide ? '0 8px' : 0,
          width: wide ? undefined : 28,
          border: 'none',
          borderRadius: 'var(--dsw-radius-sm)',
          background: active ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
          color: 'var(--dsw-alias-label-secondary)',
          fontSize: 13,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        },
      }, [
        React.createElement(IconTrashOutlineRegular, { key: 'icon', size: 14 }),
        wide ? React.createElement('span', { key: 'label' }, label) : null,
      ])
    }

    /** Containment for a dialog's own render and lifecycle failures. */
    class DialogBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error) {
        // Kept for the browser console; the panel below shows the message.
        console.error('dsh-plugin-remover: dialog failed', error)
      }

      render() {
        if (this.state.error === null) return this.props.children
        return React.createElement(Modal, {
          open: true,
          onClose: () => {},
          title: this.props.title,
          closeLabel: this.props.closeLabel,
          className: NARROW_DIALOG_CLASS,
          contentClassName: CONTENT_CLASS,
        }, React.createElement('p', {
          role: 'alert',
          style: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' },
        }, String(this.state.error?.message ?? this.state.error)))
      }
    }

    /** The overlay entry for the delete dialog: one form per request. */
    function PurgeDialog({ purgeStore, t }) {
      const request = React.useSyncExternalStore(purgeStore.subscribe, purgeStore.getSnapshot)
      if (request === null) return null
      // The dialog renders into a body portal, so an uncaught render error here
      // would unmount the application root rather than just this dialog.
      return React.createElement(DialogBoundary, { t, title: t('dialog.title'), closeLabel: t('dialog.close') },
        React.createElement(PurgeForm, {
          key: `${request.sessionId}:${String(request.nonce)}`,
          request,
          purgeStore,
          t,
        }))
    }

    /** Whether a filter matches one row. */
    function matches(row, needle) {
      if (needle.trim() === '') return true
      const value = String(row.displayPath ?? row.originalPath ?? '').toLowerCase()
      return value.includes(needle.trim().toLowerCase())
    }

    /**
     * The delete dialog: scan, tick what to take, move it to the recycle bin.
     *
     * There is no acknowledgement checkbox on the normal path. Deleting here is
     * reversible — everything lands in the recycle bin — and a checkbox on a
     * reversible action only trains people to tick it. The irreversible paths
     * (the overflow question, and permanent deletion from the recycle bin) each
     * carry their own checkbox and a danger-coloured button.
     */
    function PurgeForm({ request, purgeStore, t }) {
      const [plan, setPlan] = React.useState(null)
      const [scanError, setScanError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [failure, setFailure] = React.useState(null)
      const [result, setResult] = React.useState(null)
      const [countdown, setCountdown] = React.useState(0)

      // Per-section selection. `null` until the scan lands, so the defaults can
      // be applied once per request instead of fighting the user on a refresh.
      const [artifactIds, setArtifactIds] = React.useState(null)
      const [referencedIds, setReferencedIds] = React.useState([])
      const [childIds, setChildIds] = React.useState(null)
      const [includeAttachments, setIncludeAttachments] = React.useState(true)
      const [openDetails, setOpenDetails] = React.useState({})
      const [needle, setNeedle] = React.useState('')

      // The overflow question, which is the only place this dialog can lose data.
      const [overflow, setOverflow] = React.useState(null)
      const [overflowChoice, setOverflowChoice] = React.useState('purge')
      const [acknowledged, setAcknowledged] = React.useState(false)

      React.useEffect(() => {
        let cancelled = false
        callHost('/scan', { sessionId: request.sessionId })
          .then((payload) => {
            if (cancelled) return
            setPlan(payload)
            // Produced files are what "delete this conversation" means; files it
            // merely read are opt-in, one by one.
            setArtifactIds((payload.artifacts?.items ?? []).map(row => row.id))
            setChildIds((payload.children ?? []).map(row => row.sessionId))
          })
          .catch((error) => { if (!cancelled) setScanError(error instanceof Error ? error.message : String(error)) })
        return () => { cancelled = true }
      }, [request.sessionId])

      // After a successful purge the list on screen is already stale; reloading
      // is the only honest way to show what the Host now holds.
      React.useEffect(() => {
        if (result === null || !result.ok) return undefined
        setCountdown(Math.ceil(RELOAD_DELAY_MS / 1000))
        const tick = window.setInterval(() => {
          setCountdown((value) => (value > 0 ? value - 1 : 0))
        }, 1000)
        const timer = window.setTimeout(() => { window.location.reload() }, RELOAD_DELAY_MS)
        return () => {
          window.clearInterval(tick)
          window.clearTimeout(timer)
        }
      }, [result])

      // `busy` alone cannot stop a second click in the same event batch (state
      // updates are not synchronous), so a ref gates the request itself.
      const inFlight = React.useRef(false)

      const submit = (extra) => {
        if (inFlight.current) return
        inFlight.current = true
        setBusy(true)
        setFailure(null)
        callHost('/purge', {
          sessionId: request.sessionId,
          include: {
            record: true,
            cache: true,
            children: true,
            attachments: includeAttachments,
          },
          artifactIds: artifactIds ?? [],
          referencedIds,
          childIds: childIds ?? [],
          ...extra ?? {},
        })
          .then((payload) => { setResult(payload) })
          .catch((error) => {
            if (error?.code === 'trash-overflow') {
              // Not an error: a question. Nothing was touched.
              setOverflow(error.payload)
              setOverflowChoice(error.payload?.onlyPurge === true ? 'purge' : 'empty')
              setAcknowledged(false)
            } else {
              setFailure(error instanceof Error ? error.message : String(error))
            }
          })
          .finally(() => {
            inFlight.current = false
            setBusy(false)
          })
      }

      const close = () => {
        if (busy) return
        purgeStore.close()
      }

      const toggleIn = (setter, current, id) => {
        const list = Array.isArray(current) ? current : []
        setter(list.includes(id) ? list.filter(value => value !== id) : [...list, id])
      }

      const body = []
      const title = request.displayTitle === undefined || request.displayTitle === ''
        ? request.sessionId
        : request.displayTitle

      if (result !== null && result.ok) {
        const removed = result.removed ?? {}
        body.push(React.createElement('h3', { key: 'done', style: { margin: '0 0 6px' } }, t('done.title')))
        body.push(hint('done-record', format(t('done.record'), {
          dirs: removed.directories?.length ?? 0,
          bytes: formatBytes(removed.directoryBytes ?? 0),
        })))
        if ((removed.children?.length ?? 0) > 0) {
          body.push(hint('done-children', format(t('done.children'), { count: removed.children.length })))
        }
        if (removed.projectionCache) {
          body.push(hint('done-cache', format(t('done.cache'), { bytes: formatBytes(removed.projectionCache.bytes ?? 0) })))
        }
        if ((removed.artifacts?.length ?? 0) > 0) {
          body.push(hint('done-artifacts', format(t('done.artifacts'), {
            count: removed.artifacts.length,
            bytes: formatBytes(removed.artifactBytes ?? 0),
          })))
        }
        if ((removed.referenced?.length ?? 0) > 0) {
          body.push(hint('done-referenced', format(t('done.referenced'), {
            count: removed.referenced.length,
            bytes: formatBytes(removed.referencedBytes ?? 0),
          })))
        }
        if ((removed.attachments?.length ?? 0) > 0) {
          body.push(hint('done-attachments', format(t('done.attachments'), { count: removed.attachments.length })))
        }
        body.push(hint('done-where', result.toTrash === true ? t('done.trash') : t('done.direct')))
        if ((result.errors?.length ?? 0) > 0) {
          body.push(hint('done-errors', format(t('done.errors'), { count: result.errors.length })))
          body.push(pathList('done-errors-list', result.errors.map(row => `${row.step}: ${row.path ?? ''} — ${row.message}`)))
        }
        body.push(hint('done-reload', format(t('done.reload'), { seconds: countdown })))
      } else if (overflow !== null) {
        // The one irreversible question this dialog asks.
        body.push(React.createElement('h3', { key: 'overflow', style: { margin: '0 0 6px', fontSize: 13 } }, t('overflow.title')))
        body.push(hint('overflow-body', format(t('overflow.body'), {
          incoming: formatBytes(overflow.incomingBytes ?? 0),
          cap: formatBytes(overflow.maxBytes ?? 0),
          used: formatBytes(overflow.usedBytes ?? 0),
        })))
        if (overflow.onlyPurge === true) body.push(hint('overflow-only', t('overflow.onlyPurge')))
        const options = []
        options.push(checkLine({
          key: 'opt-purge',
          checked: overflowChoice === 'purge',
          onChange: () => { setOverflowChoice('purge') },
          label: t('overflow.option.purge'),
          hintText: t('overflow.option.purgeHint'),
        }))
        if (overflow.onlyPurge !== true) {
          options.push(checkLine({
            key: 'opt-empty',
            checked: overflowChoice === 'empty',
            onChange: () => { setOverflowChoice('empty') },
            label: t('overflow.option.empty'),
            hintText: t('overflow.option.emptyHint'),
          }))
        }
        body.push(React.createElement('div', { key: 'overflow-options', style: { marginTop: 8, display: 'grid', gap: 2 } }, options))
        body.push(React.createElement('div', { key: 'overflow-ack', style: { marginTop: 10 } },
          React.createElement(Checkbox, {
            checked: acknowledged,
            onChange: setAcknowledged,
            modalAutofocus: true,
            label: t('overflow.ack'),
          })))
        if (failure !== null) {
          body.push(React.createElement('p', {
            key: 'overflow-failure',
            role: 'alert',
            style: { margin: '8px 0 0', fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' },
          }, format(t('failed'), { reason: failure })))
        }
      } else if (scanError !== null) {
        body.push(hint('scan-failed', format(t('dialog.scanFailed'), { reason: scanError })))
      } else if (plan === null) {
        body.push(hint('scanning', t('dialog.scanning')))
      } else {
        // 1. The conversation files themselves.
        body.push(section('record', t('section.record')))
        const directories = plan.store?.directories ?? []
        if (directories.length === 0) body.push(hint('record-none', t('record.none')))
        else {
          body.push(hint('record-summary', format(t('record.summary'), {
            dirs: directories.length,
            bytes: formatBytes(plan.store?.bytes ?? 0),
          })))
          body.push(pathList('record-paths', directories))
        }
        const cache = plan.projectionCache
        body.push(hint('record-cache', cache?.exists === true
          ? format(t('record.cache'), { bytes: formatBytes(cache.bytes ?? 0) })
          : t('record.cacheNone')))

        // 2. Subagent conversations, which lose their only entry point with the parent.
        const children = plan.children ?? []
        if (children.length > 0) {
          body.push(section('children', t('section.children')))
          body.push(hint('children-hint', t('children.hint')))
          body.push(React.createElement('div', { key: 'children-list', style: { display: 'grid', gap: 2, marginTop: 4 } },
            children.map(child => checkLine({
              key: child.sessionId,
              checked: (childIds ?? []).includes(child.sessionId),
              onChange: () => { toggleIn(setChildIds, childIds, child.sessionId) },
              label: `${child.title ?? child.sessionId}${child.running === true ? ` · ${t('children.running')}` : ''}`,
              hintText: `${child.sessionId} · ${format(t('children.bytes'), { bytes: formatBytes(child.bytes) })}`,
            }))))
        }

        // 3. Produced files, each individually selectable and inspectable.
        body.push(section('artifacts', t('section.artifacts')))
        const artifacts = plan.artifacts?.items ?? []
        if (artifacts.length === 0) body.push(hint('artifacts-none', t('artifacts.none')))
        else {
          const selectedArtifacts = (artifactIds ?? []).filter(id => artifacts.some(row => row.id === id))
          body.push(hint('artifacts-summary', format(t('artifacts.summary'), {
            count: selectedArtifacts.length,
            bytes: formatBytes(artifacts.filter(row => selectedArtifacts.includes(row.id)).reduce((sum, row) => sum + (row.bytes ?? 0), 0)),
          })))
          body.push(toolbar('artifacts-toolbar', [
            tinyButton('all', t('select.all'), () => { setArtifactIds(artifacts.map(row => row.id)) }),
            tinyButton('none', t('select.none'), () => { setArtifactIds([]) }),
          ]))
          const visible = artifacts.filter(row => matches(row, needle))
          body.push(React.createElement('div', {
            key: 'artifacts-list',
            style: { maxHeight: 200, overflowY: 'auto', display: 'grid', gap: 2, paddingRight: 4 },
          }, visible.length === 0
            ? hint('search-none', t('search.none'))
            : visible.map(row => React.createElement(FileRow, {
              key: row.id,
              idPrefix: 'a',
              row,
              kind: 'artifact',
              checked: (artifactIds ?? []).includes(row.id),
              onToggle: () => { toggleIn(setArtifactIds, artifactIds, row.id) },
              open: openDetails[row.id] === true,
              onToggleDetail: () => {
                setOpenDetails((current) => ({ ...current, [row.id]: current[row.id] !== true }))
              },
              t,
            }))))
          if (artifacts.length > MAX_LISTED) {
            body.push(hint('artifacts-more', format(t('artifacts.more'), { count: artifacts.length - MAX_LISTED })))
          }
        }
        if ((plan.artifacts?.refused?.length ?? 0) > 0) {
          body.push(hint('artifacts-refused', format(t('artifacts.refused'), { count: plan.artifacts.refused.length })))
        }

        // 4. Files it only read. Unselected by default: reading a source file is
        //    not producing it, and deleting one silently would be a trap.
        body.push(section('referenced', t('section.referenced')))
        body.push(React.createElement('p', {
          key: 'referenced-warning',
          style: {
            display: 'flex',
            gap: 6,
            alignItems: 'flex-start',
            margin: '2px 0 6px',
            fontSize: 11,
            color: 'var(--dsw-alias-state-warn-primary)',
          },
        }, [
          React.createElement(IconWarningOutlineRegular, { key: 'icon', size: 13 }),
          React.createElement('span', { key: 'text' }, t('referenced.warning')),
        ]))
        const referenced = plan.referenced?.items ?? []
        if (referenced.length === 0) body.push(hint('referenced-none', t('referenced.none')))
        else {
          body.push(hint('referenced-summary', format(t('referenced.summary'), {
            count: referencedIds.length,
            bytes: formatBytes(referenced.filter(row => referencedIds.includes(row.id)).reduce((sum, row) => sum + (row.bytes ?? 0), 0)),
          })))
          body.push(toolbar('referenced-toolbar', [
            tinyButton('all', t('select.all'), () => { setReferencedIds(referenced.map(row => row.id)) }),
            tinyButton('none', t('select.none'), () => { setReferencedIds([]) }),
          ]))
          const visible = referenced.filter(row => matches(row, needle))
          body.push(React.createElement('div', {
            key: 'referenced-list',
            style: { maxHeight: 180, overflowY: 'auto', display: 'grid', gap: 2, paddingRight: 4 },
          }, visible.length === 0
            ? hint('search-none', t('search.none'))
            : visible.map(row => React.createElement(FileRow, {
              key: row.id,
              idPrefix: 'r',
              row,
              kind: 'referenced',
              checked: referencedIds.includes(row.id),
              onToggle: () => { toggleIn(setReferencedIds, referencedIds, row.id) },
              open: openDetails[row.id] === true,
              onToggleDetail: () => {
                setOpenDetails((current) => ({ ...current, [row.id]: current[row.id] !== true }))
              },
              t,
            }))))
          if (referenced.length > MAX_LISTED) {
            body.push(hint('referenced-more', format(t('referenced.more'), { count: referenced.length - MAX_LISTED })))
          }
        }
        if ((plan.referenced?.refused?.length ?? 0) > 0) {
          body.push(hint('referenced-refused', format(t('referenced.refused'), { count: plan.referenced.refused.length })))
        }

        // A single filter box serves both lists; it lives above them in reading
        // order even though it is rendered here to keep the code linear.
        body.push(React.createElement('input', {
          key: 'search',
          type: 'search',
          value: needle,
          placeholder: t('search.placeholder'),
          onChange: (event) => { setNeedle(event.target.value) },
          style: {
            width: '100%',
            boxSizing: 'border-box',
            marginTop: 6,
            padding: '4px 8px',
            fontSize: 12,
            borderRadius: 6,
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-layer-2)',
            color: 'var(--dsw-alias-label-primary)',
          },
        }))

        // 5. Attachment objects.
        const attachmentIds = plan.attachments?.ids ?? []
        if (attachmentIds.length > 0) {
          body.push(section('attachments', t('section.attachments')))
          body.push(checkLine({
            key: 'attachments',
            checked: includeAttachments,
            onChange: () => { setIncludeAttachments(!includeAttachments) },
            label: format(t('attachments.summary'), { count: attachmentIds.length }),
          }))
        } else {
          body.push(section('attachments', t('section.attachments')))
          body.push(hint('attachments-none', t('attachments.none')))
        }

        // 6. Working directory, running state, and recycle-bin headroom.
        body.push(hint('cwd', plan.cwd === undefined || plan.cwd === null
          ? t('dialog.noCwd')
          : format(t('dialog.cwd'), { path: plan.cwd })))
        if (plan.live === true) {
          body.push(React.createElement('p', {
            key: 'live',
            style: {
              display: 'flex',
              gap: 6,
              alignItems: 'center',
              margin: '6px 0',
              fontSize: 12,
              color: 'var(--dsw-alias-state-warn-primary)',
            },
          }, [
            React.createElement(IconWarningOutlineRegular, { key: 'icon', size: 14 }),
            React.createElement('span', { key: 'text' }, t('dialog.live')),
          ]))
        }
        const trash = plan.trash ?? {}
        body.push(hint('trash-summary', (trash.maxBytes ?? 0) > 0
          ? format(t('trash.summary'), {
            used: formatBytes(trash.usedBytes ?? 0),
            cap: formatBytes(trash.maxBytes ?? 0),
            days: trash.retentionDays ?? 0,
          })
          : format(t('trash.summaryUnlimited'), { used: formatBytes(trash.usedBytes ?? 0) })))

        if (failure !== null) {
          body.push(React.createElement('p', {
            key: 'failure',
            role: 'alert',
            style: { margin: '8px 0 0', fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' },
          }, format(t('failed'), { reason: failure })))
        }
        body.push(hint('recover-hint', t('confirm.recoverHint')))
      }

      const done = result !== null && result.ok
      let footer
      if (done) {
        footer = [
          React.createElement(Button, {
            key: 'reload',
            variant: 'outline',
            onClick: () => { window.location.reload() },
          }, t('done.reloadNow')),
        ]
      } else if (overflow !== null) {
        footer = [
          React.createElement(Button, {
            key: 'cancel',
            variant: 'outline',
            disabled: busy,
            onClick: () => { setOverflow(null); setAcknowledged(false); setFailure(null) },
          }, t('dialog.cancel')),
          React.createElement(Button, {
            key: 'permanent',
            variant: 'primary',
            disabled: busy || acknowledged !== true,
            style: DANGER_BUTTON_STYLE,
            onClick: () => {
              submit(overflowChoice === 'purge'
                ? { permanent: true, confirm: true, onOverflow: 'purge' }
                : { confirm: true, onOverflow: 'empty-trash' })
            },
          }, busy
            ? t('confirm.deleting')
            : overflowChoice === 'purge' ? t('overflow.confirm.purge') : t('overflow.confirm.empty')),
        ]
      } else {
        footer = [
          React.createElement(Button, {
            key: 'cancel',
            variant: 'outline',
            disabled: busy,
            onClick: close,
          }, t('dialog.cancel')),
          React.createElement(Button, {
            key: 'confirm',
            variant: 'primary',
            disabled: busy || plan === null || scanError !== null,
            onClick: () => { submit() },
          }, busy ? t('confirm.deleting') : t('confirm.trash')),
        ]
      }

      return React.createElement(Modal, {
        open: true,
        onClose: close,
        title: t('dialog.title'),
        closeLabel: t('dialog.close'),
        description: format(t('dialog.subtitle'), { title }),
        className: DIALOG_CLASS,
        contentClassName: CONTENT_CLASS,
        footer: React.createElement(React.Fragment, null, footer),
      }, React.createElement('div', null, body))
    }

    /** The recycle-bin panel. */
    function TrashDialog({ trashStore, t }) {
      const request = React.useSyncExternalStore(trashStore.subscribe, trashStore.getSnapshot)
      if (request === null) return null
      return React.createElement(DialogBoundary, { t, title: t('trash.title'), closeLabel: t('trash.close') },
        React.createElement(TrashForm, { key: String(request.nonce), trashStore, t }))
    }

    /**
     * The recycle-bin body: groups, their files, restore, permanent delete, and
     * the two settings.
     *
     * Every irreversible action here is gated by one shared confirmation card
     * (`pending`), which carries the acknowledgement checkbox and a danger
     * button. The card is also where a failure is shown, because it is what the
     * user is looking at when the request fails.
     */
    function TrashForm({ trashStore, t }) {
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [expanded, setExpanded] = React.useState({})
      const [openDetails, setOpenDetails] = React.useState({})
      const [pending, setPending] = React.useState(null)
      const [acknowledged, setAcknowledged] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      const [retention, setRetention] = React.useState('')
      const [maxMegabytes, setMaxMegabytes] = React.useState('')

      const applyState = React.useCallback((payload) => {
        setState(payload)
        setRetention(String(payload.settings?.retentionDays ?? 0))
        const bytes = payload.settings?.maxBytes ?? 0
        setMaxMegabytes(String(Math.round(bytes / (1024 * 1024))))
      }, [])

      const load = React.useCallback(() => {
        setError(null)
        setLoading(true)
        callHost('/trash/list', {})
          .then((payload) => { applyState(payload) })
          .catch((failure) => { setError(failure instanceof Error ? failure.message : String(failure)) })
          .finally(() => { setLoading(false) })
      }, [applyState])

      React.useEffect(() => { load() }, [load])

      const inFlight = React.useRef(false)
      const run = (path, body, onDone) => {
        if (inFlight.current) return
        inFlight.current = true
        setBusy(true)
        setError(null)
        callHost(path, body)
          .then((payload) => {
            setNotice(onDone(payload))
            setPending(null)
            setAcknowledged(false)
            load()
          })
          .catch((failure) => { setError(failure instanceof Error ? failure.message : String(failure)) })
          .finally(() => {
            inFlight.current = false
            setBusy(false)
          })
      }

      const closePanel = () => {
        if (busy) return
        trashStore.close()
      }

      const toggleExpanded = (key) => {
        setExpanded((current) => ({ ...current, [key]: current[key] !== true }))
        // The first expand fetches that group's files; the list route returns
        // them only for the group it was asked about.
        if (expanded[key] !== true) {
          callHost('/trash/list', { groupKey: key })
            .then((payload) => { setState(payload) })
            .catch(() => {})
        }
      }

      const body = []
      if (error !== null && pending === null) {
        body.push(hint('error', format(t('trash.failed'), { reason: error })))
      } else if (state === null) {
        body.push(hint('loading', t('trash.loading')))
      } else {
        const settings = state.settings ?? {}
        const used = state.bytes ?? 0
        const cap = state.maxBytes ?? 0
        body.push(hint('used', cap > 0
          ? format(t('trash.used'), { used: formatBytes(used), cap: formatBytes(cap) })
          : format(t('trash.usedUnlimited'), { used: formatBytes(used) })))
        if (state.overCapacity === true) {
          body.push(React.createElement('p', {
            key: 'over',
            style: { margin: '4px 0', fontSize: 12, color: 'var(--dsw-alias-state-warn-primary)' },
          }, format(t('trash.overCapacity'), { used: formatBytes(used), cap: formatBytes(cap) })))
        }
        // `trash.description` is the modal's own subtitle; repeating it in the
        // body put the same sentence on screen twice.

        if (pending !== null) {
          // The shared irreversible-action card.
          body.push(section('confirm', t('trash.confirmTitle')))
          body.push(hint('confirm-body', pending.body))
          if (error !== null) {
            body.push(React.createElement('p', {
              key: 'confirm-error',
              role: 'alert',
              style: { margin: '8px 0 0', fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' },
            }, format(t('failed'), { reason: error })))
          }
          body.push(React.createElement('div', { key: 'confirm-ack', style: { marginTop: 8 } },
            React.createElement(Checkbox, {
              checked: acknowledged,
              onChange: setAcknowledged,
              modalAutofocus: true,
              label: t('trash.confirmAck'),
            })))
        } else if ((state.groups ?? []).length === 0) {
          body.push(hint('empty', t('trash.empty')))
        } else {
          const groups = state.groups ?? []
          body.push(React.createElement('div', {
            key: 'groups',
            style: { maxHeight: 320, overflowY: 'auto', display: 'grid', gap: 6, marginTop: 6, paddingRight: 4 },
          }, groups.map((group) => {
            const isOpen = expanded[group.groupKey] === true
            const title = group.title ?? group.sessionId ?? group.groupKey
            const rows = []
            // Two stacked lines rather than one grid row: with the title, the
            // item count, the deletion date, the expiry, and two buttons all
            // competing for one line, the buttons overlapped the title as soon
            // as the dialog was narrower than its content wanted. Line one is
            // the title (it can ellipsize), line two wraps whatever else fits.
            rows.push(React.createElement('div', {
              key: 'head',
              style: { display: 'grid', gap: 4 },
            }, [
              React.createElement('button', {
                key: 'toggle',
                type: 'button',
                onClick: () => { toggleExpanded(group.groupKey) },
                'aria-expanded': isOpen,
                'aria-label': title,
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  minWidth: 0,
                  padding: 0,
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--dsw-alias-label-secondary)',
                  cursor: 'pointer',
                  textAlign: 'left',
                },
              }, [
                React.createElement(isOpen ? IconChevronDownOutlineRegular : IconChevronRightOutlineRegular, { key: 'chev', size: 14 }),
                React.createElement('span', {
                  key: 'title',
                  style: {
                    flex: '1 1 auto',
                    minWidth: 0,
                    fontSize: 12,
                    color: 'var(--dsw-alias-label-primary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  },
                }, title),
              ]),
              React.createElement('div', {
                key: 'bar',
                style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px' },
              }, [
                React.createElement('span', {
                  key: 'meta',
                  style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
                }, format(t('trash.group.meta'), { count: group.itemCount ?? 0, date: formatDate(group.deletedAt) })),
                React.createElement('span', {
                  key: 'expiry',
                  style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
                }, group.expiresAt === null || group.expiresAt === undefined
                  ? t('trash.group.never')
                  : format(t('trash.group.expires'), { date: formatDate(group.expiresAt) })),
                React.createElement('span', {
                  key: 'actions',
                  style: { display: 'inline-flex', flexWrap: 'wrap', gap: 4, marginLeft: 'auto' },
                }, [
                  tinyButton('restore', t('trash.restore'), () => {
                    run('/trash/restore', { groupKey: group.groupKey }, (payload) => format(t('trash.restored'), { count: payload.restored?.length ?? 0 }))
                  }, { disabled: busy, 'aria-label': `${t('trash.restore')} ${title}` }),
                  tinyButton('delete', t('trash.delete'), () => {
                    setPending({
                      kind: 'group',
                      groupKey: group.groupKey,
                      body: format(t('trash.confirmBodyGroup'), { count: group.itemCount ?? 0 }),
                    })
                    setAcknowledged(false)
                    setError(null)
                  }, {
                    disabled: busy,
                    style: DANGER_BUTTON_STYLE,
                    'aria-label': `${t('trash.delete')} ${title}`,
                  }),
                ]),
              ]),
            ]))
            if (isOpen) {
              const items = group.items ?? []
              rows.push(React.createElement('div', {
                key: 'items',
                style: { marginTop: 4, display: 'grid', gap: 4 },
              }, items.length === 0
                ? hint('items-loading', t('trash.loading'))
                : items.map(item => React.createElement(React.Fragment, { key: item.path }, [
                  React.createElement('div', {
                    key: 'row',
                    style: { display: 'grid', gap: 3, padding: '4px 6px', borderRadius: 5, background: 'var(--dsw-alias-bg-layer-1)' },
                  }, [
                    React.createElement('div', {
                      key: 'line',
                      style: { display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 },
                    }, [
                      React.createElement('span', {
                        key: 'path',
                        style: { ...PATH_STYLE, flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                        title: item.originalPath,
                      }, `${t(`trash.kind.${String(item.kind)}`)}: ${item.originalPath ?? item.path}`),
                      React.createElement('span', {
                        key: 'bytes',
                        style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' },
                      }, formatBytes(item.bytes)),
                    ]),
                    React.createElement('div', {
                      key: 'actions',
                      style: { display: 'flex', flexWrap: 'wrap', gap: 4 },
                    }, [
                      tinyButton('detail', t('detail.button'), () => {
                        setOpenDetails((current) => ({ ...current, [item.path]: current[item.path] !== true }))
                      }, { disabled: busy }),
                      tinyButton('restore', t('trash.restore'), () => {
                        run('/trash/restore', { groupKey: group.groupKey, itemPaths: [item.path] }, (payload) => format(t('trash.restored'), { count: payload.restored?.length ?? 0 }))
                      }, { disabled: busy }),
                      tinyButton('delete', t('trash.delete'), () => {
                        setPending({
                          kind: 'item',
                          groupKey: group.groupKey,
                          path: item.path,
                          body: t('trash.confirmBodyRow'),
                        })
                        setAcknowledged(false)
                        setError(null)
                      }, { disabled: busy, style: DANGER_BUTTON_STYLE }),
                    ]),
                  ]),
                  openDetails[item.path] === true
                    ? React.createElement('div', { key: 'detail' }, React.createElement(FileDetail, {
                      row: { ...item, path: item.originalPath },
                      kind: item.kind,
                      t,
                    }))
                    : null,
                ]))))
            }
            return React.createElement('div', {
              key: group.groupKey,
              style: {
                display: 'grid',
                gap: 2,
                padding: '6px 8px',
                borderRadius: 6,
                border: '1px solid var(--dsw-alias-border-l1)',
                background: 'var(--dsw-alias-bg-layer-2)',
              },
            }, rows)
          })))
          if ((state.total ?? 0) > groups.length) {
            body.push(hint('truncated', format(t('trash.truncated'), { count: (state.total ?? 0) - groups.length })))
          }
        }

        // Settings, always available: the cap and retention are what decide
        // whether the next deletion asks its question.
        body.push(section('settings', t('trash.settings')))
        body.push(React.createElement('div', {
          key: 'settings-grid',
          style: { display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: '6px 10px', alignItems: 'center' },
        }, [
          React.createElement('label', { key: 'l1', htmlFor: 'dsh-plugin-remover-retention', style: { fontSize: 12 } }, t('trash.retention')),
          React.createElement('input', {
            key: 'i1',
            id: 'dsh-plugin-remover-retention',
            type: 'number',
            min: 0,
            max: 3650,
            value: retention,
            disabled: busy,
            onChange: (event) => { setRetention(event.target.value) },
            style: { width: 120, padding: '3px 6px', fontSize: 12, borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)' },
          }),
          React.createElement('span', { key: 'h1', style: { gridColumn: '2', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, t('trash.retentionHint')),
          React.createElement('label', { key: 'l2', htmlFor: 'dsh-plugin-remover-maxmb', style: { fontSize: 12 } }, t('trash.maxBytes')),
          React.createElement('input', {
            key: 'i2',
            id: 'dsh-plugin-remover-maxmb',
            type: 'number',
            min: 0,
            value: maxMegabytes,
            disabled: busy,
            onChange: (event) => { setMaxMegabytes(event.target.value) },
            style: { width: 120, padding: '3px 6px', fontSize: 12, borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)' },
          }),
          React.createElement('span', { key: 'h2', style: { gridColumn: '2', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, t('trash.maxBytesHint')),
        ]))
        body.push(toolbar('settings-actions', [
          tinyButton('save', t('trash.save'), () => {
            const days = Number(retention)
            const megabytes = Number(maxMegabytes)
            run('/trash/settings', {
              retentionDays: Number.isFinite(days) ? days : 0,
              maxBytes: Number.isFinite(megabytes) ? megabytes * 1024 * 1024 : 0,
            }, () => t('trash.saved'))
          }, { disabled: busy }),
        ]))
        if (notice !== null) body.push(hint('notice', notice))
      }

      let footer
      if (pending !== null) {
        footer = [
          React.createElement(Button, {
            key: 'cancel',
            variant: 'outline',
            disabled: busy,
            onClick: () => { setPending(null); setAcknowledged(false); setError(null) },
          }, t('dialog.cancel')),
          React.createElement(Button, {
            key: 'confirm',
            variant: 'primary',
            disabled: busy || acknowledged !== true,
            style: DANGER_BUTTON_STYLE,
            onClick: () => {
              if (pending.kind === 'all') {
                run('/trash/delete', { all: true, confirm: true }, () => t('trash.confirmed'))
              } else if (pending.kind === 'group') {
                run('/trash/delete', { groupKeys: [pending.groupKey], confirm: true }, () => t('trash.confirmed'))
              } else {
                run('/trash/delete', { items: [{ groupKey: pending.groupKey, path: pending.path }], confirm: true }, () => t('trash.confirmed'))
              }
            },
          }, busy ? t('confirm.deleting') : t('trash.delete')),
        ]
      } else {
        footer = [
          React.createElement(Button, {
            key: 'empty',
            variant: 'primary',
            style: DANGER_BUTTON_STYLE,
            disabled: busy || state === null || (state.groups ?? []).length === 0,
            onClick: () => {
              setPending({ kind: 'all', body: t('trash.confirmBodyAll') })
              setAcknowledged(false)
              setError(null)
            },
          }, t('trash.emptyAll')),
          React.createElement(Button, {
            key: 'refresh',
            variant: 'outline',
            disabled: busy || loading,
            onClick: load,
          }, t('trash.refresh')),
          React.createElement(Button, {
            key: 'close',
            variant: 'outline',
            onClick: closePanel,
          }, t('trash.close')),
        ]
      }

      return React.createElement(Modal, {
        open: true,
        onClose: closePanel,
        title: t('trash.title'),
        closeLabel: t('trash.close'),
        description: t('trash.description'),
        className: NARROW_DIALOG_CLASS,
        contentClassName: CONTENT_CLASS,
        footer: React.createElement(React.Fragment, null, footer),
      }, React.createElement('div', null, body))
    }

    /** The hidden subagent-conversation panel. */
    function HiddenDialog({ hiddenStore, purgeStore, t }) {
      const request = React.useSyncExternalStore(hiddenStore.subscribe, hiddenStore.getSnapshot)
      if (request === null) return null
      return React.createElement(DialogBoundary, { t, title: t('hidden.title'), closeLabel: t('hidden.close') },
        React.createElement(HiddenForm, {
          key: String(request.nonce),
          hiddenStore,
          purgeStore,
          t,
        }))
    }

    /**
     * The hidden-conversation list.
     *
     * Deleting a row here opens the same delete dialog every other entry uses,
     * so the subagent path is not a second, less careful implementation: it gets
     * the same plan, the same per-file selection, and the same recycle bin.
     */
    function HiddenForm({ hiddenStore, purgeStore, t }) {
      const [rows, setRows] = React.useState(null)
      const [total, setTotal] = React.useState(0)
      const [error, setError] = React.useState(null)
      const [loading, setLoading] = React.useState(false)

      const load = React.useCallback(() => {
        setError(null)
        setLoading(true)
        callHost('/hidden', {})
          .then((payload) => {
            setRows(payload.rows ?? [])
            setTotal(payload.total ?? 0)
          })
          .catch((failure) => { setError(failure instanceof Error ? failure.message : String(failure)) })
          .finally(() => { setLoading(false) })
      }, [])

      React.useEffect(() => { load() }, [load])

      const body = []
      if (error !== null) body.push(hint('error', format(t('hidden.failed'), { reason: error })))
      else if (loading || rows === null) body.push(hint('loading', t('hidden.loading')))
      else if (rows.length === 0) body.push(hint('none', t('hidden.none')))
      else {
        body.push(hint('count', format(t('hidden.count'), { count: total })))
        body.push(React.createElement('div', {
          key: 'rows',
          style: { display: 'grid', gap: 6, maxHeight: 320, overflowY: 'auto', marginTop: 6, paddingRight: 4 },
        }, rows.map(row => React.createElement('div', {
          key: row.sessionId,
          style: {
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) auto',
            gap: 8,
            alignItems: 'center',
            padding: '6px 8px',
            borderRadius: 6,
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-layer-2)',
          },
        }, [
          React.createElement('div', { key: 'text', style: { minWidth: 0 } }, [
            React.createElement('div', {
              key: 'title',
              style: { fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            }, row.title ?? row.sessionId),
            React.createElement('div', {
              key: 'meta',
              style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginTop: 2 },
            }, [
              row.parentPresent === true
                ? format(t('hidden.parent'), { title: row.parentTitle ?? row.parentSession ?? '?' })
                : t('hidden.orphan'),
              ` · ${format(t('hidden.bytes'), { bytes: formatBytes(row.bytes ?? 0) })}`,
              row.running === true ? ` · ${t('hidden.running')}` : '',
            ].join('')),
          ]),
          React.createElement(Button, {
            key: 'delete',
            variant: 'outline',
            // Without this every row button reads just "Delete", leaving a
            // screen-reader user no way to tell one row from another.
            'aria-label': format(t('hidden.deleteRow'), { title: row.title ?? row.sessionId }),
            onClick: () => {
              hiddenStore.close()
              purgeStore.open({ sessionId: row.sessionId, displayTitle: row.title ?? row.sessionId })
            },
          }, t('hidden.delete')),
        ]))))
        if (total > rows.length) {
          body.push(hint('truncated', format(t('hidden.truncated'), { count: total - rows.length })))
        }
      }

      const footer = [
        React.createElement(Button, {
          key: 'refresh',
          variant: 'outline',
          disabled: loading,
          onClick: load,
        }, t('hidden.refresh')),
        React.createElement(Button, {
          key: 'close',
          variant: 'outline',
          onClick: () => { hiddenStore.close() },
        }, t('hidden.close')),
      ]

      return React.createElement(Modal, {
        open: true,
        onClose: () => { hiddenStore.close() },
        title: t('hidden.title'),
        closeLabel: t('hidden.close'),
        description: t('hidden.description'),
        className: NARROW_DIALOG_CLASS,
        contentClassName: CONTENT_CLASS,
        footer: React.createElement(React.Fragment, null, footer),
      }, React.createElement('div', null, body))
    }

    /**
     * The plugin's own section on its page in Plugins.
     *
     * This is the surface that makes every deletable conversation reachable:
     * the row menu needs a Session row, and the sidebar never renders one for a
     * subagent conversation. A section on the plugin's page needs no Session at
     * all, so it is where the recycle bin, the hidden-conversation list, the
     * retention settings, and the sidebar-entry switch live.
     *
     * It renders nothing for any other bundle's page.
     *
     * @param props - the page subject, and this plugin's stores.
     */
    function PluginsSection({ subject, trashStore, hiddenStore, sidebarResource, t }) {
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [saving, setSaving] = React.useState(false)

      const load = React.useCallback(() => {
        setError(null)
        Promise.all([callHost('/trash/list', {}), callHost('/hidden', {})])
          .then(([trash, hidden]) => {
            setState({ trash, hidden })
            // The sidebar entry reads the same settings; publishing them here
            // saves it a request and keeps the two surfaces from disagreeing.
            sidebarResource.set(trash)
          })
          .catch((failure) => { setError(failure instanceof Error ? failure.message : String(failure)) })
      }, [sidebarResource])

      React.useEffect(() => {
        // Only this bundle's page carries the section; another bundle's page
        // must not fire this plugin's requests.
        if (subject?.kind !== 'bundle' || subject?.pkg?.name !== NS) return
        load()
      }, [subject?.kind, subject?.pkg?.name, load])

      if (subject?.kind !== 'bundle' || subject?.pkg?.name !== NS) return null

      /** Flip the sidebar entry; the sidebar re-renders from the same store. */
      const toggleSidebarEntry = (next) => {
        if (saving) return
        setSaving(true)
        // The checkbox and the sidebar both read this setting, so they are the
        // feedback: a success needs no toast, and a failure is reported below.
        callHost('/trash/settings', { showSidebarTrash: next })
          .then((payload) => {
            setState((current) => (current === null ? current : { ...current, trash: { ...current.trash, settings: payload.settings } }))
            sidebarResource.set({ ...(sidebarResource.getSnapshot().value ?? {}), settings: payload.settings })
          })
          .catch((failure) => { setError(failure instanceof Error ? failure.message : String(failure)) })
          .finally(() => { setSaving(false) })
      }

      const body = []
      body.push(React.createElement('h3', { key: 'title', style: { margin: '0 0 4px', fontSize: 13 } }, t('panel.title')))
      body.push(hint('hint', t('panel.hint')))

      if (error !== null) body.push(hint('error', format(t('panel.failed'), { reason: error })))
      else if (state === null) body.push(hint('loading', t('panel.loading')))
      else {
        const trash = state.trash ?? {}
        const hidden = state.hidden ?? {}
        const groups = trash.groups ?? []
        const bytes = trash.bytes ?? 0
        const cap = trash.settings?.maxBytes ?? 0
        const days = trash.settings?.retentionDays ?? 0
        const rows = hidden.total ?? (hidden.rows ?? []).length
        const lines = [
          {
            key: 'trash',
            label: t('panel.trash'),
            value: groups.length === 0 ? t('panel.trashEmpty') : format(t('panel.trashValue'), { count: groups.length, bytes: formatBytes(bytes) }),
            onOpen: () => { trashStore.open() },
          },
          {
            key: 'hidden',
            label: t('panel.hidden'),
            value: format(t('panel.hiddenValue'), { count: rows }),
            onOpen: () => { hiddenStore.open() },
          },
          {
            key: 'settings',
            label: t('panel.settings'),
            value: cap > 0
              ? format(t('panel.settingsValue'), { days, cap: formatBytes(cap) })
              : t('panel.settingsValueUnlimited'),
            onOpen: () => { trashStore.open() },
          },
        ]
        body.push(React.createElement('div', {
          key: 'lines',
          style: { display: 'grid', gap: 4, marginTop: 8 },
        }, lines.map(line => React.createElement('div', {
          key: line.key,
          style: {
            display: 'grid',
            gridTemplateColumns: 'auto minmax(0, 1fr) auto',
            gap: 10,
            alignItems: 'center',
            padding: '6px 8px',
            borderRadius: 6,
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-layer-2)',
          },
        }, [
          React.createElement('span', { key: 'label', style: { fontSize: 12 } }, line.label),
          React.createElement('span', {
            key: 'value',
            style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          }, line.value),
          React.createElement(Button, {
            key: 'open',
            variant: 'outline',
            size: 'sm',
            onClick: line.onOpen,
          }, t('panel.open')),
        ]))))
        if (trash.overCapacity === true) {
          body.push(hint('over', t('panel.overflow')))
        }
        // The sidebar entry is the only surface that exists on every page, so
        // whether it shows is a setting rather than a hard-coded choice.
        body.push(React.createElement('div', {
          key: 'sidebar-toggle',
          style: { marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--dsw-alias-border-l1)' },
        }, [
          React.createElement(Checkbox, {
            key: 'check',
            checked: trash.settings?.showSidebarTrash !== false,
            disabled: saving,
            onChange: (checked) => { toggleSidebarEntry(checked === true) },
            label: t('panel.showInSidebar'),
          }),
          hint('sidebar-toggle-hint', t('panel.showInSidebarHint')),
        ]))
        body.push(toolbar('actions', [
          tinyButton('refresh', t('panel.refresh'), load),
        ]))
      }

      return React.createElement('div', {
        style: { padding: '2px 0 8px' },
      }, body)
    }

    /**
     * Put this plugin's one stylesheet in the document head.
     *
     * The dialogs need geometry the shipped `Modal` cannot be given through its
     * props (it takes class names, not styles), so the rules go in a `<style>`
     * element instead of inline. Registering it inside an effect means disposal
     * removes it, and the `document` guard keeps the module loadable where there
     * is no DOM at all (the offline suite).
     *
     * @returns the cleanup function.
     */
    function mountStyles() {
      if (typeof document === 'undefined' || document === null) return () => {}
      const existing = document.getElementById(STYLE_ID)
      if (existing !== null) existing.remove()
      const element = document.createElement('style')
      element.id = STYLE_ID
      element.textContent = STYLE_TEXT
      document.head.appendChild(element)
      return () => { element.remove() }
    }

    /**
     * @param ctx - client plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), `${NS}: dictionaries`)
      ctx.effect(() => mountStyles(), `${NS}: stylesheet`)
      const purgeStore = createStore()
      const trashStore = createStore()
      const hiddenStore = createStore()
      const sidebarResource = createResource(() => callHost('/trash/settings', {}))

      ctx.effect(() => ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.menu.item',
        id: 'remover-session',
        // The shipped Archive row is order 400; 410 puts this row right after
        // it, before any plugin that appends at 500+.
        order: 410,
        locale: NS,
        inject: () => ({ purgeStore }),
      }, PurgeMenuItem)), `${NS}: session row menu`)

      // The recycle-bin shortcut at the foot of the sidebar, above the shipped
      // Settings row. It is the only entry point that needs neither a Session
      // row nor the plugin's page to be open; the user can switch it off from
      // the plugin page, and it stays on while that setting is unreadable.
      ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'remover-trash-foot',
        // The shipped footer occupants start at 100; 150 keeps this beside them
        // and before anything a later plugin appends.
        order: 150,
        locale: NS,
        inject: () => ({ trashStore, sidebarResource }),
      }, TrashFooterButton)), `${NS}: sidebar recycle-bin entry`)

      // The reachable surface for hidden conversations. A row menu needs a
      // Session row, and the harness never renders one for a subagent Session;
      // a section on this plugin's own page needs no Session at all.
      ctx.effect(() => ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
        name: 'plugins.detail.section',
        id: 'remover-trash',
        locale: NS,
        inject: () => ({ trashStore, hiddenStore, sidebarResource }),
      }, PluginsSection)), `${NS}: plugins page section`)

      // All three dialogs render from the overlay so the page's own layout and
      // stacking context cannot cut them off.
      ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'remover-dialog',
        locale: NS,
        inject: () => ({ purgeStore }),
      }, PurgeDialog)), `${NS}: delete dialog`)

      ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'remover-trash-dialog',
        locale: NS,
        inject: () => ({ trashStore }),
      }, TrashDialog)), `${NS}: trash dialog`)

      ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'remover-hidden-dialog',
        locale: NS,
        inject: () => ({ hiddenStore, purgeStore }),
      }, HiddenDialog)), `${NS}: hidden dialog`)
    }

    return { name: NS, inject: ['slots', 'locale'], apply }
  },
})
