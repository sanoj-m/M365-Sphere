// Ingests EXO eDiscovery PST exports into the local backup store so the
// exported mail is browsable/verifiable exactly like the EWS/Graph backup:
// data/store/<upn>/<scope>/<folder path>/<fileId>.eml.gz + items rows.
// Parser: pst-extractor (pure JS). When a message carries its original
// RFC822 headers (PR_TRANSPORT_MESSAGE_HEADERS, present on messages exported
// via compliance search) the .eml is faithful; otherwise headers+body are
// best-effort reconstructed from MAPI properties. The PST stays authoritative.
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const { PSTFile, PSTMessage } = require('pst-extractor');
const { safeName } = require('./util');

const gzipAsync = promisify(zlib.gzip);
const sha1 = s => crypto.createHash('sha1').update(String(s)).digest('hex');
const ARCHIVE_RE = /archive|online archive/i;
const enc2047 = s => !s ? '' : (/[^\x20-\x7e]/.test(s) ? `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=` : s);
const CRLF = s => String(s).replace(/\r?\n/g, '\r\n');

// Extract just the header block of raw transport headers and drop any
// Content-* / MIME-Version lines (rebuilt when we assemble a multipart body).
function transportHeaders(msg) {
  let h = '';
  try { h = msg.transportMessageHeaders || ''; } catch { h = ''; }
  const m = h.match(/([\s\S]*?)\r?\n\r?\n/);
  if (m) h = m[1];
  h = h.replace(/^(content-type|content-transfer-encoding|mime-version)\s*:[^\n]*(?:\n[ \t][^\n]*)*\r?\n?/gim, '');
  return h.trim();
}

function bodyOf(msg) {
  let html = '';
  try { html = msg.bodyHTML || ''; } catch { html = ''; }
  if (html) return { type: 'text/html; charset="utf-8"', data: Buffer.from(CRLF(html), 'utf8') };
  let text = '';
  try { text = msg.body || ''; } catch { text = ''; }
  return { type: 'text/plain; charset="utf-8"', data: Buffer.from(CRLF(text), 'utf8') };
}

// Read file attachments (attachMethod 1 = by value, 4 = by reference w/ data).
// Embedded messages (5) and OLE objects (6) are skipped — noted in the report.
function attachmentsOf(msg) {
  const out = [];
  let n = 0;
  try { n = msg.numberOfAttachments || 0; } catch { n = 0; }
  for (let i = 0; i < n; i++) {
    try {
      const att = msg.getAttachment(i);
      if (!att || att.attachMethod === 5 || att.attachMethod === 6) continue;
      const stream = att.fileInputStream;
      if (!stream) continue;
      out.push({
        filename: att.longFilename || att.filename || att.pathname || `attachment-${i + 1}`,
        mime: att.mimeTag || 'application/octet-stream',
        contentId: att.contentId ? String(att.contentId).replace(/[<>]/g, '') : null,
        b64: readStreamB64(stream)
      });
    } catch { /* unreadable attachment — body still ingested */ }
  }
  return out;
}

const b64lines = buf => buf.toString('base64').replace(/.{1,76}/g, '$&\r\n').trim();

// Read a PSTNodeInputStream in 3-aligned chunks (base64-safe) so a huge attachment
// never materializes as one Buffer. Returns an array of base64-line strings.
const CHUNK = 6 * 1024 * 1024; // divisible by 3
function readStreamB64(stream) {
  const total = Number(stream.length);
  const parts = [];
  const buf = Buffer.alloc(Math.min(CHUNK, total));
  let off = 0;
  while (off < total) {
    const want = Math.min(CHUNK, total - off);
    const n = stream.readFromOffset(buf, off, want);
    if (n <= 0) break;
    parts.push(b64lines(n === buf.length ? buf : buf.subarray(0, n)));
    off += n;
  }
  return parts;
}

