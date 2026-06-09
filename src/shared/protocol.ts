// The ONE shared contract between the host (sentineld) and the in-container
// agent-runner. Both sides import this; nothing else crosses the boundary.
import { z } from 'zod';

export const RUNNER_PROTOCOL_VERSION = 1;

// ---- Reply contract (SDK structured output) ----
export const ReplyDecisionSchema = z.object({
  action: z.enum(['reply', 'react', 'silent']),
  content: z.string().optional(),
  emoji: z.string().optional(),
});
export type ReplyDecision = z.infer<typeof ReplyDecisionSchema>;

// JSON Schema handed to query().options.outputFormat — kept in sync with the zod schema above.
export const REPLY_DECISION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: { type: 'string', enum: ['reply', 'react', 'silent'] },
    content: { type: 'string', description: 'The reply text. Required when action=reply.' },
    emoji: { type: 'string', description: 'Emoji shortcode (e.g. "eyes") when action=react.' },
  },
} as const;

// ---- In-agent tool gate policy (soft, defence-in-depth; the container is the real boundary) ----
export interface ToolPolicy {
  deny?: string[]; // tool names to deny
  allowOnly?: string[]; // if set, ONLY these tools are allowed
}

// ---- Mediated capability tools (host injects secrets; container never holds them) ----
export interface MediatedToolDef {
  name: string;
  description: string;
  params?: Record<string, { type?: 'string' | 'number' | 'boolean'; description?: string; optional?: boolean }>;
}
export interface MediatedResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

// ---- Account info (runner reports which credential it landed on) ----
export type AccountInfo = {
  tokenSource?: string;
  apiProvider?: string;
  subscriptionType?: string;
};

// ---- Agent events (runner -> host), a small stable set; SDK upgrades touch only the mapper ----
export type AgentEvent =
  | { kind: 'init'; model: string; apiKeySource: string; sessionId: string | null; effort?: string }
  | { kind: 'assistant_text'; text: string }
  | { kind: 'tool_use'; name: string; id: string; input?: unknown }
  | { kind: 'status'; text: string }
  | { kind: 'log'; level: 'info' | 'warn' | 'error'; msg: string };

// ---- Wire frames ----
export type RunnerFrame =
  | { t: 'hello'; runId: string; protocol: number; runnerVersion: string; sdkVersion?: string }
  | { t: 'account'; account: AccountInfo; apiKeySource?: string }
  | { t: 'event'; event: AgentEvent }
  | { t: 'mediated_call'; callId: string; tool: string; args: Record<string, unknown> }
  | {
      t: 'result';
      subtype: string;
      isError: boolean;
      decision: ReplyDecision | null;
      rawText: string;
      sessionId: string | null;
      costUSD?: number;
      usage?: unknown;
      rateLimit?: unknown;
    }
  | { t: 'error'; message: string };

export type HostFrame =
  | {
      t: 'turn_spec';
      prompt: string;
      model: string;
      fallbackModel?: string;
      effort?: string;
      appendSystemPrompt?: string;
      allowedTools: string[];
      disallowedTools?: string[];
      toolPolicy?: ToolPolicy;
      mediatedTools?: MediatedToolDef[];
      cwd: string;
      resumeSessionId?: string | null;
    }
  | { t: 'mediated_result'; callId: string; ok: boolean; data?: unknown; error?: string }
  | { t: 'abort' };

// ---- Length-prefixed NDJSON framing (4-byte big-endian length + JSON body) ----
export function encodeFrame(obj: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);
  push(chunk: Buffer): unknown[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: unknown[] = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (this.buf.length < 4 + len) break;
      out.push(JSON.parse(this.buf.subarray(4, 4 + len).toString('utf8')));
      this.buf = this.buf.subarray(4 + len);
    }
    return out;
  }
}
