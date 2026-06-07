// Shared "add a connection" writer — used by BOTH the dashboard (web form) and the
// `connect` CLI. Writes the secret into the vault and the host->scheme rule into
// auth-hosts; reloading the running daemon is the caller's concern (in-process for the
// dashboard, SIGHUP for the CLI). The secret is handled host-side only — never the agent.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SECRETS = process.env.SENTINEL_VAULT_FILE ?? path.join(ROOT, 'personal/config/secrets.json');
const AUTHHOSTS = process.env.SENTINEL_AUTH_HOSTS_FILE ?? path.join(ROOT, 'personal/config/auth-hosts.json');

export interface ConnFields {
  host: string;
  scheme: string; // bearer | header | basic | query
  vaultKey: string;
  secret: string;
  headerName?: string;
  basicPassword?: string;
  queryParam?: string;
  note?: string;
}

function readJson(p: string): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}
function writeJson(p: string, obj: unknown, mode?: number): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  if (mode) fs.chmodSync(p, mode);
}

/** Write the secret to the vault + the host rule to auth-hosts. Returns the normalised host. */
export function writeConnection(f: ConnFields): string {
  const host = (f.host || '').trim().toLowerCase();
  const scheme = (f.scheme || 'bearer').trim();
  const vaultKey = (f.vaultKey || '').trim();
  if (!host || !vaultKey || !f.secret) throw new Error('host, key name and secret are all required');

  const secrets = readJson(SECRETS);
  secrets[vaultKey] = f.secret;
  writeJson(SECRETS, secrets, 0o600);

  const entry: Record<string, unknown> = { scheme, vaultKey };
  if (scheme === 'header' && f.headerName?.trim()) entry.headerName = f.headerName.trim();
  if (scheme === 'basic') entry.basicPassword = f.basicPassword ?? '';
  if (scheme === 'query' && f.queryParam?.trim()) entry.queryParam = f.queryParam.trim();
  if (f.note?.trim()) entry.note = f.note.trim();
  const hosts = readJson(AUTHHOSTS);
  hosts[host] = entry;
  writeJson(AUTHHOSTS, hosts);

  return host;
}

/** Store a secret in the vault by name only (no host yet) — for `connect --name`. */
export function writeSecretOnly(name: string, value: string): void {
  const key = name.trim();
  if (!key || !value) throw new Error('a key name and a secret are required');
  const secrets = readJson(SECRETS);
  secrets[key] = value;
  writeJson(SECRETS, secrets, 0o600);
}

/** Write only the auth-hosts entry (the secret is assumed already in the vault). */
export function writeAuthHost(host: string, entry: Record<string, unknown>): void {
  const h = host.trim().toLowerCase();
  if (!h) throw new Error('host is required');
  const hosts = readJson(AUTHHOSTS);
  hosts[h] = entry;
  writeJson(AUTHHOSTS, hosts);
}
