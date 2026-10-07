---
name: saver
description: Save a session log of the current chat, update project docs/README, and push to git when there are 50 or more uncommitted changes
whenToUse: When the user asks to save the session, log progress, wrap up work, or when a work session ends and should be recorded for future reference
---

Save the current session for future reference by following these steps:

## 1. Write the session log

Create a Markdown file at `docs/sessions/YYYY-MM-DD-<short-slug>.md` (use today's date; if a file for today already exists, append a new dated section instead of overwriting). The log must include:

- **Date** and a one-line summary
- **Goals** — what the user asked for in this session
- **What was done** — concrete actions: files created/edited (with paths), commands run, commits made, repos pushed
- **Decisions** — choices made and why (e.g. what was gitignored, auth method used)
- **Current state** — where things stand (commit hash, remote URL, anything pending)
- **Next steps** — open tasks or follow-ups, if any

Read previous logs in `docs/sessions/` first so the new entry stays consistent in format.

## 2. Update docs and README

- Update `README.md` so it reflects the current state of the project: features, setup steps, scripts, and configuration. Remove anything stale.
- If a `docs/` file documents behavior that changed this session, bring it in line.

## 3. Commit and push when the change threshold is reached

- Count **individual files**, never `git status --short` line count — untracked directories collapse into one line there and hide hundreds of files. Use:
  - untracked: `git ls-files --others --exclude-standard | wc -l`
  - modified/deleted: `git ls-files --modified --deleted | wc -l`
  - total = the sum
- If the total number of changed files is **50 or more**, or the user explicitly asks, commit with a descriptive message and push to `origin`.
- Always include the new/updated session log and doc updates in the commit.
- Never commit `config.json`, `data/`, or `node_modules/` — they are gitignored; verify the actual file list (not just status lines) before committing.

## 4. Report

Tell the user: the session log path, what docs were updated, and whether a commit/push happened (with commit hash) or how many changes remain until the 50-change threshold.

ARGUMENTS: Optional note to include in the session log.
