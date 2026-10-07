import React, { useState, useEffect, useCallback } from 'react';
import { api, del } from '../api.js';
import { dialog } from '../dialog.jsx';
import { fmtBytes } from '../format.js';
import { useModal } from './useModal.js';
import { ChevronRight, Mail, Archive, FileBox, Trash2, FolderOpen, FolderCog, Database, HardDrive, X } from 'lucide-react';

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

function FolderNode({ node, depth, sel, onToggle, expanded, toggleExp }) {
  const hasKids = node.children.length > 0;
  const open = expanded.has(node.folderId);
  return (
    <>
      <div className="plan-row" style={{ paddingLeft: 6 + depth * 18 }}>
        <span
          className={`tv-indicator${open ? ' open' : ''}${hasKids ? '' : ' leaf'}`}
          onClick={() => hasKids && toggleExp(node.folderId)}
        >{hasKids ? <ChevronRight size={14} /> : null}</span>
        <input type="checkbox" checked={sel.has(node.folderId)} onChange={() => onToggle(node)} aria-label={node.path} />
        <span>{node.name || '(root)'}</span>
        <span className="sz mono">{fmtBytes(node.bytes)} · {node.backedUp}</span>
      </div>
      {open && node.children.map(c => (
        <FolderNode key={c.folderId} node={c} depth={depth + 1} sel={sel} onToggle={onToggle} expanded={expanded} toggleExp={toggleExp} />
      ))}
    </>
  );
}

function FolderManager({ upn, onChanged }) {
  const [folders, setFolders] = useState(null);
  const [err, setErr] = useState(null);
  const [sel, setSel] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(null); // null until folders load

  const load = useCallback(() => {
    api('/api/mailbox/' + encodeURIComponent(upn) + '/folders')
      .then(d => { setFolders(d.folders || []); setErr(null); })
      .catch(e => setErr(e.message));
  }, [upn]);
  useEffect(load, [load]);

  const toggle = node => {
    const next = new Set(sel);
    // Selecting a folder includes all descendants (they live under its path on disk).
    const add = n => { next.add(n.folderId); n.children.forEach(add); };
    const drop = n => { next.delete(n.folderId); n.children.forEach(drop); };
    (sel.has(node.folderId) ? drop : add)(node);
    setSel(next);
  };

  const removeSelected = async () => {
    const chosen = folders.filter(f => sel.has(f.folderId));
    if (!chosen.length) return;
    if (!await dialog.confirm({ title: 'Delete folders', danger: true, okText: 'Delete', message: `Delete ${chosen.length} selected folder(s) from the local backup of ${upn}? Locally stored emails and database records for these folders (and their subfolders) will be removed. The mailbox on the server is not touched. This cannot be undone.` })) return;
    setBusy(true);
    const failed = [];
    for (const f of chosen) {
      try {
        await del(`/api/mailbox/${encodeURIComponent(upn)}/folder?scope=${f.scope}&folderId=${encodeURIComponent(f.folderId)}`);
      } catch (e) { failed.push(`${f.path}: ${e.message}`); }
    }
    setSel(new Set());
    setBusy(false);
    if (failed.length) setErr(failed.join(' · '));
    load();
    onChanged();
  };

  if (err && !folders) return <p className="bad-text">{err}</p>;
  if (!folders) return <p className="muted">Loading folders…</p>;
  if (!folders.length) return <p className="muted">No backed-up folders for this mailbox.</p>;

  const exp = expanded === null ? new Set(folders.map(f => f.folderId)) : expanded;
  const toggleExp = id => {
    const n = new Set(exp);
    n.has(id) ? n.delete(id) : n.add(id);
    setExpanded(n);
  };

  const groups = [['primary', 'Primary mailbox'], ['archive', 'Online archive']]
    .map(([scope, label]) => ({ scope, label, tree: buildTree(folders.filter(f => f.scope === scope)) }))
    .filter(g => g.tree.length);

  return (
    <div className="foldermgr">
      <div className="tree-all-btns foldermgr-allbtns">
        <button type="button" className="btn small" onClick={() => setExpanded(new Set(folders.map(f => f.folderId)))}>Expand all</button>
        <button type="button" className="btn small" onClick={() => setExpanded(new Set())}>Collapse all</button>
      </div>
      {groups.map(g => (
        <div key={g.scope} className="foldermgr-group">
          <b>{g.label}</b>
          {g.tree.map(n => <FolderNode key={n.folderId} node={n} depth={0} sel={sel} onToggle={toggle} expanded={exp} toggleExp={toggleExp} />)}
        </div>
      ))}
      {err && <p className="bad-text">{err}</p>}
      <div className="foldermgr-actions">
        <button className="btn small danger" disabled={busy || !sel.size} onClick={removeSelected}>
          Delete selected folders ({sel.size})
        </button>
        {busy && <span className="muted">Deleting…</span>}
      </div>
    </div>
  );
}

