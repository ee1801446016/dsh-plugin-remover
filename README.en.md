# dsh-plugin-remover

**Delete a conversation in DeepSeek Harness — together with what it left behind — and be able to take it back.**

The sidebar's session row menu gains a **Delete conversation…** item right below **Archive**. It lets you decide, item by item, what goes with it; deletion lands in a recycle bin by default, restorable as a whole group or one file at a time.


## The problem it solves

The persistence layer has no deletion API at all:

- `@deepseek-ai/dsh-session-persistence`: *"No deletion or retention API — pruning stored sessions is out-of-band backend maintenance."*
- `@deepseek-ai/dsh-session-persistence-jsonl`: *"Nothing deletes session files."*
- `@deepseek-ai/dsh-attachment-local`: attachment objects are never collected, and there is no unreferenced-object sweep.

Two kinds of conversation are also **unreachable through the UI**:

- **Subagent conversations** are filtered out of the sidebar by the harness (`sessionVisible()` returns false for `origin === 'subagent'`). No row means no row menu, so any delete item attached to a row menu cannot reach them.
- Once the parent is deleted, a subagent conversation loses even the conversation header's subagent switcher, which was its only entry point; its id becomes an unreadable directory name on disk.

This plugin therefore provides three surfaces and makes deletion reversible.

## Surfaces

### 1. The conversation row menu

Hover any sidebar conversation row → **⋯** at its end → the item directly below **Archive** is **Delete conversation…**.

### 2. The foot of the sidebar

Above the **Settings** row at the bottom of the sidebar sits a recycle-bin button: an icon plus the label when the sidebar is expanded, a square icon in the 56 px rail. It opens the recycle-bin panel directly.

This entry is present on **every page**, needs no conversation row, and does not require the plugin page to be open first. It can be switched off from the plugin's detail page (below).

### 3. The plugin's detail page

**Plugins → Conversation remover and recycle bin** (the same page that installs and disables it). The page carries a section contributed by this plugin:

| Row | Value | "Open" shows |
|---|---|---|
| Recycle bin | N groups · size | the recycle-bin panel |
| Hidden subagent conversations | N | the hidden-conversation panel |
| Recycle-bin settings | retention · cap | the recycle-bin panel (settings area) |

At the bottom of that section is a **Show a recycle-bin entry in the sidebar** checkbox, ticked by default. Clearing it removes the sidebar button immediately, without a page refresh; the recycle bin stays reachable from this page — only the sidebar shortcut goes away.

This section **depends on no conversation row**, which is why both unreachable kinds above are reachable here. The row menu and the sidebar button are only conveniences.

### 4. Three dialogs

- **Delete dialog**: the scan result, the selections, and **Move to recycle bin**.
- **Recycle-bin panel**: groups, per-file detail, restore, permanent delete, and the three settings.
- **Hidden-conversation panel**: every subagent conversation, each deletable through the same delete dialog.

All three dialogs handle their own size and scrolling: the width follows the viewport (760 px at most for the delete dialog, 600 px for the other two), the height is capped to the viewport, the content column scrolls, and the header sticks. So even with every Details panel expanded, **Move to recycle bin** stays inside the viewport instead of being pushed off screen.

## What the delete dialog shows

Each section is ticked separately:

| Section | Default | Meaning |
|---|---|---|
| **Conversation files** | mandatory | The conversation's storage directories, plus its projection cache |
| **Subagent conversations** | all | Every subagent conversation it spawned, including grandchildren. Deleting the parent leaves them with no entry point, hence the default |
| **Files it produced** | all | Files written through `write`, `edit`, or `str_replace_editor` |
| **Files it referenced** | **none** | Files read through `read` or `read_image` but never written |
| **Attachment objects** | ticked | Images/files you dropped into the input; only those no other conversation references |

Both file lists are selectable **row by row**; anything unticked is untouched, byte for byte. Each has Select all / Select none and a path filter.

### The Details button

**Every selectable file has a Details toggle** that expands inline:

```
Source directory   D:\work space\TEST\_purge-patch\lib
Full path          D:\work space\TEST\_purge-patch\lib\index.js
Size               41.6 KB
From               "整合删除功能" (parent) · Written by write / edit ×3
                   "review-pass-2" (subagent) · Written by write ×1
```

- **Source directory** is the point: among many similarly named files, the directory is what identifies one.
- When several conversations wrote or read the same file, each is listed.
- For referenced files, "Written by" becomes "Read by".
- The panel expands **inline** rather than in a nested modal, because a modal inside a modal steals the focus trap. Long paths wrap on narrow screens.

