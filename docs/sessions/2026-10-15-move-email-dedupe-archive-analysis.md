# Dedupe visibility, Move-email feature, archive analysis & cleanup (2026-10-15)

Multi-day session (Oct 9–15) covering dedupe UX, a new Move email page with
undo, cleanup of PST-ingest artifacts for `user1`, and a live-vs-archive
folder/size analysis.

## Goals

- Explain archive scan limits (EWS can't reach auto-expanding aux partitions).
- Show that live dedupe excludes Deleted Items/Junk; explain "skipped (not
  identical)"; speed up live dedupe.
- Remove bogus extra folders in `user1`'s archive view; explain 635 GB vs
  459.68 GB; purge `_duplicates`.
- New **Move email** page (clone of Copy email, move semantics, live→live,
  no-loss guarantee, undo, parallel with copy jobs, local-archive sources act
  as copies).
- Undo accidental moves (jobs 1575, 1704); restore retired local archive
  items (job 1693); delete emptied live subfolders after the move.
- Analysis: signature-image size estimate; `07/11 Projects - current`
  live-vs-archive comparisons, CSVs, size breakdowns by project-number range.
- Copy job: archive-only projects 1000–1999 → `archive-projectclosed`.

## What was done

- `lib/dedupe.js`: `_liveFolders` returns `excludedCount`; live check progress
  + report carry `excluded`; honest wording ("potential duplicate group(s) —
  content verified on apply", "kept — content differed (protected)");
  `_fuzzyLiveGroups` size-gated (±10% buckets); `listMessageKeys` selects
  `size` with fallback (this tenant rejects `size` in `$select` → gate
  inactive here).
- `web-react`: DedupePage 3-column scrollable grid (`.dedupe-page` +
  `body.dedupe-mode`; compare-page classes lock 100vh — do not reuse).
- Cleanup `user1`: deleted 12 exo-ingest (PST) folder trees (archive +
  primary Contacts subtree); local SHA-256 dedupe check+apply (2,390 files →
  `_duplicates`), later purged (2.7 GB); proved 635 GB = uncompressed vs
  459.68 GB server + 485 GB gzipped on disk — no real duplication.
- **Move email** (`lib/moveemail.js` `MoveEmailEngine`, routes
  `/api/move-email[/retry|/undo]`, `POST /api/stop/move-email`, page
  `MoveEmailPage.jsx` at `/?moveemail`, nav button): local→live/local +
  **live→live** (same mailbox = atomic moveMessage; cross-mailbox =
  download→EWS upload→Deleted Items, source removed only after verified
  upload). `move_email_plan` table records every retired item; `↩ Undo` in
  Move tasks panel reverses a whole run. move-email ∥ copy-email by design.
  Local **archive** sources never retired (act as copies). `force:true`
  uploads fuzzy-only matches too.
- Fixes: MoveEmailPage crash (`useEffect` returning `null` cleanup);
  `_startLocal` plan.add referenced `dstFolderId` (live-flow var) →
  ReferenceError on every local retire (job 1693's 465 items: files graveyarded,
  rows deleted, no plan) — fixed; restored via `scripts/restore-retired-archive.js`
  (460 auto + 5 manual, 0 lost).
- Reconstruction undo for plan-less job 1575: `scripts/undo-move-email.js`
  (1824/1824 restored to `user1`, 24 dst copies aside, 0 failed). In-app undo
  of job 1704: 135/135.
- Deleted 445 emptied subfolders under the 23 moved roots in `user1` live
  (roots kept; Graph verified empty first).
- Signature estimate: ~55% of archive emails carry inline images; ≈163 GB of
  the archive is signature/inline images (1.8 MB banner re-attaches per reply).
- Analysis + CSVs: `docs/07-projects-current-compare.md`,
  `docs/archive-only-folders-07-11.csv` (606 folders, all subfolders),
  `docs/archive-only-roots-07-11.csv` (117 root rows). Findings: `11 Projects
  - current` no longer exists in live (161.8 GB archive-only); 26/33 live 07
  projects have archive matches (103.8 GB), 7 live-only projects unprotected;
  archive-only total 64,024 emails / 148.9 GB; 500-interval breakdowns.
- Copy job 1834: 8 archive-only roots coded 1000–1999 (16,523 items, 18.9 GB)
  → `archive-projectclosed` live — running at save time.

## Decisions

- Live dedupe fuzzy pass kept but size-gated; verify-before-move safety net
  untouched (fuzzy false positives only cost downloads).
- Move undo never touches pre-existing destination copies (verified-skip
  restores only the source).
- Live→local move rejected (400) — copy/download path exists via compare.
- Session logs use placeholders (`user1`, `archive-projectclosed`) — public repo.

## Current state

- Server restarted multiple times; all changes live. karsten.v archive backup
  remains PAUSED (master switch) — 7 live-only projects unarchived until
  resumed.
- Copy job 1834 in progress. `data/tmp-copyjob.json` is a scratch launch body
  (in gitignored `data/`).
- Uncommitted: ~47 changed files (< 50 threshold) — no commit this save.

## Next steps

- Optionally unpause `user1` archive backup to capture the 7 live-only
  projects (3802 Fusfaru Stage 2, 4080/4085/4150 Naia, 4275 SAAS C11, 4375
  Rand Villa, 3857 Arrival Study).
- Possibly PST-export + remove top archive-only folders if disk reclaim is
  wanted (~95 GB in top 10).
- Queue copy jobs for 2000s/3000s archive-only blocks to `archive-projectclosed`
  if the 1000s copy proves out.
