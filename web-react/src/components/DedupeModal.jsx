import React, { useState } from 'react';
import { post } from '../api.js';
import { fmtBytes } from '../format.js';

// Dedupe wizard: check first (dry run), then apply. Local duplicates are moved
// to _duplicates with the folder structure kept; live duplicates go to the
// mailbox's Deleted Items folder. Both are recoverable.
export default function DedupeModal({ upn, onClose, onChanged }) {
  const [target, setTarget] = useState('local');
  const [checking, setChecking] = useState(false);
  const [report, setReport] = useState(null);
  const [applying, setApplying] = useState(false);
  const [jobStarted, setJobStarted] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreResult, setRestoreResult] = useState(null);
  const [err, setErr] = useState(null);

  const check = () => {
    setChecking(true); setErr(null); setReport(null); setRestoreResult(null);
    post('/api/dedupe/check', { upn, target })
      .then(setReport)
      .catch(e => setErr(e.message))
      .finally(() => setChecking(false));
  };

  const apply = () => {
    setApplying(true); setErr(null);
    post('/api/dedupe/apply', { upn, target })
      .then(() => { setJobStarted(true); onChanged && onChanged(); })
      .catch(e => setErr(e.message))
      .finally(() => setApplying(false));
  };

  const restore = () => {
    setRestoring(true); setErr(null); setRestoreResult(null);
    post('/api/dedupe/restore', { upn })
      .then(r => { setRestoreResult(r); onChanged && onChanged(); })
      .catch(e => setErr(e.message))
      .finally(() => setRestoring(false));
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card settings-card" role="dialog" aria-modal="true" aria-label={`Deduplicate ${upn}`} onClick={e => e.stopPropagation()}>
        <div className="settings-head">
          <h3>Deduplicate emails</h3>
          <button className="log-iconbtn" title="Close" aria-label="Close" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>

        <section className="settings-section">
          <h4>Scope</h4>
          <div className="settings-row">
            <div>
              <div className="settings-label mono">{upn}</div>
              <p className="settings-hint">
                Local backup matches exact content hashes (SHA-256 — no false positives).
                Live mailbox matches Message-ID, then verifies full content (SHA-256) — only
                exact duplicates move to Deleted Items/Dedupe &lt;date&gt;/ with their folder structure kept.
              </p>
            </div>
            <div className="theme-switch" role="group" aria-label="Dedupe scope">
              <button className={`theme-opt${target === 'local' ? ' active' : ''}`} aria-pressed={target === 'local'} onClick={() => { setTarget('local'); setReport(null); }}>Local backup</button>
              <button className={`theme-opt${target === 'live' ? ' active' : ''}`} aria-pressed={target === 'live'} onClick={() => { setTarget('live'); setReport(null); }}>Live mailbox</button>
            </div>
          </div>
        </section>

        <section className="settings-section">
          <h4>Step 1 — check</h4>
          {!report ? (
            <div className="settings-row">
              <p className="settings-hint">Dry run — nothing is changed.</p>
              <button className="btn" disabled={checking} onClick={check}>{checking ? 'Checking…' : 'Check for duplicates'}</button>
            </div>
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

        {report && report.dupItems > 0 && !jobStarted && (
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
        {jobStarted && (
          <section className="settings-section">
            <p className="settings-hint">Dedupe job started — watch progress in the dashboard job bar.</p>
          </section>
        )}

        {target === 'local' && (
          <section className="settings-section">
            <h4>Restore</h4>
            <div className="settings-row">
              <p className="settings-hint">Put back the items moved aside by the most recent dedupe run.</p>
              <button className="btn ghost" disabled={restoring} onClick={restore}>{restoring ? 'Restoring…' : 'Restore last dedupe run'}</button>
            </div>
            {restoreResult && <p className="settings-hint">{restoreResult.restored} item(s) restored{restoreResult.missing ? `, ${restoreResult.missing} file(s) missing` : ''}.</p>}
          </section>
        )}

        {err && <p className="bad-text" style={{ padding: '0 18px 12px' }}>{err}</p>}
      </div>
    </div>
  );
}
