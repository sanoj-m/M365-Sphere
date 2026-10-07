// Client-side persistence for server-fetched data. Everything the dashboard
// pulls from the API is mirrored here so a page reload shows the last known
// state instantly; entries are overwritten on each successful refresh and only
// removed via cacheClearAll() (Settings → Danger zone → "Delete all saved data").
const PREFIX = 'm365cache:';

export function cacheGet(key, fallback = null) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function cacheSet(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Quota exceeded — keep the app working without persistence.
  }
}

export function cacheClearAll() {
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith(PREFIX)) localStorage.removeItem(k);
    }
  } catch { }
}
