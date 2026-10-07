# 2026-10-06 — Compare & transfer page, cross-channel duplicate war, transfer history

One line: built the side-by-side Compare page (local backup vs live mailbox with copy/move both ways), iterated it through a week of UX fixes, hunted down why duplicates kept appearing (every API assigns its own message id), and added prevention + cleanup + a permanent transfer history.

## Goals

- New page: two panes side by side — local backup store left, live mailbox right (read-only, no downloads unless previewing or transferring) — with copy/move of emails between them
- Full-viewport layout, resizable panels, preview on demand (right-click), no always-on preview
- Live folder tree: fetch on demand with progress, keep it saved for instant future loads
- "See more than 500 emails anywhere" + keep scroll position while loading more
- "After copy I can still see many duplicate emails, why?" → prevent + clean up, local-only deletes
- Same fuzzy duplicate handling in all dedupe options in the app
- Folder copy must include subfolders (1190-VIDA case) + visibility into what was copied
- Persistent log of all transfer actions per mailbox

## What was done

### Compare page (`web-react/src/components/ComparePage.jsx`, route `/?compare=<upn>`)
- Backend (`server.js`): `GET /api/live/:upn/folders|items|item|download|attachment` (read-only Graph browse), `POST /api/compare/transfer` (per-item copy/move), `POST /api/compare/transfer-folder` (subtree copy with merge semantics), `POST /api/compare/undo` (reverse last action), `GET /api/compare/progress`. `lib/graph.js` gained `listMessages` (sender included); `parseMimeHeaders` (now with Message-ID) exported from `lib/engine.js`; `itemFile` exported from `lib/preview.js`.
- toLocal writes use the engine's exact conventions (sha1 fileId, gz tmp+atomic rename, same folder ids) so copied mail merges into the normal backup; move mode live→local shifts the server copy to Deleted Items, local→live retires the local file to the graveyard.
- UX passes: full-viewport `compare-mode` layout (the real overflow bug was `#root` page padding around a 100vh page), draggable splitters (both inner + outer), right-click context menu → preview modal / download, mailbox picker with type-to-search + shared/guests toggles, selections persisted in localStorage + Reset button, trees collapsed by default (`ScopeTree defaultExpanded` prop), `.tree` 40vh modal cap fixed for pane use, "Load 500 more" pagination (`/items?limit=`, no scroll jump, selection kept), live pane header compacted to one line with "?" hover popover.
- Live folder tree: on-demand fetch only (`?refresh=1` walks; plain GET serves the saved tree), server-side progress endpoint + animated bar with elapsed time, **persisted to `data/live-folders/<upn>.json`** (survives restarts), "folder tree saved <time>" in the "?" popover.
- Entry points: Compare button on the dashboard header and on MailboxPage.

### Cross-channel duplicates — root cause and war
- **Root cause (verified in DB)**: the same physical email stored 2–3× under different API ids — Graph `AAMk…` (compare copies), Graph-IE `ie-AAMk…` (PST import/IE), EWS ids, `exo-…` (eDiscovery ingest). Per-id skip checks can't match across channels; receivedAt drifts seconds and MIME bytes drift (Exchange normalization), so exact keys and sha256 both miss.
- **Prevention**: `fuzzyDupes()` in server.js (same subject + receivedAt ±2 min + size ±10%) added to all four compare copy paths (transfer + transfer-folder, both directions).
- **Cleanup**: `scripts/cleanup-local-dupes.js <upn> [--apply]` (dry-run default; same-folder groups, keeps folder-namespace-matching or oldest copy, retires extras to the graveyard, LOCAL ONLY). user1 run: **4,401 duplicates retired** across 3,410 groups.
- **Dedupe engine** (`lib/dedupe.js`): `_fuzzyLocalGroups` (same-folder, differing-content clusters; sha256 pass keeps identical content mailbox-wide) and `_fuzzyLiveGroups` (candidates beyond Message-ID groups; live apply still byte-verifies before moving to Deleted Items — false positives only cost a download).

### Folder-copy stale-tree diagnosis + history
- 1190-VIDA subfolders missing after copy: the copy ran with a **stale/partial live tree** (2 folders) 9 s before the fresh 92-folder tree was saved; user then undid it. Not a merge bug. Guard: the Copy folder confirm dialog now shows the exact subtree folder count.
- **Transfer history**: `compare_log` table (ts, kind, direction, upns, folder names, counts, errors) written by all three compare routes; `GET /api/compare/history?upn=`; **History** modal on the compare page.

## Decisions

- Live side stays strictly read-only except explicit transfer actions; folder walks are one-time + persisted rather than TTL-cached (Graph throttling makes re-walks expensive).
- Fuzzy match (subject + ±2 min + ±10% size) chosen over Message-ID-only because cross-channel copies drift in all three ids/timestamps/sizes; false-positive risk accepted for local (recoverable via graveyard/_duplicates) but NOT for live — live apply keeps the byte-identity verification gate.
- Cleanup deletes local copies only, always recoverable (graveyard / `_duplicates` + manifest); the live mailbox is never touched by cleanup.

## Current state

- Server running with all compare routes; `web-react` built; AGENTS.md changelog current.
- user1 local store: 4,401 dupes retired; local dedupe check now reports 96 groups / 230 items (474 MB) remaining (mostly true content dupes).
- Saved live trees in `data/live-folders/` for archive.admin and archive-projectclosed (92 folders, full 13 Projects - closed subtree).
- Branch `feature/archive-upgrade`, ahead of last push `f83af64`; this session's changes pending commit (52 files ≥ 50 threshold — committed with this log).

## Next steps

- Re-run `◂ Copy folder` on `13 Projects - closed` (archive-projectclosed → user1 archive) with the now-complete tree (confirm should say "Subtree: 77 folder(s)") to create 1190-VIDA's subfolders locally; already-backed-up items skip.
- Address the stray double-space `12 Projects  -site` branch (holds ie- subfolder rows with 0 items).
- EWS browse pass for user1 archive still pending (from 2026-10-02 log); EWS `ErrorInvalidIdMalformed` on IE-namespaced folders still open.
