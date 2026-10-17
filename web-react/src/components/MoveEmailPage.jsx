import React, { useState, useEffect, useRef, useCallback } from 'react';
import { api, post } from '../api.js';
import { fmtBytes, fmtTime, fmtDateTime } from '../format.js';
import { MailboxPicker } from './ComparePage.jsx';
import { CopyScopeTree } from './CopyWizard.jsx';
import ToolPageHeader from './ToolPageHeader.jsx';
import { ChevronRight, FolderOpen, FolderClosed } from 'lucide-react';

// Move email — mirrors CopyEmailPage but with MOVE semantics: the destination
// copy is uploaded & verified BEFORE the source is removed (local → backup
// graveyard, live → Deleted Items). Sources can be the local backup OR the
// live mailbox itself (live → live only).

// Single-select folder tree for the destination picker (live or local rows).
function buildTree(rows) {
  const byId = new Map(rows.map(r => [r.folderId, { ...r, children: [] }]));
  const roots = [];
  for (const n of byId.values()) {
    const p = n.parentId && byId.get(n.parentId);
    if (p) p.children.push(n); else roots.push(n);
  }
  const sortRec = ns => { ns.sort((a, b) => String(a.name).localeCompare(String(b.name))); ns.forEach(n => sortRec(n.children)); };
  sortRec(roots);
  return roots;
}

function DstTreeNode({ node, expanded, toggleExp, pickedId, onPick }) {
  const open = expanded.has(node.folderId);
  const hasKids = node.children.length > 0;
  const picked = pickedId === node.folderId;
  return (
    <>
      <div className={`tv-control tree-row${picked ? ' selected' : ''}`} role="treeitem"
        aria-expanded={hasKids ? open : undefined} aria-selected={picked}
        onClick={() => onPick(node)}>
        <span
          className={`tv-indicator${open ? ' open' : ''}${hasKids ? '' : ' leaf'}`}
          onClick={e => { e.stopPropagation(); if (hasKids) toggleExp(node.folderId); }}
        >{hasKids ? <ChevronRight size={14} /> : null}</span>
        <span className="tv-text copy-tree-label">
          {hasKids
            ? (open ? <FolderOpen size={15} className="tv-icon" /> : <FolderClosed size={15} className="tv-icon" />)
            : <FolderClosed size={14} className="tv-icon tv-leaf-icon" />}
          <span className="tree-name">{node.name || '(root)'}</span>
        </span>
      </div>
      {open && hasKids && (
        <div className="tv-branch-content tree-kids">
          {node.children.map(c => (
            <DstTreeNode key={c.folderId} node={c} expanded={expanded} toggleExp={toggleExp} pickedId={pickedId} onPick={onPick} />
          ))}
        </div>
      )}
    </>
  );
}

