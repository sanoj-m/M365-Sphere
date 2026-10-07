# 2026-10-02 — Graph Mailbox IE archive provider live on 460 GB, coverage honesty, FTS previews, app hardening

One line: took the archive-upgrade from plan to production — Graph Mailbox Import/Export (beta) provider now downloads user1's 460 GB auto-expanding archive (aux partitions included), coverage reporting is byte-honest, FTS items got heuristic previews with images/attachments, and a long crash-hunt ended in watchdog + token fixes.

## Goals

- "Keep the backup running until I manually stop and get all email in whatever new way you can" (user1 only for now)
- Never affect the source mailbox (read-only guarantee)
- Browsable previews for FTS items incl. images/attachments; list shows sender name + subject + 12 h times
- Remember panel collapse state; honest archive statistics (true totals, per-partition, new mail)
- "Make sure you are keeping the app running and reachable"
- Zero-cost constraint: no Purview pay-as-you-go billing (≈$4,100 for 460 GB via eDiscovery API — declined)

## What was done

### Graph Mailbox IE provider in production (`lib/graphie.js`, `lib/engine.js`)
- Grants run by user: `MailboxFolder.Read.All`, `MailboxItem.Read.All`, `MailboxItem.Export.All` (read/export-only, least privilege) via `scripts/grant-mailboxie.ps1`.
- Probe + shadow validation green: `scripts/probe-graphie.js`, `scripts/shadow-graphie.js` — IE sees exactly what EWS sees, plus aux.
- **Critical redirect bug found & fixed**: `_raw` fell into "retries exhausted" after a 308 instead of following it — no aux content was ever fetched and the run falsely reported COMPLETE (39 GB of 460 GB). Also: Microsoft's `Location` uses mixed-case `/admin/Exchange/Mailboxes/` (policy + id extraction now case-insensitive). Verified live: 8 aux partitions discovered and downloading; 262+ GB stored.
- Parallel batch export (`ieBatchConcurrency`, default 3) within the adaptive 429 budget.
- `ie-` ID namespace coexists with EWS rows; EWS rows merged into the IE tree by normalized path (`store.mergeArchiveNamespaces`); archive root named `Archive root` (empty displayName from delta), tree flattens the synthetic root in the UI.

### Coverage honesty (`lib/coverage.js`, `server.js`, UI)
- Coverage states separate from job status; `hiddenCount` no longer absorbs unreachable content (forces PARTIAL); AEA gap is not BLOCKED when IE enabled; **byte-level check added** (folder itemCounts exclude aux content — item-based coverage faked "complete" at 39/460 GB).
- Remote deletions never delete local copies (`deletedFromSourceAt` timestamp; graveyard/prune opt-ins).
- `archive_partitions` + `backup_runs` tables; per-partition stored stats from redirect-attributed folders (`folders.physicalMailboxId`); stale derived `aux-combined` rows dropped; `+N new in last run` stat.
- EXO `ItemCount` now stored (`serverPrimaryItems`/`serverArchiveItems`) — scope panels show true archive totals instead of the misleading ~12,049 folder sum.

### FTS heuristic previews (`lib/fts.js`, new)
- Reverse-engineered the FTS wire format enough for previews: string props (`0x84B0` marker + propId + byte length + UTF-16) and binary props (`01 02 01 01 37` + length) for attachment payloads.
- Subject/From/To/Cc/Date from embedded transport headers; HTML body; **attachment extraction + download endpoint**; **inline `cid:` images embedded as data URIs** with reuse-tolerant matching (content-id → filename-in-cid → ordered fallback).
- Attachment name↔payload pairing via targeted post-payload window scan (global scan overshoots when big HTML/RTF bodies sit between attachments).
- `metaOnly` fast mode (27 ms on a 20 MB item) used at export + backfills. **The full preview scan with the bare 3-byte marker was quadratic on multi-MB streams and froze the server event loop — root cause of the first two "app unreachable" crashes; fixed with the 5-byte needle.**
- Metadata flows into the list: `items.sender` column, list shows sender name (email stripped) + subject + date; backfills: `scripts/backfill-fts-meta.js` (FTS, ~70k+ items), `scripts/backfill-eml-sender.js` (EML, 30k+ items fleet-wide); `parseMimeHeaders` now extracts From for new Graph downloads.

