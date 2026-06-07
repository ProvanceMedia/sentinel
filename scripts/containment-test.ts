// Containment build-gate. Runs a probe inside a container with the SAME hardened
// flags + network the real runner uses, and asserts the isolation properties.
//   SENTINEL_EGRESS=bridge  -> egress checks PENDING (no jail)
//   SENTINEL_EGRESS=none    -> all egress blocked
//   SENTINEL_EGRESS=jail    -> Anthropic REACHABLE, everything else BLOCKED (the goal)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { egressMode, dockerNetworkArg } from '../src/warden/egress';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_DIR = process.env.SENTINEL_RUNTIME_DIR ?? path.join(ROOT, '.runtime');
const sessionDir = path.join(RUNTIME_DIR, 'sessions', 'containment-probe');
fs.mkdirSync(path.join(sessionDir, 'work'), { recursive: true });
fs.chmodSync(sessionDir, 0o777);
fs.writeFileSync(path.join(sessionDir, 'marker.txt'), 'this-session-only');

const mode = egressMode();
const network = dockerNetworkArg(mode);

const probe = `
const fs=require('fs');const out={};
try{fs.writeFileSync('/etc/sentinel_probe','x');out.rootfs_writable=true;}catch{out.rootfs_writable=false;}
out.host_creds_visible=fs.existsSync('/root/.claude/.credentials.json')||fs.existsSync('/etc/sentinel/secrets.env')||fs.existsSync('/host');
out.docker_sock=fs.existsSync('/var/run/docker.sock');
out.sessions_parent=fs.existsSync('/sessions');
let s=[];try{s=fs.readdirSync('/session');}catch{}out.session_contents=s;
const p=(u)=>fetch(u,{signal:AbortSignal.timeout(4000)}).then(r=>'REACHED:'+r.status).catch(e=>'BLOCKED:'+(e.code||e.name||e.message));
Promise.all([p('http://169.254.169.254/latest/meta-data/'),p('https://example.com/'),p('https://api.anthropic.com/')]).then(([m,e,a])=>{out.metadata=m;out.external=e;out.anthropic=a;console.log('PROBE:'+JSON.stringify(out));});
`;

const args = [
  'run', '--rm',
  '--user', '10001:10001',
  '--cap-drop', 'ALL',
  '--security-opt', 'no-new-privileges',
  '--read-only', '--tmpfs', '/tmp',
  '--network', network,
  '-v', `${sessionDir}:/session:rw`,
  '-e', 'HOME=/session',
  '--entrypoint', 'node',
  'sentinel-runner:dev',
  '-e', probe,
];

console.error(`[containment] running probe (egress=${mode}, network=${network})…`);
const res = spawnSync('docker', args, { encoding: 'utf8' });
const line = (res.stdout || '').split('\n').find((l) => l.startsWith('PROBE:'));
if (!line) {
  console.error('[containment] probe produced no output. stderr:', res.stderr?.slice(0, 500));
  process.exit(2);
}
const out = JSON.parse(line.slice('PROBE:'.length));

const blocked = (v: string) => String(v).startsWith('BLOCKED');
const reached = (v: string) => String(v).startsWith('REACHED');
type Pass = boolean | 'pending';

const checks: { name: string; pass: Pass; detail: string }[] = [
  { name: 'rootfs is read-only', pass: out.rootfs_writable === false, detail: `writable=${out.rootfs_writable}` },
  { name: 'host creds not visible', pass: out.host_creds_visible === false, detail: `visible=${out.host_creds_visible}` },
  { name: 'docker socket not mounted', pass: out.docker_sock === false, detail: `present=${out.docker_sock}` },
  { name: 'no shared /sessions parent', pass: out.sessions_parent === false, detail: `present=${out.sessions_parent}` },
  { name: 'only this session mounted', pass: Array.isArray(out.session_contents) && out.session_contents.includes('marker.txt'), detail: JSON.stringify(out.session_contents) },
  { name: 'cloud metadata unreachable', pass: mode === 'bridge' ? 'pending' : blocked(out.metadata), detail: out.metadata },
  { name: 'external egress blocked', pass: mode === 'bridge' ? 'pending' : blocked(out.external), detail: out.external },
  { name: 'Anthropic reachable (jail allowlist)', pass: mode === 'jail' ? reached(out.anthropic) : 'pending', detail: out.anthropic },
];

console.error('\n[containment] results:');
let failed = 0;
for (const c of checks) {
  const mark = c.pass === true ? '✅ PASS' : c.pass === 'pending' ? '⏳ PEND' : '❌ FAIL';
  if (c.pass === false) failed++;
  console.error(`  ${mark}  ${c.name}  —  ${c.detail}`);
}
console.error(`\n[containment] ${failed === 0 ? '✅ all hard checks passed' : `❌ ${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
