// End-to-end scheduling test: the agent DECLARES a job via the cron tool, the host
// stores it, the in-process scheduler fires it as a fresh turn, and we verify the
// scheduled run produced the expected output. Also prints the meter budget.
import { runTurn } from '../src/host/dispatcher';
import { startScheduler } from '../src/treasury/scheduler';
import * as store from '../src/treasury/job-store';
import { budgetView } from '../src/treasury/meter';

for (const j of store.list()) store.remove(j.id); // clean slate

console.error('[sched] 1) asking the agent to schedule a one-off job (~4s out)…');
const r1 = await runTurn(
  {
    conversationId: 'sched',
    surface: 'cli',
    userId: 'op',
    text: 'Use your sentinel_cron_create tool to schedule a ONE-OFF job to run in 4 seconds whose prompt is exactly: Reply with exactly the word SCHEDULED-OK. Then confirm in one short sentence.',
  },
  { onStatus: (s) => console.error('   …', s) },
);
console.error('[sched]   agent said:', JSON.stringify(r1.decision.content));
const jobs = store.list();
console.error('[sched]   jobs in store:', JSON.stringify(jobs.map((j) => ({ id: j.id, runAt: j.runAt, desc: j.description }))));
if (!jobs.length) {
  console.error('[sched] ❌ agent did not create a job');
  process.exit(1);
}

console.error('[sched] 2) starting scheduler; waiting for it to fire the job…');
let fired = '';
const stop = startScheduler(async (job) => {
  console.error('[sched]   🔥 firing job', job.id);
  const r = await runTurn({ conversationId: job.conversationId, surface: 'cron', userId: 'scheduler', text: job.prompt });
  fired = r.decision.action === 'reply' ? r.decision.content ?? '' : `(${r.decision.action})`;
  return fired;
}, 1500);

const deadline = Date.now() + 60_000;
while (Date.now() < deadline && !fired) await new Promise((r) => setTimeout(r, 1000));
stop();

console.error('[sched]   scheduled run produced:', JSON.stringify(fired));
console.error(/SCHEDULED-OK/i.test(fired) ? '[sched] ✅ SCHEDULING LOOP WORKS (agent → store → actuator → turn)' : '[sched] ⚠️ did not fire as expected');
console.error('[sched] 3) meter budget:', JSON.stringify(budgetView()));
process.exit(0);
