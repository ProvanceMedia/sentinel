// Runs INSIDE the box (Docker container) — or as a local subprocess in dev.
// The ONLY code that imports the Agent SDK. Persona-free, secret-free.
// Connects the control socket, awaits a turn_spec, runs query(), streams events.
import net from 'node:net';
import { createRequire } from 'node:module';
import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  RUNNER_PROTOCOL_VERSION,
  encodeFrame,
  FrameDecoder,
  ReplyDecisionSchema,
  type HostFrame,
  type RunnerFrame,
  type ReplyDecision,
  type MediatedResult,
} from '../shared/protocol';
import { evaluateGate } from './agent-gate';
import { buildMediatedServer } from './mediated-mcp';

const SOCK = process.env.SENTINEL_CONTROL_SOCK;
const RUN_ID = process.env.SENTINEL_RUN_ID ?? 'unknown';
if (!SOCK) {
  console.error('agent-runner: SENTINEL_CONTROL_SOCK not set');
  process.exit(2);
}

const sock = net.createConnection(SOCK);
const decoder = new FrameDecoder();
const ac = new AbortController();
let handling = false;

const send = (f: RunnerFrame) => sock.write(encodeFrame(f));

// Mediated-call RPC: forward to the host broker, await mediated_result by callId.
const pending = new Map<string, (r: MediatedResult) => void>();
let callSeq = 0;
const mediatedRPC = (toolName: string, args: Record<string, unknown>): Promise<MediatedResult> =>
  new Promise((resolve) => {
    const callId = `mc${++callSeq}`;
    pending.set(callId, resolve);
    send({ t: 'mediated_call', callId, tool: toolName, args });
    setTimeout(() => {
      if (pending.has(callId)) {
        pending.delete(callId);
        resolve({ ok: false, error: 'mediated call timed out (runner)' });
      }
    }, 30_000);
  });

sock.on('connect', () => {
  let sdkVersion: string | undefined;
  try {
    sdkVersion = createRequire(import.meta.url)('@anthropic-ai/claude-agent-sdk/package.json').version;
  } catch {
    /* best effort */
  }
  send({ t: 'hello', runId: RUN_ID, protocol: RUNNER_PROTOCOL_VERSION, runnerVersion: '0.0.1', sdkVersion });
});

sock.on('data', (chunk) => {
  for (const raw of decoder.push(chunk)) {
    const frame = raw as HostFrame;
    if (frame.t === 'abort') {
      ac.abort();
    } else if (frame.t === 'mediated_result') {
      const r = pending.get(frame.callId);
      if (r) {
        pending.delete(frame.callId);
        r({ ok: frame.ok, data: frame.data, error: frame.error });
      }
    } else if (frame.t === 'turn_spec' && !handling) {
      handling = true;
      runTurn(frame).catch((e) => {
        send({ t: 'error', message: String(e?.message ?? e) });
        sock.end(() => process.exit(1));
      });
    }
  }
});

sock.on('error', (e) => {
  console.error('agent-runner: socket error', e.message);
  process.exit(2);
});

