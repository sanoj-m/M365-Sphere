# 2026-10-07 — PST-driven repair at scale, recovery UI, full audit + security/stability fixes

One line: turned the corrupt-FTS problem into a solved pipeline — PST-imported
replacement repair (123k+ items), EWS repair for main-partition folders, dedupe,
metadata backfills, a PST recovery panel with a detached run button, plus a full
codebase audit whose P0/P1 findings were fixed the same week.

## Goals

- "most of the images in the archive is damaged, find a way to get the full image"
- "use these PSTs to redevelop the problematic emails… no duplications, replacement with clean copies"
- "remove duplicate emails… keep the one which has proper data"
- PST recovery stats/progress in the UI (split coverage panel, run button, all PSTs on disk shown, scrollable)
- "rerun everything which was closed" after a PC crash/reboot
- "update the readme… prepare detailed documentation while you do a full audit and tell me how good is the app"
- "prepare a detailed plan and fix whats needed" → "finish the pending as well"

## What was done

### Root cause established (Microsoft-side)
- Graph IE `exportItems` FTS streams insert 16-byte page-break junk at ~64 KB
  boundaries inside large attachments (verified byte-identical across re-exports —
  not our corruption). Undocumented EWS-variant format (Dmitry Streblechenko /
  Glen Scales confirmations). Small attachments unaffected; big images truncated.
- EWS sees only the main archive partition (aux folders show TotalCount=0);
  regular Graph `/messages/$value` 503s cross-server for aux; eDiscovery
  `exportResult` blocked tenant-wide ("Purview Billing account is not enabled").

### Repair tooling (new)
- `scripts/pst-repair.js` — walks Purview/Outlook PSTs (`pst-import/<mailbox>/`),
  maps condensed PST folder paths back to DB folders, matches FTS items by
  subject+date+size, rebuilds faithful `.eml.gz` **over the same fileId**
  (replacement, deletes `.fts.gz`), verifies image end-markers (PNG/GIF/JPEG,
  NUL-padding tolerant), logs per-PST stats to `data/pst-import-log.json`.
  `--dry` / `--force` modes; PSTFile handles closed in `finally`.
  **123k+ items replaced across user1 (53 PSTs, ~450 GB processed).**
- `scripts/repair-folder-ews.js` — EWS GetItem re-fetch for main-partition folders
  (proved on "Example Project": 17/18, images verified byte-perfect).
- `scripts/dedupe-items.js` — removes EWS-vs-GraphIE duplicate copies per folder
  (keep eml > fts > larger; 21,896 removed / 15.6 GB freed first pass).
- `scripts/backfill-fts-meta.js` — rewritten (streaming, busy-conn + giant-file
  guards): 148,528 + 10,470 items got sender/subject/date restored.
- Node utf16le odd-length slice **heap-corruption crash** found & fixed
  (`lib/fts.js` `u16()` guard) — this had killed every earlier backfill silently.

### Inline images fixed
- `lib/pstingest.js` `buildEml` now emits `Content-ID` (was dropped → `cid:` refs
  unmatchable); `lib/preview.js` `toPreview` embeds `cid:` images as data URIs for
  `.eml` items (was FTS-only). Force-rebuild pass (10,404 msgs) applied.
- fts.js metaOnly now scans head+tail (properties past big attachments); seam
  guard added (P1 fix).

### PST recovery UI
- `GET /api/mailbox/:upn/pst-repair` (log merge + live DB counts + on-disk PST
  scan incl. pending files) and `POST …` to run it.
- Panel next to Coverage on MailboxPage: PSTs imported/pending, rebuilt totals,
  progress bar, per-PST lines (scrollable), **Run PST recovery** button.
- Recovery job runs **detached** with file state (`data/pst-repair-job.json`,
  `data/pst-repair-run.log`) — survives server restarts; status derived from pid
  liveness (fixes the "keeps crashing" symptom: server restarts were killing the
  child process mid-run).

### UI polish
- Hover lift animations removed app-wide (card/btn/errfab translateY + the shadow
  hover effect); panels identical height; long lists scroll internally.

### Full audit (subagent) + fixes from the plan
- P0: `/session-token.js` now rejects cross-site fetches (`Sec-Fetch-Site`) —
  closes the browser script-tag token-theft path (verified 403/200 live).
- P0: `safeName` blocks `.`/`..` segments (path-traversal via folder names).
- P1: `PSTFile.close()` in pstingest + pst-repair; fts.js head+tail seam guard.
- P2: 13 one-off temp scripts deleted; `.gitignore` PST list collapsed to
  `pst-import/`; `config.example.json` cleaned (service relics removed);
  `fast-xml-parser` 4→5.3 (CVE, parser options verified compatible);
  `vite` 5→7 (build green).
- README.md rewritten (icons, current architecture, all channels, repair tooling,
  full API reference, integrity/security models, limitations).

## Decisions

- PST imports are **replacements, not new copies** — same fileId, .fts.gz deleted,
  row flipped to format='eml'. Disk usage stays ~flat; restore-grade FTS kept
  until its replacement verifies.
- Keep `.fts.gz` byte-exact for everything not repaired — Microsoft round-trips
  its own page-break format on import, so restore fidelity is intact.
- eDiscovery API export stays parked (Purview billing declined); manual Purview
  portal exports into `pst-import/` are the zero-cost route.
- server.js compare/transfer refactor and whole-message streaming deferred
  (no user-visible gain now); Graph-IE default flip tracks Microsoft's GA timeline.

## Current state

- HEAD `f83af64` pre-session; this session's work to be committed (52 files).
- user1: 123,153 pst-import-rebuilt items; ~90k FTS items remain (mostly not
  in any PST or folders pending backup); archive backup job done.
- Server running with all fixes; recovery job detached; panel live.
- Branch `feature/archive-upgrade`; remote github.com/sanoj-m/M365-Backup.

## Next steps

- Re-run `scripts/pst-repair.js` + `scripts/dedupe-items.js` after any new PST
  drop or when more folders finish backing up (both idempotent).
- Consider Graph-IE as default archive provider once API hits GA (EWS dies Apr 2027).
- Optional: server.js → lib/compare.js extraction; per-item streaming for 100 MB+ messages.
