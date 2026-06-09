```
███████╗███████╗███╗   ██╗████████╗██╗███╗   ██╗███████╗██╗
██╔════╝██╔════╝████╗  ██║╚══██╔══╝██║████╗  ██║██╔════╝██║
███████╗█████╗  ██╔██╗ ██║   ██║   ██║██╔██╗ ██║█████╗  ██║
╚════██║██╔══╝  ██║╚██╗██║   ██║   ██║██║╚██╗██║██╔══╝  ██║
███████║███████╗██║ ╚████║   ██║   ██║██║ ╚████║███████╗███████╗
╚══════╝╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚═╝╚═╝  ╚═══╝╚══════╝╚══════╝
```

<div align="center">

**🛡️ Your own AI agent — running on your Claude subscription, sandboxed so it can't leak your secrets or touch your machine.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
&nbsp;built on the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript)

</div>

---

Sentinel is a personal AI assistant you self-host. You talk to it in **Slack** (or a terminal); it answers using **Claude**, and it can act on your behalf — read your email, check your CRM, run a `gh` command, hit any API you connect — all while being treated as **hostile by default**.

- 💳 **Runs on your Claude Pro/Max subscription**, not a metered API key. It drives the real Claude Code engine, so usage bills against your plan.
- 📦 **Every message runs in a throwaway, locked-down container.** A prompt injection can't read your files, your keys, or the host.
- 🔑 **Your secrets never enter the agent.** The host holds them and injects them only for the exact call being made. A compromised agent has nothing to steal.
- 🔌 **Connect any API in seconds** — drop a key in host-side, and the agent can use that service. It never sees the key.
- 🧠 **It remembers, schedules its own jobs, and knows what it can do** — persona, file-based memory, durable cron, and a self-knowledge layer so it stops saying "I can't" to things it can.

> Think of it as: *give Claude a Slack account, a memory, and your tools — but put it in a box where it can't hurt you.*

## Quickstart

On a fresh Linux server (as root):

```bash
git clone https://github.com/ProvanceMedia/sentinel.git
cd sentinel && ./sentinel.sh
```

That's the whole install. `./sentinel.sh` installs Docker + Node if missing, asks for your Claude subscription token (or runs `claude setup-token`), builds the sandbox image, seeds a persona, and runs an end-to-end check. Then talk to it:

```bash
npm run sentinel -- "what can you do?"
```

Run it as a Slack bot + scheduler:

```bash
./sentinel.sh --surface slack     # paste your Slack tokens (manifest included)
sudo ./sentinel.sh --service      # run it as a systemd service (starts on boot)
```

**Requirements:** Linux (or macOS) and a **Claude Pro/Max subscription**. On Linux the installer sets up Docker + Node 20 for you.

## How it works

Each message spins up a **fresh container**, runs Claude on your subscription, streams the reply back, then destroys the container. Your memory and identity live on the **host** and are loaded into every turn. When the agent needs a credential or a host action, it goes through a **mediated tool** — the host validates the request, injects the secret, performs it, and returns the result. **The agent never sees the key.**

```
  You ── Slack / CLI ──┐
                       ▼
 ┌──────────────  HOST  (holds ALL secrets, never runs the model)  ──────────────┐
 │  route → auth → queue → spawn an ephemeral container for THIS one message      │
 │                              │                                                 │
 │   vault ──inject secret──►  mediated tools  ◄──"call api.x / run this cron"──   │
 │   (any API, files, cron, memory, OAuth refresh …)                      │       │
 └────────────────────────────────────────────────────────────────────────┼──────┘
                                                                           ▼
                        ┌──────────────  SANDBOX  (one turn)  ──────────────────┐
                        │  Claude, on YOUR subscription                         │
                        │  • read-only rootfs · non-root · caps dropped         │
                        │  • only this conversation's files mounted             │
                        │  • optional kernel egress jail                        │
                        │  • NO service secrets inside the box                  │
                        └────────────────────────────────────────────────────────┘
```

## Features

