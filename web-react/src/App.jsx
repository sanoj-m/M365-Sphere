import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Activity, AlertCircle, ArrowRight, Bell, Check, CheckCircle2, Clock3, Download, Eye, EyeOff, Filter, Globe, HardDrive, Mail, ScanLine, Settings, Square, User, Users, X } from 'lucide-react';
import { EmailToolsNav } from './components/ToolPageHeader.jsx';
import { api, post, del } from './api.js';
import { cacheGet, cacheSet, cacheClearAll } from './cache.js';
import { useLive } from './live.jsx';
import { useModal } from './components/useModal.js';
import { dialog } from './dialog.jsx';
import { fmtBytes, fmtTime } from './format.js';
import Reveal from './components/Reveal.jsx';
import SetupPanel from './components/SetupPanel.jsx';
import MailboxTable from './components/MailboxTable.jsx';
import DetailPanel from './components/DetailPanel.jsx';
import BackupPage from './components/BackupPage.jsx';
import PstPlanBuilder from './components/PstPlanBuilder.jsx';
import ErrorReport from './components/ErrorReport.jsx';
import StorageManager from './components/StorageManager.jsx';
import TasksPanel from './components/TasksPanel.jsx';
import SettingsPanel from './components/SettingsPanel.jsx';

function StatCard({ n, label, tone, active, meta, kind = 'filter', onClick, icon: Icon, featured }) {
  const statusText = kind === 'visibility'
    ? (active ? 'Included in list' : 'Hidden from list')
    : kind === 'all' ? (active ? 'All shown' : 'Show all') : (active ? 'Filter on' : 'Filter off');
  const StatusIcon = kind === 'visibility' ? (active ? Eye : EyeOff) : (active ? Check : Filter);
  return (
    <button
      type="button"
      className={`card stat ${tone || ''}${active ? ' active' : ''}${featured ? ' featured' : ''}`}
      aria-pressed={active}
      onClick={onClick}
    >
      <span className="stat-top">
        <span className="stat-label">{label}</span>
        {Icon && <span className="stat-icon" aria-hidden="true"><Icon size={17} strokeWidth={1.8} /></span>}
      </span>
      <span className={`stat-state ${active ? 'on' : 'off'}`}><StatusIcon size={11} strokeWidth={2} aria-hidden="true" />{statusText}</span>
      <span className="stat-bottom">
        <span className="n">{n}</span>
        {meta ? <span className="stat-meta">{meta}</span> : null}
      </span>
    </button>
  );
}

const jobKindLabels = {
  backup: 'Mailbox backup', verify: 'Mailbox verification', sizes: 'Exchange size fetch', scan: 'Mailbox count scan',
  pst: 'PST export', 'move-email': 'Move email', 'copy-email': 'Copy email', 'move-email-undo': 'Undo move email',
  dedupe: 'Local dedupe', 'dedupe-check': 'Duplicate scan', 'dedupe-live': 'Move duplicates aside', 'exo-export': 'Exchange export',
};

function parseJobDetail(detail) {
  if (!detail || typeof detail !== 'string') return detail || null;
  try { return JSON.parse(detail); } catch { return detail; }
}

