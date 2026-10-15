# PST recovery — why FAILED, skip-existing, drive to fully done (2026-10-08)

(Continuation of `2026-10-07-dedupe-refresh.md` — same session series.)

## Diagnosis (from log + code audit)

Per-PST FAILED status came ONLY from `pst-verify.js`: any unreadable message
**or any note** — including benign `subfolders:` notes from
`SPAM Search Folder 2` (a search folder with no subfolder table;
`findBtreeItem Unable to find 8750`) — failed the whole 10 GB PST. 30 of 48
verify records were exactly that.

Rebuild-side counters: `skipped` already WAS skip-if-present (matched item
already `format='eml'+sourceApi='pst-import'`, or identical sha256 —
`pst-repair.js`). `unmatched` was dominated by folder-path mismatches:
Purview keeps `+ & ,` and `/` in condensed names and turns `.`/spaces into
`-`; the old `condense` destroyed `+ &,` and broke on `/` in names. Remainder:
folders renamed/moved/renumbered on the server between backup and export, and
folders the IE backup captured zero items from.

## Changes (scripts/pst-repair.js, scripts/pst-verify.js)

1. `condense` now matches Purview's scheme (whitespace + `:*?"<>|` → `-`,
   keeps `+ & , ( ) /`), plus a **flat fallback** (whole path, `/`→`-`, fixes
   `/`-inside-folder-names) and an alnum-only **squash fallback** (fixes `.`
   vs `-`, e.g. `KAFD 3.0` vs `KAFD-3-0`).
2. Skip-list extended: `Deletions`, `Purges`, `Audits`, `DiscoveryHolds`,
   `Versions`, `SubstrateHolds`, `TeamsMeetings`, `Flagged-Emails` (recoverable-
   items/search folders that can never match DB folders).
3. `mkdir -p` before writing rebuilt files (11 ENOENT failures killed).
4. Unreadable messages (`getNextChild` throws) are now logged once per folder
   (were silent) and counted per folder.
5. Unresolved folders: messages fall back to a **mailbox-wide
   subject+received-minute index** (lazy, ~243k rows) so renamed-folder emails
   rebuild where the copy now lives.
6. Still-unmatched messages are **inserted as new browsable items**
   (user-approved): `pst-`-prefixed itemIds, folder rows for PST-only paths
   use `exo`-prefixed ids (`ensureFolder`) so engine reconciliation skips
   them; scope = well-known primary root names else archive; idempotent via
   `getItem`+sha256; run-local indexes updated so later folders/PSTs match
   inserted items. Same verifyImages check as rebuilds. New `inserted`
   counter in records + summary line.
7. `pst-verify.js`: only genuinely unreadable messages fail a PST; notes are
   informational remarks.

## Results so far

New run started 13:27 UTC (pid in data/pst-repair-job.json). First file:
`unmatched 546→0, inserted 546, failed 0`. A one-shot cron (id
01M4DVF4RFGVX4JRWAMXGCFFQ3, 18:47 local) checks completion, then starts a full
verify and lists rescue candidates.

## Left to do

## Final numbers (2026-10-08 evening)

Rebuild run (started 13:27 UTC, finished 15:18 UTC): 57 PSTs, 205,178
messages — 168,813 skipped (already rebuilt), 6,439 replaced, **29,926
inserted as new**, **unmatched 0**, 49,846 failed (parser-unreadable),
436 verifyFailures (truncated embedded images).

Verify run (15:22–~16:2x UTC): **35 ok / 22 failed**. Every failure is now
genuine unreadable messages (`findBtreeItem Unable to find <nid>`), and the
22 files match the rebuild-failed list exactly: .057 9527, .043 4905,
.047 4432, .041 4022, .042 4014, .021 3426, .015 3393, .013 3177,
.025 3036, .054 2715, .010 2571, .027 2170, .032 2045, .049 1862,
.022 1654, .016 1542, .019 1302, .018 1158, .011 1067, .002 868,
.055 801, .008 732 (~53k messages total; all exist in the store as FTS blobs
from the Graph IE export).

Notable pattern: the failing NIDs repeat across DIFFERENT files and all sit
above 2,097,152 (0x200000) — likely a pst-extractor boundary limitation
rather than real corruption; scanpst may report these PSTs clean. Rescue
(approved, not yet implemented): Outlook-COM re-export of the affected
folders (or scanpst) on those 22 PSTs, then Rebuild again.

## Extra folders in the archive tree (2026-10-08 evening, user report)

The insert-as-new step created `exo`-prefixed folder rows for PST-only paths —
visible as PST-condensed names (`04a-Proposal---in-progress`, …) alongside the
real tree. Two categories:
- `ApplicationDataRoot/*` — Purview export ANALYTICS data (Copilot
  activities/logs), not email. 502 items + folder rows deleted via
  `scripts/cleanup-pst-folders.js <upn> [--apply]` (dry-run default; also
  merges exo folders that squash-match real ones and prunes empty ancestors).
  `ApplicationDataRoot` added to the pst-repair skip list.
