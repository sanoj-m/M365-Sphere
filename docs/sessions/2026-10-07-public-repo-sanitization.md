# 2026-10-07 — Repo sanitization for going public, rebrand to M365-Sphere, new public repo

One line: audited tree + full git history for leaked secrets/user data, scrubbed
everything, started a fresh single-commit history, rebranded the app to
M365-Sphere, and published it as the new public repo `sanoj-m/M365-Sphere`.

## Goals

- "make sure that no usage data and user data are being exposed to git because i
  want to make this repo public"
- "add a new one, remove all reference of older software name and reference to
  killa from entire app and add it to a new repo. create one called M365-Sphere"
- "run saver skill by adjusting the skill to consider updating public repo and
  making sure local environment data is preserved locally"

## What was done

### Privacy audit (tree + all 44 commits of history)
- Clean: no client secrets, JWTs, refresh tokens, PEM keys, `config.json`,
  `data/`, session tokens — anywhere in tree or history.
- Leaks found: the app-registration **client ID** and enterprise-app
  **object ID** (values redacted) in 4 grant scripts, tenant name + domain in 7
  session logs + `scripts/probe-ipps.ps1`, several real mailbox UPNs, a
  person's first name, and — history-only — an old `.gitignore` with dozens of
  PST filenames containing a full UPN, plus deleted temp scripts with the domain.

### Sanitization (user chose "fresh history, keep everything locally available")
- Old history backed up OUTSIDE the repo: `../m365-git-backup-prepublic` (all 44
  commits, still locally available).
- Scrubbed tracked text files: domain → `example.com`, org → `Contoso`,
  UPNs → `user1…user5`, app GUIDs → `YOUR-APP-CLIENT-ID` /
  `YOUR-ENTERPRISE-APP-OBJECT-ID`, person name → `Admin`, project name →
  `Example Project`. Re-scan: zero matches; remaining GUIDs are only Microsoft
  well-known public IDs (Graph permission IDs, first-party public clients).
- Deleted `.git`, `git init -b main`, single commit — provably zero leakage in
  the new history.

### Rebrand to M365-Sphere
- `M365 PST Backup` / `M365PstBackup` / `m365-pst-backup` → `M365-Sphere`
  everywhere: server banner, service installer, package names, `lib/setup.js`
  app-registration name, `lib/exoexport.js` eDiscovery case name
  (`M365-Sphere Export` — next EXO export creates a fresh Purview case),
  README/AGENTS/all docs; `design-system/m365-pst-backup/` →
  `design-system/m365-sphere/`; `killa.onmicrosoft.com` → `tenant.onmicrosoft.com`.
- Dashboard bundle rebuilt (UI already branded M365Sphere).

### Public repo + saver skill update
- Created **PUBLIC** repo `github.com/sanoj-m/M365-Sphere` via `gh`, pushed
  `main` (HEAD `d41d62c`, 3 commits incl. rebrand).
- `.kimi-code/skills/saver/SKILL.md`: new "Public-repo + local-data rules"
  section — origin is public, re-verify staged files + grep for tenant
  identifiers before every commit, and local environment data
  (`data/`, `config.json`, `pst-import/`, `../m365-git-backup-prepublic`) must
  never be committed, pushed, or deleted.

## Decisions

- Fresh single-commit history over filter-repo rewrite: provably clean, and the
  old history is preserved locally outside the repo.
- A NEW public repo instead of flipping the old private one — GitHub can retain
  old commits by hash even after force-push; the old private repo
  `github.com/sanoj-m/M365-Backup` stays as an untouched archive (user may
  delete it).
- All local working data (`data/`, `config.json`, `pst-import/`) left exactly
  in place — required for the app to keep running.

## Current state

- Public: `github.com/sanoj-m/M365-Sphere` @ `d41d62c` (branch `main`, origin set).
- Local: server running with all previous fixes; recovery tooling intact; old
  history at `../m365-git-backup-prepublic`; old private repo untouched.

## Next steps

- Optional: delete the old private `M365-Backup` repo on GitHub.
- Ongoing: saver skill now guards public pushes — session logs must use
  placeholders, never real domains/UPNs/GUIDs.
