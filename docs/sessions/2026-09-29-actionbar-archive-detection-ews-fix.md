# 2026-09-29 — Action-bar redesign, Setup fix, archive detection + archive-only backup, EWS repair

One line: redesigned the header action bar into a guided pipeline, fixed the dead Setup button, added per-mailbox archive detection with archive-only backup — and repaired two EWS bugs that had silently broken every archive/size call.

## Goals

- Redesign the header action bar (screenshot provided) for better UI/UX.
- Fix the Setup button, which "did nothing" when clicked.
- Let the user see which mailboxes have an online archive and back up **only the archive** when desired.

## What was done

### Action bar redesign (web-react)

- `App.jsx` — the four workflow actions are now a connected `.pipeline` segmented control with numbered step chips (1 Discover · 2 Fetch Sizes · 3 Verify All · 4 Export PST). A `nextStep` heuristic (no mailboxes → 1, no size data → 2, incomplete mailboxes → 3, else 4) highlights the suggested next step in accent green. **Stop** (danger) and **Setup** (new ghost variant) moved to a right-aligned group.
- `styles.css` — new `.pipeline`/`.step`/`.step-n` styles, `.btn.ghost`; ≤480px the pipeline becomes a 2×2 grid and the right group stretches.

### Setup button fix

- `components/SetupPanel.jsx` — the panel polled `/api/setup/status` on mount and called `onDone()` whenever state was `done`; with an already-connected tenant the panel closed itself the instant it opened, so the button looked dead. Now auto-closes only on a pending/running → done transition. Also removed the `onDone` effect dependency (inline prop restarted the 3s poll every render).

### Archive detection + archive-only backup

- `lib/store.js` — `hasArchive INTEGER` migration (null = unknown, 0 = no, 1 = yes).
- `server.js` — `/api/sizes` sets `hasArchive` from `archiveBytes != null`; `POST /api/backup` accepts `{scope:"archive"}` (validated, 400 otherwise) and threads it into the engine.
- `lib/engine.js` — `runBackup(upn, upns, {scope})` → `backupMailbox(..., scope)`; archive-only runs sync just the archive scope. Archive presence persisted from backups too: 404 path → `hasArchive:0`, successful archive sync → `hasArchive:1`. Completeness check unchanged (whole-mailbox status stays honest).
- `MailboxTable.jsx` — new sortable **Archive** column (`Archive` / `No archive` / `—` badges), per-row **Archive** button (only when `hasArchive===1`), bulk **Archive Only (n)** button that targets selected mailboxes with a detected archive.
- `App.jsx` `startBackup(upns, scope)` passes the scope through.

### EWS repair (found during smoke-testing — archive/size calls had never worked)

- `lib/ews.js` `resp()` checked `rm.ResponseClass`, but the XML parser stores attributes as `@ResponseClass` → every response looked like a failure with `undefined` message. Now reads both and includes the EWS `ResponseCode` in error text (so the "no archive" 404 regex can match `ErrorFolderNotFound`).
- FindFolder returns typed children (`CalendarFolder`, `ContactsFolder`, `TasksFolder`) which the code ignored — crashing whenever a folder contained *only* typed children, and undercounting sizes everywhere else. New `folderList()` helper flattens all typed folder arrays; used at all three FindFolder/GetFolder sites.

## Decisions

- Archive detection piggybacks on the existing EWS touchpoints (sizes job + backups) instead of Graph `mailboxSettings`, which would need a new `MailboxSettings.Read` consent.
- Archive-only runs leave the whole-mailbox completeness check untouched — a mailbox whose primary was never backed up correctly stays `partial`.
- PST export intentionally unchanged (still exports everything stored).

## Current state

- `npm run build` green; server restarted in console/background mode with the fixes.
- Verified live against the tenant: size scan of `user3@example.com` → `hasArchive:1`, primary 342 MB, archive 57 GB; archive-only backup started and began syncing archive folders (stopped early by us — large archive).
- `git ls-files` count: 33 modified + 9 untracked = 42 files — below the 50-file threshold, **no commit made**.

## Next steps

- Run **Fetch Sizes** across all mailboxes to populate archive badges (2516 mailboxes).
- Note: full size scans are slow on huge trees (50 GB mailbox ≈ 4+ min/scope); watch for EWS throttling during the fleet-wide run.
- `hasArchive` is still null for untouched mailboxes — badges fill in as sizes/backups run.
