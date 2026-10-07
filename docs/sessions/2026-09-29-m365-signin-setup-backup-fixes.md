# 2026-09-29 — Automated M365 sign-in setup, backup correctness fixes, live progress

**Summary:** Added one-click "Sign in with Microsoft" tenant setup; fixed a chain of backup bugs (the big one: Graph `$top` silently truncated delta syncs at 200 items/folder); added auto-resume, live byte totals, and honest completion status.

## Goals

- Replace manual app registration + consent + Exchange impersonation with an in-dashboard Microsoft sign-in
- Remember the connection — never ask to sign in again
- Searchable/selectable mailbox list with "Backup Selected" only (no Backup All)
- Sortable columns, activity log as right sidebar, wider page
- Backup must actually reach 100% and never claim "fully backed up" early; auto-retry after stops/crashes

## What was done

- **Automated setup** (`lib/setup.js`, new): device-code sign-in (Microsoft Graph PowerShell first-party client `14d82eec-…` — the Azure PowerShell client is blocked for these scopes, AADSTS65002). Creates the "M365 PST Backup" app registration, grants admin consent (roles resolved **by name** from resource SPs after a GUID mismatch error), creates a client secret, writes `config.json` live (no restart), then best-effort Exchange `ApplicationImpersonation` via PowerShell — auto-installs ExchangeOnlineManagement (TLS 1.2 + NuGet fix for PS 5.1) and surfaces the second device code in the dashboard. Routes: `POST /api/setup/login`, `GET /api/setup/status`, `POST /api/setup/archive`.
- **Persistent connection state**: `tenantName` + `archiveGranted` saved to `config.json`; `/api/setup/status` reports "Connected to tenant …" from config after restarts; header shows `● Connected — Contoso`.
- **Graph fixes** (`lib/graph.js`): removed unsupported `userPrincipalName ne null` filter; removed unsupported `parentFolderId eq null` filter; fixed double-`?` URL in folder tree; removed invalid `size` from message `$select`; error messages now show the Graph body first (URL truncation was hiding real errors); **removed `$top=200` from messages/delta — Graph returns a premature deltaLink after exactly one page when `$top` is set (verified live: 200 vs 2,277 items)**.
- **Engine fixes** (`lib/engine.js`): incremental delta syncs no longer delete untouched local rows/files (was wiping mailboxes); previously-failed items are re-queued every sync (`store.pendingItems`); null message-meta guarded; "archive folder not found" = mailbox has no archive → skip cleanly, not a failure; mailbox status now requires per-folder stored counts to match live counts before `done`; byte totals recomputed after every batch (live "Backed up" column).
- **Auto-resume** (`server.js`): on startup and every 15 min (`autoResume` / `autoResumeMinutes` in config.json), mailboxes in `syncing` or genuinely-incomplete `partial` state are re-backed-up automatically. `run-console.bat` now loops with a 5 s restart delay.
- **Dashboard** (`web-react/`): search box + per-row checkboxes + select-all-matching + "Backup Selected" (backend `POST /api/backup {upns}`); sortable column headers; activity log moved to a 380px right sidebar; page width 1280→1720px; backup detail progress shows overall `backed/remote` emails instead of per-batch.
- **Verify**: `countFilesOnDisk` no longer recurses into subfolders (was double-counting child-folder files — "on disk" now matches "backed up": 7,771 = 7,771 confirmed).
- **Discover run**: 2,516 mailboxes pulled from tenant "Contoso"; `it@example.com` used as the end-to-end test mailbox (31,272 source items, sync in progress at save time).

## Decisions

- Delegated device-code token is used only for setup, never stored; backups run app-only via the created client secret (same as manual flow).
- Client secret rotated on each setup run; app registration reused by display name.
- Empty `upns` list returns "no matching mailboxes" rather than falling through to backup-all (caught during testing — the stray run was stopped after 2 mailboxes, checkpoints intact).
- No `$top` on delta queries ever again; default page size (10/page for delta) accepted for correctness over speed.

## Current state

- Server running, connected to tenant "Contoso" (`645f8ebe-…`), archive impersonation granted.
- `it@example.com`: full re-sync running after delta-token purge; 7,771+ items stored; auto-resume keeps it driving to 31,272.
- Working tree: 48 changed files (25 untracked, 23 modified) — **below the 50-file commit threshold, no commit made** (2 more changes until threshold).
- Last commit `2df541d`; remote `origin` = https://github.com/sanoj-m/M365-Backup.git.
- `config.json`, `data/`, `node_modules/`, `pst-export/` confirmed gitignored.

## Next steps

- Let `it@example.com` finish, then Verify — expect 31,272/31,272.
- Select real staff mailboxes (search filters out `#EXT#` guests) and run Backup Selected.
- PST export (stage 4) requires console mode + interactive logon with Outlook installed.
- Optional: cleanup sweep for orphan `.eml.gz` files left by the pre-fix delta-wipe bug.
