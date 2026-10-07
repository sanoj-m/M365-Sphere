import React, { useState, useEffect } from 'react';
import { api, post } from '../api.js';
import { fmtBytes, fmtTime } from '../format.js';
import { MailboxPicker } from './ComparePage.jsx';

// One dedupe session card per mailbox. Check/apply/restore run independently
// per mailbox — the backend allows one dedupe job per upn concurrently.
function DedupeSession({ upn, checks, jobs, onRemove }) {
  const [target, setTarget] = useState(() => { try { return localStorage.getItem(`dedupe.target.${upn}`) || 'local'; } catch { return 'local'; } });
  const [checking, setChecking] = useState(false);
  const [report, setReport] = useState(() => {
    try { return JSON.parse(localStorage.getItem(`dedupe.report.${upn}`) || 'null'); } catch { return null; }
  });
  const [applying, setApplying] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreResult, setRestoreResult] = useState(null);
  const [logs, setLogs] = useState([]);
  const [err, setErr] = useState(null);

  const job = jobs.find(j => j.kind === 'dedupe' && j.status === 'running' && j.upn === upn) || null;
  const checkProg = checks.find(c => c.upn === upn) || null;
  const history = jobs.filter(j => (j.kind === 'dedupe' || j.kind === 'dedupe-check') && j.upn === upn).slice(0, 10);

  useEffect(() => {
    try { localStorage.setItem(`dedupe.target.${upn}`, target); } catch { }
  }, [upn, target]);

  // Log tail: recent events for this mailbox — kept after stop/finish.
  useEffect(() => {
    let t;
    const poll = () => {
      api(`/api/mailbox/${encodeURIComponent(upn)}`)
        .then(m => setLogs((m.events || []).slice(-12).reverse()))
        .catch(() => { });
      t = setTimeout(poll, 4000);
    };
    poll();
    return () => clearTimeout(t);
  }, [upn]);

  // Check reports survive refresh (per mailbox); switching scope clears them.
  const saveReport = r => {
    setReport(r);
    try {
      if (r) localStorage.setItem(`dedupe.report.${upn}`, JSON.stringify(r));
      else localStorage.removeItem(`dedupe.report.${upn}`);
    } catch { }
  };

  const check = () => {
    setChecking(true); setErr(null); saveReport(null); setRestoreResult(null);
    post('/api/dedupe/check', { upn, target })
      .then(saveReport)
      .catch(e => setErr(e.message))
      .finally(() => setChecking(false));
  };

  const apply = () => {
    setApplying(true); setErr(null);
    post('/api/dedupe/apply', { upn, target })
      .catch(e => setErr(e.message))
      .finally(() => setApplying(false));
  };

  const restore = () => {
    setRestoring(true); setErr(null); setRestoreResult(null);
    post('/api/dedupe/restore', { upn })
      .then(setRestoreResult)
      .catch(e => setErr(e.message))
      .finally(() => setRestoring(false));
  };

  const stop = () => {
    post('/api/stop/dedupe', { upn }).catch(e => setErr(e.message));
  };

  return (
    <div className="settings-card" style={{ margin: 0 }}>
      <div className="settings-head">
        <h3 className="mono" style={{ fontSize: 14, wordBreak: 'break-all' }}>{upn}</h3>
        <button className="log-iconbtn" title="Remove this session (running jobs are not stopped)" aria-label={`Remove session ${upn}`} onClick={onRemove}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12" /></svg>
        </button>
      </div>
      {err && <p className="bad-text" style={{ padding: '0 18px' }}>{err}</p>}

      <section className="settings-section">
        <h4>Scope</h4>
        <div className="settings-row">
          <p className="settings-hint">
            Local backup matches exact content hashes (SHA-256 — no false positives).
            Live mailbox matches Message-ID, then verifies full content (SHA-256) — only
            exact duplicates move to Deleted Items/Dedupe &lt;date&gt;/ with their folder structure kept.
          </p>
          <div className="theme-switch" role="group" aria-label="Dedupe scope">
            <button className={`theme-opt${target === 'local' ? ' active' : ''}`} aria-pressed={target === 'local'} onClick={() => { setTarget('local'); saveReport(null); }}>Local backup</button>
            <button className={`theme-opt${target === 'live' ? ' active' : ''}`} aria-pressed={target === 'live'} onClick={() => { setTarget('live'); saveReport(null); }}>Live mailbox</button>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h4>Step 1 — check</h4>
        {!report ? (
          <>
            <div className="settings-row">
              <p className="settings-hint">Dry run — nothing is changed.</p>
              <button className="btn" disabled={checking || !!job} onClick={check}>{checking ? 'Checking…' : 'Check for duplicates'}</button>
            </div>
            {checking && checkProg && (
              <div className="compare-prog" style={{ margin: '0 0 12px' }}>
                <div className="compare-prog-main">
                  <div className="compare-prog-head">
                    <b>Scanning {checkProg.foldersDone} / {checkProg.foldersTotal} folders</b>
                    {checkProg.foldersTotal > 0 && <span className="muted">{Math.round(checkProg.foldersDone / checkProg.foldersTotal * 100)}%</span>}
                  </div>
                  <div className="compare-prog-route muted">
                    <span title={checkProg.currentFolder}>{checkProg.currentFolder}</span>
                  </div>
                </div>
                <div className={`bar slim${checkProg.foldersTotal ? '' : ' indet'}`}>
                  <div className="fill" style={checkProg.foldersTotal ? { width: `${Math.min(100, Math.round(checkProg.foldersDone / checkProg.foldersTotal * 100))}%` } : undefined} />
                </div>
                <div className="compare-prog-stats">
                  <span className="muted">{checkProg.messages} message(s) scanned</span>
                  <span className="muted">{checkProg.groups} candidate group(s) so far</span>
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            {report.dupItems ? (
              <>
                <p className="settings-hint" style={{ fontSize: 13 }}>
                  <b>{report.groups}</b> duplicate group(s), <b>{report.dupItems}</b> item(s) can be moved aside
                  {report.reclaimable != null ? ` · ${fmtBytes(report.reclaimable)} reclaimable` : ''}.
                </p>
                <div className="copy-folderlist">
                  {report.sample.map((g, i) => (
                    <div key={i} className="copy-folder dedupe-group">
                      <span className="copy-folder-path">
                        {g.subject} <span className="muted">({g.count}×)</span>
                        <span className="dedupe-loc">
                          keep: {g.keep || g.folders[0]} · dup: {(g.duplicates || g.folders.slice(1)).join(', ')}
                        </span>
                      </span>
                    </div>
                  ))}
                  {report.groups > report.sample.length && <p className="settings-hint">…and {report.groups - report.sample.length} more group(s)</p>}
                </div>
              </>
            ) : (
              <p className="settings-hint">No duplicates found.</p>
            )}
          </>
        )}
      </section>

      {report && report.dupItems > 0 && !job && (
        <section className="settings-section">
          <h4>Step 2 — deduplicate</h4>
          <div className="settings-row">
            <p className="settings-hint">
              {target === 'local'
                ? 'Duplicates move to _duplicates/ with their folder structure kept, plus a restore manifest. Nothing is deleted.'
                : 'Duplicates move to the mailbox\'s Deleted Items folder — recoverable on the server until retention expires.'}
            </p>
            <button className="btn danger" disabled={applying} onClick={apply}>{applying ? 'Starting…' : 'Move duplicates aside'}</button>
          </div>
        </section>
      )}

      {job && (
        <section className="settings-section">
          <h4>Dedupe running</h4>
          <div className="settings-row">
            <p className="settings-hint">
              {job.total ? `${job.done || 0} / ${job.total} item(s) processed` : 'Dedupe job is running…'}
              {job.detail ? ` — ${job.detail}` : ''}
            </p>
            <button className="btn small danger" onClick={stop}>Stop</button>
          </div>
        </section>
      )}

      {history.length > 0 && (
        <section className="settings-section">
          <h4>History</h4>
          <div className="copy-folderlist">
            {history.map(j => (
              <div key={j.id} className="copy-folder dedupe-group">
                <span className="copy-folder-path">
                  <span className="muted">{fmtTime(j.startedAt)}</span>{' '}
                  <b>{j.kind === 'dedupe-check' ? 'Check' : 'Dedupe'}</b>{' '}
                  <span className={j.status === 'done' ? 'good-text' : j.status === 'running' ? 'muted' : 'bad-text'}>{j.status}</span>
                  {j.total ? <span className="muted"> · {j.done || 0}/{j.total}</span> : ''}
                  {j.detail ? <span className="dedupe-loc">{j.detail}</span> : ''}
                </span>
                <span style={{ flex: '0 0 auto', display: 'flex', gap: 6 }}>
                  {j.status === 'running' && j.kind === 'dedupe' && (
                    <button className="btn small danger" onClick={stop}>Stop</button>
                  )}
                  {j.status === 'running' && j.kind === 'dedupe-check' && (
                    <span className="muted">running…</span>
                  )}
                  {(j.status === 'stopped' || j.status === 'error' || j.status === 'interrupted') && (
                    <button className="btn small" disabled={applying || checking || !!job}
                      title={j.kind === 'dedupe-check' ? 'Re-run this check' : 'Restart — already-moved items are skipped'}
                      onClick={j.kind === 'dedupe-check' ? check : apply}>
                      {j.kind === 'dedupe-check' ? 'Re-check' : 'Restart'}
                    </button>
                  )}
                  {j.status === 'done' && (
                    <button className="btn small ghost" disabled={checking || !!job}
                      title="Verify again — run a fresh check against the selected scope"
                      onClick={check}>Verify again</button>
                  )}
                </span>
              </div>
            ))}
          </div>
          <p className="settings-hint">Actions run against the scope selected above (Local backup / Live mailbox).</p>
        </section>
      )}

      {logs.length > 0 && (
        <section className="settings-section">
          <h4>Log</h4>
          <div className="copy-folderlist">
            {logs.map((e, i) => (
              <div key={i} className="copy-folder">
                <span className="copy-folder-path">
                  <span className="muted">{fmtTime(e.ts)}</span> {e.message}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {target === 'local' && (
        <section className="settings-section">
          <h4>Restore</h4>
          <div className="settings-row">
            <p className="settings-hint">Put back the items moved aside by the most recent dedupe run.</p>
            <button className="btn ghost" disabled={restoring || !!job} onClick={restore}>{restoring ? 'Restoring…' : 'Restore last dedupe run'}</button>
          </div>
          {restoreResult && <p className="settings-hint">{restoreResult.restored} item(s) restored{restoreResult.missing ? `, ${restoreResult.missing} file(s) missing` : ''}.</p>}
        </section>
      )}
    </div>
  );
}

export default function DedupePage() {
  const [mailboxes, setMailboxes] = useState([]);
  const [sessions, setSessions] = useState(() => {
    try {
      const s = JSON.parse(localStorage.getItem('dedupe.sessions') || 'null');
      if (Array.isArray(s)) return s;
      // Migrate the single-mailbox selection from before sessions existed.
      const legacy = localStorage.getItem('dedupe.upn');
      return legacy ? [legacy] : [];
    } catch { return []; }
  });
  const [pickerUpn, setPickerUpn] = useState('');
  const [showShared, setShowShared] = useState(false);
  const [showGuests, setShowGuests] = useState(false);
  const [checks, setChecks] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [err, setErr] = useState(null);

  useEffect(() => {
    document.title = 'M365Sphere — Dedupe';
    document.body.classList.add('compare-mode');
    api('/api/mailboxes').then(setMailboxes).catch(e => setErr(e.message));
    return () => { document.title = 'M365Sphere'; document.body.classList.remove('compare-mode'); };
  }, []);

  useEffect(() => {
    try { localStorage.setItem('dedupe.sessions', JSON.stringify(sessions)); } catch { }
  }, [sessions]);

  // One shared status poll for all sessions.
  useEffect(() => {
    let t;
    const poll = () => {
      api('/api/status').then(s => {
        setChecks(s.dedupeChecks || []);
        setJobs(s.jobs || []);
        t = setTimeout(poll, (s.dedupeRunning || (s.dedupeChecks || []).length) ? 2000 : 10000);
      }).catch(() => { t = setTimeout(poll, 5000); });
    };
    poll();
    return () => clearTimeout(t);
  }, []);

  const addSession = () => {
    if (!pickerUpn) return;
    setSessions(s => s.includes(pickerUpn) ? s : [...s, pickerUpn]);
    setPickerUpn('');
  };

  const removeSession = upn => setSessions(s => s.filter(u => u !== upn));

  const resetAll = () => {
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith('dedupe.')) localStorage.removeItem(k);
    } catch { }
    setSessions([]); setPickerUpn(''); setErr(null);
  };

  return (
    <div className="mailbox-page compare-page">
      <header className="mailbox-page-head">
        <a className="brand" href="/" title="Go to homepage">
          <img className="brand-icon" src="/logo.png" alt="M365Sphere logo" />
          <h1>M365Sphere</h1>
        </a>
        <h2>Dedupe</h2>
        <label className="muted">Mailbox
          <MailboxPicker value={pickerUpn} onChange={setPickerUpn}
            mailboxes={mailboxes} showShared={showShared} showGuests={showGuests}
            placeholder="Search mailboxes…" /></label>
        <button className="btn small" disabled={!pickerUpn || sessions.includes(pickerUpn)}
          title={sessions.includes(pickerUpn) ? 'This mailbox already has a session' : 'Add a dedupe session for the selected mailbox'}
          onClick={addSession}>Add session</button>
        <span className="muted compare-type-toggles" title="Mailbox types to include in search results (licensed users are always listed)">
          Include:
          <label><input type="checkbox" checked={showShared} onChange={e => setShowShared(e.target.checked)} /> shared</label>
          <label><input type="checkbox" checked={showGuests} onChange={e => setShowGuests(e.target.checked)} /> guests</label>
        </span>
        <span className="spacer" />
        <button className="btn small" title="Remove all sessions and saved check results (they are remembered across refreshes otherwise)" onClick={resetAll}>Reset</button>
        <a className="btn small" href="/">← Back</a>
      </header>
      {err && <p className="bad-text">{err}</p>}

      {sessions.length === 0 ? (
        <p className="muted" style={{ padding: '0 18px' }}>Add one or more mailboxes above — each gets its own dedupe session that can run independently.</p>
      ) : (
        <div className="dedupe-grid">
          {sessions.map(upn => (
            <DedupeSession key={upn} upn={upn} checks={checks} jobs={jobs} onRemove={() => removeSession(upn)} />
          ))}
        </div>
      )}
    </div>
  );
}
