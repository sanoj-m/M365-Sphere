// Read back stored .eml.gz items and parse them for the preview UI.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const { simpleParser } = require('mailparser');
const { safeName } = require('./util');

const gunzipAsync = promisify(zlib.gunzip);

// Rebuild a folder's full path ('Inbox/Acronis') by walking the parentId chain.
// Needed because some DB rows predate path persistence (path is '').
function chainPath(folderMap, folder) {
  const parts = [];
  let cur = folder;
  let guard = 0;
  while (cur && guard++ < 50) {
    if (cur.name) parts.unshift(cur.name);
    cur = cur.parentId ? folderMap.get(cur.parentId) : null;
  }
  return parts.join('/');
}

// Items are written under storeRoot/<safeName(upn)>/<scope>/<safeName(path segments)>/.
function itemFile(storeRoot, upn, scope, folder, fileId, folderMap) {
  const segs = p => String(p || '').split('/').filter(Boolean).map(safeName);
  const candidates = [];
  if (folderMap && folder) candidates.push(segs(chainPath(folderMap, folder)));
  if (folder && folder.path) candidates.push(segs(folder.path));
  if (folder && folder.name) candidates.push(segs(folder.name));
  candidates.push([]);
  const seen = new Set();
  for (const c of candidates) {
    const key = c.join('/');
    if (seen.has(key)) continue;
    seen.add(key);
    const f = path.join(storeRoot, safeName(upn), scope, ...c, fileId + '.eml.gz');
    if (fs.existsSync(f)) return f;
    const fts = path.join(storeRoot, safeName(upn), scope, ...c, fileId + '.fts.gz');
    if (fs.existsSync(fts)) return fts;
  }
  return null;
}

async function readRaw(storeRoot, upn, scope, folder, fileId, folderMap) {
  const f = itemFile(storeRoot, upn, scope, folder, fileId, folderMap);
  if (!f) return null;
  return gunzipAsync(await fsp.readFile(f));
}

async function parseStoredItem(storeRoot, upn, scope, folder, fileId, folderMap) {
  const raw = await readRaw(storeRoot, upn, scope, folder, fileId, folderMap);
  if (!raw) return null;
  return simpleParser(raw);
}

const addrList = a => {
  if (!a) return '';
  const arr = Array.isArray(a.value) ? a.value : [a.value];
  return arr.filter(Boolean).map(x => x.name ? `${x.name} <${x.address}>` : x.address).join(', ');
};

function toPreview(parsed) {
  let body = parsed.html || (parsed.text ? parsed.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>') : '');
  // Inline images: replace cid: refs with data URIs (cap 3 MB per image).
  // Match by content-id, then by filename contained in the cid.
  if (body && parsed.html && (parsed.attachments || []).length) {
    const used = new Set();
    body = body.replace(/cid:([^"'\s>]+)/g, (m, cid) => {
      let a = parsed.attachments.find(x => x.cid && (x.cid === cid || cid.includes(x.cid)))
        || parsed.attachments.find(x => x.filename && cid.toLowerCase().includes(x.filename.toLowerCase()))
        || parsed.attachments.find((x, i) => !used.has(i) && (x.contentType || '').startsWith('image/'));
      if (!a) return m;
      const i = parsed.attachments.indexOf(a);
      used.add(i);
      if (!(a.contentType || '').startsWith('image/') || !a.content || a.content.length > 3 * 1024 * 1024) return m;
      return `data:${a.contentType};base64,${a.content.toString('base64')}`;
    });
  }
  return {
    subject: parsed.subject || '(no subject)',
    from: addrList(parsed.from),
    to: addrList(parsed.to),
    cc: addrList(parsed.cc),
    date: parsed.date ? parsed.date.toISOString() : null,
    html: body,
    attachments: (parsed.attachments || []).map((a, i) => ({
      index: i,
      filename: a.filename || `attachment-${i + 1}`,
      size: a.size || (a.content ? a.content.length : 0),
      contentType: a.contentType || 'application/octet-stream'
    }))
  };
}

module.exports = { parseStoredItem, toPreview, readRaw, chainPath, itemFile };
