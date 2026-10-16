# M365-Sphere NSIS installer

Builds `M365Sphere-Setup.exe` — a user-level Windows installer that any
recipient can run to install M365-Sphere with no project data or secrets.

## Rebuild

From the repo root (needs Node.js and NSIS; the script installs NSIS via
winget if missing):

```powershell
powershell -ExecutionPolicy Bypass -File installer\build-installer.ps1
```

The script:

1. Builds the React dashboard (`npm --prefix web-react run build`).
2. Stages the app into `installer/stage\` — everything the server needs at
   runtime (`server.js`, `lib/`, `ps/`, `web/`, `web-react/dist`,
   runtime `scripts/`, `package*.json`, `config.example.json`, `README.md`,
   `run-console.bat`) plus the installer helpers in `assets/`. It never
   stages `config.json`, `data/`, `node_modules/`, `pst-export/`,
   `pst-import/`, `.git/`, `tools/`, `design-system/`, `docs/`, or
   `web-react` sources, and fails the build if any of those end up staged.
3. Compiles `m365-sphere.nsi` → `installer/M365Sphere-Setup.exe`.

## What the installer does

- User-level install to `%LOCALAPPDATA%\M365-Sphere` (the app writes `./data`,
  so Program Files would break it). No admin rights needed.
- Checks for Node.js; if missing, offers to install Node.js LTS via winget
  (winget shows its own UAC prompt). Aborts with a clear message if node is
  still unavailable.
- Copies files, then runs `npm install --omit=dev --no-audit --no-fund --ignore-scripts`
  in the install dir. `--ignore-scripts` is deliberate: better-sqlite3 ships an
  N-API prebuilt binary in its package (no compiler needed), but npm would
  otherwise auto-run `node-gyp rebuild` and fail on machines without Visual
  Studio build tools. Internet is still required to download the packages.
- Optional "Start with Windows" checkbox (Startup-folder shortcut — not a
  service, so Outlook COM PST export keeps working in the interactive
  session).
- Finish page launches `Start-M365-Sphere.bat`, which starts the server and
  opens http://localhost:8080. On first run the server starts unconfigured and
  the dashboard shows the "Connect to Microsoft 365" wizard — one Global Admin
  sign-in creates the app registration, permissions, consent and client secret
  automatically (no manual Entra portal steps, no config.json editing).
- Uninstaller removes app files, shortcuts and the Startup entry, and asks
  before deleting `data\`, `pst-export\`, `pst-import\` and `config.json`
  (default: keep).

## Auto-updates

Installed instances check the public GitHub repo's latest Release (repo set via
`updateRepo` in config.json) on startup and once a day. When a newer version is
published, an "Update available" chip appears in the dashboard header; one click
downloads the zip, swaps the app files (`data\`, `node_modules\`, `pst-export\`,
`pst-import\`, `config.json` and logs are never touched), runs `npm install` if
dependencies changed, and restarts the app. Settings → "Check for updates"
triggers a manual check.

To ship an update:

1. Bump `version` in package.json and commit your fixes.
2. Run `build-installer.ps1` — it also produces `installer\M365Sphere-update.zip`.
3. Create a GitHub Release tagged `v<version>` in the public repo and attach
   `M365Sphere-update.zip` (and `M365Sphere-Setup.exe` for new installs).

## Caveats

- PST export still requires desktop Outlook on the host (Outlook COM,
  interactive session) — unchanged app behavior; see the main README.
- The eDiscovery PST export path needs the tenant grants documented in the
  main README (`scripts/grant-ediscovery-graph.ps1`, delegated token via
  `scripts/exo-delegate-token.js`).
