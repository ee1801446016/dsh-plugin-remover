# Changelog

All notable changes to this plugin.

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

