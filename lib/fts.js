// Best-effort FTS (MS-OXCFXIDC FastTransfer stream) PREVIEW extractor.
// Microsoft documents these export streams as opaque/never-to-be-parsed — this
// heuristic scanner exists ONLY to render UI previews. The .fts.gz file remains
// the untouched restore-grade source of truth; nothing here feeds back into
// storage or verification.
//
// String property:  marker B0 84 + propId (2B LE) + byteLength (4B LE) + UTF-16LE.
// Binary property:  marker 01 02 01 + propId (2B LE) + byteLength (4B LE) + bytes.
// (attachment payload = propId 0x3701 PR_ATTACH_DATA_BIN)
const zlib = require('zlib');

const STR_MARK = Buffer.from([0xB0, 0x84]);
const BIN_MARK = Buffer.from([0x01, 0x02, 0x01]);
// Attachment payload marker INCLUDING the propId (0x3701) — the 3-byte marker
// alone is too common and makes the scan quadratic on multi-MB streams,
// freezing the server event loop during preview.
const ATT_MARK = Buffer.from([0x01, 0x02, 0x01, 0x01, 0x37]);
const IDS = {
  0x007D: 'transportHeaders',
  0x0037: 'subject',
  0x0E1D: 'subjectNorm',
  0x0C1A: 'senderName',
  0x0C1F: 'senderEmail',
  0x0E04: 'displayTo',
  0x0E03: 'displayCc',
  0x0071: 'conversationTopic',
  0x1000: 'bodyText',
  0x3707: '_attachName',   // PR_ATTACH_LONG_FILENAME
  0x3704: '_attachName8',  // PR_ATTACH_FILENAME (short)
  0x3712: '_attachCid',    // PR_ATTACH_CONTENT_ID
  0x3714: '_attachFlags'   // PR_ATTACH_FLAGS (inline hint)
};

// Odd-length UTF-16LE slices hard-crash Node's decoder (heap corruption,
// observed on Node 24 with false-positive markers) — trim the dangling byte.
const u16 = b => (b.length % 2 ? b.slice(0, -1) : b).toString('utf16le');

function printableEnough(text) {
  if (!text) return false;
  const printable = (text.match(/[\x20-\x7E\r\n\t -￿]/g) || []).length;
  return printable / text.length > 0.85;
}

// Scan both property encodings; returns { props: {name: text}, attachments: [...] }
// seamAt: when buf is a head+tail concat (metaOnly on large streams), a string
// whose bytes would span the seam is a fabricated marker — clamp it to the head.
function scan(buf, seamAt = Infinity) {
  const props = {};
  const strings = []; // ordered (id, text, offset) — for attachment pairing
  let i = buf.indexOf(STR_MARK);
  while (i !== -1) {
    const id = buf.readUInt16LE(i + 2);
    const len = buf.readUInt32LE(i + 4);
    const inBounds = len > 0 && len < 10_000_000 && i + 8 + len <= buf.length && !(i < seamAt && i + 8 + len > seamAt);
    if (inBounds) {
      const text = u16(buf.slice(i + 8, i + 8 + len)).replace(/\0+$/, '');
      if (printableEnough(text)) {
        if (IDS[id] && !IDS[id].startsWith('_attach') && !props[IDS[id]]) props[IDS[id]] = text;
        if (id === 0x3707 || id === 0x3704 || id === 0x3712) strings.push({ id, text, off: i });
      }
      i = buf.indexOf(STR_MARK, i + 8 + len);
    } else {
      i = buf.indexOf(STR_MARK, i + 2);
    }
  }
  // Binary payloads (attachments) — searched with marker + propId combined.
  const binaries = [];
  i = buf.indexOf(ATT_MARK);
  while (i !== -1) {
    const len = buf.readUInt32LE(i + 5);
    if (len > 0 && len < 200_000_000 && i + 9 + len <= buf.length) {
      binaries.push({ off: i, len, data: buf.slice(i + 9, i + 9 + len) });
      i = buf.indexOf(ATT_MARK, i + 9 + len);
    } else {
      i = buf.indexOf(ATT_MARK, i + 5);
    }
  }
  // Attachment names: targeted scan in the small window right AFTER each
  // payload — a global sequential scan overshoots these when a huge property
  // (HTML body, RTF) sits between attachments.
  const namesIn = (start, end) => {
    const out = {};
    let j = buf.indexOf(STR_MARK, start);
    while (j !== -1 && j < end) {
      const id = buf.readUInt16LE(j + 2);
      const len = buf.readUInt32LE(j + 4);
      if (len > 0 && len < 100000 && j + 8 + len <= buf.length) {
        const text = u16(buf.slice(j + 8, j + 8 + len)).replace(/\0+$/, '');
        if (printableEnough(text) && !out[id]) out[id] = text;
        j = buf.indexOf(STR_MARK, j + 8 + len);
      } else {
        j = buf.indexOf(STR_MARK, j + 2);
      }
    }
    return out;
  };
  const attachments = binaries.map((b, n) => {
    const names = namesIn(b.off + 9 + b.len - 8, b.off + 9 + b.len + 8192);
    const filename = names[0x3707] || names[0x3704] || `attachment-${n + 1}`;
    return { index: n, filename, contentId: names[0x3712] ? names[0x3712].replace(/[<>]/g, '') : (names[0x3707] || null), size: b.len, data: b.data };
  });
  return { props, attachments };
}

