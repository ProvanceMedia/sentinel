// memory_search + memory_save as INTERNAL mediated tools (host-side; the container
// calls mcp__sentinel__memory_*, the host runs them). No sqlite in the box.
import { registerInternalTool } from '../broker/index';
import { searchMemory } from './search';
import { appendMemory } from './store';

export function registerMemoryTools(): void {
  registerInternalTool(
    {
      name: 'memory_search',
      description: 'Search your long-term memory for relevant notes by keyword. Returns matching snippets, or a "no match" message.',
      params: { query: { type: 'string', description: 'keywords to search for' } },
    },
    async (args) => {
      const hits = searchMemory(String(args.query ?? ''));
      return { ok: true, data: hits.length ? hits.join('\n---\n') : 'no matching memory found' };
    },
  );

  registerInternalTool(
    {
      name: 'memory_save',
      description: 'Save a durable fact about the user or their world to long-term memory so you remember it in future conversations. Use this whenever the user tells you something worth remembering (their name, role, preferences, ongoing projects, decisions).',
      params: { fact: { type: 'string', description: 'the fact to remember, as one short clear sentence' } },
    },
    async (args) => {
      const fact = String(args.fact ?? '').trim();
      if (!fact) return { ok: false, error: 'empty fact' };
      appendMemory(fact, 'noted');
      return { ok: true, data: 'saved to long-term memory' };
    },
  );
}