function buildEml(msg) {
  const atts = attachmentsOf(msg);
  const body = bodyOf(msg);
  const raw = transportHeaders(msg);
  const hasTransport = /^[^\s:]+:/m.test(raw);
  let head = hasTransport ? raw : '';
  if (!hasTransport) {
    const from = msg.senderEmailAddress && msg.senderEmailAddress.includes('@')
      ? (msg.senderName ? `${enc2047(msg.senderName)} <${msg.senderEmailAddress}>` : msg.senderEmailAddress)
      : enc2047(msg.senderName || msg.senderEmailAddress || '');
    const lines = [
      from ? `From: ${from}` : null,
      msg.displayTo ? `To: ${enc2047(msg.displayTo)}` : null,
      msg.displayCC ? `Cc: ${enc2047(msg.displayCC)}` : null,
      `Subject: ${enc2047(msg.subject || '(no subject)')}`,
      msg.messageDeliveryTime ? `Date: ${msg.messageDeliveryTime.toUTCString()}` : null,
      msg.internetMessageId ? `Message-ID: ${msg.internetMessageId}` : null
    ].filter(Boolean);
    head = lines.join('\r\n');
  }
  if (!/^date:/im.test(head) && msg.messageDeliveryTime) head += `\r\nDate: ${msg.messageDeliveryTime.toUTCString()}`;
  if (!/^message-id:/im.test(head) && msg.internetMessageId) head += `\r\nMessage-ID: ${msg.internetMessageId}`;

  let payload;
  if (atts.length) {
    const b = `----=_M365PstIngest_${crypto.randomBytes(12).toString('hex')}`;
    const parts = [Buffer.from(`--${b}\r\nContent-Type: ${body.type}\r\nContent-Transfer-Encoding: 8bit\r\n\r\n`), body.data];
    for (const a of atts) {
      parts.push(Buffer.from(
        `\r\n--${b}\r\nContent-Type: ${a.mime}\r\nContent-Transfer-Encoding: base64\r\n` +
        `Content-Disposition: attachment; filename="${String(a.filename).replace(/["\r\n]/g, '_')}"\r\n` +
        (a.contentId ? `Content-ID: <${a.contentId}>\r\n` : '') + `\r\n`));
      for (const p of a.b64) parts.push(Buffer.from(p + '\r\n'));
    }
    parts.push(Buffer.from(`\r\n--${b}--\r\n`));
    head += `\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="${b}"`;
    payload = Buffer.concat([Buffer.from(CRLF(head) + '\r\n\r\n'), ...parts]);
  } else {
    const transfer = /^content-type:\s*text\/html/im.test(head) ? '8bit' : '8bit';
    if (!/^content-type:/im.test(head)) head += `\r\nMIME-Version: 1.0\r\nContent-Type: ${body.type}`;
    if (!/^content-transfer-encoding:/im.test(head)) head += `\r\nContent-Transfer-Encoding: ${transfer}`;
    payload = Buffer.concat([Buffer.from(CRLF(head) + '\r\n\r\n'), body.data]);
  }
  return payload;
}

class PstIngest {
  constructor({ cfg, store, log, bus }) {
    this.cfg = cfg; this.store = store; this.log = log; this.bus = bus;
    this.storeRoot = path.join(cfg.dataDir, 'store');
    this._emitAt = 0;
  }

  folderDir(upn, scope, folderPath) {
    return path.join(this.storeRoot, safeName(upn), scope, ...String(folderPath).split('/').map(safeName));
  }

  _emit() {
    const now = Date.now();
    if (now - this._emitAt < 500) return;
    this._emitAt = now;
    this.bus.emit('progress', { exoExport: true });
  }

  // Walk one PST folder tree and ingest every message. Folder ids are derived
  // from the folder path so re-ingested overlapping chunks converge on the
  // same rows; item ids are 'exo-'-prefixed and never collide with EWS/Graph.
  async ingestPst({ upn, pstPath }) {
    const pst = new PSTFile(pstPath);
    try {
      return await this._ingestPstInner(upn, pst, pstPath);
    } finally {
      try { pst.close(); } catch { }
    }
  }

