# Sentinel — Architecture

> A single-operator flagship Claude agent: every conversation turn runs in an
> ephemeral, credential-free per-session container against the Max subscription;
> the host holds all secrets, enforces a real network-namespace egress jail, and
> brokers every host mutation — with a generic OSS-extractable core cleanly split
> from a private persona/secrets layer.

Design rationale in [DECISIONS.md](./DECISIONS.md); current status in
[ROADMAP.md](./ROADMAP.md).

## Principles

1. **The container IS the security boundary, not `canUseTool`.** In-agent gates
   (`canUseTool`/`PreToolUse`) are fast UX/audit only and may be disabled by a
   breakout. Real containment = netns no-route + forced egress + read-only rootfs
   + dropped caps + non-root + per-session-only mounts. The "box is the wall"
   stance is **gated on a containment integration test** (curl evil.com / read
   another session / read host creds / reach 169.254.169.254 all MUST fail).
2. **Only ONE Anthropic credential ever enters the box, and it's a short-lived
   ACCESS token minted host-side per turn — never the long-lived credential file**
   (which carries the account-level refresh token). Breakout blast radius is a few
   hours of quota, recoverable by re-minting, not a re-login. All service secrets
   stay host-side, always.
3. **One env producer, enforced not conventional.** `AuthResolver` is the SOLE
   constructor of `query().options.env`, from a frozen allowlist base (never a
   spread of the supervisor's `process.env`) + exactly one Anthropic credential
   with the other blanked. A runtime guard rejects any turn whose env wasn't
   stamped by `AuthResolver`. Kills the env-REPLACE footgun and the
   50-secret-leak class.
4. **One network model.** No chat runner is `--network none` (**verified**: zero
   egress can't reach the model). Every runner gets a per-session netns whose ONLY
   route is an `nftables` REDIRECT to the host egress jail. Egress is enforced at
   the kernel, NOT via `HTTP_PROXY` env (**verified**: undici/native fetch ignore
   it, so env-proxy is a sieve).
5. **One mediated-tool transport.** All host capabilities (service calls,
   scheduling, systemctl, deploy, file-ops, send-as-bot, memory_search) are
   in-process SDK MCP tools whose handlers forward a typed frame over the single
   per-turn control socket to the host broker. Secrets are injected ONLY inside
   host-side handlers.
6. **Stop = container kill**, restoring the clean tree-reap the bare SDK gives up.
   `docker kill -SIGKILL` reaps the SDK subprocess and every tool child atomically.
   Host-side mediated ops already dispatched get best-effort cancel by `turnId`;
   un-abortable ops are surfaced honestly, never claimed stopped.
7. **Ephemeral-first, pool-later.** Ship `--rm`-per-turn (**measured ~318ms**
   warm-image boot — ~5× cheaper than assumed). This deletes the shared-mount
   bleed, scrub-correctness, pause, and recycle risk classes wholesale. Add a warm
   pool ONLY if the measured full cold path proves unacceptable.
8. **Generic CORE vs PERSONAL layer is a directory + config boundary, mechanically
   enforced.** Engine reads runtime policy/persona/job/service files; zero personal
   refs in core; a CI lint gate (`check-core-clean`) fails the build on any personal
   token. OSS extraction = ship the engine + example policies, drop `personal/`.
9. **Sub-credit metered from `SDKRateLimitInfo` buckets, NOT `total_cost_usd`**
   (informational on OAuth). Collapse the daemon count: one host process under one
   systemd unit + exactly one out-of-process watchdog timer.

## Architecture overview

Sentinel is one long-lived host daemon (`sentineld`, Node/TS, systemd-managed) plus
a generic, persona-free, credential-free runner image. The daemon owns sockets, ALL
secrets, the session→turn map, the egress jail, every host mutation, scheduling,
metering, and memory indexing. **It NEVER runs the Agent SDK itself** — the SDK runs
only inside ephemeral per-turn containers.

### Components

| Component | Summary |
|---|---|
| **sentineld** | The one long-lived process: Dispatcher, surface adapters, ContainerRunner, CapabilityBroker, Warden, Treasury (AuthResolver/AccountVerifier/Meter/Scheduler), PersonaLoader, memory_search — one systemd unit, one log. Never imports the SDK. |
| **ContainerRunner + agent-runner image** | Spawns an ephemeral `--rm` container per turn with the Warden net/mount spec + Treasury env, owns the per-turn control socket. The in-box `agent-runner` is the ONLY code importing `@anthropic-ai/claude-agent-sdk`; runs `query()` and re-emits the stable NDJSON event protocol. Generic, persona-free, secret-free, digest-pinned. |
| **Warden** | Per-session containment envelope: nftables-forced netns egress jail, per-session-ONLY writable mount (`/sessions/<id>` + tmpfs `$HOME/.claude` + tmpfs `/tmp`), symlink-resolved (realpath) mount allow/deny with deny-list winning, and the read-only soft `tool-gate.json`. Owns the containment integration test as a build gate. |
| **CapabilityBroker** | The ONLY component that sees a plaintext service secret. Unsealed once at daemon start (sops/age, key from systemd credential store) into memory. Handles `mediated_call` frames: injects secrets host-side for service calls; validates + narrowly actuates host-ops (argv-only never shell, realpath+prefix paths, regex-pinned unit names, fixed recipe registry by id, `+x` forbidden, destructive ops default `confirm`). Per-call allowlist-redacted audit. |
| **Treasury** | AuthResolver (sole env producer; mints short-TTL Anthropic cred). AccountVerifier (assert `accountInfo`/`apiKeySource` vs the route's expected cred; strict-abort for sub-locked crons, lenient-warn for chat). Meter (rate-limit buckets authoritative for sub, cost informational; `guard()` pre-turn gate). Scheduler (durable JobStore + InProcessCron; per-path billing via `job.authRoute`; idempotent fires). |
| **Surfaces & pipeline** | One-file-per-surface adapters (Slack first; WhatsApp/Telegram pluggable) behind a typed contract + the surface-agnostic Dispatcher: stop → auth → serial-queue-with-coalescing → context/attachment staging → immediate placeholder → turn → throttled status → structured `ReplyDecision` delivery (replaces string sentinels). |
| **Persona / Memory / Reflect** | Host-side persona assembly (`preset:'claude_code'` + append; `MEMORY.md` as delimited *untrusted* leading context, kept OUT of the cached prefix). Two-tier git-markdown memory + SQLite FTS5 `memory_search` exposed as a mediated tool. Off-by-default post-turn reflectors as cheap-model ephemeral turns. Persona mounted RO (no self-mutation). |

### Data flow (a message, arrival → reply)

1. Slack Socket Mode → adapter normalizes `InboundTurn{conversationId, surface, userId, text, replyTarget, attachments?}`.
2. Dispatcher: stop-check → auth-check (personal DM allowlist) → per-conversation serial queue (coalescing).
3. Stage attachments to host dir; build transcript; **post placeholder immediately** (Slack shimmer) → zero perceived latency.
4. `Treasury.AuthResolver.resolve('slack.chat')` → env `{PATH,HOME,LANG,TZ,NODE_OPTIONS, CLAUDE_CODE_OAUTH_TOKEN:<freshly-minted short-TTL token>, ANTHROPIC_API_KEY:''}` + expected `{tokenSource:'CLAUDE_CODE_OAUTH_TOKEN', apiProvider:'firstParty', apiKeySource:'none'}`. `PersonaLoader.load` → system prompt + memory mounts. `Warden.registerSession` → netns jail (only route = nftables REDIRECT to warden-egress, which allowlists api.anthropic.com), writable mount = `/sessions/<id>` only.
5. `Meter.guard(auth)` → bucket allowed → proceed (else deny + inform).
6. ContainerRunner: `docker run -d --rm --user 10001:10001 --read-only --tmpfs /tmp --tmpfs ~/.claude --cap-drop ALL --security-opt no-new-privileges --pids-limit 512 --memory 2g --network sentinel-sess-<id> -v <host>/sessions/<id>:/sessions/<id>:rw -v staging:/work/attachments:ro -v run/<runId>:/run/sentinel:rw -e CLAUDE_CODE_OAUTH_TOKEN=<token> sentinel-runner:<digest>`. (NOT `--network none`; docker socket NEVER mounted.)
7. `agent-runner` connects control socket, sends `hello{accountInfo()}`. Host `AccountVerifier.assert` (lenient for chat; strict cron aborts+kills on mismatch).
8. Host sends `turn_spec{prompt, systemPrompt, outputSchema:REPLY_DECISION_SCHEMA, mediatedTools manifest, cwd:/sessions/<id>, resumeSessionId?, limits}`. Runner calls `query()` with env verbatim, `settingSources:[]`, in-process MCP server of mediated tools.
9. Model works. `memory_search` → mediated_call → host FTS5. Service tool (e.g. `hubspot_contact_get`) → mediated_call → broker injects `HUBSPOT_PAT` host-side, executes, audits, returns. WebFetch to an allowlisted host egresses through the jail; `evil.com` has no route → fails. Status frames → throttle → Slack shimmer.
10. `result` frame: `structured_output={action:'reply',content}`, `total_cost_usd` (informational), `usage`, `SDKRateLimitInfo`, `sdkSessionId`.
11. Host: `Meter.record` → ledger. Dispatcher Zod-validates `ReplyDecision` (tolerant fallback + legacy sentinel detector) → `surface.deliverAction`. Persist `sdkSessionId`. Container exits. Warden teardown. Staging reaped.
12. Post-turn fire-and-forget: significant turn → (off-by-default) reflector (cheap-model ephemeral turn, RW memory mount, debounced FTS reindex).

**STOP mid-turn:** Dispatcher finds the turn record → `broker.cancel(turnId)` (abort in-flight mediated ops where safe) → soft `abort` frame (`q.interrupt()`) → arm `STOP_GRACE_MS=1500` → `ContainerRunner.kill(SIGKILL)` (netns/cgroup teardown reaps SDK + every tool child atomically). Un-abortable host-op surfaced honestly.

## Security model

Threat model: **the agent is hostile-by-default** (any Read/WebFetch/email/API
response can prompt-inject it). Containment never relies on the model behaving; the
in-agent gate is explicitly NOT the boundary.

- **Credential**: the long-lived credential file (which carries an account-level
  refresh token) is NEVER mounted. The host (`token-minter`) injects only a
  freshly-minted short-TTL access token per turn, and refuses a turn whose token is
  near expiry. This is the only secret in the box.
- **Network**: egress is fail-closed by default — the host auth-proxy
  (`SENTINEL_AUTHPROXY=on`) only lets the box reach hosts in `auth-hosts.json` and
  denies the rest, with an optional kernel egress jail (`SENTINEL_EGRESS=jail`) forcing
  all container traffic through it. `SENTINEL_PROXY_PASSTHROUGH=on` opens egress to ANY
  host — blind-tunnelled, no credential injected — trading exfiltration-resistance for
  open web access; loopback/link-local/cloud-metadata/private IPs stay blocked (SSRF
  guard) in either mode. The allowlist bounds DESTINATION not DATA, with per-destination
  volume audit to catch bulk exfiltration.
- **Credential injection**: secrets are injected host-side, never in the container —
  two paths. Mediated tools (`http_call`, service tools) inject the secret inside the
  handler. For unmodified binaries (`gh`/`git`/`curl`), the host auth-proxy MITM-
  terminates TLS for allowlisted hosts with a per-deployment CA the runner trusts and
  swaps the placeholder for the real key. The container only ever holds placeholders.
- **Mounts**: NO shared sessions parent — the box mounts ONLY this conversation's
  directory (rw) + tmpfs for `~/.claude` and `/tmp` + read-only attachments.
  `mount-security` realpaths every source before matching; a root-owned deny-list
  (`.ssh`, `.env`, the docker socket, etc.) wins.
- **Mediated host-ops** (the top attack surface — host-side, where the box doesn't
  protect): argv arrays, never a shell; closed recipe registries by id; regex-pinned
  names; file-op roots disjoint from anything executable; agent-set `+x` forbidden;
  destructive ops default to out-of-band confirm. Validators are fuzzed as a build gate.
- **Runtime**: `--user` non-root, `--cap-drop ALL`, `no-new-privileges`,
  `--read-only`, seccomp, `--pids-limit`, `--memory`; the docker socket is never
  mounted. userns-remap and a micro-VM runtime (e.g. gVisor) are recommended opt-in
  upgrades for the strongest isolation.
- **Audit**: append-only, root-owned `0600`, ALLOWLIST-redacted (log only
  known-safe fields) so an unknown field can never leak a secret.

## Repo layout (core vs personal)

The generic core is `src/**` + `config/generic/**` (open-source, `check-core-clean`-gated).
The `personal/**` layer is git-ignored and dropped for OSS: your persona, real service
policies, surface/auth config, and encrypted secrets. See the README for the file tree.
