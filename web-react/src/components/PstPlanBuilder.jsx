import React, { useState, useEffect, useMemo } from 'react';
import { api, post } from '../api.js';
import { fmtBytes } from '../format.js';
import { useModal } from './useModal.js';
import { ChevronRight } from 'lucide-react';

const CAP_BYTES = 49 * 1024 ** 3;
const keyOf = f => `${f.scope}/${f.path}`;

// Same tree-building approach as BackupPage.jsx
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

function PlanTreeNode({ node, depth, sel, locked, onToggle, expanded, toggleExp }) {
  const k = keyOf(node);
  const lock = locked.get(k);
  const hasKids = node.children.length > 0;
  const open = expanded.has(node.folderId);
  return (
    <>
      <div className={`plan-row${lock ? ' locked' : ''}`} style={{ paddingLeft: 6 + depth * 18 }}>
        <span
          className={`tv-indicator${open ? ' open' : ''}${hasKids ? '' : ' leaf'}`}
          onClick={() => hasKids && toggleExp(node.folderId)}
        >{hasKids ? <ChevronRight size={14} /> : null}</span>
        <input type="checkbox" checked={sel.has(k) || !!lock} disabled={!!lock}
          onChange={() => onToggle(node)} aria-label={k} />
        <span>{node.name || '(root)'}</span>
        {lock && <span className="chip info">{lock}</span>}
        <span className="sz mono">{fmtBytes(node.bytes)} · {node.backedUp}</span>
      </div>
      {open && node.children.map(c => (
        <PlanTreeNode key={c.folderId} node={c} depth={depth + 1} sel={sel} locked={locked} onToggle={onToggle} expanded={expanded} toggleExp={toggleExp} />
      ))}
    </>
  );
}

