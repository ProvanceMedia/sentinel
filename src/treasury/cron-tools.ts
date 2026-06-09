// Mediated cron tools — the boxed agent DECLARES scheduling intent; the host owns
// the JobStore + actuation. Registered as internal mediated tools.
import { registerInternalTool } from '../broker/index';
import * as store from './job-store';

export function registerCronTools(): void {
  registerInternalTool(
    {
      name: 'sentinel_cron_create',
      description:
        'Schedule a job: a prompt to run later. One-off (runInSeconds), simple repeat (everySeconds), or a cron expression (cron, e.g. "30 6 * * 1-5" = 06:30 on weekdays). Optionally deliver the result to a Slack channel/user (deliverTo). Choose `model` by the job\'s load: simple/high-frequency → claude-haiku-4-5; general/moderate → claude-sonnet-4-6 (balanced); infrequent + reasoning-heavy → claude-opus-4-8; omit to inherit the base model. Set `timezone` (IANA, e.g. Europe/London) to resolve the cron in a specific zone; otherwise the server default applies. Returns the job id.',
      params: {
        prompt: { type: 'string', description: 'what the scheduled run should do (a full instruction to yourself)' },
        runInSeconds: { type: 'number', description: 'delay before a one-off run', optional: true },
        everySeconds: { type: 'number', description: 'simple repeat interval in seconds', optional: true },
        cron: { type: 'string', description: 'cron expression (5 fields); takes precedence over everySeconds', optional: true },
        deliverTo: { type: 'string', description: 'Slack channel id (C…) or user id (U…) to post the result to', optional: true },
        model: { type: 'string', description: 'model: claude-haiku-4-5 (simple/frequent) | claude-sonnet-4-6 (balanced) | claude-opus-4-8 (reasoning-heavy); omit for the default', optional: true },
        description: { type: 'string', description: 'short human label', optional: true },
        timezone: { type: 'string', description: 'IANA timezone for the cron, e.g. Europe/London or America/New_York; omit to use the server default', optional: true },
      },
    },
    async (args) => {
      const cron = args.cron ? String(args.cron) : undefined;
      const tz = args.timezone !== undefined ? String(args.timezone) : undefined;
      if (tz && !store.isValidTz(tz)) return { ok: false, error: `invalid timezone "${tz}" — use an IANA name like Europe/London` };
      const id = store.create({
        prompt: String(args.prompt ?? ''),
        cron,
        runAt: cron ? undefined : Date.now() + Number(args.runInSeconds ?? 0) * 1000,
        intervalMs: args.everySeconds ? Number(args.everySeconds) * 1000 : undefined,
        deliverTo: args.deliverTo ? String(args.deliverTo) : undefined,
        model: args.model ? String(args.model) : undefined,
        description: args.description ? String(args.description) : undefined,
        tz,
      });
      const j = store.get(id);
      const when = j?.runAt ? ` — next run ${store.formatInTz(j.runAt, j.tz)}` : '';
      return { ok: true, data: `scheduled job ${id}${args.model ? ` on ${args.model}` : ''}${when}` };
    },
  );

  registerInternalTool(
    { name: 'sentinel_cron_list', description: 'List your scheduled jobs (id, schedule, timezone, enabled, next run). Call this to answer what is scheduled — and state run times in the job\'s local timezone (nextRunLocal), not UTC.', params: {} },
    async () => ({
      ok: true,
      data: store.list().map((j) => ({
        id: j.id,
        description: j.description,
        schedule: j.cron ?? (j.intervalMs ? `every ${Math.round(j.intervalMs / 1000)}s` : 'one-off'),
        timezone: j.tz ?? store.DEFAULT_TZ,
        enabled: j.enabled,
        deliverTo: j.deliverTo,
        model: j.model ?? '(default)',
        nextRun: j.runAt ? new Date(j.runAt).toISOString() : null, // UTC ISO
        nextRunLocal: j.runAt ? store.formatInTz(j.runAt, j.tz) : null, // in the job's timezone — state this to the user
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
    {
      name: 'sentinel_cron_update',
      description:
        'Edit an existing job in place by id — no need to cancel and recreate. Pass the id plus only the fields to change: prompt, cron, everySeconds, timezone, deliverTo, model, description, or enabled (false to pause, true to resume). Changing cron, everySeconds or timezone reschedules the next run. Get ids from sentinel_cron_list.',
      params: {
        id: { type: 'string', description: 'the job id from sentinel_cron_list' },
        prompt: { type: 'string', description: 'new instruction for the run', optional: true },
        cron: { type: 'string', description: 'new cron expression (5 fields); reschedules the next run', optional: true },
        everySeconds: { type: 'number', description: 'new simple repeat interval in seconds; reschedules the next run', optional: true },
        deliverTo: { type: 'string', description: 'new Slack channel id (C…) or user id (U…)', optional: true },
        model: { type: 'string', description: 'new model: claude-haiku-4-5 | claude-sonnet-4-6 | claude-opus-4-8', optional: true },
        description: { type: 'string', description: 'new short human label', optional: true },
        enabled: { type: 'boolean', description: 'false to pause the job, true to resume', optional: true },
        timezone: { type: 'string', description: 'new IANA timezone for the cron (e.g. Europe/London); reschedules the next run', optional: true },
      },
    },
    async (args) => {
      const id = String(args.id ?? '');
      const job = store.get(id);
      if (!job) return { ok: false, error: `no job with id "${id}" — call sentinel_cron_list for valid ids` };
      const newTz = args.timezone !== undefined ? String(args.timezone) : undefined;
      if (newTz && !store.isValidTz(newTz)) return { ok: false, error: `invalid timezone "${newTz}" — use an IANA name like Europe/London` };
      const effectiveTz = newTz ?? job.tz;
      const patch: Partial<store.Job> = {};
      if (args.prompt !== undefined) patch.prompt = String(args.prompt);
      if (args.deliverTo !== undefined) patch.deliverTo = String(args.deliverTo);
      if (args.model !== undefined) patch.model = String(args.model);
      if (args.description !== undefined) patch.description = String(args.description);
      if (newTz !== undefined) patch.tz = newTz;
      if (args.cron !== undefined) {
        patch.cron = String(args.cron);
        patch.intervalMs = undefined;
        patch.runAt = store.nextCron(String(args.cron), Date.now(), effectiveTz);
      } else if (args.everySeconds !== undefined) {
        patch.intervalMs = Number(args.everySeconds) * 1000;
        patch.cron = undefined;
        patch.runAt = Date.now() + Number(args.everySeconds) * 1000;
      } else if (newTz !== undefined && job.cron) {
        // timezone changed without a new cron: re-resolve the existing schedule in the new zone.
        patch.runAt = store.nextCron(job.cron, Date.now(), effectiveTz);
      }
      if (args.enabled !== undefined) {
        patch.enabled = Boolean(args.enabled);
        // Re-enabling a cron job: refresh the next run so a stale past runAt doesn't fire it instantly.
        if (patch.enabled && patch.runAt === undefined && job.cron) patch.runAt = store.nextCron(job.cron, Date.now(), effectiveTz);
      }
      store.update(id, patch);
      const j = store.get(id)!;
      return { ok: true, data: `updated job ${id}${j.runAt ? ` — next run ${store.formatInTz(j.runAt, j.tz)}` : ''}` };
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
