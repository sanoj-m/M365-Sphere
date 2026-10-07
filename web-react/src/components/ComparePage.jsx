import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { api, post, withToken } from '../api.js';
import { fmtBytes, fmtDateTime } from '../format.js';
import { ScopeTree, qs } from './browse.jsx';

// Vertical drag handle; onDrag receives the pointer's clientX while dragging.
function DragBar({ onDrag }) {
  const start = e => {
    e.preventDefault();
    const move = ev => onDrag(ev.clientX);
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  return <div className="dragbar" role="separator" aria-orientation="vertical" onMouseDown={start} />;
}

const pctFrom = (ref, x, min = 15, max = 85) => {
  const r = ref.current.getBoundingClientRect();
  return Math.min(max, Math.max(min, (x - r.left) / r.width * 100));
};

// Per-side item list with checkboxes (local rows use itemId, live rows use id).
// Row click toggles the checkbox; right-click opens the item context menu.
function CheckItemList({ items, checked, onToggle, onToggleAll, onMenu, emptyHint, hasMore, onLoadMore }) {
  if (!items) return <p className="muted pane-hint">Loading…</p>;
  if (!items.length) return <p className="muted pane-hint">{emptyHint || 'No emails in this folder.'}</p>;
  const allChecked = items.every(it => checked.has(it.key));
  return (
    <>
      <div className="pane-head">
        <label className="check-all"><input type="checkbox" checked={allChecked && items.length > 0} onChange={e => onToggleAll(e.target.checked)} /> Select all</label>
        <span className="muted">{checked.size} checked · {items.length}{hasMore ? '+' : ''}</span>
      </div>
      {items.map(it => (
        <div key={it.key} className={`item-row check-row${checked.has(it.key) ? ' selected' : ''}`}
          onClick={() => onToggle(it.key, !checked.has(it.key))}
          onContextMenu={e => { e.preventDefault(); onMenu(it, e.clientX, e.clientY); }}>
          <input type="checkbox" checked={checked.has(it.key)} onClick={e => e.stopPropagation()} onChange={e => onToggle(it.key, e.target.checked)} />
          <div className="item-row-body">
            <div className="item-subject">{it.sender ? it.sender.replace(/\s*<[^>]*>/, '').trim() || it.sender : '(unknown sender)'}</div>
            <div className="item-meta muted">
              <span className="item-sub2">{it.subject || '(no subject)'}</span>
              <span>{fmtDateTime(it.receivedAt)}</span>
              {it.size != null && <span>{fmtBytes(it.size)}</span>}
            </div>
          </div>
        </div>
      ))}
      {hasMore && (
        <div className="load-more">
          <button type="button" className="btn small" onClick={onLoadMore}>Load 500 more</button>
        </div>
      )}
    </>
  );
}

// Preview body: fetcher url + builders for download/attachment links.
function Preview({ fetchUrl, downloadUrl, attUrl }) {
  const [pv, setPv] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    setPv(null); setErr(null);
    let stale = false;
    api(fetchUrl)
      .then(d => { if (!stale) setPv(d); })
      .catch(e => { if (!stale) setErr(e.message); });
    return () => { stale = true; };
  }, [fetchUrl]);
  if (err) return <p className="bad-text pane-hint">{err}</p>;
  if (!pv) return <p className="muted pane-hint">Loading…</p>;
  return (
    <>
      <div className="mail-head">
        <div className="mail-actions">
          <a className="btn small" href={withToken(downloadUrl)}>⬇ Download .eml</a>
          {pv.size != null && <span className="muted">{fmtBytes(pv.size)}</span>}
        </div>
        <div className="mail-subject">{pv.subject}</div>
        <div className="mail-line"><b>From:</b> {pv.from || '(unknown sender)'}</div>
        {pv.to && <div className="mail-line"><b>To:</b> {pv.to}</div>}
        {pv.cc && <div className="mail-line"><b>Cc:</b> {pv.cc}</div>}
        {pv.date && <div className="mail-line muted">{String(pv.date).slice(0, 19).replace('T', ' ')}</div>}
        {(pv.attachments || []).length > 0 && (
          <div className="mail-atts">
            {(pv.attachments || []).map(a => (
              <a key={a.index} className="att chip info" href={withToken(attUrl(a.index))}>
                📎 {a.filename} ({fmtBytes(a.size)})
              </a>
            ))}
          </div>
        )}
      </div>
      <iframe className="mailframe" sandbox="" title="email preview" srcDoc={pv.html || ''} />
    </>
  );
}

