// Harness: start a long-running turn, request stop mid-flight, verify it stops
// fast (container killed) rather than running to completion.
import { runTurn, requestStop } from '../src/host/dispatcher';

const conv = 'stoptest';
const started = Date.now();
console.error('[harness] starting a long turn (bash sleep 30)…');

const p = runTurn(
  {
    conversationId: conv,
    surface: 'cli',
    userId: 'op',
    text: 'Use the Bash tool to run exactly `sleep 30 && echo FINISHED`. Do not reply until it completes.',
  },
  { onStatus: (s) => console.error('  …', s) },
);

setTimeout(() => {
  console.error(`[harness] +${((Date.now() - started) / 1000).toFixed(1)}s requesting stop…`);
  console.error('[harness] stop accepted:', requestStop(conv));
}, 6000);

try {
  const r = await p;
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.error(`[harness] turn returned after ${secs}s → subtype=${r.subtype} stopped=${r.stopped} action=${r.decision.action}`);
  console.error(secs < '20' && r.stopped ? '[harness] ✅ STOP WORKED (returned well before the 30s sleep)' : '[harness] ⚠️ check timing');
} catch (e: any) {
  console.error('[harness] turn rejected:', e?.message ?? e);
}
process.exit(0);
