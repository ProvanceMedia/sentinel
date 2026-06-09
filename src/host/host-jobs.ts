// Host-side scheduled jobs — deterministic automation that needs NO agent/LLM
// (pollers, webhook relays, reconcilers). Modules live in the personal layer
// (personal/host-jobs/*.mjs); each default-exports { id, cron|intervalMs, tz?, run(ctx) }.
//
// These run IN the daemon with full host privileges (vault access) — they are
// operator-authored TRUSTED code, NOT the sandboxed agent. Use the agent + cron tools
// for anything that needs reasoning; use a host-job for mechanical, secret-bearing work
// you want kept entirely host-side (e.g. "poll a CRM, fire a webhook"). Secrets reach
// them only through ctx.secret() — never the agent.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { nextCron } from '../treasury/job-store';
import { getSecret } from '../broker/vault';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = process.env.SENTINEL_HOSTJOBS_DIR ?? path.join(ROOT, 'personal/host-jobs');

export interface HostJob {
  id: string;
  cron?: string; // 5-field cron (resolved in `tz`)
  intervalMs?: number; // simple repeat; ignored if `cron` is set
  tz?: string;
  run: (ctx: HostJobCtx) => Promise<unknown>;
}
export interface HostJobCtx {
  secret: (key: string) => string | undefined;
  log: (msg: string) => void;
}

/** Load + schedule personal host-jobs. No-op if the directory is absent (clean default). */
export async function startHostJobs(tickMs = 30_000): Promise<() => void> {
  if (!fs.existsSync(DIR)) return () => {};
  const entries: { job: HostJob; nextAt: number }[] = [];
  for (const f of fs.readdirSync(DIR).filter((f) => f.endsWith('.mjs') || f.endsWith('.js'))) {
    try {
      const mod: any = await import(pathToFileURL(path.join(DIR, f)).href);
      const job: HostJob = mod.default ?? mod.job ?? mod;
      if (!job?.id || typeof job.run !== 'function') {
        console.error(`[host-jobs] ${f}: not a valid host-job (needs { id, run })`);
        continue;
      }
      const nextAt = job.cron ? nextCron(job.cron, Date.now(), job.tz) : Date.now() + (job.intervalMs ?? 60_000);
      entries.push({ job, nextAt });
      console.error(`[host-jobs] loaded ${job.id} (${job.cron ? `cron ${job.cron}` : `every ${Math.round((job.intervalMs ?? 0) / 1000)}s`})`);
    } catch (e: any) {
      console.error(`[host-jobs] failed to load ${f}:`, e?.message ?? e);
    }
  }
  if (!entries.length) return () => {};

  const ctx: HostJobCtx = { secret: getSecret, log: (m) => console.error(`[host-jobs] ${m}`) };
  let running = false;
  const timer = setInterval(async () => {
    if (running) return; // no overlapping sweeps
    running = true;
    try {
      const now = Date.now();
      for (const e of entries) {
        if (e.nextAt > now) continue;
        // advance the schedule BEFORE running, so a slow run can't double-fire
        e.nextAt = e.job.cron ? nextCron(e.job.cron, now, e.job.tz) : now + (e.job.intervalMs ?? 60_000);
        try {
          await e.job.run(ctx);
        } catch (err: any) {
          console.error(`[host-jobs] ${e.job.id} error:`, err?.message ?? err);
        }
      }
    } finally {
      running = false;
    }
  }, tickMs);
  if (typeof (timer as any).unref === 'function') (timer as any).unref();
  return () => clearInterval(timer);
}
