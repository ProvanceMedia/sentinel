// OSS extraction dry-run: verify the generic core ships cleanly when personal/ is
// dropped. (1) no src/ file imports from personal/, (2) example configs present,
// (3) core has no hard dependency on a personal path at module scope.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const fail = (m: string) => {
  console.error('  ❌', m);
  failures++;
};
const ok = (m: string) => console.error('  ✅', m);

// 1) no imports from personal/ in src/
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}
let personalImports = 0;
for (const f of walk(path.join(ROOT, 'src'))) {
  const c = fs.readFileSync(f, 'utf8');
  if (/from ['"][^'"]*personal\//.test(c) || /import\(['"][^'"]*personal\//.test(c)) {
    fail(`${path.relative(ROOT, f)} imports from personal/`);
    personalImports++;
  }
}
if (personalImports === 0) ok('no src/ imports from personal/');

// 2) example configs present
for (const rel of ['config/generic/services.policy.example.json', 'config/generic/persona.example/persona.json', 'config/generic/persona.example/identity.md']) {
  if (fs.existsSync(path.join(ROOT, rel))) ok(`ships ${rel}`);
  else fail(`missing ${rel}`);
}

// 3) check-core-clean passes
const res = spawnSync('node_modules/.bin/tsx', ['scripts/check-core-clean.ts'], { cwd: ROOT, encoding: 'utf8' });
if (res.status === 0) ok('check-core-clean passes');
else fail('check-core-clean failed: ' + (res.stderr || res.stdout));

console.error(`\noss-extract-check: ${failures === 0 ? '✅ core is cleanly extractable (drop personal/, ship config/generic)' : `❌ ${failures} issue(s)`}`);
process.exit(failures === 0 ? 0 : 1);
