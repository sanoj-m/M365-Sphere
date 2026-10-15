// Probe: reconstruct MIME from a real .fts.gz item and upload it to a live
// 'CopyTest' folder via the copy-email live path primitives, verify, clean up.
const fs = require('fs');
const path = require('path');
const cfg = require('../config.json');
cfg.dataDir = path.join(__dirname, '..', 'data');
const D = require('better-sqlite3');
const { readRaw } = require('../lib/preview');
const { ftsMime, ftsPreview } = require('../lib/fts');
const { parseMimeHeaders } = require('../lib/engine');
const auth = require('../lib/auth');
const { GraphClient } = require('../lib/graph');
const { EwsClient } = require('../lib/ews');

(async () => {
  const db = new D(path.join(cfg.dataDir, 'state.db'), { readonly: true });
  const upn = process.env.UPN || 'user1@example.com';
  const it = db.prepare(`SELECT itemId, folderId, scope, subject, size, fileId, receivedAt FROM items
    WHERE upn=? AND format='fts' AND status='done' AND fileId NOT NULL AND size BETWEEN 500000 AND 15000000
    ORDER BY size DESC LIMIT 1`).get(upn);
  if (!it) throw new Error('no probe item found');
  console.log('probe item:', it.subject, '|', it.size, 'bytes |', it.receivedAt);
  const folder = db.prepare('SELECT * FROM folders WHERE upn=? AND scope=? AND folderId=?').get(upn, it.scope, it.folderId);
  const folders = db.prepare('SELECT * FROM folders WHERE upn=?').all(upn);
  const folderMap = new Map(folders.map(f => [f.folderId, f]));

  const raw = await readRaw(cfg.dataDir + '/store', upn, it.scope, folder, it.fileId, folderMap);
  console.log('raw fts bytes:', raw.length);
  const mime = ftsMime(raw);
  if (!mime) throw new Error('fts stream not reconstructable');
  console.log('mime bytes:', mime.length);
  fs.writeFileSync(path.join(cfg.dataDir, 'fts-probe.eml'), mime);

  const hdr = parseMimeHeaders(mime);
  console.log('hdr.subject:', hdr.subject);
  console.log('hdr.receivedAt:', hdr.receivedAt, '| hdr.messageId:', hdr.messageId);
  console.log('db.subject  :', it.subject);
  const { attachments } = ftsPreview(raw);
  console.log('attachments in preview scan:', attachments.length);

  // Live upload probe target (set DST_UPN)
  const dstUpn = process.env.DST_UPN || 'user2@example.com';
  const tokens = new auth.Auth(cfg);
  const graph = new GraphClient(tokens, (...a) => console.log('[graph]', ...a), cfg);
  const ews = new EwsClient(tokens, (...a) => console.log('[ews]', ...a), cfg);
  const ensured = await graph.ensureChildFolderEx(dstUpn, 'msgfolderroot', 'CopyTest', null);
  console.log('CopyTest rest id:', ensured.id);
  const conv = await ews.convertRestIds(dstUpn, [ensured.id], graph, null);
  const ewsFolderId = conv.get(ensured.id);
  console.log('ews folder id ok:', !!ewsFolderId);
  const receivedAt = hdr.receivedAt || it.receivedAt;
  const ewsId = await ews.uploadMessage(dstUpn, ewsFolderId, mime, receivedAt, null);
  console.log('uploaded ews id:', !!ewsId);

  const msgs = await graph.getJson(`/users/${dstUpn}/mailFolders/${ensured.id}/messages?$select=isDraft,receivedDateTime,subject,hasAttachments&$top=5`);
  console.log('readback:', JSON.stringify(msgs.value, null, 1));
  await graph.deleteFolder(dstUpn, ensured.id, null);
  console.log('CopyTest deleted — cleanup done');
})().catch(e => { console.error('PROBE FAILED:', e); process.exit(1); });
