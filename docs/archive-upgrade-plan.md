# M365-Sphere — Full Archive / AEA / Reliability Upgrade Plan

_Status: proposal only — no implementation yet. Awaits approval._
_Research date: 2026-10-01. All capability claims cite Microsoft Learn / Microsoft devblogs._

---

## 1. Current Architecture Summary (confirmed from source)

- Primary mailbox: Graph v1.0 `/users/{upn}/mailFolders…` + `messages/delta` + `messages/{id}/$value` (MIME) — `lib/graph.js`.
- Archive: EWS SOAP at `archivemsgfolderroot` — `SyncFolderHierarchy` / `SyncFolderItems` / `GetItem` (MIME) — `lib/ews.js`, driven by `lib/engine.js` (`_enumArchive`, `syncFolder`).
- Store: `.eml.gz` per item under `data/store/<upn>/<scope>/<path>/<sha1>.eml.gz`, sha256 per item, SQLite (`lib/store.js`), per-folder delta cursors, auto-resume.
- AEA gap: EWS sees only the main archive partition; unreachable content is absorbed into `hiddenCount` so a mailbox can report `done` with most archive bytes missing.
- eDiscovery PST export pipeline exists (`lib/exoexport.js`) but is parked (`exoExportEnabled: false`) pending Purview billing; manual portal PST + `POST /api/exo-ingest` (`lib/pstingest.js`) is the working zero-cost route.
- PST export out is Outlook COM (`lib/pst.js`).

## 2. Microsoft API Research (new findings)

### Graph Mailbox Import/Export APIs — the key one

- Base: `/admin/exchange/mailboxes/{mailboxId}` with `mailboxFolder` (CRUD + **delta**) and `mailboxItem` (get/list + **delta**); operations `exportItems` and `createImportSession`.
  Overview (beta): https://learn.microsoft.com/en-us/graph/api/resources/mailbox-import-export-api-overview?view=graph-rest-beta
- Mailbox IDs are opaque (`MBX:…@tenant-guid`), obtained from `GET /users/{id}/settings/exchange` (`exchangeSettings.primaryMailboxId`, and **`inPlaceArchiveMailboxId`** in beta). App-only OK (`User.Read.All`).
  https://learn.microsoft.com/en-us/graph/api/usersettings-list-exchange?view=graph-rest-1.0
- **GA on v1.0 announced 2026-05-07 — but GA covers primary and shared mailboxes only. Archive mailboxes (and thus AEA) are beta-only today.** Compare v1.0 vs beta overview pages.
  https://devblogs.microsoft.com/microsoft365dev/announcing-general-availability-of-the-mailbox-import-and-export-microsoft-graph-apis/
- `POST …/exportItems` `{itemIds:[…]}` — **max 20 item IDs per request**, all from one mailbox. Response 200 with per-item `{itemId, changeKey, data}` where `data` is a **base64 opaque full-fidelity stream (FTS — Fast Transfer Stream)**, explicitly "not intended for parsing", no MIME variant offered.
  https://learn.microsoft.com/en-us/graph/api/mailbox-exportitems?view=graph-rest-beta
- **AEA auxiliary partitions are explicitly supported in beta via HTTP 308 Permanent Redirect**: `Location` points to the same path under a different `MBX:` GUID on the same host. `exportItems` signals redirects per-item inside the 200 response as `{code:"ErrorArchiveFolderMovedPermanently", message:"<redirect URL>"}`.
  https://learn.microsoft.com/en-us/graph/handle-archive-mailbox-redirects (updated 2026-07-21)
- Delta: `folders/delta`, `folders/{id}/items/delta` with standard deltaLink/skipToken semantics; item delta filters limited to `receivedDateTime`.
  https://learn.microsoft.com/en-us/graph/api/mailboxitem-delta?view=graph-rest-beta
- Restore counterpart: `createImportSession` → opaque preauthenticated `importUrl` (do NOT add your own Authorization header) → POST `{FolderId, Mode:create|update, Data:<base64 FTS>}`.
  https://learn.microsoft.com/en-us/graph/api/mailbox-createimportsession?view=graph-rest-beta
