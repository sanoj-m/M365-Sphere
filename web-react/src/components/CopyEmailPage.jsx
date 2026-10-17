import React, { useState, useEffect, useRef, useCallback } from 'react';
import { api, post, del } from '../api.js';
import { fmtBytes, fmtTime, fmtDate, fmtDateTime } from '../format.js';
import { MailboxPicker } from './ComparePage.jsx';
import { CopyScopeTree } from './CopyWizard.jsx';
import ToolPageHeader from './ToolPageHeader.jsx';
import { ChevronRight, FolderOpen, FolderClosed } from 'lucide-react';

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

// Single-select destination tree — same visual design as the source tree
// (folder icons, ▸/▾ arrows, row hover, indent guides), but one picked folder.
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
  // Same as the source tree: drop the synthetic "Archive root" wrapper node.
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

// Collapsible source-scope panel: header with scope name + selected/total
// folders count; the CopyScopeTree inside brings its own expand/collapse-all.
// Collapse state persists per mailbox (copyemail.panels.<upn>) until Reset.
function SourceScopePanel({ upn, scopeKey, label, rows, flattenRoot, selected, onToggleSel, defaultOpen, emptyNote, onFocusFolder, focusId }) {
  const [open, setOpen] = useState(() => {
    try {
      const p = JSON.parse(localStorage.getItem(`copyemail.panels.${upn}`) || '{}');
      return p[scopeKey] != null ? !p[scopeKey] : defaultOpen;
    } catch { return defaultOpen; }
  });
  const toggle = () => setOpen(o => {
    try {
      const p = JSON.parse(localStorage.getItem(`copyemail.panels.${upn}`) || '{}');
      localStorage.setItem(`copyemail.panels.${upn}`, JSON.stringify({ ...p, [scopeKey]: o ? true : false }));
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
          ? <CopyScopeTree label={null} rows={rows} flattenRoot={flattenRoot} selected={selected} onToggleSel={onToggleSel} onSetAll={onToggleSel} hideCount rootTotals subOnlyAction
              persistKey={`copyemail.exp.${upn}.${scopeKey}`} onFocusFolder={onFocusFolder} focusId={focusId} />
          : <p className="settings-hint">{emptyNote}</p>
      )}
    </div>
  );
}

const loadSel = upn => {
  try { return new Set(JSON.parse(localStorage.getItem(`copyemail.sel.${upn}`) || '[]')); } catch { return new Set(); }
};
const loadPicks = upn => {
  try { return new Set(JSON.parse(localStorage.getItem(`copyemail.items.${upn}`) || '[]')); } catch { return new Set(); }
};
const loadKey = (k, d = []) => {
  try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; }
};
const loadDst = upn => {
  try {
    return JSON.parse(localStorage.getItem(`copyemail.dst.${upn}`) || 'null')
      || { target: 'live', dstUpn: upn, liveId: '', liveLabel: '', localScope: 'primary', localId: '', localLabel: '', newName: '' };
  } catch { return { target: 'live', dstUpn: upn, liveId: '', liveLabel: '', localScope: 'primary', localId: '', localLabel: '', newName: '' }; }
};
const parseDetail = d => {
  if (!d) return null;
  if (typeof d === 'object') return d;
  try { return JSON.parse(d); } catch { return null; }
};

