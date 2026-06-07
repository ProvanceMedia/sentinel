// Auth proxy — the "nanoclaw mechanism" done natively. A host-side HTTPS forward proxy
// the container points HTTPS_PROXY at. For an allowlisted host it MITM-terminates TLS
// (per-host leaf cert signed by Sentinel's CA, which the runner image trusts), injects
// the real credential from the vault, and forwards. So unmodified binaries (gh, git,
// curl) make normal calls with only a PLACEHOLDER credential; the real key never enters
// the container. Reuses auth-hosts.json + the vault — same config as the http_call tool.
//
// Boundaries: fail-closed (a CONNECT to a host NOT in auth-hosts -> 403, no tunnel);
// refuses api.anthropic.com (never MITM the OAuth path); SSRF guard (host runs
// uncontained); logs host+status only, never headers/secrets.
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import forge from 'node-forge';
import { lookupHost, authHostsCount, type AuthHost } from '../broker/auth-hosts';
import { getSecret } from '../broker/vault';
import { getAccessToken } from '../broker/oauth';
import { ssrfCheck } from '../broker/http-fetch';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CRT = path.join(ROOT, 'certs/sentinel-ca.crt');
const KEY = path.join(ROOT, 'certs/sentinel-ca.key');

let caCert: forge.pki.Certificate;
let caKey: forge.pki.rsa.PrivateKey;
let caCertPem: string;
let leafKeyPair: forge.pki.rsa.KeyPair; // one key, many per-host certs
const ctxCache = new Map<string, tls.SecureContext>();

function loadCA(): void {
  caCertPem = fs.readFileSync(CRT, 'utf8');
  caCert = forge.pki.certificateFromPem(caCertPem);
  caKey = forge.pki.privateKeyFromPem(fs.readFileSync(KEY, 'utf8')) as forge.pki.rsa.PrivateKey;
  leafKeyPair = forge.pki.rsa.generateKeyPair(2048);
}

function contextForHost(host: string): tls.SecureContext {
  const hit = ctxCache.get(host);
  if (hit) return hit;
  const cert = forge.pki.createCertificate();
  cert.publicKey = leafKeyPair.publicKey;
  cert.serialNumber = Date.now().toString(16) + Math.floor(Math.random() * 1e6).toString(16);
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86_400_000);
  cert.setSubject([{ name: 'commonName', value: host }]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [{ type: 2, value: host }] },
  ]);
  cert.sign(caKey, forge.md.sha256.create());
  const ctx = tls.createSecureContext({
    key: forge.pki.privateKeyToPem(leafKeyPair.privateKey),
    cert: forge.pki.certificateToPem(cert) + caCertPem,
  });
  ctxCache.set(host, ctx);
  return ctx;
}

// Returns true if a credential was injected. The agent only ever sends a placeholder —
// strip anything it set and put the real one (an access token for oauth2, else a vault secret).
async function injectAuth(headers: http.IncomingHttpHeaders, url: URL, d: AuthHost): Promise<boolean> {
  delete headers['authorization'];
  delete headers['proxy-authorization'];
  for (const [k, v] of Object.entries(d.extraHeaders ?? {})) headers[k.toLowerCase()] = v;
  if (d.scheme === 'oauth2') {
    const token = await getAccessToken(d);
    if (!token) return false;
    headers['authorization'] = `Bearer ${token}`;
    return true;
  }
  const secret = getSecret(d.vaultKey ?? '');
  if (!secret) return false;
  switch (d.scheme) {
    case 'bearer':
      headers['authorization'] = `Bearer ${secret}`;
      break;
    case 'header':
      headers[(d.headerName ?? 'Authorization').toLowerCase()] = secret;
      break;
    case 'basic':
      headers['authorization'] = 'Basic ' + Buffer.from(`${secret}:${d.basicPassword ?? ''}`).toString('base64');
      break;
    case 'query':
      url.searchParams.set(d.queryParam ?? 'api_key', secret);
      break;
    default:
      return false;
  }
  return true;
}

