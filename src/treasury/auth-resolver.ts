// The SOLE producer of the runner's environment. Never spreads the supervisor's
// process.env (which holds all service secrets). Builds a frozen allowlist base
// + exactly one Anthropic credential, with the other blanked.
//
// Currently passes the CLAUDE_CODE_OAUTH_TOKEN from the host env.
// TODO (security phase): mint a short-TTL access token per turn instead, and add
// an API-key route for the per-path billing model.

const ENV_ALLOWLIST_BASE = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'NODE_OPTIONS'];

export interface ResolvedAuth {
  env: Record<string, string>;
  expected: { tokenSource: string; apiProvider: string; apiKeySource: string };
  route: string;
}

export function resolveAuth(route: string): ResolvedAuth {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) {
    throw new Error(`CLAUDE_CODE_OAUTH_TOKEN not set on the host (subscription auth required for route "${route}")`);
  }

  const env: Record<string, string> = {};
  for (const k of ENV_ALLOWLIST_BASE) {
    const v = process.env[k];
    if (v != null) env[k] = v;
  }
  // exactly one Anthropic credential; blank the other so it can never win precedence.
  env.CLAUDE_CODE_OAUTH_TOKEN = token;
  env.ANTHROPIC_API_KEY = '';
  env.SENTINEL_AUTH_STAMP = '1'; // marks this env as AuthResolver-produced

  // Auth-proxy (opt-in via SENTINEL_AUTHPROXY=on): route the container's outbound HTTPS
  // through the host proxy, which injects the real credential for allowlisted hosts. The
  // container holds only PLACEHOLDER tokens; the real keys never enter it. undici (the
  // SDK's Anthropic path) ignores these, and NO_PROXY pins Anthropic direct as well.
  if (process.env.SENTINEL_AUTHPROXY === 'on') {
    const proxyUrl = `http://host.docker.internal:${process.env.SENTINEL_PROXY_PORT ?? '10260'}`;
    env.HTTPS_PROXY = proxyUrl;
    env.https_proxy = proxyUrl;
    env.NO_PROXY = 'api.anthropic.com,localhost,127.0.0.1';
    env.no_proxy = env.NO_PROXY;
    // Placeholders so gh/git actually issue the request; the proxy swaps in the real token.
    env.GH_TOKEN = 'sentinel-proxy-placeholder';
    env.GITHUB_TOKEN = 'sentinel-proxy-placeholder';
  }

  return {
    env,
    expected: { tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN', apiProvider: 'firstParty', apiKeySource: 'none' },
    route,
  };
}
