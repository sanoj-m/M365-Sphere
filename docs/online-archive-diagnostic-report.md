# M365-Backup Online Archive Diagnostic Report

_Read-only diagnostic investigation of the working tree at `c:\Users\sanoj\Documents\m365-pst-backup`._
_Nothing was modified during the investigation._

## 1. Executive Summary

The application **can and does back up Exchange Online Archives** — this is a designed,
implemented feature (EWS `SyncFolderHierarchy`/`SyncFolderItems` rooted at
`archivemsgfolderroot`, delta cursors, resume, per-scope UI buttons). The primary mailbox
uses Microsoft Graph; the archive uses raw EWS SOAP with app-only impersonation.

The failure mode with a ~460 GB archive is almost certainly **not** a crash or a bug in
download mechanics. It is architectural:

1. **If the archive is auto-expanding (AEA)** — which a 460 GB archive essentially always
   is, since a single archive partition caps at 100 GB (with auto-expanding raising to
   ~110 GB/partition) — **EWS physically cannot see the auxiliary partitions** (~360+ GB
   of the 460 GB). This is a hard Microsoft limitation, confirmed in the code
   (`lib/engine.js:217-219`, `lib/exo.js:1-4`, `README.md:275-277`). The app backs up only
   the main partition and logs a warning. The only path that can reach the full 460 GB is
   the Graph eDiscovery export (`lib/exoexport.js`), which the README says is
   **parked/disabled pending Purview pay-as-you-go billing** (`exoExportEnabled: false`,
   README.md:297-300).
2. Even for the reachable main partition, a 460 GB-scale archive via **item-by-item EWS
   `GetItem` MIME fetches** (one SOAP call per message, fully buffered) is extremely slow
   and throttling-bound — viable but days-long at this scale.
3. The designed fallback for AEA — manual Purview portal PST export +
   `POST /api/exo-ingest` (`importLocalPsts`) — exists and works around all API limits.

Root cause category: **Online Archive / Auto-Expanding Archive handling problem** caused
by an **Exchange Online limitation (EWS cannot read auxiliary partitions)**, compounded by
**download architecture (per-item EWS fetch is the wrong tool at 460 GB)** and a
**permissions/billing gap (eDiscovery path not enabled)**. Not a pagination,
authentication, or discovery bug.

## 2. Application Architecture

- Language: JavaScript (Node.js), `engines: node >=22` (package.json:13-15)
- Backend: Express 4.21.2 (lockfile 4.22.3), entry `server.js`, port 8080 localhost-only,
  token-authed
- Frontend: React SPA (Vite), `web-react/src` → `web-react/dist`
- Database: SQLite via better-sqlite3 13.0.3, `data/state.db` (WAL, synchronous=NORMAL)
- Microsoft SDKs: **none**. No `@azure/msal-node`, no Graph SDK, no EWS managed API.
  Auth is hand-rolled client-credentials over `fetch` (`lib/auth.js`); Graph and EWS are
  hand-rolled REST/SOAP clients (`lib/graph.js`, `lib/ews.js` with fast-xml-parser 4.5.0)
- Other deps: pst-extractor 1.12.0 (pure-JS PST reader), archiver 8.0.0,
  mailparser 3.9.31, node-windows 1.0.0-beta.8
- No queue system (in-process job flags + SQLite `jobs` table); no Docker; filesystem
  storage under `data/store/<upn>/<scope>/<folderPath>/<sha1>.eml.gz`
- PST export: Outlook COM automation via `ps/Export-MailboxToPst.ps1` (requires classic
  Outlook, interactive session)
- Package manager: npm; build: `cd web-react && npm run build`

## 3. Microsoft 365 APIs Used

Four distinct Microsoft interfaces:

1. **Microsoft Graph v1.0 REST** (`lib/graph.js`) — **primary mailbox only**:
   - `GET /users/{upn}/mailFolders` and `…/mailFolders/{id}/childFolders` (`$top=200`) —
     folder tree
   - `GET /users/{upn}/mailFolders/{folderId}/messages/delta?$select=id` — delta sync
     (no `$top`, deliberate)
   - `GET /users/{upn}/messages/{id}/$value` — MIME download
   - `GET /users?$select=…&$top=999` — mailbox discovery
   - `POST …/messages/{id}/move`, `POST …/messages` (MIME import) — copy/dedupe features
