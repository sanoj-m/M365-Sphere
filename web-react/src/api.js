const token = () => window.__SESSION_TOKEN || '';

// The server mints a new token on every restart. When a call comes back 401,
// pull the fresh token from /session-token.js (no-store) and retry once.
export async function refreshToken() {
  try {
    const t = await (await fetch('/session-token.js', { cache: 'no-store' })).text();
    const m = t.match(/window\.__SESSION_TOKEN\s*=\s*"([^"]+)"/);
    if (m) { window.__SESSION_TOKEN = m[1]; return true; }
  } catch { }
  return false;
}

export function withToken(url) {
  const t = token();
  if (!t) return url;
  return url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(t);
}

async function raw(path, opts) {
  const headers = { 'x-session-token': token() };
  if (opts.body) headers['Content-Type'] = 'application/json';
  return fetch(path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
}

export async function api(path, opts = {}) {
  let r = await raw(path, opts);
  if (r.status === 401 && (await refreshToken())) r = await raw(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

export const post = (path, body = {}) => api(path, { method: 'POST', body });
export const del = path => api(path, { method: 'DELETE' });


