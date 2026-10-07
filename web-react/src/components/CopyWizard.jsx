import React, { useState, useEffect, useMemo } from 'react';
import { api, post } from '../api.js';
import { fmtBytes } from '../format.js';
import { ChevronRight, FolderOpen, FolderClosed } from 'lucide-react';

// Same tree shape as the backup view (browse.jsx): parent/child folders with
// expand/collapse, plus a checkbox per folder for copy/move selection.
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

function CopyTreeNode({ node, expanded, toggleExp, selected, onToggleSel }) {
  const open = expanded.has(node.folderId);
  const hasKids = node.children.length > 0;
  // Selection toggles this folder plus every selectable descendant.
  const desc = [];
  const walk = n => { if (n.backedUp > 0) desc.push(n.scope + ':' + n.folderId); n.children.forEach(walk); };
  walk(node);
  const picked = desc.filter(k => selected.has(k)).length;
  const checked = desc.length > 0 && picked === desc.length;
  const indet = picked > 0 && picked < desc.length;
  return (
    <>
      <div className="tv-control tree-row" role="treeitem" aria-expanded={hasKids ? open : undefined}>
        <span
          className={`tv-indicator${open ? ' open' : ''}${hasKids ? '' : ' leaf'}`}
          onClick={() => hasKids && toggleExp(node.folderId)}
        >{hasKids ? <ChevronRight size={14} /> : null}</span>
        <label className="tv-text copy-tree-label" onClick={e => e.stopPropagation()}>
          <input
            type="checkbox"
            disabled={!desc.length}
            checked={checked}
            ref={el => { if (el) el.indeterminate = indet; }}
            onChange={() => onToggleSel(desc, !checked)}
          />
          {hasKids
            ? (open ? <FolderOpen size={15} className="tv-icon" /> : <FolderClosed size={15} className="tv-icon" />)
            : <FolderClosed size={14} className="tv-icon tv-leaf-icon" />}
          <span className="tree-name">{node.name || '(root)'}</span>
        </label>
        <span className="tv-stats mono">{node.backedUp}</span>
      </div>
      {open && hasKids && (
        <div className="tv-branch-content tree-kids">
          {node.children.map(c => (
            <CopyTreeNode key={c.folderId} node={c} expanded={expanded} toggleExp={toggleExp}
              selected={selected} onToggleSel={onToggleSel} />
          ))}
        </div>
      )}
    </>
  );
}

