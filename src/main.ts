// sentineld entry — starts the enabled chat surfaces (default: slack) + the scheduler.
import './env'; // load .env before anything reads process.env
import { startSlack, type SlackSurface } from './surfaces/slack';
import { startScheduler } from './treasury/scheduler';
import { loadJobsFromConfig } from './treasury/job-config';
import { startDashboard } from './host/dashboard';
import { reloadVault } from './broker/vault';
import { loadAuthHosts } from './broker/auth-hosts';
import { runTurn } from './host/dispatcher';

const surfaces = (process.env.SENTINEL_SURFACES ?? 'slack')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

console.error(`[sentineld] mode=${process.env.SENTINEL_RUNNER_MODE ?? 'local'} model=${process.env.SENTINEL_MODEL ?? 'claude-haiku-4-5'} surfaces=${surfaces.join(', ')}`);

let slack: SlackSurface | null = null;
for (const s of surfaces) {
  if (s === 'slack') slack = await startSlack();
  else console.error(`[sentineld] unknown surface "${s}" (skipped)`);
}

// Connections dashboard (opt-in): add API keys via a local web form, hot-reloaded.
startDashboard();

// Declarative recurring jobs from personal/config/jobs.json.
const loaded = loadJobsFromConfig();
if (loaded) console.error(`[sentineld] loaded ${loaded} scheduled job(s) from config`);

// Durable mediated scheduling: the host fires due jobs as 'cron' turns and delivers
// the result to the job's deliverTo (a Slack channel/user), if set.
startScheduler(async (job) => {
  const r = await runTurn({ conversationId: job.conversationId, surface: 'cron', userId: 'scheduler', text: job.prompt, model: job.model });
  const out = r.decision.action === 'reply' ? r.decision.content ?? '' : '';
  if (job.deliverTo && out && slack) {
    await slack.deliver(job.deliverTo, out).catch((e: any) => console.error('[sentineld] deliver failed:', e?.message ?? e));
  }
  return out;
});
console.error('[sentineld] scheduler started');

console.error('[sentineld] up. Ctrl-C to stop.');

// SIGHUP → hot-reload the vault + auth-hosts (the `connect` CLI sends this after adding a connection).
process.on('SIGHUP', () => {
  reloadVault();
  loadAuthHosts();
  console.error('[sentineld] reloaded vault + auth-hosts (SIGHUP)');
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.error(`[sentineld] ${sig} — shutting down`);
    process.exit(0);
  });
}
