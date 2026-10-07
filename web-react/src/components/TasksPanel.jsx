import React, { useEffect, useState } from 'react';
import { del, post } from '../api.js';
import { dialog } from '../dialog.jsx';

const ACTIVE = ['queued', 'waiting', 'verify', 'backup'];
const upnOf = s => { const m = /[\w.+-]+@[\w-]+\.[\w.]+/.exec(String(s || '')); return m ? m[0] : null; };
const fixLabel = { queued: 'Queued', waiting: 'Waiting for engine…', verify: 'Verifying…', backup: 'Backing up…' };
const stopPath = { pst: '/api/stop/pst', backup: '/api/stop/backup', verify: '/api/stop/backup', sizes: '/api/stop/sizes', scan: '/api/stop/scan', copy: '/api/stop/copy', dedupe: '/api/stop/dedupe', exoexport: '/api/stop/exo-export' };

const elapsed = iso => {
  if (!iso) return '';
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
};

function TaskLogs({ lines }) {
  if (!lines.length) return null;
  return (
    <div className="task-logs">
      {lines.map((e, i) => (
        <div key={i} className={'log-line ' + e.level}>
          <span className="log-dot" aria-hidden="true" />
          <span className="log-body">
            <span className="log-ts">{String(e.ts || '').slice(11, 19)}</span>
            <span className="log-msg"> {e.message}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function StopBtn({ kind, label }) {
  const stop = async () => {
    if (!await dialog.confirm({ title: `Stop ${kind}`, message: `${label}: stop the running ${kind} job? Partially exported folders are kept; the export resumes from the manifest next run.` })) return;
    post(stopPath[kind] || '/api/stop', {}).catch(e => dialog.notify(`Stop failed: ${e.message}`, 'error'));
  };
  return <button className="btn small danger" onClick={stop}>Stop</button>;
}

export default function TasksPanel({ status, logs }) {
  const jobs = status ? status.jobs.filter(j => j.status === 'running') : [];
  const fixTasks = (status && status.fixTasks) || [];
  const pstDetail = (status && status.pstDetail) || {};
  const exoExport = (status && status.exoExport) || {};
  const gb = n => (n / 1073741824).toFixed(1);
  const exfmt = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'k' : String(n));
  const activeFix = fixTasks.filter(t => ACTIVE.includes(t.status));
  const finishedFix = fixTasks.filter(t => !ACTIVE.includes(t.status)).slice(-5).reverse();
  const logsFor = upn => (upn ? logs.filter(e => e.mailbox === upn).slice(-4) : []);

  // tick so elapsed times stay fresh
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 5000);
    return () => clearInterval(t);
  }, []);

  const cancel = id => del('/api/tasks/' + id).catch(e => dialog.notify('Cancel failed: ' + e.message, 'error'));

  const empty = !jobs.length && !activeFix.length && !finishedFix.length && !exoExport.running;
  return (
    <div className="logbox taskspanel">
      {empty && <div className="log-empty">No running tasks — start a backup, verify, PST export or gap fix to see live progress here.</div>}

      {exoExport.running && (
        <div className="task-card">
          <div className="task-head">
            <b>EXO export</b>
            <span className="chip syncing"><i className="sdot" />running</span>
            <span className="spacer" />
            <StopBtn kind="exoexport" label="EXO export" />
          </div>
          <div className="muted task-detail">
            {exoExport.chunksDone}/{exoExport.chunksTotal} chunks · {gb(exoExport.bytesDone)} GB downloaded
            {(exoExport.itemsIngested || 0) > 0 ? ` · ${exfmt(exoExport.itemsIngested)} items ingested (${gb(exoExport.bytesIngested)} GB)` : ''}
          </div>
          {exoExport.chunksTotal ? <div className="bar task-bar"><div className="fill" style={{ width: Math.round(100 * exoExport.chunksDone / exoExport.chunksTotal) + '%' }} /></div> : null}
          {exoExport.current && (
            <div className="muted task-detail mono">
              {exoExport.current.upn} — chunk {exoExport.current.chunkFrom}…{exoExport.current.chunkTo === '9999-12-31' ? 'tail' : exoExport.current.chunkTo}
              {exoExport.current.phase ? ` (${exoExport.current.phase})` : ''}
            </div>
          )}
          {exoExport.lastError && <div className="bad-text">{exoExport.lastError}</div>}
        </div>
      )}

      {jobs.map(j => {
        const pct = j.total ? Math.round(100 * j.done / j.total) : 0;
        const upn = upnOf(j.detail) || (j.kind === 'pst' && pstDetail.current && pstDetail.current.upn);
        const isPst = j.kind === 'pst';
        return (
          <div className="task-card" key={'job-' + j.id}>
            <div className="task-head">
              <b>{j.kind}</b>
              <span className="chip syncing"><i className="sdot" />running</span>
              <span className="spacer" />
              <StopBtn kind={j.kind} label={j.kind} />
            </div>
            <div className="muted task-detail">
              {j.done}/{j.total}{j.total ? ` (${pct}%)` : ''} {j.detail || ''}
              {j.startedAt ? ` · started ${elapsed(j.startedAt)} ago` : ''}
            </div>
            {j.total ? <div className="bar task-bar"><div className="fill" style={{ width: pct + '%' }} /></div> : null}
            {isPst && pstDetail.current && (
              <div className="muted task-detail mono">
                now exporting {pstDetail.current.upn} ({elapsed(pstDetail.current.startedAt)})
              </div>
            )}
            {isPst && pstDetail.out && (
              <details className="task-out">
                <summary className="muted">PowerShell output (last lines)</summary>
                <pre>{pstDetail.out}</pre>
              </details>
            )}
            <TaskLogs lines={logsFor(upn)} />
          </div>
        );
      })}

      {activeFix.map(t => (
        <div className="task-card" key={'fix-' + t.id}>
          <div className="task-head">
            <b>Fix gaps</b>
            <span className="chip partial"><i className="sdot" />{fixLabel[t.status] || t.status}</span>
            <span className="spacer" />
            {(t.status === 'queued' || t.status === 'waiting') && (
              <button className="btn small" onClick={() => cancel(t.id)}>Cancel</button>
            )}
            {(t.status === 'verify' || t.status === 'backup') && <StopBtn kind="backup" label="fix-gaps" />}
          </div>
          <div className="muted task-detail mono">{t.upn}{t.queuedAt && t.status === 'waiting' ? ` · waiting ${elapsed(t.queuedAt)}` : ''}</div>
          <TaskLogs lines={logsFor(t.upn)} />
        </div>
      ))}

      {finishedFix.length > 0 && <div className="task-sep muted">Recently finished</div>}
      {finishedFix.map(t => (
        <div className="task-card finished" key={'fixdone-' + t.id}>
          <div className="task-head">
            <b>Fix gaps</b>
            <span className={`chip ${t.status === 'done' ? 'done' : t.status === 'cancelled' ? 'none' : 'error'}`}>
              <i className="sdot" />{t.status}
            </span>
          </div>
          <div className="muted task-detail mono">{t.upn}{t.note ? ` — ${t.note}` : ''}</div>
        </div>
      ))}
    </div>
  );
}