function MailboxStorage({ m, onChanged, onBrowse }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [foldersOpen, setFoldersOpen] = useState(false);
  const hasBackup = (m.primaryBytes || 0) + (m.archiveBytes || 0) > 0;
  const total = (m.primaryBytes || 0) + (m.archiveBytes || 0);

  const run = async (confirmText, fn) => {
    if (!await dialog.confirm({ title: 'Please confirm', danger: true, okText: 'Delete', message: confirmText })) return;
    setBusy(true);
    setErr(null);
    fn().then(() => onChanged()).catch(e => setErr(e.message)).finally(() => setBusy(false));
  };
  const enc = encodeURIComponent(m.upn);
  const initial = (m.upn || '?').slice(0, 1).toUpperCase();

  const segments = [
    (m.primaryBytes || 0) > 0 && {
      key: 'primary', icon: Mail, label: 'Primary mailbox', hint: 'local backup', bytes: m.primaryBytes,
      title: `Delete stored primary backup of ${m.upn}`,
      confirm: `Delete the stored primary backup of ${m.upn}? Locally stored emails and database records for the primary scope will be removed. This cannot be undone.`,
      action: () => del(`/api/mailbox/${enc}/backup?scope=primary`),
    },
    (m.archiveBytes || 0) > 0 && {
      key: 'archive', icon: Archive, label: 'Online archive', hint: 'local backup', bytes: m.archiveBytes,
      title: `Delete stored archive backup of ${m.upn}`,
      confirm: `Delete the stored archive backup of ${m.upn}? Locally stored emails and database records for the archive scope will be removed. This cannot be undone.`,
      action: () => del(`/api/mailbox/${enc}/backup?scope=archive`),
    },
    !!m.pstStatus && {
      key: 'pst', icon: FileBox, label: 'PST export', hint: m.pstStatus, bytes: null,
      title: `Delete exported PST files of ${m.upn}`,
      confirm: `Delete all exported PST files of ${m.upn}? This cannot be undone.`,
      action: () => del(`/api/pst/${enc}`),
    },
    (m.exoExportBytes || 0) > 0 && {
      key: 'exoexport', icon: FileBox, label: 'EXO export (full archive)', hint: 'compliance-search PSTs', bytes: m.exoExportBytes,
      title: `Delete EXO-exported PST files of ${m.upn}`,
      confirm: `Delete all EXO-exported PST files of ${m.upn} (full-mailbox compliance-search export, incl. archive)? This cannot be undone.`,
      action: () => del(`/api/mailbox/${enc}/exo-export`),
    },
  ].filter(Boolean);

  return (
    <div className="sm-card">
      <div className="sm-card-head">
        <span className="sm-avatar" aria-hidden="true">{initial}</span>
        <div className="sm-id">
          <button
            className="sm-upn mono"
            disabled={!hasBackup}
            title={hasBackup ? 'Open the backed-up folders and emails' : 'Nothing backed up yet'}
            onClick={() => onBrowse([m.upn])}
          >{m.upn}</button>
          <span className="muted">{segments.length} item{segments.length === 1 ? '' : 's'} stored</span>
        </div>
        <div className="sm-total">
          <b className="mono">{fmtBytes(total)}</b>
          <span className="muted sm-total-split">
            P {fmtBytes(m.primaryBytes)} · A {fmtBytes(m.archiveBytes)}
          </span>
        </div>
        <div className="sm-head-actions">
          <button className={`btn small${foldersOpen ? ' primary' : ''}`} onClick={() => setFoldersOpen(v => !v)}>
            <FolderCog size={13} aria-hidden="true" /> {foldersOpen ? 'Hide folders' : 'Folders'}
          </button>
        </div>
      </div>
      <div className="sm-segments">
        {segments.map(s => (
          <div className="sm-seg" key={s.key}>
            <s.icon size={15} className="sm-seg-icon" aria-hidden="true" />
            <div className="sm-seg-text">
              <span className="sm-seg-label">{s.label}</span>
              <span className="muted">{s.hint}</span>
            </div>
            {s.bytes != null && (
              <span className="sm-seg-track" aria-hidden="true">
                <span className="sm-seg-fill" style={{ width: Math.max(2, Math.round(100 * s.bytes / (total || 1))) + '%' }} />
              </span>
            )}
            <span className="sm-seg-size mono">{s.bytes != null ? fmtBytes(s.bytes) : '—'}</span>
            <button className="sm-del" title={s.title} aria-label={s.title} disabled={busy}
              onClick={() => run(s.confirm, s.action)}>
              <Trash2 size={14} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
      {err && <p className="bad-text">{err}</p>}
      {foldersOpen && <FolderManager upn={m.upn} onChanged={onChanged} />}
    </div>
  );
}

export default function StorageManager({ onClose, onChanged, onBrowse }) {
  const modalRef = useModal(useCallback(() => onClose(), [onClose]));
  const [mailboxes, setMailboxes] = useState(null);
  const [err, setErr] = useState(null);

  const load = useCallback(() => {
    api('/api/mailboxes')
      .then(rows => { setMailboxes(rows); setErr(null); onChanged(); })
      .catch(e => setErr(e.message));
  }, [onChanged]);
  useEffect(load, [load]);

  const bytes = m => (m.primaryBytes || 0) + (m.archiveBytes || 0);
  const backedUp = (mailboxes || []).filter(m => bytes(m) > 0);
  const visible = (mailboxes || [])
    .filter(m => bytes(m) > 0 || m.pstStatus)
    .sort((a, b) => bytes(b) - bytes(a));
  const totalBytes = backedUp.reduce((a, m) => a + bytes(m), 0);
  const pstCount = (mailboxes || []).filter(m => m.pstStatus).length;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box sm-modal" role="dialog" aria-modal="true" aria-label="Manage stored data" ref={modalRef} onClick={e => e.stopPropagation()}>
        <div className="modal-head sm-head">
          <span className="sm-title">
            <HardDrive size={17} aria-hidden="true" />
            <b>Manage stored data</b>
          </span>
          <span className="spacer" />
          {backedUp.length > 0 && (
            <button className="btn small primary" onClick={() => onBrowse(backedUp.map(m => m.upn))}>
              <FolderOpen size={13} aria-hidden="true" /> Open backed-up storage ({backedUp.length})
            </button>
          )}
          <button className="btn small" aria-label="Close" onClick={onClose}><X size={14} aria-hidden="true" /> Close</button>
        </div>
        <div className="modal-body">
          {mailboxes && visible.length > 0 && (
            <div className="sm-summary">
              <div className="sm-stat">
                <Database size={15} aria-hidden="true" />
                <div><b className="mono">{fmtBytes(totalBytes)}</b><span className="muted">backed up locally</span></div>
              </div>
              <div className="sm-stat">
                <Mail size={15} aria-hidden="true" />
                <div><b className="mono">{backedUp.length}</b><span className="muted">mailbox{backedUp.length === 1 ? '' : 'es'} in storage</span></div>
              </div>
              <div className="sm-stat">
                <FileBox size={15} aria-hidden="true" />
                <div><b className="mono">{pstCount}</b><span className="muted">PST export{pstCount === 1 ? '' : 's'}</span></div>
              </div>
              <p className="muted sm-note">Deleting removes local copies only — nothing is deleted from Microsoft 365.</p>
            </div>
          )}
          {err && <p className="bad-text">{err}</p>}
          {!mailboxes && !err && <p className="muted">Loading…</p>}
          {mailboxes && !visible.length && <p className="muted">No backed-up data stored yet.</p>}
          {visible.map(m => <MailboxStorage key={m.upn} m={m} onChanged={load} onBrowse={onBrowse} />)}
        </div>
      </div>
    </div>
  );
}