Expanding a group in the recycle bin shows a Details toggle on each item too, with its original path and directory.

## Confirmation levels

| Action | Recoverable | Confirmation | Button |
|---|---|---|---|
| Delete a conversation (with subagents, produced files, referenced files, attachments) | yes, in the recycle bin | **none** | "Move to recycle bin", normal primary colour |
| Restore a group or a file | — | none | "Restore" |
| Empty the recycle bin | **no** | **tick "I understand permanent deletion cannot be undone"** | "Delete permanently", danger colour |
| Permanently delete a group or a file | **no** | **same** | "Delete permanently", danger colour |
| This deletion does not fit in the recycle bin | **no** | **same** | "Delete permanently", danger colour |
| Automatic retention cleanup | **no** | none (that is the configured rule) | — |

Once ticked, the button executes directly with no second confirmation.

## The recycle bin

### Location

Fixed at `<DSH_HOME>/dsh-plugin-remover/trash/`. When `DSH_HOME` is unset it is `.dsh` under your home directory.

One deletion is one group:

```
trash/
  settings.json                          # retention days, size cap, sidebar switch
  groups/<timestamp>-<sessionId>/
    manifest.json                        # the group's manifest; restore relies on it
    store/<project>/<sessionId>/         # conversation files (one directory item)
    artifacts/<n>/<original name>        # produced files
    referenced/<n>/<original name>       # referenced files
    attachments/<n>/<sha256>             # attachment objects
    cache/<sessionId>.json               # projection cache
```

A group is built under `<key>.partial` and renamed into place only once complete, so a crash cannot leave a group that looks restorable but is not.

### Across volumes

The recycle bin lives on `C:` while workspaces usually live elsewhere. `rename` cannot cross volumes, so that case does **copy → verify byte count → remove source**. On a size mismatch the source is kept and an error is reported — never a half-delete.

### Restoring

- **Whole group**: the Restore button on the group row.
- **Single file**: expand the group and use the Restore button on that row.
- Files go back to their **original paths**; an existing file there is **never overwritten** — that item reports "target already exists" and stays in the bin.

### Settings

| Setting | Default | Meaning |
|---|---|---|
| Retention days | **30** | Older groups are cleared automatically; `0` never clears |
| Size cap | **2 GB** | A deletion over the cap asks first; `0` means no cap |
| Sidebar entry | **on** | Whether the sidebar foot shows a recycle-bin button |

The first two apply to existing groups immediately (expiry is computed from the current retention, not stored). Out-of-range values are clamped (0–3650 days, 0–1 TiB). The third is a single checkbox whose effect is immediate: the sidebar re-renders as soon as it is flipped.

Each write touches **only the field it carries**: saving the retention does not reset the cap or the sidebar switch.

Expiry runs lazily on request (opening the panel, deleting), not on a resident timer.

### When the cap is exceeded

The plugin **never silently deletes older recycle-bin groups to make room** — that is exactly what a recycle bin exists to prevent. Instead it asks, before moving anything:

- how large this deletion is, the cap, and current usage;
- **Delete this permanently** — skips the bin;
- **Empty the recycle bin, then retry** — the existing contents go for good, then this deletion is stored as usual;
- if even an emptied bin could not hold it, only the permanent option remains, with an explanation.

That question carries a checkbox and a danger button. Because the check happens **before any file moves**, "it does not fit" never leaves a partial deletion behind.

## Safety boundaries (all enforced on the Host)

- **Session ids, group keys, and item paths** are validated as a single safe path segment / safe relative path before any path is built; `..`, absolute paths, and backslashes are rejected.
- **Produced and referenced files** are only touched when their real path lies **strictly inside** the recorded `cwd` of a conversation being deleted and **outside `DSH_HOME`**. Anything else — not a regular file, an unresolvable realpath such as a symlink pointing out, outside the working directory — is skipped and the reason is reported in the dialog.
- **The browser sends only a session id, the ids it ticked, and booleans** — never paths. The Host re-derives the whole plan from the stored logs, so a stale or tampered page cannot widen a deletion. An id the Host did not itself produce resolves to nothing.
- **Attachment objects** are removed only after every other stored conversation has been read and none references them; any read failure keeps them. Conversations being deleted together are excluded from that check, so a parent and child cannot protect each other's attachments.
- **`/plugins` routes are outside session authorization**, so every endpoint requires this plugin's marker header `x-dsh-plugin-remover: 1` and, when `Origin` is present, a same-origin check. A cross-site request cannot set that header without a preflight the server does not answer.
- **Permanent deletion requires `confirm: true`**, enforced by the Host; a request without it is refused.
- **Running conversations are stopped first**: subagents go through `subagents.interrupt` (they have no Workspace row to archive), ordinary conversations through `archiveSession({stopActivity: true})`. Files move only afterwards.

