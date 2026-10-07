# 2026-10-01 — Archive backup reliability + EXO archive export pipeline

One line: fixed the archive backup loop (hidden/unreachable item counts), made backups and PST exports concurrent, then built the full EXO archive-export pipeline — including the PST→backup-store ingest — all the way to Microsoft's pay-as-you-go billing wall, where the automated path was parked and a free manual-import route was shipped instead.

## Goals

- "Archive backup is not running reliably … reruns from the beginning … need it to continue where it left off"
- Copy/move to live mailbox failing (Graph 403)
- Backup and PST export should run together
- "Why does user1's archive backup keep crashing?"
- Build a proper backup of the full online archive: reliable, resumable, no re-runs, self-restarting, browsable in the app like the primary backup

## What was done

### Archive backup loop fix (`lib/engine.js`, `lib/store.js`)
- Root cause: EWS `TotalCount` includes hidden/associated items no listing ever returns; the self-heal dropped the sync cursor and fully re-listed every folder on every run → the crawl never converged ("reruns from the beginning").
- New `folders.hiddenCount` column: a full re-list that finds nothing new records `itemCount - remoteIds` once; reconciled folders skip via cursor next run. `hiddenCount` is also subtracted in end-of-run "incomplete folders" accounting (unreachable content no longer holds the mailbox `partial` → auto-resume churn stopped).
- Verified live: folders log "marked reconciled" once and the run progresses; user1's archive enumeration converged.

### Copy/move 403 + concurrency
- Copy to live mailbox failed with Graph 403 `ErrorAccessDenied`: app had only `Mail.Read` — granted **Mail.ReadWrite** (application permission, admin consent via portal; verified in token roles). `lib/copy.js` now names the missing permission in the error.
- Backups and PST exports now run concurrently (removed stale `pst.running` guard from `POST /api/backup`; engine publishes `.eml.gz` atomically, PST only reads). Copy/dedupe still block backups (they move files).

### Admin "crashing" → auto-expanding archive discovery
- Admin's archive: **493 GB reported, only 281 MB accessible via EWS** — auto-expanding archive auxiliary partitions are unreachable by EWS/Graph (verified: `GetFolder TotalCount=5`, `SyncFolderItems`/`FindItem` return 0). Engine now labels whole-unreachable folders ("auxiliary partition?") and completes the mailbox for the accessible part.

### EXO archive export pipeline (`lib/exoexport.js`, new; `server.js`, UI)
- Chunked (6-month date-range KQL) per-mailbox export with `exo_exports` DB table: done chunks never re-run; retries with backoff; auto-resume after restarts; TasksPanel progress card; output `data/exo-export/<upn>/<from>_<to>.pst`.
- **Auth journey** (all tenant-side grants done + verified): `Exchange.ManageAsApp` app permission; service principal registered in Exchange/Purview + added to `eDiscoveryManager` role group (`scripts/grant-ediscovery.ps1`, interactive admin sign-ins); delegated refresh token via device code using Microsoft's first-party EXO PowerShell client id `fb78d390-…` (tenant app registration can't authorize `dataservice.o365filtering.com`, AADSTS650057) → `data/exo-refresh-token.json`, silently renewed, rotated tokens persisted.
- Compliance-search phase worked end-to-end after fixing: `tools/` mkdir for azcopy download, PowerShell args-as-array, org domain resolution (`killa.onmicrosoft.com` — `tenantName: "Contoso"` is not a domain), `-EnableSearchOnlySession`, TLS 1.2, newline-joined PS script (`; ` breaks `elseif`), and `Starting`/`NotStarted` search statuses.
- **Microsoft retired `New-ComplianceSearchAction -Export`** (May 26 2025) — rewrote the export step on the **Graph eDiscovery API** (v1.0): standard case `M365 PST Backup Export` + per-search `additionalSources` (userSource) + `estimateStatistics` + **`exportResult` (`exportFormat: pst`)** + streamed `exportFileMetadata[].downloadUrl` download. Custodian/`$ref`/noncustodial bindings were all rejected by the live API; the standard-case `additionalSources` + direct search export is the working route.

