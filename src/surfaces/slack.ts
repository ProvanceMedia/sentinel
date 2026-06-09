// Slack surface — Socket Mode listener wired to the dispatcher. One file; the
// dispatcher is surface-agnostic, so this just translates Slack events <-> turns.
import { SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';
import { runTurn, requestStop, type InboundTurn } from '../host/dispatcher';
import { setSlackPoster } from '../broker/slack-tool';

const STOP_WORDS = new Set(['stop', 'halt', 'abort', 'cancel', 'kill']);
const STATUS_THROTTLE_MS = 900;

// Map internal status strings to a clean phrase for the DM shimmer ("Sentinel <phrase>").
// Tool statuses arrive pre-labelled by the dispatcher ("🔧 reading foo.ts", "🛰️ calling api.x").
function shimmerText(s: string): string {
  if (/✍|composing/i.test(s)) return 'is typing…';
  if (/^(🔧|🛰)/u.test(s)) {
    const label = s.replace(/^\S+\s+/, '').replace(/[…\s]+$/, '').trim(); // drop emoji token + any trailing ellipsis
    if (label) return `is ${label}…`;
  }
  return 'is thinking…';
}

function allowlist(): Set<string> {
  return new Set(
    (process.env.SENTINEL_SLACK_ALLOWED_USERS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

// Pull a message's file attachments down with the bot token so the agent can read them.
// Capped per file; needs the `files:read` scope on the Slack app.
const MAX_ATTACH_BYTES = 25 * 1024 * 1024;
async function downloadFiles(files: any[], token: string): Promise<{ name: string; data: Buffer }[]> {
  const out: { name: string; data: Buffer }[] = [];
  for (const f of (files ?? []).slice(0, 10)) {
    const url = f?.url_private_download || f?.url_private;
    if (!url) continue;
    if (typeof f.size === 'number' && f.size > MAX_ATTACH_BYTES) {
      console.error(`[slack] skipping oversized attachment ${f.name} (${f.size} bytes)`);
      continue;
    }
    try {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) {
        console.error(`[slack] attachment "${f.name}" download failed: HTTP ${r.status} (need files:read scope?)`);
        continue;
      }
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > MAX_ATTACH_BYTES) continue;
      out.push({ name: String(f.name || f.id || 'attachment'), data: buf });
    } catch (e: any) {
      console.error(`[slack] attachment "${f?.name}" download error:`, e?.message ?? e);
    }
  }
  return out;
}

export interface SlackSurface {
  deliver: (target: string, text: string) => Promise<void>;
}

export async function startSlack(): Promise<SlackSurface> {
  const appToken = process.env.SLACK_APP_TOKEN;
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!appToken || !botToken) throw new Error('startSlack: SLACK_APP_TOKEN (xapp-) and SLACK_BOT_TOKEN (xoxb-) are required');

  const web = new WebClient(botToken);
  const allow = allowlist();
  const authInfo: any = await web.auth.test();
  const botUserId = authInfo.user_id as string;
  console.error(`[slack] connected as @${authInfo.user} (${botUserId}); allowlist=${allow.size ? [...allow].join(',') : '(open — set SENTINEL_SLACK_ALLOWED_USERS)'}`);

  const sm = new SocketModeClient({ appToken });

  const onEvent = async ({ event, ack }: any) => {
    try {
      await ack?.();
    } catch {
      /* ignore */
    }
    if (process.env.SENTINEL_SLACK_DEBUG === 'on') {
      console.error(`[slack] event type=${event?.type} subtype=${event?.subtype ?? '-'} ch_type=${event?.channel_type ?? '-'} user=${event?.user ?? '-'} bot=${event?.bot_id ? 'y' : 'n'}`);
    }
    try {
      await handle(event);
    } catch (e: any) {
      console.error('[slack] handler error:', e?.message ?? e);
    }
  };
  sm.on('message', onEvent);
  sm.on('app_mention', onEvent);
  // Assistant-surface events (only fire if the app's "Agents & AI Apps" feature is ON).
  sm.on('assistant_thread_started', onEvent);

  async function handle(event: any): Promise<void> {
    if (!event || event.bot_id || event.user === botUserId) return; // ignore bots / self
    if (event.subtype && event.subtype !== 'file_share') return; // ignore edits/deletes/joins, but keep attachments
    const text = String(event.text ?? '')
      .replace(new RegExp(`<@${botUserId}>`, 'g'), '')
      .trim();
    if (!text && !event.files?.length) return; // nothing to act on
    if (allow.size && !allow.has(event.user)) return; // not authorized

    const channel = event.channel;
    const threadTs = event.thread_ts ?? event.ts;
    const conversationId = `slack:${channel}:${threadTs}`;

    // Mid-turn stop: a stop-word during an in-flight turn kills it.
    if (STOP_WORDS.has(text.toLowerCase())) {
      if (requestStop(conversationId)) {
        await web.reactions.add({ channel, timestamp: event.ts, name: 'octagonal_sign' }).catch(() => {});
      }
      return;
    }

    // DMs use Slack's native "shimmer" (assistant.threads.setStatus); channels edit a
    // placeholder message. Shimmer needs the assistant:write scope — fall back gracefully.
    const isDM = event.channel_type === 'im' || (typeof channel === 'string' && channel.startsWith('D'));
    let shimmer = false;
    let phTs: string | null = null;
    if (isDM) {
      try {
        await setStatus(channel, threadTs, 'is thinking…');
        shimmer = true;
      } catch {
        shimmer = false;
      }
    }
    if (!shimmer) {
      const placeholder = await web.chat.postMessage({ channel, thread_ts: threadTs, text: '🧠 thinking…' });
      phTs = placeholder.ts as string;
    }

    let lastUpd = 0;
    const onStatus = (s: string) => {
      const now = Date.now();
      if (now - lastUpd < STATUS_THROTTLE_MS) return;
      lastUpd = now;
      if (shimmer) void setStatus(channel, threadTs, shimmerText(s));
      else if (phTs) web.chat.update({ channel, ts: phTs, text: s }).catch(() => {});
    };
    const clearShimmer = () => setStatus(channel, threadTs, '').catch(() => {});

    const attachments = event.files?.length ? await downloadFiles(event.files, botToken!) : [];
    const inbound: InboundTurn = { conversationId, surface: 'slack', userId: event.user, text, attachments };
    try {
      const res = await runTurn(inbound, { onStatus });
      if (res.decision.action === 'reply') {
        const content = res.decision.content || '(no content)';
        if (shimmer) {
          await clearShimmer();
          await web.chat.postMessage({ channel, thread_ts: threadTs, text: content });
        } else {
          await web.chat.update({ channel, ts: phTs as string, text: content });
        }
      } else if (res.decision.action === 'react') {
        if (shimmer) await clearShimmer();
        else await web.chat.delete({ channel, ts: phTs as string }).catch(() => {});
        await web.reactions.add({ channel, timestamp: event.ts, name: (res.decision.emoji || 'eyes').replace(/:/g, '') }).catch(() => {});
      } else {
        if (shimmer) await clearShimmer();
        else await web.chat.delete({ channel, ts: phTs as string }).catch(() => {}); // silent
      }
    } catch (e: any) {
      if (shimmer) {
        await clearShimmer();
        await web.chat.postMessage({ channel, thread_ts: threadTs, text: `⚠️ ${e?.message ?? 'error'}` }).catch(() => {});
      } else {
        await web.chat.update({ channel, ts: phTs as string, text: `⚠️ ${e?.message ?? 'error'}` }).catch(() => {});
      }
    }
  }

  // Slack assistant shimmer. Throws if the scope is missing (caller falls back).
  async function setStatus(channel: string, threadTs: string, status: string): Promise<void> {
    await web.assistant.threads.setStatus({ channel_id: channel, thread_ts: threadTs, status: status.slice(0, 250) });
  }

  // Post a message to a channel (C…/G…) or a user DM (U…). Used by scheduled jobs.
  async function deliver(target: string, text: string): Promise<void> {
    let channel = target;
    if (target.startsWith('U')) {
      const r: any = await web.conversations.open({ users: target });
      channel = r?.channel?.id ?? target;
    }
    await web.chat.postMessage({ channel, text });
  }

  await sm.start();
  console.error('[slack] socket mode started — DM the bot or @mention it.');
  setSlackPoster(deliver); // lets the agent's slack_post tool reach channels via the bot token
  return { deliver };
}
