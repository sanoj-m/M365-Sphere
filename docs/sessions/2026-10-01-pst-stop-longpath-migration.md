# Session log — PST stop fixes + long-path migration

**Date:** 2026-10-01
**Summary:** Fixed PST stop not stopping (retry-loop respawn, orphaned Outlook, stale pid files), diagnosed "PST made but empty" as a MAX_PATH problem on legacy filenames, and permanently migrated all 7,212 legacy files to sha1 names.

## Goals

1. Fix: stopping a PST task doesn't actually stop it.
2. Fix: PST file gets created but no data exported into it.
3. "Find a way to fix such issues" so backups/exports run cleanly long-term.

## What was done

### PST stop fixes (`lib/pst.js`, `server.js`)
- Retry loop now checks `_stop` after the 30 s sleep — a stop during the sleep used to kill the child, then respawn a brand-new PowerShell + Outlook export (the observed "stop doesn't stop").
- `pst.stop()` no-ops when nothing is running: `owner.pid` was never deleted, so stops taskkilled whatever processes held the recycled PIDs.
- `owner.pid` deleted on child exit; `_jobDir` cleared in `runExport` finally; 7 stale pid files cleaned from `data/pstjobs/`.
- `/api/stop` and `/api/stop/pst` also cancel a queued scheduled-window export (`pstPending = null`).
- Exports that are stopped or move zero items delete their empty/partial PSTs (no more convincing-looking empty files).
- Live on the machine at diagnosis time: PowerShell was dead but an orphaned `OUTLOOK.EXE` (spawned by the script) was still running the export — killed it manually.

### Empty-PST root cause
- 8,491 legacy `base64url(itemId).eml.gz` filenames push absolute paths past MAX_PATH (260); PowerShell 5.1 cannot open or enumerate them. The last completed it@ export failed all 2,277 items with PathTooLong and produced a 271 KB empty PST.
- `lib/pst.js` now `subst`s the store root to a drive letter (M:/X:/Y:/Z:/P:) for the export duration (covers deep folder paths too); released on child close/error.

### Permanent migration (`scripts/migrate-long-paths.js`, new)
- One-time, idempotent (`--dry` mode) offline migration: for every items row with a legacy `fileId`, gunzip-verify the legacy file, rename to `sha1(itemId).eml.gz`, update `items.fileId` + backfill `sha256` in a transaction (rename rolls back on DB failure).
- Run with server stopped, WAL checkpointed, DB backed up to `data/state.db.bak-migrate`.
- Results: 7,212 migrated, 0 failures; 0 legacy names left outside `_graveyard` (1,270 retired files there untouched — unreferenced, harmless). Re-run confirmed idempotent. Spot-checked files gunzip + sha256-verify OK.
- Removed the garbage empty PST + empty manifest from the failed it@ export.

## Decisions

- Permanent file rename (mirroring the existing lazy per-item migration in `engine.js`) over relying on subst alone — fixes every consumer of the store, not just PST export.
- `subst` kept as a safety net in the exporter for deep-folder paths that no filename migration can fix (9 files in user1's `07 Projects`).
- `_graveyard` files left as-is: `deleted` rows' files aren't resolved via live flows.

## Current state

- Server restarted with all fixes; `/api/status` healthy.
- DB backup from before migration: `data/state.db.bak-migrate` (safe to delete once confident).
- Commit this session: see git log (57 changed files total — over the 50-file threshold; includes prior sessions' EXO-export/copy/dedupe work).

## Next steps

- Re-run PST exports for it@ and user1 — they should now actually populate.
- Optional: rename the 1,270 legacy-named `_graveyard` files; delete `data/state.db.bak-migrate` after confidence period.
- Remaining known tenant backlog: ~2,511 mailboxes pending backup.
