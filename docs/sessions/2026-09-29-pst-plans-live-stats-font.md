# Session Log — 2026-09-29 — Folder-based PST plans, live stats, clear events, font swap

**Summary:** PST export can now be split by manual folder selection (49 GB cap, folders never span PSTs, duplicate selection blocked), the mailbox detail modal stats update live, a Clear-events button was added, and the UI font was changed to Google Sans.

## Goals

- PST export: split a mailbox into multiple PSTs by manually selecting folders per PST; 49 GB per-PST cap; a folder and its contents must stay together in one PST; folders already assigned to one part cannot be selected for another.
- Mailbox detail modal: all stats (FOLDERS / SOURCE ITEMS / BACKED UP / MISSING / ON DISK, folder tree chips) must update live.
- A button to clear all events of a mailbox.
- Change the UI font (away from Google Sans Code headings) — first Montserrat, then settled on Google Sans.

## What was done

- **PST plans — PowerShell** (`ps/Export-MailboxToPst.ps1`): new `-PlanPath` param (JSON `[{name, folders:["scope/path",…]}]`); `Select-PartFiles` does segment-aware prefix matching on disk paths; per part one PST `{Mailbox}-{Stamp}-{part}.pst` with `-b/-c` continuation files if the part exceeds the cap; PST closed between parts so folders never span files; result JSON gains `parts`. Default cap 48 → 49 GB. No-plan behavior unchanged.
- **PST plans — orchestrator** (`lib/pst.js`): `runExport(upn, plan)` + `validatePlan` (folders must exist in `folderStats`; duplicates and ancestor/descendant overlaps across parts rejected with clear messages); plan written to `data/pstjobs/<upn>_<stamp>/plan.json`; pstStatus reports "N PST file(s) in M part(s)".
- **Server** (`server.js`): `POST /api/pst` accepts `{upn, plan}` (400 on validation errors); new `DELETE /api/mailbox/:upn/events`.
- **Store** (`lib/store.js`): `clearEvents(upn)` — deletes event rows for one mailbox, returns count.
- **Plan builder UI** (`web-react/src/components/PstPlanBuilder.jsx`, new; wired into `MailboxTable.jsx`, `BackupPage.jsx`, `App.jsx`, `styles.css`): checkbox folder tree with per-folder sizes, "Add selection as Part N" locks folders (badge + disabled, descendants auto-included), editable part names, per-part est. GB with red >49 GB warning, unassigned-folders summary, whole-mailbox export still available.
- **Live stats** (`web-react/src/components/DetailPanel.jsx`): modal previously rendered only the last verify report and polled `/api/mailbox/:upn` (no live progress). Now also fetches `/api/mailbox/:upn/folders` (live `backedUp`/`bytes` + engine `live`), subscribes to SSE with a 1.5 s throttle (5 s poll kept as fallback); stat cards, missing badge, "Show incomplete only", tree chips and the backup progress bar all update live.
- **Clear events** (`DetailPanel.jsx` EVENTS tab): "Clear events" button with confirm, disabled while clearing/empty; clear action is logged globally so it doesn't recreate a mailbox event.
- **Font** (`web-react/index.html`, `styles.css`): `--font-heading`/`--font-body` → Google Sans; new `--font-mono` (JetBrains Mono) kept for code/log text. Montserrat was tried first at user request, then replaced with Google Sans.

## Decisions

- 49 GB cap is enforced authoritatively in the PS script (file-size check after each item); UI estimates use raw MIME bytes (conservative).
- Ancestor/descendant overlap validation lives server-side too, not just in the UI, so API callers can't double-export folders.
- ON DISK card still refreshes only after a verify completes — that number is only computed by the verify walk.
- Endpoint style follows existing routes (`DELETE /api/mailbox/:upn/events`, mirroring `DELETE /api/mailbox/:upn/backup`).

## Current state

- `npm run build` (web-react) passes; `node --check server.js` clean; PowerShell parser clean on the ps1.
- The planned-PST path was dry-run tested (prefix matching + plan validation against the real state.db) but **not run end-to-end** — needs Outlook COM in console mode; watch the first real run with a small part.
- Changed files reached the 50 threshold → committed and pushed this session (see git log).

## Next steps

- User: run a real PST export in console mode (`run-console.bat`) with a small plan first to validate the Outlook COM path.
- Backend changes (server.js/lib) require a service/console restart to take effect.
