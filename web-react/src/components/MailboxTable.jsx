import React, { useState, useMemo, useCallback } from 'react';
import { fmtBytes, fmtDate } from '../format.js';
import { Search, User, Users, Globe, Check, Wrench } from 'lucide-react';
import { post } from '../api.js';

const chipClass = s => ({ done: 'done', partial: 'partial', error: 'error', pending: 'pending', syncing: 'syncing' }[s] || 'none');
const covDotClass = s => s === 'COMPLETE_VERIFIED' ? 'cov-green'
  : s === 'PARTIAL' || s === 'COMPLETE_UNVERIFIED' ? 'cov-amber'
  : s === 'BLOCKED' || s === 'FAILED' ? 'cov-red' : 'cov-gray';
const covTooltips = {
  COMPLETE_VERIFIED: 'fully backed up and verified',
  COMPLETE_UNVERIFIED: 'fully backed up, not yet verified',
  PARTIAL: 'not all server data is backed up',
  BLOCKED: 'backup blocked (e.g. unreachable archive partitions)',
  FAILED: 'backup failed'
};
const covTooltip = s => `Coverage: ${s} — ${covTooltips[s] || 'no coverage data yet'}`;
const typeIcon = { user: User, shared: Users, guest: Globe };
// Zero-byte cells render as a quiet dash — real numbers stand out.
const zb = n => (n || 0) > 0 ? fmtBytes(n) : <span className="muted">—</span>;

// Mirrors lib/store.js aggregates() status logic and the type split in App.jsx.
const statFilterFns = {
  user: m => m.type === 'user',
  done: m => m.status === 'done',
  partial: m => m.status === 'partial' || m.status === 'syncing',
  error: m => m.status === 'error',
  bytes: m => (m.primaryBytes || 0) + (m.archiveBytes || 0) > 0
};
const statFilterLabels = {
  user: 'Licensed', done: 'Fully backed up',
  partial: 'Partial (pending)', error: 'Errors', bytes: 'Backed up (primary + archive)'
};

function SortTh({ k, className, sortKey, sortDir, onToggleSort, title, rowSpan, children }) {
  const ariaSort = sortKey !== k ? 'none' : (sortDir === 1 ? 'ascending' : 'descending');
  const arrow = sortKey === k ? (sortDir === 1 ? ' ▲' : ' ▼') : '';
  return (
    <th className={`${className} sortable`} aria-sort={ariaSort} title={title} rowSpan={rowSpan}>
      <button type="button" className="th-sort" onClick={() => onToggleSort(k)}>{children}{arrow}</button>
    </th>
  );
}

const exoSrc = <sup className="size-src" title="Authoritative size from Exchange Online">EXO</sup>;

// EWS sees only the main partition of auto-expanding archives; EXO reports the true total.
function archiveWarning(m) {
  const gap = m.sizeSource === 'exo' && m.ewsArchiveBytes != null && m.serverArchiveBytes != null
    && (m.serverArchiveBytes - m.ewsArchiveBytes) > Math.max(1024 ** 3, 0.05 * m.serverArchiveBytes);
  if (!m.autoExpandingArchive && !gap) return null;
  const total = `Auto-expanding archive: ${fmtBytes(m.serverArchiveBytes)} total per Exchange`;
  return m.ewsArchiveBytes != null
    ? `${total}, but only ${fmtBytes(m.ewsArchiveBytes)} is accessible to the backup API (Microsoft limitation). Backup covers the accessible portion.`
    : `${total}. Backup covers the portion accessible to the backup API (Microsoft limitation).`;
}

