// Memory store — host-side appends to MEMORY.md (used by the reflectors).
import fs from 'node:fs';
import path from 'node:path';
import { memoryDir } from './search';

export function appendMemory(text: string, category = 'note'): void {
  const dir = memoryDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'MEMORY.md'), `\n- [${category}] ${text.trim()}\n`);
  } catch {
    /* never throw */
  }
}