// Container->host(gateway) traffic hits the host INPUT chain (not the FORWARD jail), and
// a locked-down host (INPUT policy DROP / ufw) drops it. Open ONLY the proxy port to the
// docker bridge subnets so the container can reach the proxy. Idempotent; root required.
const BRIDGE_SUBNETS = ['172.17.0.0/16', '172.31.99.0/24'];
function ruleBody(port: number, subnet: string): string[] {
  return ['-p', 'tcp', '--dport', String(port), '-s', subnet, '-j', 'ACCEPT'];
}
function ensureIngress(port: number): void {
  for (const subnet of BRIDGE_SUBNETS) {
    try {
      execFileSync('iptables', ['-C', 'INPUT', ...ruleBody(port, subnet)], { stdio: 'ignore' });
    } catch {
      try {
        execFileSync('iptables', ['-I', 'INPUT', '1', ...ruleBody(port, subnet)], { stdio: 'ignore' });
      } catch (e) {
        console.error(`[auth-proxy] could not open INPUT for ${subnet}:${port} (root + iptables needed):`, (e as Error).message);
      }
    }
  }
}
function removeIngress(port: number): void {
  for (const subnet of BRIDGE_SUBNETS) {
    try {
      execFileSync('iptables', ['-D', 'INPUT', ...ruleBody(port, subnet)], { stdio: 'ignore' });
    } catch {
      /* best effort */
    }
  }
}

export interface AuthProxyHandle {
  port: number;
  stop: () => void;
}

export function startAuthProxy(): AuthProxyHandle | null {
  if (!fs.existsSync(CRT) || !fs.existsSync(KEY)) {
    console.error('[auth-proxy] no CA at certs/ (run `npm run gen-ca`) — proxy disabled');
    return null;
  }
  loadCA();
  const port = Number(process.env.SENTINEL_PROXY_PORT ?? 10260);
  const bind = process.env.SENTINEL_PROXY_BIND ?? '0.0.0.0';

  // Handles the DECRYPTED requests coming off each MITM'd TLS connection.
  const mitm = http.createServer((creq, cres) => {
    void (async () => {
      const host = String(creq.headers.host ?? '')
        .split(':')[0]
        .toLowerCase();
      const d = lookupHost(host);
      if (!d) {
        cres.writeHead(403);
        cres.end('host not configured');
        return;
      }
      const url = new URL(`https://${host}${creq.url}`);
      const headers = { ...creq.headers };
      if (!(await injectAuth(headers, url, d))) {
        cres.writeHead(502);
        cres.end('no credential');
        return;
      }
      headers.host = host;
      creq.on('error', () => {});
      cres.on('error', () => {});
      const upstream = https.request(
        { host, port: 443, path: url.pathname + url.search, method: creq.method, headers, servername: host },
        (ures) => {
          ures.on('error', () => cres.destroy());
          cres.writeHead(ures.statusCode ?? 502, ures.headers);
          ures.pipe(cres);
        },
      );
      upstream.on('error', () => {
        try {
          if (!cres.headersSent) cres.writeHead(502);
          cres.end('upstream error');
        } catch {
          /* client gone */
        }
      });
      creq.pipe(upstream);
    })();
  });

  const server = http.createServer((_req, res) => {
    res.writeHead(405);
    res.end('this is a CONNECT proxy');
  });

  server.on('connect', (req, clientSocket) => {
    // FIRST, always: a denied or reset client socket must never crash the proxy.
    clientSocket.on('error', () => clientSocket.destroy());
    const host = String(req.url ?? '')
      .split(':')[0]
      .toLowerCase();
    const deny = (why: string) => {
      console.error(`[auth-proxy] DENY ${host} (${why})`);
      try {
        clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      } catch {
        /* socket already gone */
      }
    };
    if (!lookupHost(host)) return deny('not in auth-hosts');
    if (host === 'api.anthropic.com') return deny('anthropic');
    void ssrfCheck(host).then((blocked) => {
      if (blocked) return deny(blocked);
      try {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        const tlsSocket = new tls.TLSSocket(clientSocket, { isServer: true, secureContext: contextForHost(host) });
        tlsSocket.on('error', () => clientSocket.destroy());
        mitm.emit('connection', tlsSocket);
      } catch (e) {
        console.error('[auth-proxy] connect setup error:', (e as Error).message);
        clientSocket.destroy();
      }
    });
  });

  server.listen(port, bind, () => {
    ensureIngress(port);
    console.error(`[auth-proxy] listening on ${bind}:${port} — ${authHostsCount()} host(s) injectable`);
  });
  server.on('error', (e) => console.error('[auth-proxy] server error:', (e as Error).message));
  return {
    port,
    stop: () => {
      removeIngress(port);
      server.close();
    },
  };
}
