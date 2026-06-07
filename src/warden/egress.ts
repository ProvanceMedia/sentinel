// Egress jail — per-jail-network default-deny egress enforced at the KERNEL via
// iptables DOCKER-USER rules (NOT HTTP_PROXY env, which undici ignores). Containers
// on the `sentinel-jail` bridge may only reach an allowlist (api.anthropic.com +
// configured hosts); everything else — including cloud metadata 169.254/16 — is
// dropped. Rules are scoped to the jail subnet, so other containers are untouched.
import { execFileSync } from 'node:child_process';
import dnsp from 'node:dns/promises';

export type EgressMode = 'bridge' | 'none' | 'jail';

const NETWORK = process.env.SENTINEL_JAIL_NETWORK ?? 'sentinel-jail';
const SUBNET = process.env.SENTINEL_JAIL_SUBNET ?? '172.31.99.0/24';
const COMMENT = 'sentinel-jail';
const ALWAYS_ALLOW = ['api.anthropic.com'];

export function egressMode(): EgressMode {
  const m = (process.env.SENTINEL_EGRESS ?? 'bridge') as EgressMode;
  return m === 'none' || m === 'jail' ? m : 'bridge';
}

export function dockerNetworkArg(mode: EgressMode): string {
  if (mode === 'none') return 'none';
  if (mode === 'jail') return NETWORK;
  return 'bridge';
}

function iptables(args: string[]): void {
  execFileSync('iptables', args, { stdio: 'pipe' });
}

export function ensureJailNetwork(): void {
  try {
    execFileSync('docker', ['network', 'inspect', NETWORK], { stdio: 'pipe' });
  } catch {
    execFileSync('docker', ['network', 'create', '--driver', 'bridge', '--subnet', SUBNET, NETWORK], { stdio: 'pipe' });
  }
}

// Remove any rules we previously added (idempotent re-apply; survives IP churn).
function clearOurRules(): void {
  let out = '';
  try {
    out = execFileSync('iptables', ['-S', 'DOCKER-USER'], { encoding: 'utf8' });
  } catch {
    return;
  }
  for (const line of out.split('\n')) {
    if (line.includes(COMMENT) && line.startsWith('-A ')) {
      const spec = line.replace(/^-A /, '-D ').trim().split(/\s+/);
      try {
        iptables(spec);
      } catch {
        /* ignore */
      }
    }
  }
}

async function resolveAll(hosts: string[]): Promise<string[]> {
  const ips = new Set<string>();
  for (const h of hosts) {
    // Resolve a few times to widen a CDN's rotating A-record set.
    for (let i = 0; i < 3; i++) {
      try {
        (await dnsp.resolve4(h)).forEach((ip) => ips.add(ip));
      } catch {
        /* ignore */
      }
    }
  }
  return [...ips];
}

export async function applyJail(extraHosts: string[] = []): Promise<{ network: string; subnet: string; allowedIPs: string[] }> {
  ensureJailNetwork();
  const allowedIPs = await resolveAll([...new Set([...ALWAYS_ALLOW, ...extraHosts])]);
  clearOurRules();

  const C = ['-m', 'comment', '--comment', COMMENT];
  // Inserted at position 1 each time, so the final top-to-bottom order is:
  //   [established/related RETURN] [allow each IP RETURN] [DROP everything from subnet]
  iptables(['-I', 'DOCKER-USER', '1', '-s', SUBNET, '-j', 'DROP', ...C]);
  for (const ip of allowedIPs) iptables(['-I', 'DOCKER-USER', '1', '-s', SUBNET, '-d', ip, '-j', 'RETURN', ...C]);
  iptables(['-I', 'DOCKER-USER', '1', '-s', SUBNET, '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'RETURN', ...C]);

  return { network: NETWORK, subnet: SUBNET, allowedIPs };
}

export function teardownJail(): void {
  clearOurRules();
}