### PST ingest into the browsable store (`lib/pstingest.js`, new)
- After each PST downloads, `pst-extractor` (pure-JS, new dependency) walks it and stores each message as `.eml.gz` under `data/store/<upn>/{primary|archive}/<folder tree>/` with `items`/`folders` rows — identical layout to the EWS backup, so browse view, per-email preview, storage stats, verify and dedupe all cover archive mail. Stable `exo`-prefixed folder/item ids (idempotent re-ingest); `engine.js` got two minimal guards (reconciliation + shortfall skip `exo%` folders). Fidelity: original RFC822 headers kept when present (`PR_TRANSPORT_MESSAGE_HEADERS`); otherwise best-effort reconstruction; PST stays the authoritative artifact.

### The billing wall + free route
- Live run proved search → estimate works, but `exportResult` returns **"Purview Billing account is not enabled"** — the tenant is E3 (verified subscribedSkus: no E5/Compliance), and the eDiscovery API export bills via Purview pay-as-you-go on standard licenses.
- User declined to pay → parked the automated export: `exoExportEnabled: false` in `config.json`, auto-resume gate in `server.js`, current job stopped.
- Shipped **manual import**: `POST /api/exo-ingest {upn}` + mailbox-page **Import archive PSTs** button — user exports in the Purview portal for free, drops PSTs into `data/exo-export/<upn>/`, clicks the button; `.ingested.json` manifest makes repeats cheap. Everything downstream (browse/verify/stats) is identical.
- Delegated download-token helper generalized: `scripts/exo-delegate-token.js "<scope>" <outfile>` + visible windows `scripts/exo-delegate-token.ps1` / `scripts/exo-download-token.ps1`; Graph grants for eDiscovery.ReadWrite.All + eDiscovery.Download.Read consent via `scripts/grant-ediscovery-graph.ps1` (log verified SUCCESS).

## Decisions

- Whole-mailbox PSTs per chunk (archive-only targeting is not offered by any API) — primary duplication accepted for robustness.
- Ingest is part of the chunk flow (auto, right after download) AND standalone (`importLocalPsts`) — the PST on disk is the authoritative copy either way.
- `hiddenCount` heuristic distinguishes "a few hidden/associated items" (partial gap) from "whole folder unreachable" (auxiliary partition) only in log wording; same skip behavior.
- Delegated tokens via the first-party EXO PS client id (matches what interactive `Connect-IPPSSession` does) — the only working route for compliance search-init + export download.
- Automated export parked rather than deleted: flipping `exoExportEnabled` to `true` after enabling billing resumes the 846-chunk queue with zero code changes.

## Current state

- Working tree clean — a parallel session committed everything (incl. this session's files) across 21 commits since 2026-09-30 noon (head around `df01e6c` …). Note: that session also built a separate "dual provider"/redirect-based aux-fetch path (`lib/fts.js`, `fc27e21`, `8441418`…) — worth reconciling with this session's Graph export pipeline.
- Server running (single instance); `web-react/dist` rebuilt with Import-archive-PSTs button.
- `exo_exports`: 6/846 chunks done (empty ranges); 56 failed from the bug era requeued once, now parked with the export.
- Grants in place and verified: `Mail.ReadWrite`, `Exchange.ManageAsApp`, `eDiscovery.ReadWrite.All`, eDiscovery.Download.Read consent, eDiscoveryManager role group (incl. the app), delegated dataservice refresh token saved.
- Not in place: Purview pay-as-you-go billing (user declined), the second delegated download token (`data/exo-download-refresh-token.json` — only needed when the API export resumes).

## Next steps

- If user enables Purview billing: set `exoExportEnabled: true`, complete `scripts/exo-download-token.ps1` device code, restart server — the pipeline resumes and first real PSTs + ingested archive mail should land within the hour.
- Otherwise: manual path — Purview portal content-search export per mailbox → drop PSTs into `data/exo-export/<upn>/` → mailbox page "Import archive PSTs".
- Reconcile with the parallel session's dual-provider/redirect aux-fetch work (possible overlap with the Graph export).
- First real PST ingest still untested (no live export has completed yet) — watch `transportMessageHeaders` coverage and `getNextChild()` behavior on first import.
- Consider re-enabling EXO export retries cleanup: 56 `failed` chunk rows will be requeued automatically when the export is unparked (or reset them first).
