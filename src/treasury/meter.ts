// Meter — per-turn telemetry into a JSONL ledger + a rolling budget_state.
// On the subscription, total_cost_usd is informational and the AUTHORITATIVE signal
// is the rate-limit bucket; on API it's the cost ledger. guard() is the pre-turn gate.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RUNTIME_DIR = process.env.SENTINEL_RUNTIME_DIR ?? path.join(ROOT, '.runtime');
const METER_DIR = path.join(RUNTIME_DIR, 'meter');
const LEDGER = path.join(METER_DIR, 'ledger.jsonl');
const STATE = path.join(METER_DIR, 'budget_state.json');
const BUDGET_USD = process.env.SENTINEL_BUDGET_USD ? Number(process.env.SENTINEL_BUDGET_USD) : null;

export interface TurnMeter {
  turnId: string;
  ts: string;
  surface: string;
  model: string;
  authKind?: string;
  costUSD?: number;
  usage?: any;
  rateLimit?: any;
}

interface BudgetState {
  cumulativeUSD: number;
  turns: number;
  latestRateLimit?: any;
}

function readState(): BudgetState {
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch {
    return { cumulativeUSD: 0, turns: 0 };
  }
}

export function record(m: TurnMeter): void {
  try {
    fs.mkdirSync(METER_DIR, { recursive: true });
    fs.appendFileSync(LEDGER, JSON.stringify(m) + '\n');
    const s = readState();
    s.cumulativeUSD += m.costUSD ?? 0;
    s.turns += 1;
    if (m.rateLimit) s.latestRateLimit = m.rateLimit;
    fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
  } catch {
    /* never throw from metering */
  }
}

export function guard(): { allowed: boolean; reason?: string } {
  const s = readState();
  // Authoritative on the sub: a rejected rate-limit bucket.
  const rl = s.latestRateLimit;
  if (rl && (rl.status === 'rejected' || rl.allowed === false)) {
    return { allowed: false, reason: `rate limit reached (${rl.rateLimitType ?? 'bucket'})` };
  }
  // Cost cap (meaningful on the API path; informational on the sub).
  if (BUDGET_USD != null && s.cumulativeUSD >= BUDGET_USD) {
    return { allowed: false, reason: `budget cap $${BUDGET_USD} reached (spent $${s.cumulativeUSD.toFixed(4)})` };
  }
  return { allowed: true };
}

export function budgetView(): BudgetState {
  return readState();
}
