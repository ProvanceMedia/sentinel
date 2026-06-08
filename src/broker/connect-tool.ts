// sentinel_connect — the agent wires up an API connection WITHOUT ever seeing the key.
// The operator drops the key in the vault (named) and gives the agent the host + a test
// path; the agent calls this tool, which probes the (operator-provided) host with the
// vault key to DETECT the auth scheme, then saves the connection. The host is never
// guessed by the agent, so a wrong guess can only break the setup — never leak the key.
import { registerInternalTool } from './index';
import { getSecret, reloadVault } from './vault';
import { loadAuthHosts } from './auth-hosts';
import { ssrfCheck } from './http-fetch';
import { writeAuthHost } from '../host/connections';
import type { MediatedResult } from '../shared/protocol';

interface Candidate {
  scheme: string;
  headerName?: string;
  queryParam?: string;
}
// Ordered by prevalence — first 2xx wins.
const CANDIDATES: Candidate[] = [
  { scheme: 'bearer' },
  { scheme: 'header', headerName: 'X-API-Key' },
  { scheme: 'query', queryParam: 'api_key' },
  { scheme: 'query', queryParam: 'key' }, // weatherapi.com, many others
  { scheme: 'query', queryParam: 'apikey' },
  { scheme: 'query', queryParam: 'token' },
  { scheme: 'header', headerName: 'Authorization' }, // raw key, no "Bearer"
  { scheme: 'basic' },
];

async function probe(host: string, testPath: string, key: string | null, c?: Candidate): Promise<number> {
  let url: URL;
  try {
    url = new URL(`https://${host}/${testPath.replace(/^\//, '')}`);
  } catch {
    return 0;
  }
  const headers: Record<string, string> = { 'User-Agent': 'sentinel', Accept: 'application/json' };
  if (key && c) {
    if (c.scheme === 'bearer') headers['Authorization'] = `Bearer ${key}`;
    else if (c.scheme === 'header') headers[c.headerName!] = key;
    else if (c.scheme === 'query') url.searchParams.set(c.queryParam!, key);
    else if (c.scheme === 'basic') headers['Authorization'] = 'Basic ' + Buffer.from(`${key}:`).toString('base64');
  }
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { headers, signal: ctrl.signal });
    return r.status;
  } catch {
    return 0;
  } finally {
    clearTimeout(to);
  }
}

export function registerConnectTool(): void {
  registerInternalTool(
    {
      name: 'sentinel_connect',
      description:
        'Wire up OR fix an API connection so you can call it with http_call. The operator first adds the key to the vault (named) and gives you the host — NEVER invent the host. By default this probes the host with the vault key to AUTO-DETECT the auth scheme and saves it. If auto-detect was wrong, or you already know the API\'s auth from its docs, pass an explicit `scheme` (bearer | header | query | basic) with `headerName` or `queryParam` to SET it — re-calling for the same host overwrites the old entry, so this is also how you REPAIR a broken connection. You only ever set config; you never see the key. Params: host, vaultKey, testPath (an auth-requiring GET path used to verify, e.g. v1/current.json?q=London), scheme/headerName/queryParam (optional, to set auth explicitly), note (optional).',
      params: {
        host: { type: 'string', description: 'the API host the operator gave you — do not guess it' },
        vaultKey: { type: 'string', description: 'name of the key already in the vault' },
        testPath: { type: 'string', description: 'an auth-requiring GET path to probe/verify, e.g. v1/me', optional: true },
        scheme: { type: 'string', description: 'explicit auth scheme to SET: bearer | header | query | basic (omit to auto-detect)', optional: true },
        headerName: { type: 'string', description: 'header name when scheme=header (e.g. X-API-Key)', optional: true },
        queryParam: { type: 'string', description: 'query-param name when scheme=query (e.g. key, api_key)', optional: true },
        note: { type: 'string', description: 'short label for what this API is', optional: true },
      },
    },
    async (args): Promise<MediatedResult> => {
      const host = String(args.host ?? '')
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .split('/')[0];
      const vaultKey = String(args.vaultKey ?? '').trim();
      const testPath = String(args.testPath ?? '').trim();
      if (!host || !vaultKey) return { ok: false, error: 'host and vaultKey are required' };
      if (host === 'api.anthropic.com') return { ok: false, error: 'refused: api.anthropic.com' };

      const key = getSecret(vaultKey);
      if (!key) {
        return {
          ok: false,
          error: `no key named "${vaultKey}" in the vault. The operator must add it first, host-side: \`npm run connect -- --name ${vaultKey}\` (or the dashboard). Ask them to do that, then try again.`,
        };
      }

      const blocked = await ssrfCheck(host);
      if (blocked) return { ok: false, error: `refused: ${blocked}` };

      const explicit = String(args.scheme ?? '').trim().toLowerCase();
      let chosen: Candidate = { scheme: 'bearer' };
      let verified = false;
      let status = 0;

      if (explicit) {
        // The agent is SETTING the auth method (knows it, or repairing a wrong guess).
        if (!['bearer', 'header', 'query', 'basic'].includes(explicit)) {
          return { ok: false, error: `unknown scheme "${explicit}" — use bearer | header | query | basic` };
        }
        chosen = { scheme: explicit };
        if (explicit === 'header') chosen.headerName = String(args.headerName ?? 'X-API-Key').trim();
        if (explicit === 'query') chosen.queryParam = String(args.queryParam ?? 'api_key').trim();
        if (testPath) {
          const base = await probe(host, testPath, null);
          const baseOpen = base >= 200 && base < 300;
          const s = await probe(host, testPath, key, chosen);
          verified = s >= 200 && s < 300 && !baseOpen;
          status = verified ? s : s || base;
        }
      } else if (testPath) {
        // Auto-detect by probing — only "verify" if the endpoint actually requires auth.
        const base = await probe(host, testPath, null);
        const baseOpen = base >= 200 && base < 300;
        for (const c of CANDIDATES) {
          const s = await probe(host, testPath, key, c);
          if (s >= 200 && s < 300 && !baseOpen) {
            chosen = c;
            verified = true;
            status = s;
            break;
          }
        }
        if (!verified) status = base;
      }

      const entry: Record<string, unknown> = { scheme: chosen.scheme, vaultKey };
      if (chosen.headerName) entry.headerName = chosen.headerName;
      if (chosen.queryParam) entry.queryParam = chosen.queryParam;
      if (args.note) entry.note = String(args.note).trim();
      writeAuthHost(host, entry);
      reloadVault();
      loadAuthHosts(); // live

      const how =
        chosen.scheme === 'header'
          ? `a ${chosen.headerName} header`
          : chosen.scheme === 'query'
            ? `a ?${chosen.queryParam}= query param`
            : chosen.scheme === 'basic'
              ? 'HTTP Basic auth'
              : 'a Bearer token';
      return {
        ok: true,
        data: verified
          ? `Connected ${host} — detected ${how} (verified: HTTP ${status} on ${testPath}). You can call it with http_call now.`
          : `Saved ${host} as ${how}, but could NOT verify it${testPath ? ` (HTTP ${status} on ${testPath})` : ' (no test path was given)'}. If an http_call 401/403s, FIX it yourself: re-call sentinel_connect for this host with an explicit scheme (e.g. scheme:"query", queryParam:"key" for weatherapi.com) — check the API docs for how the key is passed. You only set config, never see the key.`,
      };
    },
  );
}
