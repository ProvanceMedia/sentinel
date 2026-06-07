// Connections dashboard — the OneCLI-style "add an API key" UX, done locally. A tiny
// host-side web form (no deps) where the operator enters a key + host + scheme; it writes
// the vault (personal/config/secrets.json) + auth-hosts (personal/config/auth-hosts.json)
// and HOT-RELOADS the running daemon — no restart. The secret is entered host-side here,
// never through the agent. Opt-in (SENTINEL_DASHBOARD=on); binds to 127.0.0.1 by default
// (reach it over an SSH tunnel) with HTTP Basic auth.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { reloadVault, vaultSize, getSecret } from '../broker/vault';
import { loadAuthHosts, authHostsList } from '../broker/auth-hosts';
import { writeConnection } from './connections';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const AUTHHOSTS = process.env.SENTINEL_AUTH_HOSTS_FILE ?? path.join(ROOT, 'personal/config/auth-hosts.json');

function readJson(p: string): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

function addConnection(f: Record<string, string>): string {
  const host = writeConnection(f as any);
  reloadVault();
  loadAuthHosts(); // live — http_call + the auth-proxy see it immediately
  return host;
}

function esc(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

function page(added?: string): string {
  const rows = authHostsList()
    .map((h) => {
      const d = readJson(AUTHHOSTS)[h.host] ?? {};
      const keyOk = d.vaultKey && getSecret(d.vaultKey) ? 'ok' : (d.scheme === 'oauth2' ? 'oauth' : 'missing-key');
      return `<tr><td><code>${esc(h.host)}</code></td><td>${esc(d.scheme ?? '')}</td><td>${esc(h.note ?? '')}</td><td class="${keyOk}">${keyOk}</td></tr>`;
    })
    .join('');
  const banner = added ? `<div class="ok">✓ Connected <code>${esc(added)}</code> — the agent can use it now.</div>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Sentinel — Connections</title>
<style>
body{font:15px system-ui,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;color:#1a1a1a}
h1{font-size:1.4rem} h2{font-size:1.05rem;margin-top:2rem}
table{border-collapse:collapse;width:100%;margin:.5rem 0} td,th{text-align:left;padding:.35rem .6rem;border-bottom:1px solid #eee;font-size:.9rem}
code{background:#f4f4f5;padding:.05rem .3rem;border-radius:4px}
form{display:grid;gap:.6rem;margin-top:.5rem} label{display:grid;gap:.2rem;font-size:.85rem;color:#444}
input,select{font:inherit;padding:.45rem;border:1px solid #ccc;border-radius:6px}
button{font:inherit;padding:.55rem 1rem;background:#111;color:#fff;border:0;border-radius:6px;cursor:pointer;width:fit-content}
.ok{background:#e7f6ec;border:1px solid #b6e0c4;padding:.6rem;border-radius:6px;margin:.5rem 0}
.missing-key{color:#b00} .oauth{color:#777} .ok{color:#137a3a}
small{color:#777}
</style></head><body>
<h1>🛰️ Sentinel — Connections</h1>
${banner}
<p><small>Keys are stored host-side in the vault and injected per call. They never reach the agent.</small></p>
<h2>Wired (${authHostsList().length}) · vault: ${vaultSize()} keys</h2>
<table><tr><th>Host</th><th>Auth</th><th>Note</th><th>Key</th></tr>${rows || '<tr><td colspan=4><small>none yet</small></td></tr>'}</table>
<h2>Add a connection</h2>
<form method="post" action="/connect" autocomplete="off">
  <label>API host <input name="host" placeholder="api.acme.com" required oninput="suggest(this.value)"></label>
  <label>Auth scheme
    <select name="scheme" onchange="showFor(this.value)">
      <option value="bearer">Bearer token (Authorization: Bearer KEY)</option>
      <option value="header">Custom header (e.g. X-API-Key: KEY)</option>
      <option value="query">Query param (?api_key=KEY)</option>
      <option value="basic">Basic auth (KEY as username)</option>
    </select></label>
  <label id="f-header" style="display:none">Header name <input name="headerName" placeholder="X-API-Key"></label>
  <label id="f-query" style="display:none">Query param name <input name="queryParam" placeholder="api_key"></label>
  <label id="f-basic" style="display:none">Basic password (optional) <input name="basicPassword" placeholder="(blank)"></label>
  <label>Vault key name <input name="vaultKey" id="vk" placeholder="ACME_KEY" required></label>
  <label>The secret / API key <input name="secret" type="password" required></label>
  <label>Note (what is it, optional) <input name="note" placeholder="Acme widgets API"></label>
  <button type="submit">Connect</button>
</form>
<script>
function showFor(s){for(const k of ['header','query','basic'])document.getElementById('f-'+k).style.display=(s===k)?'grid':'none';}
function suggest(h){const vk=document.getElementById('vk');if(!vk.dataset.touched){const base=(h.split('.').slice(-2,-1)[0]||h).toUpperCase().replace(/[^A-Z0-9]/g,'');vk.value=base?base+'_KEY':'';}}
document.getElementById('vk').addEventListener('input',function(){this.dataset.touched=1;});
</script>
</body></html>`;
}

export function startDashboard(): { stop: () => void } | null {
  if (process.env.SENTINEL_DASHBOARD !== 'on') return null;
  const port = Number(process.env.SENTINEL_DASHBOARD_PORT ?? 10254);
  const bind = process.env.SENTINEL_DASHBOARD_BIND ?? '127.0.0.1';
  const user = 'sentinel';
  let pass = process.env.SENTINEL_DASHBOARD_PASSWORD;
  if (!pass) {
    pass = crypto.randomBytes(12).toString('base64url');
    console.error(`[dashboard] generated password (set SENTINEL_DASHBOARD_PASSWORD to fix it): ${pass}`);
  }

  const server = http.createServer((req, res) => {
    const hdr = req.headers.authorization ?? '';
    const [, b64] = hdr.split(' ');
    const [u, p] = Buffer.from(b64 ?? '', 'base64').toString().split(':');
    if (u !== user || p !== pass) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="sentinel"' });
      res.end('auth required');
      return;
    }
    if (req.method === 'POST' && req.url === '/connect') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const f = Object.fromEntries(new URLSearchParams(body));
        try {
          const host = addConnection(f as Record<string, string>);
          res.writeHead(303, { Location: '/?added=' + encodeURIComponent(host) });
          res.end();
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('error: ' + (e?.message ?? e));
        }
      });
      return;
    }
    const added = new URL(req.url ?? '/', 'http://x').searchParams.get('added') ?? undefined;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page(added));
  });
  server.listen(port, bind, () => console.error(`[dashboard] connections UI at http://${bind}:${port}  (user: ${user})`));
  server.on('error', (e) => console.error('[dashboard] error:', (e as Error).message));
  return { stop: () => server.close() };
}