- Permissions (least privilege): export = app **`MailboxItem.Export.All`**; restore = `MailboxItem.ImportExport.All` (superset — only request when restore is built). Folder/item read for enumeration/delta: `MailboxFolder.Read.All`, `MailboxItem.Read.All`.
- Microsoft explicitly states these APIs are **not designed for backup/restore** and points to M365 Backup; throttling = "standard Outlook resource limits", no dedicated numbers documented. Archive/AEA support has no GA date commitment (roadmap ETA Q4 CY2026).
- Classic Graph Mail API (`/users/{id}/mailFolders`) **does not expose the Online Archive** — no `archivemsgfolderroot` well-known name (the `archive` well-known folder is the unrelated One-Click Archive folder).

### EWS — now has a hard deadline (critical)

- **EWS begins being disabled for Exchange Online in October 2026 and is fully disabled by April 2027** (official deprecation page, updated 2026-09-04). The archive-access Graph replacements ("Import-Export (Archive)", "In-Place Archive CRUD") carry ETA Q4 CY2026.
  https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/deprecation-of-ews-exchange-online
- Consequence: the current archive engine has months of life left. This upgrade is not optional; it is a migration.

### eDiscovery / Purview export (existing fallback)

- `ediscoverySearch: exportResult` (exportFormat `pst`; `eml` deprecated). Documented limits: **2 GB/hr per mailbox export rate**, auto-cancel after 7 days, PST split at 10 GB, 40 GB per export package, 2 TB (Standard)/5 TB (Premium) per org per day, downloads expire 14 days.
  https://learn.microsoft.com/en-us/purview/edisc-ref-limits
- **API export on E3 tenants requires Purview pay-as-you-go billing** (stated on the exportResult API page itself). App-only `eDiscovery.ReadWrite.All` is documented as sufficient. Microsoft also cautions these APIs are for investigations, "shouldn't be used as a substitute for journaling".
- PowerShell: `New-ComplianceSearchAction -Export` retired 2025-05-26; `New-MailboxExportRequest` is on-prem only. **No supported PowerShell PST export for Exchange Online remains.** `Get-EXOMailboxStatistics -Archive` still works for sizes.

### Microsoft 365 Backup Storage API

- Restore-back-into-M365 only; **"data never leaves the Microsoft 365 data trust boundary"** — no local export path. $0.15/GB/month PAYG, partner/controller-oriented. Archive/AEA coverage not documented. **Unsuitable for local downloadable backup.**
  https://learn.microsoft.com/en-us/microsoft-365/backup/backup-overview?view=o365-worldwide

## 3. Acquisition Method Comparison

| Capability | A: Graph Mailbox Import/Export (beta) | B: eDiscovery PST (API) | C: EWS sync | D: Manual portal PST + ingest | E: M365 Backup Storage |
|---|---|---|---|---|---|
| Primary mailbox | ✔ (GA) | ✔ | ✔ | ✔ | ✔ (in-place only) |
| Online Archive | ✔ (beta) | ✔ | ✔ main partition | ✔ | not documented |
| AEA / auxiliary | ✔ (beta, 308 redirects) | ✔ | ✖ | ✔ | not documented |
| App-only auth | ✔ | ✔ (billing req.) | ✔ | n/a | ✔ |
| Incremental/delta | ✔ (folder+item delta) | ✖ (date chunks) | ✔ (syncState) | ✖ | restore points |
| Full fidelity | ✔ (FTS) | ~ (PST/MAPI) | ~ (MIME) | ~ (PST/MAPI) | ✔ |
| MIME output | ✖ | via ingest recon | ✔ | via ingest recon | ✖ |
| Local downloadable | ✔ | ✔ | ✔ | ✔ | ✖ |
| Hundreds of GB | likely (no documented cap) | 2 GB/hr/mailbox throttle | slow, works | slow but works | yes but no egress |
| Resume | app-built | chunked in app | ✔ exists | manifest | n/a |
| Cost | none documented | PAYG billing | free | free | $0.15/GB/mo |
| Support status | beta for archive | GA | **deprecated, dies ≤2027-04** | portal feature | GA |
| Restore path | createImportSession (FTS) | PST import (portal) | none | none | native rollback |
| Impl. complexity | medium-high | exists | exists | exists | n/a |

