// auth-hosts — a flat hostname -> credential map so adding an authenticated API is ONE
// line (host + scheme + vault key) instead of a full service definition. Powers the
// generic `http_call` tool: the agent names a host, the host injects the credential.
// The secret stays in the vault, host-side; only the key NAME lives here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSecret } from './vault';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export interface AuthHost {
  scheme: 'bearer' | 'header' | 'basic' | 'query' | 'oauth2';
  vaultKey?: string; // name of the secret in the vault (never the value); not used by oauth2
  headerName?: string; // for scheme=header (default Authorization)
  basicPassword?: string; // for scheme=basic (key is the username; default empty password)
  queryParam?: string; // for scheme=query (default api_key)
  extraHeaders?: Record<string, string>; // non-secret headers (Accept, User-Agent, …)
  note?: string; // short human label shown to the agent so it knows what this host is for
  // scheme=oauth2: refresh a short-lived access token (host-side) and inject it as Bearer.
  tokenUrl?: string; // default https://oauth2.googleapis.com/token
  clientIdKey?: string; // vault key for the OAuth client id
  clientSecretKey?: string; // vault key for the OAuth client secret
  refreshTokenKey?: string; // vault key for the refresh token
}

let hosts: Record<string, AuthHost> = {};

export function loadAuthHosts(): void {
  const explicit = process.env.SENTINEL_AUTH_HOSTS_FILE;
  const personal = path.join(ROOT, 'personal/config/auth-hosts.json');
  const file = explicit ?? (fs.existsSync(personal) ? personal : '');
  if (!file) {
    hosts = {};
    return;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    hosts = Object.fromEntries(Object.entries(raw).map(([h, d]) => [h.toLowerCase(), d as AuthHost]));
  } catch {
    hosts = {};
    return;
  }
  // Loud warning (no values) if a configured host points at a missing vault key.
  for (const [h, d] of Object.entries(hosts)) {
    if (d?.vaultKey && !getSecret(d.vaultKey)) console.error(`[broker] auth-hosts: "${h}" needs vault key ${d.vaultKey}, which is not set`);
  }
}

export function lookupHost(hostname: string): AuthHost | undefined {
  return hosts[hostname.toLowerCase()];
}

export function authHostsCount(): number {
  return Object.keys(hosts).length;
}

export function authHostsList(): { host: string; note?: string }[] {
  return Object.entries(hosts).map(([host, d]) => ({ host, note: d.note }));
}