2. **Exchange Web Services SOAP** (`lib/ews.js`) — **archive only**, fixed endpoint
   `https://outlook.office365.com/EWS/Exchange.asmx`, `Exchange2013_SP1`, Exchange
   impersonation, exactly 5 operations:
   - `SyncFolderHierarchy` (root: `DistinguishedFolderId Id="archivemsgfolderroot"`,
     MaxChangesReturned 512, SyncState cursor) — `lib/ews.js:262-299`
   - `SyncFolderItems` (per folder, IdOnly, 512/call, SyncState cursor) —
     `lib/ews.js:302-336`
   - `GetItem` with `IncludeMimeContent=true` — `lib/ews.js:338-365`
   - `FindFolder` (Shallow, IndexedPageFolderView 100/page) — folder tree walk + sizes
   - `GetFolder` with extended property `PR_MESSAGE_SIZE_EXTENDED` (0x0E08) — sizes
   - **No `ExportItems`, no `FindItem`** — the one EWS operation designed for bulk export
     is not used.
3. **Exchange Online PowerShell** (`lib/exo.js`) — statistics only:
   `Connect-ExchangeOnline -AccessToken`, `Get-Mailbox` (ArchiveStatus,
   AutoExpandingArchiveEnabled), `Get-EXOMailboxStatistics [-Archive]`. Sole source of
   true AEA total size.
4. **Microsoft Graph eDiscovery API** (`lib/exoexport.js`) — full-archive export:
   `ediscoveryCases` → `ediscoverySearch` (KQL `sent>=… AND sent<…`) →
   `additionalSources` → `estimateStatistics` → `searches/{id}/exportResult`
   (exportFormat `pst`, `splitSource`) → stream `exportFileMetadata[].downloadUrl`.
   Per README currently gated off (`exoExportEnabled: false`) pending Purview billing.

Not used: IMAP, Graph beta, Graph mailbox export APIs, EWS `ExportItems`.

## 4. Authentication & Permissions

- Flow: **client credentials, application permissions, client secret**
  (`lib/auth.js:25-36`, raw POST to `/oauth2/v2.0/token`). Certificate auth explicitly
  unimplemented (`lib/auth.js:22-23`). No delegated flow for backup; one delegated
  refresh token exists solely for eDiscovery PST download.
- Scopes requested: `https://graph.microsoft.com/.default` and
  `https://outlook.office365.com/.default` (`lib/auth.js:45-46`).
- Documented registration (README.md:53-56): Graph `User.Read.All`, `Mail.Read`;
  Exchange Online `full_access_as_app` + `ApplicationImpersonation` role (required for
  archive access — the EWS envelope impersonates each user, `lib/ews.js:19-30`).
- Grant scripts:
  - `scripts/grant-appperm.ps1` → app role `Exchange.ManageAsApp`
  - `scripts/grant-ediscovery-graph.ps1` → `eDiscovery.ReadWrite.All` (app) + delegated
    `eDiscovery.Download.Read` on MicrosoftPurviewEDiscovery (`b26e684c-…`)
  - `scripts/grant-ediscovery.ps1` → service principal into "eDiscovery Manager" role
    group
  - `scripts/exo-delegate-token.js` → device-code refresh token via first-party client
    `fb78d390-…`
- On this tenant (per AGENTS.md/README): EWS `full_access_as_app` + impersonation granted;
  `Exchange.ManageAsApp` + eDiscovery grants may still be pending (EXO sizes fail
  `UnAuthorized` if missing).

## 5. Primary Mailbox Flow

