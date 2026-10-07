# M365 PST Backup — Agent Guide

Read this first; it exists so you don't have to explore the codebase to be effective.
Keep it updated when you change architecture, endpoints, or workflows.

## What this is

Self-hosted Node.js (Express) app that backs up Microsoft 365 mailboxes to local
`.eml.gz` files, verifies integrity, and exports PSTs. React SPA dashboard
served from `web-react/dist` on port 8080 (localhost only, token-authed).

## Toolchain gotchas (Windows)

- `node`/`npm` are NOT on the Bash tool's PATH. Prefix every command:
  `export PATH="/c/Program Files/nodejs:$PATH"`
- Bash is Git Bash: Unix syntax, forward slashes.
- Build UI: `cd web-react && npm run build` (vite → `web-react/dist`).
- Syntax check backend: `node --check server.js lib/engine.js ...` (no test suite).

## Layout

- `server.js` — Express app, all `/api/*` routes, SSE at `/api/events`, session
  token auth, auto-resume sweep. Entry point: `node server.js`.
- `lib/engine.js` — backup engine: `runBackup`, `backupMailbox`, `syncScope`,
  `_enumArchive` (EWS SyncFolderHierarchy delta), verify, live progress
  (`engine.live[upn]` = `{ scope, foldersTotal, foldersDone, itemsTotal,
  itemsDone, currentFolder, enumFound }`).
- `lib/ews.js` — EWS SOAP client (archive access). `folderTree` (full walk,
  `onFolder` callback), `syncFolderHierarchy` (delta with cursor),
  `syncFolderItems` (per-folder delta with syncState), `getItemMime`.
- `lib/graph.js` — Graph client (primary mailbox): `folderTree`, delta sync.
- `lib/exo.js` — EXO PowerShell sizes. App-only auth via
  `Connect-ExchangeOnline -AccessToken <ewsToken> -Organization <tenant>`
  (module 3.10.1 removed `-Device`; device flow is dead). Requires the app
  registration to have `Exchange.ManageAsApp` + Exchange admin role, else
  `UnAuthorized`. Parses `STAT:`/`STATERR:`/`FATAL:` lines from stdout.
- `lib/exoexport.js` — EXO export pipeline (`class ExoExport`): backs up FULL
  mailboxes (incl. auto-expanding archive auxiliary partitions, which EWS
  cannot reach) to PSTs via the Microsoft Graph eDiscovery (Premium) API —
  the replacement for the retired `New-ComplianceSearchAction -Export`.
  Per-chunk: `ediscoverySearch` (KQL `sent>=… AND sent<…`) under a shared case
  (`M365 PST Backup Export`, id cached in `data/exo-case.json`) with the mailbox
  attached via `searches/{id}/additionalSources` → `estimateStatistics` →
  direct search `exportResult` (exportFormat `pst`, `splitSource`) → stream
  `exportFileMetadata[].downloadUrl` to disk
  with a DELEGATED download token (`data/exo-download-refresh-token.json`,
  scope `b26e684c-…/.default` on MicrosoftPurviewEDiscovery). App-only
  `auth.graphToken()` for all Graph calls (needs `eDiscovery.ReadWrite.All`,
  grant via `scripts/grant-ediscovery-graph.ps1`). No PowerShell, no azcopy.
  Chunk state in `exo_exports` table (identity = upn+from+to, unique
  searchName `mb365-<hash8>-<from>-<to>`); done chunks with the PST on disk
  are never re-exported; one chunk at a time; retries with exponential
  backoff (`exoExportRetries`, timeout `exoExportTimeoutMs`). Output
  `data/exo-export/<safeUpn>/<from>_<to|tail>.pst` (`.partial-…` staging dir).
- `lib/store.js` — better-sqlite3 (`data/state.db`). Tables: mailboxes, folders,
  items, events, jobs, copy_items, exo_exports. Schema migrations are `ALTER TABLE … catch{}`
  in the constructor. Notable mailbox columns: `serverPrimaryBytes`,
  `serverArchiveBytes`, `sizeSource` ('exo' preferred), `hasArchive`,
  `autoExpandingArchive`, `backupScope`, `archiveHierarchyState` (EWS hierarchy
  cursor).
