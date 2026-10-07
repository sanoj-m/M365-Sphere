# 2026-10-01 — "Scan counts": server-side email counts without downloading

## Goals

- Add a button to scan all mailboxes and count total emails on the server, so the dashboard shows what still needs to back up ("74 / 12049 emails" totals) before any backup runs.
- Separate Scan buttons for primary and archive on the mailbox page.
- Show live scan progress where the user clicked (mailbox page scope panel), not just the dashboard.

## What was done

- **New endpoint `POST /api/scan`** (`server.js`) — `{ upn?|upns?, scope?: 'primary'|'archive' }` walks each mailbox's folder tree (Graph `folderTree` for primary, EWS `folderTree` for archive) and upserts server-side `folders.itemCount` via the existing `store.upsertFolder`. No item bodies are downloaded; sync cursors (`deltaToken`/`syncState`) are preserved because they're passed `undefined` → SQL `COALESCE` keeps existing values. Mirrors the `/api/sizes` job skeleton: `scanRunning/scanStop/scanAborter` flags, `store.createJob('scan')`, worker pool (`cfg.scanConcurrency`, default 3, 2 while the engine runs), throttled job-detail progress, 409 while running.
- **Archive gating** — archive is walked when `hasArchive` is truthy OR when sizes were never fetched (EXO grant pending → unknown); EWS "folder not found" is a warn ("no accessible archive"), not a failure. Motivated by `it@example.com` (hasArchive=0, sizes never fetched, tiny archive partition).
- **Stops & sweeps** — `POST /api/stop/scan` (mirrors `/api/stop/sizes`), the global Stop now also aborts the scan, `scanRunning` added to `/api/status`, and both auto-resume sweep guards skip while a scan runs.
- **Live progress** — per-mailbox `scanLive[upn] = { scope, folders }` map updated from the tree walkers' `onProgress` callback; exposed on `GET /api/mailbox/:upn/folders` as `scanLive`. Job detail shows "N folders scanned" every 1 s (dashboard job bar); activity log gets a line every 250 folders.
- **UI** (`web-react/src/`) — dashboard pipeline "Scan counts" button (both scopes, all mailboxes); `MailboxTable.jsx` "Scan Selected" (passes `upns`); `TasksPanel.jsx` stop-path mapping for `scan`; `MailboxPage.jsx` per-scope **Scan** buttons next to Start/Stop backup (scope param added to the API for this); `browse.jsx` `ScopePanel` renders "Scanning counts — N folders…" (dimmed full bar) when `scanLive` matches the scope, including the no-folders-yet state.
- **Verified live** — `it@example.com` (43 primary folders / 29,788 emails; archive warn path exercised), `user1@example.com` full run: 2,832 primary folders / 14,043 emails + 3,523 archive folders / 12,049 emails, all 3,523 archive cursors intact; the 7 primary folders without cursors are newly discovered (full-listed on next backup, as designed). Archive-only scan verified after the scope param was added.
- AGENTS.md updated (API quick ref + recent-changes entry).

## Decisions

- Scan reuses the existing tree walkers — counts come free with enumeration; only `syncFolder` downloads bodies, so no new Graph/EWS code was needed.
- Scan does **not** delete folders removed server-side (engine's `_reconcileFolders` owns that during backup) — scan is purely additive.
- Per-scope Scan buttons live in the scope panel headers (user request), replacing an initial single mailbox-level button; the dashboard buttons still scan both scopes at once.
- Mailbox-page progress goes through `scanLive` on the existing `/folders` poll (3 s) rather than a new channel — no new endpoints or SSE wiring.

## Current state

- Server restarted with all scan code live; `web-react/dist` rebuilt (`index-Cy7Iq6Nd.js`).
- **Note:** during testing the server was restarted externally several times (auto-resumed EXO export was failing its chunks — PowerShell error `The term 'elseif' is not recognized`, a pre-existing `lib/exoexport.js` script bug, possibly a missing brace before an `elseif`). Each restart marked in-flight scans `interrupted`; scans are safe to re-run.
- Large archives are slow: user1's 3,523-folder archive took ~16 min (serial EWS `FindFolder` walk — same code the engine's enumeration fallback uses).

## Next steps

- Investigate/fix the EXO export `elseif` PowerShell bug and check whether it correlates with the unexplained server restarts.
- Consider speeding up the EWS archive walk (parallel child-folder enumeration like the Graph walk) if the ~16 min per large archive is a problem.
- Consider showing scan progress on the dashboard job bar for the mailbox page too — currently the mailbox page only shows it inside the scope panels.
