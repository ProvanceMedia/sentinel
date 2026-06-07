// Generate Sentinel's per-deployment auth-proxy CA — ONCE, idempotently, into certs/.
// The proxy mints per-host leaf certs signed by this CA at request time; the runner
// image bakes ONLY the public cert (certs/sentinel-ca.crt) into its trust store. The
// private key (certs/sentinel-ca.key) is host-only, 0600, NEVER committed or copied
// into the container — it is a forge-anything primitive.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import forge from 'node-forge';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CERT_DIR = path.join(ROOT, 'certs');
const CRT = path.join(CERT_DIR, 'sentinel-ca.crt');
const KEY = path.join(CERT_DIR, 'sentinel-ca.key');

if (fs.existsSync(CRT) && fs.existsSync(KEY)) {
  console.error('[gen-ca] CA already exists — leaving it. (delete certs/ to rotate)');
  process.exit(0);
}

fs.mkdirSync(CERT_DIR, { recursive: true });
console.error('[gen-ca] generating a fresh 2048-bit CA (valid 2 years)…');

const keys = forge.pki.rsa.generateKeyPair(2048);
const cert = forge.pki.createCertificate();
cert.publicKey = keys.publicKey;
cert.serialNumber = '01' + Math.floor(Math.random() * 1e12).toString(16);
cert.validity.notBefore = new Date();
cert.validity.notAfter = new Date();
cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 2);
const attrs = [
  { name: 'commonName', value: 'Sentinel Auth Proxy CA' },
  { name: 'organizationName', value: 'Sentinel' },
];
cert.setSubject(attrs);
cert.setIssuer(attrs);
cert.setExtensions([
  { name: 'basicConstraints', cA: true, critical: true },
  { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
]);
cert.sign(keys.privateKey, forge.md.sha256.create());

fs.writeFileSync(CRT, forge.pki.certificateToPem(cert));
fs.writeFileSync(KEY, forge.pki.privateKeyToPem(keys.privateKey), { mode: 0o600 });
fs.chmodSync(KEY, 0o600);
console.error(`[gen-ca] wrote ${path.relative(ROOT, CRT)} (public) + ${path.relative(ROOT, KEY)} (0600, host-only)`);
