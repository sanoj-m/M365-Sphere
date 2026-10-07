import React, { useState, useEffect, useCallback, useRef } from 'react';
import { api, del, post } from '../api.js';
import { fmtTime, fmtBytes, fmtDateTime } from '../format.js';
import { ScopePanel } from './browse.jsx';
import CopyWizard from './CopyWizard.jsx';
import DedupeModal from './DedupeModal.jsx';
import PstPlanBuilder from './PstPlanBuilder.jsx';

const chipClass = s => ({ done: 'done', partial: 'partial', error: 'error', pending: 'pending', syncing: 'syncing' }[s] || 'none');
const covChipClass = s => ({ COMPLETE_VERIFIED: 'done', COMPLETE_UNVERIFIED: 'syncing', PARTIAL: 'partial', BLOCKED: 'error', FAILED: 'error' }[s] || '');

export default function MailboxPage({ upn }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [logOpen, setLogOpen] = useState(false);
  const [busyScope, setBusyScope] = useState(null);
  const [copyOpen, setCopyOpen] = useState(false);
  const [dedupeOpen, setDedupeOpen] = useState(false);
  const [pstMenuOpen, setPstMenuOpen] = useState(false);
  const [pstBusy, setPstBusy] = useState(false);
  const [exoBusy, setExoBusy] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [planScope, setPlanScope] = useState(null); // 'primary' | 'archive' | null
  const [guideOpen, setGuideOpen] = useState(false);

  useEffect(() => {
    document.title = `M365Sphere — ${upn}`;
    return () => { document.title = 'M365Sphere'; };
  }, [upn]);

  const load = useCallback(() => {
    Promise.all([
      api('/api/mailbox/' + encodeURIComponent(upn) + '/folders'),
      api('/api/mailbox/' + encodeURIComponent(upn)),
      api('/api/mailbox/' + encodeURIComponent(upn) + '/coverage').catch(() => null),
      api('/api/mailbox/' + encodeURIComponent(upn) + '/pst-repair').catch(() => null)
    ])
      .then(([f, m, cov, pr]) => { setD({ ...f, mailbox: m, coverage: cov, pstRepair: pr }); setErr(null); })
      .catch(e => setErr(e.message));
  }, [upn]);
  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  const folders = (d && d.folders) || [];
  const primary = folders.filter(f => f.scope === 'primary');
  const archive = folders.filter(f => f.scope === 'archive');
  const events = (d && d.mailbox && d.mailbox.events) || [];
  const logRef = useRef(null);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  const syncing = !!d && d.status === 'syncing';
  const hasData = folders.some(f => f.backedUp > 0);
  const liveScope = d && d.live && d.live.scope;

  const startBackup = async scope => {
    setBusyScope(scope);
    try { await post('/api/backup', { upn, scope }); load(); }
    catch (e) { setErr(e.message); }
    finally { setBusyScope(null); }
  };

  const exportPst = async scope => {
    setPstMenuOpen(false); setPstBusy(true);
    try {
      await post('/api/pst', scope ? { upn, scope } : { upn });
      load();
    } catch (e) { setErr(e.message); }
    finally { setPstBusy(false); }
  };

  const stopBackup = async scope => {
    setBusyScope(scope);
    try { await post('/api/stop', { scope, upn }); }
    catch (e) { setErr(e.message); }
    load();
    setBusyScope(null);
  };

  const startExoExport = async () => {
    setExoBusy(true);
    try { await post('/api/exo-export', { upn }); load(); }
    catch (e) { setErr(e.message); }
    finally { setExoBusy(false); }
  };

  const startExoIngest = async () => {
    setExoBusy(true);
    try { await post('/api/exo-ingest', { upn }); load(); }
    catch (e) { setErr(e.message); }
    finally { setExoBusy(false); }
  };

  const startScan = async scope => {
    setScanBusy(scope);
    try { await post('/api/scan', { upn, scope }); load(); }
    catch (e) { setErr(e.message); }
    finally { setScanBusy(null); }
  };

  const scopeActions = scope => (
    <>
      <button className="btn small" disabled={scanBusy === scope || syncing} title={syncing ? 'A backup is already running' : `Re-count the ${scope === 'archive' ? 'archive' : 'primary'} emails on the server (no download) — refreshes the 'X / Y emails' totals`} onClick={() => startScan(scope)}>{scanBusy === scope ? 'Starting…' : 'Scan'}</button>
      {liveScope === scope
        ? <button className="btn small danger" disabled={busyScope === scope} onClick={() => stopBackup(scope)}>Stop backup</button>
        : <button className="btn small" disabled={busyScope === scope || syncing} title={syncing ? 'A backup is already running' : undefined} onClick={() => startBackup(scope)}>Start backup</button>}
      {scope === 'archive' && (
        <>
          <button className="btn small" disabled={busyScope === scope || syncing}
            title="Download browsable .eml copies of the main archive partition via EWS (auxiliary partitions are invisible to EWS — use Import archive PSTs for those). Merges into the same folder tree afterwards."
            onClick={async () => { setBusyScope(scope); try { await post('/api/backup', { upn, scope: 'archive', provider: 'ews' }); load(); } catch (e) { setErr(e.message); } finally { setBusyScope(null); } }}>
            Browsable copies (EWS)
          </button>
          <button className="btn small" disabled={exoBusy || syncing}
            title="Import PST files you exported manually (Purview portal — free) into this archive: drop them into data/exo-export/<this mailbox>/ and click; every email appears in this archive's folder tree, browsable with attachments"
            onClick={startExoIngest}>
            {exoBusy ? 'Starting…' : 'Import archive PSTs'}
          </button>
        </>
      )}
      <button className="btn small" disabled={!hasData}
        title={hasData ? `Export downloaded ${scope === 'archive' ? 'archive' : 'primary'} emails to PST — pick folders from the tree, split into parts` : 'No downloaded emails yet — run a backup first'}
        onClick={() => setPlanScope(scope)}>
        Export PST…
      </button>
    </>
  );

  return (
    <div className="mailbox-page">
      <header className="mailbox-page-head">
        <a className="brand" href="/" title="Go to homepage">
          <img className="brand-icon" src="/logo.png" alt="M365Sphere logo" />
          <h1>M365Sphere</h1>
        </a>
        <h2 className="mono">{upn}</h2>
        {d && <span className={`chip ${chipClass(d.status)}`}>{d.status}</span>}
        {d && d.pstStatus ? <span className="chip info">PST: {d.pstStatus}</span> : null}
        <span className="spacer" />
        {d && <a className="btn small" href={`/?compare=${encodeURIComponent(upn)}`} title="Compare the local backup with the live mailbox side by side and copy/move individual emails between them">Compare</a>}
        {d && <button className="btn small" disabled={!hasData} title={hasData ? 'Copy or move downloaded emails into another live mailbox (works while a backup runs)' : 'No downloaded emails yet — run a backup first'} onClick={() => setCopyOpen(true)}>Copy to mailbox…</button>}
        {d && <button className="btn small" title="Find and move aside duplicate emails (local backup or live mailbox)" onClick={() => setDedupeOpen(true)}>Dedupe…</button>}
        {d && (d.mailbox.hasArchive || (d.mailbox.serverArchiveBytes || 0) > 0) && (
          <button className="btn small" disabled={exoBusy} title="Export the FULL mailbox (incl. the complete online archive, incl. auto-expanding partitions) to local PSTs via compliance search — needs Purview pay-as-you-go billing on standard tenants" onClick={startExoExport}>{exoBusy ? 'Starting…' : 'EXO export (full archive)'}</button>
        )}
        {d && (
          <span className="pstmenu-wrap">
            <button className="btn small" disabled={pstBusy || !hasData} title={hasData ? 'Export downloaded emails to PST' : 'No downloaded emails yet — run a backup first'} onClick={() => setPstMenuOpen(v => !v)}>{pstBusy ? 'Starting…' : 'Export PST…'}</button>
            {pstMenuOpen && (
              <span className="pstmenu" role="menu">
                <button className="pstmenu-item" role="menuitem" disabled={!hasData} onClick={() => { setPstMenuOpen(false); setPlanOpen(true); }}>Choose folders &amp; parts…</button>
                <button className="pstmenu-item" role="menuitem" disabled={!primary.some(f => f.backedUp > 0)} onClick={() => exportPst('primary')}>Primary mailbox only (whole scope)</button>
                <button className="pstmenu-item" role="menuitem" disabled={!archive.some(f => f.backedUp > 0)} onClick={() => exportPst('archive')}>Online archive only (whole scope)</button>
                <button className="pstmenu-item" role="menuitem" onClick={() => exportPst(null)}>Both (full mailbox)</button>
              </span>
            )}
          </span>
        )}
        <a className="btn small" href="/">← Back to dashboard</a>
      </header>
      {err && !d && <p className="bad-text">{err}</p>}
      {!d && !err && <p className="muted">Loading folders…</p>}
      {d && (
        <div className="mailbox-page-body">
          {d.mailbox.archiveGapBytes > Math.max(1024 ** 3, 0.05 * (d.mailbox.serverArchiveBytes || 0)) && (
            <p className="banner-warn card" role="alert">
              Auto-expanding archive: only the main partition ({fmtBytes(d.mailbox.ewsArchiveBytes ?? d.mailbox.archiveBytes ?? 0)}) is reachable by backup — {fmtBytes(d.mailbox.archiveGapBytes)} sits in auxiliary partitions no sync API can read. To capture it: export the archive to PST in the Purview portal (free), drop the PSTs into <code>data/exo-export/{upn}/</code>, then use <strong>Import archive PSTs</strong> in the Online archive panel.{' '}
              <button className="btn small" onClick={() => setGuideOpen(true)}>Step-by-step Purview export guide…</button>
            </p>
          )}
          {d.coverage && d.coverage.coverage && (
            <div className="coverage-split">
              <CoveragePanel cov={d.coverage} />
              {d.pstRepair && (d.pstRepair.psts.length > 0 || d.pstRepair.rebuiltItems > 0) && <PstRepairPanel pr={d.pstRepair} upn={upn} onChanged={load} />}
            </div>
          )}
          <div className="mailbox-panels">
            <ScopePanel upn={upn} scope="primary" label="Primary mailbox" rows={primary} live={d.live} scanLive={d.scanLive} mailbox={d.mailbox} actions={scopeActions('primary')} />
            <ScopePanel upn={upn} scope="archive" label="Online archive" rows={archive} live={d.live} scanLive={d.scanLive} mailbox={d.mailbox} actions={scopeActions('archive')} />
          </div>
          {logOpen ? (
            <aside className="logs log-sidebar mailbox-log" aria-label={`Activity log for ${upn}`}>
              <div className="log-head">
                <button className="log-iconbtn" title="Collapse activity log" aria-label="Collapse activity log" onClick={() => setLogOpen(false)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>
                </button>
                <span className="log-title">Activity — {upn}</span>
                <span className="live"><span className="dot" /> live</span>
                <span className="log-count" role="status" aria-atomic="true">{events.length} {events.length === 1 ? 'entry' : 'entries'}</span>
                <button className="log-iconbtn danger" title={`Clear activity log for ${upn}`} aria-label={`Clear activity log for ${upn}`}
                  onClick={async () => {
                    if (!window.confirm(`Clear the activity log of ${upn}? This removes the stored event history for this mailbox only.`)) return;
                    try { await del('/api/mailbox/' + encodeURIComponent(upn) + '/events'); load(); }
                    catch (e) { setErr(e.message); }
                  }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
                </button>
              </div>
              <div className="logbox" ref={logRef}>
                {!events.length && <div className="log-empty">No activity recorded for this mailbox yet.</div>}
                {events.map((e, i) => (
                  <div key={i} className={'log-line ' + e.level}>
                    <span className="log-dot" aria-hidden="true" />
                    <span className="log-body">
                      <span className="log-ts">{fmtTime(e.ts)}</span>
                      <span className="log-msg"> {e.message}</span>
                    </span>
                  </div>
                ))}
              </div>
            </aside>
          ) : (
            <button className="log-rail" title="Expand activity log" aria-label="Expand activity log" onClick={() => setLogOpen(true)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>
              <span className="log-rail-label">Activity log</span>
              {events.length > 0 && <span className="log-rail-count">{events.length > 99 ? '99+' : events.length}</span>}
            </button>
          )}
        </div>
      )}
      {copyOpen && <CopyWizard srcUpn={upn} folders={folders} onClose={() => { setCopyOpen(false); load(); }} />}
      {dedupeOpen && <DedupeModal upn={upn} onClose={() => setDedupeOpen(false)} onChanged={load} />}
      {planOpen && <PstPlanBuilder upn={upn} onClose={() => { setPlanOpen(false); load(); }} />}
      {planScope && <PstPlanBuilder upn={upn} scope={planScope} onClose={() => { setPlanScope(null); load(); }} />}
      {guideOpen && <PurviewGuideModal upn={upn} onClose={() => setGuideOpen(false)} />}
    </div>
  );
}

function CoverageScopeLine({ label, s }) {
  if (!s) return null;
  const parts = [
    <>Backed up <strong>{(s.localItems || 0).toLocaleString()}</strong> of <strong>{(s.serverItems || 0).toLocaleString()}</strong> items</>,
    <>local {fmtBytes(s.localBytes || 0)}</>
  ];
  if (s.serverBytes != null) parts.push(<>server {fmtBytes(s.serverBytes)}</>);
  return (
    <div className="cov-scope">
      <span className="cov-scope-label">{label}</span>
      {parts.map((p, i) => <span key={i}>{i > 0 && <span className="muted"> · </span>}{p}</span>)}
      {(s.unreachableItems || 0) > 0 && <span className="warn-text"> · {s.unreachableItems.toLocaleString()} unreachable</span>}
      {(s.deletedFromSource || 0) > 0 && <span className="muted" title="These emails were deleted or moved on the Exchange server itself. The backup only reads the source — it never deletes anything there. Your local backup copies are kept safe."> · {s.deletedFromSource.toLocaleString()} removed on the server — your copies are safe</span>}
    </div>
  );
}

function CoveragePanel({ cov }) {
  const c = cov.coverage;
  const partitions = cov.partitions || [];
  return (
    <div className="card coverage-panel">
      <div className="coverage-head">
        <span className={`chip ${covChipClass(c.state)}`}>Coverage: {c.state}</span>
        {c.checkedAt && <span className="muted">checked {fmtDateTime(c.checkedAt)}</span>}
        {cov.runs && cov.runs[0] && (cov.runs[0].itemsNew || 0) > 0 && (
          <span className="good-text" title={`${(cov.runs[0].itemsNew || 0).toLocaleString()} items added by the last backup run (${fmtDateTime(cov.runs[0].finishedAt || cov.runs[0].startedAt)})`}>
            +{cov.runs[0].itemsNew.toLocaleString()} new in last run
          </span>
        )}
      </div>
      <CoverageScopeLine label="Primary" s={c.primary ? { ...c.primary, serverBytes: c.serverPrimaryBytes } : null} />
      <CoverageScopeLine label="Online archive" s={c.archive ? { ...c.archive, serverBytes: c.serverArchiveBytes } : null} />
      {partitions.length > 0 && (
        <div className="cov-partitions muted">
          {partitions.map((p, i) => (
            <div key={p.partitionId} title={p.partitionId}>
              {p.partitionType === 'aux' ? `Auxiliary partition ${i}` : 'Main partition'}
              {' — '}{(p.backedUpItems || 0).toLocaleString()} items · {fmtBytes(p.backedUpBytes || 0)} stored
              {p.status === 'reachable' && <span className="good-text"> · reachable</span>}
              {p.status === 'unreachable' && <span className="warn-text"> · unreachable</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PstRepairPanel({ pr, upn, onChanged }) {
  const total = pr.rebuiltItems + pr.remainingFts;
  const pct = total ? Math.round(100 * pr.rebuiltItems / total) : 0;
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try { await post('/api/mailbox/' + encodeURIComponent(upn) + '/pst-repair', {}); }
    catch (e) { alert(e.message); }
    setBusy(false);
    onChanged && onChanged();
  };
  return (
    <div className="card coverage-panel">
      <div className="coverage-head">
        <span className="chip cov-good">PST recovery</span>
        {pr.lastRun && <span className="muted">last run {fmtDateTime(pr.lastRun)}</span>}
        <span style={{ flex: 1 }} />
        {pr.running
          ? <span className="muted">Running… {pr.lastLine ? pr.lastLine.slice(0, 60) : ''}</span>
          : <button className="btn small" disabled={busy} onClick={run}>{busy ? 'Starting…' : 'Run PST recovery'}</button>}
      </div>
      <div className="cov-scope">
        <span className="cov-scope-label">PSTs imported</span>
        <strong>{pr.psts.filter(p => p.processed).length}</strong>
        <span className="muted"> of {pr.psts.length} on disk{pr.psts.some(p => !p.processed) ? ' — run recovery to process the rest' : ''}</span>
      </div>
      <div className="cov-scope">
        <span className="cov-scope-label">Emails rebuilt</span>
        <strong>{pr.rebuiltItems.toLocaleString()}</strong>
        <span className="muted"> of {(total).toLocaleString()} · {fmtBytes(pr.rebuiltBytes)}</span>
      </div>
      <div className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin="0" aria-valuemax="100" title={`${pr.rebuiltItems.toLocaleString()} rebuilt · ${pr.remainingFts.toLocaleString()} still original`}>
        <div className="fill" style={{ width: pct + '%' }} />
      </div>
      <div className="cov-scope muted">
        <span>{pr.remainingFts.toLocaleString()} still original (FTS)</span>
        {pr.totals.unmatched > 0 && <span title="PST messages whose folder isn't backed up yet — a re-run matches them later"> · {pr.totals.unmatched.toLocaleString()} unmatched</span>}
        {pr.totals.failed > 0 && <span className="warn-text"> · {pr.totals.failed.toLocaleString()} failed</span>}
        {pr.totals.verifyFailures > 0 && <span className="warn-text" title="Rebuilt emails whose image attachments failed the integrity check"> · {pr.totals.verifyFailures.toLocaleString()} verify failures</span>}
      </div>
      {pr.psts.length > 0 && (
        <div className="cov-partitions muted">
          {pr.psts.map(p => (
            <div key={p.file} title={p.processed ? `${p.file}: ${p.replaced} replaced${p.verifyFailures ? `, ${p.verifyFailures} verify failures` : ''}` : `${p.file}: not yet processed`}>
              {p.file}{' — '}{p.processed
                ? <>{(p.replaced || 0).toLocaleString()} rebuilt{(p.verifyFailures || 0) > 0 ? ` · ${p.verifyFailures} verify` : ''}</>
                : <span className="warn-text">pending{p.size ? ` · ${fmtBytes(p.size)}` : ''}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PurviewGuideModal({ upn, onClose }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card settings-card guide-card" role="dialog" aria-modal="true" aria-label="Purview portal PST export guide" onClick={e => e.stopPropagation()}>
        <div className="settings-head">
          <h3>Export the archive to PST — Purview portal</h3>
          <button className="btn small" onClick={onClose} aria-label="Close guide">✕</button>
        </div>
        <div className="guide-body">
          <p className="muted">Free built-in Microsoft 365 route. Captures the <strong>entire</strong> online archive of <span className="mono">{upn}</span>, including auto-expanding auxiliary partitions no sync API can reach. Allow a few hours per step — Purview jobs are slow.</p>
          <ol>
            <li><strong>Give yourself export permission</strong> (admin, once):
              <ul>
                <li>Open <a href="https://purview.microsoft.com" target="_blank" rel="noreferrer">purview.microsoft.com</a> and sign in as a global admin.</li>
                <li>Go to <strong>Settings → Roles and scopes → Role groups</strong>.</li>
                <li>Open <strong>eDiscovery Manager</strong>, click <strong>Edit</strong>, and add your account under <em>eDiscovery Administrator</em> (that role includes the Export permission). Save.</li>
              </ul>
            </li>
            <li><strong>Create an eDiscovery case</strong>:
              <ul>
                <li>In Purview, go to <strong>Cases → eDiscovery (Standard)</strong> → <strong>Create a case</strong>.</li>
                <li>Name it e.g. <span className="mono">Archive export — {upn}</span> and create it.</li>
              </ul>
            </li>
            <li><strong>Create a search for the archive</strong>:
              <ul>
                <li>Open the case → <strong>Searches → Create a search</strong>.</li>
                <li>Name it, then under <strong>Locations</strong> choose <em>Specific locations</em> → Exchange mailboxes → add <span className="mono">{upn}</span>.</li>
                <li>Leave the query <strong>empty</strong> (everything) and finish. If offered, include the archive mailbox content.</li>
                <li>Wait for the estimate to finish (status shows items/size — should roughly match the archive size).</li>
              </ul>
            </li>
            <li><strong>Export the results as PST</strong>:
              <ul>
                <li>Open the search → <strong>Actions → Export results</strong> (or the <em>Export</em> tab → <strong>Create an export</strong>).</li>
                <li>Output type: <strong>PST</strong>. Choose <em>One PST per mailbox</em> and enable deduplication if offered.</li>
                <li>Submit and wait — large archives take hours and are split into multiple PST files.</li>
              </ul>
            </li>
            <li><strong>Download the PSTs</strong>:
              <ul>
                <li>When the export status is <em>Complete</em>, open it → <strong>Download</strong>. The portal gives you an <strong>export key</strong> and a download tool/link (or direct browser download of each PST).</li>
                <li>Download <strong>every</strong> PST file for this mailbox.</li>
              </ul>
            </li>
            <li><strong>Import into this app</strong>:
              <ul>
                <li>Put the PST files into <code>data/exo-export/{upn}/</code> on the backup server.</li>
                <li>Come back to this page and click <strong>Import archive PSTs</strong> in the header — the emails appear in the Online archive panel and count toward verification.</li>
                <li>You can delete the PST files afterwards; the content is stored in the backup store.</li>
              </ul>
            </li>
          </ol>
          <p className="muted">Tip: the automated <strong>EXO export (full archive)</strong> button does all of this via the Graph eDiscovery API, but needs Purview pay-as-you-go billing enabled on the tenant. The portal route above costs nothing.</p>
        </div>
      </div>
    </div>
  );
}
