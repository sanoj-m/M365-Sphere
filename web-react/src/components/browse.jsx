import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { api, withToken } from '../api.js';
import { fmtBytes, fmtDateTime } from '../format.js';
import { ChevronRight, FolderClosed, FolderOpen, Check, CheckCircle } from 'lucide-react';

export const qs = o => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

export const exportFolderUrl = (upn, node, recursive) =>
  withToken(`/api/mailbox/${encodeURIComponent(upn)}/export-folder?${qs({ scope: node.scope, folderId: node.folderId, recursive: recursive ? 1 : 0 })}`);

function buildTree(rows) {
  const byId = new Map(rows.map(r => [r.folderId, { ...r, children: [] }]));
  const roots = [];
  for (const n of byId.values()) {
    const p = n.parentId && byId.get(n.parentId);
    if (p) p.children.push(n); else roots.push(n);
  }
  const sortRec = ns => { ns.sort((a, b) => String(a.name).localeCompare(String(b.name))); ns.forEach(n => sortRec(n.children)); };
  sortRec(roots);
  // Rollup backed-up bytes: totalBytes = own folder items + all descendants
  const roll = ns => { for (const n of ns) { roll(n.children); n.totalBytes = (n.bytes || 0) + n.children.reduce((a, c) => a + c.totalBytes, 0); } };
  roll(roots);
  // The synthetic store root is not a real mailbox folder — show its children
  // at top level instead of wrapping the whole tree in one "Archive root" node.
  return roots.flatMap(r => r.name === 'Archive root' ? r.children : [r]);
}

function TreeNode({ node, depth, expanded, toggle, currentFolder, selectedId, onSelect, onMenu }) {
  const open = expanded.has(node.folderId);
  const hasKids = node.children.length > 0;
  const isCurrent = currentFolder && (node.path === currentFolder);
  const complete = node.itemCount > 0 && node.backedUp >= node.itemCount;
  const activate = () => { onSelect(node); if (hasKids) toggle(node.folderId); };
  const openMenuAtButton = e => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    onMenu(r.right, r.bottom, node);
  };
  return (
    <>
      <div
        className={`tv-control tree-row${isCurrent ? ' current' : ''}${selectedId === node.folderId ? ' selected' : ''}`}
        style={{ paddingLeft: 6 + depth * 18 }}
        role="treeitem"
        aria-expanded={hasKids ? open : undefined}
        aria-selected={selectedId === node.folderId}
        tabIndex={0}
        onClick={activate}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } }}
        onContextMenu={e => { e.preventDefault(); onMenu(e.clientX, e.clientY, node); }}
        title="Right-click for export options"
      >
        <span
          className={`tv-indicator${open ? ' open' : ''}${hasKids ? '' : ' leaf'}`}
          onClick={e => { e.stopPropagation(); if (hasKids) toggle(node.folderId); }}
        >{hasKids ? <ChevronRight size={14} /> : null}</span>
        <span className="tv-text">
          {hasKids
            ? (open ? <FolderOpen size={15} className="tv-icon" /> : <FolderClosed size={15} className="tv-icon" />)
            : <FolderClosed size={14} className="tv-icon tv-leaf-icon" />}
          <span className="tree-name">{node.name || '(root)'}</span>
        </span>
        {complete && <Check size={14} className="tree-done-icon" />}
        <span className="tv-stats mono">{node.backedUp} / {node.itemCount}</span>
        <span className="tv-size mono muted" title={`Backed-up size of "${node.name || '(root)'}" including subfolders (raw message bytes)`}>{fmtBytes(node.totalBytes || 0)}</span>
        <button type="button" className="tree-menu-btn" aria-label={`Export options for ${node.name || '(root)'}`}
          onClick={openMenuAtButton}>⋯</button>
      </div>
      {open && hasKids && (
        <div className="tv-branch-content tree-kids">
          {node.children.map(c => (
            <TreeNode key={c.folderId} node={c} depth={0} expanded={expanded} toggle={toggle}
              currentFolder={currentFolder} selectedId={selectedId} onSelect={onSelect} onMenu={onMenu} />
          ))}
        </div>
      )}
    </>
  );
}

