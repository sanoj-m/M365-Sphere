# Session log — Full audit → fixes → EXO sizes → UX polish

**Date:** 2026-09-30
**Summary:** Full 3-track software audit with all fixes applied, EXO authoritative sizes enabled end-to-end (including the Azure grant walk-through), and a series of dashboard UX improvements.

## Goals

1. Full software audit (backend / frontend / security-ops) and comprehensive fixes.
2. Add M365Sphere logo/branding, favicon (earlier same day).
3. Fix wrong archive sizes for auto-expanding archives (user1: 38.7 GB shown vs 459.66 GB real).
4. Allow sizes fetch while a backup runs; make "Stop mean stop" (no auto-resume after manual stop).
5. Merge the two Fetch Sizes buttons into one accurate combined run.
6. Various UX tweaks: status-grouped sorting, full-page mailbox view with Primary/Archive panels, collapsible stacked scope panels, folder sizes in tree, always-visible ⋯ button, wider tree pane, completed-state visual, local (Asia/Dubai) timestamps.

## What was done

### Audit + comprehensive fix (both agents, ~30 files)
- **Critical:** `lib/engine.js` transaction never invoked (`store.tx(commit)` → added `()`) — delta sync actually persists now; print-path XSS closed (sandboxed iframe); session token no longer logged; `pst-export/`+`daemon/` gitignored; streaming zip export (`archiver@8`, 2 GB cap); HTTP timeouts everywhere; async I/O in hot path; permanent-failure `skipped` status; shared `lib/util.js` (safeName/upn validation/xmlEscape).
- Frontend: shared EventSource (LiveProvider), memoized rows, a11y pass, error boundary, per-mailbox fetch race guards, PST progress surfaces.

### EXO sizes (`lib/exo.js`, `server.js`, store)
- New EXO PowerShell path: `Connect-ExchangeOnline -AccessToken` (app-only) + `Get-EXOMailboxStatistics` (+`-Archive`) + `AutoExpandingArchiveEnabled`; byte parser for `"459.66 GB (493,… bytes)"`.
- Store: `sizeSource`, `ewsPrimaryBytes/ewsArchiveBytes`, `autoExpandingArchive` columns + backfill.
- **Key discovery:** ExchangeOnlineManagement ≥ 3.7 **removed `-Device`** — device-code fallback is dead; app-only requires `Exchange.ManageAsApp` API permission + Exchange admin role on the service principal. Guided user through both grants in Azure; verified via JWT `roles` inspection; succeeded (user1: 459.7 GB, auto-expanding).
- **Combined run (final):** single "Fetch Sizes" = EXO totals for all + EWS accessible-archive measurement only for archive mailboxes; falls back to full EWS walk if EXO fails. Removed the separate EXO buttons. `source` API param still accepts `ews`/`exo`/`both`.

### UX (`web-react`)
- `/?mailbox=<upn>` full page (query-param routing in `main.jsx`), two stacked collapsible fixed-height scope panels (shared `ScopePanel` in `browse.jsx`); same layout in backup view cards.
- Tree: folder byte rollups (`totalBytes` incl. subfolders), always-visible ⋯ button, 420px folders pane, dead-gap fix (margin→padding indent, flex on name column, no horizontal scroll).
- Completed state: `donebox` static check strip replaces the active green bar at 100% & not running; coverage % clamped at 100.
- Backup status sorting: logical rank grouping with `pending` pinned (default: active on top, pending bottom); stable upn tiebreak.
- Timestamps: all UI timestamps via `fmtTime/fmtDateTime` (Asia/Dubai); fixed two raw `slice(5,19)` spots.
- Server: sizes runnable during backup (per-call EWS abort signals); manual full stop suppresses auto-resume until a manual backup start (`autoResumeSuppressed`, header pill); scoped stops don't suppress.

### Commands / ops
- Multiple server restarts (documented PowerShell one-liner from AGENTS.md); `npm install` (archiver); `npm run build` (web-react) many times.
- README + AGENTS.md updated (combined sizes, EXO grant requirements, stop semantics).