`POST /api/backup` (server.js:313) → `Engine.runBackup` (engine.js:160) →
`backupMailbox` (196) → `syncScope('primary')` (405) → `graph.folderTree` (graph.js:179,
bounded-parallel batches of 4, incremental `onFolder` upserts) → per-folder `syncFolder`
(engine.js:495) → `graph.deltaIds` (deltaLink cursor in `folders.deltaToken`) → one
transaction queues pending rows + stores cursor (engine.js:576) → fetch loop,
`cfg.concurrency||3` batches → `graph.getMessageMime` → sha256 + gzip (buffered) → write
`.tmp` + atomic rename → `items` row `status:'done'` → `_flushBytes` → end-of-mailbox
shortfall accounting → status done/partial. Resume: per-folder cursors + per-item rows;
auto-resume sweep re-queues partial mailboxes.

## 6. Online Archive Flow

Same engine path with `scope='archive'`:

1. **Detection**: reactive, not proactive. Archive scope is attempted unconditionally; a
   folder-not-found error sets `hasArchive:0` and skips (engine.js:225-229).
   `hasArchive`/`autoExpandingArchive` are learned from EXO `Get-Mailbox`
   (server.js:373-374). No `ArchiveGuid` usage anywhere.
2. **Enumeration**: `_enumArchive` (engine.js:311-386) → EWS `SyncFolderHierarchy` on
   `archivemsgfolderroot` with cursor `mailboxes.archiveHierarchyState`; on stale cursor
   resets and retries once; on other failure falls back to full `FindFolder` walk
   (serial). Synthetic root row injected so root-held items sync (ews.js:254-255).
3. **Items**: per folder `ews.syncFolderItems` (512-change pages, per-folder
   `syncState`); `ews.getItemMime` per item (whole MIME base64 in one SOAP response,
   buffered, `r.text()` → `Buffer.from(b64)`).
4. **AEA**: after archive sync, if `autoExpandingArchive`, logs: *"auto-expanding
   archive: auxiliary archive storage is not accessible via EWS — backup covers the main
   archive partition only"* (engine.js:217-219). Whole-folder-inaccessible gaps are
   recorded as `hiddenCount` with log "auxiliary partition?" (engine.js:605-607) so the
   mailbox isn't stuck 'partial' forever — i.e. **the app deliberately papers over the
   missing ~360 GB as "hidden"**.
5. **Full coverage path**: `lib/exoexport.js` eDiscovery PST export → `lib/pstingest.js`
   ingests PSTs into the store as `exo`-prefixed rows. Currently gated
   (`exoExportEnabled`), needs Purview pay-as-you-go billing + the grants in §4.

## 7. Primary vs Online Archive Comparison

| | Primary | Archive |
|---|---|---|
| API | Graph v1.0 delta + `$value` | EWS SOAP sync + GetItem MIME |
| Folder enum | Full walk each run, parallel ×4 | SyncFolderHierarchy delta cursor, serial fallback |
| Item listing | messages/delta | SyncFolderItems |
| Coverage | Whole primary mailbox | **Main archive partition only** (AEA aux invisible) |
| Folder paging | nextLink | IndexedPageFolderView 100 |
| Resume | deltaToken per folder | syncState per folder + archiveHierarchyState |

## 8. Pagination Analysis

Pagination is correct everywhere; **no early-stop bug**:

- Graph: generic `pages()` iterator follows `@odata.nextLink` verbatim
  (graph.js:147-155); delta follows nextLink until deltaLink and *throws* if a page has
  neither (238-243) — guards against silent truncation. No `$top` on delta.
- EWS: FindFolder loops on `IncludesLastItemInRange` (100/page);
  SyncFolderHierarchy/SyncFolderItems loop on `IncludesLastItemInRange` with 512-change
  pages, cursors persisted.
- No 100/500/1000/10000-item cap exists. Pagination is **not** the cause of archive
  failure. Caveat: the serial `folderTree` EWS walk is slow (~10 min per 3.5k folders)
  but bounded.

## 9. Throttling & Retry Analysis

- EWS `call()` (ews.js:69-144): 10 attempts; 429 honors Retry-After with escalation to
  120 s + shared cross-worker cooldown; 5xx exponential to 60 s; retryable SOAP faults
  `ErrorServerBusy|ErrorTimeoutExpired|ErrorInternalServerTransientError`; per-call 120 s
  timeout (`httpTimeoutMs`); terminal: `EWS throttled persistently`.
