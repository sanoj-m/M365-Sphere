# 2026-10-07 — Resumable live dedupe (own task kind), compare Undo no longer re-walks live tree

One line: made "Move duplicates aside" a separately tracked, resumable task
(`dedupe-live` job kind + persisted per-item plan), confirmed no data loss in a
suspect folder, and removed the full live-mailbox re-walk after compare Undo.

## Goals

- "Moving duplicates aside gets interrupted … I want a separate task
  registration in history … even if interrupted, rerun without losing the
  already-done progress" (no re-scan / re-verify on restart)
- "Confirm whether move duplicates aside actually moves emails to Deleted"
- "Check whether files in folder `13 Projects - closed/1020-MotF` got deleted"
- "Pressing Undo in compare & transfer refreshes the live mailbox — I don't
  want that"

## What was done

### Resumable live dedupe (`lib/dedupe.js`, `lib/store.js`, `server.js`, `DedupePage.jsx`)
- New `dedupe_live_plan` table (store.js ctor): upn+liveId → dstPath, groupKey,
  status `pending|moved|failed|kept`, updatedAt. Helpers `dedupeLivePlanAll`,
  `upsertDedupeLiveItem`, `markDedupeLiveItem`, `clearDedupeLivePlan`.
- `applyLive(upn, { resume })` reworked: job kind is now **`dedupe-live`** (own
  task type in History, label "Move duplicates aside"; local apply stays
  `dedupe`). Every verified outcome is persisted per item as it happens. Fresh
  apply clears the plan; resume moves leftover `pending` items WITHOUT
  re-fingerprinting and skips kept/moved/failed rows entirely. Move-404 counts
  as moved (idempotent — an earlier run already moved it). Job detail shows
  `N pending (Restart resumes)` when a stop leaves moves behind.
- `POST /api/dedupe/apply` accepts `resume` (live only).
- DedupePage: history filter + running-job lookup include `dedupe-live`;
  interrupted/stopped/error `dedupe-live` rows get a **Resume** button
  (posts `resume:true`); fresh "Move duplicates aside" stays a clean run.
- AGENTS.md + README.md updated to match.

### Data-loss audit (answer: nothing deleted)
- Local backup user1 archive `13 Projects - closed/1020-MotF`: 395 DB rows, all
  `done`; all 379 UI-visible files verified on disk; 16 further rows share
  content-hash files stored under a sibling folder copy — none lost.
- Live user2 mailbox: no `13 Projects - closed` folder exists (474-folder walk)
  — the compare view showed absence, not deletion.
- Dedupe runs touched LIVE mailboxes only and only MOVE: user2 122 moved /
  0 failed, user3 1 moved / 47 kept — all in `Deleted Items/Dedupe <date>/…`,
  recoverable. The interrupted user2 `dedupe-live` run (23,204 candidates,
  ~120 done) has its remainder pending and resumable.

### Compare Undo no live re-walk (`ComparePage.jsx`)
- `doUndo` called `loadRightFolders(true)` — a full live mailbox walk after
  every undo. Removed; undo now refreshes only the local tree + selected-folder
  item lists. Manual **Refresh** still available for a fresh walk.

### Verification
- `node --check lib/dedupe.js lib/store.js server.js` OK; vite build OK (twice);
  server restarted to load the backend changes.

## Decisions

- Persist verified outcomes per item rather than a whole-plan blob: incremental
  upserts mean even a stop mid-verify keeps the already-verified rows, and
  resume never redoes fingerprint downloads for known kept/moved items.
- Stop during the scan phase leaves no plan rows → resume degrades to a fresh
  run (nothing was moved yet, nothing lost).
- Failed moves are not retried on resume (same semantics as before: a failed
  item stays put).

## Current state

- Server restarted with the new code; UI rebuilt. Not committed — 25 changed
  files, below the 50-file threshold.

## Next steps

- User-side end-to-end check: run live dedupe, Stop mid-move, hit **Resume** in
  History — log should show `resuming saved plan — N verified move(s) pending`.
- The interrupted user2 `dedupe-live` run can be finished via Resume.
