# Live→live folder-structure repair + 30 GB project migration (2026-10-16)

Repair of two move-email runs that flattened folders onto the destination
root, then an ongoing ~30 GB project-by-project live migration between two
archive mailboxes.

## Goals

- Fix the aftermath of move jobs 1962/1964 (`user1` live → `bids-historic`
  live, destination "mailbox root"): 96 emails landed in 23 folders created
  FLAT at the destination root instead of under their source paths; merge by
  project number where a counterpart folder exists.
- Migrate ~30 GB of project folders from `pc-2` "13 Projects - closed" to
  `pc-main` "13 Projects - closed", project by project, leaving **no folder
  residues** in `pc-2`.
- Make externally-started move-email runs visible on the Move email page.

## What was done

- `scripts/fix-kvbids-root-folders.js` (dry-run default, `--apply`): reads the
  `move_email_plan` rows of jobs 1962/1964, verifies each created folder live
  via Graph, resolves the intended parent path, and either moves the folder
  whole (`POST /mailFolders/{id}/move`, server-side, dates untouched) or —
  when the parent already has a folder for the same project (exact name or
  name minus a " (2)" suffix) — moves the emails into it and deletes the
  duplicate. Result: 20 folder moves + 3 merges (Kabir Pakistan, MRC MP
  Competition, ADPIC Government Hub), 0 failures, root verified clean.
- Move email page UX (`web-react/src/components/MoveEmailPage.jsx`):
  auto-selects the running run's source mailbox when none is picked, so
  API-started jobs show up in the Move tasks panel without manual selection.
- Migration tooling:
  - `scripts/exo-folder-sizes.js <upn> [pathPrefix]` — per-folder
    FolderAndSubfolderSize via EXO `Get-MailboxFolderStatistics` (used to pick
    the ~30 GB subset; `pc-2` total was 40 GB / 92 projects).
  - `scripts/move-pc2-projects.js` — driver: 12 biggest projects (~30.5 GB),
    smallest-first, one move-email engine run per project via the server API
    (`POST /api/move-email`, live→live, structure recreated + merged by name,
    EWS upload with original dates), automatic retry of failed items, 409-wait
    while the engine is busy, then deepest-first deletion of the
    verified-empty source tree.
  - `scripts/move-pc2-sweep.js` — sweep for engine fuzzy-only skips:
    fingerprint-verifies source+destination MIMEs (`mimeFingerprint` from
    `lib/dedupe.js`), retires true duplicates, uploads genuinely unique
    look-alikes via EWS (date preserved) and retires after success, then
    deletes the emptied source tree.
- Periodic progress checks via cron (every 2 h) against the driver log +
  `/api/status`.

## Decisions

- Project selection: biggest-first 12 projects ≈ 30.5 GB (user-confirmed),
  the 18.5 GB `2020 ASGC - MAA 1+2` goes last so the pipeline validates on
  small projects first.
- Multi-pass driver: Graph `listMessages` proved **eventually consistent** —
  items bulk-imported into `pc-2` weeks earlier (PST import, 2026-09-26) were
  invisible to listings during the first pass, so "done" moves left items
  behind. The driver now re-lists and re-moves until the source subtree reads
  empty (max 3 passes), then hands stubborn fuzzy-skips to the sweep.
- Fuzzy-only skips are NOT auto-retired by design — the sweep showed they
  were all *unique* emails whose destination look-alikes differed in content;
  every one was uploaded with its original date before the source retired.
- Moved emails sit in `pc-2`'s Deleted Items (recoverable) — the engine's
  safety net, not a residue.
- The two `026-02 Naia Island` folders were kept separate (different
  sub-projects/clients despite the same project number).

## Current state

- 8/12 projects complete with source trees deleted from `pc-2` (CAD-
  Supervision, RSG Octopus, NEOM Pre-CD Airport, Damac Sofouh, Neom Airport
  Sprint 3, TRSDC Sheybarah, Neom Airport MP, Abbas Two Canal); Select BB /
  WSP / N25 MAA Penthouse / ASGC MAA 1+2 remaining; 0 failures so far.
- Driver runs as a background task; progress visible on `/?moveemail`
  (auto-selects `pc-2`) and via the 2-hourly cron check.
- Commit: see git log (this session's commit includes the four new scripts,
  the MoveEmailPage tweak, installer sources, and the auto-updater).

## Next steps

- Let the driver finish; sweep any remaining fuzzy-skip leftovers per project,
  then confirm `pc-2` "13 Projects - closed" holds only the unmoved projects.
- Consider fixing the move-email engine's live→live "mailbox root" path so it
  recreates the source structure instead of flattening (root cause of the
  1962/1964 repair).
- The Graph listing inconsistency may warrant a verification pass inside the
  engine itself (re-list after a move before declaring a folder done).
