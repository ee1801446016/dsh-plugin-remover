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
- **Recycle-bin panel**: groups, multi-selection, restore, permanent delete, and the three settings.
- **Hidden-conversation panel**: every subagent conversation, each deletable through the same delete dialog.

All three dialogs handle their own size and scrolling: the width follows the viewport (720 px at most for the delete dialog, 600 px for the other two), the height is capped to the viewport, the content column scrolls, and the header sticks. So even with every Details panel expanded, **Move to recycle bin** stays inside the viewport instead of being pushed off screen.

The delete dialog is also **sectioned and collapsible**: each of the six sections is one row that states its own count and size, only the produced files start open, and a sticky summary bar on top carries the counts, the record switch, expand/collapse, and the path filter. The whole decision — what goes, how much of it, where the button is — fits one screen instead of scrolling past six open lists.

## What the delete dialog shows

Each section is ticked separately, and each one collapses:

| Section | Default | Meaning |
|---|---|---|
| **Conversation files** | ticked, un-tickable | The conversation's storage directories and its projection cache; unticking keeps the conversation and deletes only files |
| **Subagent conversations** | all | Every subagent conversation it spawned, including grandchildren. Deleting the parent leaves them with no entry point, hence the default |
| **Files it produced** | all | Files written through `write`, `edit`, or `str_replace_editor` |
| **Files it read** | — | Files read through `read` or `read_image` but never written. **Listed only, never deleted** (see below) |
| **Produced outside the working directory** | **none** | Files this conversation **wrote** but not inside its working directory. Collapsed and unticked by default; removed only when you tick one, and a restore puts it back at its absolute path |
| **Changed during the conversation** | **none** | Files inside the working directory whose mtime falls inside the conversation's own event span — this is what catches products written by a script or a shell command. **Provenance unknown**, hence unticked |
| **Attachment objects** | ticked | Images/files you dropped into the input; only those no other conversation references. One whose bytes are identical to a file listed above is folded into that row instead of appearing twice |

Every *deletable* file list is selectable **row by row**; anything unticked is untouched, byte for byte. Each has Select none, and one path filter in the summary bar serves all of them. The read-only list has no checkboxes.

**Why can't "Files it read" be deleted?** It lists what the log saw through `read` / `read_image` without writing. The problem is that **the log cannot tell "this conversation generated the file and read it back" from "this file was already here"** — both record the same `read` call. 1.3.0 offered a checkbox, which meant deleting a conversation could take a source document you never meant to give up. So this section shows paths and sizes only, with no delete control; clean them up in Explorer. Its value is showing you what the conversation actually touched.

**Rows that will not be deleted say why.** Skipped paths are listed one by one — "no longer on disk", "not a regular file", "inside a system directory (`C:\Windows`)", "inside the DSH data directory" — instead of a bare count. System directories and `~/.dsh` are hard refusals: an `edit` call against `C:\Windows\...` in a log is far more likely to be a mistaken path than an instruction to delete part of Windows.

**Want to delete only the files and keep the conversation?** Untick **Also delete the conversation itself** in the summary bar. The ticked files go into the bin, still grouped under that conversation, and the conversation stays in the list. Attachment objects are disabled in that state and the dialog says why: the log keeps only their digests, so removing one would leave dead images in a conversation that still exists — the Host refuses that combination too.

**One picture, one row.** An image you pasted exists twice on disk: the file you had, and the copy DSH keeps in its attachment store under the digest. Both used to be listed, which made them look like two things — and ticking the attachment deleted the copy you could not see while the visible file stayed. Identity is now decided by **content** (byte count first, then SHA-256). If that file is one the conversation **produced**, the store copy no longer gets its own row: the file's Details panel names it, and deleting the file takes the copy along (never when another conversation still references the object). If the file was only **read**, the copy stays a standalone row in the attachment list, because that file cannot be deleted and folding the copy in would leave it reachable from nowhere.

**Why is "Changed during the conversation" its own section?** A conversation rarely writes its target file directly. It writes a script, runs it with `pwsh`, and the `.docx` / `.xlsx` / `.pptx` / `.pdf` appears — with **no tool call naming any of those paths**. Scanning only paths shows you the seven `.py` scripts and none of the nine documents. This section falls back to modification time to recover them, and the price is that anything else touching the directory in that window lands in it too. So it starts unticked, carries a warning, and states the window it used. Measured on a real conversation that produced nine documents: the old scanner saw **one** (and only because that one was passed to `read_image`); the new section finds **all nine**.

