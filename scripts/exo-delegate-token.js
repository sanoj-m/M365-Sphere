// One-time: acquire a DELEGATED refresh token for the compliance search-init
// audience via the OAuth 2.0 device code flow (admin signs in once, pastes a code).
// Saved to data/exo-refresh-token.json; the app uses it silently from then on.
//
// Uses Microsoft's first-party Exchange PowerShell client id (public client) —
// the same client Connect-IPPPSession itself uses interactively — because the
// tenant's app registration cannot authorize the dataservice.o365filtering.com
// resource for delegated flows (AADSTS650057 otherwise).
const fs = require('fs');
const path = require('path');
const cfg = require('../config.json');

const TENANT = cfg.tenantId;
const CLIENT_ID = 'fb78d390-0c51-40cd-8e17-fdbfab77341b'; // "Microsoft Exchange REST API Based Powershell" (public, first-party)
const SCOPES = process.argv[2] || 'https://dataservice.o365filtering.com/.default offline_access';
const OUT = path.resolve(process.argv[3] || path.join(__dirname, '..', 'data', 'exo-refresh-token.json'));

async function post(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body)
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

(async () => {
  const d = await post(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/devicecode`, {
    client_id: CLIENT_ID, scope: SCOPES
  });
  if (d.status !== 200) {
    console.error('device code request failed:', d.status, JSON.stringify(d.json).slice(0, 400));
    process.exit(1);
  }
  console.log('\n============================================================');
  console.log('  OPEN:  ' + d.json.verification_uri);
  console.log('  CODE:  ' + d.json.user_code);
  console.log('  Sign in with an EXCHANGE/COMPLIANCE ADMIN account.');
  console.log('============================================================\n');
  const expires = Date.now() + (d.json.expires_in || 900) * 1000;
  while (Date.now() < expires) {
    await new Promise(r => setTimeout(r, (d.json.interval || 5) * 1000));
    const t = await post(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: CLIENT_ID,
      device_code: d.json.device_code
    });
    if (t.status === 200) {
      fs.writeFileSync(OUT, JSON.stringify({
        refreshToken: t.json.refresh_token,
        scope: SCOPES,
        acquiredAt: new Date().toISOString(),
        account: t.json.id_token ? JSON.parse(Buffer.from(t.json.id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()).preferred_username : null
      }, null, 2));
      console.log('SAVED refresh token for', JSON.parse(fs.readFileSync(OUT)).account, '→', OUT);
      return;
    }
    const err = t.json.error;
    if (err === 'authorization_pending') continue;
    if (err === 'authorization_declined') { console.error('declined'); process.exit(1); }
    if (err === 'expired_token') { console.error('code expired — re-run'); process.exit(1); }
    console.error('token error:', err, t.json.error_description || '');
    process.exit(1);
  }
  console.error('timed out');
  process.exit(1);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
