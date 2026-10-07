import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createTreeCollection } from '@ark-ui/react/tree-view';
import { api, del } from '../api.js';
import { fmtDateTime } from '../format.js';
import { cacheGet, cacheSet } from '../cache.js';
import { useLive } from '../live.jsx';
import FolderTreeView from './ui/tree-view.jsx';

const fmtNum = n => Number(n || 0).toLocaleString();

// Per-folder stats: live backed-up counts from folderStats (items table) win
// over the last verify report; graph/onDisk come from the report when present.
function makeStatsFor(reportFolders) {
  const reportByKey = new Map();
  for (const r of reportFolders) {
    reportByKey.set(r.scope + '|' + (r.path || r.name), r);
    reportByKey.set(r.scope + '|name:' + r.name, r);
  }
  return f => {
    const r = reportByKey.get(f.scope + '|' + (f.path || f.name)) || reportByKey.get(f.scope + '|name:' + f.name);
    const graph = r ? (r.graph || 0) : (f.itemCount || 0);
    const local = f.backedUp != null ? f.backedUp : (r ? (r.local || 0) : 0);
    return { graph, local, missing: Math.max(0, graph - local), onDisk: r ? (r.onDisk || 0) : 0 };
  };
}

// Build the tree from the server's authoritative folder list (folders table,
// linked by parentId), overlaying verification counts from the report matched
// by scope+path (falling back to scope+name for older reports without paths).
function buildFolderTree(serverFolders, statsFor, onlyMissing, hideEmpty) {

  const byScope = new Map();
  for (const f of serverFolders) {
    if (!byScope.has(f.scope)) byScope.set(f.scope, new Map());
    byScope.get(f.scope).set(f.folderId, { f, childList: [] });
  }

  const nodeFor = new Map();
  const makeNode = entry => {
    if (nodeFor.has(entry.f.folderId)) return nodeFor.get(entry.f.folderId);
    const node = {
      id: entry.f.scope + '|' + entry.f.folderId,
      name: entry.f.name,
      stats: statsFor(entry.f),
    };
    nodeFor.set(entry.f.folderId, node);
    return node;
  };

  const roots = [];
  for (const [scope, entries] of byScope) {
    const top = [];
    for (const entry of entries.values()) {
      const parent = entry.f.parentId && entries.get(entry.f.parentId);
      if (parent) parent.childList.push(entry); else top.push(entry);
    }
    const assemble = entry => {
      const node = makeNode(entry);
      if (entry.childList.length) {
        node.children = entry.childList.map(assemble).sort((a, b) => a.name.localeCompare(b.name));
        node.missingTotal = node.stats.missing + node.children.reduce((s, c) => s + (c.missingTotal ?? c.stats.missing), 0);
        node.graphTotal = node.stats.graph + node.children.reduce((s, c) => s + (c.graphTotal ?? c.stats.graph), 0);
      }
      return node;
    };
    const children = top.map(assemble).sort((a, b) => a.name.localeCompare(b.name));
    roots.push({
      id: 'scope:' + scope,
      name: scope === 'archive' ? 'Archive' : 'Primary mailbox',
      children,
      missingTotal: children.reduce((s, c) => s + (c.missingTotal ?? c.stats.missing), 0),
    });
  }

  // Keep incomplete folders plus their ancestor chain when filtering.
  const prune = nodes => nodes
    .map(n => {
      if (!n.children) return n.stats.missing > 0 ? n : null;
      const kids = prune(n.children);
      const selfMissing = n.stats.missing > 0;
      if (!selfMissing && !kids.length) return null;
      return { ...n, children: kids.length ? kids : n.children, missingTotal: n.missingTotal };
    })
    .filter(Boolean);
  const finalRoots0 = onlyMissing
    ? roots.map(r => ({ ...r, children: prune(r.children) })).filter(r => r.children.length)
    : roots;

  // Drop folders that hold no emails anywhere in their subtree.
  const pruneEmpty = nodes => nodes
    .map(n => {
      if (!n.children) return n.stats.graph > 0 ? n : null;
      const kids = pruneEmpty(n.children);
      if (!kids.length && !(n.graphTotal > 0)) return null;
      return kids.length ? { ...n, children: kids } : null;
    })
    .filter(Boolean);
  const finalRoots = hideEmpty
    ? finalRoots0.map(r => ({ ...r, children: pruneEmpty(r.children) })).filter(r => r.children.length)
    : finalRoots0;

  return createTreeCollection({
    nodeToValue: node => node.id,
    nodeToString: node => node.name,
    rootNode: { id: 'ROOT', name: '', children: finalRoots },
  });
}

