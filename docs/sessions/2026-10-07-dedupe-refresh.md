# Dedupe page — Refresh button (2026-10-07)

## Request

On `/?dedupe`, add a refresh button to re-check a mailbox for newly arrived
mail, and make sure the check runs through all emails in all folders.

## Verified before changing (full-coverage audit)

- **Live check** (`lib/dedupe.js` `checkLive` / `applyLive` → `_liveFolders`):
  walks the entire Graph folder tree and pages every message
  (`graph.listMessageKeys`, `$top=200`, full pagination). Only exclusions:
  Deleted Items + Junk Email subtrees (by design — dedupe moves duplicates
  into Deleted Items, so re-runs would rescan its own output; junk is exempt
  by policy). Covers primary mailbox only (Graph has no archive access).
- **Local check** (`checkLocal`): SQL over ALL `items` rows with
  `status='done'` for the mailbox (both scopes, every folder) — sha256 groups
  mailbox-wide plus fuzzy same-folder clusters. No folder exclusions.

## Changes made

1. `lib/dedupe.js`
   - `checkLocal` now returns `folders` (folders-table count) and `messages`
     (done-items count) in the report.
   - `checkLive` now returns `folders` (scanned folder count) and `messages`
     (total messages scanned) in the report.
   - No route change needed: `POST /api/dedupe/check` returns the report
     object as-is (`server.js:1608`).
2. `web-react/src/components/DedupePage.jsx`
   - New **↻ Refresh** button in the Step 1 section, visible once a report
     exists (previously the only way back was history "Verify again"). It
     reuses the existing `check()` — clears the saved report and re-runs a
     full scan of every folder.
   - Live scan progress card moved out of the no-report branch so it shows
     during a refresh too.
   - Coverage line under the report: "Last scan covered all N folder(s), M
     message(s)" (+ note that live excludes Deleted Items & Junk Email).
   - Hint text on the first check now states the scan covers every folder.
3. `AGENTS.md` — dedupe section updated.
4. Server restarted (backend change); UI rebuilt (`web-react/dist`).

## Follow-up: "Move duplicates aside" must cover ALL reported duplicates

Audit of both apply paths:

- **Local apply** — full coverage already: iterates all sha256 groups mailbox-wide
  + fuzzy same-folder clusters and moves every reported dup; a file missing on
  disk is logged, keeps `status='done'`, and is re-reported next check
  (retryable, never silently dropped).
- **Live apply** — one real gap found and fixed in `lib/dedupe.js` `applyLive`:
  if a group's canonical (keep) copy was unreadable, the code `break`ed and
  skipped the WHOLE group. Now fingerprints are memoized per group and the
  first readable member takes over as keep, so every reported group is fully
  processed. Candidates whose content differs from the keep are still kept by
  design (the report lists unverified candidates; apply verifies content
  before moving — that verification is the safety guarantee, not a skip).
  Every reported item ends the run accounted as moved / failed / skipped.
- **UI** (`DedupePage.jsx`): when a mailbox's dedupe job finishes, the stale
  saved report is auto-cleared so Step 1 offers a fresh check showing exactly
  what remains.

Server restarted; UI rebuilt; `node --check` passed.

## Mailbox page wrong totals (karsten.v) — "243,663 of 12,059 items, 999%"

Root cause: the archive denominators came only from per-folder `itemCount`,
which covers just the EWS/IE-visible MAIN partition (~12k items). The 234k
PST-recovery/IE-ingested items live under `ie-` folders whose itemCount never
grew, so every "X of Y" widget compared 243,663 against 12,059. Separately,
EXO sizes stored bytes but `serverArchiveItems`/`serverPrimaryItems` were null
(a stale pre-ItemCount EXO run); `archive_partitions.itemCount` is null too
(those panel numbers were always LOCAL backed-up counts, not server counts).

Fixes:
- Re-ran Fetch Sizes (EXO): `serverArchiveItems`=239,622, `serverPrimaryItems`
  =27,216 now populated (the EXO PowerShell script already parsed ItemCount —
  `lib/exo.js:44-46`; it had simply never re-run since).
- `lib/coverage.js`: archive `serverItems` = folder counts + aux-partition
  counts (`auxPartitionItems`, prefers real aux rows over the aux-combined
  placeholder), and `computeCoverage` overrides the archive denominator with
  EXO `serverArchiveItems` when present. PRIMARY deliberately keeps folder
  counts — EXO ItemCount also counts calendar/contacts/hidden items (27,216
  vs 14,915 real mail) and would fake a 51% gap.
- `server.js` `/api/mailbox/:upn`: derives `serverArchiveItems` as
  max(stored, folder+aux sum) so the scope header has a real total.
- `browse.jsx`: EXO total (`exoTotal`) now used for the archive scope ONLY
  (same calendar/contacts reason); approx `~` mode unchanged when no EXO count.

Verified via API after restart: primary 13,789/14,915, archive
243,663/239,622 (local > server is honest: 66 server-side deletions +
cross-channel duplicates), coverage state COMPLETE_UNVERIFIED.

## Left to do / known limits

- Other mailboxes with null `server*Items` will fix themselves on the next
  Fetch Sizes run.
- Reminder: **local** refresh only sees mail the backup engine has already
  downloaded — run a backup first to pick up new mail locally. **Live**
  refresh always scans the server directly.