function mimeFromMagic(b) {
  if (!b || b.length < 4) return 'application/octet-stream';
  if (b[0] === 0xFF && b[1] === 0xD8) return 'image/jpeg';
  if (b.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47]))) return 'image/png';
  if (b.slice(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  if (b.slice(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  if (b[0] === 0x50 && b[1] === 0x4B) return 'application/zip';
  return 'application/octet-stream';
}

// HTML body: binary property or inline text — find the first plausible HTML run.
function findHtml(buf) {
  const s = buf.toString('latin1');
  for (const probe of ['<!DOCTYPE html', '<html', '<HTML']) {
    const i = s.indexOf(probe);
    if (i === -1) continue;
    const end = s.indexOf('</html>', i);
    const slice = s.slice(i, end !== -1 ? end + 7 : Math.min(s.length, i + 800000));
    if (slice.length > 40) return slice;
  }
  return null;
}

function parseHeaders(raw) {
  const out = {};
  if (!raw) return out;
  const m = raw.match(/^(From|To|Cc|Subject|Date|Message-ID|Bcc):[ \t]*(.*)$/gim);
  if (!m) return out;
  for (const line of m) {
    const j = line.indexOf(':');
    const k = line.slice(0, j).toLowerCase();
    if (!out[k]) out[k] = line.slice(j + 1).trim();
  }
  return out;
}

const clean = s => s && !/[　-￿]{2}/.test(s) && s.length < 400 ? s : '';

// buf: raw (gunzipped) FTS bytes → preview object compatible with the UI.
// attachments carry their bytes (used by the download endpoint + cid: embedding).
// opts.metaOnly: only header/identity strings (fast — skips the binary/html
// scan; used for list metadata at export time and bulk backfills).
function ftsPreview(buf, opts = {}) {
  // metaOnly on large streams: scan head + tail. Message properties can sit
  // AFTER attachment payloads (e.g. transportHeaders/senderName past a 20 MB
  // PDF), so a head-only window loses sender/subject for big messages.
  const CAP = 4 * 1024 * 1024;
  const metaScan = opts.metaOnly && buf.length > CAP * 2
    ? Buffer.concat([buf.slice(0, CAP), buf.slice(-CAP)])
    : buf;
  const { props, attachments } = opts.metaOnly
    ? { props: scan(metaScan, metaScan === buf ? Infinity : CAP).props, attachments: [] }
    : scan(buf);
  const hdr = parseHeaders(props.transportHeaders);
  let html = opts.metaOnly ? null : findHtml(buf);
  // Inline images: replace cid: refs with data URIs (cap 3 MB per image).
  // Match order: exact content-id → filename contained in the cid → next
  // unused image attachment in document order (Outlook cid styles vary).
  const imgs = attachments.filter(a => a.size <= 3 * 1024 * 1024 && mimeFromMagic(a.data).startsWith('image/'));
  const used = new Set();
  if (html && imgs.length) {
    html = html.replace(/cid:([^"'\s>]+)/g, (m, cid) => {
      let a = imgs.find(x => x.contentId && (x.contentId === cid || cid.includes(x.contentId)))
        || imgs.find(x => x.filename && cid.toLowerCase().includes(x.filename.toLowerCase()))
        || imgs.find(x => !used.has(x.index));
      if (!a) return m;
      used.add(a.index);
      return `data:${mimeFromMagic(a.data)};base64,${a.data.toString('base64')}`;
    });
  }
  // Normalize the date to ISO for the UI's timestamp rendering.
  let isoDate = '';
  if (hdr.date) { const d = new Date(hdr.date); if (!isNaN(d)) isoDate = d.toISOString(); }
  return {
    subject: hdr.subject || clean(props.subject) || clean(props.subjectNorm) || '(no subject)',
    from: hdr.from || clean(props.senderName) || '',
    to: hdr.to || clean(props.displayTo) || '',
    cc: hdr.cc || clean(props.displayCc) || '',
    date: isoDate || hdr.date || '',
    html: html || (props.bodyText ? `<pre style="white-space:pre-wrap">${String(props.bodyText).replace(/</g, '&lt;')}</pre>` : ''),
    attachments: attachments.map(a => ({ index: a.index, filename: a.filename, size: a.size, contentType: mimeFromMagic(a.data) })),
    ftsParsed: true
  };
}

// One attachment's bytes by index (for the download endpoint). Streams the same
// scan — preview-only heuristic, bounded by one message's size.
function ftsAttachment(buf, index) {
  const { attachments } = scan(buf);
  const a = attachments[index];
  return a ? { filename: a.filename, contentType: mimeFromMagic(a.data), data: a.data } : null;
}

module.exports = { ftsPreview, ftsAttachment };
