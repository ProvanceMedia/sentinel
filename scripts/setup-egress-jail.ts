// Set up (or tear down) the egress jail. Run as ROOT on the host.
//   apply:    tsx scripts/setup-egress-jail.ts apply [extra,allow,hosts]
//   teardown: tsx scripts/setup-egress-jail.ts teardown
// After apply, run runners with SENTINEL_EGRESS=jail. Re-run apply periodically
// (cron) to refresh allowlisted IPs as the CDN rotates.
import { applyJail, teardownJail } from '../src/warden/egress';

const cmd = process.argv[2] ?? 'apply';
const extra = (process.argv[3] ?? '').split(',').map((s) => s.trim()).filter(Boolean);

if (cmd === 'teardown') {
  teardownJail();
  console.error('[egress] jail rules removed.');
  process.exit(0);
}

const res = await applyJail(extra);
console.error(`[egress] jail applied: network=${res.network} subnet=${res.subnet}`);
console.error(`[egress] allowlisted ${res.allowedIPs.length} IP(s): ${res.allowedIPs.join(', ')}`);
console.error('[egress] run runners with SENTINEL_EGRESS=jail. Re-run "apply" to refresh IPs.');
process.exit(0);
