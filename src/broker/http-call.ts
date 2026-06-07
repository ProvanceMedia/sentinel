// http_call — the generic "use any configured API naturally" tool (nanoclaw-style).
// The agent names a host + path; the host looks it up in auth-hosts.json, injects the
// credential from the vault, and fetches host-side. Adding an API = one line of config;
// the agent never holds a key and can only reach allowlisted hosts (fail-closed).
import { registerInternalTool } from './index';
import { lookupHost } from './auth-hosts';
import { getSecret } from './vault';
import { getAccessToken } from './oauth';
import { doFetch, ssrfCheck } from './http-fetch';
import type { MediatedResult } from '../shared/protocol';

export async function httpCall(args: Record<string, unknown>): Promise<MediatedResult> {
  const host = String(args.host ?? '')
    .trim()
    .toLowerCase();
  if (!host) return { ok: false, error: 'host required' };
  // Never let the agent reach Anthropic through here (the OAuth token must never be forwarded/logged).
  if (host === 'api.anthropic.com') return { ok: false, error: 'refused: api.anthropic.com is not callable via http_call' };

  const desc = lookupHost(host);
  if (!desc) return { ok: false, error: `host not configured — add "${host}" to personal/config/auth-hosts.json` };

  // SSRF defence: this fetch runs uncontained on the host.
  const blocked = await ssrfCheck(host);
  if (blocked) return { ok: false, error: `refused: ${blocked}` };

  const method = String(args.method ?? 'GET').toUpperCase();
  let p = String(args.path ?? '');
  if (p.startsWith('/')) p = p.slice(1);
  let url: URL;
  try {
    url = new URL(`https://${host}/${p}`);
  } catch {
    return { ok: false, error: 'bad path' };
  }
  if (args.query) {
    try {
      for (const [k, v] of new URLSearchParams(String(args.query))) url.searchParams.append(k, v);
    } catch {
      /* ignore malformed query */
    }
  }

  // Headers are host-controlled only — the agent cannot set them, so there is nothing to strip.
  const headers: Record<string, string> = { ...(desc.extraHeaders ?? {}) };
  if (desc.scheme === 'oauth2') {
    const token = await getAccessToken(desc);
    if (!token) return { ok: false, error: `could not obtain an OAuth access token for ${host}` };
    headers['Authorization'] = `Bearer ${token}`;
  } else {
    const secret = getSecret(desc.vaultKey ?? '');
    if (!secret) return { ok: false, error: `vault has no key ${desc.vaultKey} (for ${host})` };
    switch (desc.scheme) {
      case 'bearer':
        headers['Authorization'] = `Bearer ${secret}`;
        break;
      case 'header':
        headers[desc.headerName ?? 'Authorization'] = secret;
        break;
      case 'basic':
        headers['Authorization'] = 'Basic ' + Buffer.from(`${secret}:${desc.basicPassword ?? ''}`).toString('base64');
        break;
      case 'query':
        url.searchParams.set(desc.queryParam ?? 'api_key', secret);
        break;
      default:
        return { ok: false, error: `unknown auth scheme for ${host}` };
    }
  }

  const init: RequestInit = { method, headers };
  const body = (args as any).body;
  if (body != null && method !== 'GET' && method !== 'HEAD') {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
  }

  return doFetch(url, init, 15_000);
}

export function registerHttpTool(): void {
  registerInternalTool(
    {
      name: 'http_call',
      description:
        'Make an authenticated HTTPS request to a configured API host — the host injects the API key for you (you never see it). Use this for any host listed in auth-hosts.json instead of curl. Params: host (e.g. api.stripe.com), path (e.g. v1/events), method (default GET), query (without leading ?), body (JSON, for writes).',
      params: {
        host: { type: 'string', description: 'the API hostname, e.g. api.stripe.com' },
        path: { type: 'string', description: 'path after the host, e.g. crm/v3/objects/contacts' },
        method: { type: 'string', description: 'GET/POST/PATCH/DELETE (default GET)', optional: true },
        query: { type: 'string', description: 'querystring without the leading ? (optional)', optional: true },
        body: { type: 'string', description: 'JSON body for writes (optional)', optional: true },
      },
    },
    httpCall,
  );
}
