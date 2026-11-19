# Changelog

All notable changes to this plugin.

## 1.4.0 — 2026-11-19

Files a conversation only *read* become a list, not a selection: they are shown
so the reader can see what shared the disk, and no request can delete one.

### Changed

- **Referenced files are listed, never deleted.** 1.3.0 offered a checkbox on
  every file the log named, inside and outside the working directory. That was
  wrong in a way the tests could not see: `read` in an event log records the same
  call whether the conversation generated the file and read it back, or found it
  already there. Deleting on that signal occasionally destroys work the user
  never gave up. The section now renders without checkboxes, the request carries
  no field for one, and a page from 1.3.0 that still sends `referencedIds` is
  refused with `referenced-not-deletable` instead of being told "done".
- **The outside section holds produced files only.** 1.3.0 merged everything the
  log named outside the working directory into one section, so a single heading
  offered to delete both a file the conversation wrote and a file it merely read
  from somewhere else. Only the produced ones remain. They keep their own
  collapsed section, start unticked, are removed only when ticked individually,
  and restore to their recorded absolute paths.
- **An attachment copy is only folded into a file that can actually act.** The
  fold means "deleting this file takes the store copy with it". A referenced file
  cannot be deleted, so folding its copy there would leave the copy unreachable
  from every list at once. Only a produced file folds; the copy of a referenced
  file stays a standalone attachment row that can be removed on its own terms.
- The referenced section's wording no longer promises a deletion, and the result
  page no longer reports a referenced count it can never change.
- `verify/host` 324, `verify/client` 191, `verify/render` 62, `verify/routes` 72,
  `verify/runtime` 27, `verify/scan` 72 — 748 offline checks.

### Removed

- `plan.referenced.outside` and `plan.referenced.outsideBytes`. Referenced rows
  come back as one flat list because the directory a read file sat in no longer
  informs any decision the reader can make.
- `removed.referenced` and `removed.referencedBytes` on the purge result, along
  with the `done.referenced` line. A counter for something that can never be
  removed is worse than no counter.
- The 1.3.0 inside/outside id routing in the dialog. With one deletable section
  left, every outside row is a produced row and goes into `artifactIds`.

## 1.3.0 — 2026-11-19

Files the log names outside the working directory become deletable on request, a
file and its attachment-store copy stop appearing as two separate rows, and a
failed publish can no longer strand files where nothing can find them.

### Added

- **Files outside the working directory.** A path a conversation read or wrote
  somewhere else used to be refused outright, which made it visible in the scan
  and impossible to delete. Those rows now come back with `scope: 'outside'`, are
  listed in their own collapsed section, start unticked, and are removed only
  when ticked one by one. A restore puts each back at its recorded absolute path.
  Operating-system directories and the DSH home stay hard refusals: an `edit` call
  against `C:\Windows\...` in a log is a mistaken path, not an instruction to
  remove part of Windows.
- **The reasons a file was not listed are now printed.** Refusals were counted
  and never shown, so "the file is on the scan but not in the list" was
  indistinguishable from a bug. Each refused path is now listed with its reason
  (missing, not a regular file, inside a system directory, inside the DSH home),
  capped at 50 rows per group with a summary line.
- **An attachment object that duplicates a listed file is folded into it.** An
  image pasted into a conversation is stored twice: as the file the user had, and
  in the attachment store under its digest. Both used to be listed, so the same
  picture appeared under two headings and ticking the attachment removed a copy
  the reader could not see while the visible file stayed. Identity is now decided
  by content (byte count pre-filter, then SHA-256), the store copy disappears from
  its own list, and the file's detail panel names it. Deleting the file removes the
  copy too, but only when the conversation itself goes, and never when another
  conversation still references the object.
- **An unfinished deletion is visible and restorable.** A group whose publish
  never finished (`<key>.partial`) used to be skipped by the recycle-bin listing
  and by the retention sweep, so files that had already left their directories were
  invisible and unrecoverable. Those groups now appear in the panel flagged as
  unfinished, and the normal restore path finishes the job.

### Changed

- The dialog reports separately how many attachment-store copies went along with
  the files they duplicated.
- `verify/render` now asserts the outside section, the fold, and the refusal list
  against a mounted dialog, not only the source text.

### Fixed

- **A failed publish no longer loses files.** Every item is moved into
  `<key>.partial` before the final `rename` publishes the group. On Windows that
  rename fails whenever a handle is open on the directory being moved — the
  Harness holding the Session log, or a page still displaying an image. The error
  escaped, the items were already moved, and the partial directory was skipped by
  both the listing and the sweep: gone from the workspace, absent from the bin,
  still occupying disk. A failed publish now rolls every item back to where it
  came from, and returns `publish-failed` instead of a success.
- **A request that matched nothing is refused, not reported as done.** Ticking
  files whose ids no longer resolve (the file vanished, the page went stale) used
  to return `ok: true, empty: true`, which the dialog rendered as a completed
  deletion. It now returns `nothing-matched` with a reason; ticking nothing at all
  remains a harmless no-op.
