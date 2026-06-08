// Turns an InboundTurn into a container turn: resolve auth -> open control socket
// -> launch the runner (local|docker) -> stream events -> return a ReplyDecision.
// Reply contract (reply/react/silent), mid-turn stop (-> container kill),
// idle + iteration watchdogs, built-in throttle fallback model.
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ControlChannel } from './control-socket';
import { launchLocal, launchDocker, type LaunchSpec, type RunnerHandle } from './launcher';
import { resolveAuth } from '../treasury/auth-resolver';
import { audit } from '../warden/audit';
import { unsealVault, loadServices, allMediatedManifest, handleMediatedCall } from '../broker/index';
import { loadAuthHosts, authHostsList } from '../broker/auth-hosts';
import { registerHttpTool } from '../broker/http-call';
import { registerConnectTool } from '../broker/connect-tool';
import { startAuthProxy } from './auth-proxy';
import { registerMemoryTools } from '../memory-core/memory-tool';
import { registerCronTools } from '../treasury/cron-tools';
import { registerHostOps } from '../broker/hostops';
import { record as meterRecord, guard as meterGuard } from '../treasury/meter';
import { acquire, release } from './admission';
import { loadPersona } from '../persona-core/loader';
import { maybeReflect } from '../reflect-core/reflector';
import type { RunnerFrame, ReplyDecision, AccountInfo, ToolPolicy } from '../shared/protocol';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RUNTIME_DIR = process.env.SENTINEL_RUNTIME_DIR ?? path.join(ROOT, '.runtime');
const MODE = (process.env.SENTINEL_RUNNER_MODE ?? 'local') as 'local' | 'docker';
const MODEL = process.env.SENTINEL_MODEL ?? 'claude-haiku-4-5';
const FALLBACK_MODEL = process.env.SENTINEL_FALLBACK_MODEL ?? '';
const TURN_TIMEOUT_MS = Number(process.env.SENTINEL_TURN_TIMEOUT_MS ?? 180_000);
const IDLE_MS = Number(process.env.SENTINEL_IDLE_MS ?? 120_000);
const MAX_ITER = Number(process.env.SENTINEL_MAX_ITER ?? 60);
const STOP_GRACE_MS = Number(process.env.SENTINEL_STOP_GRACE_MS ?? 1500);
const DENY_TOOLS = (process.env.SENTINEL_DENY_TOOLS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// Tools the agent may use without an (impossible, headless) approval prompt. Safe
// because the container is the boundary. Override/extend via SENTINEL_ALLOWED_TOOLS.
const ALLOWED_TOOLS = (process.env.SENTINEL_ALLOWED_TOOLS ?? 'Read,Write,Edit,Bash,Glob,Grep,WebSearch,WebFetch,TodoWrite,Task')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const AUDIT_DIR = path.join(RUNTIME_DIR, 'audit');

// Host-side init: unseal the vault, load services, register internal tools
// (memory_search), and assemble the persona once.
unsealVault();
loadServices();
loadAuthHosts();
registerMemoryTools();
registerCronTools();
registerHttpTool();
registerConnectTool();
if (process.env.SENTINEL_HOSTOPS === 'on') registerHostOps();
if (process.env.SENTINEL_AUTHPROXY === 'on') startAuthProxy();
const MEDIATED = allMediatedManifest();

// Generic operating playbook shipped in core (config/core/operating.md) — applies to every
// install. Personal identity/voice lives in the persona; this is universal good behaviour
// (check-before-claiming, proactivity, memory discipline, safety, honesty, voice).
const CORE_OPERATING = (() => {
  try {
    return fs.readFileSync(path.join(ROOT, 'config/core/operating.md'), 'utf8').trim();
  } catch {
    return '';
  }
})();

// Self-knowledge appended to every turn so the agent answers correctly ABOUT ITSELF
// (its real tools + Sentinel's config model) instead of guessing generic Claude Code config.
// A FUNCTION (not a const) so the wired-APIs list reflects connections added at runtime.
function buildCapabilities(): string {
  return [
  '## Your setup (read before answering questions about yourself)',
  'You are **Sentinel**: a host daemon plus an isolated, per-turn container. The host injects any secrets into tool calls — you never hold API keys yourself. Besides the standard tools (Bash, Read, Write, WebSearch, WebFetch, …), you have these mediated tools:',
  MEDIATED.map((t) => `- \`${t.name}\` — ${t.description}`).join('\n') || '- (none registered)',
  '',
  'APIs wired and ready RIGHT NOW — reach any of these with the `http_call` tool (host + path); the host injects the credential. When the user asks about email, calendar, payments, a CRM, a repo, etc., MATCH it to a host below and call it. NEVER say you lack access without checking this list first:',
  authHostsList()
    .map((h) => `- \`${h.host}\`${h.note ? ` — ${h.note}` : ''}`)
    .join('\n') || '- (none configured yet)',
  '',
  'Be proactive and agentic: for read-only lookups (email, calendar, payments, data) just DO the work and answer — do NOT ask "want me to look?". Chain multiple http_call steps as needed. E.g. "any emails today?" → http_call gmail.googleapis.com `gmail/v1/users/me/messages?q=newer_than:1d`, then read the top few with `gmail/v1/users/me/messages/{id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, then summarise. Only ask first before WRITES/sends/deletes or anything irreversible.',
  '',
  'When asked what is set up or scheduled, actually CALL `sentinel_cron_list` and check your memory — never guess "nothing".',
  'To RUN a scheduled job on demand ("run/trigger X now"), call the `sentinel_cron_run` tool with its id — it hands you the job\'s instructions; carry them out now and reply with the result here. NEVER say you "can\'t trigger it" or invent a trigger/RemoteTrigger API — `sentinel_cron_run` IS the trigger.',
  'When you CREATE a scheduled job, choose its `model` by load: simple/high-frequency (alerts, every-few-minutes sweeps) → `claude-haiku-4-5`; general/moderate work → `claude-sonnet-4-6` (the balanced middle); infrequent + reasoning-heavy (daily code review, analysis, drafting) → `claude-opus-4-8`; omit for the default. Tell the user which you picked so they can change it.',
  '',
  "Your configuration lives in operator-edited files. When asked how to add something, give the Sentinel answer below — do NOT suggest generic Claude Code config (settings.local.json, a project .env, ~/.bashrc, or \"skills\"):",
  '- **API keys / secrets** → the vault: `personal/config/secrets.json` (a flat {"KEY":"value"} map) or a `SENTINEL_VAULT_<KEY>=…` line in `.env`. Secrets stay host-side and never enter your container. You cannot set one from chat — tell the user the exact key name to add.',
  '- **A new external API (easiest)** → the **connections dashboard** — a local web form (`SENTINEL_DASHBOARD=on`, reach it over an SSH tunnel) where the user enters the key + host + scheme; it wires the vault + `auth-hosts.json` and hot-reloads, no restart. Equivalent by hand: one line in `personal/config/auth-hosts.json` (e.g. `"api.stripe.com": {"scheme":"bearer","vaultKey":"STRIPE_API_KEY"}`) + the key in the vault. Either way the host injects the key; you call it with `http_call` and never see the secret.',
  '- **If the user asks YOU to set up an API** → they first add the key host-side (`npm run connect -- --name THEIR_KEY`), then give you the **host** and a **test path**; you call `sentinel_connect(host, vaultKey, testPath)` and it auto-detects the auth scheme and wires it. NEVER invent the host — if they didn\'t give it, ask. You never see the key.',
  '- **A connection is wrong / returns 401** → FIX it yourself, do not refuse: re-call `sentinel_connect` for that host with an explicit `scheme` (bearer|header|query|basic) + `queryParam`/`headerName` (e.g. weatherapi.com uses `scheme:"query", queryParam:"key"`). Read the API\'s docs for how the key is passed. You only edit the config (host + scheme), never the key — so there is no security reason you cannot repair it.',
  '- **A non-standard service** (query-param keys, custom bodies/headers) → an entry in `personal/config/services.policy.json` using `${VAULT:KEY}`; it becomes its own tool.',
  '- **Scheduled jobs** → `personal/config/jobs.json` (declarative) or your `sentinel_cron_*` tools.',
  '- **Your personality / who you serve** → `personal/persona/{identity,soul,user}.md`.',
  ].join('\n');
}

export interface InboundTurn {
  conversationId: string;
  surface: string;
  userId: string;
  text: string;
  model?: string; // per-turn model override (e.g. a cron job's own model); falls back to SENTINEL_MODEL
}

export interface TurnResult {
  decision: ReplyDecision;
  sessionId: string | null;
  account?: AccountInfo;
  costUSD?: number;
  usage?: unknown;
  rateLimit?: unknown;
  subtype: string;
  authOk: boolean;
  stopped: boolean;
}

export interface DispatchHooks {
  onStatus?: (s: string) => void;
}

interface InFlight {
  stop: (reason: string) => void;
}
const inflight = new Map<string, InFlight>();

/** Request a mid-turn stop for a conversation. Returns false if nothing in flight. */
export function requestStop(conversationId: string): boolean {
  const e = inflight.get(conversationId);
  if (!e) return false;
  e.stop('user-stop');
  return true;
}

export function inflightCount(): number {
  return inflight.size;
}

// Friendly "what is the agent doing right now" label from a tool call + its input,
// so surfaces can show "reading connect-tool.ts" / "searching the web…" rather than a bare name.
function clip(s: unknown, n = 46): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
function baseName(p: unknown): string {
  const s = String(p ?? '');
  return s.split('/').pop() || s;
}
function hostOf(u: unknown): string {
  try {
    return new URL(String(u)).host;
  } catch {
    return clip(u, 40);
  }
}
export function toolLabel(name: string, input?: unknown): string {
  const i = (input ?? {}) as Record<string, any>;
  const mcp = /^mcp__([a-z0-9_]+?)__(.+)$/i.exec(name);
  const server = mcp ? mcp[1].toLowerCase() : '';
  const n = mcp ? mcp[2] : name;
  if (/gmail/.test(server)) return 'checking email';
  if (/calendar/.test(server)) return 'checking the calendar';
  if (/drive/.test(server)) return 'looking in Drive';
  switch (n) {
    case 'Read':
      return `reading ${baseName(i.file_path)}`;
    case 'Write':
      return `writing ${baseName(i.file_path)}`;
    case 'Edit':
    case 'NotebookEdit':
      return `editing ${baseName(i.file_path ?? i.notebook_path)}`;
    case 'Bash':
      return `running ${clip(i.command ?? 'a command', 52)}`;
    case 'Glob':
      return `finding ${clip(i.pattern, 28)}`;
    case 'Grep':
      return `searching for ${clip(i.pattern, 28)}`;
    case 'WebSearch':
      return `searching the web for ${clip(i.query, 38)}`;
    case 'WebFetch':
      return `reading ${hostOf(i.url)}`;
    case 'Task':
    case 'Agent':
      return 'running a sub-agent';
    case 'TodoWrite':
      return 'planning';
    case 'http_call':
      return `calling ${clip(i.host ?? 'an API', 38)}`;
    case 'sentinel_connect':
      return `wiring up ${clip(i.host ?? 'a connection', 28)}`;
  }
  if (/memory/.test(n)) return /save|write|remember/.test(n) ? 'saving to memory' : 'checking its memory';
  if (/cron/.test(n)) return /create/.test(n) ? 'scheduling a job' : /run/.test(n) ? 'running a job' : 'checking its schedule';
  return `using ${n.replace(/_/g, ' ')}`;
}

export async function runTurn(inbound: InboundTurn, hooks: DispatchHooks = {}): Promise<TurnResult> {
  // Pre-turn budget/rate-limit gate.
  const g = meterGuard();
  if (!g.allowed) {
    hooks.onStatus?.(`⛔ ${g.reason}`);
    return { decision: { action: 'reply', content: `⚠️ ${g.reason}` }, sessionId: null, subtype: 'budget', authOk: true, stopped: false };
  }

  // Reloaded each turn so persona edits and newly-saved memory apply without a restart.
  const persona = loadPersona();
  const model = inbound.model || MODEL; // per-turn override (cron jobs carry their own), else the base model
  const runId = crypto.randomUUID().slice(0, 8);
  const sessionId = sessionKey(inbound.conversationId);
  const sessionDir = path.join(RUNTIME_DIR, 'sessions', sessionId);
  const runDir = path.join(RUNTIME_DIR, 'run', runId);
  fs.mkdirSync(path.join(sessionDir, 'work'), { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  const socketPathHost = path.join(runDir, 'control.sock');

  // Dev: the container runs as uid 10001 against host-owned bind mounts.
  if (MODE === 'docker') {
    for (const d of [RUNTIME_DIR, path.join(RUNTIME_DIR, 'sessions'), path.join(RUNTIME_DIR, 'run'), sessionDir, path.join(sessionDir, 'work'), runDir]) {
      try {
        fs.chmodSync(d, 0o777);
      } catch {
        /* ignore */
      }
    }
  }

  const auth = resolveAuth(`${inbound.surface}.chat`);
  const channel = new ControlChannel(socketPathHost);
  await channel.listen();

  const resumeFile = path.join(sessionDir, 'sdk-session-id');
  const resumeSessionId = fs.existsSync(resumeFile) ? fs.readFileSync(resumeFile, 'utf8').trim() : null;
  const cwd = MODE === 'docker' ? '/session/work' : path.join(sessionDir, 'work');

  let account: AccountInfo | undefined;
  let authOk = true;
  let handle: RunnerHandle | null = null;
  let stopped = false;
  let toolUses = 0;
  let idleTimer: NodeJS.Timeout | null = null;
  let hardTimer: NodeJS.Timeout | null = null;
  let graceTimer: NodeJS.Timeout | null = null;

  const result = new Promise<TurnResult>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const stop = (reason: string) => {
      if (stopped) return;
      stopped = true;
      hooks.onStatus?.(`🛑 stopping (${reason})`);
      try {
        channel.send({ t: 'abort' }); // soft interrupt first
      } catch {
        /* ignore */
      }
      // Hard kill after a short grace: container kill reaps the SDK + every tool child.
      graceTimer = setTimeout(() => {
        try {
          handle?.kill();
        } catch {
          /* ignore */
        }
      }, STOP_GRACE_MS);
    };
    inflight.set(inbound.conversationId, { stop });

    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => stop('idle-timeout'), IDLE_MS);
    };
    hardTimer = setTimeout(() => stop('hard-timeout'), TURN_TIMEOUT_MS);
    armIdle();

    channel.on('frame', (f: RunnerFrame) => {
      armIdle();
      if (f.t === 'hello') {
        const toolPolicy: ToolPolicy | undefined = DENY_TOOLS.length ? { deny: DENY_TOOLS } : undefined;
        channel.send({
          t: 'turn_spec',
          prompt: inbound.text,
          model,
          fallbackModel: FALLBACK_MODEL || undefined,
          appendSystemPrompt: `${persona.systemPromptAppend}\n\n${CORE_OPERATING}\n\n${buildCapabilities()}`,
          allowedTools: ALLOWED_TOOLS,
          toolPolicy,
          mediatedTools: MEDIATED.length ? MEDIATED : undefined,
          cwd,
          resumeSessionId,
        });
      } else if (f.t === 'account') {
        account = f.account;
        authOk = account?.tokenSource === auth.expected.tokenSource && account?.apiProvider === auth.expected.apiProvider;
        hooks.onStatus?.(authOk ? `🔐 ${account?.tokenSource}/${account?.apiProvider}` : `⚠️ auth mismatch: ${account?.tokenSource}/${account?.apiProvider}`);
      } else if (f.t === 'event') {
        if (f.event.kind === 'init') hooks.onStatus?.(`🧠 ${f.event.model} (apiKeySource=${f.event.apiKeySource})`);
        else if (f.event.kind === 'tool_use') {
          toolUses++;
          hooks.onStatus?.(`🔧 ${toolLabel(f.event.name, f.event.input)}`);
          if (toolUses > MAX_ITER) stop('iteration-cap');
        } else if (f.event.kind === 'assistant_text') hooks.onStatus?.('✍️  composing');
        else if (f.event.kind === 'log') hooks.onStatus?.(`🚫 ${f.event.msg}`);
      } else if (f.t === 'mediated_call') {
        hooks.onStatus?.(`🛰️  ${toolLabel(f.tool, f.args)}`);
        audit(AUDIT_DIR, { ts: new Date().toISOString(), turnId: runId, conversationId: inbound.conversationId, event: 'mediated_call', tool: f.tool });
        handleMediatedCall(f.tool, f.args)
          .then((res) => {
            channel.send({ t: 'mediated_result', callId: f.callId, ok: res.ok, data: res.data, error: res.error });
            audit(AUDIT_DIR, { ts: new Date().toISOString(), turnId: runId, conversationId: inbound.conversationId, event: 'mediated_result', tool: f.tool, status: res.ok ? 'ok' : 'error' });
          })
          .catch((e) => channel.send({ t: 'mediated_result', callId: f.callId, ok: false, error: String(e?.message ?? e) }));
      } else if (f.t === 'result') {
        if (f.sessionId) {
          try {
            fs.writeFileSync(resumeFile, f.sessionId);
          } catch {
            /* ignore */
          }
        }
        done(() =>
          resolve({
            decision: f.decision ?? { action: 'reply', content: f.rawText },
            sessionId: f.sessionId,
            account,
            costUSD: f.costUSD,
            usage: f.usage,
            rateLimit: f.rateLimit,
            subtype: stopped ? 'stopped' : f.subtype,
            authOk,
            stopped,
          }),
        );
      } else if (f.t === 'error') {
        done(() => reject(new Error(f.message)));
      }
    });

    channel.on('closed', () => {
      // If we stopped it, a closed socket is success (the container was killed).
      if (stopped) done(() => resolve({ decision: { action: 'silent' }, sessionId: null, account, subtype: 'stopped', authOk, stopped: true }));
      else done(() => reject(new Error('runner closed before delivering a result')));
    });
  });

  await acquire(); // host-wide concurrency gate (shared with the scheduler)
  const spec: LaunchSpec = { runId, socketPathHost, env: auth.env, sessionDir };
  handle = MODE === 'docker' ? launchDocker(spec) : launchLocal(spec);

  try {
    const r = await result;
    meterRecord({ turnId: runId, ts: new Date().toISOString(), surface: inbound.surface, model, authKind: r.account?.tokenSource, costUSD: r.costUSD, usage: r.usage, rateLimit: r.rateLimit });
    audit(AUDIT_DIR, {
      ts: new Date().toISOString(),
      turnId: runId,
      conversationId: inbound.conversationId,
      surface: inbound.surface,
      userId: inbound.userId,
      model,
      subtype: r.subtype,
      authOk: r.authOk,
      stopped: r.stopped,
      costUSD: r.costUSD,
    });
    // Fire-and-forget self-improvement (off by default; never on reflect/cron turns).
    if (inbound.surface !== 'reflect' && inbound.surface !== 'cron') {
      void maybeReflect({ userText: inbound.text, replyText: r.decision.action === 'reply' ? r.decision.content ?? '' : '', userId: inbound.userId }, (i) => runTurn(i));
    }
    return r;
  } catch (e: any) {
    audit(AUDIT_DIR, { ts: new Date().toISOString(), turnId: runId, conversationId: inbound.conversationId, surface: inbound.surface, status: 'error', reason: String(e?.message ?? e) });
    throw e;
  } finally {
    release();
    inflight.delete(inbound.conversationId);
    for (const t of [idleTimer, hardTimer, graceTimer]) if (t) clearTimeout(t);
    channel.close();
    handle?.kill();
    try {
      fs.rmSync(runDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function sessionKey(conversationId: string): string {
  return crypto.createHash('sha1').update(conversationId).digest('hex').slice(0, 16);
}