- `lib/auth.js` — MSAL client-credentials; `graphToken()`, `ewsToken()`.
- `lib/pst.js`, `lib/copy.js`, `lib/dedupe.js`, `lib/preview.js`, `lib/setup.js`.
- `lib/pstingest.js` — `class PstIngest`: walks downloaded EXO PSTs with
  `pst-extractor` (pure JS) and ingests every message into the browsable
  backup store (`data/store` + folders/items rows). Stable `exo`-prefixed
  folder/item ids (`folderId='exo'+sha1('exo'+upn+scope+path)`,
  `itemId='exo-'+sha1(internetMessageId|…)`); folders under an
  `Archive`/`Online Archive` path segment get scope 'archive'; engine
  reconciliation + shortfall accounting skip `exo%` folderIds (ingested
  folders are invisible to EWS/Graph). Emails keep original RFC822 headers
  when the PST carries them, else best-effort MAPI reconstruction (embedded
  message/OLE attachments skipped). Idempotent: identical sha256 content is
  skipped on re-ingest. Called from `ExoExport._ingestChunk` after each chunk
  publishes its PST(s); per-chunk `ingestedItems`/`ingestedBytes` columns on
  `exo_exports`; `phase` (`search|export|download|ingest`) on
  `exoExport.current`.
- `web-react/src/` — React SPA. Key components: `App.jsx` (dashboard, actions),
  `components/MailboxTable.jsx` (selection toolbar), `components/browse.jsx`
  (`ScopePanel`, `ScopeTree`, context menu via `createPortal` to `document.body`
  — required because ancestor transforms break `position: fixed`),
  `components/MailboxPage.jsx` (per-mailbox page at `/?mailbox=<upn>`),
  `components/BackupPage.jsx`, `components/DetailPanel.jsx`,
  `components/TasksPanel.jsx`, `components/ErrorReport.jsx`,
  `components/ComparePage.jsx` (compare & transfer at `/?compare=<upn>` — local
  store vs live Graph mailbox side by side, checkbox copy/move).
- `web-react/src/format.js` — `fmtBytes`, `fmtTime`, `fmtDate`, `fmtDateTime`.
  ALL displayed timestamps use Asia/Dubai (UTC+4); stored data stays UTC ISO.
- `web-react/src/api.js` — `api`, `post`, `del` helpers (session token header).

## API quick reference (server.js)

- `POST /api/discover` — enumerate mailboxes (Graph).
- `POST /api/backup` — `{ upn | upns, scope?: 'primary'|'archive' }`; 409 if
  backup already running or a copy/dedupe job is active. Backups and PST
  exports run concurrently by design (engine publishes files atomically;
  PST only reads local files).
- `POST /api/stop` — `{}` full stop; `{ scope, upn? }` graceful per-scope stop.
  Granular per-task stops: `POST /api/stop/backup|pst|sizes|copy|dedupe|exo-export|compare`
  (stop exactly one running job; each 409s if that job isn't running).
  `/api/status` includes `pstDetail` = `{running, current:{upn,startedAt},
  jobId, out}` — live per-mailbox PST progress + PowerShell output tail.
- `POST /api/exo-export` — `{ upn? | upns? }` start the unattended
  compliance-search export (409 if already running; independent of backup/PST
  jobs). `DELETE /api/mailbox/:upn/exo-export` deletes its PSTs + records.
  `/api/status` includes `exoExport` = `{running, current:{upn,chunkFrom,
  chunkTo}, chunksDone, chunksTotal, chunksFailed, bytesDone, lastError}`.
  The auto-resume sweep re-queues an interrupted export on startup/periodically
  (loop-free: only when not running).
- `POST /api/sizes` — `{ upn?|upns?, source?: 'both'|'ews'|'exo' }` (default 'both':
  EXO authoritative totals, then EWS accessible-archive measurement for archive
  mailboxes; EWS full walk as fallback if EXO fails). One sizes job at a time.
- `POST /api/scan` — `{ upn?|upns?, scope?: 'primary'|'archive' }` count-only folder-tree walk (Graph primary,
  EWS archive) that upserts server-side `folders.itemCount` without downloading
  items or touching sync cursors — makes the "X / Y emails" totals accurate
  before any backup. Archive is walked when `hasArchive` or when sizes were
  never fetched (unknown); an EWS "folder not found" there just logs a warn
  (no accessible archive). One scan at a time; `POST /api/stop/scan`;
  `scanRunning` in `/api/status`; dashboard "Scan counts" button + "Scan
  Selected" in the mailbox table. Large archives are slow (serial FindFolder
  walk, ~10 min for 3.5k folders).