**Attachment objects are not file paths.** An image you paste or drop is stored by DSH at `<DSH_HOME>/attachments/v1/objects/<sha256>`, and the log keeps only the digest — so it is not in the working directory and never appears among "Files it read". The dialog now lists each attachment's **original name and size** so you can recognise which image is which.

### The Details button

**Every selectable file has a Details toggle** that expands inline:

```
Source directory   D:\work space\dsh-plugin-remover\_purge-patch\lib
Full path          D:\work space\dsh-plugin-remover\_purge-patch\lib\index.js
Size               41.6 KB
From               "整合删除功能" (parent) · Written by write / edit ×3
                   "review-pass-2" (subagent) · Written by write ×1
```

- **Source directory** is the point: among many similarly named files, the directory is what identifies one.
- When several conversations wrote or read the same file, each is listed.
- For read-only rows, "Written by" becomes "Read by".
- The panel expands **inline** rather than in a nested modal, because a modal inside a modal steals the focus trap. Long paths wrap on narrow screens.

Expanding a group in the recycle bin shows a Details toggle on each item too, with its original path and directory.

## Confirmation levels

| Action | Recoverable | Confirmation | Button |
|---|---|---|---|
| Delete a conversation (with subagents, produced files, files changed during it, attachments) | yes, in the recycle bin | **none** | "Move to recycle bin", normal primary colour |
| Delete only files and keep the conversation | yes, in the recycle bin | **none** | "Move to recycle bin", normal primary colour |
| Restore a group, a file, or a multi-selection | — | none | "Restore" / "Restore selection" |
| Empty the recycle bin | **no** | **tick "I understand permanent deletion cannot be undone"** | "Delete permanently", danger colour |
| Permanently delete a group, a file, or a multi-selection | **no** | **same** | "Delete permanently" / "Delete selection permanently", danger colour |
| This deletion does not fit in the recycle bin | **no** | **same** | "Delete permanently", danger colour |
| Automatic retention cleanup | **no** | none (that is the configured rule) | — |

Once ticked, the button executes directly with no second confirmation.

## The recycle bin

### Location

Fixed at `<DSH_HOME>/dsh-plugin-remover/trash/`. When `DSH_HOME` is unset it is `.dsh` under your home directory.

One deletion is one group, and the group records whether it holds conversation files or the files that conversation produced:

```
trash/
  settings.json                          # retention days, size cap, sidebar switch
  groups/<timestamp>-<sessionId>/
    manifest.json                        # the group's manifest; restore relies on it
    store/<project>/<sessionId>/         # conversation files (one directory item)
    artifacts/<n>/<original name>        # produced files
    artifacts-outside/<n>/<original name>  # produced outside the working directory
    changed/<n>/<original name>          # files changed during the conversation
    attachments/<n>/<sha256>             # attachment objects
    cache/<sessionId>.json               # projection cache
```

The manifest also records three things a restore needs: `recordIncluded` (whether this deletion took the conversation itself), a per-item `role` (`record` for conversation files, `file` for what the conversation produced), and a snapshot of the workspace the conversation belonged to at deletion time. Groups written by older versions carry none of these; the panel derives the roles from the item kinds and labels them correctly.

A group is built under `<key>.partial` and renamed into place only once complete, so a crash cannot leave a group that looks restorable but is not.

### Across volumes

The recycle bin lives on `C:` while workspaces usually live elsewhere. `rename` cannot cross volumes, so that case does **copy → verify byte count → remove source**. On a size mismatch the source is kept and an error is reported — never a half-delete.

### Restoring

- **Whole group**: the Restore button on the group row.
- **Single file**: expand the group and use the Restore button on that row.
- **Batch**: tick several groups and/or files and use **Restore selection** in the bar
  above the list; the same multi-selection can also be permanently deleted in one
  request (still behind the acknowledgement checkbox).
- Files go back to their **original paths**; an existing file there is **never overwritten** — that item reports "target already exists" and stays in the bin.

Restoring a conversation puts it **back into its original workspace** and takes it out of the archive set (an archived conversation stays grayed out and cannot be opened, which made a finished restore look like it had done nothing). The result is reported per conversation:

| Situation | Result |
|---|---|
| The workspace record and its directory both still exist | re-attached to that workspace |
| The directory exists but its workspace record was deleted | the workspace is **recreated** for that same directory and the conversation is attached to it |
| The original directory is gone | the conversation returns to **Ungrouped**, and the reason names the missing directory |

