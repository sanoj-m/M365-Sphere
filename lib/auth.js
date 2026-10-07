// Client-credentials auth for Microsoft Graph and Exchange Online (EWS).
class Auth {
  constructor(cfg) {
    this.cfg = cfg;
    this.cache = new Map(); // scope -> { tok, exp }
    this.inflight = new Map(); // scope -> Promise<string> (dedup concurrent refreshes)
  }
  clearToken(scope) {
    if (scope) this.cache.delete(scope);
    else this.cache.clear();
  }
  async token(scope) {
    const hit = this.cache.get(scope);
    if (hit && hit.exp > Date.now() + 60 * 1000) return hit.tok;
    const pending = this.inflight.get(scope);
    if (pending) return pending;
    const p = this._fetchToken(scope).finally(() => this.inflight.delete(scope));
    this.inflight.set(scope, p);
    return p;
  }
  async _fetchToken(scope) {
    if (!this.cfg.clientSecret) {
      throw new Error('config.json has no clientSecret (certificate auth is not implemented in this build — use a client secret)');
    }
    const body = new URLSearchParams({
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      scope,
      grant_type: 'client_credentials'
    });
    const r = await fetch(`https://login.microsoftonline.com/${this.cfg.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(this.cfg.httpTimeoutMs || 120000)
    });
    if (!r.ok) {
      const t = (await r.text()).slice(0, 500);
      throw new Error(`token request failed (HTTP ${r.status}): ${t} — check tenantId/clientId/clientSecret and that admin consent was granted`);
    }
    const j = await r.json();
    this.cache.set(scope, { tok: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 });
    return j.access_token;
  }
  graphToken() { return this.token(this.cfg.scopes || 'https://graph.microsoft.com/.default'); }
  ewsToken() { return this.token('https://outlook.office365.com/.default'); }
}

module.exports = { Auth };