- `POST /api/verify` — `{ upn? }`; bulk or single-mailbox integrity verify.
- `POST /api/pst` — `{ upn?, plan?, scope?: 'primary'|'archive' }`; one at a
  time. With `pstWindow: {"from":"20:00","to":"08:00"}` in config.json,
  requests outside the window queue (one pending) and auto-start when it opens.
  Per-mailbox retries: `pstRetryCount` (default 1). PST export needs Outlook
  COM on the host (interactive session): no free offline PST writer exists —
  libpff is read-only (verified 2026-09); commercial libs (Aspose/GemBox) are
  the only Outlook-free route — Outlook COM stays the engine for now.
- `POST /api/fix-gaps {upn}` — queue background gap repair (verify → backup
  once the engine is free; one task at a time, queue survives UI use).
  `GET /api/tasks` lists fix-gaps tasks; `DELETE /api/tasks/:id` cancels a
  queued/waiting one. Tasks also appear in `GET /api/status` as `fixTasks`.
- Compare page backend: `GET /api/live/:upn/folders` (Graph folderTree; the tree
  is walked ONLY on `?refresh=1` and then kept forever — memory + persisted to
  `data/live-folders/<safeUpn>.json`, plain GET serves the saved tree or
  `{folders:null}`; `GET …/folders/progress` reports the live walk), `GET /api/live/:upn/items?folderId=`,
  `GET /api/live/:upn/item?itemId=` (preview), `…/download`, `…/attachment?itemId=&index=`
  (all read-only Graph; MIME fetched only for preview/download/transfer), and
  `POST /api/compare/transfer` — synchronous per-item copy/move between the
  local store and a live mailbox (`direction: toLive|toLocal`, `mode: copy|move`,
  toLive items `{scope,folderId,itemId}` + `dstFolderId`, toLocal items `{id}` +
  `dstFolder {folderId,parentId,name,path}` + `dstScope`); toLive move retires
  the local file to the graveyard, toLocal move moves the live message to
  Deleted Items; 409 while a copy job runs. `POST /api/compare/transfer-folder`
  — folder-level COPY (no move) with merge semantics: copies a source folder
  incl. its subtree into the destination folder; same-named destination folders
  are reused (never duplicated), emails already present (Message-ID,
  subject+receivedAt key, content sha256 for toLocal, or live-id+file-on-disk)
  are skipped — duplicated SOURCE emails are transferred only once. toLive body
  `{direction,srcUpn,dstUpn,srcFolder:{scope,folderId,name},dstFolderId}`;
  toLocal body adds `srcFolders` (live subtree rows incl. the folder itself) and
  `dstFolder {folderId,parentId,name,path}` + `dstScope`. Returns
  `{done,skipped,failed,folders,errors[:10]}`; 409 while a copy job runs.
  toLocal archive merges resolve under the local `Archive root` (a root-level
  copy targets it so merge-by-path works), and selecting the same-named archive
  folder as destination merges INTO it instead of creating a like-named child
  (archive-only; primary behavior unchanged).
  `GET /api/compare/progress` → live progress of the running/last compare action
  (kind, label, src→dst, folders/items counters, done/skipped/failed, stopped) —
  powers the compare-mid progress card (bar + stats + Stop, polled while busy).
  `GET /api/compare/undo` → `{available,label,at}`; `POST /api/compare/undo` —
  one-slot in-memory undo (lost on restart) reversing the last compare transfer
  (either route, either direction, copy or move): toLive uploads are moved to
  Deleted Items, toLive-move graveyard files/rows restored, toLocal downloads
  retired to the graveyard + row deleted, toLocal-move live messages moved back
  from Deleted Items, created folders removed deepest-first when empty
  (`graph.deleteFolder` live / folder row + `fsp.rmdir` local). Both transfer
  responses include `undo:{label}`; 409 while a copy job runs or nothing to undo.
  All compare transfers/undos run under one `compareGuard` slot (409 on a second
  concurrent transfer) with cooperative cancellation: `POST /api/stop/compare`
  sets `compareStop`, checked per folder/item (and by the full `/api/stop`);
  responses carry `stopped: true` on a partial run, and `/api/status` exposes
  `compareRunning`.