export function ScopeTree({ label, rows, currentFolder, selectedId, onSelect, onMenu, flattenRoot, defaultExpanded = true }) {
  const [expanded, setExpanded] = useState(() => defaultExpanded ? new Set(rows.map(r => r.folderId)) : new Set());
  const toggle = id => setExpanded(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  if (!rows.length) return null;
  let roots = buildTree(rows);
  // A single synthetic container root (e.g. "Archive root") is not a real
  // folder — show its children at the top level instead of an expandable node.
  if (flattenRoot && roots.length === 1 && roots[0].children.length) roots = roots[0].children;
  const remote = rows.reduce((a, r) => a + (r.itemCount || 0), 0);
  const backed = rows.reduce((a, r) => a + (r.backedUp || 0), 0);
  const foldersDone = rows.filter(r => r.itemCount > 0 && r.backedUp >= r.itemCount).length
    + rows.filter(r => r.itemCount === 0).length;
  return (
    <div className="scope-tree">
      <div className="scope-head">
        {label && <b>{label}</b>}
        {label && <span className="muted">{foldersDone}/{rows.length} folders complete · {backed} / {remote} emails</span>}
        <span className="tree-all-btns">
          <button type="button" className="btn small" onClick={() => setExpanded(new Set(rows.map(r => r.folderId)))}>Expand all</button>
          <button type="button" className="btn small" onClick={() => setExpanded(new Set())}>Collapse all</button>
        </span>
      </div>
      <div className="tree">
        {roots.map(n => <TreeNode key={n.folderId} node={n} depth={0} expanded={expanded} toggle={toggle}
          currentFolder={currentFolder} selectedId={selectedId} onSelect={onSelect} onMenu={onMenu} />)}
      </div>
    </div>
  );
}

export function ItemList({ upn, folder, selectedItemId, onSelectItem }) {
  const [items, setItems] = useState(null);
  const [err, setErr] = useState(null);
  const [limit, setLimit] = useState(500);
  useEffect(() => { setItems(null); setLimit(500); }, [upn, folder]);
  useEffect(() => {
    setErr(null);
    if (!folder) return;
    let stale = false;
    api(`/api/mailbox/${encodeURIComponent(upn)}/items?${qs({ scope: folder.scope, folderId: folder.folderId, limit })}`)
      .then(d => { if (!stale) setItems(d.items); })
      .catch(e => { if (!stale) setErr(e.message); });
    return () => { stale = true; };
  }, [upn, folder, limit]);
  if (!folder) return <div className="pane items"><p className="muted pane-hint">Select a folder</p></div>;
  if (err) return <div className="pane items"><p className="bad-text">{err}</p></div>;
  if (!items) return <div className="pane items"><p className="muted pane-hint">Loading…</p></div>;
  const hasMore = items.length >= limit;
  return (
    <div className="pane items">
      <div className="pane-head">{folder.name} <span className="muted">{items.length}{hasMore ? '+' : ''} backed up</span></div>
      {items.length === 0 && <p className="muted pane-hint">No backed-up emails in this folder yet.</p>}
      {items.map(it => (
        <div key={it.itemId}
          className={`item-row${selectedItemId === it.itemId ? ' selected' : ''}`}
          onClick={() => onSelectItem(it)}>
          <div className="item-subject">{it.sender ? it.sender.replace(/\s*<[^>]*>/, '').trim() || it.sender : '(unknown sender)'}</div>
          <div className="item-meta muted">
            <span className="item-sub2">{it.subject || '(no subject)'}</span>
            <span>{fmtDateTime(it.receivedAt)}</span>
            <span>{fmtBytes(it.size)}</span>
          </div>
        </div>
      ))}
      {hasMore && (
        <div className="load-more">
          <button type="button" className="btn small" onClick={() => setLimit(l => l + 500)}>Load 500 more</button>
        </div>
      )}
    </div>
  );
}

export function ReadingPane({ upn, folder, item }) {
  const [pv, setPv] = useState(null);
  const [err, setErr] = useState(null);
  const frameRef = React.useRef(null);
  useEffect(() => {
    setPv(null); setErr(null);
    if (!item) return;
    let stale = false;
    api(`/api/mailbox/${encodeURIComponent(upn)}/item?${qs({ scope: folder.scope, folderId: folder.folderId, itemId: item.itemId })}`)
      .then(d => { if (!stale) setPv(d); })
      .catch(e => { if (!stale) setErr(e.message); });
    return () => { stale = true; };
  }, [upn, folder, item]);
  if (!item) return <div className="pane reading"><p className="muted pane-hint">Select an email to preview</p></div>;
  if (err) return <div className="pane reading"><p className="bad-text">{err}</p></div>;
  if (!pv) return <div className="pane reading"><p className="muted pane-hint">Loading…</p></div>;
  const itemQs = qs({ scope: folder.scope, folderId: folder.folderId, itemId: item.itemId });
  if (pv.fts) {
    return (
      <div className="pane reading">
        <div className="mail-head">
          <div className="mail-actions">
            <a className="btn small" href={withToken(`/api/mailbox/${encodeURIComponent(upn)}/download?${itemQs}`)}>⬇ Download .fts</a>
          </div>
          <div className="mail-subject">{pv.subject || '(no subject)'}</div>
          {pv.receivedAt && <div className="mail-line muted">{String(pv.receivedAt).slice(0, 19).replace('T', ' ')}</div>}
        </div>
        <p className="muted pane-hint" style={{ padding: 16 }}>{pv.note}</p>
      </div>
    );
  }
  const printMail = () => {
    const w = window.open('', '_blank');
    if (!w) return;
    const esc = s => String(s || '').replace(/</g, '&lt;');
    // The email body HTML is untrusted — render it in a sandboxed iframe (no scripts).
    w.document.write(`<html><head><title>${esc(pv.subject)}</title></head><body>` +
      `<h2>${esc(pv.subject)}</h2>` +
      `<p><b>From:</b> ${esc(pv.from)}<br><b>To:</b> ${esc(pv.to)}<br><b>Date:</b> ${(pv.date || '').slice(0, 19).replace('T', ' ')}</p><hr>` +
      `<iframe sandbox="" title="email print view" style="width:100%;border:0;height:78vh"></iframe></body></html>`);
    w.document.close();
    const frame = w.document.querySelector('iframe');
    frame.srcdoc = pv.html || '';
    w.focus();
    frame.addEventListener('load', () => w.print(), { once: true });
  };
  return (
    <div className="pane reading">
      <div className="mail-head">
        <div className="mail-actions">
          <button className="btn small" onClick={printMail}>🖨 Print</button>
          <a className="btn small" href={withToken(`/api/mailbox/${encodeURIComponent(upn)}/download?${itemQs}`)}>⬇ Download .eml</a>
        </div>
        <div className="mail-subject">{pv.subject}</div>
        <div className="mail-line"><b>From:</b> {pv.from || '(unknown sender)'}</div>
        {pv.to && <div className="mail-line"><b>To:</b> {pv.to}</div>}
        {pv.cc && <div className="mail-line"><b>Cc:</b> {pv.cc}</div>}
        {pv.date && <div className="mail-line muted">{(pv.date || '').slice(0, 19).replace('T', ' ')}</div>}
        {(pv.attachments || []).length > 0 && (
          <div className="mail-atts">
            {(pv.attachments || []).map(a => (
              <a key={a.index} className="att chip info"
                href={withToken(`/api/mailbox/${encodeURIComponent(upn)}/attachment?${qs({ scope: folder.scope, folderId: folder.folderId, itemId: item.itemId, index: a.index })}`)}>
                📎 {a.filename} ({fmtBytes(a.size)})
              </a>
            ))}
          </div>
        )}
      </div>
      <iframe ref={frameRef} className="mailframe" sandbox="" title="email preview" srcDoc={pv.html} />
    </div>
  );
}

// Stored bytes (primaryBytes/archiveBytes) are sums of raw MIME sizes — the
// same measure as the server sizes, so this is a coverage metric, not compression.
function storageInfo(scope, mailbox) {
  if (!mailbox) return null;
  const stored = scope === 'archive' ? mailbox.archiveBytes : mailbox.primaryBytes;
  const server = scope === 'archive' ? mailbox.serverArchiveBytes : mailbox.serverPrimaryBytes;
  if (stored == null) return null;
  const title = 'Locally stored backup size (raw message bytes, same measure as the server size). '
    + 'Server size per Exchange (EXO-authoritative when available, otherwise EWS — the API-accessible portion). '
    + 'Percentage = how much of the server-side content is backed up.';
  if (server == null || !server) {
    return { text: `stored ${fmtBytes(stored)}`, title };
  }
  const pct = Math.min(100, Math.round(100 * stored / server));
  const title2 = stored > server
    ? title + ' Stored exceeds the last server measurement — run Fetch Sizes to refresh.'
    : title;
  return { text: `${fmtBytes(stored)} of ${fmtBytes(server)} (${pct}%)`, title: title2 };
}

// Collapsible per-scope panel (Primary / Archive) with independent folder/item
// selection, live progress bar, and export context menu. Used by both
// MailboxPage (full-page) and BackupPage MailboxCard (inline live view).
export function ScopePanel({ upn, scope, label, rows, live, scanLive, mailbox, actions }) {
  const [folder, setFolder] = useState(null);
  const [item, setItem] = useState(null);
  const [menu, setMenu] = useState(null); // { x, y, node }
  // Panel collapse persists across refreshes (per mailbox + scope).
  const collapseKey = `m365panel:${upn}:${scope}`;
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(collapseKey) === '1');
  const toggleCollapsed = () => setCollapsed(c => { try { localStorage.setItem(collapseKey, c ? '0' : '1'); } catch { } return !c; });

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = e => { if (e.key === 'Escape') setMenu(null); };
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const remote = rows.reduce((a, r) => a + (r.itemCount || 0), 0);
  const backed = rows.reduce((a, r) => a + (r.backedUp || 0), 0);
  // Authoritative server total from EXO (includes AEA auxiliary content, which
  // folder counts miss) — prefer it whenever sizes have been fetched.
  const exoTotal = mailbox && (scope === 'archive' ? mailbox.serverArchiveItems : mailbox.serverPrimaryItems);
  const remoteShown = exoTotal != null && exoTotal > 0 ? exoTotal : remote;
  const pct = remoteShown ? Math.min(999, Math.round(100 * backed / remoteShown)) : 0;
  const scopeLive = live && live.scope === scope ? live : null;
  const scopeScan = scanLive && scanLive.scope === scope ? scanLive : null;
  const storage = storageInfo(scope, mailbox);
  // Without an EXO total, auto-expanding archives undercount: folder counts see
  // only the main partition — mark the number approximate.
  const approx = scope === 'archive' && !!(mailbox && mailbox.autoExpandingArchive) && !(exoTotal > 0);
  const approxTitle = 'Approximate — counts the API-visible main archive partition only. Run Fetch Sizes to get the authoritative archive total from Exchange (includes auxiliary partitions).';
  const remoteTxt = (approx ? '~' : '') + remoteShown.toLocaleString();

  if (!rows.length) {
    return (
      <section className="card scope-panel">
        <div className="scope-panel-head"><h3>{label}</h3><span className="spacer" />{actions}</div>
        {scopeScan
          ? <p className="muted pane-hint">Scanning server counts — {scopeScan.folders} folders…</p>
          : <p className="muted pane-hint">{scope === 'archive' ? 'No online archive' : 'No folders discovered yet — start a backup to enumerate this mailbox.'}</p>}
      </section>
    );
  }

  const toggle = toggleCollapsed;
  return (
    <section className="card scope-panel">
      <div className="scope-panel-head scope-panel-toggle" role="button" tabIndex={0}
        aria-expanded={!collapsed} aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${label}`}
        onClick={toggle}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}>
        <span className={`scope-chevron${collapsed ? '' : ' open'}`}><ChevronRight size={14} /></span>
        <h3>{label}</h3>
        <span className="muted" title={approx ? approxTitle : undefined}>{rows.length} folders · {backed} / {remoteTxt} emails{approx ? '' : ` (${pct}%)`}{approx ? ' (visible)' : ''}</span>
        <span className="spacer" />
        {storage && <span className="scope-storage muted" title={storage.title}>{storage.text}</span>}
        {actions && <span className="scope-actions" onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>{actions}</span>}
      </div>
      {/* Kept mounted while collapsed so selection state and fetches survive re-expand. */}
      <div className="scope-panel-body" style={collapsed ? { display: 'none' } : undefined}>
        {!scopeLive && !scopeScan && remote > 0 && pct >= 100 && backed <= remoteShown && !approx ? (
          <div className="donebox">
            <CheckCircle size={14} className="donebox-icon" />
            <span className="kind">Backed up</span>
            <span className="muted" title={approx ? approxTitle : undefined}>{backed} / {remoteTxt} emails</span>
          </div>
        ) : (
          <div className="livebox">
            <div className="joblabel">
              <span className="kind">{scopeScan ? `Scanning counts — ${scope}` : scopeLive ? `Backup running — ${scope}` : backed > remoteShown ? 'Count exceeds server total' : 'Backed up'}</span>
              <span>{scopeScan
                ? `${scopeScan.folders} folders…`
                : `${backed} / ${remoteTxt} emails${scopeLive
                  ? scopeLive.enumFound
                    ? ` · enumerating folders… ${scopeLive.enumFound} found`
                    : ` · ${pct}% · folder ${scopeLive.foldersDone}/${scopeLive.foldersTotal}`
                  : approx ? ' (visible portion)' : ` (${pct}%)`}`}</span>
            </div>
            <div className="bar"><div className="fill" style={{ width: (scopeScan ? 100 : Math.min(100, pct)) + '%', ...(scopeScan ? { opacity: 0.4 } : null) }} /></div>
            {scopeLive && scopeLive.currentFolder && <div className="muted mono current-folder">→ {scopeLive.currentFolder}</div>}
          </div>
        )}
        <div className="outlook">
          <div className="pane folders">
            <ScopeTree label={null} rows={rows} flattenRoot={scope === 'archive'}
              currentFolder={scopeLive ? scopeLive.currentFolder : null}
              selectedId={folder && folder.folderId} onSelect={n => { setFolder(n); setItem(null); }}
              onMenu={(x, y, node) => setMenu({ x, y, node })} />
          </div>
          <ItemList upn={upn} folder={folder} selectedItemId={item && item.itemId} onSelectItem={setItem} />
          <ReadingPane upn={upn} folder={folder} item={item} />
        </div>
      </div>
      {menu && createPortal(
        <div className="ctxmenu" role="menu"
          style={{
            left: Math.max(4, Math.min(menu.x, window.innerWidth - 240)),
            top: Math.max(4, Math.min(menu.y, window.innerHeight - 110))
          }}
          onClick={e => e.stopPropagation()}>
          <div className="ctx-title">{menu.node.name || '(root)'}</div>
          <a role="menuitem" href={exportFolderUrl(upn, menu.node, false)} download>⬇ Export folder (.zip of .eml)</a>
          <a role="menuitem" href={exportFolderUrl(upn, menu.node, true)} download>⬇ Export incl. subfolders (.zip)</a>
        </div>,
        document.body
      )}
    </section>
  );
}
