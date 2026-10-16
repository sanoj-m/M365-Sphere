# 2026-10-14 — Live-copy date repair, archive-bids restructure, folder analytics

One line: fixed upload-stamped dates on live copies (permanently), cleaned up a
mistaken root copy in `archive-bids@example.com`, merged its duplicate bid
folders, and produced size analytics for `user1`'s archive projects.

## Goals (this session series, Oct 9–14)

- "emails copied without proper timestamp … fix all these inconsistencies and
  make sure this will never ever happen when i copy or move"
- "so many folders in root [of archive-bids] — where was it copied from?" →
  "remove them, keep only the master root folders"
- "60 Bids - declined and 61 Bids - declined … combined without duplication …
  place all of those emails in 61 Bids - declined (historic) … delete [the
  sources] by making sure they are empty"
- "Duplicates to be deleted. and run it"
- Move the <6-month mail out of historic (folder move + recent 00 misc emails)
- Size breakdowns of `13 Projects - closed` / `12 Projects - site` (local
  archive) by project-number ranges, plus duplicate cross-checks

## What was done

### Live-copy wrong dates (permanent fix + repair)
- Root cause chain: Graph MIME import stamps `receivedDateTime` = import time;
  FTS-sourced copies carry no Date header; Exchange sometimes rewrites the
  Date header itself; migration-era copies carry different Message-IDs;
  `createdDateTime` shifts on later moves; cross-mailbox delivery variance
  looks like small stamps.
- `lib/graph.js`: `postMessageMime` now self-corrects after EVERY upload —
  parses the MIME Date header (`mimeDateHeader`) and PATCHes MAPI date props
  via new `setMessageDates` (`SystemTime 0x0E06` / `0x0039`). All copy paths
  flow through it → cannot recur.
- `scripts/fix-live-dates.js` (10 iterations, dry-run default): per live
  folder, truth = (1) Message-ID map from same-named local folders' EML
  headers, (2) content fingerprint (subject + tag/entity-stripped visible
  text + attachment bytes; EML first, FTS via ftsMime reconstruction;
  single-date matches only), (3) Date header only when received is stamped
  AND header isn't. Guards: own-mailbox rows excluded, >30 MB files skipped,
  plausible-date window (2008..now+2d), 24 h minimum drift, copy-era gate
  (never touch old-vs-old drifts), per-message 90 s/60 s timeouts, 6-way
  concurrency. Full scan of `archive-admin@example.com` (488 folders, 20,133
  msgs): 1 genuine stamp patched + verified; the rest already correct (a
  re-copy after the upload fix + dedupe had cleaned most).

### archive-bids restructure (live, `archive-bids@example.com`)
- Root flood traced: copy jobs 1740/1805/1807 (Oct 13–14) from `user1`'s
  archive bid parents ("61 Bids - declined (historic)" etc.) aimed at
  "mailbox root" → 207 stray root folders deleted (Graph delete → Recoverable
  Items; plan in `data/bids-root-delete-plan.json`).
- Merged "60 Bids - declined" + "61 Bids - declined" into "61 Bids - declined
  (historic)" with `scripts/merge-live-folders.js` (new, reusable, dry-run
  default; merges same-named subfolders, creates as needed, dedupe-skips
  existing, deletes sources only when empty / dupes-only after re-verify).
  Two passes: 5,031 unique messages moved, 5,397 verified duplicates
  discarded, both source roots deleted. Bug fixed mid-run: never page a
  folder while moving its messages (continuation skips items) — list-then-move.
- <6-month mail scan (cutoff 2026-04-14): 2 subfolders. Moved
  `026-03 Hero HQ in Dehli` wholesale to "60 Bids - declined (last 6 months)"
  (15 msgs, source deleted empty); the 48 recent `00 misc` emails already
  existed at the destination (Message-ID verified) → historic copies moved to
  Deleted Items.

### Folder analytics (local store, `user1` archive)
- `13 Projects - closed`: 137.8 GB / 70,758 emails / 125 folders — tables by
  1000-block and 500-block ranges (1000–1499: 60.06 GB dominates).
- `12 Projects - site`: 19.6 GB / 4,869 emails / 4 folders — 3 of 4 projects
  duplicate folders in `11 Projects - current` and/or `13 Projects - closed`
  (~19.4 GB redundant); only `1994 LCP - Preatoni` unique.

### Earlier in the series (Oct 9–12, logged in 2026-10-08-pst-recovery-fixes.md)
- Watchdog installed (`scripts/watchdog.ps1` + Scheduled Task
  `M365Sphere-Watchdog`) after repeated 'interrupted' jobs (external restarts).
- Live dedupe check now content-verifies like apply (no more "647 candidates,
  0 moved"): check seeds `dedupe_live_plan`, apply reuses it; ↻ Refresh button.
- `mergeArchiveNamespaces` runs after every archive backup + scan (no more
  EWS/IE duplicate trees).

## Decisions

- Extended-property PATCH for dates (only writable path; Graph schema is read-only).
- Repair patches only >24 h drifts in the copy era — anything else is left as-is.
- Folder deletes via Graph go to Recoverable Items (restorable safety net).
- Dedupe verification by internetMessageId or subject+receivedDateTime before
  any duplicate is discarded.
- Session logs use placeholders (public repo `sanoj-m/M365-Sphere`).

## Current state

- archive-bids root = 7 masters + system folders; historic holds the merged
  60/61 content; archive-admin dates verified clean (1 patch).
- Server running under watchdog; dedupe check/apply consistent.
- Git: 47 changed files (21 untracked + 26 modified) — under the 50 threshold,
  NO commit/push made. NOTE: several untracked docs/scripts contain tenant
  identifiers (older session logs, CSVs, analysis outputs) — sanitize before
  any public push.

## Next steps

- Optional: Outlook-COM rescue for 22 PSTs with parser-unreadable messages
  (approved earlier, not implemented).
- Optional: wizard warning when a multi-folder copy targets "mailbox root".
- Sanitize + commit/push once the 50-file threshold is reached or on request.