function DstTree({ rows, pickedId, onPick, flattenRoot, persistKey }) {
  const [expanded, setExpanded] = useState(() => {
    if (persistKey) {
      try {
        const a = JSON.parse(localStorage.getItem(persistKey) || 'null');
        if (Array.isArray(a)) return new Set(a);
      } catch { }
    }
    return new Set(rows.map(r => r.folderId));
  });
  useEffect(() => {
    if (!persistKey) return;
    try { localStorage.setItem(persistKey, JSON.stringify([...expanded])); } catch { }
  }, [persistKey, expanded]);
  const toggleExp = id => setExpanded(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  if (!rows.length) return <p className="settings-hint">No folders.</p>;
  let roots = buildTree(rows);
  if (flattenRoot) roots = roots.flatMap(r => r.name === 'Archive root' ? r.children : [r]);
  return (
    <div className="scope-tree">
      <div className="scope-head">
        <span className="muted">{rows.length} folder(s)</span>
        <span className="tree-all-btns">
          <button type="button" className="btn small" onClick={() => setExpanded(new Set(rows.map(r => r.folderId)))}>Expand all</button>
          <button type="button" className="btn small" onClick={() => setExpanded(new Set())}>Collapse all</button>
        </span>
      </div>
      <div className="tree">
        {roots.map(n => <DstTreeNode key={n.folderId} node={n} expanded={expanded} toggleExp={toggleExp} pickedId={pickedId} onPick={onPick} />)}
      </div>
    </div>
  );
}

// Collapsible source-scope panel (same as CopyEmailPage).
function SourceScopePanel({ upn, scopeKey, label, rows, flattenRoot, selected, onToggleSel, defaultOpen, emptyNote }) {
  const [open, setOpen] = useState(() => {
    try {
      const p = JSON.parse(localStorage.getItem(`moveemail.panels.${upn}`) || '{}');
      return p[scopeKey] != null ? !p[scopeKey] : defaultOpen;
    } catch { return defaultOpen; }
  });
  const toggle = () => setOpen(o => {
    try {
      const p = JSON.parse(localStorage.getItem(`moveemail.panels.${upn}`) || '{}');
      localStorage.setItem(`moveemail.panels.${upn}`, JSON.stringify({ ...p, [scopeKey]: o ? true : false }));
    } catch { }
    return !o;
  });
  const keys = rows.filter(r => r.backedUp > 0).map(r => r.scope + ':' + r.folderId);
  const picked = keys.filter(k => selected.has(k)).length;
  return (
    <div className={`copyemail-scope${open ? '' : ' collapsed'}`}>
      <div className="scope-head">
        <button type="button" className="btn small ghost" aria-expanded={open} onClick={toggle}>
          {open ? '▾' : '▸'} <b>{label}</b>
        </button>
        <span className="muted">{picked}/{keys.length} folders selected</span>
      </div>
      {open && (
        rows.length
          ? <CopyScopeTree label={null} rows={rows} flattenRoot={flattenRoot} selected={selected} onToggleSel={onToggleSel} onSetAll={onToggleSel} hideCount rootTotals
              persistKey={`moveemail.exp.${upn}.${scopeKey}`} />
          : <p className="settings-hint">{emptyNote}</p>
      )}
    </div>
  );
}

const loadSel = upn => {
  try { return new Set(JSON.parse(localStorage.getItem(`moveemail.sel.${upn}`) || '[]')); } catch { return new Set(); }
};
const loadDst = upn => {
  try {
    return JSON.parse(localStorage.getItem(`moveemail.dst.${upn}`) || 'null')
      || { target: 'live', dstUpn: upn, liveId: '', liveLabel: '', localScope: 'primary', localId: '', localLabel: '', newName: '' };
  } catch { return { target: 'live', dstUpn: upn, liveId: '', liveLabel: '', localScope: 'primary', localId: '', localLabel: '', newName: '' }; }
};
const loadSrcType = upn => {
  try { return localStorage.getItem(`moveemail.srctype.${upn}`) === 'live' ? 'live' : 'local'; } catch { return 'local'; }
};
const parseDetail = d => {
  if (!d) return null;
  if (typeof d === 'object') return d;
  try { return JSON.parse(d); } catch { return null; }
};

// Move session for the one active source mailbox. One move-email run at a
// time (server-enforced); a move never loses email — the destination copy is
// verified before the source is retired (graveyard / Deleted Items).
function MoveEmailSession({ upn, mailboxes, showShared, showGuests, runs, jobs }) {
  const [folders, setFolders] = useState(null);
  const [srcType, setSrcType] = useState(() => loadSrcType(upn));
  const [selected, setSelected] = useState(() => loadSel(upn));
  const [dst, setDst] = useState(() => loadDst(upn));
  const [liveFolders, setLiveFolders] = useState(null); // destination live tree (dstUpn)
  const [liveProg, setLiveProg] = useState(null);
  const [srcLiveFolders, setSrcLiveFolders] = useState(null); // source live tree (upn)
  const [srcLiveProg, setSrcLiveProg] = useState(null);
  const [dstFolders, setDstFolders] = useState(null);
  const [starting, setStarting] = useState(false);
  const [logs, setLogs] = useState([]);
  const [err, setErr] = useState(null);

  const run = runs.find(r => r.upn === upn) || null;
  const job = jobs.find(j => j.kind === 'move-email' && j.status === 'running') || null;
  const jobDetail = !run && job ? parseDetail(job.detail) : null;
  const running = !!(job || run);
  const history = jobs.filter(j => (j.kind === 'move-email' || j.kind === 'move-email-undo') && j.upn === upn).slice(0, 10);

  useEffect(() => {
    setFolders(null); setSelected(loadSel(upn)); setDst(loadDst(upn)); setSrcType(loadSrcType(upn)); setErr(null);
    api(`/api/mailbox/${encodeURIComponent(upn)}/folders`)
      .then(d => setFolders(d.folders || []))
      .catch(e => { setErr(e.message); setFolders([]); });
  }, [upn]);

  useEffect(() => {
    try { localStorage.setItem(`moveemail.sel.${upn}`, JSON.stringify([...selected])); } catch { }
  }, [upn, selected]);
  useEffect(() => {
    try { localStorage.setItem(`moveemail.dst.${upn}`, JSON.stringify(dst)); } catch { }
  }, [upn, dst]);
  useEffect(() => {
    try { localStorage.setItem(`moveemail.srctype.${upn}`, srcType); } catch { }
  }, [upn, srcType]);

  // Switching source type invalidates the picked folders (different key space).
  const changeSrcType = t => {
    setSrcType(t);
    setSelected(new Set());
    if (t === 'live') setDst(d => ({ ...d, target: 'live' }));
  };

  // Live folder tree loader (shared by source and destination pickers).
  const loadLiveTree = useCallback(async (forUpn, refresh, setTree, setProg) => {
    if (!forUpn) return;
    if (refresh) setProg({ running: true, found: 0, current: '' });
    try {
      const d = await api(`/api/live/${encodeURIComponent(forUpn)}/folders${refresh ? '?refresh=1' : ''}`);
      if (!d.folders) { setTree(null); return; }
      setTree(d.folders);
    } catch (e) {
      if (refresh) { setErr(e.message); setTree(null); }
    } finally {
      if (refresh) setProg(null);
    }
  }, []);
  // Poll folders/progress while a live walk runs; returns undefined (NOT null)
  // when idle — React effect cleanups must be a function or undefined.
  const pollProg = (prog, forUpn, setProg) => {
    if (!prog?.running || !forUpn) return undefined;
    const t = setInterval(() => {
      api(`/api/live/${encodeURIComponent(forUpn)}/folders/progress`)
        .then(p => setProg(prev => (p.running ? { ...p } : prev)))
        .catch(() => { });
    }, 700);
    return () => clearInterval(t);
  };

  // Destination live tree.
  useEffect(() => {
    setLiveFolders(null); setLiveProg(null);
    if (dst.target === 'live' && dst.dstUpn) loadLiveTree(dst.dstUpn, false, setLiveFolders, setLiveProg);
  }, [dst.target, dst.dstUpn]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => pollProg(liveProg, dst.dstUpn, setLiveProg), [liveProg?.running, dst.dstUpn]); // eslint-disable-line react-hooks/exhaustive-deps

  // Source live tree (only in live source mode).
  useEffect(() => {
    setSrcLiveFolders(null); setSrcLiveProg(null);
    if (srcType === 'live' && upn) loadLiveTree(upn, false, setSrcLiveFolders, setSrcLiveProg);
  }, [srcType, upn]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => pollProg(srcLiveProg, upn, setSrcLiveProg), [srcLiveProg?.running, upn]); // eslint-disable-line react-hooks/exhaustive-deps

  // Local destination folder tree (that mailbox's backed-up folders).
  useEffect(() => {
    setDstFolders(null);
    if (dst.target !== 'local' || !dst.dstUpn) return;
    api(`/api/mailbox/${encodeURIComponent(dst.dstUpn)}/folders`)
      .then(d => setDstFolders(d.folders || []))
      .catch(e => setErr(e.message));
  }, [dst.target, dst.dstUpn]);

  // Log tail: move-email lines only for this mailbox — kept after stop/finish.
  useEffect(() => {
    let t;
    const poll = () => {
      api(`/api/mailbox/${encodeURIComponent(upn)}`)
        .then(m => setLogs((m.events || []).filter(e => /move.?email/i.test(e.message || '')).slice(-12).reverse()))
        .catch(() => { });
      t = setTimeout(poll, 4000);
    };
    poll();
    return () => clearTimeout(t);
  }, [upn]);

  const toggleMany = (keys, add) => setSelected(s => { const n = new Set(s); keys.forEach(k => add ? n.add(k) : n.delete(k)); return n; });

  // Source rows in CopyScopeTree shape. Live folders are mapped to scope 'live'
  // with itemCount as the selectable count → keys are 'live:<folderId>'.
  const liveSrcRows = (srcLiveFolders || []).map(f => ({ ...f, scope: 'live', backedUp: f.itemCount || 0 }));
  const localSelectable = (folders || []).filter(f => f.backedUp > 0);
  const srcRows = srcType === 'live' ? liveSrcRows : localSelectable;
  const selRows = srcRows.filter(f => selected.has(f.scope + ':' + f.folderId));
  const selItems = selRows.reduce((a, f) => a + f.backedUp, 0);
  const selBytes = selRows.reduce((a, f) => a + (f.bytes || 0), 0);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [placement, setPlacement] = useState('folder'); // 'folder' | 'root'
  const [rootName, setRootName] = useState('');
  const [fullPath, setFullPath] = useState(true);

  // Resolve the current destination config into a POST body + human label;
  // null when incomplete.
  const dstBody = () => {
    if (dst.target === 'live') {
      if (!dst.liveId) return null;
      return { dstUpn: dst.dstUpn, dst: { folderId: dst.liveId }, label: `${dst.dstUpn} (live) → ${dst.liveLabel || dst.liveId}` };
    }
    if (dst.localId) return { dstUpn: dst.dstUpn, dst: { scope: dst.localScope, folderId: dst.localId }, label: `${dst.dstUpn} (${dst.localScope}) → ${dst.localLabel || dst.localId}` };
    if (dst.newName.trim()) return { dstUpn: dst.dstUpn, dst: { scope: dst.localScope, folderId: null, name: dst.newName.trim() }, label: `${dst.dstUpn} (${dst.localScope}) → new root folder "${dst.newName.trim()}"` };
    return null;
  };
  const dstCfg = dstBody();

  const folderAvail = dst.target === 'live' ? !!dst.liveId : !!dst.localId;
  const folderName = dst.target === 'live' ? (dst.liveLabel || dst.liveId) : (dst.localLabel || dst.localId);

  const startMove = (override) => {
    const cfg = override || dstCfg;
    if (!cfg || (!selected.size && !override)) return;
    const folderKeys = override && override.folderKeys ? override.folderKeys : [...selected];
    setStarting(true); setErr(null);
    post('/api/move-email', { srcUpn: upn, srcType, dstUpn: cfg.dstUpn, target: dst.target, folderKeys, dst: cfg.dst })
      .catch(e => setErr(e.message))
      .finally(() => setStarting(false));
  };

  const openConfirm = () => {
    setPlacement(folderAvail ? 'folder' : 'root');
    setRootName(dst.newName || '');
    setConfirmOpen(true);
  };
  const confirmMove = () => {
    const body = placement === 'folder'
      ? (dst.target === 'live' ? { folderId: dst.liveId } : { scope: dst.localScope, folderId: dst.localId })
      : (dst.target === 'live' ? { folderId: null } : { scope: dst.localScope, folderId: null, name: rootName.trim() });
    setStarting(true); setErr(null);
    post('/api/move-email', { srcUpn: upn, srcType, dstUpn: dst.dstUpn, target: dst.target, folderKeys: [...selected], dst: body, fullPath })
      .then(() => setConfirmOpen(false))
      .catch(e => setErr(e.message))
      .finally(() => setStarting(false));
  };
  const confirmValid = placement === 'folder'
    ? folderAvail
    : (dst.target === 'live' || !!rootName.trim());

  // Restart a history row: reuse its srcType/folderKeys/target/dstUpn; dst
  // falls back to the saved per-mailbox destination config.
  const restart = (j) => {
    const d = parseDetail(j.detail);
    if (!d || !d.folderKeys) { setErr('Cannot restart — job detail is missing'); return; }
    const cfg = dstCfg || (d.dstUpn && dst.dstUpn === d.dstUpn ? dstBody() : null);
    if (!cfg) { setErr('Pick a destination above to restart this run'); return; }
    setStarting(true); setErr(null);
    post('/api/move-email', {
      srcUpn: upn, srcType: d.srcType || 'local', dstUpn: cfg.dstUpn,
      target: (d.srcType === 'live') ? 'live' : dst.target,
      folderKeys: d.folderKeys, dst: cfg.dst
    })
      .catch(e => setErr(e.message))
      .finally(() => setStarting(false));
  };

  const stop = () => post('/api/stop/move-email', { upn }).catch(e => setErr(e.message));

  const retryFailed = (j) => post('/api/move-email/retry', { jobId: j.id }).catch(e => setErr(e.message));

  // Reverse a finished move run from its recorded per-item plan.
  const undoJob = (j) => {
    if (!window.confirm(`Undo this move: destination copies go to Deleted Items / graveyard, sources are restored. Recoverable at every step.\n\nUndo run #${j.id}?`)) return;
    post('/api/move-email/undo', { jobId: j.id }).catch(e => setErr(e.message));
  };

  return (
    <>
    <div className="settings-card" style={{ margin: 0 }}>
      <div className="settings-head">
        <h3 className="mono" style={{ fontSize: 14, wordBreak: 'break-all' }}>{upn}</h3>
      </div>
      {err && <p className="bad-text" style={{ padding: '0 18px' }}>{err}</p>}

      <div className="copyemail-row">
      <section className="settings-section">
        <h4>Source</h4>
        <div className="settings-row">
          <div className="theme-switch" role="group" aria-label="Source type">
            <button className={`theme-opt${srcType === 'local' ? ' active' : ''}`} aria-pressed={srcType === 'local'} onClick={() => changeSrcType('local')}>Local backup</button>
            <button className={`theme-opt${srcType === 'live' ? ' active' : ''}`} aria-pressed={srcType === 'live'} onClick={() => changeSrcType('live')}>Live mailbox</button>
          </div>
        </div>
        <p className="settings-hint">
          {selected.size
            ? <><b>{selected.size}</b> folder(s) selected · {selItems} item(s){selBytes ? ` · ${fmtBytes(selBytes)}` : ''}</>
            : srcType === 'live' ? 'Pick the live folders to move (subfolders are included).' : 'Pick the backed-up folders to move.'}
        </p>
        <div className="copy-folderlist copyemail-src">
          {srcType === 'local' && (
            <>
              {folders === null && <p className="settings-hint">Loading folders…</p>}
              {folders !== null && (
                <>
                  <SourceScopePanel upn={upn} scopeKey="primary" label="Primary" rows={folders.filter(f => f.scope !== 'archive')}
                    selected={selected} onToggleSel={toggleMany} defaultOpen
                    emptyNote="No primary backup folders yet — run a backup first." />
                  <SourceScopePanel upn={upn} scopeKey="archive" label="Archive" rows={folders.filter(f => f.scope === 'archive')} flattenRoot
                    selected={selected} onToggleSel={toggleMany}
                    emptyNote="No archive backup for this mailbox." />
                </>
              )}
            </>
          )}
          {srcType === 'live' && (
            <>
              <div className="settings-row" style={{ marginTop: 0 }}>
                <button className="btn small" disabled={!!srcLiveProg?.running} onClick={() => loadLiveTree(upn, true, setSrcLiveFolders, setSrcLiveProg)}
                  title="Walk the live mailbox to refresh the folder list">{srcLiveProg?.running ? `Walking… ${srcLiveProg.found || 0}` : '↻ Refresh'}</button>
              </div>
              {srcLiveProg?.running && (
                <div className="bar slim indet" style={{ margin: '0 0 8px' }}><div className="fill" /></div>
              )}
              {srcLiveFolders === null
                ? <p className="settings-hint">No saved folder tree — press ↻ Refresh to walk the live mailbox (can take a while).</p>
                : <SourceScopePanel upn={upn} scopeKey="live" label="Live mailbox" rows={liveSrcRows} selected={selected} onToggleSel={toggleMany} defaultOpen
                    emptyNote="No live folders." />}
            </>
          )}
        </div>
      </section>

      <section className="settings-section">
        <h4>Destination</h4>
        <div className="settings-row">
          <p className="settings-hint">
            Source folders are recreated under the destination (same-named folders are merged, never duplicated).
            Emails already at the destination are skipped — and their source copy is retired only on a verified match.
          </p>
          {srcType === 'local' && (
            <div className="theme-switch" role="group" aria-label="Move target">
              <button className={`theme-opt${dst.target === 'live' ? ' active' : ''}`} aria-pressed={dst.target === 'live'} onClick={() => setDst(d => ({ ...d, target: 'live' }))}>Live mailbox</button>
              <button className={`theme-opt${dst.target === 'local' ? ' active' : ''}`} aria-pressed={dst.target === 'local'} onClick={() => setDst(d => ({ ...d, target: 'local' }))}>Local backup</button>
            </div>
          )}
        </div>
        <div className="settings-row">
          <div className="settings-label">Destination mailbox</div>
          <MailboxPicker value={dst.dstUpn} onChange={v => setDst(d => ({ ...d, dstUpn: v, liveId: '', liveLabel: '', localId: '', localLabel: '' }))}
            mailboxes={mailboxes} showShared={showShared} showGuests={showGuests} placeholder="Search mailboxes…" />
        </div>

        {dst.target === 'live' && (
          <>
            <div className="settings-row">
              <p className="settings-hint">Pick the live folder the source folders are recreated under.</p>
              <button className="btn small" disabled={!!liveProg?.running} onClick={() => loadLiveTree(dst.dstUpn, true, setLiveFolders, setLiveProg)}
                title="Walk the live mailbox to refresh the folder list">{liveProg?.running ? `Walking… ${liveProg.found || 0}` : '↻ Refresh'}</button>
            </div>
            {liveProg?.running && (
              <div className="bar slim indet" style={{ margin: '0 0 8px' }}><div className="fill" /></div>
            )}
            <div className="copy-folderlist copyemail-dst">
              {liveFolders === null
                ? <p className="settings-hint">No saved folder tree — press ↻ Refresh to walk the live mailbox (can take a while).</p>
                : <DstTree key={`live:${dst.dstUpn}`} rows={liveFolders} pickedId={dst.liveId} persistKey={`moveemail.dexp.${dst.dstUpn}.live`}
                    onPick={n => setDst(d => ({ ...d, liveId: n.folderId, liveLabel: n.path || n.name }))} />}
            </div>
          </>
        )}

        {dst.target === 'local' && (
          <>
            <div className="settings-row">
              <div className="settings-label">Scope</div>
              <div className="theme-switch" role="group" aria-label="Destination scope">
                <button className={`theme-opt${dst.localScope === 'primary' ? ' active' : ''}`} aria-pressed={dst.localScope === 'primary'} onClick={() => setDst(d => ({ ...d, localScope: 'primary', localId: '', localLabel: '' }))}>Primary</button>
                <button className={`theme-opt${dst.localScope === 'archive' ? ' active' : ''}`} aria-pressed={dst.localScope === 'archive'} onClick={() => setDst(d => ({ ...d, localScope: 'archive', localId: '', localLabel: '' }))}>Archive</button>
              </div>
            </div>
            <div className="copy-folderlist copyemail-dst">
              {dstFolders === null
                ? <p className="settings-hint">Loading folders…</p>
                : <DstTree key={`local:${dst.dstUpn}:${dst.localScope}`} rows={dstFolders.filter(f => f.scope === dst.localScope)} pickedId={dst.localId} flattenRoot={dst.localScope === 'archive'}
                    persistKey={`moveemail.dexp.${dst.dstUpn}.${dst.localScope}`}
                    onPick={n => setDst(d => ({ ...d, localId: n.folderId, localLabel: n.path || n.name, newName: '' }))} />}
            </div>
            <div className="settings-row">
              <div>
                <div className="settings-label">…or new folder at root</div>
                <p className="settings-hint">Typing a name here overrides the folder picked above.</p>
              </div>
              <input className="confirm-input" style={{ maxWidth: 220 }} value={dst.newName}
                placeholder="New folder name" aria-label="New root folder name"
                onChange={e => setDst(d => ({ ...d, newName: e.target.value, localId: e.target.value ? '' : d.localId, localLabel: e.target.value ? '' : d.localLabel }))} />
            </div>
          </>
        )}
      </section>
      </div>

      <section className="settings-section">
        <h4>Move</h4>
        {running ? (
          <div className="compare-prog" style={{ margin: '0 0 12px' }}>
            <div className="compare-prog-main">
              <div className="compare-prog-head">
                <b>{run ? `Moving folders ${run.foldersDone} / ${run.foldersTotal}` : 'Move running…'}</b>
                {run && run.foldersTotal > 0 && <span className="muted">{Math.round(run.foldersDone / run.foldersTotal * 100)}%</span>}
              </div>
              {run && (
                <div className="compare-prog-route muted">
                  <span title={`${run.dstUpn} · ${run.dstLabel}${run.currentDest ? ' · ' + run.currentDest : ''}`}>
                    → {run.dstUpn} ({run.target}){run.dstLabel ? ` · ${run.dstLabel}` : ''}{run.currentDest ? ` · ${run.currentDest}` : ''}
                  </span>
                </div>
              )}
              {!run && jobDetail && (
                <div className="compare-prog-route muted">
                  <span>→ {jobDetail.dstUpn} ({jobDetail.target}){jobDetail.dstLabel ? ` · ${jobDetail.dstLabel}` : ''}</span>
                </div>
              )}
              {run && run.currentFolder && (
                <div className="compare-prog-route muted"><span title={run.currentFolder}>from: {run.currentFolder}</span></div>
              )}
            </div>
            <div className={`bar slim${run && run.itemsTotal ? '' : ' indet'}`}>
              <div className="fill" style={run && run.itemsTotal ? { width: `${Math.min(100, Math.round((run.itemsDone || 0) / run.itemsTotal * 100))}%` } : undefined} />
            </div>
            <div className="compare-prog-stats">
              {run && <span className="muted">{run.itemsDone || 0} / {run.itemsTotal} item(s)</span>}
              {run && run.bytesTotal > 0 && <span className="muted">{fmtBytes(run.bytesDone || 0)} / {fmtBytes(run.bytesTotal)}</span>}
              {run && <span className="muted">{run.done} moved · {run.skipped} skipped · {run.failed} failed</span>}
              <button className="btn small danger" onClick={stop}>Stop</button>
            </div>
          </div>
        ) : (
          <div className="settings-row">
            <p className="settings-hint">
              {dstCfg
                ? <>Move {selItems} item(s){selBytes ? ` (${fmtBytes(selBytes)})` : ''} to <b>{dstCfg.label}</b>. The source is removed only after the destination copy is verified.</>
                : <>Move {selItems} item(s){selBytes ? ` (${fmtBytes(selBytes)})` : ''} to <b>{dst.dstUpn} ({dst.target === 'live' ? 'live' : 'local'})</b> — pick the exact placement in the next step. The source is removed only after the destination copy is verified.</>}
            </p>
            <button className="btn danger" disabled={starting || !selected.size} onClick={openConfirm}>
              {starting ? 'Starting…' : 'Move'}
            </button>
          </div>
        )}
        {!running && (() => {
          const fj = history.find(j => {
            const d = parseDetail(j.detail);
            return (d?.failed || 0) > 0 && ['done', 'stopped', 'error', 'interrupted'].includes(j.status);
          });
          if (!fj) return null;
          const d = parseDetail(fj.detail);
          return (
            <div className="settings-row">
              <p className="settings-hint">Last run had <b>{d.failed} failed</b> item(s).</p>
              <button className="btn small" disabled={starting}
                title={`Re-check/move the ${d.failed} failed item(s)${Array.isArray(d.failedKeys) && d.failedKeys.length ? '' : ' (no failed items recorded on this run)'}`}
                onClick={() => retryFailed(fj)}>Retry {d.failed} failed</button>
            </div>
          );
        })()}
      </section>

      <section className="settings-section">
        <h4>Log</h4>
        {logs.length === 0 ? (
          <p className="settings-hint">No move activity yet.</p>
        ) : (
          <div className="copy-folderlist">
            {logs.map((e, i) => (
              <div key={i} className="copy-folder">
                <span className="copy-folder-path">
                  <span className="muted">{fmtTime(e.ts)}</span> {e.message}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
    <MoveTasksPanel upn={upn} run={run} history={history} starting={starting} running={running}
      onStop={stop} onRestart={restart} onRetry={retryFailed} onUndo={undoJob} />
    {confirmOpen && (
      <div className="modal-backdrop" onClick={() => setConfirmOpen(false)}>
        <div className="modal-card settings-card copyemail-confirm" role="dialog" aria-modal="true" aria-label="Confirm move" onClick={e => e.stopPropagation()}>
          <div className="settings-head">
            <h3>Confirm move</h3>
            <button className="log-iconbtn" title="Cancel" aria-label="Cancel" onClick={() => setConfirmOpen(false)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12" /></svg>
            </button>
          </div>
          <section className="settings-section">
            <p className="settings-hint" style={{ fontSize: 13 }}>
              <b>MOVE</b> {selItems} item(s){selBytes ? ` (${fmtBytes(selBytes)})` : ''} from <b className="mono">{upn}</b> ({srcType === 'live' ? 'live mailbox' : 'local backup'}) to <b className="mono">{dst.dstUpn}</b> ({dst.target === 'live' ? 'live mailbox' : `local backup, ${dst.localScope}`}).
              Source folders are recreated at the destination; emails already there are skipped.
            </p>
            <p className="settings-hint" style={{ fontSize: 13 }}>
              Safety: items are uploaded &amp; verified at the destination <b>before</b> the source is removed.
              Live sources go to Deleted Items (recoverable), local primary sources go to the backup graveyard, and local <b>archive</b> sources are always kept (archive moves act as copies) — email is never lost.
            </p>
            <div className="copy-folderlist" style={{ maxHeight: 'none' }}>
              {folderAvail && (
                <label className="copy-folder dedupe-group" style={{ cursor: 'pointer' }}>
                  <input type="radio" name="moveemail-placement" checked={placement === 'folder'} onChange={() => setPlacement('folder')} />
                  <span className="copy-folder-path">Into folder: <b>{folderName}</b></span>
                </label>
              )}
              <label className="copy-folder dedupe-group" style={{ cursor: 'pointer' }}>
                <input type="radio" name="moveemail-placement" checked={placement === 'root'} onChange={() => setPlacement('root')} />
                <span className="copy-folder-path">{dst.target === 'live' ? 'Mailbox root' : 'New folder at root'}</span>
              </label>
              {placement === 'root' && dst.target === 'local' && (
                <div style={{ padding: '4px 8px 8px 30px' }}>
                  <input className="confirm-input" style={{ maxWidth: 260 }} value={rootName} autoFocus
                    placeholder="New folder name" aria-label="New root folder name"
                    onChange={e => setRootName(e.target.value)} />
                </div>
              )}
            </div>
            {!folderAvail && dst.target === 'live' && (
              <p className="settings-hint">No destination folder picked — the source folders will be created at the mailbox root.</p>
            )}
            {srcType === 'live' && dst.target === 'live' && placement === 'root' && (
              <label className="settings-hint" style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
                <input type="checkbox" checked={fullPath} onChange={e => setFullPath(e.target.checked)} />
                Recreate the full source folder path (e.g. <i>parent/project</i>) instead of dropping the picked folders straight onto the root
              </label>
            )}
          </section>
          <div className="confirm-actions" style={{ padding: '0 18px 16px' }}>
            <button className="btn" onClick={() => setConfirmOpen(false)}>Cancel</button>
            <button className="btn danger" disabled={starting || !confirmValid} onClick={confirmMove}>
              {starting ? 'Starting…' : 'Start move'}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}

// Floating right panel with the mailbox's move-email runs (running one on top
// with live progress + Stop, history below with Restart).
function MoveTasksPanel({ upn, run, history, starting, running, onStop, onRestart, onRetry, onUndo }) {
  const runDetail = parseDetail((history.find(j => j.status === 'running') || {}).detail);
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem('moveemail.tasksCollapsed') !== '1'; } catch { return false; }
  });
  const togglePanel = v => {
    setOpen(v);
    try { localStorage.setItem('moveemail.tasksCollapsed', v ? '0' : '1'); } catch { }
  };
  if (!open) {
    return (
      <button className="log-rail" title="Show move tasks" aria-label="Show move tasks" onClick={() => togglePanel(true)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
        <span className="log-rail-label">Move tasks</span>
        {(running || history.length > 0) && <span className="log-rail-count">{running ? '●' : history.length > 99 ? '99+' : history.length}</span>}
      </button>
    );
  }
  return (
    <aside className="logs log-sidebar mailbox-log copyemail-tasks" aria-label={`Move tasks for ${upn}`}>
      <div className="log-head">
        <button className="log-iconbtn" title="Collapse move tasks" aria-label="Collapse move tasks" onClick={() => togglePanel(false)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6" /></svg>
        </button>
        <span className="log-title">Move tasks — {upn}</span>
        {running && <span className="live"><span className="dot" /> live</span>}
      </div>
      <div className="logbox">
        {run && (
          <div className="compare-prog" style={{ margin: '4px 0 10px' }}>
            <div className="compare-prog-main">
              <div className="compare-prog-head">
                <b>Moving folders {run.foldersDone} / {run.foldersTotal}</b>
                {run.foldersTotal > 0 && <span className="muted">{Math.round(run.foldersDone / run.foldersTotal * 100)}%</span>}
              </div>
              <div className="compare-prog-route muted">
                <span title={`${run.dstUpn} · ${run.dstLabel || runDetail?.dstLabel || ''}${run.currentDest ? ' · ' + run.currentDest : ''}`}>
                  → {run.dstUpn}{run.target ? ` (${run.target})` : ''}{(run.dstLabel || runDetail?.dstLabel) ? ` · ${run.dstLabel || runDetail?.dstLabel}` : ''}{run.currentDest ? ` · ${run.currentDest}` : ''}
                </span>
              </div>
              {run.currentFolder && (
                <div className="compare-prog-route muted"><span title={run.currentFolder}>from: {run.currentFolder}</span></div>
              )}
            </div>
            <div className={`bar slim${run.itemsTotal ? '' : ' indet'}`}>
              <div className="fill" style={run.itemsTotal ? { width: `${Math.min(100, Math.round((run.itemsDone || 0) / run.itemsTotal * 100))}%` } : undefined} />
            </div>
            <div className="compare-prog-stats">
              <span className="muted">{run.itemsDone || 0} / {run.itemsTotal} item(s)</span>
              {run.bytesTotal > 0 && <span className="muted">{fmtBytes(run.bytesDone || 0)} / {fmtBytes(run.bytesTotal)}</span>}
              <span className="muted">{run.done} moved · {run.skipped} skipped · {run.failed} failed{run.failed > 0 ? ' (retried automatically; re-check via “Retry failed” after the run)' : ''}</span>
              <button className="btn small danger" onClick={onStop}>Stop</button>
            </div>
          </div>
        )}
        {!history.length && !run && <div className="log-empty">No move runs for this mailbox yet.</div>}
        {history.map(j => {
          const d = parseDetail(j.detail);
          const isUndo = j.kind === 'move-email-undo';
          return (
            <div key={j.id} className="copy-folder dedupe-group">
              <span className="copy-folder-path">
                <span className="muted" title={fmtDateTime(j.startedAt)}>{fmtTime(j.startedAt)}</span>{' '}
                <b>{isUndo ? 'Undo move' : (d && d.target === 'local' ? 'Move to local' : 'Move to live')}</b>{' '}
                <span className={j.status === 'done' ? 'good-text' : j.status === 'running' ? 'muted' : 'bad-text'}>{j.status}</span>
                {j.total ? <span className="muted"> · {j.done || 0}/{j.total}</span> : ''}
                {isUndo && d && (
                  <span className="dedupe-loc">
                    of run #{d.undoOf} · {d.restored || 0} restored, {d.cleaned || 0} destination copies removed, {d.failed || 0} failed
                    {j.finishedAt ? ` · finished ${fmtDateTime(j.finishedAt)}` : ''}
                  </span>
                )}
                {!isUndo && d && (
                  <span className="dedupe-loc">
                    {d.srcType === 'live' ? '(live source) ' : ''}→ {d.dstLabel || d.dstUpn || ''} · {d.done || 0} moved{d.bytesTotal ? ` (${fmtBytes(d.bytesCopied || 0)})` : ''}, {d.skipped || 0} skipped, {d.failed || 0} failed
                    {j.finishedAt ? ` · finished ${fmtDateTime(j.finishedAt)}` : ''}
                  </span>
                )}
              </span>
              <span style={{ flex: '0 0 auto', display: 'flex', gap: 6 }}>
                {j.status === 'running' && !isUndo && <button className="btn small danger" onClick={onStop}>Stop</button>}
                {!isUndo && ['done', 'stopped', 'error', 'interrupted'].includes(j.status) && (
                  <button className="btn small" disabled={starting || running}
                    title="Reverse this move: destination copies go to Deleted Items / graveyard, sources are restored"
                    onClick={() => onUndo(j)}>↩ Undo</button>
                )}
                {!isUndo && d && (d.failed || 0) > 0 && (j.status === 'done' || j.status === 'stopped' || j.status === 'error' || j.status === 'interrupted') && (
                  <button className="btn small" disabled={starting || running}
                    title={`Re-check/move the ${d.failed} failed item(s)${Array.isArray(d.failedKeys) && d.failedKeys.length ? '' : ' (no failed items recorded on this run)'}`}
                    onClick={() => onRetry(j)}>Retry {d.failed} failed</button>
                )}
                {!isUndo && (j.status === 'stopped' || j.status === 'error' || j.status === 'interrupted') && (
                  <button className="btn small" disabled={starting || running}
                    title="Restart — already-moved items are skipped"
                    onClick={() => onRestart(j)}>Restart</button>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

export default function MoveEmailPage() {
  const [mailboxes, setMailboxes] = useState([]);
  const [upn, setUpn] = useState(() => {
    try { return localStorage.getItem('moveemail.upn') || ''; } catch { return ''; }
  });
  const [showShared, setShowShared] = useState(false);
  const [showGuests, setShowGuests] = useState(false);
  const [runs, setRuns] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [err, setErr] = useState(null);

  useEffect(() => {
    document.title = 'M365Sphere — Move email';
    api('/api/mailboxes').then(setMailboxes).catch(e => setErr(e.message));
    return () => { document.title = 'M365Sphere'; };
  }, []);

  useEffect(() => {
    try { localStorage.setItem('moveemail.upn', upn); } catch { }
  }, [upn]);

  // One shared status poll.
  useEffect(() => {
    let t;
    const poll = () => {
      api('/api/status').then(s => {
        setRuns(s.moveEmailRuns || []);
        setJobs(s.jobs || []);
        // Nothing picked yet but a move is running (e.g. started via API) — jump to its source mailbox.
        if (s.moveEmailRuns && s.moveEmailRuns.length) setUpn(v => v || s.moveEmailRuns[0].upn);
        t = setTimeout(poll, s.moveEmailRunning ? 2000 : 10000);
      }).catch(() => { t = setTimeout(poll, 5000); });
    };
    poll();
    return () => clearTimeout(t);
  }, []);

  const resetAll = () => {
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith('moveemail.')) localStorage.removeItem(k);
    } catch { }
    setUpn(''); setErr(null);
  };

  return (
    <div className="mailbox-page copyemail-page">
      <ToolPageHeader active="moveemail" title="Move email" actions={<>
        <button className="btn small" title="Clear the mailbox choice and all saved selections/destinations (they are remembered across refreshes otherwise)" onClick={resetAll}>Reset</button>
        <a className="btn small" href="/">← Back</a>
      </>}>
        <label className="muted">Source mailbox
          <MailboxPicker value={upn} onChange={setUpn}
            mailboxes={mailboxes} showShared={showShared} showGuests={showGuests}
            placeholder="Search mailboxes…" /></label>
        <span className="muted compare-type-toggles" title="Mailbox types to include in search results (licensed users are always listed)">
          Include:
          <label><input type="checkbox" checked={showShared} onChange={e => setShowShared(e.target.checked)} /> shared</label>
          <label><input type="checkbox" checked={showGuests} onChange={e => setShowGuests(e.target.checked)} /> guests</label>
        </span>
      </ToolPageHeader>
      {err && <p className="bad-text">{err}</p>}

      {!upn ? (
        <p className="muted" style={{ padding: '0 18px' }}>Pick a source mailbox above — one mailbox is moved at a time; selections are remembered per mailbox.</p>
      ) : (
        <MoveEmailSession key={upn} upn={upn} mailboxes={mailboxes} showShared={showShared} showGuests={showGuests}
          runs={runs} jobs={jobs} />
      )}
    </div>
  );
}
