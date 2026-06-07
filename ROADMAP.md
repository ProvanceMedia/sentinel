# Roadmap & status

Sentinel works end-to-end today, and every subsystem below has been exercised with
real runs. It's young software — expect rough edges and please open issues.

## What works today

- **Per-turn isolation** — each message runs in an ephemeral, non-root, read-only
  container with dropped capabilities; only that conversation's files are mounted;
  the Docker socket is never mounted.
- **Kernel egress jail** — optional default-deny network jail (`nftables`); only
  `api.anthropic.com` is reachable. Blocks data exfiltration and cloud-metadata SSRF.
- **Subscription auth** — runs on your Claude Pro/Max plan via the OAuth token, and
  verifies at startup that it's the subscription path (not an API key).
- **Capability broker** — service secrets live in a host-side vault and are injected
  just-in-time for mediated calls; they never enter the container.
- **Persona & memory** — Markdown persona + file-based long-term memory with keyword
  search, plus optional self-reflection that distils durable facts after a chat.
- **Mediated scheduling** — the agent can create recurring jobs; the host owns a
  durable scheduler and runs them.
- **Host-ops actuators** — e.g. `file_write`, confined to a sandboxed root with a
  path validator that's been adversarially fuzz-tested.
- **Surfaces** — Slack (Socket Mode) and CLI; add more with one file.
- **Operability** — mid-turn stop, idle/iteration watchdogs, model fallback on
  throttle, and per-turn metering against your plan's rate-limit buckets.
- **One-command installer** — `./sentinel.sh` bootstraps Docker + Node, auth, image,
  persona, and an end-to-end check.

## Known limitations

- The egress jail is Linux-only (`iptables`/`nftables`) and allowlists destination
  **IPs**; re-run the setup on a timer to follow CDN address changes.
- Tool denial relies on `disallowedTools` + the container boundary, not on in-agent
  prompts (the agent is assumed hostile).
- Mediated service auth currently covers header/query-param injection; OAuth-refresh
  and other bespoke schemes are added per service.
- Subscription billing depends on your plan's headless-usage allowance; for
  always-on production workloads consider an API-key route.

## On the roadmap

- Stronger sandbox runtimes (gVisor / micro-VM, rootless) as an opt-in.
- Hostname-based egress (proxy/SNI) to replace IP allowlisting.
- More surfaces (Telegram, Discord, iMessage) and more built-in service tools.
- Semantic memory search (embeddings) alongside keyword search.
- A warm container pool if per-turn cold-start latency proves an issue.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the design.
