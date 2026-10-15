# 2026-10-07 — Compare "Failed to fetch" chase, server crash logging, Tasks & history panel

One line: fixed long compare transfers dying in the browser (Node's 300 s
`requestTimeout` + a still-unidentified mid-copy server crash), made the
compare page resilient to dropped connections, and merged a new live task
manager with the transfer history into one "Tasks & history" panel.

## Goals

- "Not copying, keeps saying failed to fetch" (compare page folder copy of a
  large archive folder, user1 → local store / live user2)
- "Make a task manager and list all running copies on the compare page"
- "Combine Tasks and History — a running task becomes history when it finishes"
- "While copying, show exactly which folder is being copied, with clear
  from/to lines"

## What was done

### Backend (`server.js`)
- `srv.requestTimeout = 0` after `app.listen`: Node ≥18 defaults to 300 s and
  was destroying the synchronous compare-transfer socket mid-run (browser saw
  "Failed to fetch" while the copy continued server-side).
- Crash diagnostics: `process.on('uncaughtException'/'unhandledRejection')`
  append full stacks to `data/server-crash.log` (the server runs detached with
  no console, so mid-job crashes — visible only as "Failed to fetch" + an
  empty task list — left no trace). Server restart command now also redirects
  stdout/stderr to `data/server-out.log` / `data/server-err.log`.

### Frontend (`web-react/src/components/ComparePage.jsx`)
- Dropped-connection resilience: `transferStillRunning()` — when a transfer
  POST rejects with "Failed to fetch", poll `/api/compare/progress`; if the
  job is live server-side, keep `busy` so the existing progress poll finishes
  it and shows the final counts instead of a dead error. Applied to Copy/Move,
  Copy folder, and Undo.
- Tasks & history panel: single header **Tasks** button (live count badge when
  copies run) opens one modal — running copies on top (compare transfer card:
  **From:**/**To:** lines, copied/skipped/failed, items bar, `copying folder
  x/y: <name>` live, elapsed, Stop; copy-engine job cards with bar + Stop),
  history rows below, auto-refreshing every 3 s while open so a finished task
  visibly becomes a history row. Separate History button/modal removed.
- Inline progress card got the same From:/To: lines and
  `copying folder x/y: <name>` wording.

## Decisions

- Frontend fallback over reverting the synchronous-transfer design: the copy
  continues server-side regardless of the socket, so polling the existing
  progress endpoint is the minimal robust fix; converting transfers to
  background jobs stays an option if crashes persist.
- No backend change needed for the task list: `/api/compare/progress` +
  `/api/status` jobs already expose everything (only one copy-type job can run
  at a time by design — compareGuard/copyEngine mutually exclude).

## Current state

- All changes committed and pushed to origin (public repo): code landed in
  `2e752da` (parallel-session commit), tree clean at `72d5fee`.
- The user's large folder copy crashed the server process mid-run (~870/28.7k
  items) BEFORE crash logging existed; the root cause is still unknown.
  Server restarted with logging active.

## Next steps

- User retries the folder copy; if the server dies again, read
  `data/server-crash.log` / `data/server-err.log` and fix the actual crash.
- If crashes keep killing long transfers, consider making
  `/api/compare/transfer-folder` a persisted background job (auto-resume like
  backups).
