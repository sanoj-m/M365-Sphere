import React, { useState, useEffect, useCallback } from 'react';
import { api, del, post } from '../api.js';
import PstPlanBuilder from './PstPlanBuilder.jsx';
import { dialog } from '../dialog.jsx';
import CopyWizard from './CopyWizard.jsx';
import DedupeModal from './DedupeModal.jsx';
import { ScopePanel } from './browse.jsx';

const chipClass = s => ({ done: 'done', partial: 'partial', error: 'error', pending: 'pending', syncing: 'syncing' }[s] || 'none');

function MailboxCard({ upn, onChanged }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [dedupeOpen, setDedupeOpen] = useState(false);

  const load = useCallback(() => {
    Promise.all([
      api('/api/mailbox/' + encodeURIComponent(upn) + '/folders'),
      api('/api/mailbox/' + encodeURIComponent(upn))
    ])
      .then(([f, m]) => { setD({ ...f, mailbox: m }); setErr(null); })
      .catch(e => setErr(e.message));
  }, [upn]);
  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  const removeBackup = async scope => {
    const what = scope ? `the stored ${scope} backup` : 'the stored backup (primary + archive)';
    if (!await dialog.confirm({ title: 'Delete backup', danger: true, okText: 'Delete', message: `Delete ${what} of ${upn}? Locally stored emails (.eml.gz) and database records for ${scope ? 'that scope' : 'both scopes'} will be removed. This cannot be undone.` })) return;
    setDeleting(true);
    del('/api/mailbox/' + encodeURIComponent(upn) + '/backup' + (scope ? '?scope=' + scope : '')).then(onChanged).catch(e => setErr(e.message)).finally(() => setDeleting(false));
  };
  const removePst = async () => {
    if (!await dialog.confirm({ title: 'Delete PST files', danger: true, okText: 'Delete', message: `Delete all exported PST files of ${upn}? This cannot be undone.` })) return;
    setDeleting(true);
    del('/api/pst/' + encodeURIComponent(upn)).then(onChanged).catch(e => setErr(e.message)).finally(() => setDeleting(false));
  };

  const stopScope = scope => {
    post('/api/stop', { scope, upn })
      .then(load)
      .catch(e => setErr(e.message));
  };

  if (err && !d) return <div className="card mailcard"><h3 className="mono">{upn}</h3><p className="bad-text">{err}</p></div>;
  if (!d) return <div className="card mailcard"><h3 className="mono">{upn}</h3><p className="muted">Loading folders…</p></div>;

  const live = d.live;
  const folders = d.folders || [];
  const primary = folders.filter(f => f.scope === 'primary');
  const archive = folders.filter(f => f.scope === 'archive');

  return (
    <div className="card mailcard">
      <div className="mailcard-head">
        <h3 className="mono">{upn}</h3>
        <span className={`chip ${chipClass(d.status)}`}>{d.status}</span>
        {d.pstStatus ? <span className="chip info">PST: {d.pstStatus}</span> : null}
        <button className="btn small" onClick={() => setPlanOpen(true)}>Export PST plan</button>
        <button className="btn small" disabled={!folders.some(f => f.backedUp > 0)} title="Copy or move downloaded emails into another live mailbox (works while a backup runs)" onClick={() => setCopyOpen(true)}>Copy to mailbox…</button>
        <button className="btn small" title="Find and move aside duplicate emails (local backup or live mailbox)" onClick={() => setDedupeOpen(true)}>Dedupe…</button>
        <span className="spacer" />
        <button className="btn small danger" disabled={deleting || d.status === 'syncing'} title="Delete downloaded primary mailbox files only (archive is kept)" onClick={() => removeBackup('primary')}>Delete primary</button>
        <button className="btn small danger" disabled={deleting || d.status === 'syncing'} title="Delete downloaded archive files only (primary is kept)" onClick={() => removeBackup('archive')}>Delete archive</button>
        <button className="btn small danger" disabled={deleting || d.status === 'syncing'} title="Delete all stored backup data for this mailbox" onClick={() => removeBackup()}>Delete all</button>
        <button className="btn small danger" disabled={deleting || d.status === 'syncing'} onClick={removePst}>Delete PST files</button>
      </div>
      {err && <p className="bad-text">{err}</p>}

      {live && (
        <div className="livebox">
          <div className="joblabel">
            <span className="kind">Backup running — {live.scope || 'starting'}</span>
            <span>folder {live.foldersDone}/{live.foldersTotal}</span>
            <span className="spacer" />
            <button className="btn small" disabled={live.scope === 'archive'} title="Stop this mailbox's primary sync — its archive sync continues" onClick={() => stopScope('primary')}>Stop primary</button>
            <button className="btn small" disabled={live.scope === 'primary'} title="Stop this mailbox's archive sync — its primary sync continues" onClick={() => stopScope('archive')}>Stop archive</button>
          </div>
          {live.currentFolder && <div className="muted mono current-folder">→ {live.currentFolder}</div>}
        </div>
      )}

      <div className="mailcard-scopes">
        <ScopePanel upn={upn} scope="primary" label="Primary mailbox" rows={primary} live={live} mailbox={d.mailbox} />
        <ScopePanel upn={upn} scope="archive" label="Online archive" rows={archive} live={live} mailbox={d.mailbox} />
      </div>

      {planOpen && <PstPlanBuilder upn={upn} onClose={() => { setPlanOpen(false); load(); }} />}
      {copyOpen && <CopyWizard srcUpn={upn} folders={folders} onClose={() => { setCopyOpen(false); load(); }} />}
      {dedupeOpen && <DedupeModal upn={upn} onClose={() => setDedupeOpen(false)} onChanged={load} />}
    </div>
  );
}

export default function BackupPage({ upns, onBack, onChanged }) {
  return (
    <section className="backup-page">
      <div className="toolbar">
        <button className="btn small" onClick={onBack}>← Back to dashboard</button>
        <h2>Backup detail — {upns.length} mailbox{upns.length === 1 ? '' : 'es'}</h2>
      </div>
      {upns.map(u => <MailboxCard key={u} upn={u} onChanged={onChanged} />)}
    </section>
  );
}
