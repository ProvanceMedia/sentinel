// `connect` — add an API connection from the terminal (no browser, no tunnel). Prompts
// for host + scheme + key, writes the vault + auth-hosts host-side, and SIGHUPs the
// running daemon so the agent can use it immediately. Run on the box: npm run connect
import '../env';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { writeConnection, writeSecretOnly } from '../host/connections';

// Hot-reload the running daemon (vault + auth-hosts) so the agent picks up the change.
function signalDaemon(): void {
  try {
    execFileSync('systemctl', ['kill', '-s', 'HUP', 'sentinel.service'], { stdio: 'ignore' });
    console.log('🔄 Reloaded the live daemon — no restart needed.');
  } catch {
    try {
      execFileSync('pkill', ['-HUP', '-f', 'src/main.ts'], { stdio: 'ignore' });
      console.log('🔄 Signalled the daemon to reload.');
    } catch {
      console.log('ℹ️  No running daemon to signal — it will be available next time sentineld starts.');
    }
  }
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });

// A line queue so prompts work whether input is interactive or piped (piped lines can
// arrive faster than the next question is set up — queue them so none are lost).
const queue: string[] = [];
const waiters: ((l: string) => void)[] = [];
rl.on('line', (l) => {
  const w = waiters.shift();
  if (w) w(l);
  else queue.push(l);
});
function nextLine(): Promise<string> {
  return new Promise((res) => {
    const l = queue.shift();
    if (l !== undefined) res(l);
    else waiters.push(res);
  });
}
async function ask(q: string, def = ''): Promise<string> {
  process.stdout.write(def ? `${q} [${def}]: ` : `${q}: `);
  const a = await nextLine();
  return a.trim() || def;
}
async function askHidden(q: string): Promise<string> {
  process.stdout.write(`${q}: `);
  const rlAny = rl as any;
  const orig = rlAny._writeToOutput;
  rlAny._writeToOutput = () => {}; // mute echo of the secret
  const a = await nextLine();
  rlAny._writeToOutput = orig;
  process.stdout.write('\n');
  return a;
}

const SCHEMES: Record<string, string> = { '1': 'bearer', '2': 'header', '3': 'query', '4': 'basic' };

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // `connect --name ACME_KEY` — just stash a key in the vault (no host). The agent wires it
  // up later via sentinel_connect once you give it the host + a test path.
  if (argv[0] === '--name') {
    const name = (argv[1]?.trim() || (await ask('vault key name (e.g. ACME_KEY)'))).trim();
    if (!name) {
      console.error('a key name is required');
      process.exit(1);
    }
    const secret = await askHidden('paste the secret / API key');
    rl.close();
    if (!secret) {
      console.error('secret is required');
      process.exit(1);
    }
    writeSecretOnly(name, secret);
    console.log(`\n✅ Stored ${name} in the vault (no host wired yet).`);
    signalDaemon();
    console.log(`\nNow just tell the agent, e.g.:\n  "set up the Acme API — host api.acme.com, key ${name}, test path v1/me"\nand it'll auto-detect the auth and wire it.`);
    return;
  }

  // Fast path: `connect api.acme.com` → Bearer + auto key name, just asks for the secret.
  // No args → full interactive (pick scheme, name the key, add a note).
  const argHost = argv[0]?.trim();
  console.log('\n🛰️  Add a connection — the key is stored host-side and never reaches the agent.\n');

  const host = argHost || (await ask('API host (e.g. api.acme.com)'));
  if (!host) {
    console.error('host is required');
    process.exit(1);
  }
  let scheme = 'bearer';
  let headerName, queryParam, basicPassword;
  if (!argHost) {
    console.log('Auth scheme:  1) Bearer token   2) Custom header   3) Query param   4) Basic');
    scheme = SCHEMES[await ask('scheme number', '1')] ?? 'bearer';
    if (scheme === 'header') headerName = await ask('header name', 'X-API-Key');
    if (scheme === 'query') queryParam = await ask('query param name', 'api_key');
    if (scheme === 'basic') basicPassword = await ask('basic password (blank is fine)', '');
  }
  const suggested = ((host.split('.').slice(-2, -1)[0] || host).toUpperCase().replace(/[^A-Z0-9]/g, '') || 'API') + '_KEY';
  const vaultKey = argHost ? suggested : await ask('vault key name', suggested);
  const secret = await askHidden('paste the secret / API key');
  const note = argHost ? '' : await ask('note (what is it, optional)', '');
  rl.close();

  if (!secret) {
    console.error('secret is required');
    process.exit(1);
  }

  const h = writeConnection({ host, scheme, vaultKey, secret, headerName, queryParam, basicPassword, note });
  console.log(`\n✅ Connected ${h}  (scheme: ${scheme}, vault key: ${vaultKey})`);
  signalDaemon();
}

main().catch((e) => {
  console.error('error:', e?.message ?? e);
  process.exit(1);
});
