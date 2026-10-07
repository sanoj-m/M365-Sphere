// Read-only diagnostic: tally mailbox classification from live Graph data.
// Uses the app's existing client-credentials auth (config.json). No writes.
// Usage: node scripts/tally-mailbox-types.js
const fs = require('fs');
const path = require('path');
const { Auth } = require('../lib/auth.js');
const { GraphClient } = require('../lib/graph.js');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const auth = new Auth(cfg);
const graph = new GraphClient(auth, (level, box, msg) => console.error(`[${level}] ${msg}`));

(async () => {
  let total = 0, guests = 0, licensedMembers = 0, unlicensedMembers = 0, licensedGuests = 0;
  const skuCounts = new Map();
  for await (const batch of graph.pages(`/users?$select=id,userPrincipalName,userType,assignedLicenses&$top=999`)) {
    for (const u of batch) {
      if (!u.userPrincipalName) continue;
      total++;
      const licenses = u.assignedLicenses || [];
      const guest = u.userType === 'Guest';
      if (guest) { guests++; if (licenses.length) licensedGuests++; }
      else if (licenses.length) licensedMembers++; else unlicensedMembers++;
      for (const l of licenses) {
        const id = l.skuId || '(unknown)';
        skuCounts.set(id, (skuCounts.get(id) || 0) + 1);
      }
    }
  }
  console.log('--- Mailbox classification tally (live Graph) ---');
  console.log('total user objects:        ', total);
  console.log('guests (userType=Guest):   ', guests, `(${licensedGuests} with licenses)`);
  console.log('members with licenses:     ', licensedMembers, '→ classified "user" (Licensed)');
  console.log('members without licenses:  ', unlicensedMembers, '→ classified "shared" (heuristic)');
  console.log('--- Top assigned SKU ids ---');
  [...skuCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    .forEach(([id, n]) => console.log(String(n).padStart(6), id));
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
