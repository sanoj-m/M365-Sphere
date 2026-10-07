import React, { useState, useEffect, useRef } from 'react';
import { api, post } from '../api.js';
import { dialog } from '../dialog.jsx';

export default function SetupPanel({ onDone }) {
  const [s, setS] = useState(null);
  const [starting, setStarting] = useState(false);
  const prevState = useRef(null);
  useEffect(() => {
    let alive = true;
    const poll = () => api('/api/setup/status').then(x => {
      if (!alive) return;
      setS(x);
      // Auto-close only when a sign-in flow just completed — not when the
      // tenant was already connected before the panel was opened.
      if (x.state === 'done' && (prevState.current === 'pending' || prevState.current === 'running')) onDone();
      prevState.current = x.state;
    }).catch(() => {});
    poll();
    const t = setInterval(poll, 3000);
    return () => { alive = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const start = () => {
    setStarting(true);
    post('/api/setup/login').then(setS).catch(e => setS({ state: 'error', message: e.message })).finally(() => setStarting(false));
  };
  const archive = () => { setS(x => x ? { ...x, archiveNote: null } : x); post('/api/setup/archive').catch(() => {}); };
  const disconnect = async () => {
    if (!await dialog.confirm({ title: 'Disconnect tenant', danger: true, okText: 'Disconnect', message: 'Disconnect this tenant? The stored credentials will be removed from config.json.' })) return;
    post('/api/setup/disconnect').then(setS).catch(e => setS({ state: 'error', message: e.message }));
  };
  return (
    <section className="setup card">
      <h2>Connect to Microsoft 365</h2>
      {(!s || s.state === 'idle') && (
        <>
          <p>Sign in with a <b>Global Admin</b> account. The app registration, permissions, admin consent and client secret are created for you automatically.</p>
          <button className="btn primary" disabled={starting} onClick={start}>Sign in with Microsoft</button>
        </>
      )}
      {s && s.state === 'pending' && (
        <>
          <p>1. Open <a href={s.verificationUri} target="_blank" rel="noreferrer">{s.verificationUri}</a><br />
            2. Enter this code and sign in as Global Admin:</p>
          <div className="devcode">{s.userCode}</div>
          <p className="mono">Waiting for sign-in…</p>
        </>
      )}
      {s && s.state === 'running' && <p className="mono">{s.message}</p>}
      {s && s.state === 'done' && (
        <>
          <p className="good-text">{s.message}</p>
          {s.archiveSignIn && (
            <>
              <p>One more sign-in for <b>online archive</b> access: open <a href={s.archiveSignIn.url} target="_blank" rel="noreferrer">{s.archiveSignIn.url}</a> and enter:</p>
              <div className="devcode">{s.archiveSignIn.code}</div>
            </>
          )}
          {s.archiveNote && (s.archiveNote.ok
            ? <p className="good-text">{s.archiveNote.text}</p>
            : !s.archiveSignIn && <div className="cfg-warn"><pre>{s.archiveNote.text}</pre><button className="btn small" onClick={archive}>Retry archive grant</button></div>)}
          <button className="btn small" onClick={disconnect}>Disconnect tenant</button>
        </>
      )}
      {s && s.state === 'error' && (
        <>
          <p className="bad-text">{s.message}</p>
          <button className="btn" disabled={starting} onClick={start}>Try again</button>
        </>
      )}
    </section>
  );
}
