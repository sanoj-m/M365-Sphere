# 2026-09-30 — Copy wizard: folder tree, select/deselect all, expand/collapse all

## Goals

- Copy/Move wizard: add a select-all / deselect-all checkbox to the source folder list.
- Show the source folders as the same expandable tree used in the backup view, instead of a flat path list.
- Add Expand all / Collapse all buttons in the same header area.

## What was done

- **`web-react/src/components/CopyWizard.jsx`** — replaced the flat `copy-folder` list with a tree matching `browse.jsx`:
  - `buildTree()` (same parent/child assembly + name sort as the backup view).
  - `CopyTreeNode` — tree rows using the existing `tv-control tree-row` / `tv-indicator` / `tv-text` / `tree-kids` markup and chevron/folder icons; each node has a checkbox that cascades to all selectable descendants (`backedUp > 0`) and shows an indeterminate state on partial selection; empty folders are disabled.
  - `CopyScopeTree` — one section per scope (Primary / Archive); archive root flattened like the backup view; header holds a select-all/deselect-all checkbox (indeterminate when partial), an "N/M folders selected" counter, and Expand all / Collapse all buttons (same `tree-all-btns` style/behavior as `ScopeTree`).
  - `toggleMany(keys, add)` replaces single-key `toggle` for cascade/bulk updates; removed unused `CheckCircle` import.
- **`web-react/src/styles.css`** — `.copy-tree-label`, `.copy-select-all`, `.copy-folderlist .scope-tree` styles.
- Rebuilt the React bundle (`npm run build` → `dist/assets/index-AkHu7aOQ.js`); frontend-only change, no server restart.

## Decisions

- Selection cascades parent → descendants so checking a container folder is meaningful; each selected folder still counts only its own items, so totals don't double-count.
- Reused the backup view's tree markup/CSS classes instead of importing `ScopeTree` — `ScopeTree` is select-to-browse, not checkbox multi-select; a parallel read-only component is smaller than generalizing it.

## Current state

- UI live after browser refresh (no server restart needed).
- 36 changed files uncommitted (11 untracked + 25 modified) — below the 50-file auto-commit threshold; no commit made.

## Next steps

- Commit + push when the change count crosses 50 files or on request.
