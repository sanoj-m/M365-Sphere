// Backup coverage accounting — deliberately separate from job execution status.
// A job can be 'done' while coverage is PARTIAL (e.g. auto-expanding archive
// auxiliary partitions no sync API can reach). hiddenCount items are reported as
// unreachable and always push coverage to PARTIAL/BLOCKED — never absorbed.
// All byte figures are logical (uncompressed) sizes; never mix with disk bytes.

const GAP_MIN = 1024 ** 3; // 1 GB or 5% — same threshold as the UI heuristic
const gapThreshold = serverBytes => Math.max(GAP_MIN, 0.05 * (serverBytes || 0));

function scopeCoverage(store, upn, scope) {
  // Server items: dedupe by folder path — the same logical folder can appear in
  // several provider namespaces (EWS scan rows + Graph IE 'ie-' rows), and their
  // itemCounts are the same server-side count. Count each path once (max wins).
  const rows = store.db.prepare(
    `SELECT path, itemCount, hiddenCount FROM folders WHERE upn=? AND scope=? AND folderId NOT LIKE 'exo%'`).all(upn, scope);
  const byPath = new Map();
  for (const r of rows) {
    const key = r.path || '';
    const cur = byPath.get(key) || { itemCount: 0, hiddenCount: 0 };
    cur.itemCount = Math.max(cur.itemCount, r.itemCount || 0);
    cur.hiddenCount = Math.max(cur.hiddenCount, r.hiddenCount || 0);
    byPath.set(key, cur);
  }
  let serverItems = 0, unreachableItems = 0;
  for (const v of byPath.values()) { serverItems += v.itemCount; unreachableItems += v.hiddenCount; }
  const f = { folders: rows.length, serverItems, unreachableItems };
  const i = store.db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status IN ('done','deduped') THEN 1 ELSE 0 END),0) localItems,
      COALESCE(SUM(CASE WHEN status IN ('done','deduped') THEN size ELSE 0 END),0) localBytes,
      COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END),0) failedItems,
      COALESCE(SUM(CASE WHEN status NOT IN ('done','deduped','deleted','failed') THEN 1 ELSE 0 END),0) pendingItems,
      COALESCE(SUM(CASE WHEN deletedFromSourceAt IS NOT NULL THEN 1 ELSE 0 END),0) deletedFromSource
    FROM items WHERE upn=? AND scope=?`).get(upn, scope);
  return { folders: f.folders, ...f, ...i };
}

// Returns { state, primary, archive, archiveGapBytes, checkedAt }.
// States: NOT_STARTED | BACKING_UP | FAILED | BLOCKED | PARTIAL | COMPLETE_UNVERIFIED | COMPLETE_VERIFIED
// (DISCOVERING/VERIFYING/PAUSED are live job states, not persisted coverage states.)
// opts.ieEnabled: when the Graph IE archive provider is active, AEA auxiliary
// partitions ARE reachable — the gap no longer forces BLOCKED.
function computeCoverage(store, upn, opts = {}) {
  const m = store.getMailbox(upn);
  if (!m) return null;
  const primary = scopeCoverage(store, upn, 'primary');
  const archive = scopeCoverage(store, upn, 'archive');

  const ewsArch = m.ewsArchiveBytes != null ? m.ewsArchiveBytes : null;
  const archiveGapBytes = m.autoExpandingArchive && m.serverArchiveBytes != null && ewsArch != null
    ? Math.max(0, m.serverArchiveBytes - ewsArch) : null;

  let state;
  if (m.status === 'syncing') state = 'BACKING_UP';
  else if (m.status === 'error') state = 'FAILED';
  else if (m.status === 'skipped') state = 'BLOCKED';
  else {
    const missing = (primary.pendingItems + primary.failedItems + archive.pendingItems + archive.failedItems);
    const unreachable = primary.unreachableItems + archive.unreachableItems;
    const aeaBlocked = !opts.ieEnabled && archiveGapBytes != null && archiveGapBytes > gapThreshold(m.serverArchiveBytes);
    const started = primary.folders + archive.folders + primary.localItems + archive.localItems > 0 || m.status === 'done' || m.status === 'partial';
    // Byte-level honesty: folder itemCounts do NOT include AEA expanded-folder
    // content living in auxiliary partitions, so item counts alone can fake
    // 'complete'. Compare logical bytes (FTS/EML sizes are same-ballpark).
    const archByteShort = m.serverArchiveBytes != null && archive.folders > 0
      && archive.localBytes < 0.7 * m.serverArchiveBytes;
    const primByteShort = m.serverPrimaryBytes != null && primary.folders > 0
      && primary.localBytes < 0.7 * m.serverPrimaryBytes;
    if (aeaBlocked) state = 'BLOCKED'; // known content no configured provider can reach
    else if (!started) state = 'NOT_STARTED';
    else if (missing > 0 || unreachable > 0 || archByteShort || primByteShort) state = 'PARTIAL';
    else state = m.verifyOk === 1 ? 'COMPLETE_VERIFIED' : 'COMPLETE_UNVERIFIED';
  }
  return {
    state, primary, archive, archiveGapBytes,
    serverPrimaryBytes: m.serverPrimaryBytes ?? null,
    serverArchiveBytes: m.serverArchiveBytes ?? null,
    autoExpandingArchive: !!m.autoExpandingArchive,
    checkedAt: new Date().toISOString()
  };
}

// Persist the computed state so the mailbox table can show it without recompute.
function refreshCoverage(store, upn, opts = {}) {
  const c = computeCoverage(store, upn, opts);
  if (c) store.patchMailboxFields(upn, { coverageState: c.state, coverageCheckedAt: c.checkedAt });
  return c;
}

module.exports = { computeCoverage, refreshCoverage, gapThreshold };
