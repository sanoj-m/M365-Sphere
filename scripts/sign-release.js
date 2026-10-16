// Signs the update zip with the release signing key (ed25519, no deps).
// Usage: node scripts/sign-release.js <zipPath>
// Key: installer/release-key.pem (PKCS8 PEM). Missing → a keypair is
// generated, the private key is written there (BACK IT UP) and the public
// key is printed for embedding into lib/updater.js (UPDATE_PUBKEY).
// Output: <zipPath>.sig — ed25519 signature over the zip bytes, base64url,
// single-line ASCII. Attach it to the GitHub Release next to the zip +
// .sha256 sidecar.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const keyFile = path.join(root, 'installer', 'release-key.pem');
const zip = process.argv[2] && path.resolve(process.argv[2]);
if (!zip || !fs.existsSync(zip)) {
  console.error('usage: node scripts/sign-release.js <zipPath>');
  process.exit(1);
}

let priv;
if (fs.existsSync(keyFile)) {
  priv = crypto.createPrivateKey(fs.readFileSync(keyFile, 'utf8'));
} else {
  const pair = crypto.generateKeyPairSync('ed25519');
  priv = pair.privateKey;
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, priv.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  const pub = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  console.log(`[sign] generated NEW ed25519 keypair → installer/release-key.pem`);
  console.log(`[sign] BACK UP installer/release-key.pem NOW — losing it means no more signed releases.`);
  console.log(`[sign] embed this public key as UPDATE_PUBKEY in lib/updater.js:`);
  console.log(pub);
}

const data = fs.readFileSync(zip);
const sig = crypto.sign(null, data, priv).toString('base64url');
fs.writeFileSync(`${zip}.sig`, sig + '\n', 'ascii');
console.log(`[sign] wrote ${path.basename(zip)}.sig (ed25519, base64url)`);
const sha = crypto.createHash('sha256').update(data).digest('hex');
console.log(`[sign] reminder — ${zip}.sha256 should contain:`);
console.log(`${sha}  ${path.basename(zip)}`);
