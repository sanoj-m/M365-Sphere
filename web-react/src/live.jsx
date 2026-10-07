import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { withToken, refreshToken } from './api.js';

const LiveCtx = createContext(null);

// One shared EventSource for the whole app; consumers subscribe through context.
export function LiveProvider({ children }) {
  const [connected, setConnected] = useState(true);
  const listeners = useRef({ log: new Set(), progress: new Set() });

  useEffect(() => {
    let es = null;
    let closed = false;
    const connect = () => {
      if (closed) return;
      es = new EventSource(withToken('/api/events'));
      es.addEventListener('log', ev => {
        const d = JSON.parse(ev.data);
        listeners.current.log.forEach(f => f(d));
      });
      es.addEventListener('progress', () => listeners.current.progress.forEach(f => f()));
      es.onopen = () => setConnected(true);
      es.onerror = () => {
        setConnected(false);
        // After a server restart the old token is invalid — fetch the new one,
        // otherwise the browser retries the stale URL forever.
        es.close();
        if (!closed) setTimeout(async () => { await refreshToken(); connect(); }, 3000);
      };
    };
    connect();
    return () => { closed = true; if (es) es.close(); };
  }, []);

  const value = useMemo(() => ({
    connected,
    subscribe(onLog, onProgress) {
      if (onLog) listeners.current.log.add(onLog);
      if (onProgress) listeners.current.progress.add(onProgress);
      return () => { listeners.current.log.delete(onLog); listeners.current.progress.delete(onProgress); };
    }
  }), [connected]);

  return <LiveCtx.Provider value={value}>{children}</LiveCtx.Provider>;
}

export const useLive = () => useContext(LiveCtx);