- `DELETE /api/mailbox/:upn/folder?scope=&folderId=` — delete one backed-up
  folder (disk + DB) incl. descendants; 409 while jobs run.
- `GET /api/status` — aggregates, jobs, `running/sizesRunning/pstRunning`, live.
- `GET /api/mailbox/:upn` and `…/folders` — folders + `live` progress + events.
- `GET /api/events` — SSE stream (log + progress).
- `GET /session-token.js` — serves `window.__SESSION_TOKEN`; the token is also
  in `data/session-token` (rotates on every server restart — re-read it).

## Running / restarting the server

Runs as a detached `node server.js` process (no service). To restart:

```bash
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*server.js*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }; Start-Sleep -Seconds 2; Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList 'server.js' -WorkingDirectory 'C:\Users\sanoj\Documents\m365-pst-backup' -WindowStyle Hidden"
```

Interrupting a backup is safe: folders persist incrementally, items resume
per-folder, and the auto-resume sweep re-queues incomplete mailboxes on startup.
Frontend-only changes need no restart (just `npm run build` + browser refresh).

Query state directly:
```bash
node -e "const D=require('better-sqlite3');const db=new D('data/state.db',{readonly:true});console.log(db.prepare('SELECT * FROM events ORDER BY rowid DESC LIMIT 8').all())"
```

## Conventions

- Match existing code style: 2-space indent, template literals, minimal comments.
- DB migrations: add `try { ALTER TABLE … } catch {}` lines in store.js ctor.
- Live progress: update `engine.live[upn]` fields and call `emitLive()`
  (throttled 500 ms); the UI polls `/folders` every 3 s.
- UI buttons: `btn small` / `btn small danger`, errors via `setErr`/`pushLog`.
- UI timestamps: always `fmtTime`/`fmtDate`/`fmtDateTime` (never slice ISO).

## Known tenant/config facts

- Config in `config.json` (gitignored secrets): tenantId, clientId, clientSecret;
  cert fields empty. App has EWS `full_access_as_app` + impersonation granted.
- EXO app-only (`Exchange.ManageAsApp` + Exchange admin role) may still be
  pending — if EXO sizes fail with `UnAuthorized`, that's the missing grant.
- `lib/setup.js` `grantArchive()` still uses the removed `-Device` flag
  (harmless: archive access already granted on this tenant).
- Auto-expanding archives: EWS sees only the main partition; sizes must come
  from EXO (`sizeSource='exo'` wins over EWS values).

## Token-usage guidance for agents

- Read this file instead of exploring. Explore only the subsystem you're changing.
- Grep with `-n` and path scoping; Read with `line_offset`/`n_lines`.
- Delegate multi-file investigations to subagents; keep the main context lean.
- Don't restart the server for frontend-only changes.

## Code minimalism (ponytail ladder)

Before writing code, stop at the first rung that holds:

1. Does this need to exist? → no: skip it (YAGNI)
2. Already in this codebase? → reuse it, don't rewrite
3. Stdlib does it? → use it
4. Native platform feature? → use it (e.g. `<input type="date">` over a picker lib)
5. Installed dependency? → use it (check package.json/imports first, never add a dep without asking)
6. One line? → one line
7. Only then: the minimum that works