function MailboxRowInner({ m, pstJob, fixTask, onDetail, onAct, onBackup, onView, onPlan, onFixGaps, busy, selected, onToggle }) {
  const warn = archiveWarning(m);
  return (
    <tr className={selected ? 'selected' : ''}>
      <td className="col-check"><input type="checkbox" checked={selected} onChange={() => onToggle(m.upn)} aria-label={`Select ${m.upn}`} /></td>
      <td className="col-mailbox"><a className="mono" title="Open backed-up storage" href={'/?mailbox=' + encodeURIComponent(m.upn)}>{m.upn}</a></td>
      <td className="mono col-type">
        {(() => { const I = typeIcon[m.type] || User; return <span className="type-cell"><I size={13} aria-hidden="true" />{m.type}</span>; })()}
      </td>
      <td className="col-status col-archflag" title={m.hasArchive == null ? 'Unknown — run Fetch Sizes to detect' : m.hasArchive ? 'Online archive present' : 'No online archive'}>
        {m.hasArchive ? <Check size={15} className="arch-yes" aria-label="Has online archive" /> : <span className="muted">—</span>}
      </td>
      <td className="col-num grp-sep" title={m.serverSizeAt ? `Fetched ${fmtDate(m.serverSizeAt)}` : 'Not fetched yet — run Fetch Sizes'}>{m.serverPrimaryBytes == null ? '—' : fmtBytes(m.serverPrimaryBytes)}{m.sizeSource === 'exo' && m.serverPrimaryBytes != null ? exoSrc : null}</td>
      <td className="col-num">{m.serverArchiveBytes == null ? '—' : fmtBytes(m.serverArchiveBytes)}{m.sizeSource === 'exo' && m.serverArchiveBytes != null ? exoSrc : null}{warn ? <span className="chip partial size-warn" role="img" aria-label={warn} title={warn}>!</span> : null}</td>
      <td className="col-num"><strong>{m.serverPrimaryBytes == null && m.serverArchiveBytes == null ? '—' : fmtBytes((m.serverPrimaryBytes || 0) + (m.serverArchiveBytes || 0))}</strong></td>
      <td className="col-num grp-sep" title={`Primary ${fmtBytes(m.primaryBytes)} / archive ${fmtBytes(m.archiveBytes)}`}>{zb(m.primaryBytes)}</td>
      <td className="col-num">{zb(m.archiveBytes)}</td>
      <td className="col-status grp-sep"><span className={`chip ${chipClass(m.status)} clickable`} title="Mailbox details" onClick={() => onDetail(m.upn)}><i className="sdot" />{m.status}</span>{m.coverageState ? <span className={`covdot ${covDotClass(m.coverageState)}`} role="img" aria-label={`Coverage: ${m.coverageState}`} title={covTooltip(m.coverageState)} /> : null}</td>
      <td className="col-status">{m.verifyOk == null ? '—' : m.verifyOk
        ? <span className="chip ok"><i className="sdot" />Passed {fmtDate(m.verifyAt)}</span>
        : <button className="chip bad clickable fixgaps" disabled={!!fixTask || busy}
            title={fixTask
              ? `Fix-gaps task is ${fixTask.status} — see the Running tasks panel`
              : 'Queue a background fix: verify resets the sync cursors, then a backup re-scan fills the gaps. Runs alongside your other work.'}
            onClick={() => onFixGaps(m.upn)}>
            {fixTask
              ? { queued: 'Queued', waiting: 'Waiting…', verify: 'Verifying…', backup: 'Backing up…' }[fixTask.status] || fixTask.status
              : <><Wrench size={11} aria-hidden="true" /> Fix gaps</>}
          </button>}</td>
      <td className="mono col-status">
        {m.pstStatus === 'running' && pstJob
          ? <span className="chip info chip-pulse">running {pstJob.done}/{pstJob.total}{pstJob.total ? ` (${Math.round(100 * pstJob.done / pstJob.total)}%)` : ''}</span>
          : (m.pstStatus || 'none')}
      </td>
      <td className="col-actions">
        <span className="btn-row">
          <button className="btn small" title={busy ? 'A job is running — this backup will be queued and start when it finishes' : undefined} onClick={() => onBackup([m.upn])}>Backup</button>
          {m.hasArchive === 1 && (
            <button className="btn small" title={busy ? 'A job is running — this archive backup will be queued' : 'Back up only the online archive'} onClick={() => onBackup([m.upn], 'archive')}>Archive</button>
          )}
          <button className="btn small" title={busy ? 'A job is running — this verify will be queued' : undefined} onClick={() => onAct('/api/verify', m.upn)}>Verify</button>
          <button className="btn small" onClick={() => onPlan(m.upn)}>PST</button>
        </span>
      </td>
    </tr>
  );
}
const MailboxRow = React.memo(MailboxRowInner);