// Copy session for the one active source mailbox. Copy-only: the source
// backup is never modified; one copy-email run at a time (server-enforced).
function CopyEmailSession({ upn, mailboxes, showShared, showGuests, runs, jobs, histJobs, queue }) {
  const [folders, setFolders] = useState(null);
  const [selected, setSelected] = useState(() => loadSel(upn));
  const [dst, setDst] = useState(() => loadDst(upn));
  const [liveFolders, setLiveFolders] = useState(null);
  const [liveProg, setLiveProg] = useState(null);
  const [dstFolders, setDstFolders] = useState(null);
  const [starting, setStarting] = useState(false);
  const [logs, setLogs] = useState([]);
  const [err, setErr] = useState(null);
  // Item-level picking: click a folder name in the source tree to load its
  // emails; ticks accumulate across folders (copyemail.items.<upn>).
  const [focusFolder, setFocusFolder] = useState(null);
  const [folderItems, setFolderItems] = useState(null);
  const [picks, setPicks] = useState(() => loadPicks(upn));
  // Live source mode: tree from /api/live/:upn/folders, own selection + picks.
  const [srcMode, setSrcMode] = useState(() => {
    try { return localStorage.getItem(`copyemail.srcmode.${upn}`) === 'live' ? 'live' : 'store'; } catch { return 'store'; }
  });
  const [srcLiveFolders, setSrcLiveFolders] = useState(null);
  const [srcLiveProg, setSrcLiveProg] = useState(null);
  const [selLive, setSelLive] = useState(() => new Set(loadKey(`copyemail.sellive.${upn}`)));
  const [livePicks, setLivePicks] = useState(() => new Set(loadKey(`copyemail.itemslive.${upn}`)));

  const run = runs.find(r => r.upn === upn) || null;
  const job = jobs.find(j => j.kind === 'copy-email' && j.status === 'running') || null;
  const jobDetail = !run && job ? parseDetail(job.detail) : null;
  const running = !!(job || run);
  const history = (histJobs || []).filter(j => j.upn === upn).slice(0, 10);

  useEffect(() => {
    setFolders(null); setSelected(loadSel(upn)); setDst(loadDst(upn)); setErr(null);
    setFocusFolder(null); setFolderItems(null); setPicks(loadPicks(upn));
    setSrcMode(localStorage.getItem(`copyemail.srcmode.${upn}`) === 'live' ? 'live' : 'store');
    setSelLive(new Set(loadKey(`copyemail.sellive.${upn}`)));
    setLivePicks(new Set(loadKey(`copyemail.itemslive.${upn}`)));
    setSrcLiveFolders(null); setSrcLiveProg(null);
    api(`/api/mailbox/${encodeURIComponent(upn)}/folders`)
      .then(d => setFolders(d.folders || []))
      .catch(e => { setErr(e.message); setFolders([]); });
  }, [upn]);

  useEffect(() => {
    try { localStorage.setItem(`copyemail.sel.${upn}`, JSON.stringify([...selected])); } catch { }
  }, [upn, selected]);
  useEffect(() => {
    try { localStorage.setItem(`copyemail.items.${upn}`, JSON.stringify([...picks])); } catch { }
  }, [upn, picks]);
  useEffect(() => {
    try { localStorage.setItem(`copyemail.srcmode.${upn}`, srcMode); } catch { }
  }, [upn, srcMode]);
  useEffect(() => {
    try { localStorage.setItem(`copyemail.sellive.${upn}`, JSON.stringify([...selLive])); } catch { }
  }, [upn, selLive]);
  useEffect(() => {
    try { localStorage.setItem(`copyemail.itemslive.${upn}`, JSON.stringify([...livePicks])); } catch { }
  }, [upn, livePicks]);

  // Live SOURCE folder tree: plain GET serves the saved tree (no walk);
  // Refresh walks the mailbox (?refresh=1) and we poll folders/progress.
  const loadSrcLiveFolders = useCallback(async (refresh) => {
    if (refresh) setSrcLiveProg({ running: true, found: 0, current: '' });
    try {
      const d = await api(`/api/live/${encodeURIComponent(upn)}/folders${refresh ? '?refresh=1' : ''}`);
      if (!d.folders) { setSrcLiveFolders(null); return; }
      setSrcLiveFolders(d.folders);
    } catch (e) {
      if (refresh) { setErr(e.message); setSrcLiveFolders(null); }
    } finally {
      if (refresh) setSrcLiveProg(null);
    }
  }, [upn]);
  useEffect(() => {
    setSrcLiveFolders(null); setSrcLiveProg(null);
    if (srcMode === 'live') loadSrcLiveFolders(false);
  }, [srcMode, upn]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!srcLiveProg?.running) return;
    const t = setInterval(() => {
      api(`/api/live/${encodeURIComponent(upn)}/folders/progress`)
        .then(p => setSrcLiveProg(prev => (p.running ? { ...p } : prev)))
        .catch(() => { });
    }, 700);
    return () => clearInterval(t);
  }, [srcLiveProg?.running, upn]);

  // Open a source folder's emails in the picker column (does not touch the
  // checkbox selection — that's still the folder copy granularity).
  const focusOn = useCallback((node) => {
    setFocusFolder(node); setFolderItems(null);
    const url = srcMode === 'live'
      ? `/api/live/${encodeURIComponent(upn)}/items?folderId=${encodeURIComponent(node.folderId)}`
      : `/api/mailbox/${encodeURIComponent(upn)}/items?scope=${encodeURIComponent(node.scope)}&folderId=${encodeURIComponent(node.folderId)}&limit=500`;
    api(url)
      .then(d => setFolderItems(d.items || []))
      .catch(e => { setErr(e.message); setFolderItems([]); });
  }, [upn, srcMode]);

  const itemKey = it => `${focusFolder.scope}:${focusFolder.folderId}:${it.itemId || it.id}`;
  const togglePick = (key, on) => setActivePicks(s => { const n = new Set(s); on ? n.add(key) : n.delete(key); return n; });
  useEffect(() => {
    try { localStorage.setItem(`copyemail.dst.${upn}`, JSON.stringify(dst)); } catch { }
  }, [upn, dst]);

  // Live destination folder tree: plain GET serves the saved tree (no walk);
  // Refresh walks the mailbox (?refresh=1) and we poll folders/progress.
  const loadLiveFolders = useCallback(async (refresh) => {
    if (!dst.dstUpn) return;
    if (refresh) setLiveProg({ running: true, found: 0, current: '' });
    try {
      const d = await api(`/api/live/${encodeURIComponent(dst.dstUpn)}/folders${refresh ? '?refresh=1' : ''}`);
      if (!d.folders) { setLiveFolders(null); return; }
      setLiveFolders(d.folders);
    } catch (e) {
      if (refresh) { setErr(e.message); setLiveFolders(null); }
    } finally {
      if (refresh) setLiveProg(null);
    }
  }, [dst.dstUpn]);
  useEffect(() => {
    setLiveFolders(null); setLiveProg(null);
    if (dst.target === 'live' && dst.dstUpn) loadLiveFolders(false);
  }, [dst.target, dst.dstUpn]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!liveProg?.running || !dst.dstUpn) return;
    const t = setInterval(() => {
      api(`/api/live/${encodeURIComponent(dst.dstUpn)}/folders/progress`)
        .then(p => setLiveProg(prev => (p.running ? { ...p } : prev)))
        .catch(() => { });
    }, 700);
    return () => clearInterval(t);
  }, [liveProg?.running, dst.dstUpn]);

  // Local destination folder tree (that mailbox's backed-up folders).
  useEffect(() => {
    setDstFolders(null);
    if (dst.target !== 'local' || !dst.dstUpn) return;
    api(`/api/mailbox/${encodeURIComponent(dst.dstUpn)}/folders`)
      .then(d => setDstFolders(d.folders || []))
      .catch(e => setErr(e.message));
  }, [dst.target, dst.dstUpn]);

  // Log tail: copy-email lines only for this mailbox — kept after stop/finish.
  useEffect(() => {
    let t;
    const poll = () => {
      api(`/api/mailbox/${encodeURIComponent(upn)}`)
        .then(m => setLogs((m.events || []).filter(e => /copy.?email/i.test(e.message || '')).slice(-12).reverse()))
        .catch(() => { });
      t = setTimeout(poll, 4000);
    };
    poll();
    return () => clearTimeout(t);
  }, [upn]);

  const toggleMany = (keys, add) => setSelected(s => { const n = new Set(s); keys.forEach(k => add ? n.add(k) : n.delete(k)); return n; });
  const toggleManyLive = (keys, add) => setSelLive(s => { const n = new Set(s); keys.forEach(k => add ? n.add(k) : n.delete(k)); return n; });

  const selectable = (folders || []).filter(f => f.backedUp > 0);
  const selRows = selectable.filter(f => selected.has(f.scope + ':' + f.folderId));

  // Live source: tree rows mapped to the CopyScopeTree shape. Selection keys
  // are 'live:<folderId>'.
  const liveRows = (srcLiveFolders || []).map(f => ({
    scope: 'live', folderId: f.folderId, parentId: f.parentId || null,
    name: f.name, path: f.path, backedUp: f.itemCount || 0, bytes: 0
  }));
  const liveSelRows = liveRows.filter(f => selLive.has('live:' + f.folderId));
  const liveMode = srcMode === 'live';
  const activeSelSize = liveMode ? selLive.size : selected.size;
  const activePicks = liveMode ? livePicks : picks;
  const setActivePicks = liveMode ? setLivePicks : setPicks;

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [placement, setPlacement] = useState('folder'); // 'folder' | 'root'
  const [copyMode, setCopyMode] = useState('folders'); // 'folders' | 'items'
  const [rootName, setRootName] = useState('');
  const [note, setNote] = useState(null); // transient info line (e.g. queue position)

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

  // Confirm-dialog folder list: every checked folder, sorted by path. Store
  // mode sums whole subtrees of the topmost picks (the engine copies each
  // picked folder WITH its descendants); live mode has no byte sizes.
  const folderByKey = new Map((folders || []).map(f => [f.scope + ':' + f.folderId, f]));
  const liveByKey = new Map(liveRows.map(f => ['live:' + f.folderId, f]));
  const topSelRows = (liveMode ? [...liveSelRows] : [...selRows]).sort((a, b) => String(a.path).localeCompare(String(b.path)));
  // Store-mode summary counts whole subtrees of the topmost picks (the engine
  // copies each picked folder WITH its descendants); live mode has no byte sizes.
  const topmostSelRows = liveMode ? topSelRows : selRows.filter(f => {
    const p = f.parentId && folderByKey.get(f.scope + ':' + f.parentId);
    return !(p && selected.has(p.scope + ':' + p.folderId));
  });
  const kidsOf = new Map();
  if (!liveMode) {
    for (const f of folders || []) {
      if (!f.parentId) continue;
      const k = f.scope + ':' + f.parentId;
      if (!kidsOf.has(k)) kidsOf.set(k, []);
      kidsOf.get(k).push(f);
    }
  }
  let selItems = 0, selBytes = 0;
  if (liveMode) {
    for (const f of liveSelRows) selItems += f.backedUp || 0;
  } else {
    for (const top of topmostSelRows) {
      const stack = [top];
      while (stack.length) {
        const f = stack.pop();
        selItems += f.backedUp || 0;
        selBytes += f.bytes || 0;
        for (const c of kidsOf.get(f.scope + ':' + f.folderId) || []) stack.push(c);
      }
    }
  }
  // Item-level mode: group the picks by their folder (path + count).
  const pickGroups = [];
  if (activePicks.size) {
    const m = new Map();
    for (const k of activePicks) {
      const i1 = k.indexOf(':'); const i2 = k.indexOf(':', i1 + 1);
      const fk = k.slice(0, i2);
      if (!m.has(fk)) m.set(fk, { row: liveMode ? liveByKey.get(fk) : folderByKey.get(fk), count: 0 });
      m.get(fk).count++;
    }
    for (const g of m.values()) pickGroups.push(g);
    pickGroups.sort((a, b) => String((a.row || {}).path || '').localeCompare(String((b.row || {}).path || '')));
  }

  const folderAvail = dst.target === 'live' ? !!dst.liveId : !!dst.localId;
  const folderName = dst.target === 'live' ? (dst.liveLabel || dst.liveId) : (dst.localLabel || dst.localId);

  const startCopy = (override) => {
    const cfg = override || dstCfg;
    if (!cfg || (!activeSelSize && !override)) return;
    const folderKeys = override && override.folderKeys ? override.folderKeys : [...(liveMode ? selLive : selected)];
    setStarting(true); setErr(null);
    post('/api/copy-email', {
      srcUpn: upn, dstUpn: cfg.dstUpn, target: cfg.target || dst.target, folderKeys,
      items: override && override.items, dst: cfg.dst, dstLabel: cfg.dstLabel,
      srcMode: (override && override.srcMode) || (liveMode ? 'live' : 'store'),
      srcFolders: override && override.srcFolders ? override.srcFolders : (liveMode ? livePayloadFolders() : undefined)
    })
      .catch(e => setErr(e.message))
      .finally(() => setStarting(false));
  };

  // Live source: the engine needs the selected folders' tree rows PLUS their
  // ancestors (for rel-path structure recreation) — walk parents in the
  // loaded live tree.
  const livePayloadFolders = () => {
    const byId = new Map(liveRows.map(f => [f.folderId, f]));
    const out = new Map();
    for (const k of selLive) {
      const id = k.slice('live:'.length);
      for (let cur = byId.get(id); cur; cur = cur.parentId ? byId.get(cur.parentId) : null) {
        if (out.has(cur.folderId)) break;
        out.set(cur.folderId, { id: cur.folderId, parentId: cur.parentId, name: cur.name, path: cur.path });
      }
    }
    return [...out.values()];
  };

  // Confirm dialog: recreate source folders INTO the picked destination folder,
  // or at the mailbox root (live: msgfolderroot; local: a new root folder).
  const openConfirm = () => {
    setPlacement(folderAvail ? 'folder' : 'root');
    setCopyMode(activePicks.size > 0 ? 'items' : 'folders');
    setRootName(dst.newName || '');
    setNote(null);
    setConfirmOpen(true);
  };
  const confirmCopy = () => {
    const body = placement === 'folder'
      ? (dst.target === 'live' ? { folderId: dst.liveId } : { scope: dst.localScope, folderId: dst.localId })
      : (dst.target === 'live' ? { folderId: null } : { scope: dst.localScope, folderId: null, name: rootName.trim() });
    const itemLevel = copyMode === 'items' && activePicks.size > 0;
    const label = placement === 'folder' ? folderName : (dst.target === 'live' ? 'mailbox root' : rootName.trim());
    setStarting(true); setErr(null);
    post('/api/copy-email', {
      srcUpn: upn, dstUpn: dst.dstUpn, target: dst.target,
      folderKeys: itemLevel ? [] : [...(liveMode ? selLive : selected)],
      items: itemLevel ? [...activePicks] : undefined,
      dst: body, dstLabel: label,
      srcMode: liveMode ? 'live' : 'store',
      srcFolders: liveMode ? livePayloadFolders() : undefined
    })
      .then(r => {
        setConfirmOpen(false);
        if (itemLevel) setActivePicks(new Set());
        if (r && r.queued) setNote(`Queued as #${r.position} — it starts automatically when the current copy finishes.`);
      })
      .catch(e => setErr(e.message))
      .finally(() => setStarting(false));
  };
  const confirmValid = (copyMode === 'items' ? activePicks.size > 0 : activeSelSize > 0)
    && (placement === 'folder' ? folderAvail : (dst.target === 'live' || !!rootName.trim()));

  // Restart a history row: the job detail carries the full original config
  // (target/dstUpn/dst/folderKeys/srcMode/srcFolders) — use it verbatim; only
  // fall back to the session's current destination for old jobs without dst.
  const restart = (j) => {
    const d = parseDetail(j.detail);
    if (!d || !d.folderKeys) { setErr('Cannot restart — job detail is missing'); return; }
    const cfg = d.dst
      ? { target: d.target, dstUpn: d.dstUpn, dst: d.dst, srcMode: d.srcMode, srcFolders: d.srcFolders, dstLabel: d.dstLabel }
      : (dstCfg || (d.dstUpn && dst.dstUpn === d.dstUpn ? dstBody() : null));
    if (!cfg) { setErr('Pick a destination above to restart this run'); return; }
    startCopy({ ...cfg, folderKeys: d.folderKeys || [], items: d.items });
  };

  const stop = () => post('/api/stop/copy-email', { upn }).catch(e => setErr(e.message));

  // Human label for a live folder id (from the loaded destination live tree).
  const liveNameOf = id => {
    const f = (liveFolders || []).find(x => x.folderId === id);
    return f ? (f.path || f.name) : null;
  };
  // …and for a local store folder id (the loaded source folders).
  const localNameOf = key => {
    const f = (folders || []).find(x => x.scope + ':' + x.folderId === key);
    return f ? (f.path || f.name) : null;
  };

  // Re-check/re-copy just the failed items of a finished run.
  const retryFailed = (j) => post('/api/copy-email/retry', { jobId: j.id }).catch(e => setErr(e.message));

  const cancelQueued = (id) => del(`/api/copy-email/queue/${id}`).catch(e => setErr(e.message));

  return (
    <>
    <div className="settings-card" style={{ margin: 0 }}>
      <div className="settings-head">
        <h3 className="mono" style={{ fontSize: 14, wordBreak: 'break-all' }}>{upn}</h3>
      </div>
      {err && <p className="bad-text" style={{ padding: '0 18px' }}>{err}</p>}

      <div className="copyemail-row">
      <section className="settings-section">
        <div className="settings-row" style={{ alignItems: 'center' }}>
          <h4 style={{ margin: 0 }}>{liveMode ? 'Source (live mailbox)' : 'Source (local backup)'}</h4>
          <div className="theme-switch" role="group" aria-label="Copy source">
            <button className={`theme-opt${!liveMode ? ' active' : ''}`} aria-pressed={!liveMode} onClick={() => setSrcMode('store')}>Local backup</button>
            <button className={`theme-opt${liveMode ? ' active' : ''}`} aria-pressed={liveMode} onClick={() => setSrcMode('live')}>Live mailbox</button>
          </div>
        </div>
        <p className="settings-hint">
          {activeSelSize
            ? <><b>{activeSelSize}</b> folder(s) selected · {selItems} item(s){liveMode ? '' : ` · ${fmtBytes(selBytes)}`}</>
            : liveMode ? 'Pick live folders to copy. Note: a live copy fetches every message from Exchange — slower than the backup source.' : 'Pick the backed-up folders to copy.'}
        </p>
        {liveMode && (
          <div className="settings-row">
            <p className="settings-hint" />
            <button className="btn small" disabled={!!srcLiveProg?.running} onClick={() => loadSrcLiveFolders(true)}
              title="Walk the live mailbox to refresh the folder list">{srcLiveProg?.running ? `Walking… ${srcLiveProg.found || 0}` : '↻ Refresh'}</button>
          </div>
        )}
        {liveMode && srcLiveProg?.running && (
          <div className="bar slim indet" style={{ margin: '0 0 8px' }}><div className="fill" /></div>
        )}
        <div className="copy-folderlist copyemail-src">
          {!liveMode && folders === null && <p className="settings-hint">Loading folders…</p>}
          {!liveMode && folders !== null && (
            <>
              <SourceScopePanel upn={upn} scopeKey="primary" label="Primary" rows={folders.filter(f => f.scope !== 'archive')}
                selected={selected} onToggleSel={toggleMany} defaultOpen
                emptyNote="No primary backup folders yet — run a backup first."
                onFocusFolder={focusOn} focusId={focusFolder && focusFolder.folderId} />
              <SourceScopePanel upn={upn} scopeKey="archive" label="Archive" rows={folders.filter(f => f.scope === 'archive')} flattenRoot
                selected={selected} onToggleSel={toggleMany}
                emptyNote="No archive backup for this mailbox."
                onFocusFolder={focusOn} focusId={focusFolder && focusFolder.folderId} />
            </>
          )}
          {liveMode && srcLiveFolders === null && (
            <p className="settings-hint">No saved folder tree — press ↻ Refresh to walk the live mailbox (can take a while).</p>
          )}
          {liveMode && srcLiveFolders !== null && (
            <SourceScopePanel upn={upn} scopeKey="live" label="Live mailbox" rows={liveRows}
              selected={selLive} onToggleSel={toggleManyLive} defaultOpen
              emptyNote="The live mailbox has no folders."
              onFocusFolder={focusOn} focusId={focusFolder && focusFolder.folderId} />
          )}
        </div>
      </section>

      <section className="settings-section copyemail-items">
        <h4>Pick individual emails</h4>
        <p className="settings-hint">
          {activePicks.size > 0
            ? <><b>{activePicks.size}</b> email(s) picked — they copy FLAT into the destination folder (no folder structure is recreated).</>
            : 'Click a folder name on the left to see its emails, then tick individual ones. Picked emails copy flat into the destination folder.'}
          {activePicks.size > 0 && <> <button className="btn small ghost" style={{ marginLeft: 6 }} onClick={() => setActivePicks(new Set())}>Clear picks</button></>}
        </p>
        <div className="copy-folderlist copyemail-items-list">
          {!focusFolder && <p className="settings-hint">No folder open — click a folder name in the source tree.</p>}
          {focusFolder && folderItems === null && <p className="settings-hint">Loading {focusFolder.name}…</p>}
          {focusFolder && folderItems !== null && (
            <>
              <div className="scope-head">
                <label className="copy-tree-label copy-select-all">
                  <input type="checkbox"
                    checked={folderItems.length > 0 && folderItems.every(it => activePicks.has(itemKey(it)))}
                    onChange={e => {
                      const on = e.target.checked;
                      setActivePicks(s => { const n = new Set(s); for (const it of folderItems) on ? n.add(itemKey(it)) : n.delete(itemKey(it)); return n; });
                    }} />
                  <b>{focusFolder.name || '(root)'}</b>
                </label>
                <span className="muted">{folderItems.filter(it => activePicks.has(itemKey(it))).length}/{folderItems.length} picked{!liveMode && folderItems.length >= 500 ? ' · showing first 500' : ''}</span>
              </div>
              {folderItems.length === 0 && <p className="settings-hint">{liveMode ? 'No messages in this live folder.' : 'No backed-up emails in this folder.'}</p>}
              {folderItems.map(it => {
                const k = itemKey(it);
                return (
                  <label key={k} className="copy-folder" style={{ cursor: 'pointer' }}>
                    <input type="checkbox" checked={activePicks.has(k)} onChange={e => togglePick(k, e.target.checked)} />
                    <span className="copy-folder-path">
                      {it.subject || '(no subject)'}
                      <span className="dedupe-loc">{it.sender ? it.sender.replace(/\s*<[^>]*>/, '').trim() || it.sender : '(unknown sender)'} · {fmtDate(it.receivedAt)}</span>
                    </span>
                    <span className="copy-folder-n">{it.size ? fmtBytes(it.size) : ''}</span>
                  </label>
                );
              })}
            </>
          )}
        </div>
      </section>

      <section className="settings-section">
        <h4>Destination</h4>
        <div className="settings-row">
          <p className="settings-hint">
            Source folders are recreated under the destination (same-named folders are merged, never duplicated).
            Emails already at the destination are skipped — re-running a copy is safe.
          </p>
          <div className="theme-switch" role="group" aria-label="Copy target">
            <button className={`theme-opt${dst.target === 'live' ? ' active' : ''}`} aria-pressed={dst.target === 'live'} onClick={() => setDst(d => ({ ...d, target: 'live' }))}>Live mailbox</button>
            <button className={`theme-opt${dst.target === 'local' ? ' active' : ''}`} aria-pressed={dst.target === 'local'} onClick={() => setDst(d => ({ ...d, target: 'local' }))}>Local backup</button>
          </div>
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
              <button className="btn small" disabled={!!liveProg?.running} onClick={() => loadLiveFolders(true)}
                title="Walk the live mailbox to refresh the folder list">{liveProg?.running ? `Walking… ${liveProg.found || 0}` : '↻ Refresh'}</button>
            </div>
            {liveProg?.running && (
              <div className="bar slim indet" style={{ margin: '0 0 8px' }}><div className="fill" /></div>
            )}
            <div className="copy-folderlist copyemail-dst">
              {liveFolders === null
                ? <p className="settings-hint">No saved folder tree — press ↻ Refresh to walk the live mailbox (can take a while).</p>
                : <DstTree key={`live:${dst.dstUpn}`} rows={liveFolders} pickedId={dst.liveId} persistKey={`copyemail.dexp.${dst.dstUpn}.live`}
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
                    persistKey={`copyemail.dexp.${dst.dstUpn}.${dst.localScope}`}
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
        <h4>Copy</h4>
        {running ? (
          <div className="compare-prog" style={{ margin: '0 0 12px' }}>
            <div className="compare-prog-main">
              <div className="compare-prog-head">
                <b>{run ? `Copying folders ${run.foldersDone} / ${run.foldersTotal}` : 'Copy running…'}</b>
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
              {run && <span className="muted">{run.done} copied · {run.skipped} skipped · {run.failed} failed</span>}
              <button className="btn small danger" onClick={stop}>Stop</button>
              <button className="btn small" disabled={starting || (!activeSelSize && !activePicks.size)}
                title="Queue another copy — it starts automatically when this one finishes"
                onClick={openConfirm}>Add to queue</button>
            </div>
            {note && <p className="settings-hint good-text" style={{ margin: '6px 0 0' }}>{note}</p>}
          </div>
        ) : (
          <div className="settings-row">
            <p className="settings-hint">
              <b>{activeSelSize}</b> folder(s) selected · {selItems} item(s){liveMode ? '' : ` · ${fmtBytes(selBytes)}`}
              {activePicks.size > 0 && <> · <b>{activePicks.size}</b> email(s) picked individually</>}
              {dstCfg
                ? <> — copying to <b>{dstCfg.label}</b>. Copy only — the source backup stays untouched.</>
                : <> — destination placement is chosen in the next step. Copy only — the source backup stays untouched.</>}
            </p>
            <button className="btn primary" disabled={starting || (!activeSelSize && !activePicks.size)} onClick={openConfirm}>
              {starting ? 'Starting…' : 'Copy'}
            </button>
          </div>
        )}
        {!running && note && <p className="settings-hint good-text" style={{ margin: '6px 0 0' }}>{note}</p>}
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
                title={`Re-check/copy the ${d.failed} failed item(s)${Array.isArray(d.failedKeys) && d.failedKeys.length ? '' : ' (no failed items recorded on this run)'}`}
                onClick={() => retryFailed(fj)}>Retry {d.failed} failed</button>
            </div>
          );
        })()}
      </section>

      <section className="settings-section">
        <h4>Log</h4>
        {logs.length === 0 ? (
          <p className="settings-hint">No copy activity yet.</p>
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
    <CopyTasksPanel upn={upn} run={run} history={history} queue={queue || []} starting={starting} running={running}
      liveNameOf={liveNameOf} localNameOf={localNameOf}
      onStop={stop} onRestart={restart} onRetry={retryFailed} onCancelQueued={cancelQueued} />
    {confirmOpen && (
      <div className="modal-backdrop" onClick={() => setConfirmOpen(false)}>
        <div className="modal-card settings-card copyemail-confirm" role="dialog" aria-modal="true" aria-label="Confirm copy" onClick={e => e.stopPropagation()}>
          <div className="settings-head">
            <h3>Confirm copy</h3>
            <button className="log-iconbtn" title="Cancel" aria-label="Cancel" onClick={() => setConfirmOpen(false)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12" /></svg>
            </button>
          </div>
          <section className="settings-section">
            <p className="settings-hint" style={{ fontSize: 13 }}>
              {copyMode === 'items'
                ? <>Copy <b>{activePicks.size}</b> picked email(s) from {liveMode ? 'the LIVE mailbox ' : ''}<b className="mono">{upn}</b> to <b className="mono">{dst.dstUpn}</b> ({dst.target === 'live' ? 'live mailbox' : `local backup, ${dst.localScope}`}) — FLAT, no folder structure is recreated.</>
                : <>Copy <b>{selItems}</b> item(s){liveMode ? '' : ` (${fmtBytes(selBytes)})`} from {liveMode ? 'the LIVE mailbox ' : ''}<b className="mono">{upn}</b> to <b className="mono">{dst.dstUpn}</b> ({dst.target === 'live' ? 'live mailbox' : `local backup, ${dst.localScope}`}). Source folders are recreated at the destination.</>}
              {' '}Emails already there are skipped.
            </p>
            {copyMode === 'folders' && topSelRows.length > 0 && (
              <div className="copy-folderlist" style={{ maxHeight: 200, overflowY: 'auto', marginBottom: 8 }}>
                {topSelRows.slice(0, 30).map(f => (
                  <div key={f.scope + ':' + f.folderId} className="copy-folder dedupe-group">
                    <FolderClosed size={14} className="tv-icon" style={{ flex: 'none' }} />
                    <span className="copy-folder-path" title={f.path}>{f.path || f.name}</span>
                    <span className="copy-folder-n">{f.backedUp}{liveMode ? '' : ` · ${fmtBytes(f.bytes || 0)}`}</span>
                  </div>
                ))}
                {topSelRows.length > 30 && <p className="settings-hint" style={{ padding: '2px 8px' }}>…and {topSelRows.length - 30} more</p>}
              </div>
            )}
            {copyMode === 'items' && pickGroups.length > 0 && (
              <div className="copy-folderlist" style={{ maxHeight: 200, overflowY: 'auto', marginBottom: 8 }}>
                {pickGroups.slice(0, 30).map((g, i) => (
                  <div key={i} className="copy-folder dedupe-group">
                    <FolderClosed size={14} className="tv-icon" style={{ flex: 'none' }} />
                    <span className="copy-folder-path" title={(g.row || {}).path}>{(g.row || {}).path || '(folder)'}</span>
                    <span className="copy-folder-n">{g.count} picked</span>
                  </div>
                ))}
                {pickGroups.length > 30 && <p className="settings-hint" style={{ padding: '2px 8px' }}>…and {pickGroups.length - 30} more</p>}
              </div>
            )}
            {activePicks.size > 0 && (
              <p className="settings-hint" style={{ marginBottom: 8 }}>To copy whole folders, clear the picked emails first (Clear picks in the picker column).</p>
            )}
            <div className="copy-folderlist" style={{ maxHeight: 'none' }}>
              {folderAvail && (
                <label className="copy-folder dedupe-group" style={{ cursor: 'pointer' }}>
                  <input type="radio" name="copyemail-placement" checked={placement === 'folder'} onChange={() => setPlacement('folder')} />
                  <span className="copy-folder-path">Into folder: <b>{folderName}</b></span>
                </label>
              )}
              <label className="copy-folder dedupe-group" style={{ cursor: 'pointer' }}>
                <input type="radio" name="copyemail-placement" checked={placement === 'root'} onChange={() => setPlacement('root')} />
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
            {running && (
              <p className="settings-hint">A copy is running — this job joins the queue and starts automatically when the current one finishes.</p>
            )}
          </section>
          <div className="confirm-actions" style={{ padding: '0 18px 16px' }}>
            <button className="btn" onClick={() => setConfirmOpen(false)}>Cancel</button>
            <button className="btn primary" disabled={starting || !confirmValid} onClick={confirmCopy}>
              {starting ? 'Starting…' : running ? 'Add to queue' : 'Start copy'}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}

// Floating right panel with the mailbox's copy-email runs (running one on top
// with live progress + Stop, history below with Restart). Mirrors MailboxPage's
// activity-log sidebar: fixed aside, collapsing to a rail.
function CopyTasksPanel({ upn, run, history, queue, starting, running, onStop, onRestart, onRetry, onCancelQueued, liveNameOf, localNameOf }) {
  // Fallback destination label from the running job's detail when the live
  // progress snapshot doesn't carry it yet.
  const runDetail = parseDetail((history.find(j => j.status === 'running') || {}).detail);
  // Old rows may carry a raw Graph/EWS folder id as dstLabel — never dump it;
  // resolve via the loaded live tree, else a neutral placeholder.
  const rawId = s => typeof s === 'string' && s.length > 40 && /^[A-Za-z0-9\-_=+/]+$/.test(s);
  const pretty = (label, folderId) => rawId(label) ? ((folderId && liveNameOf && liveNameOf(folderId)) || 'folder') : label;
  // Route links: from → backup browse deep link (store source; live source has
  // no browse view → compare page), to → destination browse folder (local) or
  // the compare page (live).
  const splitKey = k => { const i = String(k).indexOf(':'); return { scope: String(k).slice(0, i), id: String(k).slice(i + 1) }; };
  const fromHref = (u, d) => {
    if (d && d.srcMode === 'live') return `/?compare=${encodeURIComponent(u)}`;
    const k = d && Array.isArray(d.folderKeys) && d.folderKeys[0];
    if (!k) return `/?mailbox=${encodeURIComponent(u)}`;
    const { scope, id } = splitKey(k);
    return `/?mailbox=${encodeURIComponent(u)}&scope=${encodeURIComponent(scope)}&folderId=${encodeURIComponent(id)}`;
  };
  const toHref = d => {
    if (!d || !d.dstUpn) return null;
    if (d.target === 'local' && d.dst && d.dst.folderId) return `/?mailbox=${encodeURIComponent(d.dstUpn)}&scope=${encodeURIComponent(d.dst.scope)}&folderId=${encodeURIComponent(d.dst.folderId)}`;
    if (d.target === 'live') return `/?compare=${encodeURIComponent(d.dstUpn)}`;
    return `/?mailbox=${encodeURIComponent(d.dstUpn)}`;
  };
  // Source label: saved srcLabel, else resolve the first folderKey against the
  // loaded store rows, else a neutral fallback — never a raw id.
  const srcLabelOf = (d, fallbackKey) => {
    if (d && d.srcLabel) return d.srcLabel;
    const k = fallbackKey || (d && Array.isArray(d.folderKeys) && d.folderKeys[0]);
    const hit = k && localNameOf ? localNameOf(k) : null;
    return hit || (d && Array.isArray(d.folderKeys) && d.folderKeys.length > 1 ? `${d.folderKeys.length} folders` : null);
  };
  // Collapse state persists globally (copyemail.tasksCollapsed) until Reset;
  // default is the collapsed rail.
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem('copyemail.tasksCollapsed') !== '1'; } catch { return false; }
  });
  const togglePanel = v => {
    setOpen(v);
    try { localStorage.setItem('copyemail.tasksCollapsed', v ? '0' : '1'); } catch { }
  };
  if (!open) {
    return (
      <button className="log-rail" title="Show copy tasks" aria-label="Show copy tasks" onClick={() => togglePanel(true)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
        <span className="log-rail-label">Copy tasks</span>
        {(running || history.length > 0) && <span className="log-rail-count">{running ? '●' : history.length > 99 ? '99+' : history.length}</span>}
      </button>
    );
  }
  return (
    <aside className="logs log-sidebar mailbox-log copyemail-tasks" aria-label={`Copy tasks for ${upn}`}>
      <div className="log-head">
        <button className="log-iconbtn" title="Collapse copy tasks" aria-label="Collapse copy tasks" onClick={() => togglePanel(false)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6" /></svg>
        </button>
        <span className="log-title">Copy tasks — {upn}</span>
        {running && <span className="live"><span className="dot" /> live</span>}
      </div>
      <div className="logbox">
        {run && (() => {
          const d = runDetail || {};
          const sLabel = srcLabelOf(d);
          const tLabel = pretty(run.dstLabel || d.dstLabel, d.dst && d.dst.folderId);
          return (
          <div className="copy-task-card">
            <div className="copy-task-route">
              <a className="copy-task-bubble" href={fromHref(run.upn || upn, d)} title={`From: ${run.upn || upn}\n${sLabel || 'mailbox'}`}>{run.upn || upn}{sLabel ? ` · ${sLabel}` : ''}</a>
              <span className="copy-task-arrow" aria-hidden="true">↓</span>
              <a className="copy-task-bubble" href={toHref({ ...d, dstUpn: run.dstUpn, target: run.target }) || '#'} title={`To: ${run.dstUpn}\n${tLabel || 'mailbox'}${run.currentDest ? '\nwriting: ' + run.currentDest : ''}`} onClick={e => { if (!toHref({ ...d, dstUpn: run.dstUpn, target: run.target })) e.preventDefault(); }}>{run.dstUpn}{tLabel ? ` · ${tLabel}` : ''}</a>
              <span className="muted"> ({run.target})</span>
            </div>
            <div className="copy-task-activity muted">
              Copying folders {run.foldersDone} / {run.foldersTotal}
              {run.foldersTotal > 0 && <> · {Math.round(run.foldersDone / run.foldersTotal * 100)}%</>}
              {run.currentDest && <> · → {run.currentDest}</>}
              {run.currentFolder && <> · from: {run.currentFolder}</>}
            </div>
            <div className={`bar slim${run.itemsTotal ? '' : ' indet'}`}>
              <div className="fill" style={run.itemsTotal ? { width: `${Math.min(100, Math.round((run.itemsDone || 0) / run.itemsTotal * 100))}%` } : undefined} />
            </div>
            <div className="compare-prog-stats">
              <span className="muted">{run.itemsDone || 0} / {run.itemsTotal} item(s)</span>
              {run.bytesTotal > 0 && <span className="muted">{fmtBytes(run.bytesDone || 0)} / {fmtBytes(run.bytesTotal)}</span>}
              <span className="muted">{run.done} copied · {run.skipped} skipped · {run.failed} failed{run.failed > 0 ? ' (retried automatically; re-check via “Retry failed” after the run)' : ''}</span>
              <button className="btn small danger" onClick={onStop}>Stop</button>
            </div>
          </div>
          );
        })()}
        {queue && queue.length > 0 && (
          <>
            <div className="settings-label" style={{ margin: '4px 0 6px' }}>Queue ({queue.length})</div>
            {queue.map((q, i) => {
              const qd = { srcMode: q.srcMode, folderKeys: q.srcFolderKey ? [q.srcFolderKey] : [], dst: { folderId: q.dstFolderId, scope: q.target === 'local' ? 'primary' : undefined }, dstUpn: q.dstUpn, target: q.target, srcLabel: q.srcLabel };
              const qsLabel = srcLabelOf(qd, q.srcFolderKey);
              return (
              <div key={q.id} className="copy-task-card">
                <div className="copy-task-route">
                  <a className="copy-task-bubble" href={fromHref(q.srcUpn, qd)} title={`From: ${q.srcUpn}\n${qsLabel || 'mailbox'}`}>{q.srcUpn}{qsLabel ? ` · ${qsLabel}` : ''}</a>
                  <span className="copy-task-arrow" aria-hidden="true">↓</span>
                  <a className="copy-task-bubble" href={toHref(qd)} title={`To: ${q.dstUpn}\n${q.dstLabel ? pretty(q.dstLabel, q.dstFolderId) : 'mailbox'}`}>{q.dstUpn}{q.dstLabel ? ` · ${pretty(q.dstLabel, q.dstFolderId)}` : ''}</a>
                  <span className="muted"> ({q.target})</span>
                </div>
                <div className="copy-task-activity muted">
                  <span className="muted" title={fmtDateTime(q.createdAt)}>#{i + 1} · queued · {fmtTime(q.createdAt)}</span>
                  {q.retryOf ? ` · retry of job ${q.retryOf}` : ''}
                  {q.items ? ` · ${q.items} picked email(s)` : q.folders ? ` · ${q.folders} folder(s)` : ''}
                </div>
                <div className="compare-prog-stats">
                  <button className="btn small danger" title="Remove from the queue" onClick={() => onCancelQueued(q.id)}>✕ Cancel</button>
                </div>
              </div>
              );
            })}
          </>
        )}
        {!history.length && !run && !(queue && queue.length) && <div className="log-empty">No copy runs for this mailbox yet.</div>}
        {history.map(j => {
          const d = parseDetail(j.detail);
          const label = d ? pretty(d.dstLabel || d.dstUpn || '', d.dst && d.dst.folderId) : '';
          const sLabel = d ? srcLabelOf(d) : null;
          const sUpn = (d && d.srcUpn) || j.upn || upn;
          return (
            <div key={j.id} className="copy-task-card">
              {d && (
                <div className="copy-task-route">
                  <a className="copy-task-bubble" href={fromHref(sUpn, d)} title={`From: ${sUpn}\n${sLabel || 'mailbox'}`}>{sUpn}{sLabel ? ` · ${sLabel}` : ''}</a>
                  <span className="copy-task-arrow" aria-hidden="true">↓</span>
                  <a className="copy-task-bubble" href={toHref(d)} title={`To: ${d.dstUpn}\n${label || 'mailbox'}`}>{d.dstUpn || ''}{label ? ` · ${label}` : ''}</a>
                  <span className="muted"> ({d.target || 'live'})</span>
                </div>
              )}
              <div className="copy-task-activity">
                <b>{d && d.target === 'local' ? 'Copy to local' : 'Copy to live'}</b>{' '}
                <span className={j.status === 'done' ? 'good-text' : j.status === 'running' ? 'muted' : 'bad-text'}>{j.status}</span>{' '}
                <span className="muted" title={fmtDateTime(j.startedAt)}>{fmtTime(j.startedAt)}</span>
                {j.total ? <span className="muted"> · {j.done || 0}/{j.total}</span> : ''}
                {j.finishedAt ? <span className="muted"> · finished {fmtDateTime(j.finishedAt)}</span> : ''}
              </div>
              {d && (
                <div className="copy-task-activity muted">
                  {d.done || 0} copied{d.bytesTotal ? ` (${fmtBytes(d.bytesCopied || 0)})` : ''} · {d.skipped || 0} skipped · {d.failed || 0} failed
                </div>
              )}
              <div className="compare-prog-stats">
                {j.status === 'running' && <button className="btn small danger" onClick={onStop}>Stop</button>}
                {d && (d.failed || 0) > 0 && (j.status === 'done' || j.status === 'stopped' || j.status === 'error' || j.status === 'interrupted') && (
                  <button className="btn small" disabled={starting || running}
                    title={`Re-check/copy the ${d.failed} failed item(s)${Array.isArray(d.failedKeys) && d.failedKeys.length ? '' : ' (no failed items recorded on this run)'}`}
                    onClick={() => onRetry(j)}>Retry {d.failed} failed</button>
                )}
                {(j.status === 'stopped' || j.status === 'error' || j.status === 'interrupted') && (
                  <button className="btn small" disabled={starting || running}
                    title="Restart — already-copied items are skipped"
                    onClick={() => onRestart(j)}>Restart</button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

export default function CopyEmailPage() {
  const [mailboxes, setMailboxes] = useState([]);
  const [upn, setUpn] = useState(() => {
    try { return localStorage.getItem('copyemail.upn') || ''; } catch { return ''; }
  });
  const [showShared, setShowShared] = useState(false);
  const [showGuests, setShowGuests] = useState(false);
  const [runs, setRuns] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [queue, setQueue] = useState([]);
  const [histJobs, setHistJobs] = useState([]);
  const upnRef = useRef(upn);
  const [err, setErr] = useState(null);

  useEffect(() => {
    document.title = 'M365Sphere — Copy email';
    api('/api/mailboxes').then(setMailboxes).catch(e => setErr(e.message));
    return () => { document.title = 'M365Sphere'; };
  }, []);

  useEffect(() => {
    try { localStorage.setItem('copyemail.upn', upn); } catch { }
    upnRef.current = upn;
    setHistJobs([]);
    if (upn) api(`/api/copy-email/jobs?upn=${encodeURIComponent(upn)}`)
      .then(d => setHistJobs(d.jobs || []))
      .catch(() => { });
  }, [upn]);

  // One shared status poll. History comes from the kind-filtered endpoint —
  // /api/status's jobs array is capped at 20 rows of all kinds, so sweep jobs
  // would push copy-email rows out. Fetched on the same cadence.
  useEffect(() => {
    let t;
    const poll = () => {
      api('/api/status').then(s => {
        setRuns(s.copyEmailRuns || []);
        setJobs(s.jobs || []);
        setQueue(s.copyEmailQueue || []);
        t = setTimeout(poll, (s.copyEmailRunning || (s.copyEmailQueue || []).length) ? 2000 : 10000);
      }).catch(() => { t = setTimeout(poll, 5000); });
      const u = upnRef.current;
      if (u) api(`/api/copy-email/jobs?upn=${encodeURIComponent(u)}`)
        .then(d => setHistJobs(d.jobs || []))
        .catch(() => { });
    };
    poll();
    return () => clearTimeout(t);
  }, []);

  const resetAll = () => {
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith('copyemail.')) localStorage.removeItem(k);
    } catch { }
    setUpn(''); setErr(null);
  };

  return (
    <div className="mailbox-page copyemail-page">
      <header className="mailbox-page-head">
        <a className="brand" href="/" title="Go to homepage">
          <img className="brand-icon" src="/logo.png" alt="M365Sphere logo" />
          <h1>M365Sphere</h1>
        </a>
        <h2>Copy email</h2>
        <label className="muted">Source mailbox
          <MailboxPicker value={upn} onChange={setUpn}
            mailboxes={mailboxes} showShared={showShared} showGuests={showGuests}
            placeholder="Search mailboxes…" /></label>
        <span className="muted compare-type-toggles" title="Mailbox types to include in search results (licensed users are always listed)">
          Include:
          <label><input type="checkbox" checked={showShared} onChange={e => setShowShared(e.target.checked)} /> shared</label>
          <label><input type="checkbox" checked={showGuests} onChange={e => setShowGuests(e.target.checked)} /> guests</label>
        </span>
        <span className="spacer" />
        <button className="btn small" title="Clear the mailbox choice and all saved selections/destinations (they are remembered across refreshes otherwise)" onClick={resetAll}>Reset</button>
        <a className="btn small" href="/">← Back</a>
      </header>
      {err && <p className="bad-text">{err}</p>}

      {!upn ? (
        <p className="muted" style={{ padding: '0 18px' }}>Pick a source mailbox above — one mailbox is copied at a time; selections are remembered per mailbox.</p>
      ) : (
        <CopyEmailSession key={upn} upn={upn} mailboxes={mailboxes} showShared={showShared} showGuests={showGuests}
          runs={runs} jobs={jobs} histJobs={histJobs} queue={queue} />
      )}
    </div>
  );
}