Lazy about the solution, never about reading: read the code the change touches
and trace the real flow first. Never cut validation, error handling, security,
or accessibility. No new files, wrappers, or abstractions the task doesn't need.

## Current state / recent changes (refresh each session)

_Updated 2026-10-01. Keep to ~10 lines; delete entries older than ~2 weeks._

- Compare transfer history: `compare_log` table (one row per completed
  transfer/folder-copy/undo: ts, kind, direction, upns, folder names, counts,
  errors) written by all three `/api/compare/*` routes;
  `GET /api/compare/history?upn=` (optional filter, newest first, 200 rows) and
  a "History" modal on the compare page header.
- Compare cross-channel dupes: all four copy paths in `/api/compare/transfer` +
  `/api/compare/transfer-folder` now ALSO skip on a fuzzy match (`fuzzyDupes()` in
  server.js: same subject + receivedAt ±2 min + size ±10%) — Graph/EWS/IE/PST
  copies of one email have different ids and drifted timestamps/sizes, so
  exact-key dedupe missed them. The same fuzzy rule is built into the dedupe
  engine itself (`lib/dedupe.js` `_fuzzyLocalGroups`/`_fuzzyLiveGroups`): local
  check/apply catches differing-content copies within one folder (sha256 pass
  still owns identical content, mailbox-wide), live check/apply adds fuzzy
  candidates on top of Message-ID groups (live apply still verifies
  byte-identity before moving — fuzzy false positives only cost a download).
  One-off cleanup:
  `node scripts/cleanup-local-dupes.js <upn> [--scope=…] [--apply]` (dry by
  default; retires extras to the graveyard, keeps the folder-namespace-matching
  or oldest copy, LOCAL ONLY; user1 run 2026-10-01: 4,401 retired).
- Compare page Undo: `GET/POST /api/compare/undo` + `↩ Undo` button in the
  page header next to Reset reverses the last compare transfer (one in-memory slot;
  both transfer routes record per-item undo records + created folders and
  return `undo:{label}`). `graph.moveMessage` (moveToDeletedItems now delegates),
  `graph.deleteFolder` (404-tolerant), `graph.ensureChildFolderEx` ({id,created}).
  Transfer bodies accept optional `dstName` (labels) and toLocal `srcFolderId`
  (move-back target for undo).
- Compare page folder copy: `POST /api/compare/transfer-folder` + `◂ Copy folder`
  / `Copy folder ▸` buttons in the compare-mid stack copy a selected folder incl.
  its whole subtree into the folder selected on the other side (copy only, no
  move). Merge semantics: same-named destination folders are reused
  (`ensureChildFolder` live / reuse-by-path local), emails already present
  (subject+receivedAt key; toLocal also live-id + file-on-disk) are skipped.
  New `store.listItemsAll` (no LIMIT) and public `graph.ensureChildFolder`.
- Compare & transfer page (`web-react/src/components/ComparePage.jsx` at
  `/?compare=<upn>`, button on MailboxPage header): local backup store (left)
  vs live Graph mailbox (right) side by side with checkbox copy/move of
  individual emails. New backend: `GET /api/live/:upn/folders|items|item|download|attachment`
  (read-only; folderTree cached 120 s; `graph.listMessages` lists id+subject+
  sender+date, MIME fetched only on preview/transfer) and synchronous
  `POST /api/compare/transfer` (toLive imports local .eml.gz via
  `postMessageMime` + verify, move retires the local file to the graveyard;
  toLocal gz-writes the live MIME into the store under `dstScope` and
  reuses engine ids, move sends the source to Deleted Items; 409 while a copy
  job runs). `lib/preview.js` now exports `itemFile`, `lib/engine.js` exports
  `parseMimeHeaders`.
- Archive-support fixes: `lib/exo.js` `_ensureModule` ReferenceError (`ver`)
  fixed; `Engine.fetchItem` now streams gzip (`pipeline(Readable.from(mime),
  createGzip(), createWriteStream(tmp))`, no full-size gz buffer); archive scope
  is skipped up front when `hasArchive === 0`; `GET /api/mailbox/:upn` returns
  derived `archiveGapBytes` (serverArchiveBytes − archiveBytes when AEA) and
  MailboxPage shows a `.banner-warn` with the Purview-portal + Import PSTs
  workaround; pstingest attachments read in 6 MiB chunks via
  `readFromOffset` (no full-attachment Buffer.alloc). Diagnostic report:
  `docs/online-archive-diagnostic-report.md`.