### Dual provider + UI
- `provider:'ews'` override on `POST /api/backup` + mailbox-page **Browsable copies (EWS)** button: EWS `.eml.gz` main-partition browse copies, auto-merged into the IE tree afterwards. (EWS browse pass NOT yet run for user1 — IE baseline takes priority; EWS SyncFolderItems currently errors `ErrorInvalidIdMalformed` on IE-namespaced folders — known gap to fix when the EWS pass is scheduled.)
- 12-hour clock default + Settings → Time display (12/24 h toggle, timezone picker); panel collapse persists across refresh (`localStorage`).

### Crash hunt + app hardening
- Symptoms: server dying silently every few minutes under backup load; users logged out (401).
- Fixed for real: session token now written only **after** successful port bind (duplicate watchdog-spawned instances dying on EADDRINUSE were rotating the token and logging everyone out); watchdog (`scripts/watchdog.ps1`, 60 s checks) now authenticates with the token and auto-restarts the server (logs to `data/watchdog.log`); server logs stdout+stderr to `data/server-console.log`/`data/server-error.log`.
- Ruled out for the residual silent deaths: AV/Defender, EDR, OOM (90 GB free), port conflicts, Windows service, DB corruption, node-level crashes (no exit event, no WER). Only happens under backup download load; idle server + plain node survive indefinitely. Unidentified — likely native-level (better-sqlite3 under load?) — watchdog + checkpoint-resume keeps impact at ~1 min blips. Stable since the fixes (10/10 min clean survival watch).

### Docs
- `docs/online-archive-diagnostic-report.md`, `docs/archive-upgrade-plan.md` (research + phased plan, approved by user before implementation), AGENTS.md changelog kept current.

## Decisions

- **Zero-cost architecture**: IE provider (free, automated, full fidelity) + manual Purview portal PST export (free, browsable) instead of eDiscovery API export ($10/GB after 50 GB/mo free). Automated eDiscovery export stays parked (`exoExportEnabled: false`).
- FTS stays the restore-grade source of truth; the heuristic parser is preview-only and never feeds back into storage/verification.
- Dual provider (IE for coverage, EWS for browse copies) rather than forcing one format — EWS kept until Microsoft retires it (Apr 2027).
- Restore (createImportSession) deliberately not built — the only write-capable feature; user wants source guaranteed untouched.
- user1-only scope for now: user2 marked `skipped`, fleet-wide queued backup cancelled on user request.

## Current state

- Branch `feature/archive-upgrade`, HEAD `38984eb` (tag `pre-archive-upgrade` on main before all work). Working tree clean.
- user1 archive baseline **running**: 150,639 items / ~263 GB stored of 460 GB (57%), 8 aux partitions reachable, checkpoints resuming cleanly through every restart.
- Server up (API 200) + watchdog active; `graphExchangeExportEnabled: true`, `exoExportEnabled: false`, `autoResume: true`.
- FTS backfill (metaOnly) + EML sender backfill completed for user1; fleet EML sender backfill done (30,364 items).

## Next steps

- Let the IE baseline finish (~200 GB to go); then run **Browsable copies (EWS)** for the main partition (fix the `ErrorInvalidIdMalformed` on the EWS pass first — IE-namespaced folder ids need raw-id mapping).
- Optional: user does the free Purview portal export → **Import archive PSTs** for browsable aux copies (walkthrough documented in mailbox page).
- Remaining plan phases: PST fallback hardening, restore drill (on explicit request only), test suite (`node:test`), search (FTS5), pause UX, audit log.
- Reconcile with the parallel session's EXO export pipeline work (per its own session log note).
