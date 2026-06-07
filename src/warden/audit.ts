// Append-only, ALLOWLIST-redacted audit log. We log only known-safe fields, so
// an unexpected field can never leak a secret. Never throws (audit must not break
// a turn).
import fs from 'node:fs';
import path from 'node:path';

const ALLOW_FIELDS = [
  'ts',
  'turnId',
  'conversationId',
  'surface',
  'userId',
  'event',
  'tool',
  'status',
  'model',
  'subtype',
  'authOk',
  'costUSD',
  'stopped',
  'reason',
];

export function audit(dir: string, record: Record<string, unknown>): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const safe: Record<string, unknown> = {};
    for (const k of ALLOW_FIELDS) if (k in record) safe[k] = record[k];
    fs.appendFileSync(path.join(dir, 'audit.jsonl'), JSON.stringify(safe) + '\n', { mode: 0o600 });
  } catch {
    /* never throw from audit */
  }
}