- Archive-upgrade branch `feature/archive-upgrade` (plan:
  `docs/archive-upgrade-plan.md`, diagnosis: `docs/online-archive-diagnostic-report.md`):
  Phase 1 coverage correctness (`lib/coverage.js`, coverage states on mailboxes,
  `archive_partitions` + `backup_runs` tables, hiddenCount no longer absorbs
  unreachable content — it forces PARTIAL; remote deletions keep local copies via
  `deletedFromSourceAt`, old mirror behind `graveyardDeleted`/`pruneDeleted`;
  disk preflight `diskReserveBytes`; `GET /api/mailbox/:upn/coverage`; mailbox
  page coverage panel + table dot). Phase 2/3: Graph Mailbox Import/Export (BETA)
  provider `lib/graphie.js` — read-only archive folder/item delta + `exportItems`
  (20/batch, FTS opaque streams → `.fts.gz`), 308 aux-partition redirects
  (policy: https+graph.microsoft.com+mailboxes path, 5 hops), engine methods
  `_enumArchiveIe`/`syncFolderIe` behind `graphExchangeExportEnabled` (default
  off), ids namespaced `ie-`. Grants via `scripts/grant-mailboxie.ps1`
  (MailboxFolder/MailboxItem.Read.All + MailboxItem.Export.All — granted
  2026-10-01); probe `scripts/probe-graphie.js <upn> [--export]`, shadow check
  `scripts/shadow-graphie.js <upn>`. EWS archive path remains the default;
  EWS dies tenant-wide ≤ Apr 2027 (Microsoft deprecation).
- EXO PST ingest (`lib/pstingest.js`): each downloaded eDiscovery PST is
  walked with `pst-extractor` (new dependency, pure JS) and ingested into the
  browsable backup store (`data/store` + folders/items rows) so exported mail
  is browsable/verifiable like the EWS/Graph backup. Stable `exo`-prefixed
  ids, archive folders scoped by `Archive`/`Online Archive` path segment;
  engine `_reconcileFolders` + shortfall query skip `exo%` folderIds (minimal
  engine.js guard — ingested folders are invisible to EWS/Graph). Chunk rows
  track `ingestedItems`/`ingestedBytes`; live `phase` on `exoExport.current`;
  TasksPanel EXO card shows phase + ingested totals. Not yet verified against
  a real PST (pending first live Graph export).
- EXO export REWRITTEN to the Graph eDiscovery (Premium) API (`lib/exoexport.js`,
  `POST /api/exo-export`, auto-resume unchanged): per-chunk search → estimate →
  direct `exportResult` (exportFormat `pst`, mailbox attached via
  `additionalSources`) → streamed HTTPS
  download of `exportFileMetadata[].downloadUrl`. Case + custodian ids cached in
  `data/exo-case.json`; app-only Graph token needs `eDiscovery.ReadWrite.All`
  (`scripts/grant-ediscovery-graph.ps1`); download uses a DELEGATED token from
  `data/exo-download-refresh-token.json` (`node scripts/exo-delegate-token.js
  "b26e684c-…/.default offline_access" data/exo-download-refresh-token.json`).
  PowerShell + azcopy machinery removed (retired `-Export` path). Not yet
  verified against the live tenant (grants pending).
- Count scan (`POST /api/scan`): read-only folder-tree walk per mailbox (Graph
  primary + EWS archive) upserts server-side item counts (`folders.itemCount`)
  so "X / Y emails" is accurate without a backup; cursors preserved via
  COALESCE (`deltaToken/syncState` passed undefined); `POST /api/stop/scan`,
  `scanRunning` in `/api/status`; dashboard "Scan counts" + "Scan Selected".