- Graph `req()` (graph.js:65-140): 10 attempts; adaptive concurrency (start 6, halve per
  429, +1 after 50 successes); shared cooldown; 401 retried once with token refresh;
  404 → null.
- Engine: per-item poison guard `attempts >= 5` → failed (engine.js:648-653); failed
  items re-queued next run; a failed folder doesn't abort the run; stop/interruption is
  safe (cursors + rows committed per folder); auto-resume sweep.
- eDiscovery export: 5 retries, backoff `min(30·2^(n-1), 600)` s, 30 min/phase timeout
  (download ×3); crash recovery resets `running` chunks to `pending`.
- Assessment: solid for 429/5xx. Weakness at 460 GB scale: **EWS budget throttling for
  heavy GetItem loads is the binding constraint** — the retry layer survives it, but
  throughput collapses; a full 460 GB at even 1 msg/s is months. This is why the
  eDiscovery path was built — but it's throttled to ~2 GB/hr itself (comment
  exoexport.js:8, Microsoft-imposed).

## 10. 460 GB Archive Analysis

- **API capability**: EWS reaches only the main partition (~100-110 GB of 460 GB if AEA).
  Graph mail API has no archive capability used here. eDiscovery reaches everything but
  is disabled. ❌ for full coverage via the default path.
- **Authentication capability**: app-only EWS impersonation is sufficient for the main
  partition; eDiscovery needs `eDiscovery.ReadWrite.All` + delegated download token +
  Purview billing — per docs, pending. ⚠️
- **Archive discovery capability**: works (reactive detection + EXO ArchiveStatus). ✔️
- **Message retrieval capability**: correct but one SOAP GetItem per message, fully
  buffered in memory — functional at any size, painfully slow at millions of items. ⚠️
- **Attachment capability**: attachments ride inside MIME (no separate API); EWS includes
  them in MimeContent. ✔️ but inflates per-item payload.
- **Pagination capability**: ✔️ no cap.
- **Throttling capability**: retries robust; throughput is the issue — EWS throttling +
  serial-ish per-item fetch. ⚠️
- **Storage capability**: ✔️ per-item `.eml.gz` files, sha1 filenames (NTFS-safe), subst
  workaround for legacy long paths; no total-size cap. Disk must hold ~460 GB+
  (gzip helps).
- **Database capability**: ✔️ SQLite INTEGER is 64-bit; JS doubles; per-item rows scale
  (millions of rows fine for SQLite).
- **Resume/retry capability**: ✔️ per-folder cursors, per-item status, auto-resume.
- **Overall architecture**: sound for incremental sync; wrong tool (per-item EWS) for
  initial bulk acquisition of 460 GB; correct tool (eDiscovery PST export) already built
  but parked on billing/grants.

**The limiting component, in order**: (1) EWS cannot see AEA auxiliary partitions —
coverage ceiling ~110 GB of 460 GB; (2) eDiscovery path disabled by missing Purview
billing/grants; (3) per-item EWS throughput for what remains.

## 11. Storage Architecture

M365 → Graph/EWS full MIME → in-memory gzip → atomic rename →
`data/store/<safeUpn>/<primary|archive>/<folderPath>/<sha1(itemId)>.eml.gz`, with `items`
row (size, sha256, status). Attachments are inside the MIME (not separate). Verify =
sampled gunzip+sha256 re-check (engine.js:816-845). Dedupe groups on sha256. PST export
reads these files via Outlook COM (49 GB rollover, `maxPstSizeGB`). Zip folder export
capped at 2 GB (`maxExportBytes`, server.js:273,287). EXO-exported PSTs land in
`data/exo-export/<upn>/<from>_<to>.pst` (streamed download, exoexport.js:251-259) then
ingested to `.eml.gz` by pstingest.

## 12. Database Analysis

better-sqlite3, tables: `mailboxes` (upn PK; `serverPrimaryBytes`, `serverArchiveBytes`,
`ewsPrimaryBytes`, `ewsArchiveBytes`, `hasArchive`, `autoExpandingArchive`,
`backupScope`, `archiveHierarchyState` — separate primary/archive stats), `folders`
(PK upn+scope+folderId; itemCount, deltaToken, syncState, hiddenCount), `items`
(PK upn+scope+folderId+itemId; size, sha256, attempts, status), `events`, `jobs`,
`exo_exports` (PK upn+chunkFrom+chunkTo), `copy_items`. All sizes/counts SQLite INTEGER =
signed 64-bit — **no 32-bit limitation**. No VARCHAR length traps (TEXT). Events
truncated to 2000 chars. No schema-level obstacle to 460 GB.

