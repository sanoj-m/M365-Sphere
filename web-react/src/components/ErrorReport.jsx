import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { fmtTime, fmtDateTime } from '../format.js';

export default function ErrorReport({ status, logs, consoleErrors }) {
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [clearedAt, setClearedAt] = useState(null);

  const freshBadge = e => !clearedAt || (e.ts || e.startedAt || '') > clearedAt;
  const errCount = logs.filter(e => e.level === 'error' && freshBadge(e)).length
    + consoleErrors.filter(freshBadge).length
    + (status && status.jobs ? status.jobs.filter(j => j.status === 'error' && freshBadge(j)).length : 0);

  // The report is a snapshot taken when the panel opens; re-collect whenever
  // the live error count changes while the panel is open so the two never diverge.
  useEffect(() => {
    if (open) collect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [errCount, open]);

  const collect = async (since = clearedAt) => {
    setBusy(true);
    setCopied(false);
    const fresh = e => !since || (e.ts || e.startedAt || '') > since;
    let serverLogs = [];
    try { serverLogs = await api('/api/logs?n=400'); } catch { }
    const seen = new Set(serverLogs.map(e => e.ts + '|' + e.message));
    const merged = [...serverLogs, ...logs.filter(e => !seen.has(e.ts + '|' + e.message))];
    const warnErrLogs = merged
      .filter(e => (e.level === 'error' || e.level === 'warn') && fresh(e))
      .sort((a, b) => (a.ts || '') < (b.ts || '') ? -1 : 1)
      .slice(-60);
    let mailboxes = [];
    try { mailboxes = await api('/api/mailboxes'); } catch { }
    const badBoxes = mailboxes.filter(m => m.status === 'error' || m.lastError).slice(0, 30);
    const jobs = (status && status.jobs ? status.jobs : []).filter(j => (j.status === 'error' || j.status === 'stopped') && fresh(j)).slice(0, 10);
    setReport({ at: new Date().toISOString(), jobs, badBoxes, warnErrLogs, consoleErrors: consoleErrors.filter(fresh).slice(-30) });
    setOpen(true);
    setBusy(false);
  };

  const buildText = () => {
    const { at, jobs, badBoxes, warnErrLogs, consoleErrors: cerrs } = report;
    const L = [];
    L.push('# M365 PST Backup — error report');
    L.push('');
    L.push(`- Time: ${at}`);
    L.push(`- Tenant: ${(status && status.tenant) || 'unknown'}`);
    L.push(`- Backup running: ${!!(status && status.running)}, PST export running: ${!!(status && status.pstRunning)}`);
    L.push(`- App URL: ${window.location.origin}`);
    L.push('');
    if (jobs.length) {
      L.push('## Failed / stopped jobs');
      jobs.forEach(j => L.push(`- job #${j.id} [${j.kind}] ${j.status}: ${j.done}/${j.total} ${j.detail || ''} (${fmtDateTime(j.startedAt)})`));
      L.push('');
    }
    if (badBoxes.length) {
      L.push('## Mailboxes with errors');
      badBoxes.forEach(m => L.push(`- ${m.upn} [${m.status}] ${m.lastError || ''}`));
      L.push('');
    }
    L.push(`## Server log — warnings & errors (last ${warnErrLogs.length})`);
    if (warnErrLogs.length) {
      warnErrLogs.forEach(e => L.push(`- [${e.ts}] ${e.level.toUpperCase()}${e.mailbox ? ' [' + e.mailbox + ']' : ''} ${e.message}`));
    } else L.push('(none)');
    L.push('');
    L.push(`## Browser console errors (${cerrs.length})`);
    if (cerrs.length) cerrs.forEach(e => L.push(`- [${e.ts}] ${e.message}`));
    else L.push('(none)');
    L.push('');
    L.push('---');
    L.push('Please analyze the errors above and suggest a fix.');
    return L.join('\n');
  };

  // Mark everything currently collected as acknowledged, then re-collect so the
  // panel immediately shows only errors that arrive after this moment.
  const clearReport = () => {
    const now = new Date().toISOString();
    setClearedAt(now);
    setCopied(false);
    collect(now);
  };

  const copy = async () => {
    const text = buildText();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const errors = report ? report.warnErrLogs.filter(e => e.level === 'error') : [];
  const hasAny = report && (report.jobs.length || report.badBoxes.length || errors.length || report.consoleErrors.length);

  return (
    <>
      <button className="errfab" title="Collect errors for an AI agent" onClick={collect} disabled={busy}>
        {busy ? '…' : '⚠'}
        {errCount > 0 && <span className="errfab-badge" aria-label={`${errCount} errors`}>{errCount > 99 ? '99+' : errCount}</span>}
      </button>
      {open && report && (
        <div className="errpanel card">
          <div className="errpanel-head">
            <div className="errpanel-title">
              <b>Errors</b>
              {hasAny && <span className="errpanel-count">{report.jobs.length + report.badBoxes.length + errors.length + report.consoleErrors.length}</span>}
            </div>
            <span className="spacer" />
            <button className="btn small primary" onClick={copy}>{copied ? 'Copied ✓' : 'Copy to clipboard'}</button>
            <button className="btn small danger" onClick={clearReport}>Clear report</button>
            <button className="errpanel-close" title="Close" onClick={() => setOpen(false)}>✕</button>
          </div>
          <div className="errlist">
            {!hasAny && (
              <div className="errempty">
                <span className="errempty-icon">✓</span>
                <p className="muted">No errors — everything looks healthy.</p>
              </div>
            )}
            {report.jobs.length > 0 && (
              <div className="errgroup">
                <div className="errgroup-head">Failed / stopped jobs <span>{report.jobs.length}</span></div>
                {report.jobs.map(j => (
                  <div key={j.id} className="errrow">
                    <span className={`errpill ${j.status}`}>{j.status}</span>
                    <div className="errrow-body">
                      <div className="errrow-title">job #{j.id} <span className="muted">[{j.kind}]</span> — {j.done}/{j.total} done</div>
                      {j.detail && <div className="errrow-detail muted">{j.detail}</div>}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {report.badBoxes.length > 0 && (
              <div className="errgroup">
                <div className="errgroup-head">Mailboxes with errors <span>{report.badBoxes.length}</span></div>
                {report.badBoxes.map(m => (
                  <div key={m.upn} className="errrow">
                    <span className="errpill error">{m.status}</span>
                    <div className="errrow-body">
                      <div className="errrow-title mono">{m.upn}</div>
                      {m.lastError && <div className="errrow-detail muted">{m.lastError}</div>}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {errors.length > 0 && (
              <div className="errgroup">
                <div className="errgroup-head">Server log — errors <span>{errors.length}</span></div>
                {errors.map((e, i) => (
                  <div key={i} className="errrow">
                    <span className="errpill error">error</span>
                    <div className="errrow-body">
                      <div className="errrow-title">{e.message}</div>
                      <div className="errrow-detail muted mono">{fmtDateTime(e.ts)}{e.mailbox ? ` · ${e.mailbox}` : ''}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {report.consoleErrors.length > 0 && (
              <div className="errgroup">
                <div className="errgroup-head">Browser console errors <span>{report.consoleErrors.length}</span></div>
                {report.consoleErrors.map((e, i) => (
                  <div key={i} className="errrow">
                    <span className="errpill error">console</span>
                    <div className="errrow-body">
                      <div className="errrow-title">{e.message}</div>
                      <div className="errrow-detail muted mono">{fmtTime(e.ts)}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <p className="errpanel-foot muted">“Copy to clipboard” copies the full report (including warnings) formatted for the AI agent.</p>
        </div>
      )}
    </>
  );
}
