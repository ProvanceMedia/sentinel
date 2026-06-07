// Mediated cron tools — the boxed agent DECLARES scheduling intent; the host owns
// the JobStore + actuation. Registered as internal mediated tools.
import { registerInternalTool } from '../broker/index';
import * as store from './job-store';

export function registerCronTools(): void {
  registerInternalTool(
    {
      name: 'sentinel_cron_create',
      description:
        'Schedule a job: a prompt to run later. One-off (runInSeconds), simple repeat (everySeconds), or a cron expression (cron, e.g. "30 6 * * 1-5" = 06:30 on weekdays). Optionally deliver the result to a Slack channel/user (deliverTo). Returns the job id.',
      params: {
        prompt: { type: 'string', description: 'what the scheduled run should do (a full instruction to yourself)' },
        runInSeconds: { type: 'number', description: 'delay before a one-off run', optional: true },
        everySeconds: { type: 'number', description: 'simple repeat interval in seconds', optional: true },
        cron: { type: 'string', description: 'cron expression (5 fields); takes precedence over everySeconds', optional: true },
        deliverTo: { type: 'string', description: 'Slack channel id (C…) or user id (U…) to post the result to', optional: true },
        description: { type: 'string', description: 'short human label', optional: true },
      },
    },
    async (args) => {
      const cron = args.cron ? String(args.cron) : undefined;
      const id = store.create({
        prompt: String(args.prompt ?? ''),
        cron,
        runAt: cron ? undefined : Date.now() + Number(args.runInSeconds ?? 0) * 1000,
        intervalMs: args.everySeconds ? Number(args.everySeconds) * 1000 : undefined,
        deliverTo: args.deliverTo ? String(args.deliverTo) : undefined,
        description: args.description ? String(args.description) : undefined,
      });
      return { ok: true, data: `scheduled job ${id}` };
    },
  );

  registerInternalTool(
    { name: 'sentinel_cron_list', description: 'List your scheduled jobs (id, schedule, enabled, next run). Call this to answer what is scheduled.', params: {} },
    async () => ({
      ok: true,
      data: store.list().map((j) => ({
        id: j.id,
        description: j.description,
        schedule: j.cron ?? (j.intervalMs ? `every ${Math.round(j.intervalMs / 1000)}s` : 'one-off'),
        enabled: j.enabled,
        deliverTo: j.deliverTo,
        nextRun: j.runAt ? new Date(j.runAt).toISOString() : null,
        source: j.source,
        prompt: j.prompt, // what the job actually does — so you can explain any cron
      })),
    }),
  );

  registerInternalTool(
    {
      name: 'sentinel_cron_run',
      description: 'Run a scheduled job NOW (use this for "run/trigger X now"). Returns the job\'s instructions — execute them immediately using your tools, then reply with the result. There is no other trigger; YOU run it.',
      params: { id: { type: 'string', description: 'the job id from sentinel_cron_list' } },
    },
    async (args) => {
      const job = store.get(String(args.id ?? ''));
      if (!job) return { ok: false, error: `no job with id "${args.id}" — call sentinel_cron_list for valid ids` };
      return {
        ok: true,
        data: `RUN THIS NOW. Carry out the following instructions step by step using your tools, then reply with the result (this is the "${job.description ?? job.id}" job):\n\n${job.prompt}`,
      };
    },
  );

  registerInternalTool(
    { name: 'sentinel_cron_cancel', description: 'Cancel a scheduled job by id.', params: { id: { type: 'string', description: 'the job id' } } },
    async (args) => {
      store.remove(String(args.id ?? ''));
      return { ok: true, data: 'cancelled' };
    },
  );
}
