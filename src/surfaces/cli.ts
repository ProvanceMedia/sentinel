// CLI surface — the first runnable surface. Sends one message through the full
// host -> container -> SDK -> structured-reply pipeline and prints the result.
// Usage: pnpm sentinel "your message"   (env: SENTINEL_RUNNER_MODE=local|docker)
import '../env'; // load .env before anything reads process.env
import { runTurn, type InboundTurn } from '../host/dispatcher';

const text =
  process.argv.slice(2).join(' ') ||
  'In one short sentence, confirm whether you are running inside a sandboxed container and on the Max subscription.';

const inbound: InboundTurn = {
  conversationId: process.env.SENTINEL_CONV ?? 'cli:default',
  surface: 'cli',
  userId: 'operator',
  text,
};

const mode = process.env.SENTINEL_RUNNER_MODE ?? 'local';
const model = process.env.SENTINEL_MODEL ?? 'claude-haiku-4-5';
console.error(`[sentinel] mode=${mode} model=${model}`);
console.error(`[you] ${text}`);

try {
  const res = await runTurn(inbound, { onStatus: (s) => console.error(`  … ${s}`) });
  console.error(
    `[sentinel] auth=${res.authOk ? 'OK' : 'MISMATCH'} (${res.account?.tokenSource}/${res.account?.apiProvider}) cost~$${res.costUSD ?? 0} action=${res.decision.action}`,
  );
  if (res.decision.action === 'reply') console.log(`\n[sentinel] ${res.decision.content}`);
  else if (res.decision.action === 'react') console.log(`\n[sentinel] (reacts :${res.decision.emoji}:)`);
  else console.log(`\n[sentinel] (stayed silent)`);
  process.exit(0);
} catch (e: any) {
  console.error('[sentinel] turn failed:', e?.message ?? e);
  process.exit(1);
}