export default function App() {
  const [status, setStatus] = useState(() => cacheGet('status', null));
  const [mailboxes, setMailboxes] = useState(() => cacheGet('mailboxes', []));
  const [logs, setLogs] = useState(() => cacheGet('logs', []));
  const [detail, setDetail] = useState(null);
  const [view, setView] = useState({ name: 'dash' });
  const [consoleErrors, setConsoleErrors] = useState([]);
  const [busy, setBusy] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [statFilter, setStatFilter] = useState(null);
  const [showShared, setShowShared] = useState(true);
  const [showGuests, setShowGuests] = useState(true);
  const [planUpn, setPlanUpn] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [storageOpen, setStorageOpen] = useState(false);
  const [logTab, setLogTab] = useState('activity');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [updating, setUpdating] = useState(false);
  const applyUpdate = async () => {
    const u = status && status.update;
    if (!u || !u.latest || updating) return;
    if (!await dialog.confirm({ title: 'Update M365Sphere', okText: 'Update now', message: `Update from v${u.current} to v${u.latest.version}?${u.latest.notes ? `\n\n${u.latest.notes}` : ''}\n\nThe app restarts itself; backups and config are kept.` })) return;
    setUpdating(true);
    try { await post('/api/update/apply'); } catch { /* socket drops when the server exits mid-reply — expected */ }
    // The server downloads, swaps files and restarts. Reload once it is back.
    const t0 = Date.now();
    const poll = () => api('/api/status').then(() => window.location.reload())
      .catch(() => (Date.now() - t0 < 120000 ? setTimeout(poll, 3000) : setUpdating(false)));
    setTimeout(poll, 5000);
  };
  const [theme, setTheme] = useState(() => cacheGet('theme', 'dark'));
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    cacheSet('theme', theme);
  }, [theme]);
  const [logOpen, setLogOpen] = useState(() => cacheGet('logOpen', true));
  const logRef = useRef(null);
  const notificationRef = useRef(null);
  const notificationButtonRef = useRef(null);
  const live = useLive();
  const detailModalRef = useModal(useCallback(() => setDetail(null), []));
  useEffect(() => {
    if (!notificationsOpen) return;
    const onPointerDown = e => {
      if (notificationRef.current && !notificationRef.current.contains(e.target)) setNotificationsOpen(false);
    };
    const onKeyDown = e => {
      if (e.key !== 'Escape') return;
      setNotificationsOpen(false);
      if (notificationButtonRef.current) notificationButtonRef.current.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [notificationsOpen]);

  const pushLog = useCallback(e => setLogs(l => [...l.slice(-500), e]), []);
  const clearLogs = useCallback(async () => {
    try { await del('/api/logs'); setLogs([]); }
    catch (e) { pushLog({ ts: new Date().toISOString(), level: 'error', mailbox: '', message: 'clear logs failed: ' + e.message }); }
  }, [pushLog]);
  useEffect(() => { api('/api/logs?n=500').then(rows => setLogs(rows)).catch(() => {}); }, []);
  useEffect(() => { cacheSet('logOpen', logOpen); }, [logOpen]);
  // Keep the log popover below the header: at the top of the page it starts
  // under the header; once scrolled past, it sticks to a small top margin.
  useEffect(() => {
    const header = document.querySelector('header');
    const update = () => {
      const bottom = header ? header.getBoundingClientRect().bottom : 0;
      document.documentElement.style.setProperty('--log-top', Math.max(16, Math.round(bottom) + 8) + 'px');
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    const ro = header && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    if (ro && header) ro.observe(header);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      if (ro) ro.disconnect();
    };
  }, []);
  useEffect(() => {
    const t = setTimeout(() => cacheSet('logs', logs), 1000);
    return () => clearTimeout(t);
  }, [logs]);
  const load = useCallback(async () => {
    try {
      const s = await api('/api/status');
      const m = await api('/api/mailboxes');
      setStatus(s);
      setMailboxes(m);
      cacheSet('status', s);
      cacheSet('mailboxes', m);
    } catch (e) {
      pushLog({ ts: new Date().toISOString(), level: 'error', mailbox: '', message: 'status refresh failed: ' + e.message });
    }
  }, [pushLog]);
  const [clearStep, setClearStep] = useState(0); // 0 = closed, 1 = first confirm, 2 = type-to-confirm
  const [clearText, setClearText] = useState('');
  const clearStoredData = useCallback(() => { setClearText(''); setClearStep(1); }, []);
  const doClearStoredData = useCallback(() => {
    setClearStep(0);
    cacheClearAll();
    setLogs([]);
    load();
  }, [load]);

  useEffect(() => {
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, 4000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    // SSE progress fires up to every 500ms — throttle the refetch it triggers.
    let last = 0, timer = null;
    const onProgress = () => {
      const now = Date.now();
      if (now - last > 1000) { last = now; load(); }
      else if (!timer) timer = setTimeout(() => { timer = null; last = Date.now(); load(); }, 1000);
    };
    const unsub = live.subscribe(pushLog, onProgress);
    return () => { unsub(); clearTimeout(timer); };
  }, [live, pushLog, load]);
  useEffect(() => {
    const push = message => setConsoleErrors(l => [...l.slice(-99), { ts: new Date().toISOString(), message: String(message).slice(0, 1000) }]);
    const onError = e => push(e.message + (e.filename ? ` (${e.filename}:${e.lineno})` : ''));
    const onRejection = e => push('unhandled rejection: ' + (e.reason && (e.reason.stack || e.reason.message || e.reason)));
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => { window.removeEventListener('error', onError); window.removeEventListener('unhandledrejection', onRejection); };
  }, []);
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) el.scrollTop = el.scrollHeight;
  }, [logs]);

  const act = useCallback((path, upn) => {
    setBusy(true);
    post(path, upn ? { upn } : {}).catch(e => pushLog({ ts: new Date().toISOString(), level: 'error', mailbox: upn || '', message: e.message })).finally(() => setBusy(false));
  }, [pushLog]);

  const startBackup = useCallback(async (upns, scope) => {
    if (!upns.length) return;
    setActionError(null);
    try {
      const r = await post('/api/backup', scope ? { upns, scope } : { upns });
      if (r && r.queued) {
        pushLog({ ts: new Date().toISOString(), level: 'info', mailbox: '', message: `Backup for ${upns.length} mailbox(es) queued — it starts when the running job finishes` });
        load();
        return;
      }
      setView({ name: 'backup', upns });
      load();
    } catch (e) {
      setActionError('Failed to start backup: ' + e.message);
      pushLog({ ts: new Date().toISOString(), level: 'error', mailbox: '', message: e.message });
    }
  }, [load, pushLog]);
  const openBackupView = useCallback(upns => setView({ name: 'backup', upns }), []);
  const startSizes = useCallback(async upns => {
    if (!upns.length) return;
    setActionError(null);
    try {
      await post('/api/sizes', { upns });
      load();
    } catch (e) {
      setActionError('Failed to start size fetch: ' + e.message);
      pushLog({ ts: new Date().toISOString(), level: 'error', mailbox: '', message: e.message });
    }
  }, [load, pushLog]);
  const startScan = useCallback(async upns => {
    setActionError(null);
    try {
      await post('/api/scan', upns && upns.length ? { upns } : {});
      load();
    } catch (e) {
      setActionError('Failed to start count scan: ' + e.message);
      pushLog({ ts: new Date().toISOString(), level: 'error', mailbox: '', message: e.message });
    }
  }, [load, pushLog]);

  const a = status ? status.aggregates : { total: 0, done: 0, partial: 0, errors: 0, pending: 0, primaryBytes: 0, archiveBytes: 0 };
  const licensedCount = mailboxes.filter(m => m.type === 'user').length;
  const sharedCount = mailboxes.filter(m => m.type === 'shared').length;
  const guestCount = mailboxes.filter(m => m.type === 'guest').length;
  // Type visibility is controlled by the Shared/Guests tiles themselves;
  // remaining tiles apply status/type filters on top of the visible set.
  const toggleFilter = f => setStatFilter(cur => (cur === f ? null : f));
  const nextStep = !a.total ? 1
    : (a.primaryBytes + a.archiveBytes === 0 ? 2
    : (a.done + a.partial + a.errors < a.total ? 3 : 4));
  const jobs = status ? status.jobs.filter(j => j.status === 'running') : [];
  const pstJob = jobs.find(j => j.kind === 'pst') || null;
  const taskCount = jobs.length + ((status && status.fixTasks) || []).filter(t => t.status === 'queued' || t.status === 'waiting').length;
  const notificationCount = (live && !live.connected ? 1 : 0)
    + (status && status.autoResumeSuppressed ? 1 : 0)
    + (status && status.update && status.update.latest ? 1 : 0);
  return (
    <>
      <Reveal index={0} className={notificationsOpen ? 'notifications-open' : ''}>
        <header className="dashboard-header">
          <div className="navbar">
            <a className="brand" href="/" title="Go to homepage">
              <img className="brand-icon" src="/logo.png" alt="M365Sphere logo" />
              <div className="brand-copy">
                <h1>M365Sphere</h1>
                <span className="header-sub">Mailbox backup, verification and PST export for Microsoft 365.</span>
              </div>
            </a>
            <EmailToolsNav>
              <button type="button" className="nav-action" title="Walk every mailbox's folders and re-count the emails on the server (no download) — makes the 'X / Y emails' totals accurate before backing up" disabled={busy || (status && (status.scanRunning || status.running))} onClick={() => startScan()}>
                <ScanLine size={16} aria-hidden="true" /><span>Scan counts</span>
              </button>
            </EmailToolsNav>
            <div className="navbar-actions">
              {status && status.configured && (
                <span className="connection-status" title={`Connected — ${status.tenant}${status.archiveGranted ? ' · archive granted' : ''}`}>
                  <span className="dot" /><span>Connected</span>
                </span>
              )}
              <div className="notification-root" ref={notificationRef}>
                <button
                  ref={notificationButtonRef}
                  type="button"
                  className="notification-button"
                  aria-label={`Notifications${notificationCount ? `, ${notificationCount} active ${notificationCount === 1 ? 'alert' : 'alerts'}` : ''}`}
                  aria-expanded={notificationsOpen}
                  aria-controls="dashboard-notifications"
                  onClick={() => setNotificationsOpen(v => !v)}
                >
                  <Bell size={18} strokeWidth={1.8} aria-hidden="true" />
                  {notificationCount > 0 && <span className="notification-badge" aria-hidden="true">{notificationCount}</span>}
                </button>
                {notificationsOpen && (
                  <section className="notification-panel" id="dashboard-notifications" aria-label="Notifications">
                    <div className="notification-head">
                      <div>
                        <h2>Notifications</h2>
                        <span>{notificationCount ? `${notificationCount} active ${notificationCount === 1 ? 'alert' : 'alerts'}` : 'All systems normal'}</span>
                      </div>
                      <button type="button" className="notification-close" aria-label="Close notifications" onClick={() => setNotificationsOpen(false)}><X size={16} aria-hidden="true" /></button>
                    </div>
                    <div className="notification-list">
                      {status && status.configured && (
                        <div className="notification-item">
                          <span className="notification-item-icon success" aria-hidden="true"><CheckCircle2 size={17} /></span>
                          <div className="notification-content">
                            <strong>Connected to {status.tenant}</strong>
                            <p>Microsoft 365 access is active{status.archiveGranted ? ' · Archive access granted' : ''}.</p>
                          </div>
                        </div>
                      )}
                      {live && !live.connected && (
                        <div className="notification-item">
                          <span className="notification-item-icon warn" aria-hidden="true"><AlertCircle size={17} /></span>
                          <div className="notification-content">
                            <strong>Live updates paused</strong>
                            <p>Reconnecting to the live event stream. Background jobs continue normally.</p>
                          </div>
                        </div>
                      )}
                      {status && status.autoResumeSuppressed && (
                        <div className="notification-item">
                          <span className="notification-item-icon warn" aria-hidden="true"><AlertCircle size={17} /></span>
                          <div className="notification-content">
                            <strong>Auto-resume is off</strong>
                            <p>Incomplete mailboxes will not resume automatically after a manual stop.</p>
                          </div>
                        </div>
                      )}
                      {status && status.update && status.update.latest && (
                        <div className="notification-item">
                          <span className="notification-item-icon info" aria-hidden="true"><Download size={17} /></span>
                          <div className="notification-content">
                            <strong>{updating || status.update.status === 'applying' ? 'Updating M365Sphere' : status.update.status === 'downloading' ? 'Downloading update' : `Update available — v${status.update.latest.version}`}</strong>
                            <p>{updating || status.update.status === 'applying' || status.update.status === 'downloading' ? 'The app will restart when the update is applied.' : `Version ${status.update.latest.version} is ready to install.`}</p>
                            <button type="button" className="btn small primary" disabled={updating || status.update.status === 'downloading' || status.update.status === 'applying'} title={status.update.latest.notes || 'Install the latest version'} onClick={() => { setNotificationsOpen(false); applyUpdate(); }}>
                              {updating || status.update.status === 'applying' ? 'Updating…' : status.update.status === 'downloading' ? 'Downloading…' : 'Update now'}
                            </button>
                          </div>
                        </div>
                      )}
                      {!status && <div className="notification-empty">Checking system status…</div>}
                      {status && !status.configured && !notificationCount && <div className="notification-empty">No new notifications.</div>}
                    </div>
                  </section>
                )}
              </div>
              <button type="button" className="btn ghost settings-btn" onClick={() => setSettingsOpen(true)}><Settings size={16} aria-hidden="true" /><span>Settings</span></button>
            </div>
          </div>
          <div className="workflow-bar">
            <span className="action-label">Backup workflow</span>
            <div className="pipeline" role="group" aria-label="Backup workflow steps">
              <button className={`step${nextStep === 1 ? ' suggested' : ''}`} disabled={busy || (status && status.running)} onClick={() => act('/api/discover')}>
                <span className="step-n">1</span><span className="step-label">Discover</span>
              </button>
              <button className={`step${nextStep === 2 ? ' suggested' : ''}`} title="Authoritative sizes from Exchange Online, plus the API-accessible archive portion (EWS) for archive mailboxes" disabled={busy || (status && status.sizesRunning)} onClick={() => act('/api/sizes')}>
                <span className="step-n">2</span><span className="step-label">Fetch Sizes</span>
              </button>
              <button className={`step${nextStep === 3 ? ' suggested' : ''}`} disabled={busy || (status && status.running)} onClick={() => act('/api/verify')}>
                <span className="step-n">3</span><span className="step-label">Verify All</span>
              </button>
              <button className={`step${nextStep === 4 ? ' suggested' : ''}`} disabled={busy || (status && status.pstRunning)} onClick={() => act('/api/pst')}>
                <span className="step-n">4</span><span className="step-label">Export PST (All)</span>
              </button>
            </div>
            {status && (status.running || status.sizesRunning || status.scanRunning) && (
              <div className="workflow-actions">
                <div className="actions-group danger-zone" role="group" aria-label="Stop controls">
                  <button className="btn danger" disabled={busy} onClick={() => act('/api/stop')}><Square size={11} fill="currentColor" aria-hidden="true" />Stop</button>
                  {status.running && <button className="btn small" disabled={busy} title="Stop syncing the primary mailbox only — the archive sync continues" onClick={() => post('/api/stop', { scope: 'primary' }).catch(e => pushLog({ ts: new Date().toISOString(), level: 'error', mailbox: '', message: e.message }))}>Stop primary</button>}
                  {status.running && <button className="btn small" disabled={busy} title="Stop syncing online archives only — the primary sync continues" onClick={() => post('/api/stop', { scope: 'archive' }).catch(e => pushLog({ ts: new Date().toISOString(), level: 'error', mailbox: '', message: e.message }))}>Stop archive</button>}
                </div>
              </div>
            )}
          </div>
          {status && status.exoSignIn && (
            <div className="exo-signin" role="status">
              <p><b>Exchange sign-in required</b> — open <a href={status.exoSignIn.url} target="_blank" rel="noreferrer">{status.exoSignIn.url}</a> and enter code:</p>
              <div className="devcode">{status.exoSignIn.code}</div>
            </div>
          )}
          {status && (!status.configured || showSetup) && <SetupPanel onDone={() => { setShowSetup(false); load(); }} />}
        </header>
      </Reveal>

      <Reveal index={1}>
        <section className="stats-section" aria-labelledby="mailbox-overview-title">
          <div className="section-heading">
            <h2 id="mailbox-overview-title">Mailbox overview</h2>
            <span>Select a metric to filter the mailbox list</span>
          </div>
          <div className="stats">
            <StatCard n={a.total} label="Total mailboxes" icon={Mail} kind="all" featured active={!statFilter && showShared && showGuests} onClick={() => { setStatFilter(null); setShowShared(true); setShowGuests(true); }} />
            <StatCard n={licensedCount} label="Licensed" icon={User} active={statFilter === 'user'} onClick={() => toggleFilter('user')} />
            <StatCard n={sharedCount} label="Shared" icon={Users} tone="info" kind="visibility" active={showShared} onClick={() => setShowShared(v => !v)} />
            <StatCard n={guestCount} label="Guests" icon={Globe} tone="warn" kind="visibility" active={showGuests} onClick={() => setShowGuests(v => !v)} />
            <StatCard n={a.done} label="Fully backed up" icon={CheckCircle2} tone="ok" active={statFilter === 'done'} onClick={() => toggleFilter('done')} />
            <StatCard n={a.partial} label="Partial (pending)" icon={Clock3} tone="warn" active={statFilter === 'partial'} onClick={() => toggleFilter('partial')} />
            <StatCard n={a.errors} label="Errors" icon={AlertCircle} tone={a.errors ? 'bad' : 'ok'} active={statFilter === 'error'} onClick={() => toggleFilter('error')} />
            <StatCard n={fmtBytes(a.primaryBytes + a.archiveBytes)} label="Backed up" icon={HardDrive} featured meta="Primary + archive" active={statFilter === 'bytes'} onClick={() => toggleFilter('bytes')} />
          </div>
        </section>
      </Reveal>

      {jobs.length > 0 && (
        <Reveal index={2}>
          <div className="job-stack">
            {jobs.map(job => {
              const total = Number(job.total) || 0;
              const done = Number(job.done) || 0;
              const pct = total ? Math.min(100, Math.max(0, Math.round(100 * done / total))) : 0;
              const data = parseJobDetail(job.detail);
              const structured = data && typeof data === 'object';
              const source = structured ? data.srcUpn : '';
              const destination = structured ? (data.dstUpn || (data.target === 'local' ? 'Local backup' : '')) : '';
              const plainDetail = !structured && typeof data === 'string' ? data : '';
              const hasOutcomes = structured && ['done', 'skipped', 'failed'].some(key => data[key] != null);
              const doneLabel = job.kind === 'move-email' ? 'moved' : job.kind === 'copy-email' ? 'copied' : 'processed';
              const kindLabel = jobKindLabels[job.kind] || job.kind.replace(/-/g, ' ');
              const taskHref = job.kind === 'move-email' ? '/?moveemail' : job.kind === 'copy-email' ? '/?copyemail' : null;
              return (
                <section className="jobbar card" key={job.id}>
                  <span className="job-symbol" aria-hidden="true"><Activity size={19} strokeWidth={1.8} /></span>
                  <div className="job-main">
                    <div className="job-heading">
                      <span className="kind">{kindLabel}</span>
                      <span className="job-status"><span className="job-status-dot" />Running</span>
                    </div>
                    {(source || destination) ? (
                      <div className="job-route">
                        {source && <span>{source}</span>}
                        {source && destination && <ArrowRight size={14} aria-hidden="true" />}
                        {destination && <span>{destination}</span>}
                      </div>
                    ) : plainDetail ? <div className="job-description" title={plainDetail}>{plainDetail}</div> : null}
                    <div className="job-meta">
                      <span className="job-count">{done.toLocaleString()}{total ? ` of ${total.toLocaleString()}` : ''} items</span>
                      {hasOutcomes && (
                        <span className="job-outcomes">
                          <span>{Number(data.done) || 0} {doneLabel}</span>
                          <span>{Number(data.skipped) || 0} skipped</span>
                          <span className={Number(data.failed) ? 'has-failures' : ''}>{Number(data.failed) || 0} failed</span>
                        </span>
                      )}
                    </div>
                    <div className={`bar${total ? '' : ' indet'}`} role="progressbar" aria-label={`${kindLabel} progress`} aria-valuemin="0" aria-valuemax="100" aria-valuenow={total ? pct : undefined} aria-valuetext={total ? `${pct}% complete` : 'In progress'}>
                      <div className="fill" style={total ? { width: pct + '%' } : undefined} />
                    </div>
                  </div>
                  <div className="job-side">
                    <span className="job-percent">{total ? `${pct}%` : 'Active'}</span>
                    {job.kind === 'backup' && (
                      <button className="btn small primary jobbar-open" onClick={() => {
                        const jobUpns = status && Array.isArray(status.jobUpns) ? status.jobUpns : [];
                        const syncing = mailboxes.filter(m => m.status === 'syncing').map(m => m.upn);
                        const liveUpns = status && status.live ? Object.keys(status.live) : [];
                        const upns = jobUpns.length
                          ? jobUpns
                          : [...new Set([...liveUpns, ...syncing, ...(job.detail ? [job.detail] : [])])];
                        if (upns.length === 1) {
                          window.location.href = '/?mailbox=' + encodeURIComponent(upns[0]);
                        } else if (upns.length) {
                          openBackupView(upns);
                        } else {
                          pushLog({ ts: new Date().toISOString(), level: 'warn', mailbox: '', message: 'Open live view: no active mailbox detected yet — the backup may be between mailboxes, try again in a few seconds.' });
                        }
                      }}>Open live view{status && status.jobUpns && status.jobUpns.length > 1 ? ` (${status.jobUpns.length} mailboxes)` : ''}<ArrowRight size={13} aria-hidden="true" /></button>
                    )}
                    {taskHref && <a className="btn small ghost jobbar-open" href={taskHref}>View task<ArrowRight size={13} aria-hidden="true" /></a>}
                  </div>
                </section>
              );
            })}
          </div>
        </Reveal>
      )}

      {actionError && view.name === 'dash' && (
        <div className="banner-error card" role="alert">
          {actionError}
          <button className="btn small" onClick={() => setActionError(null)}>Dismiss</button>
        </div>
      )}

      {view.name === 'backup' ? (
        <BackupPage upns={view.upns} onBack={() => setView({ name: 'dash' })} onChanged={load} />
      ) : (
        <>
          <div className="content-row">
            <MailboxTable mailboxes={mailboxes} busy={busy || (status && status.running)} sizesBusy={busy || (status && status.sizesRunning)} scanBusy={busy || (status && (status.scanRunning || status.running))} pstJob={pstJob} fixTasks={status && status.fixTasks} onDetail={setDetail} onAct={act} onBackup={startBackup} onSizes={startSizes} onScan={startScan} onView={openBackupView} onPlan={setPlanUpn} statFilter={statFilter} onClearFilter={() => setStatFilter(null)} showShared={showShared} showGuests={showGuests} />
          </div>
          {logOpen ? (
            <aside className="logs log-sidebar" aria-label="Activity and running tasks">
              <div className="log-head">
                <button className="log-iconbtn" title="Collapse panel" aria-label="Collapse panel" onClick={() => setLogOpen(false)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>
                </button>
                <span className="log-tabs" role="tablist">
                  <button role="tab" aria-selected={logTab === 'activity'} className={`log-tab${logTab === 'activity' ? ' on' : ''}`} onClick={() => setLogTab('activity')}>Activity</button>
                  <button role="tab" aria-selected={logTab === 'tasks'} className={`log-tab${logTab === 'tasks' ? ' on' : ''}`} onClick={() => setLogTab('tasks')}>
                    Running tasks{taskCount ? ` (${taskCount})` : ''}
                  </button>
                </span>
                <span className="spacer" />
                {logTab === 'activity' && <span className="live"><span className="dot" /> live</span>}
                {logTab === 'activity' && <span className="log-count" role="status" aria-atomic="true">{logs.length} {logs.length === 1 ? 'entry' : 'entries'}</span>}
                {logTab === 'activity' && (
                  <button className="log-iconbtn danger" title="Clear activity log" aria-label="Clear activity log" onClick={clearLogs}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
                  </button>
                )}
              </div>
              {logTab === 'activity' ? (
                <div className="logbox" ref={logRef}>
                  {logs.length === 0 && <div className="log-empty">No activity yet — run a workflow step to see live output.</div>}
                  {logs.map((e, i) => (
                    <div key={i} className={'log-line ' + e.level}>
                      <span className="log-dot" aria-hidden="true" />
                      <span className="log-body">
                        <span className="log-ts">{fmtTime(e.ts)}</span>
                        {e.mailbox ? <span className="log-mb"> {e.mailbox}</span> : null}
                        <span className="log-msg"> {e.message}</span>
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <TasksPanel status={status} logs={logs} />
              )}
            </aside>
          ) : (
            <button className="log-rail" title="Expand activity log" aria-label="Expand activity log" onClick={() => setLogOpen(true)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>
              <span className="log-rail-label">Activity log</span>
              {logs.length > 0 && <span className="log-rail-count">{logs.length > 99 ? '99+' : logs.length}</span>}
            </button>
          )}
        </>
      )}

      {detail && view.name === 'dash' && (
        <div className="modal-backdrop" onClick={() => setDetail(null)}>
          <div className="modal-card" role="dialog" aria-modal="true" aria-label={`Mailbox details for ${detail}`} ref={detailModalRef} onClick={e => e.stopPropagation()}>
            <DetailPanel upn={detail} onClose={() => setDetail(null)} />
          </div>
        </div>
      )}

      {planUpn && <PstPlanBuilder upn={planUpn} onClose={() => { setPlanUpn(null); load(); }} />}

      {storageOpen && <StorageManager onClose={() => setStorageOpen(false)} onChanged={load} onBrowse={upns => { setStorageOpen(false); openBackupView(upns); }} />}

      {settingsOpen && (
        <SettingsPanel
          theme={theme}
          onTheme={setTheme}
          onOpenSetup={() => { setSettingsOpen(false); setShowSetup(true); }}
          onOpenStorage={() => { setSettingsOpen(false); setStorageOpen(true); }}
          onDeleteAll={() => { setSettingsOpen(false); clearStoredData(); }}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      <ErrorReport status={status} logs={logs} consoleErrors={consoleErrors} />

      {clearStep > 0 && (
        <div className="modal-backdrop" onClick={() => setClearStep(0)}>
          <div className="modal-card confirm-card" role="dialog" aria-modal="true" aria-label="Confirm deleting all saved data" onClick={e => e.stopPropagation()}>
            {clearStep === 1 ? (
              <>
                <h3>Delete all saved data?</h3>
                <p>This deletes everything the dashboard has saved in <b>this browser</b>: the cached mailbox list, status, activity log and preferences.</p>
                <p>Your backups on disk and all server data are <b>not</b> deleted — everything is re-fetched from the server on the next refresh.</p>
                <div className="confirm-actions">
                  <button className="btn" onClick={() => setClearStep(0)}>Cancel</button>
                  <button className="btn danger" onClick={() => setClearStep(2)}>Continue</button>
                </div>
              </>
            ) : (
              <>
                <h3>Are you sure?</h3>
                <p>This is the final confirmation. Type <b className="mono">delete everything</b> below to delete all saved data.</p>
                <input
                  className="confirm-input"
                  autoFocus
                  value={clearText}
                  onChange={e => setClearText(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && clearText.trim().toLowerCase() === 'delete everything') doClearStoredData(); }}
                  placeholder="delete everything"
                  aria-label="Type delete everything to confirm"
                />
                <div className="confirm-actions">
                  <button className="btn" onClick={() => setClearStep(0)}>Cancel</button>
                  <button className="btn danger" disabled={clearText.trim().toLowerCase() !== 'delete everything'} onClick={doClearStoredData}>Delete all saved data</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