// Type-to-search mailbox picker: licensed users by default, shared/guests via
// the header toggles. Filters as you type; Enter picks the first match.
export function MailboxPicker({ value, onChange, mailboxes, showShared, showGuests, placeholder }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const close = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const ql = q.toLowerCase();
  const list = mailboxes.filter(m =>
    ((m.type || 'user') === 'user' || (m.type === 'shared' && showShared) || (m.type === 'guest' && showGuests) || m.upn === value)
    && (!ql || m.upn.toLowerCase().includes(ql)));
  const pick = upn => { onChange(upn); setQ(''); setOpen(false); };
  return (
    <span className="mbx-picker" ref={ref}>
      <input className="search" value={open ? q : value} placeholder={placeholder || 'Search mailboxes…'}
        onFocus={() => { setQ(''); setOpen(true); }}
        onChange={e => { setQ(e.target.value); setOpen(true); }}
        onKeyDown={e => {
          if (e.key === 'Escape') { setQ(''); setOpen(false); }
          if (e.key === 'Enter' && list.length) pick(list[0].upn);
        }} />
      {open && (
        <div className="mbx-list">
          {list.length === 0 && <div className="mbx-opt muted">No matches — check the shared/guests toggles.</div>}
          {list.map(m => (
            <div key={m.upn} className="mbx-opt" onMouseDown={() => pick(m.upn)}>
              {m.upn}{m.type && m.type !== 'user' && <span className="muted"> ({m.type})</span>}
            </div>
          ))}
        </div>
      )}
    </span>
  );
}