- One-time long-path migration done (`scripts/migrate-long-paths.js`, idempotent,
  `--dry` mode): all 7,212 legacy base64url-named live files renamed to sha1
  `fileId` form with items.fileId/sha256 updated in-transaction; 0 legacy names
  left outside `_graveyard` (1,270 retired files there still base64url — harmless,
  not referenced). Pre-migration DB backup: `data/state.db.bak-migrate`.
- PST exports now subst the store root to a drive letter (M:/X:/Y:/Z:/P:)
  during the run: ~8.5k legacy base64url-named files exceed MAX_PATH and
  PowerShell 5.1 couldn't open/enumerate them (it@ export: 2277/2277 failed,
  271 KB empty PST). Drive is released on child close/error. Exports that are
  stopped or move zero items delete their empty/partial PSTs.
- PST stop fixed: `pst.stop()` no-ops when not running (stale `owner.pid` recycled
  PIDs were taskkilled); retry loop checks `_stop` after the 30 s sleep (a stop
  during the sleep used to respawn the export); `owner.pid` is deleted on child
  exit and `_jobDir` cleared in the finally; `/api/stop` and `/api/stop/pst`
  also cancel a queued window export (`pstPending = null`).

- EXO compliance-search export pipeline (`lib/exoexport.js`, `class ExoExport`):
  full-mailbox PST export incl. the complete online archive (auto-expanding
  auxiliary partitions, which EWS cannot reach). Chunks = sent-date ranges
  (cfg `exoExportChunkMonths`, default 6) + open tail; chunk identity
  (upn, from, to) in new `exo_exports` table — done chunks never re-export.
  One chunk at a time, `exoExportRetries` (5) with backoff, per-chunk timeout
  `exoExportTimeoutMs` (30 min). azcopy auto-installed to `tools/azcopy/`.
  `POST /api/exo-export`, `POST /api/stop/exo-export`, `DELETE …/exo-export`,
  `exoExport` in `/api/status`, job card in TasksPanel, button on MailboxPage,
  auto-resume sweep re-queues an interrupted export (loop-free). Needs two
  tenant grants (documented in README): `Exchange.ManageAsApp` + eDiscovery
  Manager role group membership for the service principal.
- Fixed archive backup loop: EWS `TotalCount` includes hidden/associated
  items that no listing (SyncFolderItems/FindItem) ever returns, so the
  self-heal dropped the cursor and fully re-listed every folder every run.
  Folders now get `hiddenCount` (folders table) recorded once — a full
  re-list that finds nothing new stores `itemCount - remoteIds` as hidden
  and the folder is skipped via cursor next run. hiddenCount is also
  subtracted in the end-of-run "incomplete folders" accounting so
  unreachable content (incl. auto-expanding-archive auxiliary partitions,
  which EWS cannot access at all) doesn't hold the mailbox 'partial'
  forever. Whole-folder-unreachable heal logs "auxiliary partition?"
  wording; partial gaps log "hidden/associated".
- Fixed EWS sync parsing: SyncFolderHierarchy/SyncFolderItems changes use
  `Create/Update/Delete` tags (not Created/…); archive items had NEVER
  downloaded because of this. syncFolder self-heals drifted cursors (empty
  delta + missing items → full re-list); archiveHierarchyState was reset once.
- Copy/move to live mailbox: `lib/copy.js`, `POST /api/copy`, `GET /api/copy/:jobId`,
  `CopyWizard.jsx` on BackupPage. Graph MIME import; per-item existence verify +
  sampled hash re-check; move mode retires source files to the graveyard.