## 4. Recommended Final Architecture

- **Primary baseline + incremental:** unchanged — Graph Mail (GA, MIME, delta). Keep.
- **Archive enumeration + incremental:** new **Graph Mailbox Import/Export provider (beta)** — archive mailbox ID from `exchangeSettings.inPlaceArchiveMailboxId`, folder/item delta, 308-redirect-aware client. This replaces EWS as primary archive path (EWS is being disabled anyway).
- **Archive baseline + AEA/auxiliary acquisition:** Graph `exportItems` in 20-item batches, following `ErrorArchiveFolderMovedPermanently` redirects across aux mailboxes — **dual-format store**: `.fts.gz` (restore source of truth, opaque, never parsed) + `.eml.gz` browse copy where obtainable (EWS MIME while EWS lives for main partition; PST-ingest reconstruction for aux content).
- **Bulk/escape hatch for AEA:** keep eDiscovery path — **free manual portal PST export + `exo-ingest`** (zero-cost default), API `exoexport.js` behind existing flag if billing is ever enabled.
- **EWS:** retained as legacy/fallback/shadow-validation provider, clearly labeled "main partition only", with a documented end-of-life (disabled by April 2027).
- **Restore (later phase):** `createImportSession` + FTS upload; EML restore via existing Graph MIME import stays for primary.
- Provider interface (`discoverMailbox/discoverFolders/enumerateChanges/fetchItems/verifyCoverage/healthCheck`) + capability registry — justified here because we genuinely run 4 providers with different capabilities.

## 5. 460 GB Workflow (your mailbox)

1. Preflight (new diagnostic): auth, permissions (`MailboxFolder.Read.All`, `MailboxItem.Read.All`, `MailboxItem.Export.All`), archive detected via EXO stats (`Get-EXOMailboxStatistics -Archive` = 460 GB, `AutoExpandingArchiveEnabled`), `inPlaceArchiveMailboxId` resolved, disk-space check (reserve configurable), storage health, DB check.
2. Strategy selection: AEA=YES → Graph IE provider (beta). If beta unavailable/fails at runtime → eDiscovery/manual PST route automatically.
3. Baseline: folder delta enumeration (following 308s into aux partitions, recording a partition inventory row per physical `MBX:` GUID) → per-folder item delta → `exportItems` batches of 20 → stream `.fts.gz` to disk (tmp→rename, sha256) → checkpoint per batch in SQLite. Browse copies: EWS MIME for main-partition items while EWS lives; PST-ingest reconciliation for aux items.
4. Integrity: sha256 per object; sampled gunzip/parse scrub; coverage = local logical bytes+items vs server-reported per partition.
5. Status: `COMPLETE_VERIFIED` only when every partition's coverage passes; otherwise honest `PARTIAL` with GB breakdown. hiddenCount never again marks unreachable content "done" — it contributes to PARTIAL/UNVERIFIED.
6. Incrementals: item delta per folder (redirect-aware) + periodic full reconciliation (configurable interval) because AEA moves content between partitions.
7. If Graph IE archive beta proves unusable in testing: automatic fallback — Purview portal export (free) → `exo-ingest` → ingest verification → coverage against EXO-reported 460 GB.

## 6. Database Changes

Migration-style `ALTER TABLE … catch{}` additions in `lib/store.js` (DB file backed up to `data/state.db.bak-<date>` before first migration run):