## 13. Size/Limit Analysis

| Limit | Value | Where | Type |
|---|---|---|---|
| PST rollover | 49 GB | pst.js:187, ps1:8,158 | App |
| Zip export | 2 GB | config maxExportBytes; server.js:273 | App |
| eDiscovery export rate | ~2 GB/hr | exoexport.js:8 (comment) | **Microsoft** |
| AEA aux partitions unreachable via EWS | — | engine.js:217-219, exo.js:1-4 | **Microsoft** |
| EXO export chunk | 6 months sent-range | exoexport.js:265 | App |
| EWS pages | 100 folders / 512 changes | ews.js:189,270,313 | App-chosen |
| Graph $top | 200/999 | graph.js | App-chosen |
| HTTP timeout | 120 s | httpTimeoutMs | App |
| 100 GB / 1 TB constant | none anywhere | — | — |

## 14. Error Handling

Logging via `events` table + SSE. Notable archive-relevant messages: AEA warning
(engine.js:217-219); "auxiliary partition?" / "hidden/associated" gap logs
(engine.js:605-609); permanent-skip on 403/impersonation errors → mailbox 'skipped' with
remediation hint (engine.js:233-239); EXO `UnAuthorized` → Exchange.ManageAsApp hint
(exo.js:130-132); eDiscovery 401/403 → GRANT_HINT (exoexport.js:23).
**Error-hiding risk**: `hiddenCount` accounting intentionally absorbs unreachable content
so the mailbox shows 'done'/'partial' without an error — for AEA this means the missing
~360 GB manifests only as a UI gap heuristic (serverArchiveBytes − ewsArchiveBytes >
max(1 GB, 5%), MailboxTable.jsx:39) and a log warning. If you only watched job status, a
460 GB archive could look "backed up" while 80% is untouched.

## 15. Existing Tests

No test suite (AGENTS.md: "Syntax check backend: `node --check` … (no test suite)").
Only `scripts/_smoke.js`. No coverage of archive, pagination, throttling, resume, or
large mailboxes.

## 16. Documentation vs Actual Implementation

README accurately documents: archive via EWS with SyncFolderHierarchy cursor, AEA
main-partition-only limitation ("Microsoft limitation — affects backup coverage"),
49 GB PST split, Outlook COM requirement, eDiscovery export parked pending billing,
~2 GB/hr throttle. Discrepancies (minor): `concurrency` default documented as 3 vs 6 in
config.example; `pstRetryCount` 1 vs 2; AGENTS.md describes exoexport as
custodian+review-set based but the code now uses `additionalSources` + direct
`exportResult` (exoexport.js:370-401). The documented design matches the diagnosis in §1.

## 17. Exact Root Cause / Suspected Root Causes

Ranked by technical likelihood:

**Issue 1 — Auto-expanding archive auxiliary partitions unreachable (root cause)**
- Evidence: 460 GB archive ⇒ AEA (single partition ≤110 GB). EWS sees main partition
  only.
- File: `lib/engine.js:217-219`, `lib/ews.js:262-299` (rooted at
  `archivemsgfolderroot`), `lib/exo.js:1-4`
- Function: `Engine._enumArchive`, `Engine.backupMailbox`
- Current behavior: backs up main partition; logs warning; counts the rest as
  `hiddenCount` (engine.js:605-607) so status can reach 'done'
- Why it affects Online Archive: ~360 GB of the 460 GB is in auxiliary partitions no
  sync API exposes
- Severity: **Critical (coverage)** — Microsoft platform limitation, not fixable in the
  sync path

