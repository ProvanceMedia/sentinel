// Reflector test: run an exchange containing a durable fact with SENTINEL_REFLECT=on,
// then wait for the fire-and-forget reflection to distil it into MEMORY.md.
import fs from 'node:fs';
import path from 'node:path';
import { runTurn } from '../src/host/dispatcher';

const memDir = process.env.SENTINEL_MEMORY_DIR;
if (!memDir) {
  console.error('set SENTINEL_MEMORY_DIR to a writable dir');
  process.exit(2);
}
const memFile = path.join(memDir, 'MEMORY.md');
fs.mkdirSync(memDir, { recursive: true });
try {
  fs.rmSync(memFile, { force: true });
} catch {
  /* ignore */
}

console.error('[reflect] running an exchange with a durable fact…');
const r = await runTurn(
  {
    conversationId: 'reflect-test',
    surface: 'cli',
    userId: 'op',
    text: 'For the future: my favourite programming language is Rust, and I am building a CLI tool called Quill.',
  },
  { onStatus: (s) => console.error('  …', s) },
);
console.error('[reflect] reply:', JSON.stringify(r.decision.content));
console.error('[reflect] waiting for the background reflection to write memory…');

const deadline = Date.now() + 70_000;
while (Date.now() < deadline) {
  if (fs.existsSync(memFile) && /reflected/i.test(fs.readFileSync(memFile, 'utf8'))) break;
  await new Promise((res) => setTimeout(res, 1500));
}

const mem = fs.existsSync(memFile) ? fs.readFileSync(memFile, 'utf8') : '(none)';
console.error('[reflect] MEMORY.md:\n' + mem);
console.error(/rust|quill/i.test(mem) ? '[reflect] ✅ REFLECTOR WROTE MEMORY' : '[reflect] ⚠️ no memory written');
process.exit(0);
