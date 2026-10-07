# 2026-09-30 — Per-scope backup controls, delta archive enumeration, EXO app-only auth, task queue, agent guides

## Goals

- Per-mailbox Start/Stop backup buttons on the mailbox page, split per scope (primary/archive).
- Fix live enumeration not showing (panel stuck on "Backed up" / folder 0/0); persist enumeration incrementally; validate only folder changes on later runs.
- EXO sizes: use `Get-EXOMailboxStatistics -Archive` (user verified correct archive size); EXO for selected mailboxes.
- Fix folder-tree context menu opening far from the click; "Collapse all" should keep root folders open.
- All UI timestamps in Dubai local time (Asia/Dubai).
- EXO `-Device` failure: make sizes fetch work unattended.
- Action buttons (Backup/Archive/Verify/PST) usable while a job is running.
- AGENTS.md for token efficiency + ponytail minimalism ladder; global version for all chats.

## What was done

- **Per-scope backup buttons** — `MailboxPage.jsx` header buttons → per-card buttons via new `actions` slot in `ScopePanel` (`browse.jsx`); `POST /api/backup {upn, scope}` now accepts `'primary'` (`server.js`, `engine.js` `backupMailbox` scope handling, `backupScope` records the scope verbatim).
- **Live enumeration fix** — engine set `live.scope` only *after* enumeration; now set at `syncScope` start (`engine.js:305`), so the panel shows "Backup running" and the Stop button immediately.
- **Delta archive enumeration** — new `ews.syncFolderHierarchy()` (SyncFolderHierarchy, 512/page, cursor persisted in new `mailboxes.archiveHierarchyState` column); engine `_enumArchive()` upserts folders incrementally as they arrive, applies renames (moves on-disk dirs), prunes deleted folders, falls back to the recursive `FindFolder` walk on hierarchy-sync failure, retries once with a fresh cursor on invalid-state errors. Result: 3523-folder archive enumerates in seconds instead of ~20 min.
- **Live tracker** — `live.enumFound` counts folders during enumeration; UI shows "enumerating folders… N found" instead of "folder 0/0".
- **EXO cmdlet swap** — `Get-MailboxStatistics` → `Get-EXOMailboxStatistics` in `lib/exo.js`, raw `TotalItemSize` string parsed by existing `toBytes()`.
- **EXO auth without device code** — module 3.10.1 removed `-Device`; now `Connect-ExchangeOnline -AccessToken <ewsToken> -Organization <tenant>` (app-only, no sign-in); `Exo` gets `auth` in `server.js`. Tested: connects, but tenant returns `UnAuthorized` — needs `Exchange.ManageAsApp` app permission + Exchange admin role. Error message now explains this.
- **Fetch Sizes Selected (EXO)** — new toolbar button in `MailboxTable.jsx`; server already accepted `{upns, source:'exo'}`.
- **Context menu fix** — menu renders via `createPortal(document.body)`; ancestor CSS transforms were breaking `position: fixed` placement.
- **Collapse all** keeps root folders expanded (`browse.jsx`).
- **Dubai time everywhere** — `format.js` gains `fmtTime/fmtDate/fmtDateTime` (Asia/Dubai); applied to all log panels, item dates, verify chips, size-fetch tooltips, error report; storage stays UTC.
- **Action queue** — fix-gaps queue generalized to task kinds `fix|backup|verify`; `/api/backup` and `/api/verify` queue (202-style `{queued:true}`) when the engine is busy instead of 409; tasks cancelable via `DELETE /api/tasks/:id`. UI buttons no longer disabled while running (tooltips explain queueing); TasksPanel shows kind labels and targets. Verified live: queued + cancelled a backup mid-run.
- **Agent guides** — project `AGENTS.md` (architecture, API reference, restart runbook, tenant facts, ponytail ladder, rolling "Current state" section) and global `~/.kimi-code/AGENTS.md` (token-efficiency + ponytail rules for all chats). Note: Windows case-insensitive FS — `agents.md`/`AGENTS.md` are the same file; keep one.
- Server restarted several times to load backend changes; auto-resume re-queued the user1 archive backup each time.

## Decisions

- SyncFolderHierarchy chosen over storing partial FindFolder state — one paged delta call replaces the whole recursive walk and gives a resumable cursor for free.
- Queue-on-busy instead of parallel engine runs — engine is single-run by design (shared `_stop`/`_aborter`/live maps); queueing preserves that invariant while unblocking the UI.
- PST export start still blocks while the engine runs (both hit disk/DB heavily); only the PST *plan builder* was unlocked.
- Task queue is in-memory (same as fix-gaps) — acceptable; restart drops queued (not running) tasks.
- EXO token passed as a PowerShell command-line argument — acceptable for localhost-only tool; process list exposure is brief.

## Current state

- Server running detached with all changes live; UI rebuilt (latest bundle `index-CtbCSDxM.js`).
- user1 archive backup running via auto-resume with the new delta enumeration.
- 30 changed files uncommitted (8 untracked + 22 modified) — below the 50-file threshold, no commit.
- EXO sizes scan blocked on tenant grant (`UnAuthorized` until `Exchange.ManageAsApp` + Exchange admin role is added to the app registration).

## Next steps

- Tenant: grant **Exchange.ManageAsApp** (Office 365 Exchange Online, application) + admin consent, and assign **Exchange Administrator** role to the service principal; then re-run "Fetch Sizes (EXO)".
- Optionally port `lib/setup.js` `grantArchive()` off the removed `-Device` flag (currently dead code path; archive already granted).
- Consider persisting queued tasks across restarts if the queue sees heavy use.
- Commit + push when the 50-file threshold is reached or on request.