- New table `archive_partitions` (mailbox_upn, partition_id (MBX guid), partition_type main|aux, discovered_via, redirect_from, item_count, logical_bytes, backed_up_items, backed_up_bytes, status, first_seen_at, last_seen_at).
- New table `backup_runs` (id, upn, scope, provider, started_at, ended_at, items_discovered/new/changed/deleted/failed, bytes, coverage_state).
- `items` += `format` ('eml'|'fts'), `source_api`, `physical_mailbox_id`, `deleted_from_source_at`, `verified_at`, `verify_method`; index on (upn, scope, status) reviewed for million-row ingestion.
- `folders` += `physical_mailbox_id`, `is_expanded` (AEA expanded folder), `redirect_url`.
- `mailboxes` += `archiveMailboxId` (Graph MBX id), `coverageState`, `coverageCheckedAt`.
- Deletion semantics: remote deletions set `deleted_from_source_at`, files retained (graveyard stays opt-in via `pruneDeleted`).

## 7. Storage Changes

- Keep `data/store/<upn>/<scope>/<path>/<sha1>.eml.gz` untouched (existing backups stay valid).
- Add restore copy alongside: `<sha1>.fts.gz` (opaque FTS, gzipped, sha256 of raw stream). `items.format` tracks which exist.
- Write discipline stays tmp→verify→rename; orphaned `.tmp` sweep on startup.
- Configurable store root already exists via `cfg.dataDir`; document NAS caveats (locking, atomic rename) rather than building volume management now.

## 8. Security Changes

- New app permissions (least privilege): `MailboxFolder.Read.All`, `MailboxItem.Read.All`, `MailboxItem.Export.All`; restore permission deferred.
- Redirect safety: only follow 308/`ErrorArchiveFolderMovedPermanently` URLs on host `graph.microsoft.com` over HTTPS, same path pattern, max 5 redirects, no credential forwarding beyond the existing bearer to that host, log every transition, loop detection.
- importUrl handling: never log, never attach extra auth headers.
- Token/secret redaction sweep of logging paths (events table truncation already exists).
- Grant script: `scripts/grant-mailboxie.ps1` for the three new app roles.

## 9. UI Changes

- Coverage model: `job status` ≠ `coverage status`; coverage states (NOT_STARTED…COMPLETE_VERIFIED…PARTIAL/BLOCKED/FAILED) on mailbox table + mailbox page.
- Archive panel: partition breakdown (Main/Aux N, bytes, verified) from `archive_partitions` — only real measured numbers.
- Existing `archiveGapBytes` banner (just shipped) upgraded into the coverage view.
- Mailbox diagnostics page: ArchiveStatus, AEA, per-API access tests (Graph IE probe incl. one redirect test), storage health, "Test backup capability" (read-only).
- TasksPanel: per-provider progress (items/s, MB/s, throttle state, current concurrency).

## 10. Testing Plan

- New `tests/` using `node:test` (no new deps): unit — redirect following (valid/loop/bad host/max), 429 Retry-After, retry classification, exportItems batching (20 cap), chunk base64, hiddenCount→PARTIAL accounting, idempotent re-ingest.
- Integration with a mock HTTP server simulating: archive mailbox, two aux partitions with 308s, delta tokens, exportItems batches, crash mid-batch (restart resumes at checkpoint, no duplicates).
- Synthetic scale: generate 1M item rows via scripted inserts; measure DB growth/query latency; no payload data.
- Restore drill (manual checklist in README): backup test mailbox → restore 3 messages to a recovery folder → verify metadata/attachments/dates.
- Live validation: shadow-run EWS vs Graph IE on one archive mailbox; compare folder/item counts and bytes.

## 11. Implementation Phases

1. **Coverage correctness (no new APIs):** coverage states, hiddenCount→PARTIAL, archive_partitions (populated from EXO stats + EWS), backup manifest, UI coverage display, disk-space preflight. Zero risk, immediately honest reporting for the 460 GB mailbox.
2. **Graph IE prototype (feature-flagged `graphExchangeExportEnabled`):** read-only scripts probing `exchangeSettings`, archive folder delta, one 308 redirect, one `exportItems` batch, FTS format inspection. Validate against your real tenant before touching engine.
3. **Redirect-aware provider:** production `lib/graphie.js` client (enumeration + delta + export + redirect handling + retry classification) behind flag; shadow validation vs EWS.
4. **Production archive provider + dual-format store:** engine integration, `.fts.gz`, checkpoints, strategy selection, EWS demoted to fallback.
5. **eDiscovery/manual fallback hardening:** adaptive chunking, PST verification before ingest, ingest resume, optional PST lifecycle (keep default).
6. **Restore:** `createImportSession` FTS restore to a recovery folder, dry run, admin-only, drill.
7. **Scale & performance:** bounded queues, per-API concurrency accounting, metrics, 1M-row DB tuning.
8. **Docs + tests + audit log + retention controls.**