async function runTurn(spec: Extract<HostFrame, { t: 'turn_spec' }>) {
  const opts: any = {
    model: spec.model,
    permissionMode: 'default',
    allowedTools: spec.allowedTools,
    disallowedTools: spec.disallowedTools,
    cwd: spec.cwd,
    settingSources: [], // no stray CLAUDE.md hijack
    resume: spec.resumeSessionId ?? undefined,
    abortController: ac,
    // env was already curated by the host (AuthResolver -> launcher set our process.env);
    // Options.env REPLACES, so we spread our already-safe process.env.
    env: { ...process.env } as Record<string, string>,
  };
  // Reply contract: append to Claude Code's preset prompt (reply/react/silent sentinels).
  if (spec.appendSystemPrompt) {
    opts.systemPrompt = { type: 'preset', preset: 'claude_code', append: spec.appendSystemPrompt };
  }
  // Built-in throttle fallback (e.g. opus -> haiku on overload).
  if (spec.fallbackModel) opts.fallbackModel = spec.fallbackModel;

  // Deterministic tool denial: disallowedTools actually removes the tool (canUseTool
  // is SKIPPED for pre-approved tools like Bash, so it can't be relied on to block them).
  if (spec.toolPolicy?.deny?.length) {
    opts.disallowedTools = [...(opts.disallowedTools ?? []), ...spec.toolPolicy.deny];
  }
  // Soft in-agent gate on top (covers allowOnly + any non-pre-approved/MCP tools).
  if (spec.toolPolicy) {
    opts.canUseTool = async (toolName: string, input: any) => {
      const g = evaluateGate(spec.toolPolicy!, toolName);
      if (g.allow) return { behavior: 'allow', updatedInput: input };
      send({ t: 'event', event: { kind: 'log', level: 'info', msg: `gate denied tool: ${toolName}` } });
      return { behavior: 'deny', message: g.reason ?? `Tool "${toolName}" is not permitted.` };
    };
  }

  // Mediated capability tools (host-brokered; secrets never enter the box).
  if (spec.mediatedTools?.length) {
    const { server, toolNames } = buildMediatedServer(spec.mediatedTools, mediatedRPC);
    opts.mcpServers = { sentinel: server };
    opts.allowedTools = [...(opts.allowedTools ?? []), ...toolNames];
  }

  const q: any = query({ prompt: spec.prompt, options: opts });

  // Report which credential we landed on so the host can refuse an API-key box when sub was intended.
  try {
    const account = await q.accountInfo();
    send({ t: 'account', account });
  } catch (e: any) {
    send({ t: 'event', event: { kind: 'log', level: 'warn', msg: 'accountInfo failed: ' + String(e?.message ?? e) } });
  }

  let rawText = '';
  let sessionId: string | null = null;
  let result: any = null;
  let lastRateLimit: unknown;

  for await (const m of q) {
    if (m.type === 'rate_limit_event') {
      lastRateLimit = m.rate_limit_info;
    } else if (m.type === 'system') {
      if (m.session_id) sessionId = m.session_id;
      if (m.subtype === 'init') {
        send({ t: 'event', event: { kind: 'init', model: m.model, apiKeySource: m.apiKeySource, sessionId: m.session_id ?? null } });
      }
    } else if (m.type === 'assistant') {
      for (const b of m.message?.content ?? []) {
        if (b.type === 'text') {
          rawText += b.text;
          send({ t: 'event', event: { kind: 'assistant_text', text: b.text } });
        } else if (b.type === 'tool_use') {
          send({ t: 'event', event: { kind: 'tool_use', name: b.name, id: b.id } });
        }
      }
    } else if (m.type === 'result') {
      result = m;
      if (m.session_id) sessionId = m.session_id;
    }
  }

  // Structured reply first; tolerant fallback + legacy sentinel detector if the schema was ignored.
  let decision: ReplyDecision | null = null;
  if (result?.structured_output) {
    const parsed = ReplyDecisionSchema.safeParse(result.structured_output);
    if (parsed.success) decision = parsed.data;
  }
  if (!decision) decision = coerceReply(result?.result ?? rawText);

  send({
    t: 'result',
    subtype: result?.subtype ?? 'unknown',
    isError: !!result?.is_error,
    decision,
    rawText: result?.result ?? rawText,
    sessionId,
    costUSD: result?.total_cost_usd,
    usage: result?.usage,
    rateLimit: lastRateLimit,
  });
  // Self-exit after the frame flushes so the --rm container is reaped promptly.
  sock.end(() => process.exit(0));
}

function coerceReply(text: string): ReplyDecision {
  const t = (text ?? '').trim();
  if (/^NO_REPLY\b/.test(t)) return { action: 'silent' };
  const r = t.match(/^REACT:\s*:?([a-z0-9_+-]+):?/i);
  if (r) return { action: 'react', emoji: r[1] };
  return { action: 'reply', content: t };
}
