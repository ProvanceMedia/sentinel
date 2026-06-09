// Launches the agent-runner connected to a host control socket.
// Two transports behind one interface: a local subprocess (dev) and a Docker
// container (the real per-turn isolation model). The runner code is identical.
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { egressMode, dockerNetworkArg } from '../warden/egress';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const RUNNER_TS = path.resolve(__dirname, '../runner/agent-runner.ts');
const TSX_BIN = path.resolve(ROOT, 'node_modules/.bin/tsx');

export interface LaunchSpec {
  runId: string;
  socketPathHost: string; // host filesystem path of the UDS
  env: Record<string, string>; // curated env from AuthResolver (token in, API key blanked)
  sessionDir: string; // host per-session dir (persists ~/.claude transcript + cwd)
  image?: string;
}

export interface RunnerHandle {
  kill(): void;
  onExit(cb: (code: number | null) => void): void;
}

function mkHandle(child: ChildProcess, killer?: () => void): RunnerHandle {
  return {
    kill() {
      if (killer) killer();
      else
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
    },
    onExit(cb) {
      child.on('exit', cb);
    },
  };
}

// --- Local subprocess (dev / fast proof; NO isolation) ---
export function launchLocal(spec: LaunchSpec): RunnerHandle {
  const child = spawn(TSX_BIN, [RUNNER_TS], {
    env: {
      ...spec.env,
      SENTINEL_CONTROL_SOCK: spec.socketPathHost,
      SENTINEL_RUN_ID: spec.runId,
      HOME: spec.sessionDir,
      CLAUDE_CONFIG_DIR: path.join(spec.sessionDir, '.claude'),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  return mkHandle(child);
}

// --- Docker container (the real per-turn boundary; egress jail via SENTINEL_EGRESS) ---
export function launchDocker(spec: LaunchSpec): RunnerHandle {
  const image = spec.image ?? process.env.SENTINEL_IMAGE ?? 'sentinel-runner:dev';
  const runDir = path.dirname(spec.socketPathHost);
  const sockName = path.basename(spec.socketPathHost);
  const name = `sentinel-${spec.runId}`;

  const mode = egressMode();
  const args = [
    'run',
    '--rm',
    '--name',
    name,
    '--user',
    '10001:10001',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--read-only', // rootfs read-only; only the mounts + tmpfs below are writable
    '--tmpfs',
    '/tmp',
    '--pids-limit',
    '512',
    '--memory',
    '2g',
    '--network',
    dockerNetworkArg(mode), // bridge (default) | none | jail (host nftables step)
    // Reach the host auth-proxy (HTTPS_PROXY) at the bridge gateway. container->gateway
    // is host-bound (not the FORWARD jail), so this works in every egress mode.
    '--add-host',
    'host.docker.internal:host-gateway',
    // Docker socket is NEVER mounted (would be a host breakout). Asserted below.
    '-v',
    `${runDir}:/run/sentinel:rw`,
    '-v',
    `${spec.sessionDir}:/session:rw`,
    '-e',
    `SENTINEL_CONTROL_SOCK=/run/sentinel/${sockName}`,
    '-e',
    `SENTINEL_RUN_ID=${spec.runId}`,
    '-e',
    `HOME=/session`,
    '-e',
    `CLAUDE_CONFIG_DIR=/session/.claude`,
    // The in-container Claude CLI's non-essential phone-home (telemetry, error reporting,
    // auto-update) can't pass the auth-proxy anyway; turn it off so it stops generating
    // proxy DENY noise for hosts like datadog.
    '-e',
    `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`,
  ];
  for (const [k, v] of Object.entries(spec.env)) args.push('-e', `${k}=${v}`);
  args.push(image);

  // Hard invariant: the docker socket must never be mounted into an agent box.
  if (args.some((a) => /docker\.sock/.test(a))) {
    throw new Error('refusing to launch: docker socket mount detected in container args');
  }

  const child = spawn('docker', args, { stdio: ['ignore', 'inherit', 'inherit'] });
  // Hard stop = kill the container (reaps the SDK subprocess + every tool child atomically).
  return mkHandle(child, () => {
    try {
      spawn('docker', ['kill', name], { stdio: 'ignore' });
    } catch {
      /* ignore */
    }
  });
}