## 12. Risks / Open Questions

- **Archive/AEA support in Graph IE is beta**; no GA date committed (roadmap Q4 CY2026). Beta behavior can change; feature flags + EWS/eDiscovery fallbacks mitigate.
- **FTS is opaque**: cannot be parsed/searched; browse copies must come from elsewhere (EWS MIME while alive, PST ingest reconstruction). If EWS dies before Graph IE archive GA, there is a window where aux-partition browse copies come only from PST ingest.
- No documented throttling numbers for Graph IE; 20-item batch cap may make 460 GB slow (millions of items × 20/request). Measured in Phase 2 prototype before committing.
- `inPlaceArchiveMailboxId` is a beta property; per-partition sizes are NOT exposed by Graph IE — partition byte inventory must come from EXO stats (total) + our own accumulation per partition (no fabricated numbers).
- Microsoft says the API is "not designed for backup/restore" — acceptable risk given it is the only documented API route to AEA content; eDiscovery/manual PST remains the fully-supported fallback.
- Purview portal manual export for 460 GB: operator effort, 10 GB PST splits, browser/download manager limits — workable but document the drill.

## 13. Files To Change

- Modify: `lib/engine.js` (coverage accounting, provider dispatch, checkpoints), `lib/store.js` (tables/columns above), `server.js` (coverage/diagnostics/partition endpoints, feature flags), `config.example.json` (flags, reserve), `web-react/src/components/MailboxPage.jsx` + `MailboxTable.jsx` + `TasksPanel.jsx` (coverage/partitions/diagnostics), `web-react/src/styles.css`, `README.md`, `AGENTS.md`, `scripts/` (new grant script).
- New: `lib/graphie.js` (Graph Mailbox Import/Export client), `lib/coverage.js` (coverage states + reconciliation), `lib/preflight.js`, `scripts/probe-graphie.js`, `scripts/grant-mailboxie.ps1`, `tests/` (node:test).
- Untouched: `lib/ews.js`, `lib/graph.js`, `lib/exoexport.js`, `lib/pstingest.js` (fallbacks preserved).

## 14. Rollback Plan

- Git branch `feature/archive-upgrade`; checkpoint tag before Phase 1. Each phase = separate commit(s).
- DB: `data/state.db` copied to `data/state.db.bak-<date>` before migrations; all migrations additive (`ALTER TABLE … ADD COLUMN`, new tables) — old code keeps working on a migrated DB.
- New providers feature-flagged off by default; EWS path untouched — reverting = flag off or branch checkout.
- Storage: new `.fts.gz` files are additive; deleting them + the new columns/tables restores the old state. No existing `.eml.gz` is modified.

## 15. Recommendation

Adopt the **hybrid**: Graph Mailbox Import/Export (beta) as the future archive engine with redirect-aware AEA support and dual-format storage, EWS kept until Microsoft's cutoff, free manual Purview PST export + ingest as the zero-cost AEA escape hatch today, eDiscovery API export only if billing is ever approved. Phases ordered correctness-first (Phase 1 fixes the "silent partial" integrity problem without any beta dependency), beta-dependent work isolated in Phases 2–4 behind flags.

**Why not eDiscovery-first:** documented 2 GB/hr/mailbox (≈10 days minimum for 460 GB, per chunk retries), PAYG billing for API use, 14-day download expiry, and Microsoft's own "not a backup substitute" caution. **Why not EWS-first:** Microsoft starts disabling it this month (Oct 2026). **Why not M365 Backup Storage:** no data egress at all. Graph IE is the only API that is free, app-only, delta-capable, and documented to reach auxiliary partitions — with the explicit caveat that archive support is still beta, which is exactly why Phase 2 is a prototype-before-commit gate.
