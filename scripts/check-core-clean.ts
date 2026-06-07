// CI gate: the generic core (src/ + config/generic/) must contain NO personal
// references, so the OSS engine can be shipped by dropping personal/. Fails on any
// hit from the denylist.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = [path.join(ROOT, 'src'), path.join(ROOT, 'config/generic'), path.join(ROOT, 'config/core'), path.join(ROOT, 'scripts')];
const SELF = 'check-core-clean.ts'; // this file lists the patterns below; don't scan it

// Personal names/services, dev-environment paths, and ACTUAL token shapes (prefix +
// real chars, so the xoxb-/xapp- doc prefixes in surface code don't false-positive).
const DENY = [
  /roboquill/i, /\bstu\b/i, /\btex\b/i, /\bjasper\b/i, /hubspot/i, /starling/i, /\bocean\.io\b/i,
  /\byoda(code)?\b/i, /\/opt\/shared/,
  /xoxb-[A-Za-z0-9]{5,}/, /xapp-[A-Za-z0-9]{5,}/, /sk-ant-[A-Za-z0-9]{5,}/,
];

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

let hits = 0;
for (const dir of SCAN_DIRS) {
  for (const file of walk(dir)) {
    if (path.basename(file) === SELF) continue;
    let content = '';
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const re of DENY) {
      if (re.test(content)) {
        console.error(`❌ ${path.relative(ROOT, file)} matches ${re}`);
        hits++;
      }
    }
  }
}

if (hits === 0) console.error('✅ check-core-clean: core is free of personal references');
process.exit(hits === 0 ? 0 : 1);
