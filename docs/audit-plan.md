# M365-Sphere — Audit Plan

_2026-10-16. Objectives, scope, method, and execution phases for a full audit
of the app. Findings are rated Critical / High / Medium / Low / Info with
file:line references; every Critical/High gets a repro script under `scripts/`._

## 0. Objectives

1. **Data safety** — prove the app can never silently lose email (backup, copy, move, dedupe, PST export/import).
2. **Security** — dashboard is localhost + session-token; verify nothing escapes that trust boundary; secrets never leak (logs, public repo, installer).
3. **Correctness** — sync engines (Graph delta, EWS cursor, EXO eDiscovery) capture everything the server holds.
4. **Recoverability** — every long-running job resumes correctly after crash/restart/stop.
5. **Maintainability** — dead code, dependency risk, migration hygiene.

Method per area: static review → targeted dynamic tests against a test mailbox → evidence in the audit report.

## 1. Security

### 1.1 Session-token auth (`server.js`, `lib/auth.js`, `web-react/src/api.js`)
- [ ] Every `/api/*` route requires the token — enumerate routes mechanically, confirm middleware covers all incl. `/api/events` (SSE) and `/session-token.js`.
- [ ] Bind address is `127.0.0.1` only.
- [ ] Token entropy (CSPRNG?), file permissions, rotation on restart invalidates old tokens.
- [ ] SSE stream does not leak tokens/PII to connected clients.
- [ ] CORS: no `Access-Control-Allow-Origin: *`.

### 1.2 Secrets handling
- [ ] `config.json` never served via any route (`/api/status`, `/api/setup`, error messages).
- [ ] Tokens (`data/exo-download-refresh-token.json`, MSAL cache) never logged; pre-authenticated `downloadUrl` values never hit logs.
- [ ] Grep `lib/` logging for tokens/secrets/Authorization headers.
- [ ] Public-repo hygiene: re-run saver scan; `.gitignore` covers `data/`, `config.json`, `pst-*`, installer binaries, tenant-specific scripts.

### 1.3 Injection & path safety
- [ ] Filesystem paths from UPNs/folder names: test `../`, reserved Windows names (CON, NUL), trailing dots/spaces, >MAX_PATH after the long-path migration.
- [ ] SQL: prepared statements everywhere — grep for interpolated SQL in `lib/store.js`, `server.js`.
- [ ] KQL injection in `lib/exoexport.js` search queries.
- [ ] PowerShell escaping (`psq`) in `lib/exo.js` `buildScript`, `ps/Export-MailboxToPst.ps1`.
- [ ] React XSS: no unsanitized `dangerouslySetInnerHTML`; email HTML preview sandboxing (`lib/preview.js`).

### 1.4 Update mechanism (`lib/updater.js`, `scripts/update-apply.bat`) — high-value target
- [ ] Release zip integrity: signature/hash or pure HTTPS trust — document the trust model.
- [ ] Zip-slip path validation on extraction.
- [ ] `robocopy /MIR` exclusion list complete (data/, config.json, node_modules/, tools/, .git, logs).
- [ ] Exit-42 relaunch: failed update must not leave watchdog looping.

### 1.5 Dependencies
- [ ] `npm audit` backend + `web-react/`; review `pst-extractor`, `mailparser`, `better-sqlite3` versions.
- [ ] Confirm no dependency exfiltrates email content.

## 2. Data integrity (no-loss guarantees)

### 2.1 Move/Copy engines (`lib/moveemail.js`, `lib/copyemail.js`, `lib/copy.js`)
- [ ] Ordering invariant everywhere: destination verified BEFORE source retired.
- [ ] Skip taxonomy: exact (msgId/key) → retire; fuzzy-only → keep. Regression-test (fuzzy-retire bug class).
- [ ] Date fidelity hard rule: automated Graph readback on uploads (`isDraft:false`, receivedDateTime == source) incl. edge cases (pre-2000, missing Date header, FTS-reconstructed).
- [ ] FTS reconstruction (`lib/fts.js` `ftsMime`): null-case, attachment fidelity.
- [ ] Undo completeness: partial run, mid-folder stop, server restart (move-email plan in DB; compare undo in-memory — documented).
- [ ] Known gap: live→live "mailbox root" destination flattens source structure — spec the engine fix.

### 2.2 Backup engine (`lib/engine.js`, `lib/graph.js`, `lib/ews.js`)
- [ ] Graph delta: cursor loss (410 Gone), token expiry mid-delta, empty-delta self-heal.
- [ ] EWS hidden/associated accounting (`hiddenCount`) — can real items be misclassified hidden and skipped forever?
- [ ] Graph eventual consistency: `listMessages` missed bulk-imported items for weeks — can backup completion criteria falsely declare a folder complete? Propose verification pass / count-quarantine.
- [ ] Reconciliation: remote deletions keep local copies (`deletedFromSourceAt`); `exo%`/`cpy%` exclusions.
- [ ] Atomic `.eml.gz` writes (tmp+rename), gzip corruption detection, sha256 backfill coverage.
- [ ] Concurrent-job matrix: backup ∥ PST ∥ copy ∥ move ∥ dedupe — allowed pairs and shared-state risks.