**Issue 2 — Full-archive path (eDiscovery export) disabled/pending**
- Evidence: README.md:297-300 ("parked via `exoExportEnabled: false`… until billing is
  enabled"); requires Purview pay-as-you-go + `eDiscovery.ReadWrite.All` + delegated
  download token; AGENTS.md "grants pending"
- File: `lib/exoexport.js`, `scripts/grant-ediscovery-graph.ps1`
- Current behavior: the only component that can fetch AEA aux content is not operational
- Severity: **Critical (blocker)** — configuration/tenant state, not code

**Issue 3 — Per-item EWS GetItem throughput at 460 GB scale**
- Evidence: one SOAP call per message, whole MIME base64 buffered
  (`lib/ews.js:338-365`); serial per folder, `concurrency` batches only across small
  slices; EWS throttling budget
- File: `lib/ews.js:338-365`, `lib/engine.js:618-628, 679-702`
- Current behavior: correct but potentially weeks/months for the first full archive
  pass; heavy 429 exposure
- Severity: **High (practical feasibility)** for the reachable partition

**Issue 4 — Silent partial success**
- Evidence: `hiddenCount` absorption (engine.js:605-609) + shortfall formula excluding
  hidden (engine.js:256-268)
- Current behavior: mailbox can report 'done' while most archive bytes were never fetched
- Severity: **Medium (observability)**

Ruled out by code inspection: pagination caps, auth model for EWS archive (impersonation
present and working), DB integer overflow, folder discovery bugs, Graph being asked to
read the archive (it isn't — archive is EWS-only by design).

## 18. Evidence With File Names & Line Numbers

Key locations: ews.js:6 (endpoint), ews.js:262-336 (archive sync ops), ews.js:338-365
(GetItem MIME, buffered), engine.js:217-229 (AEA warning + reactive hasArchive),
engine.js:256-268 + 605-609 (hiddenCount absorption), engine.js:644-728 (buffered gzip
write), exo.js:1-4 (AEA sizes comment), exoexport.js:8 (~2 GB/hr), exoexport.js:370-401
(additionalSources + exportResult), README.md:275-277, 293, 297-300, graph.js:147-155
(pagination), store.js:56-94 (schema/migrations).

## 19. Recommended Architecture

**Approach A — keep existing APIs**: (1) Enable + finish the eDiscovery path: Purview
pay-as-you-go billing, run `grant-ediscovery-graph.ps1`, acquire the delegated download
token, set `exoExportEnabled:true`; use it for the archive bulk baseline (6-month chunks
already resume-safe), then keep EWS incremental sync for the main partition delta.
(2) Improve observability: surface `hiddenCount`/AEA gap as a first-class per-mailbox
warning instead of absorbing it. (3) Optionally parallelize archive item fetch across
folders (currently effectively serial per folder). EWS `ExportItems` would be the faster
bulk call but adds complexity; per-item GetItem already works.

**Approach B — Microsoft-supported large-data mechanism**: the Graph eDiscovery
(Premium) export *is* the Microsoft-supported mechanism and is already implemented
(`lib/exoexport.js`) — the change is operational (billing, grants, delegated token), not
architectural. The zero-billing variant also already exists: manual Purview portal
export of the archive to PST → place in `data/exo-export/<upn>/` →
`POST /api/exo-ingest` (`importLocalPsts`, exoexport.js:470-508) → `lib/pstingest.js`
ingests into the browsable store. For ongoing deltas after the baseline, EWS incremental
sync suffices (aux partitions only grow by archival policy moves).

## 20. Required Changes — NOT IMPLEMENTED

1. Tenant/ops: enable Purview pay-as-you-go billing; run
   `scripts/grant-ediscovery-graph.ps1`; run
   `scripts/exo-delegate-token.js "b26e684c-…/.default offline_access"
   data/exo-download-refresh-token.json`; set `exoExportEnabled: true` in config.json.
   (Config/tenant only — no code.)
2. Code (optional, Approach A): expose AEA coverage gap in UI/status (use existing
   `serverArchiveBytes − ewsArchiveBytes` and `hiddenCount`); consider cross-folder fetch
   parallelism for archive scope; consider streaming gzip in `fetchItem` and streaming
   attachment reads in `pstingest.js:55-56` to bound memory.
3. Documentation: reconcile AGENTS.md review-set description with current `exportResult`
   implementation.

## 21. Relevant Code Snippets

1. **Auth** — FILE: lib/auth.js, FUNCTION: `_fetchToken`/`graphToken`/`ewsToken`,
   LINES: 25-46. Client-credentials POST; scopes `graph.microsoft.com/.default`,
   `outlook.office365.com/.default`:
   ```js
   graphToken() { return this.token(this.cfg.scopes || 'https://graph.microsoft.com/.default'); }
   ewsToken()   { return this.token('https://outlook.office365.com/.default'); }
   ```
2. **EWS envelope/impersonation** — FILE: lib/ews.js, FUNCTION: `soap`, LINES: 19-30.
   `ExchangeImpersonation` + `PrimarySmtpAddress`, `Exchange2013_SP1`.
3. **Archive enumeration** — FILE: lib/ews.js, FUNCTION: `syncFolderHierarchy`,
   LINES: 262-299:
   ```xml
   <m:SyncFolderId><t:DistinguishedFolderId Id="archivemsgfolderroot"/></m:SyncFolderId>
   <m:MaxChangesReturned>512</m:MaxChangesReturned>
   ```
4. **Archive item listing** — FILE: lib/ews.js, FUNCTION: `syncFolderItems`,
   LINES: 302-336 (IdOnly, per-folder SyncState).
5. **MIME fetch (buffered)** — FILE: lib/ews.js, FUNCTION: `getItemMime`,
   LINES: 338-365; Graph equivalent `getMessageMime`, graph.js:248-251
   (`GET …/messages/{id}/$value`).
6. **AEA limitation** — FILE: lib/engine.js, FUNCTION: `backupMailbox`, LINES: 217-219:
   ```js
   this.log('warn', upn, `auto-expanding archive: auxiliary archive storage is not accessible via EWS — backup covers the main archive partition only …`);
   ```
7. **Hidden-gap absorption** — FILE: lib/engine.js, FUNCTION: `syncFolder`,
   LINES: 605-609 ("auxiliary partition?"); shortfall formula 256-268.
8. **Graph pagination** — FILE: lib/graph.js, FUNCTION: `pages`, LINES: 147-155
   (verbatim nextLink following); delta guard 238-245.
9. **Write path** — FILE: lib/engine.js, FUNCTION: `fetchItem`, LINES: 679-702
   (`gzipAsync(mime)` → `.tmp` → rename; sha256; attempts poison guard 648-653).
10. **Throttling** — FILE: lib/ews.js, FUNCTION: `call`, LINES: 69-144 (Retry-After,
    shared cooldown, 10 attempts); FILE: lib/graph.js, FUNCTION: `req` + `_throttled`,
    LINES: 59-140 (adaptive concurrency).
11. **eDiscovery export** — FILE: lib/exoexport.js, FUNCTION: `_runChunk`,
    LINES: 359-445 (KQL chunk search → estimateStatistics → `exportResult`
    exportFormat 'pst' → streamed download 251-259); chunk planner 265; delegated
    download token 215-240.
12. **Archive detection via EXO** — FILE: lib/exo.js, LINES: 41-46
    (`ArchiveStatus -eq 'Active'`, `AutoExpandingArchiveEnabled`); mapped
    server.js:373-374.
13. **PST ingest scope heuristic** — FILE: lib/pstingest.js, LINES: 19, 141-142
    (`/archive|online archive/i` → scope 'archive'); attachment buffering 55-56.

## 22. Information Still Missing

- Whether the 460 GB archive actually has AEA enabled on your tenant
  (`Get-Mailbox … AutoExpandingArchiveEnabled`) — cannot determine from source code; run
  `POST /api/sizes` or check `mailboxes.autoExpandingArchive` in `data/state.db`.
- Current tenant grant state (`Exchange.ManageAsApp`, `eDiscovery.ReadWrite.All`,
  delegated download token, Purview billing) — per docs "pending"; cannot verify from
  code.
- The actual failure symptom observed (error text in `events`/`jobs` tables, UI status) —
  the repo has no test data proving where a given run stops. Querying `data/state.db`
  events for the affected mailbox would pinpoint which ranked cause fired first.