- 🔒 **OS-level isolation** — per-turn ephemeral container: read-only rootfs, non-root, dropped capabilities, no Docker socket, per-conversation file access, and an optional kernel `nftables` **egress jail** (default-deny).
- 🔑 **Secrets never in the agent** — a host-side vault injects credentials just-in-time, so prompt-injection can't steal them.
- 🔌 **Connect any API** — the agent reaches any configured host with `http_call`; you wire one up with a one-line CLI, a local web dashboard, or by *asking the agent to set it up* (it probes the auth scheme itself). OAuth2 (refresh → access token) handled host-side too.
- 🧰 **Real CLIs in the box** — opt-in auth-proxy lets unmodified `gh`, `git`, `curl` run inside the sandbox with credentials injected at the network layer — the key still never lands in the container.
- 💳 **Runs on your Claude subscription** — drives the real Claude Code engine on your Pro/Max plan (OAuth token), not a metered API key.
- 🧠 **Memory, persona & self-knowledge** — file-based long-term memory with search, a Markdown persona, a shipped operating playbook, and a live capability list so the agent knows what it can actually do.
- ⏰ **Self-scheduling** — declarative cron jobs with delivery to a channel; the agent can also create and run jobs on demand.
- 💬 **Surfaces** — Slack (Socket Mode, with native status shimmer) and CLI out of the box; add another in one file.
- 🧰 **Operable** — mid-turn `stop`, idle/iteration watchdogs, automatic model fallback on throttle, and per-turn metering.
- 🧩 **Forkable core** — a generic engine cleanly separated from your private `personal/` layer, enforced by a CI lint.

## Connecting your tools

Sentinel keeps every credential **out of the agent** — the key lives in a host-side vault and is injected per request. There are three ways to wire one up, all secret-safe:

**1. One-line CLI** (the common case):

```bash
npm run connect api.stripe.com         # paste the key → done (Bearer auth assumed)
```

**2. A local web dashboard** (`SENTINEL_DASHBOARD=on`) — a form on `127.0.0.1` (reach it over an SSH tunnel) to add connections point-and-click, hot-reloaded with no restart.

**3. Just ask the agent.** Drop the key in host-side, then tell it the host:

```bash
npm run connect -- --name ACME_KEY     # stash the key, no host yet
# then, in chat:
"set up the Acme API — host api.acme.com, key ACME_KEY, test path v1/me"
```

The agent **probes the host to detect the auth scheme** (Bearer / header / query-param / Basic), verifies it, and wires it. It never sees the key and never guesses the host — so a mistake can only break the setup, never leak a credential.

Once connected, the agent calls it naturally: *"check my latest Stripe charges"*, *"open a PR on owner/repo"*, *"what's on my calendar?"* — using `http_call` (or `gh`/`git` if the auth-proxy is on). Standard REST hosts go in `personal/config/auth-hosts.json`; anything unusual (custom bodies, multi-key auth) goes in `personal/config/services.policy.json`.

## Security model

The agent is **hostile by default** — assume any web page, email, or API response it reads could try to hijack it. Containment never relies on the model behaving:

| Boundary | How it's enforced |
|---|---|
| **Filesystem** | Read-only rootfs; only *this* conversation's directory is mounted; host code & secrets aren't present |
| **Network** | Optional kernel egress jail (default-deny); the auth-proxy injects credentials at the network layer so keys never enter the box |
| **Credentials** | Never in the container; injected host-side per request; OAuth tokens refreshed host-side; only a short-lived Claude token is ever inside |
| **Host actions** | Mediated through validated actuators (argv-only, path-confined, symlink-safe — adversarially fuzz-tested) |
| **Privilege** | Non-root, all capabilities dropped, `no-new-privileges`, pid/memory limits, Docker socket never mounted |

