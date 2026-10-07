// Re-fetch every FTS item in one folder via EWS (pristine MIME) and replace the
// stored .fts.gz with a clean .eml.gz (same fileId, format='eml'). Fixes Graph
// exportItems page-break corruption in large attachments.
// Only works for folders in the MAIN archive partition (EWS can't see aux).
// Usage: node scripts/repair-folder-ews.js <upn> <folderPath> [scope=archive]
//   folderPath as stored, e.g. "Archive root/07 Projects - current/Example Project"
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { simpleParser } = require('mailparser');
const { Store } = require('../lib/store');
const { Auth } = require('../lib/auth');
const { safeName } = require('../lib/util');

const [upn, folderPath, scope = 'archive'] = process.argv.slice(2);
if (!upn || !folderPath) { console.error('usage: node scripts/repair-folder-ews.js <upn> <folderPath> [scope]'); process.exit(1); }

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
cfg.dataDir = path.resolve(__dirname, '..', cfg.dataDir || './data');
const store = new Store(cfg.dataDir);
const auth = new Auth(cfg);

const xmlEscape = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
async function ews(inner) {
  const tok = await auth.ewsToken();
  const body = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types" xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"><soap:Header><t:RequestServerVersion Version="Exchange2013_SP1"/><t:ExchangeImpersonation><t:ConnectingSID><t:PrimarySmtpAddress>${xmlEscape(upn)}</t:PrimarySmtpAddress></t:ConnectingSID></t:ExchangeImpersonation></soap:Header><soap:Body>${inner}</soap:Body></soap:Envelope>`;
  for (let i = 0; i < 8; i++) {
    const r = await fetch('https://outlook.office365.com/EWS/Exchange.asmx', {
      method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'text/xml; charset=utf-8', 'X-AnchorMailbox': upn }, body
    });
    if (r.status === 429 || r.status >= 500) {
      await new Promise(res => setTimeout(res, Math.min(60, 2 ** i * 3) * 1000 + Math.random() * 2000));
      continue;
    }
    const text = await r.text();
    if (!r.ok) throw new Error(`EWS HTTP ${r.status}: ${text.slice(0, 200)}`);
    return text;
  }
  throw new Error('EWS throttled persistently');
}

(async () => {
  const folder = store.db.prepare(`SELECT * FROM folders WHERE upn=? AND scope=? AND path=?`).get(upn, scope, folderPath);
  if (!folder) { console.error('folder not found in DB'); process.exit(1); }
  const items = store.db.prepare(`SELECT * FROM items WHERE upn=? AND scope=? AND folderId=? AND format='fts' AND fileId IS NOT NULL`).all(upn, scope, folder.folderId);
  console.log(`${items.length} FTS item(s) in ${folderPath}`);

  // Walk the EWS folder chain: archivemsgfolderroot + path segments after 'Archive root'.
  const segsPath = folderPath.split('/').filter(Boolean).slice(1);
  let parentXml = '<t:DistinguishedFolderId Id="archivemsgfolderroot"/>';
  let folderEwsId = null;
  for (const seg of segsPath) {
    const res = await ews(`<m:FindFolder Traversal="Shallow"><m:FolderShape><t:BaseShape>Default</t:BaseShape></m:FolderShape><m:ParentFolderIds>${parentXml}</m:ParentFolderIds></m:FindFolder>`);
    const subs = [...res.matchAll(/<t:Folder><t:FolderId Id="([^"]+)"[^>]*\/><t:DisplayName>([^<]+)/g)].map(m => ({ id: m[1], name: m[2] }));
    const hit = subs.find(f => f.name === seg);
    if (!hit) throw new Error(`EWS folder not found: ${seg} (aux partition folder? EWS cannot see those)`);
    folderEwsId = hit.id;
    parentXml = `<t:FolderId Id="${hit.id}"/>`;
  }
  console.log('EWS folder located');

  // Page through all EWS items in the folder.
  const ewsItems = [];
  for (let offset = 0; ; offset += 100) {
    const res = await ews(`<m:FindItem Traversal="Shallow"><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape></m:ItemShape><m:IndexedPageItemView MaxEntriesReturned="100" Offset="${offset}" BasePoint="Beginning"/><m:ParentFolderIds><t:FolderId Id="${folderEwsId}"/></m:ParentFolderIds></m:FindItem>`);
    const page = [...res.matchAll(/<t:ItemId Id="([^"]+)" ChangeKey="([^"]+)"/g)].map(m => ({ id: m[1], ck: m[2] }));
    ewsItems.push(...page);
    if (page.length < 100) break;
  }
  console.log(`${ewsItems.length} EWS item(s)`);

  const segs = String(folder.path || '').split('/').filter(Boolean).map(safeName);
  const dir = path.join(cfg.dataDir, 'store', safeName(upn), scope, ...segs);
  const upd = store.db.prepare(`UPDATE items SET subject=?, sender=?, receivedAt=?, size=?, sha256=?, format='eml', sourceApi='ews' WHERE upn=? AND scope=? AND folderId=? AND itemId=?`);
  const normSubj = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const key = (subj, date) => `${normSubj(subj)}|${date ? new Date(date).toISOString().slice(0, 16) : ''}`;
  const dbByKey = new Map(items.map(it => [key(it.subject, it.receivedAt), it]));

  let done = 0, failed = 0, unmatched = 0;
  for (const ei of ewsItems) {
    try {
      const res = await ews(`<m:GetItem><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape><t:IncludeMimeContent>true</t:IncludeMimeContent></m:ItemShape><m:ItemIds><t:ItemId Id="${ei.id}" ChangeKey="${ei.ck}"/></m:ItemIds></m:GetItem>`);
      const mm = res.match(/<t:MimeContent[^>]*>([^<]+)/);
      if (!mm) throw new Error(`no MimeContent: ${(res.match(/<m:MessageText>([^<]+)/) || [])[1] || '?'}`);
      const mime = Buffer.from(mm[1], 'base64');
      const p = await simpleParser(mime);
      const from = p.from && p.from.value && p.from.value[0];
      const sender = from ? (from.name ? `${from.name} <${from.address}>` : from.address) : null;
      const receivedAt = p.date ? p.date.toISOString() : null;
      let dbItem = dbByKey.get(key(p.subject, receivedAt));
      if (!dbItem) dbItem = items.find(it => Math.abs((it.size || 0) - mime.length) < 4096 && normSubj(it.subject) === normSubj(p.subject));
      if (!dbItem) { unmatched++; console.log(`  UNMATCHED: ${String(p.subject).slice(0, 60)} (${(mime.length / 1e6).toFixed(1)} MB)`); continue; }
      const eml = path.join(dir, dbItem.fileId + '.eml.gz');
      await fsp.writeFile(eml + '.tmp', zlib.gzipSync(mime));
      await fsp.rename(eml + '.tmp', eml);
      await fsp.rm(path.join(dir, dbItem.fileId + '.fts.gz'), { force: true });
      upd.run(p.subject || null, sender, receivedAt, mime.length, crypto.createHash('sha256').update(mime).digest('hex'), upn, scope, folder.folderId, dbItem.itemId);
      done++;
      console.log(`  [${done}] ${(mime.length / 1e6).toFixed(1)} MB ${String(p.subject || '').slice(0, 50)}`);
    } catch (e) {
      failed++;
      console.log(`  FAIL: ${String(e.message || e).slice(0, 150)}`);
    }
  }
  console.log(`repaired ${done}, unmatched ${unmatched}, failed ${failed}`);
})();
