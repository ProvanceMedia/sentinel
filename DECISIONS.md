# Design decisions

The three choices that shape everything else, and why.

### 1. Isolation = a container per turn

Each conversation turn runs in its own ephemeral, non-root, credential-free
container; the host holds the secrets and exposes host actions as **mediated**
tools. Stopping a turn is a container kill, which cleanly reaps the agent and every
child process it spawned.

*Why:* the agent is assumed hostile (prompt injection is a when, not an if), so the
boundary has to be the OS, not the model's good behaviour or in-process permission
checks.

### 2. A generic core, with personal config kept out

The engine in `src/` is generic and self-contained. Anything personal — persona,
secrets, service definitions — lives in a git-ignored `personal/` layer, with
*example* versions under `config/generic/`. A lint keeps the two from mixing.

*Why:* you can run your own customised agent and still share/fork the engine without
leaking anything private; the open-source core is whatever ships minus `personal/`.

### 3. Subscription-first auth

By default Sentinel authenticates with your Claude Pro/Max subscription via the
OAuth token, driving the real Claude Code engine so usage bills against your plan.
An API key is supported as a fallback for workloads that need metered, always-on
billing.

*Why:* a personal agent should run on the subscription you already pay for, not rack
up separate API charges — while leaving the door open for production use.
