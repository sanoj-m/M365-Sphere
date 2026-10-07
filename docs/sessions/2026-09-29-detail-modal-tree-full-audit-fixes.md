# 2026-09-29 — Detail panel redesign, modal, full backup-pipeline audit + fixes

One line: redesigned the mailbox detail panel (tabs, folder tree, modal), then ran a full multi-agent audit of the backup pipeline and fixed every gap found.

## Goals

- Detail panel redesign; show only on the explore/dashboard page; events in their own tab; folder tree matching the server's real hierarchy; compact, expanded by default, click-to-expand; events readability + "copy logs for AI agent"; open as a centered popup; show live backup state; fix misleading "Failed — 0 not backed up" chip.
- Answer "why does backup never finish" and then fix **all** audit findings.

## What was done

### UI (web-react)

- `DetailPanel.jsx` — rebuilt: Verification / Events tabs; summary tiles (folders, source, backed up, missing, on disk); error callout; Ark UI folder tree grouped Primary/Archive, built from server `folders` table via real `parentId` links with verify counts overlaid; "Show incomplete only" keeps ancestor chains; all branches open by default (controlled expansion seeded with all branch ids), `expandOnClick`; folder icons everywhere (no mail icon); events tab with aligned timestamp/level-badge rows, 60vh tall, and **Copy logs for AI agent** button (clipboard brief with verify status, missing folders, top errors, last 80 events).
- New `web-react/src/components/ui/tree-view.jsx` — Ark UI TreeView ported to plain JSX + project CSS (`.tv-*` in styles.css); project has no Tailwind/shadcn/TS, deliberately not added.
- `BackupPage.jsx` — its older hand-rolled tree restyled to the same design (chevrons, folder icons, indent guides, Lucide check), row click now selects + expands; behavior (selection, right-click export, live highlight) preserved.
- Panel is now a **modal**: `App.jsx` renders `.modal-backdrop`/`.modal-card`, backdrop click + Esc close. Key bug: the `Reveal` wrapper's CSS transform made `position:fixed` anchor to the wrapper (panel appeared at page bottom) — wrapper removed for the modal.
- Header shows a pulsing **Backup running** chip + live progress block (folders/emails counts, bar, current folder) from new `live` field on `/api/mailbox/:upn`.
- Fixed misleading chip: was `report.pendingTotal` (DB queue, 0) — now uses summed per-folder missing (the real 27,291).
- `api.js` sends `x-session-token` on all requests, `?token=` for SSE and download/export links (`withToken` helper); `index.html` includes `/session-token.js`.
- Installed `@ark-ui/react`, `lucide-react`.

### Backend — full audit (3 explore agents) then fixes (3 coder agents, parallel by file ownership)

- `lib/engine.js` — **fileId = sha1(itemId)** (was base64url → 200–800 char filenames exceeded NTFS limits, every write failed forever) with legacy-file migration (verify+rename, no re-download); shared `folderDir()` for write/delete/disk-count/integrity (verify previously skipped `safeName` → false "corrupt" loop); **one Graph request per item** (MIME only; subject/date parsed from MIME headers); poison items: 404/gone → row dropped, ≥5 attempts → `failed`; delta cursor saved **after** pending-row registration in a transaction; folder rename moves on-disk dir; complete-folder short-circuit; short-check excludes failed items.
- `lib/graph.js` — delta page guard (no-link page throws); 404-on-delta → full folder re-sync; mailbox root synced; network-error + 401 (token clear + retry once) retries; full Retry-After honoring + adaptive concurrency semaphore (halve on 429, recover on success); parallel folder-tree walk.
- `lib/store.js` — `synchronous=NORMAL`, `tx()` helper, `failed` status (`markItemFailed`, `countFailed`, excluded from `pendingItems`), events/jobs indexes + pruning, `reconcileJobs()`, faster `randomItems`, folders.diskPath column.
- `lib/ews.js` — Graph-style throttle escalation + shared cooldown + network retries; archive root folder included; typed `.gone` errors for not-found items.
- `server.js` — startup job reconciliation + daily pruning; `/api/stop` stops engine + PST + sizes; global job mutex (backup/verify/PST/sizes 409 on conflict); auto-resume sweep with per-mailbox exponential backoff (15→120 min), startup resumes only `syncing`, skipped during PST and 30 min after manual stop; **session-token auth** on all `/api/*` (header or `?token=`), token in `data/session-token` (0600), `/session-token.js` loopback-only, refuses non-loopback host unless `allowRemote`.
- `lib/auth.js` — in-flight token-request dedup; `clearToken()`.
- `lib/pst.js` + `ps/Export-MailboxToPst.ps1` — export **resume manifest** (`.export-manifest.json`, skips done items, saved incrementally); temp sweep; disk-space preflight; split suffix `-part002` numeric (was broken past 26).
- Earlier this session: per-folder failure no longer aborts the whole run; concurrency default 6 → 3 (`config.json` + engine defaults).

## Decisions

- No Tailwind/shadcn/TypeScript adoption — pasted tree-view component was ported to the project's JSX + CSS instead of adding three toolchains for one component.
- Session token rotates on every server start; static files stay open, `/api/*` guarded. Legacy `web/index.html` fallback's plain `/api/status` link will 401 — accepted (React app is the real UI).
- `fileId` sha1 migration renames legacy files in place rather than re-downloading.

## Current state

- All files pass `node --check`; web build passes; PS1 passes PSParser.
- Server restarted (console mode, background task): auth verified (401 without token, 200 with), dashboard live on :8080.
- `git ls-files` count: 6 modified + this log + README = ~8 files — below the 50-file threshold, **no commit made**.

## Next steps

- Watch a full backup run on `it@example.com`: Inbox should climb past 200/10,420; if 429s persist, drop `concurrency` to 2.
- Optional follow-ups not yet done: mailbox-level worker pool (backups still serial across mailboxes), orphan-file sweep before PST export, disk-vs-DB reconciliation in verify, encryption at rest, cert auth.
- Consider reinstalling the Windows service once console-mode validation is done (service can't run PST export).
