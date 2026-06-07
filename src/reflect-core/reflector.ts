// Self-improvement reflector — OFF by default. After a substantial turn it runs a
// cheap ephemeral turn to distil durable facts into memory. Fire-and-forget,
// rate-capped, and never reflects on its own (reflect/cron) turns.
import { appendMemory } from '../memory-core/store';

export type ReflectRunner = (inbound: { conversationId: string; surface: string; userId: string; text: string }) => Promise<{ decision: { action: string; content?: string } }>;

const MAX_PER_HOUR = Number(process.env.SENTINEL_REFLECT_MAX_PER_HOUR ?? 20);
let windowStart = Date.now();
let count = 0;

export function reflectEnabled(): boolean {
  return process.env.SENTINEL_REFLECT === 'on';
}

function significant(userText: string, replyText: string): boolean {
  return userText.trim().length >= 12 && replyText.trim().length > 0;
}

export async function maybeReflect(opts: { userText: string; replyText: string; userId: string }, runner: ReflectRunner): Promise<void> {
  if (!reflectEnabled() || !significant(opts.userText, opts.replyText)) return;

  const now = Date.now();
  if (now - windowStart > 3_600_000) {
    windowStart = now;
    count = 0;
  }
  if (count >= MAX_PER_HOUR) return;
  count++;

  const prompt =
    'You are a memory reflector. From the exchange below, extract any DURABLE facts about the user or their world worth remembering long-term (preferences, names, ongoing projects, decisions). ' +
    'Output each as a short bullet starting with "- ". If nothing is worth saving, reply with exactly: NONE.\n\n' +
    `USER: ${opts.userText}\nASSISTANT: ${opts.replyText}`;

  try {
    const r = await runner({ conversationId: `reflect:${now}`, surface: 'reflect', userId: opts.userId, text: prompt });
    const out = r.decision.content ?? '';
    if (/^\s*NONE\s*$/i.test(out)) return;
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*-\s+(.*)$/);
      if (m && m[1].trim().length > 3) appendMemory(m[1].trim(), 'reflected');
    }
  } catch {
    /* reflection is best-effort; never affects the user-facing turn */
  }
}