- Project folders (04a/05a/05b/07-…, ~150 rescued emails) — initially kept as
  the only home for renamed-folder emails, but per USER DIRECTIVE
  (2026-10-08): **never add folders that don't exist on the archive server**.
  All 22 exo folders + 4,254 inserted items removed (files moved to
  `_graveyard`, recoverable). `insertNew` in pst-repair.js now inserts ONLY
  into server-resolved folders (`dbFolder`); PST folders with no server
  counterpart count `unmatched` and are never created. Skip list extended:
  `ComplianceMetadata`, `SubstrateContacts`, `OneNotePagePreviews`,
  `Recipient-Cache`, `Contacts` (Purview export artifacts, not mail).

## Duplicate archive folders (EWS vs Graph IE rows)

User still saw a duplicated archive tree: 3,487 paths existed twice — EWS scan
rows vs `ie-` rows of the same folders; the `/folders` filter keeps EWS rows
with content PLUS their ancestor chains, so whole duplicate branches showed.
Fix: ran `store.mergeArchiveNamespaces(upn)` (the engine's built-in EWS→IE
fold, normally invoked after an EWS browse-copy pass at `lib/engine.js:298`):
1,652 items moved into IE folders (id collisions ranked, losers retired to
`_graveyard`), 3,528 EWS folder rows dropped, 255 EWS folders without an IE
counterpart kept, 7 fuzzy path merges. Archive folders 7,304 → 3,776; the
`/folders` API now serves 0 duplicate paths.

