// Memory search — lexical (keyword-overlap) search over the memory dir's .md
// files. Runs HOST-side (exposed to the agent as the mediated memory_search tool),
// so the container needs no sqlite/index. (FTS5/embeddings = a later upgrade.)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// The active persona directory: an explicit override, else your private
// personal/persona (if set up), else the shipped generic example.
export function personaDir(): string {
  if (process.env.SENTINEL_PERSONA_DIR) return process.env.SENTINEL_PERSONA_DIR;
  const personal = path.join(ROOT, 'personal/persona');
  try {
    if (fs.existsSync(path.join(personal, 'persona.json')) || fs.existsSync(path.join(personal, 'identity.md'))) return personal;
  } catch {
    /* ignore */
  }
  return path.join(ROOT, 'config/generic/persona.example');
}

export function memoryDir(): string {
  if (process.env.SENTINEL_MEMORY_DIR) return process.env.SENTINEL_MEMORY_DIR;
  return path.join(personaDir(), 'memory');
}

function mdFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((e) => e.endsWith('.md'))
      .map((e) => path.join(dir, e));
  } catch {
    return [];
  }
}

export function searchMemory(query: string, max = 5): string[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);
  if (!terms.length) return [];

  const snippets: { score: number; text: string }[] = [];
  for (const file of mdFiles(memoryDir())) {
    let content = '';
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const para of content.split(/\n\s*\n/)) {
      const low = para.toLowerCase();
      const score = terms.reduce((s, t) => s + (low.includes(t) ? 1 : 0), 0);
      if (score > 0) snippets.push({ score, text: para.trim().slice(0, 500) });
    }
  }
  return snippets
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((s) => s.text);
}
