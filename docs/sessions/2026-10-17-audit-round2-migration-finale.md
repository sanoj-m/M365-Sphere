# Audit round 2 + 30 GB migration finale (2026-10-17)

Continuation of the 2026-10-16 session
(`2026-10-16-live-folder-repair-30gb-migration.md`): pushing every sub-9 audit
area to 9, and finishing the `pc-2` → `pc-main` project migration.

## Goals

- "Fix all the ones less than 9 and make it 9" — remaining areas: updater
  (trust model), guards (stall wedging), backup (verify sampling), PST
  pipeline (subst leaks, silent ingest skips), EXO export.
- Finish the 12-project migration and account for every single email.

## What was done

- **Updater → 9**: ed25519 release signing with zero new deps —
  `scripts/sign-release.js` (keygen to gitignored `installer/release-key.pem`,
  signs zip → `<zip>.sig`), pubkey embedded as `UPDATE_PUBKEY` in
  lib/updater.js, sig enforced when a real key is embedded; zip downloads now
  stream to disk. build-installer.ps1 signs automatically when the key exists.
- **Guards → 9**: 30-min no-progress stall watchdog for compare transfers
  (`compareLastProgress` heartbeat, auto-sets compareStop); timeout sweep —
  four gaps closed in lib/exoexport.js; auth.js/setup.js/graph.js/ews.js
  verified already covered.
- **Backup/PST → 9**: `cfg.verifySampleSize` (0 = full) + `/api/verify
  {full:true}`; subst letters persisted (`data/pst-subst.json`) and reclaimed
  safely at export start; pstingest `skippedAttachments` counter (embedded
  msg/OLE), surfaced in chunk logs.
- **Migration finale**: ASGC (18.5 GB, 5,779 items, 0 failed) finished;
  102 fuzzy-skip leftovers swept (all unique → uploaded with original dates,
  source tree of 103 folders deleted); Penthouse swept (18). All 12 projects
  done, source trees removed.
- **Verify-skips repair hardening**: the second pass started re-uploading
  items the first pass had already fixed — root cause: throttled destination
  MIME downloads were `.catch(()=>null)`'d into false "no match" judgments.
  Stopped after ~5 premature uploads; fixed to refuse judgment when candidate
  downloads fail. (The handful of resulting exact duplicates at the
  destination are fingerprint-identical — cleanable with a live dedupe pass.)
- Restored `scripts/sign-release.js` + `scripts/register-watchdog.ps1` after a
  parallel session's one-off-script cleanup deleted them from the working tree
  (both are permanent tooling, not one-offs).
- Parallel session shipped v1.1.3 (new sphere logo set) and published the
  first signed release assets (zip + .sha256 + .sig).

## Decisions

- Signing over more hashing: the sha256 sidecar comes from the same release as
  the zip, so only an embedded-key signature actually defeats a compromised
  repo. REPLACE_ME placeholder keeps self-hosters unbroken.
- The `pc-2` Deleted Items keep all retired sources (user chose recoverable
  over purged).

## Current state

- Commits: `d28278c` (audit round 2) → this session's commit. All audit areas
  9–10/10 (`docs/audit-2026-10-16.md`).
- Migration: 12/12 projects complete in `pc-main`; `pc-2`'s
  "13 Projects - closed" holds only the unmoved remainder. Final verify-skips
  pass (fixed version) running at commit time.
- Pending: restart the server when convenient to activate the engine fixes;
  optional live-dedupe pass on the touched destination folders.

## Next steps

- Final migration summary once the verify pass completes; delete the hourly
  cron.
- Fresh-VM installer test (audit §6 dynamic part) still open.