export default function PstPlanBuilder({ upn, scope, onClose }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [sel, setSel] = useState(() => new Set());
  const [parts, setParts] = useState([]);
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);
  const [expanded, setExpanded] = useState(null); // null = all expanded

  useEffect(() => {
    api('/api/mailbox/' + encodeURIComponent(upn) + '/folders').then(setData).catch(e => setErr(e.message));
  }, [upn]);

  const folders = ((data && data.folders) || []).filter(f => !scope || f.scope === scope);
  const byKey = useMemo(() => new Map(folders.map(f => [keyOf(f), f])), [folders]);

  // locked: folder key -> part name (part roots and all their descendants)
  const locked = useMemo(() => {
    const m = new Map();
    for (const f of folders) {
      const k = keyOf(f);
      for (const p of parts) {
        if (p.folders.some(r => k === r || k.startsWith(r + '/'))) { m.set(k, p.name); break; }
      }
    }
    return m;
  }, [folders, parts]);

  const descendantsOf = node => {
    const out = [];
    const walk = n => { out.push(keyOf(n)); n.children.forEach(walk); };
    walk(node);
    return out;
  };
  const toggle = node => setSel(s => {
    const n = new Set(s);
    const keys = descendantsOf(node).filter(k => !locked.has(k));
    const on = !n.has(keyOf(node));
    keys.forEach(k => on ? n.add(k) : n.delete(k));
    return n;
  });

  const selRoots = [...sel].filter(k => ![...sel].some(o => o !== k && k.startsWith(o + '/')));

  const addPart = () => {
    if (!sel.size) return;
    const conflicts = [];
    for (const r of selRoots)
      for (const p of parts)
        for (const g of p.folders)
          if (r === g || r.startsWith(g + '/') || g.startsWith(r + '/'))
            conflicts.push(`"${r}" overlaps "${g}" (already in ${p.name})`);
    if (conflicts.length) { setErr(conflicts.join('; ')); return; }
    setErr(null);
    let i = parts.length + 1;
    while (parts.some(p => p.name === `part${i}`)) i++;
    setParts([...parts, { name: `part${i}`, folders: selRoots }]);
    setSel(new Set());
  };
  const removePart = idx => setParts(parts.filter((_, i) => i !== idx));
  const renamePart = (idx, name) => setParts(parts.map((p, i) => i === idx ? { ...p, name } : p));

  const partBytes = p => p.folders.reduce((a, k) => a + ((byKey.get(k) || {}).bytes || 0), 0);

  // unassigned = minimal folder keys not covered by any part root
  const unassignedRoots = folders.map(keyOf).filter(k =>
    !parts.some(p => p.folders.some(r => k === r || k.startsWith(r + '/')))
  ).filter(k => !folders.some(f => { const o = keyOf(f); return o !== k && k.startsWith(o + '/') &&
    !parts.some(p => p.folders.some(r => o === r || o.startsWith(r + '/'))); }));
  const unassignedBytes = unassignedRoots.reduce((a, k) => a + ((byKey.get(k) || {}).bytes || 0), 0);

  const run = plan => {
    setBusy(true); setErr(null);
    post('/api/pst', plan ? { upn, plan, scope } : { upn, scope })
      .then(() => setStarted(true))
      .catch(e => setErr(e.message))
      .finally(() => setBusy(false));
  };

  const scopes = (scope ? [[scope, scope === 'archive' ? 'Online archive' : 'Primary mailbox']] : [['primary', 'Primary mailbox'], ['archive', 'Online archive']]);
  const modalRef = useModal(onClose);

  const exp = expanded === null ? new Set(folders.map(f => f.folderId)) : expanded;
  const toggleExp = id => {
    const n = new Set(exp);
    n.has(id) ? n.delete(id) : n.add(id);
    setExpanded(n);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" role="dialog" aria-modal="true" aria-label={`PST export for ${upn}`} ref={modalRef} onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h3>PST export{scope ? ` — ${scope === 'archive' ? 'Online archive' : 'Primary mailbox'}` : ''} — <span className="mono">{upn}</span></h3>
          <span className="spacer" />
          <button className="btn small" onClick={onClose}>✕ Close</button>
        </div>
        <div className="modal-body">
          {err && <p className="bad-text">{err}</p>}
          {!data && !err && <p className="muted">Loading folders…</p>}
          {started ? (
            <p>Export started — Outlook will open on the host machine. Watch the activity log and the PST column for progress.</p>
          ) : data && (
            <div className="plan-cols">
              <div>
                <div className="plan-scope-head plan-scope-bar">
                  <span>Select folders (includes subfolders)</span>
                  <span className="tree-all-btns">
                    <button type="button" className="btn small" onClick={() => setExpanded(new Set(folders.map(f => f.folderId)))}>Expand all</button>
                    <button type="button" className="btn small" onClick={() => setExpanded(new Set())}>Collapse all</button>
                  </span>
                </div>
                <div className="plan-tree">
                  {scopes.map(([scope, label]) => {
                    const rows = folders.filter(f => f.scope === scope);
                    if (!rows.length) return null;
                    return (
                      <div key={scope}>
                        <div className="plan-scope-head">{label}</div>
                        {buildTree(rows).map(n => (
                          <PlanTreeNode key={n.folderId} node={n} depth={0} sel={sel} locked={locked} onToggle={toggle} expanded={exp} toggleExp={toggleExp} />
                        ))}
                      </div>
                    );
                  })}
                  {!folders.length && <p className="muted">No folders discovered yet.</p>}
                </div>
                <div style={{ marginTop: 8 }}>
                  <button className="btn small primary" disabled={!sel.size} onClick={addPart}>
                    Add selection as Part {parts.length + 1} ({selRoots.length} folder{selRoots.length === 1 ? '' : 's'})
                  </button>
                </div>
              </div>
              <div>
                <div className="plan-scope-head">Parts (each becomes its own PST, max 49 GB per file)</div>
                {!parts.length && <p className="muted">No parts yet — select folders on the left, or export the whole mailbox below.</p>}
                {parts.map((p, i) => {
                  const bytes = partBytes(p);
                  return (
                    <div className="plan-part" key={i}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input value={p.name} onChange={e => renamePart(i, e.target.value)} aria-label="part name" />
                        <span className="muted">{p.folders.length} folder{p.folders.length === 1 ? '' : 's'} · ~{fmtBytes(bytes)}</span>
                        <span className="spacer" />
                        <button className="btn small danger" onClick={() => removePart(i)}>Remove</button>
                      </div>
                      {bytes > CAP_BYTES && <div className="plan-warn">Estimate exceeds 49 GB — this part will be split into multiple files.</div>}
                      <div className="muted mono" style={{ fontSize: 11, marginTop: 4 }}>{p.folders.join(' · ')}</div>
                    </div>
                  );
                })}
                <p className="muted" style={{ fontSize: 12 }}>
                  Not covered by any part: {unassignedRoots.length} folder{unassignedRoots.length === 1 ? '' : 's'} (~{fmtBytes(unassignedBytes)}). Export with gaps is allowed.
                </p>
              </div>
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn primary" disabled={busy || started || !parts.length}
            onClick={() => run(parts.map(p => ({ name: p.name, folders: p.folders })))}>
            Export plan ({parts.length} part{parts.length === 1 ? '' : 's'})
          </button>
          <button className="btn" disabled={busy || started} onClick={() => run(null)}>Export whole {scope === 'archive' ? 'archive' : scope === 'primary' ? 'primary' : 'mailbox'} (no plan)</button>
          {busy && <span className="muted">Starting…</span>}
        </div>
      </div>
    </div>
  );
}
