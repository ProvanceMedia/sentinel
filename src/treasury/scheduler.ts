// In-process cron actuator. Polls the durable JobStore and fires due jobs via the
// injected runJob (avoids a dispatcher import cycle). Idempotent: a job's next run
// is advanced/disabled BEFORE it runs, so a slow run can't double-fire.
import * as store from './job-store';
import type { Job } from './job-store';

export type RunJob = (job: Job) => Promise<string | undefined>;

export function startScheduler(runJob: RunJob, tickMs = 2000): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return; // no overlapping sweeps
    running = true;
    try {
      const due = store.dueJobs(Date.now());
      for (const job of due) {
        // advance/disable first (idempotency)
        const now = Date.now();
        if (job.cron) store.update(job.id, { runAt: store.nextCron(job.cron, now), lastRun: now });
        else if (job.intervalMs) store.update(job.id, { runAt: now + job.intervalMs, lastRun: now });
        else store.update(job.id, { enabled: false, lastRun: now });
        try {
          const out = await runJob(job);
          store.update(job.id, { lastResult: (out ?? '').slice(0, 200) });
        } catch (e: any) {
          store.update(job.id, { lastResult: `error: ${e?.message ?? e}` });
        }
      }
    } finally {
      running = false;
    }
  }, tickMs);
  // don't keep the process alive solely for the scheduler
  if (typeof (timer as any).unref === 'function') (timer as any).unref();
  return () => clearInterval(timer);
}
