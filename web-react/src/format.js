export const fmtBytes = n => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(n >= 100 || i === 0 ? 0 : 1) + ' ' + u[i];
};

// All log/job timestamps are stored as UTC ISO strings. Display preferences are
// user-configurable (Settings → Time display): 12/24-hour clock and timezone.
// Defaults: 12-hour clock, Asia/Dubai.
const PREFS_KEY = 'm365time';
export const getTimePrefs = () => {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    return { h12: p.h12 !== false, tz: p.tz || 'Asia/Dubai' };
  } catch { return { h12: true, tz: 'Asia/Dubai' }; }
};
export const setTimePrefs = p => {
  localStorage.setItem(PREFS_KEY, JSON.stringify({ ...getTimePrefs(), ...p }));
  _cache = null;
};

let _cache = null;
function fmts() {
  const p = getTimePrefs();
  if (_cache && _cache.key === p.h12 + '|' + p.tz) return _cache;
  const f = {
    key: p.h12 + '|' + p.tz,
    time: new Intl.DateTimeFormat('en-US', { timeZone: p.tz, hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: p.h12 }),
    date: new Intl.DateTimeFormat('en-GB', { timeZone: p.tz, day: '2-digit', month: '2-digit', year: 'numeric' }),
    dateTime: new Intl.DateTimeFormat('en-US', { timeZone: p.tz, day: '2-digit', month: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: p.h12 })
  };
  _cache = f;
  return f;
}
const asDate = ts => { const d = new Date(ts); return isNaN(d) ? null : d; };
export const fmtTime = ts => { const d = asDate(ts); return d ? fmts().time.format(d) : ''; };
export const fmtDate = ts => { const d = asDate(ts); return d ? fmts().date.format(d) : ''; };
export const fmtDateTime = ts => { const d = asDate(ts); return d ? fmts().dateTime.format(d) : ''; };
