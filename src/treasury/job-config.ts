// Declarative jobs — load recurring jobs from a JSON file so you can define them
// in one place (and bulk-import them). Each entry upserts by id, so editing the
// file and restarting keeps schedules in sync. Default: personal/config/jobs.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { upsert, list, remove } from './job-store';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export interface JobSpec {
  id: string;
  prompt: string;
  cron?: string; // "30 6 * * 1-5"
  everySeconds?: number;
  deliverTo?: string; // Slack channel id (C…/G…) or user id (U…)
  description?: string;
  enabled?: boolean;
}

function jobsFile(): string {
  return process.env.SENTINEL_JOBS_FILE ?? path.join(ROOT, 'personal/config/jobs.json');
}

/** Sync the JobStore to the config file: upsert declared jobs, remove ones dropped from the file. */
export function loadJobsFromConfig(): number {
  const file = jobsFile();
  let specs: JobSpec[];
  try {
    specs = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return 0; // no config file — fine
  }
  if (!Array.isArray(specs)) return 0;

  const declaredIds = new Set<string>();
  for (const s of specs) {
    if (!s || !s.id || !s.prompt) continue;
    declaredIds.add(s.id);
    upsert({
      id: s.id,
      prompt: s.prompt,
      cron: s.cron,
      intervalMs: s.everySeconds ? s.everySeconds * 1000 : undefined,
      deliverTo: s.deliverTo,
      description: s.description,
      enabled: s.enabled ?? true,
      source: 'config',
    });
  }
  // Remove config-managed jobs that were dropped from the file (leave agent-created ones).
  for (const j of list()) {
    if (j.source === 'config' && !declaredIds.has(j.id)) remove(j.id);
  }
  return declaredIds.size;
}