## Decisions

- EXO auth: app-only only (Microsoft killed `-Device`); documented the two required Azure grants in README instead of building a dead interactive path.
- EWS kept as the accessible-portion measurement *after* EXO totals (not instead of) — only way to compute the coverage-warning chip.
- Manual full stop = suppression of the auto-resume sweep (user intent: "stop means stop"); scoped stops don't suppress.
- Graveyard (not delete) for remotely-purged items by default (`pruneDeleted: false`) — backup must not propagate deletions.
- Size sorting pinned `pending` to an end instead of plain asc/desc (user request).

## Current state

- Commit: `484f1f7` (last commit by parallel session; this session's work uncommitted — 32 changed files, below the 50-file threshold).
- Server running (detached `node server.js`), backup of user1 in progress; EXO sizes working for user1 (459.7 GB archive, auto-expanding flagged).
- ~2,511 of 2,516 mailboxes still pending (tenant backup ongoing).

## Next steps

- Run the combined Fetch Sizes for all mailboxes to refresh authoritative sizes.
- Remaining: aux-archive (~420 GB on user1) not back-up-able via any API — needs eDiscovery export if ever required; warning chip communicates this.
- Consider committing accumulated work (approaching threshold).


---

# Session log — Copy/move, dedupe, EWS parse fix, PST export overhaul

**Date:** 2026-09-30 (afternoon, second session)
**Summary:** Two new major features (copy/move to a live mailbox, dedupe), a root-cause fix for archive backups never downloading (EWS XML tag mismatch), live folder enumeration, settings page + dark/light theme, and deep PST export fixes + troubleshooting of a machine-level Outlook COM hang.

## Goals

1. Activity log as collapsible right-side popover (viewport-aware, header-clearing).
2. Header + log redesign via ui-ux-pro-max skill (dark OLED console style).
3. Move "Clear local cache" into a Settings page as "Delete all saved data"; add dark/light theme switcher.
4. New feature: copy/move downloaded mail into another *live* M365 mailbox with an integrity check.
5. New feature: dedupe (check + apply) for local backup and live mailbox, recoverable.
6. Fix: archive backup running forever with zero progress.
7. Fix: PST export stuck at "Starting…", stop not stopping, no progress shown, plan exports scanning all folders.

## What was done

### Copy/move (`lib/copy.js`, `CopyWizard.jsx`)
- Graph MIME import into target mailbox; folder tree recreated under a prefix (default `Restored from <upn>`); copy vs move mode (move retires source files to the graveyard only after verified upload).
- Integrity: per-item existence re-check, every-20th-item full re-download hash sample (drift = note, not failure — Exchange normalizes MIME), per-folder count check for freshly created folders; per-item records in new `copy_items` table; report via `GET /api/copy/:jobId`.
- New Graph methods (`lib/graph.js`): `postMessageMime`, `ensureFolderPath`, `getMessageMeta`, `folderItemCount`, `moveToDeletedItems`, `listMessageKeys`.

### Dedupe (`lib/dedupe.js`, `DedupeModal.jsx`)
- Local: SHA-256 groups (`items.sha256` computed at backup time — free + zero false positives); duplicates moved to `_duplicates/<scope>/<folder path>/` + restore manifest; rows marked `status='deduped'`; restore endpoint re-runs in reverse. Verified live: it@example.com = 340 groups / 908 items / ~12.7 MB reclaimable.
- Live: Message-ID groups (subject+date fallback) → extras moved to Deleted Items (recoverable server-side).
- Engine/store consistency: `deduped` excluded from pending/error counts, counted toward folder completeness, never re-downloaded.

### EWS root-cause fix (the "archive backup runs forever, 0 items" bug)
- `lib/ews.js`: SyncFolderHierarchy/SyncFolderItems parsed `Created/CreatedItems/Deleted` — real EWS tags are `Create/Update/Delete`. Archive items had *never* downloaded; cursors were saved anyway, creating permanent drift.
- `lib/engine.js` syncFolder self-heal: empty delta + missing item count → drop cursor, full re-list. Hierarchy cursors (`archiveHierarchyState`) reset once via SQL.
- Live enumeration: folders now persist as discovered (`onFolder` hooks in EWS hierarchy sync, fallback walk, and Graph folderTree) — the UI tree lists them during enumeration.

### Concurrency
- `GraphClient` accepts per-call abort signals (`opts.signal` threaded through req/pages/getJson); copy/dedupe use their own AbortControllers instead of hijacking `graph.signal`. Copy + live-dedupe + PST export can run alongside backups; local dedupe refused only for the mailbox currently syncing.

### Settings page + theme
- `SettingsPanel.jsx` (gear in header): Appearance (dark/light), M365 connection (setup), Stored data, Danger zone → "Delete all saved data" (two-step, type-to-confirm; renamed from "Clear local cache").
- Light theme as `[data-theme='light']` token overrides; applied pre-render in `index.html` to avoid flash. Fixed `.modal-card` having no background (transparent-modal gray-mush bug) and added an "opaque overlay surfaces" rule + checklist item to the ui-ux-pro-max SKILL.md.

### PST export fixes
- `runExport` no longer blocks the HTTP request (was the "Starting… forever" bug); returns job id, runs detached.
- Startup reconcile also resets `pstStatus='running'` (server restart no longer strands the UI).
- Full stop: script writes `owner.pid` (PS + owned Outlook PIDs) to the job dir; `pst.stop()` taskkills the whole tree (previously the orphaned Outlook kept exporting).
- Stop endpoints (`/api/stop/pst|backup|sizes`) are idempotent (no 409 noise on stale clicks).
- Script progress lines (`outlook:`, `scan:`, `pst: creating`, `progress: N/M/K` every 50 items); PowerShell output exposed live via `pstDetail.out`.
- Plan exports scan only planned folders' directories (not the whole store); plan paths sanitized with safeName to match on-disk dirs.
- `cfg.pstVisible` option to show the PowerShell/Outlook windows for debugging.
- Mailbox page Export PST menu: "Choose folders & parts…" (plan builder) + primary-only / archive-only / both (scope export implemented server-side as a one-part plan of top-level scope folders).

### Outlook COM hang (environment, unresolved in-app)
- Probes proved `AddStoreEx`/`AddStore` hang: initially the default MAPI profile had no Exchange account (user runs New Outlook, which has no COM). User set up classic Outlook (profile now logs on as Sanoj Maliyekkal, 74 stores) — but AddStoreEx *still* hangs; `ObjectModelGuard=2` (HKCU) ruled out security prompts. Last step: a *visible* probe window was launched so the user can see any hidden dialog.

## Decisions

- Dup criteria: content hash first (already stored, zero false positives), Message-ID only for live dedupe.
- Nothing is ever hard-deleted: move → graveyard, dedupe → `_duplicates` + manifest, live → Deleted Items.
- PST export allowed during backups (engine publishes atomically, tmp+rename); backup start during PST export also allowed (asymmetric guard removed).
- Kept Outlook COM exporter (user chose classic Outlook setup over building a standalone PST writer).

## Current state

- Server restarted multiple times; latest code loaded (incl. non-blocking PST, tree-kill stop, EWS fixes). user1 archive backup auto-resumes and is genuinely downloading now (EWS parse fix verified by rising item counts).
- 36 changed files (11 untracked + 25 modified) — below the 50-file commit threshold; **not committed**.
- PST export still blocked by the machine-level `AddStoreEx` hang; visible probe pending user feedback.

## Next steps

- User to report what the visible probe window shows (dialog? plain hang? success?) → then either fix the hang (visible mode / profile tweak) or build the standalone PST writer.
- Re-run dedupe apply on it@example.com (908 dup items identified) when the user is ready.
- Commit soon: 36 files, approaching threshold.
