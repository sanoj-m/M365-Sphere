# 2026-10-07 — Folder-placement integrity, image verification, in-app dialogs everywhere

One line: closed out the folder-mess for good — every stale EWS row merged into
its proper Graph-IE home with a nothing-is-deleted guarantee, a full image
verification pass with per-reason stats, a clickable per-folder rebuild report,
and a redesigned in-app dialog system replacing every browser popup, including
root-vs-folder destination choices on all copy actions.

## Goals

- "verify all the emails… some still have broken embedded images… PST is the
  primary way — whatever exists in the PST should replace the local copy"
- "give me stats I can click — how many emails moved to which folders"
- "there are random folders in the archive root that shouldn't be there — where
  are they coming from, make sure nothing is deleted"
- "delete what is in 25 IT and merge with the actual root projects"
- "any action request should not pop up in the browser — within the app as a
  notification… work on it for the entire app"
- "the popup looks poorly designed, do a better design; for any folder ask
  whether to copy to the folder or root"

## What was done

### Mystery folders — root cause + full fix
- Stray root folders (1020-MotF trio, 1395/1397 trio) were **stale EWS-namespace
  rows**: the tree mounts by `parentId`, and their 0-item EWS parents were hidden
  by the IE-namespace filter → children floated to root.
- `server.js` `/api/mailbox/:upn/folders`: filter now **keeps the ancestor chain**
  of every content-holding folder (nesting is always correct).
- `lib/store.js` `mergeArchiveNamespaces`: fuzzy fallback merges mangled EWS
  paths into the unique IE twin of the same (top-level group, name); collision
  handling keeps the **better copy** (eml > fts > larger) and retires the loser
  to `data/store/_graveyard/<upn>/` — never deleted. Ran fleet-wide:
  user1 archive: 2,586 items re-homed, later +620 (25 IT parent), +16/+38
  targeted merges (MotF, 1070-Namaste).
- **25 IT is a REAL mailbox folder** (aux partition, thousands of items) — kept,
  not deleted (user informed); only the stale EWS rows inside it were folded.
- Verified: 0 stray root folders left; archive tree has one clean root.

### PST-wins repair + per-folder tracking
- `scripts/pst-repair.js`: if a message exists in the PST, the PST version now
  replaces the local copy **regardless of current format** (was: skipped all
  `.eml` items) — identical-sha pst-import rebuilds still skipped (idempotency).
- Per-folder stats recorded in every log record (`folderStats[]` in
  `data/pst-import-log.json`).

### Image verification
- `scripts/verify-images.js <upn> [--scope] [--source]`: parses every stored
  email, checks image end-markers (PNG/GIF/JPEG, NUL-padding tolerant) **and**
  inline `cid:` resolution; per-folder counts + per-reason tally + 500-item
  detail cap; writes `data/image-verify-report.json`. First pass OOM-crashed at
  24k items — hardened (8 GB heap, GC yields, capped lists). Early signal: many
  flags are structural (OLE/embedded-message cids by design), not corruption.

### Clickable rebuild report
- `GET /api/mailbox/:upn/pst-repair/report` (per-folder table + imageVerify
  summary) + "Rebuild report" button in the PST recovery panel → modal with
  folder → rebuilt/skipped/unmatched/failed/verify table (scrollable, sticky
  header).

### In-app dialogs everywhere
- New `web-react/src/dialog.jsx`: confirm/choose/toast singleton mounted at
  `main.jsx` root (after a bug where it lived in App and silently no-oped on
  Compare/Mailbox/Dedupe pages). Redesigned twice: intent icon, hierarchy
  buttons, toast notifications.
- All 15 `window.confirm`/`alert()` sites across 9 components replaced.
- **Root-vs-folder choice**: item transfers AND folder copies to local now ask
  `Into "<folder>"` (primary) vs `Into Archive root (root)` when a subfolder is
  selected — copies never silently land nested.

## Decisions

- Merge losers always go to `_graveyard/` (or `_duplicates/` for dedupe) —
  recoverable; the app never hard-deletes email content.
- 25 IT kept because it's real Exchange content; "delete it" would have been
  data loss — the stale EWS duplicates inside it were the actual artifacts.

## Current state

- Public repo `sanoj-m/M365-Sphere` @ this commit; server running all fixes;
  recovery run + image verification complete/continuing.
- user1 archive: clean tree, PST-wins recovery active, report available in UI.

## Next steps

- Review `data/image-verify-report.json` reasonCounts once full pass finishes;
  re-run repair only for genuinely-truncated items.
- Remaining ~90k FTS items: mostly not present in any PST — decide later whether
  to accept (restore-grade) or cover via Purview exports.
