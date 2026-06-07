// Install-time auth check: confirms CLAUDE_CODE_OAUTH_TOKEN authenticates on the
// SUBSCRIPTION (not an API key). Exit 0 = good. Used by sentinel.sh.
import { query } from '@anthropic-ai/claude-agent-sdk';

delete process.env.ANTHROPIC_API_KEY;
if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  console.error('verify-auth: CLAUDE_CODE_OAUTH_TOKEN not set');
  process.exit(2);
}

const q: any = query({
  prompt: 'Reply with exactly: OK',
  options: {
    model: 'claude-haiku-4-5',
    allowedTools: [],
    settingSources: [],
    env: { ...process.env, ANTHROPIC_API_KEY: '' },
  },
});

let account: any = null;
try {
  account = await q.accountInfo();
} catch {
  /* fall through */
}
let reply = '';
let apiKeySource = '?';
for await (const m of q) {
  if (m.type === 'system' && m.subtype === 'init') apiKeySource = m.apiKeySource;
  if (m.type === 'assistant') for (const b of m.message?.content ?? []) if (b.type === 'text') reply += b.text;
}

const oauth = account?.tokenSource === 'CLAUDE_CODE_OAUTH_TOKEN' && account?.apiProvider === 'firstParty';
console.error(`verify-auth: tokenSource=${account?.tokenSource} provider=${account?.apiProvider} apiKeySource=${apiKeySource} reply=${JSON.stringify(reply.trim())}`);
process.exit(oauth ? 0 : 1);
