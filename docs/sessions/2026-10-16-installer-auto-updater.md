# Windows installer, seamless first run & GitHub auto-updater (2026-10-16)

Packaged M365-Sphere as a distributable Windows installer and added a
self-updater so fixes can be shipped to installed instances via public GitHub
Releases.

## Goals

- Package the app as a Windows installer with all dependencies, no local data.
- Make installation/first run seamless (no console prompts, no config editing).
- Add an automatic updater fed by the public GitHub repo's Releases.
- Save the session and push to the public repo.

## What was done

- **NSIS installer** (`installer/`, new): `build-installer.ps1` builds
  web-react, stages a data/secret-free tree into `installer/stage/`
  (sanity-checked: no `config.json`, `data/`, `node_modules/` etc.), compiles
  `m365-sphere.nsi` → `M365Sphere-Setup.exe` (1.72 MB) and, since the updater
  was added, also `M365Sphere-update.zip`. NSIS installed via winget.
  Installer behavior: user-level install to `%LOCALAPPDATA%\M365-Sphere`,
  Node.js 22 LTS via winget when missing, `npm install --omit=dev
  --ignore-scripts` at install time (better-sqlite3 N-API prebuilt, no
  compiler needed), optional Startup-folder shortcut, Add/Remove Programs
  entry, uninstaller that asks before deleting backups/config.
- **Seamless first run**: `server.js` no longer exits when `config.json` is
  missing — copies the template and starts unconfigured; the dashboard
  auto-shows the existing SetupPanel wizard (one Global Admin device-code
  sign-in provisions the Entra app, consent, secret, archive grant). Removed
  the PowerShell `first-run-setup.ps1` Read-Host flow and its Start Menu
  shortcut; `Start-M365-Sphere.bat` just starts the server + opens the
  browser.
- **Auto-updater**: `lib/updater.js` (check latest GitHub Release via
  unauthenticated API → semver-compare vs package.json `version` → download
  release zip to `data/update/` → verify → spawn `scripts/update-apply.bat`
  detached → exit code 42). `update-apply.bat` waits for server exit,
  `robocopy /MIR` over the app dir excluding `data/ node_modules/ pst-export/
  pst-import/ tools/ .git/` + `config.json Uninstall.exe *.log`, runs npm
  install when package-lock changed, relaunches the launcher, logs to
  `data/update-apply.log`. Routes `GET /api/update/status`,
  `POST /api/update/check|apply`; `status.update` in `/api/status`; daily +
  startup checks gated on `updateRepo`/`updateCheck` in config.example.json.
  UI: header chip "Update available — vX" with confirm + poll-until-reload
  (`App.jsx`, `.conn-update` style), Settings → "Check for updates".
  Launchers (`Start-M365-Sphere.bat`, `run-console.bat`) exit their restart
  loop on code 42. package.json bumped to 1.1.0.
- **Public-repo hygiene for this push**: `installer/stage/` and
  tenant-specific one-off scripts/docs added to `.gitignore`
  (`compare-archive-11projects.js`, `fix-kvbids-root-folders.js`,
  `move-pc2-projects.js`, `move-pc2-sweep.js`, a user1 folder-list doc);
  sanitized a real UPN in AGENTS.md → `user1`; README repo note updated to
  public; GUID/identifier grep over everything staged (clean — only
  well-known Microsoft first-party GUIDs remain).

## Decisions

- NSIS over zip/self-contained package (user choice); dependencies install at
  setup time (internet required) instead of bundling node_modules — avoids
  Node ABI mismatch (build machine runs Node 24, recipients get 22 LTS).
- Updates delivered as a plain zip of the staged tree attached to a Release —
  no code signing / delta updates (kept minimal); swap script is a .bat so no
  new runtime deps.
- The public repo doubles as the update channel; `updateRepo` in
  config.example.json points at `sanoj-m/M365-Sphere`.

## Current state

- `installer/M365Sphere-Setup.exe` (1.72 MB) + `installer/M365Sphere-update.zip`
  (2.75 MB) built and reproducible via `installer/build-installer.ps1`.
- Server on this machine picks up the updater only after its next restart.
- Pushed to `origin` (public github.com/sanoj-m/M365-Sphere) — see git log.

## Next steps

- Publish GitHub Release `v1.1.0` with `M365Sphere-update.zip` +
  `M365Sphere-Setup.exe` attached; then end-to-end test: install the exe on a
  clean machine/VM, watch the update chip appear, apply, verify restart.
- Known pre-existing gap: the wizard's automatic archive impersonation grant
  uses the removed `Connect-ExchangeOnline -Device` flow — it surfaces manual
  instructions on failure; worth fixing separately.
