import React, { useEffect, useState } from 'react';
import { api, post } from '../api.js';
import { dialog } from '../dialog.jsx';

// Master stop switch — floating button pinned to the top-right corner of every
// page. One click (with confirm) halts ALL running jobs via POST /api/stop.
export default function MasterStopFab() {
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    let alive = true;
    const poll = () => api('/api/status').then(s => {
      if (!alive) return;
      setBusy(!!(s.running || s.sizesRunning || s.scanRunning || s.pstRunning || s.compareRunning
        || s.copyEmailRunning || s.moveEmailRunning || (s.exoExport && s.exoExport.running)
        || (s.dedupeRuns && s.dedupeRuns.length) || (s.dedupeChecks && s.dedupeChecks.length)));
    }).catch(() => {});
    poll();
    const t = setInterval(poll, 4000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  const stopAll = async () => {
    if (!busy || stopping) return;
    if (!await dialog.confirm({ title: 'Stop everything', danger: true, okText: 'Stop all', message: 'Stop ALL running tasks now (backups, PST exports, scans, copies, moves, dedupe, EXO export)? Jobs resume safely later — nothing is deleted.' })) return;
    setStopping(true);
    try { await post('/api/stop'); } catch { }
    setTimeout(() => setStopping(false), 3000);
  };
  return (
    <button
      className={`master-stop-fab${busy ? ' active' : ''}`}
      title={busy ? 'MASTER STOP — halt all running tasks' : 'Master stop (nothing is running)'}
      aria-label="Stop all running tasks"
      aria-pressed={stopping}
      disabled={!busy || stopping}
      onClick={stopAll}
    >
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3v9" />
        <path d="M18.4 6.6a8 8 0 11-12.8 0" />
      </svg>
      {busy && <span className="fab-pulse" aria-hidden="true" />}
    </button>
  );
}
