// Durable job store — the HOST owns scheduling state (the boxed agent only declares
// intent via cron tools). A single JSON file; idempotent fires are the scheduler's
// job. Jobs can be one-off (runAt), interval (intervalMs), or cron-expression (cron).
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CronExpressionParser } from 'cron-parser';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RUNTIME_DIR = process.env.SENTINEL_RUNTIME_DIR ?? path.join(ROOT, '.runtime');
const JOBS_DIR = path.join(RUNTIME_DIR, 'jobs');
const JOBS_FILE = path.join(JOBS_DIR, 'jobs.json');
// Default timezone for cron schedules. Per-job `tz` overrides this; both fall back here.
export const DEFAULT_TZ = process.env.SENTINEL_TZ || process.env.TZ || 'UTC';

export interface Job {
  id: string;
  prompt: string;
  conversationId: string;
  runAt?: number; // epoch ms of next run
  intervalMs?: number; // simple repeat
  cron?: string; // cron expression (5 fields), takes precedence over intervalMs
  deliverTo?: string; // Slack channel id (C…/G…) or user id (U…) to post the result
  enabled: boolean;
  createdAt: number;
  lastRun?: number;
  lastResult?: string;
  description?: string;
  model?: string; // per-job model override (e.g. claude-haiku-4-5); falls back to SENTINEL_MODEL
  tz?: string; // per-job IANA timezone for the cron (e.g. America/New_York); falls back to DEFAULT_TZ
  source?: 'config' | 'agent'; // 'config' = declared in jobs.json, 'agent' = created in chat
}

/** Next run time (epoch ms) for a cron expression, after `after`, resolved in IANA `tz`. */
export function nextCron(expr: string, after = Date.now(), tz: string = DEFAULT_TZ): number {
  return CronExpressionParser.parse(expr, { tz: tz || DEFAULT_TZ, currentDate: new Date(after) }).next().getTime();
}

/** Render a timestamp in `tz` for human/agent-facing schedules, e.g. "9 Jun 2026, 17:00 Europe/London". */
export function formatInTz(ms: number, tz: string = DEFAULT_TZ): string {
  const zone = tz || DEFAULT_TZ;
  return `${new Date(ms).toLocaleString('en-GB', { timeZone: zone, dateStyle: 'medium', timeStyle: 'short' })} ${zone}`;
}

/** True if `tz` is a valid IANA timezone name. */
export function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function load(): Job[] {
  try {
    return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
  } catch {
    return [];
  }
}
function saveAll(jobs: Job[]): void {
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
}

export interface JobInput {
  prompt: string;
  runAt?: number;
  intervalMs?: number;
  cron?: string;
  deliverTo?: string;
  description?: string;
  model?: string;
  tz?: string;
  source?: 'config' | 'agent';
}

export function create(input: JobInput): string {
  const id = crypto.randomUUID().slice(0, 8);
  upsert({ id, source: 'agent', ...input });
  return id;
}

/** Create or update a job by id (used by the declarative jobs config). */
export function upsert(input: JobInput & { id: string; enabled?: boolean }): void {
  const jobs = load();
  const i = jobs.findIndex((j) => j.id === input.id);
  const runAt = input.cron ? nextCron(input.cron, Date.now(), input.tz) : (input.runAt ?? Date.now());
  const base: Job = {
    id: input.id,
    prompt: input.prompt,
    conversationId: `cron:${input.id}`,
    runAt,
    intervalMs: input.intervalMs,
    cron: input.cron,
    deliverTo: input.deliverTo,
    enabled: input.enabled ?? true,
    createdAt: i >= 0 ? jobs[i].createdAt : Date.now(),
    description: input.description,
    model: input.model,
    tz: input.tz,
    source: input.source ?? (i >= 0 ? jobs[i].source : 'agent'),
  };
  if (i >= 0) jobs[i] = { ...jobs[i], ...base };
  else jobs.push(base);
  saveAll(jobs);
}

export function list(): Job[] {
  return load();
}
export function get(id: string): Job | undefined {
  return load().find((j) => j.id === id);
}
export function update(id: string, patch: Partial<Job>): void {
  const jobs = load();
  const i = jobs.findIndex((j) => j.id === id);
  if (i >= 0) {
    jobs[i] = { ...jobs[i], ...patch };
    saveAll(jobs);
  }
}
export function remove(id: string): void {
  saveAll(load().filter((j) => j.id !== id));
}
export function dueJobs(now: number): Job[] {
  return load().filter((j) => j.enabled && j.runAt != null && j.runAt <= now);
}