- A partial group's manifest could name a group key without its `.partial`
  suffix, which would have sent a restore to a directory that does not exist. The
  directory name now wins.

## 1.2.0 — 2026-11-19

The delete dialog gets out of the way, a conversation can be kept while its files
are removed, a restore puts things back where they came from, and the recycle bin
grows batch operations.

### Added

- **A conversation can be kept while its files go.** The "conversation files"
  section is now a switch in the summary bar, on by default. Unticking it deletes
  only the ticked files, grouped in the bin under that conversation. The
  conversation keeps its list entry: the Host skips the archive/detach/interrupt
  steps when its own log is not being moved, and it refuses to remove attachment
  objects in the same state — the log stores those only as `sha256:` digests, so
  removing one would leave dead images in a conversation that still exists.
- **Roles in the recycle bin.** Every group now states how many of its items are
  the conversation's own storage and how many are files it produced, and says
  either "includes the conversation itself" or "files only (the conversation was
  kept)". Each file row names the conversation it came from. Older groups written
  before these fields existed are labelled by deriving the same roles from their
  item kinds.
- **Restore returns to the original workspace.** The group manifest records the
  workspace the conversation belonged to, and a restore uses it before falling
  back to the recorded working directory. Three outcomes are reported per
  conversation: `re-attached` (a workspace still owns that directory), `created`
  (the directory is back but its registration was deleted, so the same workspace
  is recreated and the conversation attached to it), and `ungrouped` (the
  directory itself is gone). A restore also takes the conversation out of the
  archive set, which it previously left in place — an archived conversation shows
  grayed out and cannot be opened, so the restore looked like it had done nothing.
- **Batch operations in the recycle bin.** Groups and individual files can be
  ticked together and restored or permanently deleted in one request. The bytes
  and counts of the selection are shown before either button is pressed, and
  permanent deletion still requires the acknowledgement checkbox.

### Changed

- **The delete dialog is compact.** The six sections are collapsible rows that
  report their own count and byte total; only the produced files start open. A
  sticky summary bar carries the counts, the record switch, expand/collapse, and
  the path filter — which used to sit below every list. Each list caps at 150 px
  instead of 180–200 px and the dialog narrowed from 760 px to 720 px. The whole
  decision now fits one screen instead of scrolling past six open lists.
- `formatVersion` stays 1: the new manifest fields (`recordIncluded`, `roles`,
  `workspace`, and a per-item `role`) are additive, so a 1.2.0 install reads a
  1.1.0 group and vice versa.
- `/trash/restore` accepts `{groupKeys, items}` for a batch in addition to the
  single-group `{groupKey, itemPaths}` form, which still answers with the same
  top-level `groupRemoved` field the per-row buttons read.
- `/scan` now returns the conversation's workspace slot, so the dialog can say
  where a restore will put it.

### Fixed

- A restore left the conversation in the archive set even though its log was
  back. Whichever surface hid archived rows then showed nothing changed.
- Restoring a conversation whose workspace registration had been deleted dropped
  it into "Ungrouped" silently; it now recreates the workspace for that same
  directory and says so.

## 1.1.0 — 2026-11-18

Fixes a scan gap that made a whole class of produced files invisible.

A conversation that writes files through a script does not record their paths:
it writes `make_report.py`, runs it with `pwsh`, and the `.docx`/`.xlsx`/`.pptx`/
`.pdf`/`.csv` appear without any tool call naming them. The scanner only read
`file_path` out of `write`/`edit`/`read`/`read_image`, so it reported the script
and none of its products. Measured on a real conversation that produced nine
documents by this route: **one of nine was visible**, and that one only because
the conversation happened to `read_image` it.

### Added

- **"Changed during the conversation" section.** Files inside the working
  directory whose modification time falls inside the span of the conversation's
  own events are listed in a group of their own, alongside produced and
  referenced files. Unselected by default. This is what surfaces the nine
  documents above: all nine are now found.
- **Why it is a separate group, not part of "produced":** the log contains no
  evidence of authorship for these files. Anything that touched the directory
  while the conversation ran — a manual edit, a build, another process — lands in
  the same window. Presenting them as produced would be a claim the code cannot
  back, and ticking them by default would turn that claim into a deletion. The
  group therefore carries a warning, states the time window it used, and starts
  empty.
- **Attachment names.** The dialog used to show only "N attachment objects". The
  id is a sha256 digest, so two images pasted into one conversation looked
  identical and neither could be recognised. The original name, size and media
  type recorded beside each id are now listed.

### Changed

- The changed-file walk is bounded and filtered: `node_modules`, `.git`, `dist`,
  `build`, `out`, `__pycache__`, `.venv`, `target`, `.next`, `.nuxt`, `.cache`,
  `coverage` and similar are never entered (16 names in total); depth is capped
  at 6, and one scan reports at most 2000 files, saying so when it truncates.
