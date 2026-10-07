# 2026-10-07 — Dedupe page: concurrent sessions, content-fingerprint verification, incremental moves

One line: built the standalone Dedupe page (`/?dedupe`) end-to-end — multiple
concurrent per-mailbox sessions, verified live dedupe that moves duplicates to
Deleted Items with folder structure kept, run history with resume, and two
rounds of verification fixes driven by live diffs.

## Goals

- "i need a new page called dedupe … select an online email or local backup to dedupe"
- "dedupe should … move them to deleted with keeping its folder structure, make
  sure the emails are duplicated — dont dedupe unless its duplicate verified"
- Live progress while checking (folders + stats + logs); logs must persist
  after stop; resume where a run stopped
- Exclude Deleted Items and Junk from scans; per-mailbox task history with
  restart-failed / verify-again actions
- Refresh must not reset the page; add a Reset button
- "make me multiple dedupe sessions in the same page"; column layout for cards
- "still not moving" — why are verified duplicates not landing in Deleted Items?

## What was done

### Dedupe page (frontend, `web-react/src/`)
- New route `/?dedupe` in `main.jsx`, nav link in `App.jsx`, exported
  `MailboxPicker` from `ComparePage.jsx`.
- `components/DedupePage.jsx`: session-per-mailbox cards in a responsive column
  grid (`.dedupe-grid` in `styles.css`), each with scope toggle (Local backup /
  Live mailbox), check → report → apply, per-session Stop, run History
  (`dedupe`/`dedupe-check` job rows; Restart resumes, Verify again re-checks),
  live check progress (folders done/total, current folder, messages, candidate
  groups), and a persistent mailbox log tail. Sessions/scope/reports persist in
  localStorage (`dedupe.sessions`, `dedupe.target.<upn>`, `dedupe.report.<upn>`);
  Reset clears all. Legacy single-mailbox key migrated.

### Backend (`lib/dedupe.js`, `lib/store.js`, `server.js`)
- Per-mailbox concurrency: `DedupeEngine._runs` (upn → `{stop, aborter}`),
  `running` aggregate getter, `isRunning(upn)`, `stop(upn?)`; apply/restore 409
  only for the same mailbox. `/api/status` exposes `dedupeRuns` + `dedupeChecks`
  (upn-keyed progress map); `/api/stop/dedupe` takes `{upn?}`.
- `jobs.upn` column (store.js migration; `createJob(kind, total, upn)`); checks
  recorded as `dedupe-check` job rows, applies as `dedupe`.
- Live moves keep folder structure: `Deleted Items/Dedupe <date>/<original
  path>` via `graph.ensureChildFolder` from `deleteditems`, folder-id cache.
- Scans exclude Deleted Items AND Junk Email subtrees (`_liveFolders`,
  well-known folder ids) — junk exempt, re-runs resume after a stop.

### Verification fixes (the "not moving" saga)
- v1 raw-byte SHA-256 of Graph `$value` MIME rejected everything: diffed two
  real copies (`scripts/_dedupe-diff.js`) — Exchange rewrites transport headers
  and re-wraps MIME per copy (boundaries/encodings); a signature relay even
  replaced the text part.
- v2 header-stripped byte hash still failed (boundaries differ).
- Final: `mimeFingerprint()` — mailparser parse, hash identity headers
  (subject/from/to/cc/message-id/date) + whitespace-stripped html (text
  fallback) + decoded attachment bytes. Verified MATCH on the previously
  rejected pair.
- Incremental moves: verified duplicates move immediately per group (was: move
  phase only after ALL groups verified → hours with zero visible movement and
  lost progress on restart). Progress detail `group X/Y: N moved, F failed, K
  skipped`. One real run moved 8021 items, 0 failed.

## Decisions

- Verification errs safe: any fetch/parse error or fingerprint mismatch = keep
  the message (logged "content differs"/"could not verify"); ~10% of candidates
  are legitimately-different relay variants and stay by design.
- History action buttons act on the currently selected scope toggle (jobs table
  doesn't record target).
- Query-param routing `/?dedupe` (SPA has no path router), matching `/?compare=`.

## Current state

- Server restarted and healthy; UI rebuilt to `web-react/dist`.
- Live run #969 completed: 8021 duplicates in `Deleted Items/Dedupe 2026-10-07`.
- This commit adds the incremental-move fix + column grid + docs (all earlier
  work went in with the repo-sanitization commit `49af506`).

## Next steps

- Optional: a "move anyway" review list for the ~10% skipped non-identical
  candidates (currently kept forever by the safe default).
