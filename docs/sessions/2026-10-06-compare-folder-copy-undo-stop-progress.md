# 2026-10-06 — Compare page: folder copy with merge, undo, stop, live progress

## Goals

- Don't claim "Backed up" when the local email count exceeds the (approximate) server total (archive scope panel badge was misleading for auto-expanding archives).
- Compare page (`/?compare`): licensed-users-only mailbox pickers by default with opt-in shared/guest toggles; type-to-search pickers instead of raw selects.
- Folder-level copy with merge semantics: copy a folder incl. subfolders; same-named destination folders are reused (never duplicated); existing emails skipped after a thorough check.
- Undo button for the last compare action.
- Source-side dedupe: duplicated emails in the source are transferred only once.
- Stop button for running transfers; live progress card with copied/skipped/failed stats and source → destination (incl. primary/archive/live tags).
- Fix: archive folder copy creating a like-named subfolder instead of merging.
- UX moves: action buttons into each side panel's header; Undo next to Reset; progress card as a top banner; folder totals updating live; progress surviving page refresh; folder tree not blanking during polling.

## What was done

- `web-react/src/components/browse.jsx` — scope-panel "Backed up" donebox now requires `backed <= remoteShown && !approx`; over-count falls through to the progress box labelled "Count exceeds server total"; bar capped at 100%.
- `ComparePage.jsx` — `MailboxPicker` (type-to-search, Enter picks first match, Esc/outside-click closes); `showShared`/`showGuests` header toggles (mailboxes filtered by `type`, suffix `(shared)`/`(guest)`); folder-copy buttons `◂ Copy folder`/`Copy folder ▸`; Undo; progress card; buttons relocated to side-panel headers, Undo next to Reset.
- `server.js` — `POST /api/compare/transfer-folder` (subtree copy, merge-by-name via `ensureChildFolderEx` for live / merge-by-path for local, dedupe keys Message-ID + subject|receivedAt + sha256 for toLocal); one-slot in-memory `compareUndo` + `GET/POST /api/compare/undo`; `compareGuard` (one transfer at a time, 409) + `compareStop` cooperative cancellation + `POST /api/stop/compare` + `compareRunning` in `/api/status`; `compareProg` live progress + `GET /api/compare/progress`; null destination = mailbox root; archive-only merge fixes (`Archive root` anchor for root copies; same-named archive destination merges INTO it).
- `lib/store.js` — `listItemsAll()`; **bug fix: `upsertItem` defaulted `format: null` → `NOT NULL constraint failed: items.format`** on every compare insert and some backup folders (event-log warns) → now `'eml'`.
- `lib/graph.js` — `ensureChildFolder`/`ensureChildFolderEx` ({id,created}), `moveMessage` (moveToDeletedItems delegates), `deleteFolder` (404-tolerant).
- `lib/engine.js` — `parseMimeHeaders` also returns `messageId`.
- Live round-trip tests (archive.admin → user1 local, small folders): copy/skip/idempotence/undo/stop all verified; test data cleaned up after each run; one interrupted user copy ("25 IT", 53 items) manually reverted (files to graveyard, rows deleted, bytes recomputed) since the undo slot is lost on restart.
- AGENTS.md kept in sync (compare bullet, granular stops list, recent changes).

## Decisions

- Folder copy is copy-only (no folder move) — reversal via Undo instead.
- Undo record is one in-memory slot, written when a transfer completes; a transfer killed by a server restart is not undoable (known limitation).
- Dedupe ordering: cheap key/id checks before MIME download, sha256 check after download but before write.
- Refresh-surviving progress uses a `sawRunning` ref to avoid a first-poll race closing the card.
- The 1.5 s progress poll refreshes the folder tree but NOT the open item list (`loadLeftItems` clears checkbox selections); `loadLeftFolders` no longer nulls the tree while refreshing.

## Current state

- Server running with all of the above; UI rebuilt. Commit includes concurrent-session compare enhancements too (`compare_log` history table + History modal, fuzzy-dupe skipping in all copy paths and the dedupe engine, `scripts/cleanup-local-dupes.js`).

## Next steps

- Optional: persistent/incremental undo records so interrupted transfers are undoable.
- Try a live (toLive) copy + undo round trip on a test email — never exercised against a real mailbox.