- Files already named by a tool call are never repeated in the changed group, and
  nothing under `DSH_HOME` or outside the working directory is ever reported.
- `README.md` / `README.en.md`: the known limitation "files written by a shell
  command are not detected" is no longer true and has been replaced.

### Verification

- `verify/verify-scan.mjs`, new and offline: 72 checks driven by a fixture
  derived from the real conversation that exposed the bug (event timing, tool
  names and argument shapes only; every absolute path replaced by a token). Its
  central assertions: all nine deliverables are found, the image that predates
  the conversation is excluded, the seven scripts are not duplicated into the
  changed group, noise directories and `DSH_HOME` are never reported, and the
  group is empty in a request that does not tick it.
- `verify-host.mjs` 193 → 193, `verify-client.cjs` 109 → 117.

## 1.0.0 — 2026-11-15

First release of `dsh-plugin-remover`. It deletes a conversation together with
what it left behind, and makes that deletion reversible.

### Added

- **Delete dialog sections**, each independently ticked: conversation files,
  subagent conversations, produced files, referenced files, attachment objects,
  projection cache.
- **Subagent conversation tree.** The plan walks `parentSession` to any depth, so
  deleting a conversation also takes the conversations it spawned — including
  grandchildren, which lose their only entry point once the parent is gone.
- **Per-file Details panel** on every selectable file: source directory, full
  path, size, and the conversations that wrote or read it. Inline, not a modal.
- **Referenced files.** Targets of `read` / `read_image` are listed separately
  from produced files, unselected by default, and deletable only when ticked.
- **Per-file deletion.** Produced and referenced files are removed by id; a file
  that was not ticked is untouched.
- **Recycle bin** at `<DSH_HOME>/dsh-plugin-remover/trash`, one group per
  deletion, with a manifest that makes restore exact. Whole-group and single-file
  restore.
- **Retention and size cap** (default 30 days / 2 GiB, both `0`-able), stored in
  `trash/settings.json` and applied to existing groups immediately.
- **Sidebar recycle-bin entry** at the foot of the sidebar, above the shipped
  Settings row, with a checkbox on the plugin page to switch it off. Flipping it
  takes effect in the sidebar immediately, without a page reload.
- **Overflow question.** A deletion that cannot fit is refused *before* anything
  moves; the user answers "delete permanently" or "empty the bin and retry".
- **Plugin-page section** (`plugins.detail.section`) carrying the recycle bin,
  the hidden-conversation list, the settings, and the sidebar-entry switch —
  reachable without any Session row.
- **Cross-volume moves** via copy → verify size → remove source; a mismatch
  keeps the source instead of half-deleting.
- Dialogs that fit the viewport: widened, height-capped, with a scrolling content
  column, a sticky header, and a footer that stays on screen.
- `locale/zh.json` and `locale/en.json` with `meta.title` / `meta.description`,
  and `icon.svg`, so the plugin has a name, a description, and artwork in
  Plugins.
- Host routes: `/scan`, `/purge`, `/hidden`, `/trash/list`, `/trash/restore`,
  `/trash/delete`, `/trash/sweep`, `/trash/settings`, `/health`.

### Notes

- The delete request names ids, never paths; the Host re-derives the whole plan
  from the stored logs, so a stale or tampered page cannot widen a deletion.
- Moving a conversation into the recycle bin is reversible and therefore asks for
  no acknowledgement. Emptying the recycle bin, deleting a group or a file for
  good, and a deletion too large to fit all require an explicit checkbox and a
  danger-coloured button.
- A `mode` field in a delete request is ignored rather than honoured: it belonged
  to an earlier single-scope dialog, and accepting it could widen a deletion past
  the per-file selection.

### Verified

- `verify/verify-host.mjs` — offline Host suite (193 checks).
- `verify/verify-client.cjs` — offline browser suite (109 checks).
- `verify/verify-served.mjs` — against the bundle the Web Host actually serves
  (64 checks).
- `verify/verify-e2e.mjs` — a real delete / restore / delete-again cycle against
  the live Host; `verify/seed-e2e.mjs` seeds the synthetic conversation it acts
  on, in the backend's real log format.

All suites run against DSH `0.2.2-rc.3` on the desktop profile.

### Packaging

- `engines.dsh` is `>=0.2.2-rc.1 <0.3.0-0`. The range spells out the prerelease
  tuple on purpose: a wider-looking `>=0.2.0-0 <0.3.0-0` matches no prerelease
  build at all, because node-semver only admits a prerelease when a comparator
  shares its exact `major.minor.patch`.
- `lib/` ships prebuilt and the package declares no `prepare` or `postinstall`
  script, so installing from npm, from a Git spec, or from a tarball needs no
  build approval.
- `assets/icon-180.png` is the storefront tile; `icon.svg` remains the icon the
  DSH plugin page reads.

Rendered appearance, dark theme, and a 390 px viewport remain unverified: this
environment has no browser control.