export default function ComparePage({ upn }) {
  // Selected mailboxes survive page refresh (localStorage) until Reset is pressed.
  const stored = (() => { try { return JSON.parse(localStorage.getItem('compare.sel') || '{}'); } catch { return {}; } })();
  const [mailboxes, setMailboxes] = useState([]);
  const [leftUpn, setLeftUpn] = useState(stored.left || upn || '');
  const [rightUpn, setRightUpn] = useState(stored.right || upn || '');
  const [showShared, setShowShared] = useState(false);
  const [showGuests, setShowGuests] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    try { localStorage.setItem('compare.sel', JSON.stringify({ left: leftUpn, right: rightUpn })); } catch { }
  }, [leftUpn, rightUpn]);

  const resetAll = () => {
    try { localStorage.removeItem('compare.sel'); } catch { }
    setLeftUpn(''); setRightUpn(''); setLeftFolder(null); setErr(null); setResult(null);
  };

  // Left (local) side
  const [leftFolders, setLeftFolders] = useState(null);
  const [leftScope, setLeftScope] = useState('primary');
  const [leftFolder, setLeftFolder] = useState(null);
  const [leftItems, setLeftItems] = useState(null);
  const [leftChecked, setLeftChecked] = useState(new Set());

  // Right (live) side
  const [rightFolders, setRightFolders] = useState(null);
  const [rightFolder, setRightFolder] = useState(null);
  const [rightItems, setRightItems] = useState(null);
  const [rightChecked, setRightChecked] = useState(new Set());

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [undoInfo, setUndoInfo] = useState(null); // { label } | null
  const [prog, setProg] = useState(null);         // live progress of the running transfer
  const [menu, setMenu] = useState(null);       // { x, y, side, it }
  const [preview, setPreview] = useState(null); // { side, it }
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyRows, setHistoryRows] = useState(null);

  // Resizable splits: outer left/right + per-side folders/items
  const bodyRef = useRef(null);
  const leftSplitRef = useRef(null);
  const rightSplitRef = useRef(null);
  const [sidePct, setSidePct] = useState(50);
  const [leftFolderPct, setLeftFolderPct] = useState(50);
  const [rightFolderPct, setRightFolderPct] = useState(50);

  useEffect(() => {
    document.title = 'M365Sphere — Compare';
    document.body.classList.add('compare-mode'); // strip #root page padding so 100vh fits exactly
    return () => { document.title = 'M365Sphere'; document.body.classList.remove('compare-mode'); };
  }, []);

  useEffect(() => {
    api('/api/mailboxes').then(setMailboxes).catch(e => setErr(e.message));
    api('/api/compare/undo').then(d => setUndoInfo(d.available ? { label: d.label } : null)).catch(() => { });
  }, []);

  // Close the item context menu on any click / escape.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const key = e => { if (e.key === 'Escape') close(); };
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
      window.removeEventListener('keydown', key);
    };
  }, [menu]);

  const loadLeftFolders = useCallback(() => {
    if (!leftUpn) { setLeftFolders([]); return; }
    // No null reset: keep showing the current tree while the refresh is in
    // flight (the transfer poll calls this every 1.5 s).
    api(`/api/mailbox/${encodeURIComponent(leftUpn)}/folders`)
      .then(d => setLeftFolders(d.folders || []))
      .catch(e => { setErr(e.message); setLeftFolders([]); });
  }, [leftUpn]);
  useEffect(loadLeftFolders, [loadLeftFolders]);

  const [rightProg, setRightProg] = useState(null); // { running, found, current }
  const [rightFoldersAt, setRightFoldersAt] = useState(null); // epoch ms of the saved tree
  // refresh=false only reads the saved tree (memory/disk — instant, no server walk);
  // refresh=true walks the live mailbox and saves the result for future loads.
  const loadRightFolders = useCallback(async (refresh) => {
    if (!rightUpn) return;
    if (refresh) setRightProg({ running: true, found: 0, current: '', startedAt: Date.now() });
    try {
      const d = await api(`/api/live/${encodeURIComponent(rightUpn)}/folders${refresh ? '?refresh=1' : ''}`);
      if (!d.folders) { setRightFolders(null); setRightFoldersAt(null); return; }
      setRightFolders(d.folders.map(f => ({ ...f, backedUp: 0, bytes: 0 })));
      setRightFoldersAt(d.at || null);
    } catch (e) {
      if (refresh) { setErr(e.message); setRightFolders(null); setRightFoldersAt(null); }
    } finally {
      if (refresh) setRightProg(null);
    }
  }, [rightUpn]);
  // Selecting a live mailbox resets the pane, then tries the saved tree (no walk).
  useEffect(() => {
    setRightFolders(null); setRightFoldersAt(null); setRightFolder(null); setRightItems(null); setRightChecked(new Set()); setRightProg(null);
    if (rightUpn) loadRightFolders(false);
  }, [rightUpn]); // eslint-disable-line react-hooks/exhaustive-deps
  // Poll server-side fetch progress while a folder walk is running. When the
  // server reports idle, keep the last state — the /folders response itself
  // (or its error) clears rightProg, so the bar can never freeze on screen.
  useEffect(() => {
    if (!rightProg?.running || !rightUpn) return;
    const t = setInterval(() => {
      api(`/api/live/${encodeURIComponent(rightUpn)}/folders/progress`)
        .then(p => setRightProg(prev => (p.running ? { ...p, startedAt: prev?.startedAt } : prev)))
        .catch(() => { });
    }, 700);
    return () => clearInterval(t);
  }, [rightProg?.running, rightUpn]);

  const [leftLimit, setLeftLimit] = useState(500);
  // Changing mailbox/scope/folder resets pagination and the checkbox selection;
  // "load more" refetches with a higher limit but keeps what's checked AND the
  // already-loaded rows on screen (no collapse/scroll jump while fetching).
  useEffect(() => { setLeftLimit(500); setLeftChecked(new Set()); setLeftItems(null); }, [leftUpn, leftScope, leftFolder]);
  const loadLeftItems = useCallback(() => {
    if (!leftUpn || !leftFolder) { setLeftItems(null); return; }
    api(`/api/mailbox/${encodeURIComponent(leftUpn)}/items?${qs({ scope: leftScope, folderId: leftFolder.folderId, limit: leftLimit })}`)
      .then(d => setLeftItems(d.items.map(it => ({ ...it, key: it.itemId }))))
      .catch(e => setErr(e.message));
  }, [leftUpn, leftScope, leftFolder, leftLimit]);
  useEffect(() => { loadLeftItems(); }, [loadLeftItems]);

  const loadRightItems = useCallback(() => {
    if (!rightUpn || !rightFolder) { setRightItems(null); return; }
    setRightItems(null); setRightChecked(new Set());
    api(`/api/live/${encodeURIComponent(rightUpn)}/items?${qs({ folderId: rightFolder.folderId })}`)
      .then(d => setRightItems(d.items.map(it => ({ ...it, key: it.id }))))
      .catch(e => setErr(e.message));
  }, [rightUpn, rightFolder]);
  useEffect(loadRightItems, [loadRightItems]);

  const toggle = (set, setSet) => (key, on) => setSet(s => { const n = new Set(s); on ? n.add(key) : n.delete(key); return n; });
  const toggleAll = (items, setSet) => on => setSet(on ? new Set(items.map(it => it.key)) : new Set());

  // Live progress of the running transfer (server-side state, polled while busy).
  // Also refresh the local folder tree so destination totals (backed-up counts,
  // bytes) tick up as the copy writes them. (Items are not reloaded here —
  // loadLeftItems clears the checkbox selection.)
  // sawRunning guards the race where the first poll lands before the server
  // has populated progress for a just-started transfer.
  const sawRunning = useRef(false);
  useEffect(() => {
    if (!busy) { setProg(null); sawRunning.current = false; return; }
    const tick = () => {
      api('/api/compare/progress').then(p => {
        setProg(p);
        if (p && p.running) { sawRunning.current = true; return; }
        if (sawRunning.current && p && !p.running) {
          sawRunning.current = false;
          setBusy(false);
          setResult(`${p.label || 'transfer'}: ${p.done} done, ${p.skipped} skipped, ${p.failed} failed${p.stopped ? ' — stopped' : ''}`);
          loadLeftFolders();
          loadRightItems();
          api('/api/compare/undo').then(u => setUndoInfo(u && u.available ? { label: u.label } : null)).catch(() => { });
        }
      }).catch(() => { });
      loadLeftFolders();
    };
    tick();
    const t = setInterval(tick, 1500);
    return () => clearInterval(t);
  }, [busy, loadLeftFolders, loadRightItems]);

  // Re-attach after a page refresh: the server-side transfer keeps running even
  // though local state was reset — pick up its progress and show the card again.
  useEffect(() => {
    api('/api/compare/progress').then(p => {
      if (p && p.running) { setProg(p); setBusy(true); }
    }).catch(() => { });
  }, []);

  const doTransfer = async (direction, mode) => {
    const isToLive = direction === 'toLive';
    const srcItems = isToLive ? leftItems : rightItems;
    const srcChecked = isToLive ? leftChecked : rightChecked;
    const picked = (srcItems || []).filter(it => srcChecked.has(it.key));
    if (!picked.length) return;
    if (mode === 'move' && !window.confirm(`Move ${picked.length} email(s)? Source copies will be removed (recoverable).`)) return;
    const body = isToLive
      ? {
        direction, mode, srcUpn: leftUpn, dstUpn: rightUpn, dstFolderId: rightFolder.folderId, dstName: rightFolder.name, srcName: leftFolder.name,
        items: picked.map(it => ({ scope: leftScope, folderId: leftFolder.folderId, itemId: it.itemId }))
      }
      : {
        direction, mode, srcUpn: rightUpn, dstUpn: leftUpn, dstScope: leftScope,
        srcFolderId: rightFolder.folderId, dstName: leftFolder.name, srcName: rightFolder.name,
        dstFolder: { folderId: leftFolder.folderId, parentId: leftFolder.parentId, name: leftFolder.name, path: leftFolder.path },
        items: picked.map(it => ({ id: it.id }))
      };
    setBusy(true); setResult(null); setErr(null);
    try {
      const r = await post('/api/compare/transfer', body);
      const errs = r.results.filter(x => x.error).slice(0, 3).map(x => x.error);
      setResult(`${r.done} ${mode === 'move' ? 'moved' : 'copied'}, ${r.failed} failed, ${r.skipped} skipped${r.stopped ? ' — stopped' : ''}${errs.length ? ' — ' + errs.join(' · ') : ''}`);
      setUndoInfo(r.undo || null);
      loadLeftFolders();
      loadLeftItems();
      loadRightItems();
      if (isToLive) loadRightFolders(true);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  // URL builders per side for preview/download/attachments.
  const itemUrls = (side, it) => side === 'left'
    ? {
      fetchUrl: `/api/mailbox/${encodeURIComponent(leftUpn)}/item?${qs({ scope: leftScope, folderId: leftFolder && leftFolder.folderId, itemId: it.itemId })}`,
      downloadUrl: `/api/mailbox/${encodeURIComponent(leftUpn)}/download?${qs({ scope: leftScope, folderId: leftFolder && leftFolder.folderId, itemId: it.itemId })}`,
      attUrl: i => `/api/mailbox/${encodeURIComponent(leftUpn)}/attachment?${qs({ scope: leftScope, folderId: leftFolder && leftFolder.folderId, itemId: it.itemId, index: i })}`
    }
    : {
      fetchUrl: `/api/live/${encodeURIComponent(rightUpn)}/item?${qs({ itemId: it.id })}`,
      downloadUrl: `/api/live/${encodeURIComponent(rightUpn)}/download?${qs({ itemId: it.id })}`,
      attUrl: i => `/api/live/${encodeURIComponent(rightUpn)}/attachment?${qs({ itemId: it.id, index: i })}`
    };

  const scopeRows = sc => (leftFolders || []).filter(f => f.scope === sc);
  const hasArchive = (leftFolders || []).some(f => f.scope === 'archive');
  const leftReady = leftFolder && leftChecked.size > 0 && rightFolder;
  const rightReady = rightFolder && rightChecked.size > 0 && leftFolder;

  // Folder-level copy (copy only): source folder incl. its whole subtree is
  // merged into the selected destination folder — or the mailbox root when no
  // destination folder is selected. Same-named destination folders are reused;
  // emails already present are skipped.
  const doFolderTransfer = async (direction) => {
    const isToLive = direction === 'toLive';
    const src = isToLive ? leftFolder : rightFolder;
    const dst = isToLive ? rightFolder : leftFolder;
    if (!src) return;
    // Subtree size is shown in the confirm so a stale/partial tree is obvious.
    const subtreeOf = (rows, rootId) => {
      const byId = new Map((rows || []).map(f => [f.folderId, f]));
      return (rows || []).filter(f => {
        for (let cur = f; cur; cur = byId.get(cur.parentId)) if (cur.folderId === rootId) return true;
        return false;
      });
    };
    const subtreeRows = isToLive
      ? subtreeOf(leftFolders.filter(f => f.scope === leftScope), leftFolder.folderId)
      : subtreeOf(rightFolders, rightFolder.folderId);
    const dstLabel = dst ? `'${dst.name}'` : 'the mailbox root';
    if (!window.confirm(`Copy folder '${src.name}' into ${dstLabel}?\n\nSubtree: ${subtreeRows.length} folder(s), incl. subfolders. Same-named folders are merged; existing emails are skipped.`)) return;
    const body = isToLive
      ? {
        direction, srcUpn: leftUpn, dstUpn: rightUpn,
        srcFolder: { scope: leftScope, folderId: leftFolder.folderId, name: leftFolder.name },
        dstFolderId: rightFolder ? rightFolder.folderId : null, dstName: rightFolder ? rightFolder.name : ''
      }
      : {
        direction, srcUpn: rightUpn, dstUpn: leftUpn, dstScope: leftScope,
        srcFolder: { folderId: rightFolder.folderId, name: rightFolder.name },
        dstName: leftFolder ? leftFolder.name : '',
        srcFolders: subtreeRows.map(({ folderId, parentId, name, path, itemCount }) => ({ folderId, parentId, name, path, itemCount })),
        dstFolder: leftFolder ? { folderId: leftFolder.folderId, parentId: leftFolder.parentId, name: leftFolder.name, path: leftFolder.path } : null
      };
    setBusy(true); setResult(null); setErr(null);
    try {
      const r = await post('/api/compare/transfer-folder', body);
      setResult(`folder copy: ${r.done} copied, ${r.skipped} skipped (already present), ${r.failed} failed across ${r.folders} folders${r.stopped ? ' — stopped' : ''}${r.errors && r.errors.length ? ' — ' + r.errors.slice(0, 3).join(' · ') : ''}`);
      setUndoInfo(r.undo || null);
      loadLeftFolders();
      loadLeftItems();
      loadRightItems();
      if (isToLive) loadRightFolders(true);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  // Reverse the last compare transfer (single-item or folder, either direction).
  const doUndo = async () => {
    if (!undoInfo) return;
    if (!window.confirm(`Undo last action: ${undoInfo.label}?`)) return;
    setBusy(true); setResult(null); setErr(null);
    try {
      const r = await post('/api/compare/undo', {});
      setResult(`undo: ${r.undone} undone, ${r.failed} failed${r.errors && r.errors.length ? ' — ' + r.errors.slice(0, 3).join(' · ') : ''}`);
      setUndoInfo(null);
      loadLeftFolders();
      loadLeftItems();
      loadRightItems();
      loadRightFolders(true);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mailbox-page compare-page">
      <header className="mailbox-page-head">
        <a className="brand" href="/" title="Go to homepage">
          <img className="brand-icon" src="/logo.png" alt="M365Sphere logo" />
          <h1>M365Sphere</h1>
        </a>
        <h2>Compare &amp; transfer</h2>
        <label className="muted">Local backup
          <MailboxPicker value={leftUpn} onChange={v => { setLeftUpn(v); setLeftFolder(null); }}
            mailboxes={mailboxes} showShared={showShared} showGuests={showGuests}
            placeholder="Search local backup…" /></label>
        <label className="muted">Live mailbox
          <MailboxPicker value={rightUpn} onChange={setRightUpn}
            mailboxes={mailboxes} showShared={showShared} showGuests={showGuests}
            placeholder="Search live mailbox…" /></label>
        <span className="muted compare-type-toggles" title="Mailbox types to include in search results (licensed users are always listed)">
          Include:
          <label><input type="checkbox" checked={showShared} onChange={e => setShowShared(e.target.checked)} /> shared</label>
          <label><input type="checkbox" checked={showGuests} onChange={e => setShowGuests(e.target.checked)} /> guests</label>
        </span>
        <span className="spacer" />
        <button className="btn small" title="Show the transfer history (every copy/move/folder/undo action, newest first)" onClick={() => { setHistoryOpen(true); setHistoryRows(null); api('/api/compare/history').then(d => setHistoryRows(d.rows)).catch(e => setErr(e.message)); }}>History</button>
        <button className="btn small" disabled={busy || !undoInfo} title={undoInfo ? `Undo last action: ${undoInfo.label}` : 'Nothing to undo'} onClick={doUndo}>↩ Undo</button>
        <button className="btn small" title="Clear both mailbox selections (they are remembered across refreshes otherwise)" onClick={resetAll}>Reset</button>
        <a className="btn small" href={upn ? `/?mailbox=${encodeURIComponent(upn)}` : '/'}>← Back</a>
      </header>
      {err && <p className="bad-text">{err}</p>}
      {result && <p className="good-text">{result}</p>}
      {busy && (() => {
        const pct = prog && prog.itemsTotal ? Math.min(100, Math.round(prog.itemsDone / prog.itemsTotal * 100)) : null;
        return (
          <div className="compare-prog">
            <div className="compare-prog-main">
              <div className="compare-prog-head">
                <b>{prog?.label || 'Transferring…'}</b>
                {pct != null && <span className="muted">{pct}%</span>}
              </div>
              {prog && (prog.src || prog.dst) && (
                <div className="compare-prog-route muted">
                  <span>{prog.src}</span><span className="compare-prog-arrow">→</span><span>{prog.dst}</span>
                </div>
              )}
            </div>
            <div className={`bar slim${pct == null ? ' indet' : ''}`}>
              <div className="fill" style={pct != null ? { width: `${pct}%` } : undefined} />
            </div>
            <div className="compare-prog-stats">
              <span className="good-text">✓ {prog?.done ?? 0} {prog?.kind === 'undo' ? 'undone' : 'copied'}</span>
              <span className="muted">→ {prog?.skipped ?? 0} skipped</span>
              <span className="bad-text">✗ {prog?.failed ?? 0} failed</span>
              {prog && prog.kind === 'folder' && (
                <span className="muted" title={prog.currentFolder || ''}>folder {prog.foldersDone}/{prog.foldersTotal}{prog.currentFolder ? ` · ${prog.currentFolder}` : ''}</span>
              )}
            </div>
            <button className="btn small danger" title="Stop the running transfer after the current email (copies made so far are kept — use Undo to reverse them)" onClick={() => post('/api/stop/compare', {}).catch(e => setErr(e.message))}>■ Stop</button>
          </div>
        );
      })()}
      <div className="compare-body" ref={bodyRef}>
        <div className="compare-side card" style={{ flex: `0 0 calc(${sidePct}% - 44px)` }}>
          <div className="compare-side-head">
            <b>Local backup</b>
            {hasArchive && (
              <span className="scope-tabs">
                <button className={`btn small${leftScope === 'primary' ? ' primary' : ''}`} onClick={() => { setLeftScope('primary'); setLeftFolder(null); }}>Primary</button>
                <button className={`btn small${leftScope === 'archive' ? ' primary' : ''}`} onClick={() => { setLeftScope('archive'); setLeftFolder(null); }}>Archive</button>
              </span>
            )}
            <span className="spacer" />
            <span className="compare-actions" title="Transfer from the local backup to the live mailbox">
              <button className="btn small" disabled={busy || !leftReady} title="Copy checked local emails into the folder selected on the right (live mailbox)" onClick={() => doTransfer('toLive', 'copy')}>Copy →</button>
              <button className="btn small" disabled={busy || !leftReady} title="Move checked local emails into the live mailbox (local copy retires to the graveyard)" onClick={() => doTransfer('toLive', 'move')}>Move →</button>
              <button className="btn small" disabled={busy || !leftFolder || !rightUpn} title="Copy the local folder selected here (incl. subfolders) into the live folder selected on the right — or the mailbox root if none is selected. Same-named folders are merged, existing emails skipped" onClick={() => doFolderTransfer('toLive')}>Copy folder ▸</button>
            </span>
          </div>
          <div className="compare-split" ref={leftSplitRef}>
            <div className="pane folders" style={{ flex: `0 0 ${leftFolderPct}%` }}>
              {leftUpn && leftFolders === null
                ? <p className="muted pane-hint">Loading folders…</p>
                : leftUpn && scopeRows(leftScope).length > 0
                  ? <ScopeTree label={null} rows={scopeRows(leftScope)} flattenRoot={leftScope === 'archive'} defaultExpanded={false}
                    selectedId={leftFolder && leftFolder.folderId}
                    onSelect={n => setLeftFolder(n)}
                    onMenu={() => { }} />
                  : <p className="muted pane-hint">{leftUpn ? 'No folders in this scope.' : 'Select a mailbox.'}</p>}
            </div>
            <DragBar onDrag={x => setLeftFolderPct(pctFrom(leftSplitRef, x, 10, 70))} />
            <div className="pane items">
              {!leftFolder
                ? <p className="muted pane-hint">Select a folder</p>
                : <CheckItemList items={leftItems} checked={leftChecked} onToggle={toggle(leftChecked, setLeftChecked)}
                  onToggleAll={toggleAll(leftItems || [], setLeftChecked)}
                  onMenu={(it, x, y) => setMenu({ side: 'left', it, x, y })}
                  hasMore={!!leftItems && leftItems.length >= leftLimit}
                  onLoadMore={() => setLeftLimit(l => l + 500)}
                  emptyHint="No backed-up emails in this folder." />}
            </div>
          </div>
        </div>

        <div className="compare-mid">
          <DragBar onDrag={x => setSidePct(pctFrom(bodyRef, x, 20, 80))} />
        </div>

        <div className="compare-side card">
          <div className="compare-side-head">
            <b>Live mailbox</b>
            <span className="info-tip" tabIndex={0}>
              <span className="info-btn" aria-label="About the live mailbox pane">?</span>
              <span className="info-pop">
                <b>Live mailbox</b> — read-only. Nothing is downloaded until you preview or transfer an email.
                {rightFoldersAt
                  ? <> Folder tree saved {fmtDateTime(new Date(rightFoldersAt).toISOString())} — it loads instantly next time; <b>Refresh</b> re-walks the mailbox for a fresh copy.</>
                  : <> No folder tree saved yet — <b>Fetch live folders</b> walks the mailbox once, then it's saved.</>}
              </span>
            </span>
            <span className="spacer" />
            <span className="compare-actions" title="Transfer from the live mailbox to the local backup">
              <button className="btn small" disabled={busy || !rightReady} title="Copy checked live emails into the folder selected on the left" onClick={() => doTransfer('toLocal', 'copy')}>← Copy</button>
              <button className="btn small" disabled={busy || !rightReady} title="Move checked live emails into the folder selected on the left (server copy moves to Deleted Items)" onClick={() => doTransfer('toLocal', 'move')}>← Move</button>
              <button className="btn small" disabled={busy || !rightFolder || !leftUpn} title="Copy the live folder selected here (incl. subfolders) into the local folder selected on the left — or the mailbox root if none is selected. Same-named folders are merged, existing emails skipped" onClick={() => doFolderTransfer('toLocal')}>◂ Copy folder</button>
            </span>
            {rightFolders && <button className="btn small" disabled={!rightUpn || rightProg?.running} title="Re-walk the live mailbox and save the fresh folder tree" onClick={() => loadRightFolders(true)}>Refresh</button>}
          </div>
          <div className="compare-split" ref={rightSplitRef}>
            <div className="pane folders" style={{ flex: `0 0 ${rightFolderPct}%` }}>
              {rightProg?.running
                ? <div className="live-prog">
                  <div className="bar indet"><div className="fill" /></div>
                  <span className="muted">{rightProg.found} folder(s) found{rightProg.current ? ` · ${rightProg.current}` : ''} · {Math.max(0, Math.floor((Date.now() - (rightProg.startedAt || Date.now())) / 1000))}s</span>
                  <span className="muted">Large mailboxes can take several minutes — the walk is throttled by Microsoft Graph.</span>
                </div>
                : rightFolders
                  ? rightFolders.length > 0
                    ? <ScopeTree label={null} rows={rightFolders} defaultExpanded={false}
                      selectedId={rightFolder && rightFolder.folderId}
                      onSelect={n => setRightFolder(n)}
                      onMenu={() => { }} />
                    : <p className="muted pane-hint">No folders.</p>
                  : <div className="pane-hint live-load">
                    {rightUpn
                      ? <>
                        <p className="muted">No saved folder tree — fetching walks the whole mailbox on the server once, then it's saved for instant loads.</p>
                        <button className="btn small primary" onClick={() => loadRightFolders(true)}>Fetch live folders</button>
                      </>
                      : <p className="muted">Select a mailbox.</p>}
                  </div>}
            </div>
            <DragBar onDrag={x => setRightFolderPct(pctFrom(rightSplitRef, x, 10, 70))} />
            <div className="pane items">
              {!rightFolder
                ? <p className="muted pane-hint">Select a folder</p>
                : <CheckItemList items={rightItems} checked={rightChecked} onToggle={toggle(rightChecked, setRightChecked)}
                  onToggleAll={toggleAll(rightItems || [], setRightChecked)}
                  onMenu={(it, x, y) => setMenu({ side: 'right', it, x, y })}
                  emptyHint="No emails in this folder." />}
            </div>
          </div>
        </div>
      </div>

      {menu && createPortal(
        <div className="ctxmenu" role="menu"
          style={{
            position: 'fixed',
            left: Math.max(4, Math.min(menu.x, window.innerWidth - 240)),
            top: Math.max(4, Math.min(menu.y, window.innerHeight - 110))
          }}>
          <div className="ctx-title">{menu.it.subject || '(no subject)'}</div>
          <a role="menuitem" href="#preview" onClick={e => { e.preventDefault(); setPreview({ side: menu.side, it: menu.it }); setMenu(null); }}>Preview</a>
          <a role="menuitem" href={withToken(itemUrls(menu.side, menu.it).downloadUrl)} download>⬇ Download .eml</a>
        </div>, document.body)}

      {preview && (
        <div className="modal-overlay" onClick={() => setPreview(null)}>
          <div className="modal-box compare-pv-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <h3>{preview.it.subject || '(no subject)'}</h3>
              <span className="spacer" />
              <button className="btn small" onClick={() => setPreview(null)}>Close</button>
            </div>
            <div className="modal-body compare-pv-body">
              <Preview {...itemUrls(preview.side, preview.it)} />
            </div>
          </div>
        </div>
      )}

      {historyOpen && (
        <div className="modal-overlay" onClick={() => setHistoryOpen(false)}>
          <div className="modal-box compare-pv-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Transfer history</h3>
              <span className="muted">every copy/move/folder/undo action, newest first</span>
              <span className="spacer" />
              <button className="btn small" onClick={() => setHistoryOpen(false)}>Close</button>
            </div>
            <div className="modal-body">
              {!historyRows && <p className="muted pane-hint">Loading…</p>}
              {historyRows && historyRows.length === 0 && <p className="muted pane-hint">No transfers recorded yet.</p>}
              {(historyRows || []).map(r => (
                <div key={r.id} className="hist-row">
                  <span className="hist-ts muted">{fmtDateTime(r.ts)}</span>
                  <span className={`chip ${r.failed ? 'danger' : 'info'}`}>
                    {r.kind === 'folder' ? 'folder copy' : r.kind}{r.mode === 'move' ? ' (move)' : ''}{r.stopped ? ' — stopped' : ''}
                  </span>
                  <span className="hist-route">
                    {r.srcUpn}{r.srcName ? ` · ${r.srcName}` : ''}
                    {' → '}
                    {r.direction === 'toLive' ? 'live ' : 'local '}{r.dstUpn}{r.dstName ? ` · ${r.dstName}` : ''}{r.dstScope && r.direction === 'toLocal' ? ` (${r.dstScope})` : ''}
                  </span>
                  <span className="hist-counts muted">
                    {r.kind === 'undo'
                      ? `${r.done} undone${r.failed ? `, ${r.failed} failed` : ''}`
                      : `${r.done} copied, ${r.skipped} skipped, ${r.failed} failed${r.folders ? ` · ${r.folders} folder(s)` : ''}`}
                  </span>
                  {r.detail && <div className="hist-detail muted" title={r.detail}>{r.detail}</div>}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
