# 2026-09-30 — Storage manager, task management, mailbox table redesign

## Goals

- Fix the error-panel badge counting stale errors after "Clear report" (badge said N, panel said healthy).
- Per-mailbox storage management UI: list data per user, delete primary/archive/PST separately, delete individual folders manually.
- Mailbox name click should open the backup view as a full page (same tab), with a per-user activity log as a floating right panel (like the dashboard activity log, collapsible, hidden by default).
- Grouped/redesigned mailbox table; two columns "Primary stored" / "Archive stored"; borders between columns; simpler Archive flag column; one-click gap repair.
- Fix gaps must run as a background task in parallel with everything else; new "Running tasks" tab in the right panel showing all parallel jobs and their logs.
- Manage the running PST task (stop, view, more data). Investigate Outlook-free PST export; user chose to keep Outlook COM — add reliability (retries, off-hours scheduling) instead.

## What was done

- **ErrorReport** (`components/ErrorReport.jsx`) — badge now applies the same `clearedAt` cutoff as the panel; panel merges client + server log sources (dedup by ts+message) instead of discarding client-side entries; panel auto-re-collects when the live error count changes while open.
- **Storage manager** (`components/StorageManager.jsx`, new) — modal from the new "Manage stored data" header button (old "Clear stored data" renamed "Clear local cache"): mailboxes sorted by size desc, 0 B hidden, per-scope/PST rows with proportional size bars, per-folder delete (checkbox tree, collapsible, expand/collapse-all), delete via new `DELETE /api/mailbox/:upn/folder` (`store.deleteFolder` removes folder + descendants, recomputes bytes; unit-tested against scratch DB). Redesigned per ui-ux-pro-max tokens; mailbox UPN is a link into the backup view; total shows P/A split.
- **Mailbox page** — mailbox name in the table (and "Open live view →" for single-mailbox jobs) now navigates to `/?mailbox=<upn>` (same tab, full page). The page mounts the dashboard activity log as a floating right panel (same `logs log-sidebar` styles), filtered to that mailbox, with clear (per-mailbox `DELETE …/events`), live dot, entry count, and the same collapse-to-rail behavior starting collapsed. Logo links back to `/` on both pages.
- **Mailbox table redesign** (`MailboxTable.jsx`, `styles.css`) — two-tier sticky header with column groups ("Exchange size (server)" / "Stored locally"), vertical separators on every column (stronger on group boundaries), search with icon, selection pill, type-column icons (lucide), status chips with dots (syncing pulses), row actions fade until hover, selected rows get accent edge, zero bytes render as "—", Archive column is a simple green ✓/"—".
- **Fix gaps as background tasks** — server-side queue (`POST /api/fix-gaps`, `GET /api/tasks`, `DELETE /api/tasks/:id`; tasks also in `/api/status.fixTasks`): waits for the engine, runs verify → backup, one at a time; table chip shows Queued/Waiting/Verifying/Backing up; old client-side verify→backup chain removed. Duplicate queueing 409s; queued tasks cancellable.
- **Running tasks tab** (`components/TasksPanel.jsx`, new; App.jsx sidebar tabbed Activity/Running tasks with live count) — card per running job (backup/verify/pst/sizes/copy/dedupe) with progress, detail, elapsed, per-mailbox log lines; fix-gaps queue cards with cancel/stop; "Recently finished" section.
- **PST task management** — granular stop endpoints `POST /api/stop/{backup,pst,sizes,copy,dedupe}`; `/api/status` gains `pstDetail = {running, current:{upn,startedAt}, jobId, out}` (PowerShell output tail, expandable in the card); per-mailbox retry in `lib/pst.js` (`pstRetryCount`, default 2, 30s backoff); off-hours scheduling: `pstWindow {from,to}` in config.json queues exports outside the window (one pending) and auto-starts when it opens.
- **Folder trees** — Expand all / Collapse all added to ScopeTree, StorageManager folder tree, and PstPlanBuilder tree; "Collapse all" now collapses every node (previously kept roots open, which broke on primary due to orphan parentIds); archive trees flatten the synthetic "Archive root" wrapper (children shown at top level).
- **Collapse-all bug** root cause: `buildTree` treats folders with missing parents as roots; the root-open collapse policy left orphan rows expanded in the primary scope.
- Restarted `node server.js` several times (killed duplicate stale instances first — two were running); validated `/api/tasks`, `/api/status.pstDetail` via curl.
- AGENTS.md updated (API quick ref + recent changes); kept mirrored `agents.md` in sync.

## Decisions

- PST export engine: user chose to **keep Outlook COM**. Verified on this machine that no free offline PST writer exists (`libpff-python` 2026 release is read-only — no create/add APIs; PyPI `pypff` is an unrelated package); commercial libs (Aspose ~$999/yr, GemBox ~€500) are the only Outlook-free route. Documented in AGENTS.md so it isn't re-litigated. Reliability (retry + scheduling window) added instead.
- Gap repair is a server queue rather than client chaining: survives page reloads and interleaves with user activity; engine still runs one backup/verify at a time by design.
- PST export blocked during backup was already removed (atomic tmp+rename publish makes concurrent reads safe) — old error the user saw came from a pre-restart process.
- Manage stored data is a modal, not a page — browse path reuses the existing backup view.

## Current state

- Server running detached with all changes live (latest restart after PST retry/window + task-management endpoints).
- React `dist` rebuilt after every UI change (latest `index-DI_2FD56.js`).
- 12 untracked + 25 modified files (37 total) — **below the 50-file commit threshold, no commit made**.
- libpff-python + pypff installed on the machine during the PST investigation (harmless).

## Next steps

- Commit + push once 13 more files change (or on request).
- Consider config: set `pstWindow` if off-hours export is wanted; `pstRetryCount` default 2.
- If PST without Outlook becomes a hard requirement: buy Aspose.Email or GemBox.Email and swap the PowerShell backend (plumbing is in place).
