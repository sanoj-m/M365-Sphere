// Diff two live copies of the same Message-ID to see why byte-hashes differ.
const cfg = require('../config.json');
const { Auth } = require('../lib/auth');
const { GraphClient } = require('../lib/graph');

const upn = process.argv[2];
if (!upn) { console.error('usage: node scripts/_dedupe-diff.js <upn>'); process.exit(1); }

(async () => {
  const auth = new Auth(cfg);
  const graph = new GraphClient(auth, () => { });
  const tree = await graph.folderTree(upn);
  const byKey = new Map();
  for (const f of tree.filter(f => f.itemCount > 0)) {
    const msgs = await graph.listMessageKeys(upn, f.folderId);
    for (const m of msgs) {
      if (!m.internetMessageId) continue;
      const arr = byKey.get(m.internetMessageId) || [];
      arr.push({ id: m.id, folder: f.path, subject: m.subject });
      byKey.set(m.internetMessageId, arr);
    }
  }
  const group = [...byKey.values()].find(g => g.length > 1);
  if (!group) { console.log('no duplicate Message-ID group found'); return; }
  console.log('group:', group.map(x => `${x.folder} :: ${x.subject}`));
  const a = await graph.getMessageMime(upn, group[0].id);
  const b = await graph.getMessageMime(upn, group[1].id);
  const { mimeFingerprint } = require('../lib/dedupe');
  console.log('sizes:', a.length, b.length);
  const fa = await mimeFingerprint(a), fb = await mimeFingerprint(b);
  console.log('fingerprint A:', fa);
  console.log('fingerprint B:', fb);
  console.log(fa === fb ? 'MATCH — fingerprints identical' : 'MISMATCH — fingerprints differ');
  if (fa !== fb) {
    const { simpleParser } = require('mailparser');
    const crypto = require('crypto');
    const sha = b => crypto.createHash('sha256').update(b).digest('hex').slice(0, 12);
    const dump = (label, mail) => {
      console.log(`--- ${label}`);
      console.log('subject:', JSON.stringify(mail.subject));
      console.log('from:', JSON.stringify(mail.from && mail.from.value));
      console.log('to:', JSON.stringify(mail.to && mail.to.value));
      console.log('date:', mail.date && mail.date.toISOString(), 'messageId:', mail.messageId);
      console.log('text len/hash:', (mail.text || '').length, sha(mail.text || ''));
      console.log('html len/hash:', (mail.html || '').length, sha(mail.html || ''));
      for (const a of (mail.attachments || [])) console.log('att:', a.filename, a.contentType, a.size, sha(a.content));
    };
    dump('A', await simpleParser(a));
    dump('B', await simpleParser(b));
    const pa = await simpleParser(a), pb = await simpleParser(b);
    const showDiff = (label, x, y) => {
      if (x === y) return;
      let i = 0;
      while (i < Math.min(x.length, y.length) && x[i] === y[i]) i++;
      console.log(`--- ${label} first diff at char ${i} (len ${x.length} vs ${y.length})`);
      console.log('  A:', JSON.stringify(x.slice(Math.max(0, i - 120), i + 120)));
      console.log('  B:', JSON.stringify(y.slice(Math.max(0, i - 120), i + 120)));
    };
    showDiff('text', pa.text || '', pb.text || '');
    showDiff('html', pa.html || '', pb.html || '');
  }
})().catch(e => { console.error(e.message); process.exit(1); });