## Install / update / uninstall

A standard DSH bundle; `cordis.patch.yml` ships with it:

```yaml
- insert:
    - id: remover
      name: dsh-plugin-remover
```

The package ships a prebuilt `lib/` and declares **no `prepare` or `postinstall` script**, so
none of these install paths needs a build approval:

```sh
# from npm (recommended)
dsh plugin --profile <profile> add dsh-plugin-remover

# from the GitHub source
dsh plugin --profile <profile> add github:ee1801446016/dsh-plugin-remover

# from a local directory (a link install: edits take effect immediately)
dsh plugin --profile <profile> add ./dsh-plugin-remover
```

You can also use **Plugins → Add plugin** and pick a local directory.

- **Update**: disable and re-enable the bundle in the plugin manager — the Host half reloads without a full DSH
  restart. The browser half (`lib/client.js`) is pushed to open pages by HMR; refresh if needed. A version
  installed from npm can also be updated with the plugin manager's update button.
- **Uninstall**: disable or remove it in Plugins. The recycle-bin directory is **not** deleted — that is your
  data; clear `<DSH_HOME>/dsh-plugin-remover/trash/` yourself if you want.

## Known limitations

- **Only tool-call targets are recognized**: `write`, `edit`, `str_replace_editor`, `create_file`, `read`, `read_image`. Files created by shell redirection or a script inside `pwsh` / `bash` are **not** detected.
- **A running conversation's log may still be open**: it is stopped first, but on Windows an unreleased handle can make the move fail; the failure is reported and the source is kept — retry later.
- **Shared attachments**: content-addressed storage deduplicates, so one object may be referenced by several conversations. "Take its attachments too" will therefore keep some, by design.
- **List refresh**: the `api-session/removed` broadcast is best-effort; reloading the page is reliable, and the dialog does that after a successful deletion.
- **Cross-volume moves of large directories are slow**: attachments can reach hundreds of MB; the dialog shows "Moving to recycle bin…".
- **Verified against DSH `0.2.2-rc.3`** (desktop profile); `engines.dsh` therefore declares `>=0.2.2-rc.1 <0.3.0-0`. For another version, run the offline suites first and re-check the `sidebar.workspaces.session.menu.item`, `sidebar.footer.action`, `plugins.detail.section`, and `shell.overlay` slot contracts.
- **It depends on host client components**: `lib/client.js` takes `Button`, `Checkbox`, `Modal`, `MenuItemButton`, and a few icons from `@deepseek-ai/dsh-client-ui-primitives`. Those packages change without notice, and an upgrade that removes or renames one of those members leaves the slot entry failing to render (console: `slot entry crashed`). `verify-client.cjs` guards against importing anything unverified, but re-run the suites after a host upgrade.


## Structure and verification

| Path | Purpose |
|---|---|
| `lib/index.js` | Host half: plan derivation, selection, recycle bin, hidden conversations |
| `lib/client.js` | Browser half: delete dialog (with per-file details), recycle-bin panel, hidden panel, plugin-page section |
| `locale/` | Localized plugin name and description (`meta.title` / `meta.description`) |
| `icon.svg` | The icon shown on the plugin page |
| `verify/` | Four suites (Host offline / Client offline / live served bundle / end to end) |

Run them with:

```sh
node verify/verify-host.mjs     # Host half, offline, no DSH needed
node verify/verify-client.cjs   # Browser half, offline
node verify/verify-served.mjs   # Live; reads DSH_WEB_URL, SKIPs without one
```

End to end (really delete a conversation, then restore it from the bin):

```sh
node verify/seed-e2e.mjs                                  # seeds a synthetic conversation, prints its id
node verify/verify-e2e.mjs <the id it printed>             # delete → bin → restore → delete again → clear
```

`seed-e2e.mjs` writes one synthetic conversation in the backend's real format
under `<DSH_HOME>/sessions/` and `<DSH_HOME>/storages/session_projcache/`, and a
scratch workspace under `%USERPROFILE%\dsh-plugin-remover-e2e\`. It touches none of
your conversations, and `verify-e2e.mjs` removes it for good at the end.
