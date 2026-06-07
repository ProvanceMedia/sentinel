# Contributing to Sentinel

Thanks for your interest! Sentinel is young — bug reports, hardening, new surfaces,
and docs are all welcome.

## Ground rule: keep the core generic

The trunk is a **generic engine**. Anything personal — your persona, secrets, and
service configs — lives in `personal/` (git-ignored) and `config/generic/` ships
*example* versions. A CI lint enforces that no personal references leak into the core:

```bash
npm run -s check       # runs scripts/check-core-clean.ts over src/ + config/generic + scripts
```

If you add an example, put it under `config/generic/`; never reference a real
service, name, host path, or token in `src/`.

## Dev setup

```bash
npm install
npm run typecheck

# fast loop without containers:
CLAUDE_CODE_OAUTH_TOKEN=... SENTINEL_RUNNER_MODE=local npm run sentinel -- "hi"

# the real thing:
npm run build:image
CLAUDE_CODE_OAUTH_TOKEN=... SENTINEL_RUNNER_MODE=docker npm run sentinel -- "hi"
```

## Tests & gates

| Command | Checks |
|---|---|
| `npm run typecheck` | TypeScript |
| `npx tsx scripts/check-core-clean.ts` | no personal refs in the core |
| `npx tsx scripts/fuzz-hostops.ts` | the host-ops path validator can't escape its root |
| `npx tsx scripts/containment-test.ts` | container isolation (run with `SENTINEL_EGRESS=jail` for the full gate) |
| `npx tsx scripts/oss-extract-check.ts` | the core builds cleanly without `personal/` |

Please run the relevant gates before opening a PR, and add a test when you change a
security-sensitive path (the broker, the warden, or any host-ops actuator).

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md). The short version: the **host** holds all
secrets and never runs the model; the **container** runs the agent and is treated as
hostile. New capabilities should be *mediated* (the agent asks; the host validates and
acts), not handed to the agent directly.

## License

By contributing you agree your contributions are licensed under the [MIT License](./LICENSE).