export default function MailboxTable({ mailboxes, busy, sizesBusy, scanBusy, pstJob, fixTasks, onDetail, onAct, onBackup, onSizes, onScan, onView, onPlan, statFilter, onClearFilter, showShared, showGuests }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(() => new Set());
  const [starting, setStarting] = useState(false);
  const [sortKey, setSortKey] = useState('status');
  const [sortDir, setSortDir] = useState(1); // status sort: 1 = active states on top, pending pinned to bottom

  // Gap repair runs as a server-side background task (verify → backup) that
  // queues behind whatever the engine is doing — no client-side waiting.
  const fixGaps = async upn => {
    try { await post('/api/fix-gaps', { upn }); }
    catch (e) { window.alert(`Fix gaps failed for ${upn}: ${e.message}`); }
  };

  const statusRank = s => ({ syncing: 0, partial: 1, error: 2, 'failed-final': 3, skipped: 4, done: 5 }[s] ?? 6);
  // Backup column: not a plain asc/desc — pending is pinned to one end
  // (sortDir 1 = bottom, -1 = top), all other statuses stay grouped in rank order.
  const statusCmp = (a, b, dir) => {
    const ap = a.status === 'pending', bp = b.status === 'pending';
    if (ap !== bp) return ap ? dir : -dir;
    return statusRank(a.status) - statusRank(b.status);
  };
  const sortVal = (m, k) => ({
    upn: m.upn, type: m.type,
    archive: m.hasArchive == null ? -1 : m.hasArchive,
    serverPrimaryBytes: m.serverPrimaryBytes == null ? -1 : m.serverPrimaryBytes,
    serverArchiveBytes: m.serverArchiveBytes == null ? -1 : m.serverArchiveBytes,
    serverTotalBytes: (m.serverPrimaryBytes == null && m.serverArchiveBytes == null) ? -1 : (m.serverPrimaryBytes || 0) + (m.serverArchiveBytes || 0),
    backedUpBytes: (m.primaryBytes || 0) + (m.archiveBytes || 0),
    status: statusRank(m.status), verified: m.verifyOk == null ? -1 : m.verifyOk ? 1 : 0, pst: m.pstStatus || ''
  }[k]);
  const toggleSort = k => {
    if (sortKey === k) setSortDir(d => -d);
    else { setSortKey(k); setSortDir(k.endsWith('Bytes') ? -1 : 1); }
  };

  const filtered = useMemo(() => mailboxes
    .filter(m => (m.type !== 'shared' || showShared) && (m.type !== 'guest' || showGuests))
    .filter(statFilter ? statFilterFns[statFilter] : () => true)
    .filter(m => !q || m.upn.toLowerCase().includes(q.toLowerCase()))
    .slice()
    .sort((a, b) => {
      const c = sortKey === 'status'
        ? statusCmp(a, b, sortDir)
        : (() => {
            const va = sortVal(a, sortKey), vb = sortVal(b, sortKey);
            return (typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb))) * sortDir;
          })();
      return c || a.upn.localeCompare(b.upn);
    }), [mailboxes, showShared, showGuests, statFilter, q, sortKey, sortDir]);
  const toggleSel = useCallback(upn => setSel(s => { const n = new Set(s); n.has(upn) ? n.delete(upn) : n.add(upn); return n; }), []);
  const allFilteredSel = filtered.length > 0 && filtered.every(m => sel.has(m.upn));
  const toggleAllFiltered = () => setSel(s => {
    const n = new Set(s);
    if (allFilteredSel) filtered.forEach(m => n.delete(m.upn)); else filtered.forEach(m => n.add(m.upn));
    return n;
  });
  const backupSelected = async () => {
    if (!sel.size || starting) return;
    setStarting(true);
    try { await onBackup([...sel]); } finally { setStarting(false); }
  };
  const selArchiveUpns = mailboxes.filter(m => sel.has(m.upn) && m.hasArchive === 1).map(m => m.upn);
  const backupSelectedArchive = async () => {
    if (!selArchiveUpns.length || starting) return;
    setStarting(true);
    try { await onBackup(selArchiveUpns, 'archive'); } finally { setStarting(false); }
  };
  const sizesSelected = async () => {
    if (!sel.size || starting) return;
    setStarting(true);
    try { await onSizes([...sel]); } finally { setStarting(false); }
  };
  const scanSelected = async () => {
    if (!sel.size || starting) return;
    setStarting(true);
    try { await onScan([...sel]); } finally { setStarting(false); }
  };

  return (
    <section className="tablewrap card">
      <div className="toolbar">
        <span className="search-wrap">
          <Search size={14} aria-hidden="true" />
          <input className="search" aria-label="Search mailboxes" placeholder={`Search ${mailboxes.length} mailboxes…`} value={q} onChange={e => setQ(e.target.value)} />
        </span>
        {q && <span className="muted">{filtered.length} match</span>}
        {statFilter && (
          <span className="filter-tag">
            Filter: {statFilterLabels[statFilter]} · <a href="#" onClick={e => { e.preventDefault(); onClearFilter(); }}>clear</a>
          </span>
        )}
        <span className="spacer" />
        <span className={`sel-pill${sel.size ? ' on' : ''}`}>{sel.size} selected</span>
        <button className="btn small primary" disabled={starting || !sel.size} title={busy ? 'A job is running — selected backups will be queued' : undefined} onClick={backupSelected}>Backup Selected</button>
        <button className="btn small" disabled={sizesBusy || starting || !sel.size} title="Fetch sizes for the selected mailboxes — authoritative Exchange Online totals plus the API-accessible archive portion" onClick={sizesSelected}>Fetch Sizes Selected</button>
        <button className="btn small" disabled={scanBusy || starting || !sel.size} title="Re-count the emails on the server for the selected mailboxes (no download) — refreshes the 'X / Y emails' totals" onClick={scanSelected}>Scan Selected</button>
        <button className="btn small" disabled={starting || !selArchiveUpns.length}
          title={selArchiveUpns.length ? `Back up only the online archive of ${selArchiveUpns.length} selected mailbox(es)` : 'No selected mailbox has a detected archive — run Fetch Sizes first'}
          onClick={backupSelectedArchive}>Archive Only ({selArchiveUpns.length})</button>
      </div>
      <div className="list-scroll">
        <table>
          <thead>
            <tr className="grp">
              <th className="col-check" rowSpan={2}><input type="checkbox" checked={allFilteredSel} onChange={toggleAllFiltered} title="Select all matching" aria-label="Select all matching mailboxes" /></th>
              <SortTh k="upn" className="col-mailbox" rowSpan={2} sortKey={sortKey} sortDir={sortDir} onToggleSort={toggleSort}>Mailbox</SortTh>
              <SortTh k="type" className="col-type" rowSpan={2} sortKey={sortKey} sortDir={sortDir} onToggleSort={toggleSort}>Type</SortTh>
              <SortTh k="archive" className="col-status" rowSpan={2} sortKey={sortKey} sortDir={sortDir} onToggleSort={toggleSort}>Archive</SortTh>
              <th className="col-num grp-sep" colSpan={3}>Exchange size (server)</th>
              <th className="col-num grp-sep" colSpan={2}>Stored locally</th>
              <SortTh k="status" className="col-status grp-sep" rowSpan={2} sortKey={sortKey} sortDir={sortDir} onToggleSort={toggleSort}>Backup</SortTh>
              <SortTh k="verified" className="col-status" rowSpan={2} sortKey={sortKey} sortDir={sortDir} onToggleSort={toggleSort}>Verified</SortTh>
              <SortTh k="pst" className="col-status" rowSpan={2} sortKey={sortKey} sortDir={sortDir} onToggleSort={toggleSort}>PST</SortTh>
              <th className="col-actions" rowSpan={2}>Actions</th>
            </tr>
            <tr className="cols">
              <SortTh k="serverPrimaryBytes" className="col-num grp-sep" sortKey={sortKey} sortDir={sortDir} onToggleSort={toggleSort} title="Best-known size from Exchange. EXO-marked values are authoritative (Exchange Online); unmarked values come from EWS, which sees only the API-accessible portion.">Mailbox</SortTh>
              <SortTh k="serverArchiveBytes" className="col-num" sortKey={sortKey} sortDir={sortDir} onToggleSort={toggleSort} title="Archive size from Exchange. EXO-marked values are authoritative (full auto-expanding archive); EWS values cover only the API-accessible portion.">Archive</SortTh>
              <SortTh k="serverTotalBytes" className="col-num" sortKey={sortKey} sortDir={sortDir} onToggleSort={toggleSort}>Total</SortTh>
              <SortTh k="backedUpBytes" className="col-num grp-sep" sortKey={sortKey} sortDir={sortDir} onToggleSort={toggleSort} title="Total backed up (primary + archive) — click to sort">Primary</SortTh>
              <th className="col-num" title="Archive backed up">Archive</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(m => <MailboxRow key={m.upn} m={m} busy={busy} pstJob={pstJob} fixTask={(fixTasks || []).find(t => t.upn === m.upn && ['queued', 'waiting', 'verify', 'backup'].includes(t.status))} onDetail={onDetail} onAct={onAct} onBackup={onBackup} onView={onView} onPlan={onPlan} onFixGaps={fixGaps} selected={sel.has(m.upn)} onToggle={toggleSel} />)}
          </tbody>
        </table>
      </div>
    </section>
  );
}
