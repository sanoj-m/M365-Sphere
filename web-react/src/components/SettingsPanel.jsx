import React from 'react';
import { getTimePrefs, setTimePrefs } from '../format.js';

const TIMEZONES = ['Asia/Dubai', 'Asia/Riyadh', 'Asia/Qatar', 'Asia/Kuwait', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Asia/Kolkata', 'Asia/Singapore', 'Australia/Sydney', 'UTC'];

// Settings: home for configuration and advanced/destructive functions,
// kept out of the day-to-day operational header.
export default function SettingsPanel({ theme, onTheme, onOpenSetup, onOpenStorage, onDeleteAll, onClose }) {
  const tp = getTimePrefs();
  const apply = p => { setTimePrefs(p); window.location.reload(); };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card settings-card" role="dialog" aria-modal="true" aria-label="Settings" onClick={e => e.stopPropagation()}>
        <div className="settings-head">
          <h3>Settings</h3>
          <button className="log-iconbtn" title="Close settings" aria-label="Close settings" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>

        <section className="settings-section">
          <h4>Appearance</h4>
          <div className="settings-row">
            <div>
              <div className="settings-label">Theme</div>
              <p className="settings-hint">Switch between dark and light mode. Saved in this browser.</p>
            </div>
            <div className="theme-switch" role="group" aria-label="Theme">
              <button
                className={`theme-opt${theme === 'dark' ? ' active' : ''}`}
                aria-pressed={theme === 'dark'}
                onClick={() => onTheme('dark')}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1111.2 3 7 7 0 0021 12.8z"/></svg>
                Dark
              </button>
              <button
                className={`theme-opt${theme === 'light' ? ' active' : ''}`}
                aria-pressed={theme === 'light'}
                onClick={() => onTheme('light')}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
                Light
              </button>
            </div>
          </div>
        </section>

        <section className="settings-section">
          <h4>Time display</h4>
          <div className="settings-row">
            <div>
              <div className="settings-label">Clock format</div>
              <p className="settings-hint">How times are shown across the dashboard. Reloads the page.</p>
            </div>
            <div className="theme-switch" role="group" aria-label="Clock format">
              <button className={`theme-opt${tp.h12 ? ' active' : ''}`} aria-pressed={tp.h12} onClick={() => apply({ h12: true })}>12-hour</button>
              <button className={`theme-opt${!tp.h12 ? ' active' : ''}`} aria-pressed={!tp.h12} onClick={() => apply({ h12: false })}>24-hour</button>
            </div>
          </div>
          <div className="settings-row">
            <div>
              <div className="settings-label">Timezone</div>
              <p className="settings-hint">All stored timestamps stay UTC — only display changes.</p>
            </div>
            <select className="btn ghost" value={tp.tz} onChange={e => apply({ tz: e.target.value })} aria-label="Timezone">
              {TIMEZONES.includes(tp.tz) ? null : <option value={tp.tz}>{tp.tz}</option>}
              {TIMEZONES.map(z => <option key={z} value={z}>{z}</option>)}
            </select>
          </div>
        </section>

        <section className="settings-section">
          <h4>Microsoft 365 connection</h4>
          <div className="settings-row">
            <div>
              <div className="settings-label">Tenant &amp; credentials</div>
              <p className="settings-hint">Edit the tenant, app registration and certificate used to connect.</p>
            </div>
            <button className="btn ghost" onClick={onOpenSetup}>Open setup</button>
          </div>
        </section>

        <section className="settings-section">
          <h4>Stored data</h4>
          <div className="settings-row">
            <div>
              <div className="settings-label">Backups on disk</div>
              <p className="settings-hint">Inspect, browse or delete downloaded mailbox backups and PST exports.</p>
            </div>
            <button className="btn ghost" onClick={onOpenStorage}>Manage stored data</button>
          </div>
        </section>

        <section className="settings-section danger-section">
          <h4>Danger zone</h4>
          <div className="settings-row">
            <div>
              <div className="settings-label">Delete all saved data</div>
              <p className="settings-hint">
                Deletes everything this dashboard has saved in <b>this browser</b> — cached mailbox list,
                status, activity log and preferences. Backups on disk and server data are <b>not</b> touched.
                Requires double confirmation.
              </p>
            </div>
            <button className="btn danger" onClick={onDeleteAll}>Delete all saved data…</button>
          </div>
        </section>
      </div>
    </div>
  );
}