Full design: [ARCHITECTURE.md](./ARCHITECTURE.md).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | — | your Claude subscription token (the installer sets this) |
| `SENTINEL_RUNNER_MODE` | `local` | `docker` (real sandbox) or `local` (fast dev loop) |
| `SENTINEL_MODEL` | `claude-sonnet-4-6` | default model for chat turns (`claude-haiku-4-5` / `claude-sonnet-4-6` / `claude-opus-4-8`) |
| `SENTINEL_EFFORT` | — | default reasoning effort `low`–`max` (blank = the model's own default; skipped on Haiku) |
| `SENTINEL_EGRESS` | `bridge` | `jail` (kernel egress jail), `none`, or `bridge` |
| `SENTINEL_PROXY_PASSTHROUGH` | `off` | `on` lets the agent reach **any** host (open web); keys are still injected only for auth-hosts, and loopback/metadata/private IPs stay blocked |
| `SENTINEL_SURFACES` | `slack` | which chat surfaces the daemon starts |
| `SENTINEL_TZ` | `UTC` | timezone for cron schedules (the installer detects and prompts for it) |
| `SENTINEL_AUTHPROXY` | `off` | `on` to let `gh`/`git`/`curl` run in the box (keys injected) |
| `SENTINEL_DASHBOARD` | `off` | `on` to serve the local connections web form |

- **Persona** → edit `personal/persona/*.md` (seeded from `config/generic/persona.example`): `identity` (who it is), `soul` (voice), `user` (who it serves), `operating` (how to act safely on the open web).
- **Connections** → `personal/config/auth-hosts.json`; secrets go in the vault (`personal/config/secrets.json` or `SENTINEL_VAULT_*`), never the repo.
- **Scheduled jobs** → declare them in `personal/config/jobs.json`, or just ask in chat: the agent creates, lists, runs, edits, and cancels jobs (each with its own model and timezone) via its `sentinel_cron_*` tools.

**Choosing the model/effort from chat** — switch inline and it sticks to the thread: `use opus` / `use sonnet` / `use haiku` picks the model; `ultrathink` or `xhigh` raises reasoning effort; `normal effort` and `default model` reset.

## Connecting Slack

`./sentinel.sh --surface slack` walks you through this and prints the manifest. By hand:

1. **[api.slack.com/apps](https://api.slack.com/apps)** → **Create New App** → **From a manifest** → pick your workspace.
2. Paste [`sentinel-slack-manifest.json`](./sentinel-slack-manifest.json) → **Create**.
3. **Install App** → **Install to Workspace** → **Allow**, then copy the **Bot User OAuth Token** (`xoxb-…`).
4. **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes**, add `connections:write`, copy the token (`xapp-…`).
5. Your avatar → **Profile** → **⋮** → **Copy member ID** (`U…`).

Put those in `.env` as `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, and `SENTINEL_SLACK_ALLOWED_USERS`, then run the service and DM the bot.

## Commands

```bash
./sentinel.sh [--yes] [--surface cli|slack] [--service] [--jail] [--rebuild]
npm run sentinel -- "message"      # a one-off CLI turn
npm run sentineld                  # the daemon (surfaces + scheduler)
npm run connect <host>             # add an API connection (one-liner)
npm run connect -- --name KEY      # stash a key for the agent to wire up
sudo ./sentinel.sh --service       # install + enable the systemd unit
sudo ./sentinel.sh --jail          # apply the kernel egress jail
```

## Project layout

```
src/                 the engine (generic, open-source core)
  host/                supervisor, dispatcher, container runner, auth-proxy, dashboard
  runner/              the in-container agent (the only code that imports the SDK)
  warden/              isolation: egress jail, mount-security, audit
  broker/              secret vault + mediated tools (http_call, services, OAuth, connect)
  treasury/            auth, metering, scheduler, cron
  persona-core/  memory-core/  reflect-core/  surfaces/
config/generic/      example persona + policies      config/core/  shipped operating rules
personal/            YOUR persona, secrets, connections, jobs (git-ignored)
scripts/             installer helpers, tests, fuzzers
```

## Contributing

The trunk is the **generic engine**. Keep personal references out of `src/`, `config/generic/`, and `config/core/` — the `check-core-clean` lint enforces it. PRs welcome for surfaces, tools, hardening, and docs. See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE).