The third case deliberately does **not** rewrite the conversation log's working directory to force it into another workspace — that would change the conversation's recorded cwd permanently. Its files are still restored to their original paths (parent directories are recreated).

### Unfinished deletions

A deletion moves every item into `<timestamp>-<sessionId>.partial` and publishes the group with one final rename. That rename fails whenever something holds a handle on the directory being moved — on Windows that includes the Harness itself while the Session log is open, and any page still displaying an image. When it fails:

- The Host **puts every item it already moved back where it came from**, then reports that the bin could not register the deletion and how many items were rolled back. The files are all still there; nothing is half-deleted.
- If an individual item cannot go back (something else has taken its place), it stays in that `.partial` directory — and the **recycle bin lists the unfinished group** and lets you restore it, instead of pretending it does not exist.
- The retention sweep **never** touches an unfinished group: it may be the only record of where those files came from.

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
- **Referenced files are never touched.** They appear in the list with no checkbox, and the request has no field for them. Even a stale 1.3.0 page that still sends `referencedIds` is refused with `referenced-not-deletable`, before anything moves — because the log cannot tell "generated then read back" from "already there", and that signal must not decide a deletion.
- **Produced files** are only touched when their real path is **outside `DSH_HOME` and outside the operating system's directories**. Files inside the working directory are ticked by default; produced files outside it get their own section, start unticked, and are removed only when ticked one by one — a path named in the log is evidence the conversation touched it, never permission to remove a directory tree the user never looked at. System directories (`C:\Windows`, `Program Files`, …) and `~/.dsh` are hard refusals. Anything that is not a regular file, or whose realpath cannot be resolved (a symlink pointing outside), is skipped and the reason is listed row by row.
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

- **Direct paths only come from write/read tool calls**: `write`, `edit`, `str_replace_editor`, `create_file`, `read`, `read_image`. **Files produced by a script or a shell command** (write a `.py`, run it with `pwsh`, get a `.docx`) carry no path in the log — those are recovered by the **"Changed during the conversation"** section, which filters by modification time. That group has **unknown provenance**: anything that touched the directory while the conversation ran lands in it, so it is unticked by default. Read it before ticking.
- **The changed-file walk does not enter dependency or build directories**: `node_modules`, `.git`, `dist`, `build`, `__pycache__`, `.venv` and 10 more are skipped outright; depth is capped at 6 and one scan reports at most 2000 files, saying so when it truncates.
- **Attachments have no original path**: an image pasted or dropped into a conversation is stored at `<DSH_HOME>/attachments/v1/objects/<sha256>` and the log keeps only the digest. The dialog now shows the original file name and size, but an attachment is not in the working directory and is not a "referenced file".
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
| `verify/` | Six offline suites (Host / Client / real render / route level / crash regression / scan regression) plus one live served-bundle suite |

Run them with:

```sh
node verify/verify-host.mjs        # Host half, offline, no DSH needed
node verify/verify-client.cjs      # Browser half, offline
node verify/verify-render.mjs      # Mounts the real dialog and panel and asserts what renders
node verify/verify-routes-120.mjs  # Route level: files-only delete, produced outside the workspace, attachment copies, referenced-file refusal, workspace restore, batch restore
node verify/verify-runtime.mjs     # Crash regression: an older Host payload cannot wedge the dialog
node verify/verify-scan.mjs        # Fixture regression built from real conversation events
node verify/verify-served.mjs      # Live; reads DSH_WEB_URL, SKIPs without one
```

`verify-render.mjs` is worth a separate mention: `verify-client.cjs` only matches source text, which cannot catch a dialog that throws while rendering and therefore cannot be closed — the very crash this plugin was first reported for. The render suite mounts the actually registered component tree against a minimal hooks runtime, so "the new section renders", "ticking an outside file really lands in the `/purge` body", "the read-only list really has no checkboxes", and "a duplicated attachment does not get a second checkbox" are conclusions from real renders rather than string matches.

End to end (really delete a conversation, then restore it from the bin):

```sh
node verify/seed-e2e.mjs                                  # seeds a synthetic conversation, prints its id
node verify/verify-e2e.mjs <the id it printed>             # delete → bin → restore → delete again → clear
```

`seed-e2e.mjs` writes one synthetic conversation in the backend's real format
under `<DSH_HOME>/sessions/` and `<DSH_HOME>/storages/session_projcache/`, and a
scratch workspace under `%USERPROFILE%\dsh-plugin-remover-e2e\`. It touches none of
your conversations, and `verify-e2e.mjs` removes it for good at the end.