### 2.3 Dedupe (`lib/dedupe.js`)
- [ ] `mimeFingerprint` false-positive analysis (forwarded-with-comment vs original) on a test corpus.
- [ ] Fuzzy gates (±2 min, ±10% size); `$select=size` fallback path.
- [ ] Live apply resume from `dedupe_live_plan`: kill mid-apply → resume → no double-move, no re-verify.
- [ ] Local `_duplicates/` + manifest restore round-trip.

### 2.4 PST pipeline (`lib/pst.js`, `ps/Export-MailboxToPst.ps1`, `lib/pstingest.js`, `scripts/pst-repair.js`, `pst-verify.js`)
- [ ] subst drive lifecycle: leaks on crash, drive-letter collisions.
- [ ] Outlook COM failure modes (no interactive session, profile dialog) — error detection.
- [ ] pstingest MAPI reconstruction vs original headers (sample-compare).
- [ ] Partial/empty PST deletion policy — no false deletions.

### 2.5 EXO export (`lib/exoexport.js`)
- [ ] Chunk identity gaps/overlaps at month boundaries (KQL `sent` timezone).
- [ ] Delegated download-token refresh; expiry mid-download.
- [ ] Estimate-vs-export mismatch; `splitSource` completeness; ingest idempotency.

## 3. Reliability & recovery

- [ ] Kill server mid-backup/move/dedupe → auto-resume sweep re-queues, 'interrupted' marking, idempotent resume.
- [ ] `data/watchdog.pause` semantics.
- [ ] DB migrations replay/downgrade safety.
- [ ] Crash logging catches the compare-transfer crash class (open root cause).
- [ ] No route can hang forever holding a guard slot; every stop endpoint interrupts I/O.
- [ ] Disk-full behavior (`diskReserveBytes` preflight).

## 4. API & concurrency

- [ ] Full route table (method, path, guard, conflict rules) from `server.js`; verify against AGENTS.md.
- [ ] Parallel start requests per job class → single winner.
- [ ] Input validation on every POST (type confusion, absurd values).
- [ ] `DELETE /api/mailbox/:upn/folder` — descendants, 409 completeness.
- [ ] SSE client leaks on reconnect storm.

## 5. Frontend (`web-react/src/`)

- [ ] All timestamps via `format.js` helpers (Asia/Dubai) — no raw ISO slicing.
- [ ] "Archive root" flattening applied in every tree view.
- [ ] Context-menu portal regression.
- [ ] Task-panel polling cadence, stale-report clearing.
- [ ] Accessibility: titles/aria-labels, keyboard nav, focus traps.

## 6. Installer & packaging

- [ ] Stage completeness vs exclusion list (no secrets; `config.example.json` clean).
- [ ] Fresh-VM test: install → first-run wizard → backup test mailbox → uninstall (data preserved) → reinstall.
- [ ] Upgrade over existing install; downgrade refusal.
- [ ] winget Node fallback failure modes.

## 7. Performance & scale smoke tests

- [ ] 100k-item backup timing; 3.5k-folder archive scan time.
- [ ] SQLite indexes on hot queries; WAL mode; DB growth.
- [ ] Memory: multi-GB PST ingest (6 MiB chunking), EXO streaming downloads.
- [ ] Adaptive concurrency recovery after sustained Graph 429s.

## 8. Execution

| Phase | Scope | Output |
|---|---|---|
| 1 | Security (§1) + route table (§4 static) | findings list |
| 2 | Data integrity (§2) + dynamic no-loss tests | test corpus + results |
| 3 | Reliability kill-tests (§3) | crash matrix |
| 4 | Frontend (§5) + installer (§6) | findings |
| 5 | Performance (§7) + dependency remediation | benchmark table |
| 6 | Report + fix prioritization | audit report w/ severities |

Rules of engagement: destructive tests against test mailboxes only; production
DB read-only; fix-forward in small commits; public-repo scan before every push.

## Known open items (seed findings)

1. Move-email live→live root destination flattens structure (engine fix pending).
2. Graph listing eventual consistency — backup completeness may trust it.
3. Compare-transfer process crash root cause pending a logged repro.
4. `lib/setup.js` `grantArchive()` uses removed `-Device` flag (dead code).
5. EWS deprecation ≤ Apr 2027 — Graph-IE path still default-off.