export default function DetailPanel({ upn, onClose }) {
  const [d, setD] = useState(() => cacheGet('mailbox:' + upn, null));
  const [tab, setTab] = useState('verify');
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [hideEmpty, setHideEmpty] = useState(false);
  const [clearing, setClearing] = useState(false);
  const aliveRef = useRef(true);
  const live = useLive();
  // Detail data + live folderStats (backedUp counts) + engine.live progress.
  const load = useCallback(() => Promise.all([
    api('/api/mailbox/' + encodeURIComponent(upn)),
    api('/api/mailbox/' + encodeURIComponent(upn) + '/folders')
  ])
    .then(([m, f]) => {
      if (!aliveRef.current) return;
      const next = { ...m, folders: f.folders, live: f.live };
      setD(next);
      cacheSet('mailbox:' + upn, next);
    })
    .catch(() => aliveRef.current && setD(prev => prev || { error: true })), [upn]);
  useEffect(() => {
    aliveRef.current = true;
    // Show the last stored snapshot immediately, then refresh from the server.
    const cached = cacheGet('mailbox:' + upn, null);
    if (cached) setD(cached);
    load();
    const t = setInterval(load, 5000); // fallback polling
    // Live refresh via the app's SSE stream (throttled — progress fires up to every 500ms)
    let last = 0, timer = null;
    const unsub = live.subscribe(() => {}, () => {
      const now = Date.now();
      if (now - last > 1500) { last = now; load(); }
      else if (!timer) timer = setTimeout(() => { timer = null; last = Date.now(); load(); }, 1500);
    });
    return () => { aliveRef.current = false; clearInterval(t); clearTimeout(timer); unsub(); };
  }, [upn, load, live]);

  const clearEvents = () => {
    if (!window.confirm(`Delete all stored events for ${upn}? This cannot be undone.`)) return;
    setClearing(true);
    del('/api/mailbox/' + encodeURIComponent(upn) + '/events')
      .then(load)
      .catch(e => alert('Clear events failed: ' + e.message))
      .finally(() => setClearing(false));
  };

  // Server already parses verifyReport into `report`; fall back to parsing the raw string only if needed.
  let report = d && !d.error ? (d.report || null) : null;
  if (!report && d && typeof d.verifyReport === 'string') {
    try { report = JSON.parse(d.verifyReport); } catch { report = null; }
  }
  const integrity = (report && report.integrity) || { checked: 0, failed: 0 };
  const folders = (report && report.folders) || [];
  const topErrors = (report && report.topErrors) || [];

  const statsFor = useMemo(() => makeStatsFor(folders), [folders]);
  const serverFolders = (d && d.folders) || [];
  // Stat cards: live per-folder stats (backedUp from the items table) when the
  // folder list is available, else the last verify report's aggregates.
  const totals = useMemo(() => {
    const rows = serverFolders.length ? serverFolders.map(f => statsFor(f)) : folders;
    return rows.reduce((t, f) => ({
      source: t.source + (f.graph || 0),
      local: t.local + (f.local || 0),
      missing: t.missing + (f.missing || 0),
      onDisk: t.onDisk + (f.onDisk || 0),
    }), { source: 0, local: 0, missing: 0, onDisk: 0 });
  }, [serverFolders, folders, statsFor]);

  const collection = useMemo(
    () => buildFolderTree(serverFolders.length ? serverFolders : folders.map(f => ({ scope: f.scope, folderId: (f.path || f.name), parentId: null, name: f.name, path: f.path || f.name, itemCount: f.graph })), statsFor, onlyMissing, hideEmpty),
    [serverFolders, folders, statsFor, onlyMissing, hideEmpty]
  );
  const missingFolders = (serverFolders.length ? serverFolders.filter(f => statsFor(f).missing > 0) : folders.filter(f => f.missing > 0)).length;
  const folderCount = serverFolders.length || folders.length;
  const [copied, setCopied] = useState(false);

  const copyForAgent = () => {
    const lines = [];
    lines.push(`Help me fix backup issues for mailbox ${d.upn} in the M365 PST Backup tool (repo: m365-pst-backup, Node.js backend in lib/, verify logic in lib/engine.js).`);
    lines.push('');
    if (report) {
      lines.push(`Verification (${report.at}): ${totals.missing === 0 ? 'PASSED' : `FAILED — ${totals.missing} items not backed up`} · integrity ${integrity.checked - integrity.failed}/${integrity.checked} samples OK`);
      const bad = folders.filter(f => f.missing > 0);
      if (bad.length) {
        lines.push('');
        lines.push(`Folders with missing items (${bad.length}):`);
        for (const f of bad) lines.push(`  - [${f.scope}] ${f.path || f.name}: source ${f.graph}, backed up ${f.local}, missing ${f.missing}, on disk ${f.onDisk}`);
      }
      if (topErrors.length) {
        lines.push('');
        lines.push('Top pending reasons:');
        for (const e of topErrors) lines.push(`  - ${e.n || 0} × ${String(e.lastError || '').slice(0, 200)}`);
      }
    }
    const errs = d.events.filter(e => e.level === 'error' || e.level === 'warn');
    lines.push('');
    lines.push(`Recent events (${d.events.length} total, ${errs.length} warnings/errors):`);
    for (const e of d.events.slice(-80)) lines.push(`  [${e.ts.slice(0, 19).replace('T', ' ')}] ${e.level.toUpperCase()} ${e.message}`);
    lines.push('');
    lines.push('Diagnose the root cause and propose a fix.');
    navigator.clipboard.writeText(lines.join('\n')).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  const allBranchIds = useMemo(() => {
    const ids = [];
    const walk = nodes => nodes.forEach(n => { if (n.children) { ids.push(n.id); walk(n.children); } });
    walk(collection.rootNode.children || []);
    return ids;
  }, [collection]);

  if (!d) return <section className="detail card"><h2>Loading {upn}…</h2></section>;
  if (d.error) return <section className="detail card"><h2>Failed to load {upn}</h2><button className="btn" onClick={onClose}>Close</button></section>;

  return (
    <section className="detail card">
      <div className="detail-head">
        <div className="detail-title">
          <h2>{d.upn}</h2>
          {report && (
            <span className="detail-meta">
              Verified {fmtDateTime(report.at)}
              {' · '}integrity {integrity.checked - integrity.failed}/{integrity.checked} samples OK
            </span>
          )}
        </div>
        <div className="detail-actions">
          <button className="btn small" title="Open this mailbox as a full page in a new tab"
            onClick={() => window.open('/?mailbox=' + encodeURIComponent(d.upn), '_blank', 'noopener')}>⤢ Open as page</button>
          {(d.status === 'syncing' || d.live) && (
            <span className="chip syncing chip-pulse">
              Backup running{d.live && d.live.foldersTotal ? ` — ${d.live.foldersDone}/${d.live.foldersTotal} folders · ${fmtNum(d.live.itemsDone)}/${fmtNum(d.live.itemsTotal)} emails` : '…'}
            </span>
          )}
          {report && (
            <span className={totals.missing === 0 ? 'chip ok' : 'chip bad'} title={`Last verification: ${fmtDateTime(report.at)}`}>
              {totals.missing === 0 ? 'Passed' : `Failed — ${fmtNum(totals.missing)} not backed up`}
            </span>
          )}
          <button className="btn small" onClick={onClose}>Close</button>
        </div>
      </div>

      <div className="detail-tabs">
        <button className={`detail-tab${tab === 'verify' ? ' active' : ''}`} onClick={() => setTab('verify')}>Verification</button>
        <button className={`detail-tab${tab === 'events' ? ' active' : ''}`} onClick={() => setTab('events')}>Events ({d.events.length})</button>
      </div>

      <div className="detail-tab-body">
      {tab === 'verify' && (
        <>
          {d.live && (
            <div className="detail-live">
              <div className="joblabel">
                <span className="kind">Backup in progress — {d.live.scope || 'starting'}</span>
                <span>{d.live.foldersDone || 0}/{d.live.foldersTotal || 0} folders · {fmtNum(d.live.itemsDone)}/{fmtNum(d.live.itemsTotal)} emails</span>
              </div>
              <div className="bar"><div className="fill" style={{ width: (d.live.itemsTotal ? Math.round(100 * d.live.itemsDone / d.live.itemsTotal) : 0) + '%' }} /></div>
              {d.live.currentFolder && <div className="muted mono">→ {d.live.currentFolder}</div>}
            </div>
          )}
          {folderCount > 0 && (
          <>
            <div className="detail-summary">
              <div className="ds-item"><span className="ds-n">{folderCount}</span><label>Folders</label></div>
              <div className="ds-item"><span className="ds-n">{fmtNum(totals.source)}</span><label>Source items</label></div>
              <div className="ds-item"><span className="ds-n">{fmtNum(totals.local)}</span><label>Backed up</label></div>
              <div className={`ds-item${totals.missing > 0 ? ' bad' : ''}`}><span className="ds-n">{fmtNum(totals.missing)}</span><label>Missing</label></div>
              <div className="ds-item"><span className="ds-n">{fmtNum(totals.onDisk)}</span><label>On disk</label></div>
            </div>

            {topErrors.length > 0 && (
              <div className="detail-errors">
                <b>Top reasons items are pending</b>
                {topErrors.map((e, i) => (
                  <div key={i} className="bad-text mono">{e.n || 0} × {String(e.lastError || '').slice(0, 140)}</div>
                ))}
              </div>
            )}

            <div className="detail-table-head">
              <h3>Folder structure</h3>
              <div className="detail-tree-controls">
                <label className="switch">
                  <input type="checkbox" checked={hideEmpty} onChange={e => setHideEmpty(e.target.checked)} />
                  <span className="switch-track"><span className="switch-thumb" /></span>
                  <span className="switch-label">Hide empty folders</span>
                </label>
                {missingFolders > 0 && (
                  <button className={`btn small${onlyMissing ? ' active' : ''}`} onClick={() => setOnlyMissing(v => !v)}>
                    {onlyMissing ? `Showing ${missingFolders} incomplete` : `Show incomplete only (${missingFolders})`}
                  </button>
                )}
              </div>
            </div>
            <div className="detail-tree-wrap">
              <FolderTreeView collection={collection} defaultExpandedValue={allBranchIds} />
              {onlyMissing && missingFolders === 0 && <p className="detail-empty">All folders fully backed up.</p>}
            </div>
          </>
          )}
          {!report && <p className="muted">No verification run yet — integrity stats appear after the first Verify run.</p>}
        </>
      )}

      {tab === 'events' && (
        <>
          <div className="detail-events-head">
            <span className="muted">{d.events.length} recent events · newest last</span>
            <button className="btn small" onClick={copyForAgent}>
              {copied ? '✓ Copied' : 'Copy logs for AI agent'}
            </button>
            <button className="btn small danger" disabled={clearing || !d.events.length} onClick={clearEvents}>
              {clearing ? 'Clearing…' : 'Clear events'}
            </button>
          </div>
          <div className="detail-events">
            {d.events.map(e => (
              <div key={e.id} className={`event-row ${e.level}`}>
                <span className="event-ts mono">{fmtDateTime(e.ts)}</span>
                <span className={`event-level ${e.level}`}>{e.level}</span>
                <span className="event-msg">{e.message}</span>
              </div>
            ))}
            {!d.events.length && <p className="detail-empty">No events recorded yet.</p>}
          </div>
        </>
      )}
      </div>
    </section>
  );
}