function CopyScopeTree({ label, rows, flattenRoot, selected, onToggleSel, onSetAll }) {
  const [expanded, setExpanded] = useState(() => new Set(rows.map(r => r.folderId)));
  const toggleExp = id => setExpanded(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  if (!rows.length) return null;
  let roots = buildTree(rows);
  if (flattenRoot && roots.length === 1 && roots[0].children.length) roots = roots[0].children;
  const keys = rows.filter(r => r.backedUp > 0).map(r => r.scope + ':' + r.folderId);
  const picked = keys.filter(k => selected.has(k)).length;
  const allChecked = keys.length > 0 && picked === keys.length;
  const indet = picked > 0 && picked < keys.length;
  return (
    <div className="scope-tree">
      <div className="scope-head">
        <label className="copy-tree-label copy-select-all">
          <input
            type="checkbox"
            disabled={!keys.length}
            checked={allChecked}
            ref={el => { if (el) el.indeterminate = indet; }}
            onChange={() => onSetAll(keys, !allChecked)}
          />
          {label && <b>{label}</b>}
        </label>
        <span className="muted">{picked}/{keys.length} folders selected</span>
        <span className="tree-all-btns">
          <button type="button" className="btn small" onClick={() => setExpanded(new Set(rows.map(r => r.folderId)))}>Expand all</button>
          <button type="button" className="btn small" onClick={() => setExpanded(new Set())}>Collapse all</button>
        </span>
      </div>
      <div className="tree">
        {roots.map(n => <CopyTreeNode key={n.folderId} node={n} expanded={expanded} toggleExp={toggleExp}
          selected={selected} onToggleSel={onToggleSel} />)}
      </div>
    </div>
  );
}

// Copy/move downloaded items of one mailbox into another live M365 mailbox.
// Source is always the local backup store; the target is any mailbox in the tenant.
export default function CopyWizard({ srcUpn, folders, onClose }) {
  const [mailboxes, setMailboxes] = useState([]);
  const [dstUpn, setDstUpn] = useState('');
  const [mode, setMode] = useState('copy');
  const [prefix, setPrefix] = useState(`Restored from ${srcUpn}`);
  const [selected, setSelected] = useState(() => new Set((folders || []).filter(f => f.backedUp > 0).map(f => f.scope + ':' + f.folderId)));
  const [step, setStep] = useState(1); // 1 configure, 2 confirm, 3 running/done
  const [err, setErr] = useState(null);
  const [job, setJob] = useState(null);

  useEffect(() => { api('/api/mailboxes').then(setMailboxes).catch(() => {}); }, []);
  useEffect(() => {
    if (!job || !job.jobId) return;
    const t = setInterval(() => {
      api('/api/copy/' + job.jobId).then(setJob).catch(() => {});
    }, 2000);
    return () => clearInterval(t);
  }, [job && job.jobId]);

  const selectable = useMemo(() => (folders || []).filter(f => f.backedUp > 0), [folders]);
  const totals = useMemo(() => {
    const sel = selectable.filter(f => selected.has(f.scope + ':' + f.folderId));
    return { folders: sel.length, items: sel.reduce((a, f) => a + f.backedUp, 0), bytes: sel.reduce((a, f) => a + (f.bytes || 0), 0) };
  }, [selectable, selected]);
  const dstValid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(dstUpn) && dstUpn !== srcUpn;

  const toggleMany = (keys, add) => setSelected(s => { const n = new Set(s); keys.forEach(k => add ? n.add(k) : n.delete(k)); return n; });

  const start = () => {
    setErr(null);
    post('/api/copy', { srcUpn, dstUpn, folderKeys: [...selected], mode, prefix })
      .then(j => { setJob(j); setStep(3); })
      .catch(e => setErr(e.message));
  };

  const running = job && job.job && job.job.status === 'running';
  const report = job && job.report;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card settings-card" role="dialog" aria-modal="true" aria-label={`Copy ${srcUpn} to another mailbox`} onClick={e => e.stopPropagation()}>
        <div className="settings-head">
          <h3>Copy / move to mailbox</h3>
          <button className="log-iconbtn" title="Close" aria-label="Close" onClick={onClose} disabled={running}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>

        {step === 1 && (
          <>
            <section className="settings-section">
              <h4>Source (local backup)</h4>
              <div className="settings-label mono">{srcUpn}</div>
              <p className="settings-hint">{totals.items} item(s) selected · {fmtBytes(totals.bytes)} across {totals.folders} folder(s)</p>
              <div className="copy-folderlist">
                <CopyScopeTree label="Primary" rows={(folders || []).filter(f => f.scope !== 'archive')}
                  selected={selected} onToggleSel={toggleMany} onSetAll={toggleMany} />
                <CopyScopeTree label="Archive" rows={(folders || []).filter(f => f.scope === 'archive')} flattenRoot
                  selected={selected} onToggleSel={toggleMany} onSetAll={toggleMany} />
                {!selectable.length && <p className="settings-hint">No downloaded folders yet — run a backup first.</p>}
              </div>
            </section>
            <section className="settings-section">
              <h4>Target mailbox (live)</h4>
              <input
                className="confirm-input"
                list="copy-targets"
                placeholder="user@tenant.com"
                value={dstUpn}
                onChange={e => setDstUpn(e.target.value.trim().toLowerCase())}
                aria-label="Target mailbox"
              />
              <datalist id="copy-targets">
                {mailboxes.filter(m => m.upn !== srcUpn).map(m => <option key={m.upn} value={m.upn} />)}
              </datalist>
              <div className="settings-row" style={{ marginTop: 10 }}>
                <div>
                  <div className="settings-label">Target folder</div>
                  <p className="settings-hint">Source folders are recreated under this folder.</p>
                </div>
                <input className="confirm-input" style={{ maxWidth: 220 }} value={prefix} onChange={e => setPrefix(e.target.value)} aria-label="Target folder prefix" />
              </div>
              <div className="settings-row" style={{ marginTop: 10 }}>
                <div>
                  <div className="settings-label">Mode</div>
                  <p className="settings-hint">Move removes the local copy after a verified upload (kept in the graveyard, recoverable).</p>
                </div>
                <div className="theme-switch" role="group" aria-label="Copy mode">
                  <button className={`theme-opt${mode === 'copy' ? ' active' : ''}`} aria-pressed={mode === 'copy'} onClick={() => setMode('copy')}>Copy</button>
                  <button className={`theme-opt${mode === 'move' ? ' active' : ''}`} aria-pressed={mode === 'move'} onClick={() => setMode('move')}>Move</button>
                </div>
              </div>
            </section>
            {err && <p className="bad-text" style={{ padding: '0 18px' }}>{err}</p>}
            <div className="confirm-actions" style={{ padding: '0 18px 16px' }}>
              <button className="btn" onClick={onClose}>Cancel</button>
              <button className="btn primary" disabled={!dstValid || !totals.items} onClick={() => setStep(2)}>Review</button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <section className="settings-section">
              <h4>Confirm</h4>
              <p className="settings-hint" style={{ fontSize: 13 }}>
                {mode === 'move' ? 'Move' : 'Copy'} <b>{totals.items}</b> item(s) ({fmtBytes(totals.bytes)}) from the local backup of <b className="mono">{srcUpn}</b> into the live mailbox <b className="mono">{dstUpn}</b>, under <b>{prefix || 'mailbox root'}</b>.
              </p>
              <p className="settings-hint">This writes to a live Microsoft 365 mailbox. Each uploaded item is verified to exist; a sample is re-downloaded and hash-checked. {mode === 'move' ? 'Source files move to the local graveyard only after a verified upload.' : 'The local backup stays untouched.'}</p>
            </section>
            {err && <p className="bad-text" style={{ padding: '0 18px' }}>{err}</p>}
            <div className="confirm-actions" style={{ padding: '0 18px 16px' }}>
              <button className="btn" onClick={() => setStep(1)}>Back</button>
              <button className="btn primary" onClick={start}>Start {mode}</button>
            </div>
          </>
        )}

        {step === 3 && job && (
          <>
            <section className="settings-section">
              <h4>{running ? 'Running' : 'Result'}</h4>
              <p className="settings-hint" style={{ fontSize: 13 }}>{job.job ? job.job.detail : 'starting…'}</p>
              {job.job && (
                <div className="bar" style={{ marginTop: 8 }}>
                  <div className="fill" style={{ width: (job.job.total ? Math.round(100 * job.job.done / job.job.total) : 0) + '%' }} />
                </div>
              )}
              {report && !running && (
                <div style={{ marginTop: 10 }}>
                  <p className="settings-hint">
                    {report.uploaded} uploaded · {report.verified} verified · {report.failed} failed · {fmtBytes(report.bytes)}
                  </p>
                  {report.failures.slice(0, 8).map((f, i) => (
                    <p key={i} className="settings-hint bad-text">{f.folderPath}: {f.note}</p>
                  ))}
                  {report.mismatches.slice(0, 8).map((f, i) => (
                    <p key={i} className="settings-hint">{f.folderPath}: {f.note}</p>
                  ))}
                </div>
              )}
              {running && <p className="settings-hint">Use the dashboard Stop button to abort; already-uploaded items stay in the target mailbox.</p>}
            </section>
            <div className="confirm-actions" style={{ padding: '0 18px 16px' }}>
              <button className="btn" onClick={onClose} disabled={running}>{running ? 'Close when finished' : 'Close'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