- Dedupe: `lib/dedupe.js`, `/api/dedupe/check|apply|restore`, `DedupeModal.jsx`.
  Standalone page `web-react/src/components/DedupePage.jsx` at `/?dedupe` (nav
  link in dashboard header): MULTIPLE concurrent sessions — add mailboxes via
  the header picker ("Add session"), each session card has its own scope
  toggle, check → apply → restore, live progress, History (per-mailbox
  `dedupe`/`dedupe-check` job rows; Restart on stopped/error resumes, Verify
  again re-checks), and log tail. Sessions/reports/scope persist in
  localStorage (`dedupe.sessions`, `dedupe.target.<upn>`, `dedupe.report.<upn>`);
  Reset clears all. Backend is per-mailbox concurrent: `DedupeEngine._runs`
  (upn → {stop, aborter}), `running` is an aggregate getter, `isRunning(upn)`,
  `stop(upn?)` (no arg = all); apply/restore guard per upn (409 only for the
  same mailbox). `/api/status` exposes `dedupeChecks` (array of live check
  progress, upn-keyed Map) + `dedupeRuns`; `/api/stop/dedupe` takes `{upn?}`.
  Local = SHA-256 groups → `_duplicates/<path>/` + manifest + `status='deduped'`;
  live = Message-ID candidate groups, then MIME SHA-256 verification (only
  byte-identical copies move; any mismatch/fetch error stays) → moved to
  `Deleted Items/Dedupe <date>/<original folder path>` (structure kept, folder
  ids cached per run; `graph.ensureChildFolder` from `deleteditems`). Live scans
  exclude the Deleted Items AND Junk Email subtrees (`_liveFolders`, well-known
  ids) so re-runs resume after a stop and junk is exempt. `jobs.upn` column
  (migration in store.js; `createJob(kind, total, upn)`) attributes runs to a
  mailbox; checks run as `dedupe-check` job rows, applies as `dedupe` rows.
  The Dedupe page keeps the mailbox log tail visible after stop/finish and has
  a History section (per-mailbox check/dedupe runs with status + detail;
  Restart on stopped/error rows resumes, Verify again on done rows re-checks).
- Settings modal (`SettingsPanel.jsx`, gear in header): dark/light theme
  (`data-theme` on <html>, early-applied in index.html), setup/storage links,
  danger zone "Delete all saved data" (two-step type-to-confirm).
- Activity log is a floating right popover (`aside.log-sidebar`, `--log-top`
  tracks header bottom); collapsible rail; mono console styling.

- Mailbox table redesigned: two-tier grouped sticky header (Exchange size /
  Stored locally), vertical column borders, icon type column, dot status chips,
  zero bytes shown as "—", row actions fade in on hover. Mailbox name links to
  `/?mailbox=<upn>` (same tab); status chip opens the detail panel; "Fix gaps"
  chip on failed verify enqueues `/api/fix-gaps`.
- Dashboard right sidebar is tabbed: Activity log + Running tasks
  (`TasksPanel.jsx` — live job cards with per-mailbox log lines and fix-gaps
  queue states).
- Mailbox page (`MailboxPage.jsx`) mounts the same activity log as a floating
  right panel (collapsed to a rail by default), filtered to that mailbox.
- "Manage stored data" modal (`StorageManager.jsx`): per-mailbox storage sorted
  by size (0 B hidden), per-scope/PST delete, per-folder delete via
  `DELETE /api/mailbox/:upn/folder`, browse button into the backup view.
- Mailbox page has per-scope Start/Stop backup buttons (`MailboxPage.jsx` →
  `POST /api/backup {upn, scope}`, `/api/stop {scope, upn}`); engine supports
  `primary`-only and `archive`-only runs.
- Archive enumeration uses EWS SyncFolderHierarchy with cursor in
  `mailboxes.archiveHierarchyState`; folders persist incrementally; UI shows
  `live.enumFound` during enumeration.
- EXO sizes use `Get-EXOMailboxStatistics` with app-only `-AccessToken`;
  pending tenant grant of `Exchange.ManageAsApp` (last test: `UnAuthorized`).
- Fetch Sizes is a single combined run (EXO totals + EWS accessible archive); the separate EXO buttons were removed.
- All UI timestamps render in Asia/Dubai via `format.js` helpers.
- Folder-tree context menu portals to `document.body`; "Collapse all" collapses every node (roots included).
- Copy/Move wizard source picker is now the backup-view folder tree (per scope):
  cascading checkboxes with indeterminate parents, select/deselect all per scope,
  and Expand/Collapse all buttons (`CopyScopeTree`/`CopyTreeNode` in CopyWizard.jsx).
