// Read-only capability probe for the Graph Mailbox Import/Export APIs (archive path).
// NOTHING here modifies the source mailbox: only GETs and exportItems (a read-only
// export operation — the source item is never changed, moved or deleted).
//
// Usage: node scripts/probe-graphie.js <upn> [--export]
//   --export  also run one exportItems batch (max 20 ids) and inspect the FTS stream
//
// Reports, per step: OK / DENIED (grant missing) / REDIRECT (308 seen) / FAIL.
// Archive endpoints are BETA-only (GA v1.0 covers primary/shared only).
const path = require('path');
const fs = require('fs');
const { Auth } = require('../lib/auth');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const auth = new Auth(cfg);
const upn = process.argv[2];
const doExport = process.argv.includes('--export');
if (!upn) { console.error('usage: node scripts/probe-graphie.js <upn> [--export]'); process.exit(1); }

const results = [];
function report(step, status, detail) {
  results.push({ step, status, detail });
  console.log(`[${status}] ${step}${detail ? ' — ' + detail : ''}`);
}

// Redirect policy: only follow Location URLs on graph.microsoft.com over HTTPS,
// matching the /admin/exchange/mailboxes path, max 5 hops.
function checkRedirect(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.host === 'graph.microsoft.com'
      && /^\/(beta|v1\.0)\/admin\/exchange\/mailboxes\//i.test(u.pathname);
  } catch { return false; }
}

async function req(url, opts = {}, hops = 0) {
  const tok = await auth.graphToken();
  const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${tok}` }, redirect: 'manual' });
  if (r.status === 308) {
    const loc = r.headers.get('location');
    if (!loc || !checkRedirect(loc)) return { redirect: loc, blocked: true };
    if (hops >= 5) return { redirectLoop: true };
    return req(loc, opts, hops + 1);
  }
  return r;
}

(async () => {
  // Step A: mailbox IDs (v1.0 settings; archive id is a beta property).
  let ids = {};
  try {
    const r = await req(`https://graph.microsoft.com/beta/users/${encodeURIComponent(upn)}/settings/exchange`);
    if (r.status === 403) report('exchangeSettings', 'DENIED', 'needs User.Read.All (app)');
    else if (!r.ok) report('exchangeSettings', 'FAIL', `HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    else {
      const j = await r.json();
      const es = (j.value && j.value[0]) || j; // single-entity response, not a collection
      ids = { primary: es.primaryMailboxId, archive: es.inPlaceArchiveMailboxId };
      report('exchangeSettings', 'OK', `primary=${ids.primary || 'none'} archive=${ids.archive || 'NOT PRESENT (beta property — may need archive on this mailbox)'}`);
    }
  } catch (e) { report('exchangeSettings', 'FAIL', e.message); }
  if (!ids.archive) {
    report('archive probe', 'SKIP', 'no inPlaceArchiveMailboxId — cannot probe archive without it');
    finish(); return;
  }

  // Step B: archive folder delta (first page only).
  let firstFolder = null;
  try {
    const r = await req(`https://graph.microsoft.com/beta/admin/exchange/mailboxes/${encodeURIComponent(ids.archive)}/folders/delta`);
    if (r.redirect) report('archive folders/delta', r.blocked ? 'FAIL' : 'REDIRECT', `308 → ${r.blocked ? 'BLOCKED untrusted: ' : ''}${r.redirect}`);
    else if (r.status === 403) report('archive folders/delta', 'DENIED', 'needs MailboxFolder.Read.All (app) — run scripts/grant-mailboxie.ps1');
    else if (!r.ok) report('archive folders/delta', 'FAIL', `HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    else {
      const j = await r.json();
      const folders = j.value || [];
      firstFolder = folders.find(f => (f.totalItemCount || 0) > 0) || folders[0];
      report('archive folders/delta', 'OK', `${folders.length} folder(s) on first page, nextLink=${!!j['@odata.nextLink']}, deltaLink=${!!j['@odata.deltaLink']}`);
    }
  } catch (e) { report('archive folders/delta', 'FAIL', e.message); }

  // Step C: item enumeration in one folder.
  let itemIds = [];
  if (firstFolder) {
    try {
      const r = await req(`https://graph.microsoft.com/beta/admin/exchange/mailboxes/${encodeURIComponent(ids.archive)}/folders/${encodeURIComponent(firstFolder.id)}/items/delta`);
      if (r.redirect) report('folder items/delta', r.blocked ? 'FAIL' : 'REDIRECT', `308 → ${r.blocked ? 'BLOCKED untrusted: ' : ''}${r.redirect}`);
      else if (r.status === 403) report('folder items/delta', 'DENIED', 'needs MailboxItem.Read.All (app)');
      else if (!r.ok) report('folder items/delta', 'FAIL', `HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
      else {
        const j = await r.json();
        itemIds = (j.value || []).map(i => i.id).filter(Boolean);
        report('folder items/delta', 'OK', `folder "${firstFolder.displayName}" → ${itemIds.length} item id(s), nextLink=${!!j['@odata.nextLink']}`);
      }
    } catch (e) { report('folder items/delta', 'FAIL', e.message); }
  }

  // Step D: one exportItems batch (read-only export; inspects the FTS stream shape).
  if (doExport && itemIds.length) {
    try {
      const r = await req(`https://graph.microsoft.com/beta/admin/exchange/mailboxes/${encodeURIComponent(ids.archive)}/exportItems`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemIds: itemIds.slice(0, 20) })
      });
      if (r.redirect) report('exportItems', 'REDIRECT', `308 → ${r.redirect}`);
      else if (r.status === 403) report('exportItems', 'DENIED', 'needs MailboxItem.Export.All (app)');
      else if (!r.ok) report('exportItems', 'FAIL', `HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
      else {
        const j = await r.json();
        const responses = j.value || [];
        const okItems = responses.filter(x => x.data);
        const redirects = responses.filter(x => x.error && /ErrorArchiveFolderMovedPermanently/.test(x.error.code || ''));
        const first = okItems[0];
        let magic = '';
        if (first) magic = Buffer.from(first.data.slice(0, 64), 'base64').toString('hex');
        report('exportItems', 'OK', `${okItems.length}/${responses.length} exported, ${redirects.length} aux-redirect(s), first data bytes (hex): ${magic}`);
        if (redirects.length) report('exportItems aux routing', 'REDIRECT', redirects[0].error.message.slice(0, 200));
      }
    } catch (e) { report('exportItems', 'FAIL', e.message); }
  } else if (!doExport) {
    report('exportItems', 'SKIP', 'pass --export to test one batch');
  }

  finish();
})().catch(e => { report('fatal', 'FAIL', e.message); finish(); });

function finish() {
  const denied = results.filter(r => r.status === 'DENIED').map(r => r.step);
  console.log('\n=== SUMMARY ===');
  console.log(denied.length ? `missing grants for: ${denied.join(', ')} — run scripts/grant-mailboxie.ps1` : 'no missing grants detected');
  const failed = results.filter(r => r.status === 'FAIL');
  if (failed.length) console.log('failures:', failed.map(f => `${f.step}: ${f.detail}`).join(' | '));
}
