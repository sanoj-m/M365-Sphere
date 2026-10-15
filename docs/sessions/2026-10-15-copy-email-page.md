# "Copy email" page — dedupe-style copy tool, live-source, queue, date fidelity (2026-10-15)

(Multi-day session series, 2026-10-09 → 2026-10-15. UPNs/domains replaced with
placeholders — public repo.)

## Goals

- New standalone "Copy email" page (`/?copyemail`): copy emails from the local
  backup (primary + archive) to a live folder or local backup folder of any
  mailbox — copy only, structure recreated, duplicates skipped, "all options
  dedupe has".
- Iterated UX: single-mailbox page, collapsible Primary/Archive panels,
  viewport-height side-by-side Source | Destination, floating Copy tasks
  panel, persistence of everything until Reset, item-level email picking,
  combined root folder totals, confirm dialog with folder list, job queue.
- Copy with correct dates/identity (no drafts, original timestamps) — for all
  past and future copies/moves.
- Live mailbox as a copy source.

## What was done

**Core feature** — `lib/copyemail.js` (new `CopyEmailEngine`), routes in
`server.js` (`POST /api/copy-email`, `/api/copy-email/retry`,
`GET /api/copy-email/jobs|queue`, `DELETE /api/copy-email/queue/:id`,
`POST /api/stop/copy-email`; `copyEmailRunning`/`copyEmailRuns`/
`copyEmailQueue` in `/api/status`), page `web-react/src/components/CopyEmailPage.jsx`
(routed in main.jsx, nav link in App.jsx). Dedupe at destination: Message-ID,
subject+receivedAt, fuzzy ±2 min/±10% size, sha256 for local. Local copies get
`cpy`/`cpy-` ids; engine reconciliation skips `cpy%` like `exo%`
(lib/engine.js). `fuzzyDupes` exported from lib/dedupe.js.

**Date fidelity (major)** — Graph MIME import proved broken on this tenant:
creates undraftable drafts with import-time dates (PATCH isDraft/0x0E07
silently ignored). All live uploads switched to EWS `CreateItem` with
PR_MESSAGE_FLAGS + delivery/submit FILETIMEs: new `ews.uploadMessage`,
`ews.convertRestIds` (ConvertId RestId is tenant-blocked — bridged via Graph
`Binary 0x0FFF` PR_ENTRYID → EntryId→EwsId), `ews.moveToDeletedItems`,
`graph.folderEntryId`. Applied to copy-email, lib/copy.js, and compare
transfers/undo. `graph.postMessageMime` also base64-encodes now (tenant
rejects raw MIME). FTS items (Graph-IE backups) reconstruct MIME via new
`ftsMime`/`ftsDate` in lib/fts.js (FILETIME props 0x0E06/0x0039; ~72k items in
user1's archive were date-less). DB backfilled: `scripts/backfill-fts-meta.js`
(29,761 items). Past wrong-dated copies repaired live:
`scripts/fix-copy-dates.js <upn> [--apply]` (user1: 48+204 patched;
user2-archive: 59 patched). HARD RULE added to AGENTS.md conventions.

**UX iterations** — single mailbox at a time (server-enforced 409 while any
run active); collapsible Primary/Archive source panels; "Archive root" flatten
rule (name-based, recorded in AGENTS.md); viewport-height Source|Destination
columns; CopyTasksPanel floating right sidebar (route bubbles from↓to with
folder deep-links — browse.jsx learned `?mailbox&scope&folderId`; labeled
hover tooltips; live progress incl. GB via bytesTotal/bytesDone); combined
subtree totals on root folders here and in browse.jsx (simplified to combined
only after feedback); confirm dialog (placement: into folder / mailbox root /
new root folder; lists checked folders; item-mode hides folder option);
item-level email picker column (per-folder items endpoint, picks accumulate,
persist); failed-item retries (`failedKeys`, `POST /api/copy-email/retry`,
"Retry N failed" buttons); DB-backed **queue** (`copy_queue` table,
pumpQueue on completion + startup sweep, cancel per entry); live-mailbox
source mode (`srcMode:'live'`, client-supplied srcFolders, listMessageKeys →
getMessageMime per item).

**Selection semantics** — settled on: checkbox cascades DOWN (parent+subtree),
children never cascade up, hover "↳ subfolders only" action, engine copies
exactly the checked folders (descendant expansion removed).

**Restart discipline** — two user copies were interrupted by mid-session
deploy restarts; rule adopted: check DB `jobs WHERE status='running'` (not
just `/api/status`) before any restart; cron watchers (`*/15`) deployed
backend changes only when fully idle.

## Decisions

- One copy job at a time (user's ask) + queue instead of parallelism — shared
  tenant throttling and dest-skip races make concurrent runs unsafe.
- FTS reconstruction limits: transport headers usually absent in tenant IE
  streams → To/Cc/Message-ID often lost on those copies (From/Subject/date/
  body/attachments preserved).
- Undo of past copies was superseded by date repair (user pivoted).

## Current state

- All deployed; server running with all changes. copy-email jobs on user1
  completed (17,603-item archive→user2-archive run + 24,349-item self-restore
  incl. retries; final runs done).
- Frontend builds clean; `node --check` clean on all touched backend files.
- AGENTS.md updated continuously this session (feature entry, archive-root
  rule, date-fidelity hard rule, FTS/queue notes).

## Next steps

- Watch first live-source copy results (sizes hidden — tenant omits `size` in
  live listings, so GB progress only shows for backup-source runs).
- Possible: dedupe-check job rows occasionally left 'running' after completion
  (observed twice; reconcile-on-boot covers it, cosmetic fix pending).
