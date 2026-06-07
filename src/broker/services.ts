// Service registry — host-side execution of mediated service calls with secret
// injection. The secret is substituted ONLY here, just before the outbound fetch,
// and never logged or returned. ${VAULT:KEY} -> vault secret, ${ARG:name} -> tool arg.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSecret } from './vault';
import { doFetch } from './http-fetch';
import type { MediatedToolDef } from '../shared/protocol';

export interface ServiceDef {
  description: string;
  method?: string; // may use ${ARG:method}; default GET
  url: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  basicAuth?: string; // "user:pass" template; substituted then base64'd into Authorization: Basic
  params?: MediatedToolDef['params'];
  timeoutMs?: number;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let policy: Record<string, ServiceDef> = {};

export function loadServices(): void {
  // Explicit override, else your private personal/config/services.policy.json, else none.
  const explicit = process.env.SENTINEL_SERVICES_FILE;
  const personal = path.join(ROOT, 'personal/config/services.policy.json');
  const file = explicit ?? (fs.existsSync(personal) ? personal : '');
  if (!file) {
    policy = {};
    return;
  }
  try {
    policy = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    policy = {};
  }
}

export function serviceManifest(): MediatedToolDef[] {
  return Object.entries(policy).map(([name, s]) => ({ name, description: s.description, params: s.params }));
}

function subst(tmpl: string, args: Record<string, unknown>): string {
  return tmpl
    .replace(/\$\{VAULT:([A-Z0-9_]+)\}/g, (_m, k) => getSecret(k) ?? '')
    .replace(/\$\{ARG:([a-zA-Z0-9_]+)\}/g, (_m, k) => String(args[k] ?? ''));
}

export async function executeService(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const s = policy[name];
  if (!s) return { ok: false, error: `unknown service: ${name}` };

  const method = (subst(s.method ?? 'GET', args) || 'GET').toUpperCase();
  let url: URL;
  try {
    url = new URL(subst(s.url, args));
  } catch {
    return { ok: false, error: 'bad url' };
  }
  for (const [k, v] of Object.entries(s.query ?? {})) url.searchParams.set(k, subst(v, args));
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(s.headers ?? {})) headers[k] = subst(v, args);
  if (s.basicAuth) headers['Authorization'] = 'Basic ' + Buffer.from(subst(s.basicAuth, args)).toString('base64');

  const init: RequestInit = { method, headers };
  // Body for writes: pass a `body` arg (string or JSON-able object).
  const body = (args as any).body;
  if (body != null && method !== 'GET' && method !== 'HEAD') {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
  }

  return doFetch(url, init, s.timeoutMs ?? 15000);
}