**Permanent fix (so it can't recur):** the fold ran only after EWS browse-copy
backups (`provider === 'ews'`), but EWS folder rows are also upserted by the
count scan (`POST /api/scan` EWS archive walk) and by EWS hierarchy syncs.
Now `mergeArchiveNamespaces` runs after EVERY backup that saw an archive
(`lib/engine.js`, no-op when no EWS rows) and immediately after the scan
route's EWS archive walk (`server.js`). Server restarted with the fix.

## Left to do (updated)

- Outlook-COM/scanpst rescue for the 22 failed PSTs (approved by user).
- Note: `server.js` merges per-PST log records with `replaced` SUMMED across
  runs but other counters latest-only — the panel's "Rebuilt" column can
  exceed a PST's true message count after re-runs (cosmetic, known).
- 14,700 FTS items have no subject/receivedAt — invisible to key matching;
  their PST counterparts insert as new items (possible fuzzy dupes, cleanable
  via the Dedupe page).

## Watchdog (2026-10-09): keeping the server running

User saw repeated 'interrupted' dedupe jobs — root cause: the server process
was externally stopped and restarted several times (startup reconciliation
`store.js:262` stamps in-flight jobs 'interrupted' at each boot; multiple jobs
shared the identical finishedAt = boot time). No crash evidence (empty
server-crash.log / server-err.log, no Windows Application Error events) —
clean external kills, most likely manual/agent restarts. There was also an
OLD dead watchdog from 2026-10-02 (its log lived on in data/watchdog.log).

Fix: `scripts/watchdog.ps1` (every 30 s: start `node server.js` if no such
process; honors `data/watchdog.pause`) registered as Scheduled Task
`M365Sphere-Watchdog` (AtLogon, interactive user session — keeps Outlook COM
working; a Session-0 service would break PST export). Verified running.
AGENTS.md "Running / restarting" section updated (also fixed the stale
m365-sphere WorkingDirectory in the restart command).

## Dedupe: check now verifies content like apply (2026-10-09)

User complaint: live check reported "388 groups / 647 candidates" but apply
moved 0 — "603 kept, content differed (protected from a wrong move)". The
check grouped by Message-ID/subject+receivedAt only; apply verified
fingerprints later. Now `checkLive` (`lib/dedupe.js`) content-verifies every
candidate group with the SAME fingerprint logic as apply (per-group memoized
hashes, first-readable-member keep fallback) and SEEDS `dedupe_live_plan`
(pending = verified duplicate, kept = differed/unreadable; the plan is
cleared+reseeded by each check, never by apply). `applyLive` no longer clears
the plan on fresh runs — it moves check-verified 'pending' items without
re-downloading; resume semantics unchanged. Report/API gains `candidates` +
`kept`; UI wording updated ("verified identical — ready to move aside" /
"No movable duplicates — all N candidates differed…"). Trade-off: live checks
are slower (one MIME download per candidate, ~2x per group) but the reported
numbers are exact. Note: check-seeded dstPath uses the check's date —
apply on a later day moves into the check-dated Dedupe folder (harmless).

## Live-copy wrong dates (2026-10-09, permanent fix)

Copied/moved messages into live mailboxes showed the UPLOAD time in Outlook
(e.g. a whole batch at "Sun 3:34 PM") while local copies kept the real date:
Graph MIME import stamps receivedDateTime = import time, and the field is
read-only in the Graph schema. A previous repair (fix-copy-dates.js) only
patched messages inside copy-email job windows matched by subject — it missed
compare-transfer copies and anything off-window.

Permanent fix: `graph.postMessageMime` (lib/graph.js) now parses the MIME
`Date:` header (`mimeDateHeader`) right after every upload and PATCHes the
MAPI date properties via `graph.setMessageDates` (singleValueExtendedProperties:
`SystemTime 0x0E06` PidTagMessageDeliveryTime / `SystemTime 0x0039`
PidTagClientSubmitTime). ALL upload paths go through postMessageMime
(compare transfer, transfer-folder, lib/copy.js), so this can never recur.

Historical repair: `scripts/fix-live-dates.js <upn> [--since YYYY-MM-DD]
[--apply]` — job-independent: scans every message created since --since
(default 2026-09-01), downloads MIME, compares Date header vs
receivedDateTime, patches drifts >5 min. Dry-run default.

## Live-copy wrong dates — the full saga (2026-10-12)

Symptom: batches of copied messages in archive.admin show the UPLOAD time in
Outlook ("Sun 3:34 PM") while the local store has the real dates. Root causes
found (in layers):
1. Graph MIME import stamps receivedDateTime = import time (read-only field;
   writable only via MAPI extended props 0x0E06/0x0039).
2. Copies uploaded from FTS items have NO Date header at all (FTS streams
   without transport headers; ftsDate also null) → Exchange can only stamp
   upload time.
3. Mailbox-migration Message-ID re-stamps: the same email exists locally with
   DIFFERENT Message-IDs across copies (DB6PR04MB3000 vs DB8PR04MB5594 vs
   live AMBPR04MB5661) — Message-ID matching alone can't repair those.
4. Exchange sometimes rewrote the MIME Date header itself at import (Mode B:
   header=upload, received=real) — patching from the header blindly would
   CORRUPT correct dates.
5. createdDateTime is NOT the upload time after a later move (sample: moved
   next day, created changed, received preserved).
6. Same email legitimately has different delivery times in different
   mailboxes (routing variance, minutes) — only drifts >24h are safe to call
   upload-stamps.

Fixes shipped:
- lib/graph.js: postMessageMime self-corrects after every upload
  (mimeDateHeader + setMessageDates via SystemTime 0x0E06/0x0039) — ALL
  copy/move paths covered going forward.
- scripts/fix-live-dates.js <upn> [--since] [--apply] (v6): per live folder,
  truth = (1) Message-ID map from same-named local folders' EML headers,
  (2) content fingerprint (subject + stripped body + attachment bytes;
  FTS items via ftsMime reconstruction; single-date matches only), (3) Date
  header only when received is stamped AND header isn't. Patches only drifts
  >24h. Per-message 90s/60s hard timeouts (a stalled stream hung v4 at CPU 0).
  Dry-run default.

## Live-copy wrong dates — resolution (2026-10-12 final)

Full scan of archive.admin (488 folders, 20,133 messages, v10): **17,623
already correct, 34 routing variance, 2,452 Mode B (header rewritten,
received correct), 17 unfixable, 7 flagged, 0 failed.** The bulk had already
been corrected by a re-copy the user ran after the postMessageMime
self-correction went live (bad Sunday copies were also moved out by the
dedupe run). Of the 7 flagged, 6 were old cross-mailbox delivery variance
(NOT stamps — copy-era guard added: never touch large drifts between two
pre-2026-06 dates). The one genuine stamp ("RE: Audit report extracted",
25 IT/audit, 2026-10-11 → 2023-05-31) was PATCHED and verified via
setMessageDates + getMessageMeta.

Fingerprint lesson (v10): live-vs-local content matching must strip html
TAGS and decode ENTITIES (Exchange re-serializes charset/quotes/entities on
import; attachments stay byte-identical). Truth-map hygiene: exclude the
target mailbox's own backup rows (stamp-poisoned), cap files >30 MB, EML
first / FTS-reconstruction only on miss, plausible-date window (2008..now+2d,
kills 2002-01-01 placeholder Date headers), 90s/60s per-message timeouts,
6-way message concurrency (25 IT: 2,826 msgs in ~2.5 min vs 95 min stalled).

## archive.bids cleanup (2026-10-14)

- Deleted 207 stray root folders (mistaken copy jobs 1740/1805/1807 targeted
  "mailbox root"; sources = karsten.v archive bid parents). 1 refusal:
  'Snoozed' (distinguished folder, expected). Plan: data/bids-root-delete-plan.json.
- Merged "60 Bids - declined" + "61 Bids - declined" INTO "61 Bids - declined
  (historic)" (scripts/merge-live-folders.js, reusable, dry-run default):
  5,031 unique messages moved, 5,397 verified duplicates discarded, both
  source roots deleted when empty. BUG found+fixed: never page a folder while
  moving its messages (continuation skips items) — list-then-move.
- Recent-mail scan (cutoff 2026-04-14): only 2 subfolders had <6mo mail —
  historic/026-03 Hero HQ in Dehli (11) and historic/00 misc (48).
- Per user: moved Hero HQ folder wholesale → "60 Bids - declined (last 6
  months)/026-03 Hero HQ in Dehli" (15 msgs, source deleted empty); the 48
  recent 00 misc emails turned out to already exist in "60 Bids - declined
  (last 6 months)/00 misc" (verified by Message-ID) — the historic copies were
  moved to Deleted Items to complete the "move".