  async _ingestPstInner(upn, pst, pstPath) {
    let items = 0, bytes = 0, failed = 0;
    const walk = async (folder, parentPath, parentId, scopeHint) => {
      let name = '';
      try { name = folder.displayName || ''; } catch { name = ''; }
      const fullPath = parentPath ? `${parentPath}/${name}` : name;
      const isArchive = scopeHint === 'archive' || (fullPath && fullPath.split('/').some(s => ARCHIVE_RE.test(s)));
      const scope = isArchive ? 'archive' : 'primary';
      const folderId = 'exo' + sha1(`exo${upn}${scope}${fullPath}`);
      const dir = this.folderDir(upn, scope, fullPath);
      fs.mkdirSync(dir, { recursive: true });
      let emailCount = 0;
      try { emailCount = folder.emailCount || 0; } catch { emailCount = 0; }
      this.store.upsertFolder({
        upn, scope, folderId, parentId, name: name || '(root)', path: fullPath,
        itemCount: emailCount, deltaToken: null, syncState: null
      });

      for (let i = 0; i < emailCount; i++) {
        let child;
        try { child = folder.getNextChild(); } catch (e) {
          this.log('warn', upn, `EXO ingest: error reading message ${i + 1}/${emailCount} of "${fullPath}": ${String(e.message || e).slice(0, 200)}`);
          failed++;
          continue;
        }
        if (!child) break;
        if (!(child instanceof PSTMessage)) continue;
        let eml = null, err = null;
        try {
          eml = buildEml(child);
        } catch (e) { err = e; }
        const subject = (() => { try { return child.subject || null; } catch { return null; } })();
        const receivedAt = (() => { try { return child.messageDeliveryTime ? child.messageDeliveryTime.toISOString() : null; } catch { return null; } })();
        const size0 = (() => { try { return Number(child.messageSize || 0); } catch { return 0; } })();
        let mid = null;
        try { mid = child.internetMessageId || null; } catch { mid = null; }
        const key = mid || `${folderId}|${subject || ''}|${receivedAt || ''}|${size0}`;
        const itemId = 'exo-' + sha1(key);
        const fileId = sha1(key);
        if (err) {
          this.store.upsertItem({
            upn, scope, folderId, itemId, fileId: null, subject, receivedAt, size: 0,
            status: 'failed', lastError: `ingest: ${String(err.message || err).slice(0, 400)}`, attempts: 1, sha256: null
          });
          failed++;
          continue;
        }
        // Cheap idempotency: identical content already stored → skip the write.
        const existing = this.store.getItem(upn, scope, folderId, itemId);
        const sha256 = crypto.createHash('sha256').update(eml).digest('hex');
        if (!(existing && existing.status === 'done' && existing.sha256 === sha256 && fs.existsSync(path.join(dir, fileId + '.eml.gz')))) {
          const gz = await gzipAsync(eml);
          const tmp = path.join(dir, fileId + '.tmp');
          await fsp.writeFile(tmp, gz);
          await fsp.rename(tmp, path.join(dir, fileId + '.eml.gz')); // atomic publish
          this.store.upsertItem({
            upn, scope, folderId, itemId, fileId, subject, receivedAt,
            size: eml.length, status: 'done', lastError: null, attempts: 1, sha256
          });
          bytes += eml.length;
        }
        items++;
        if (items % 200 === 0) {
          this.log('info', upn, `EXO ingest ${upn}: ${items} items, ${Math.round(bytes / 1024 ** 2)} MB`);
          this._emit();
        }
      }

      let subs = [];
      try { subs = folder.getSubFolders(); } catch { subs = []; }
      for (const sub of subs) {
        await walk(sub, fullPath, folderId, scope);
      }
    };
    await walk(pst.getRootFolder(), '', null, null);
    this.store.recomputeMailboxBytes(upn);
    this._emit();
    this.log('info', upn, `EXO ingest ${upn}: done — ${items} items, ${Math.round(bytes / 1024 ** 2)} MB${failed ? `, ${failed} failed` : ''}`);
    return { items, bytes, failed };
  }
}

module.exports = { PstIngest, buildEml, transportHeaders };
