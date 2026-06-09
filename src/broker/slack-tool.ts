// Mediated slack_post tool — lets the boxed agent post a message to a Slack channel
// or DM mid-run (e.g. status/alerts to #ops during a long cron), using the
// daemon's bot token host-side. The poster is wired by the Slack surface at startup;
// when Slack isn't running (CLI-only) the tool reports that cleanly instead of failing.
import { registerInternalTool } from './index';

let poster: ((channel: string, text: string) => Promise<void>) | null = null;

/** Wired by the Slack surface once it's up, with a function that posts via the bot token. */
export function setSlackPoster(fn: (channel: string, text: string) => Promise<void>): void {
  poster = fn;
}

export function registerSlackTool(): void {
  registerInternalTool(
    {
      name: 'slack_post',
      description:
        'Post a message to a Slack channel or user DM right now — use for status/alerts to a channel (e.g. #ops) during a long run. `channel` is a Slack channel id (C…/G…) or user id (U…). `text` uses Slack mrkdwn: *bold*, _italic_, <url|label>, <@USERID> to mention someone. Returns once posted.',
      params: {
        channel: { type: 'string', description: 'channel id (C…/G…) or user id (U…) to post to' },
        text: { type: 'string', description: 'message text in Slack mrkdwn' },
      },
    },
    async (args) => {
      if (!poster) return { ok: false, error: 'Slack is not running on this deployment — no channel to post to' };
      const channel = String(args.channel ?? '').trim();
      const text = String(args.text ?? '');
      if (!channel || !text) return { ok: false, error: 'both channel and text are required' };
      try {
        await poster(channel, text);
        return { ok: true, data: `posted to ${channel}` };
      } catch (e: any) {
        return { ok: false, error: e?.message ?? String(e) };
      }
    },
  );
}
