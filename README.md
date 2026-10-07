# 📦 M365-Sphere

**Self-hosted Microsoft 365 mailbox backup** — a Node.js + React application that
backs up primary mailboxes **and** online archives to local disk, verifies integrity,
browses every message in a web UI, and exports PSTs.

Built for scale: 1,000+ mailboxes, 1 TB mailboxes, multi-day runs. Every item is
checkpointed in SQLite — reboot, crash, re-run: it always continues where it stopped
and never re-downloads what's already on disk.

---

## 🧭 Table of contents

1. [Architecture](#-architecture)
2. [Requirements](#-requirements)
3. [Quick start](#-quick-start)
4. [The four stages](#-the-four-stages)
5. [Online archive: the three channels](#-online-archive-the-three-channels)
6. [PST recovery & repair tooling](#-pst-recovery--repair-tooling)
7. [Data integrity model](#-data-integrity-model)
8. [Security model](#-security-model)
9. [Web dashboard](#-web-dashboard)
10. [API reference](#-api-reference)
11. [Configuration keys](#-configuration-keys)
12. [Project layout](#-project-layout)
13. [Operations](#-operations)
14. [Known limitations](#-known-limitations)
15. [Development](#-development)

---

## 🏗 Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ Windows PC (interactive session)                                 │
│                                                                  │
│  node server.js  (detached process)                              │
│  ├─ Express API + SSE            → http://localhost:8080         │
│  ├─ Engine      (lib/engine.js)  → delta sync, verify, resume    │
│  ├─ Graph       (lib/graph.js)   → primary mailbox (delta + MIME)│
│  ├─ EWS         (lib/ews.js)     → archive main partition        │
│  ├─ Graph IE    (lib/graphie.js) → archive incl. aux partitions  │
│  ├─ eDiscovery  (lib/exoexport.js) → full-mailbox PST export     │
│  ├─ PST writer  (lib/pst.js + Outlook COM)                       │
│  └─ SQLite state (lib/store.js)  → data/state.db (WAL)           │
│                                                                  │
│  React SPA (web-react/dist, Vite build) served by the same app   │
│                                                                  │
│  data/store/<mailbox>/<scope>/<folder>/<item>.eml.gz | .fts.gz   │
│  pst-export/   split Unicode PSTs · data/exo-export/  EXO PSTs   │
└──────────────────────────────────────────────────────────────────┘
```

**Run model:** a detached `node server.js` console process (not a Windows service —
the PST export stage needs Outlook COM, which only exists in an interactive desktop
session). The dashboard binds `127.0.0.1` and is token-authenticated.

All backup channels converge on one store layout, so browse, verify, stats, PST
export, and repair treat every item identically regardless of which API delivered it.

## 📋 Requirements

| Requirement | Why |
|---|---|
| Windows 10/11 / Server, interactive login | Outlook COM (PST export) needs a desktop session |
| Classic Outlook 2016+, opened once | PST writing engine (New Outlook has no COM) |
| Node.js 22+ | better-sqlite3 prebuilt binaries |
| ~1.5× tenant size free disk | gzip lands at ~60–70% of source |

## 🚀 Quick start

```powershell
npm install                 # backend dependencies
cd web-react; npm install; npm run build; cd ..   # dashboard build
node server.js              # → http://localhost:8080
```

Open the dashboard → **Sign in with Microsoft** (device code, Global Admin).
The app creates its own Entra app registration, grants consent, and writes
`config.json`. Archive access (`ApplicationImpersonation`) is granted via a second
device-code sign-in shown in the dashboard.

## 🔄 The four stages

1. **🔍 Discover** — enumerate mailboxes; **Fetch Sizes** pulls authoritative EXO
   totals + EWS-accessible archive measurement; **Scan counts** refreshes per-folder
   server item counts without downloading anything.
2. **💾 Backup** — full first pass, delta forever after. Per-item checkpoints,
   per-folder cursors, atomic tmp→rename publishes, auto-resume after any crash.
   Per-scope runs: primary-only / archive-only.
3. **✅ Verify** — per-folder counts vs live source + gzip integrity sampling;
   self-healing (cursor resets + pending re-download of corrupt items).
4. **📤 Export PST** — split PSTs (49 GB cap) via Outlook COM into `pst-export/`;
   resumable via per-mailbox manifests; window scheduling (`pstWindow`), plan
   builder per mailbox, subst drive-letter workaround for MAX_PATH.

## 🗄 Online archive: the three channels

| Channel | API | Reaches aux partitions? | Status |
|---|---|---|---|
| EWS delta sync | Exchange Web Services | ❌ main partition only | ⚠️ deprecated by Microsoft (fully disabled ≤ Apr 2027) |
| Graph Mailbox Import/Export | Graph **beta** (`lib/graphie.js`) | ✅ yes (308 redirect following) | 🧪 beta; enable with `graphExchangeExportEnabled: true` |
| eDiscovery PST export | Purview eDiscovery (Premium) | ✅ yes, server-side | 💰 needs Purview pay-as-you-go billing |

- **Graph IE** stores restore-grade opaque Exchange FastTransfer streams as
  `.fts.gz` (`ie-` id namespace), with heuristic in-app previews (`lib/fts.js`).
  Grants (one-time, `scripts/grant-mailboxie.ps1`): `MailboxFolder.Read.All`,
  `MailboxItem.Read.All`, `MailboxItem.Export.All` — read-only by design.
- **eDiscovery export** (`POST /api/exo-export`): date-range chunks → search →
  estimate → `exportResult` → streamed PST download → auto-ingest into the browse
  store. Fully resumable; done chunks never re-export. Tenant needs
  `eDiscovery.ReadWrite.All` (`scripts/grant-ediscovery-graph.ps1`) plus a
  delegated download token (`scripts/exo-delegate-token.js`).
- **Free alternative**: export PSTs manually in the Purview portal and drop them in
  `pst-import/<mailbox>/` — the recovery pipeline below handles them.

## 🛠 PST recovery & repair tooling

Graph-IE FTS streams insert 16-byte page-break markers inside large attachments
(undocumented Microsoft format quirk), which corrupts big images in previews.
The repair stack fixes those items **in place** — replacement, never duplication:

| Tool | Source of clean data | Reach |
|---|---|---|
| `scripts/pst-repair.js <upn> <pstDir>` | Purview/Outlook PST exports (`pst-import/<mailbox>/`) | ✅ all partitions |
| `scripts/repair-folder-ews.js <upn> "<folder path>"` | EWS `GetItem` MIME | main partition only |
| `scripts/backfill-fts-meta.js [upn]` | local `.fts.gz` streams | metadata only (sender/subject/date) |
| `scripts/dedupe-items.js [upn] [--dry]` | n/a | removes EWS-vs-GraphIE duplicate copies, keeps the best |
| `scripts/cleanup-local-dupes.js <upn> [--apply]` | n/a | retires cross-channel duplicate copies to the graveyard (fuzzy: same subject ±2 min ±10% size, local only) |

**pst-repair** matches PST messages to stored FTS items (folder path → subject +
date + size), rebuilds faithful `.eml.gz` (original RFC822 headers when present,
`Content-ID` preserved for inline images), verifies every image attachment's end
marker, overwrites the same `fileId`, and deletes the corrupt `.fts.gz`. Every run
appends per-PST stats to `data/pst-import-log.json`.

The mailbox page has a **PST recovery panel** (next to Coverage) with PSTs
imported/pending, rebuilt counts, a live progress bar, per-PST breakdown, and a
**Run PST recovery** button (`POST /api/mailbox/:upn/pst-repair`). The job runs
**detached** — it survives server restarts, with file-based state in
`data/pst-repair-job.json` + `data/pst-repair-run.log`.

## 🔒 Data integrity model

- **Atomic publishes everywhere**: tmp file + rename (items, PST chunks, ingest).
- **Cursor-after-rows invariant**: pending item rows and the sync cursor commit in
  one transaction — a stop mid-folder never loses track of unfetched items.
- **Idempotency**: sha1 fileIds, sha256 skip on re-ingest, chunk identity keys,
  repair overwrites in place.
- **Resume**: startup job reconciliation + 15-minute auto-resume sweep with
  per-mailbox backoff; EXO chunk resume; scope replay (`backupScope`).
- **Verify heals**: missing → cursor reset; corrupt → marked pending.
- **Coverage honesty**: `NOT_STARTED / BACKING_UP / PARTIAL / BLOCKED / FAILED /
  COMPLETE_UNVERIFIED / COMPLETE_VERIFIED` — unreachable content forces PARTIAL,
  never a silent "done".
- **Remote deletions never delete local copies** (`deletedFromSourceAt`; opt-in
  mirroring via `graveyardDeleted`/`pruneDeleted`).
- DB: WAL mode, busy timeout, debounced `VACUUM INTO` snapshots, pre-migration
  backups.

## 🔐 Security model

- All `/api/*` require a per-process session token (`Bearer`, `x-session-token`,
  or `?token=` for downloads/SSE); generated at startup, written `0600` to
  `data/session-token`, re-read on every restart.
- Dashboard binds `127.0.0.1`; remote binding requires explicit `allowRemote: true`.
- `config.json`, tokens, and `data/` are gitignored. No encryption at rest —
  BitLocker the disk if that matters.
- Threat model is single-user localhost. Hardened endpoints: `/session-token.js`
  additionally rejects cross-site browser fetches (`Sec-Fetch-Site` check) so a
  visited website can't steal the token via a script tag, and all filesystem-bound
  names pass through `safeName`, which strips traversal segments (`..`, `.`).

## 🖥 Web dashboard

React 18 + Vite SPA. Highlights:

- **Mailbox table**: live search, sortable columns, multi-select actions, status
  chips, type classification (user/shared/guest), per-row Backup/Archive/PST.
- **Mailbox page** (`/?mailbox=<upn>`): backup explorer (folder tree → item list →
  reading pane with attachments + inline images), per-scope start/stop, coverage
  panel, PST recovery panel, per-mailbox activity log.
- **Compare & transfer** (`/?compare=<upn>`): local store vs live mailbox side by
  side, searchable mailbox pickers (licensed by default, shared/guests opt-in),
  per-item and per-folder copy/move with folder merge (same-named folders reused,
  Message-ID/sha256 + fuzzy subject/date/size dedupe), live progress card with
  stats + Stop, one-slot undo, persistent transfer history (History modal),
  on-demand live folder tree (progress bar, saved to `data/live-folders/`).
- **Dedupe page** (`/?dedupe`): local (SHA-256 + fuzzy) and live (Message-ID)
  dedupe with restore.
- **Running tasks panel**: live card per parallel job (backup, verify, PST, sizes,
  EXO, scan, fix-gaps) with progress and Stop.
- Dark/light theme, Asia/Dubai timestamps, browser-local caching for instant loads,
  ⚠ error collector with AI-ready diagnostic reports.

## 🔌 API reference

All endpoints need the session token. Groups:

```
Status & control
  GET  /api/status                    aggregates, jobs, live progress, running flags
  GET  /api/events                    SSE live log + progress
  GET  /api/logs?n=200                recent log lines
  POST /api/stop                      full stop · POST /api/stop/{backup,pst,sizes,scan,copy,dedupe,exo-export,compare}

Discovery & measurement
  POST /api/discover                  enumerate mailboxes
  POST /api/sizes    {upn?|upns?,source?}   EXO totals + EWS archive measurement
  POST /api/scan     {upn?|upns?,scope?}    count-only folder walk (no download)

Backup & verify
  POST /api/backup   {upn?|upns?,scope?}    full / single / multi / archive-only
  POST /api/verify   {upn?}                 integrity pass (self-healing)
  POST /api/fix-gaps {upn}                  queued verify→repair task (GET /api/tasks, DELETE /api/tasks/:id)

Browse & download
  GET  /api/mailbox/:upn[...]               detail, folders, items, item preview, attachment, download, export-folder (zip)
  GET  /api/mailbox/:upn/coverage           coverage states, partitions, runs
  GET  /api/mailbox/:upn/pst-repair         PST recovery stats · POST = run recovery

PST & EXO export
  POST /api/pst      {upn?,plan?,scope?}    Outlook COM export (plan builder support)
  POST /api/exo-export {upn?|upns?}         eDiscovery full-mailbox PST export
  POST /api/exo-ingest {upn}                import manually-exported PSTs
  DELETE /api/mailbox/:upn/exo-export       delete EXO PSTs + records

Copy / move / dedupe / compare
  POST /api/copy · GET /api/copy/:jobId     copy/move to another mailbox
  POST /api/dedupe/check|apply|restore      local + live dedupe
  GET  /api/live/:upn/folders|items|item|download|attachment   read-only live mailbox
  POST /api/compare/transfer[/transfer-folder]  copy/move between store and live
  GET|POST /api/compare/undo · GET /api/compare/progress · GET /api/compare/history?upn=

Maintenance
  DELETE /api/mailbox/:upn/backup|folder|events   per-scope/folder deletion + event wipe
  DELETE /api/pst/:upn · POST /api/setup/disconnect
```

## ⚙ Configuration keys

`config.json` (gitignored): `tenantId`, `clientId`, `clientSecret` (client-secret
auth only; certificate auth not implemented).

Optional: `concurrency` (3), `sizeScanConcurrency` (3), `autoResumeMinutes` (15),
`newMailCheckMinutes` (60), `pstWindow` (`{from,to}`), `pstRetryCount` (1),
`pstVisible` (false), `exoExportChunkMonths` (6), `exoExportRetries` (5),
`exoExportTimeoutMs` (1800000), `exoExportEnabled`, `graphExchangeExportEnabled`,
`diskReserveBytes`, `graveyardDeleted`, `pruneDeleted`, `allowRemote` (false).

## 📁 Project layout

```
server.js            entry: API, SSE, job orchestration, serves React build
lib/                 engine · graph · ews · graphie · exo · exoexport · store ·
                     auth · coverage · fts · preview · pst · pstingest · copy ·
                     dedupe · util · setup
scripts/             repair/audit/grant/probe tooling (pst-repair, dedupe-items,
                     backfill-fts-meta, repair-folder-ews, grant-*.ps1, …)
ps/                  Export-MailboxToPst.ps1 (Outlook COM writer)
web-react/           React 18 + Vite dashboard source
web/                 minimal fallback UI (if web-react isn't built)
data/                state.db · store/ (backup files) · exo-export/ · logs
pst-import/          drop Purview/Outlook PSTs here for recovery
pst-export/          produced PST files
docs/                session logs, plans, diagnostic reports
```

## 🧰 Operations

**Restart the server**

```powershell
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*server.js*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }; Start-Sleep -Seconds 2; Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList 'server.js' -WorkingDirectory '<repo>' -WindowStyle Hidden"
```

Interrupting anything is safe; the auto-resume sweep re-queues incomplete work.

**For the 1 TB mailbox**: first full pass takes days (tenant throttling) — normal.
`powercfg /change standby-timeout-ac 0`, re-run Backup next day, then Verify, then
Export PST only after verification passes.

**Restore**: open any PST in Outlook (File → Open & Export → Open Outlook Data
File). Folder hierarchy preserved; no restore agent needed.

## ⚠️ Known limitations

- EWS archive path is deprecated by Microsoft (fully disabled ≤ Apr 2027); Graph IE
  is beta. Both are tracked; Graph IE becomes the default archive path.
- Graph-IE FTS streams corrupt large attachments at page breaks (Microsoft format
  quirk) — the `.fts.gz` stays restore-grade, and the PST/EWS repair tooling
  replaces broken previews with clean copies.
- eDiscovery PST export requires Purview pay-as-you-go billing on E3 tenants.
- PST export requires classic Outlook in an interactive session (COM).
- Whole messages are buffered in memory during fetch — multi-hundred-MB items under
  high concurrency can spike RAM.
- No test suite by design; `node --check` is the gate.

## 👨‍💻 Development

- Repo: <https://github.com/sanoj-m/M365-Sphere> (private, `main`). `config.json`,
  `data/`, `node_modules/`, `pst-import/` gitignored.
- Session logs in `docs/sessions/`; the `saver` skill (`.kimi-code/skills/saver/`)
  writes the session log, refreshes docs, and commits when ≥50 files changed.
- Design system: `design-system/m365-sphere/MASTER.md` (OLED dark palette,
  Google Sans + JetBrains Mono) — read before touching styles.
- Agent guide: `AGENTS.md` (architecture map, API quick reference, conventions) —
  kept current every session.
