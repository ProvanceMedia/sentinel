#!/usr/bin/env bash
# Sentinel installer — one command to bootstrap everything (nanoclaw-style):
# AUTO-INSTALLS prerequisites (Docker + Node 20) when missing -> deps -> runner
# image -> subscription auth (with live verify) -> persona -> surface ->
# optional systemd service + egress jail -> end-to-end check. Idempotent. Usage:
#   ./sentinel.sh [--yes] [--non-interactive] [--surface cli|slack] [--service] [--jail] [--rebuild]
# On a fresh root server, just: ./sentinel.sh   (add --yes for unattended)
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

NONINTERACTIVE=0; SURFACE=""; DO_SERVICE=0; DO_JAIL=0; REBUILD=0; ASSUME_YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --non-interactive) NONINTERACTIVE=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --install-deps) ASSUME_YES=1 ;;
    --surface) SURFACE="${2:-}"; shift ;;
    --service) DO_SERVICE=1 ;;
    --jail) DO_JAIL=1 ;;
    --rebuild) REBUILD=1 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1"; exit 2 ;;
  esac; shift
done

cG='\033[32m'; cY='\033[33m'; cR='\033[31m'; cB='\033[1m'; c0='\033[0m'
step(){ printf "\n${cB}==> %s${c0}\n" "$*"; }
ok(){   printf "  ${cG}OK${c0} %s\n" "$*"; }
warn(){ printf "  ${cY}!!${c0} %s\n" "$*"; }
die(){  printf "\n${cR}xx FAILED: %s${c0}\n" "$*"; printf "${cY}Fix and re-run ./sentinel.sh, or ask Claude: \"sentinel install failed at: %s\"${c0}\n" "$*"; exit 1; }

confirm(){ # confirm "question" -> 0 (yes) / 1 (no). --yes auto-yes; --non-interactive without --yes declines.
  [ "$ASSUME_YES" -eq 1 ] && return 0
  [ "$NONINTERACTIVE" -eq 1 ] && return 1
  printf "  %s [Y/n] " "$1"; read -r _a; case "${_a:-Y}" in [Nn]*) return 1 ;; *) return 0 ;; esac
}

SUDO=""
need_root_for_install(){
  if [ "$(id -u)" -ne 0 ]; then
    command -v sudo >/dev/null 2>&1 && SUDO="sudo" || die "need root or sudo to install prerequisites — re-run as root, or install Node>=20 + Docker manually"
  fi
}
ensure_curl(){
  command -v curl >/dev/null 2>&1 && return 0
  need_root_for_install
  if command -v apt-get >/dev/null 2>&1; then $SUDO apt-get update -y >/dev/null 2>&1 || true; $SUDO apt-get install -y curl ca-certificates >/dev/null 2>&1 || true
  elif command -v dnf >/dev/null 2>&1; then $SUDO dnf install -y curl >/dev/null 2>&1 || true; fi
  command -v curl >/dev/null 2>&1 || die "curl required and could not be installed"
}
install_docker(){
  need_root_for_install; ensure_curl
  step "Installing Docker (get.docker.com)"
  curl -fsSL https://get.docker.com | $SUDO sh || die "Docker install"
  $SUDO systemctl enable --now docker >/dev/null 2>&1 || $SUDO service docker start >/dev/null 2>&1 || true
  [ "$(id -u)" -ne 0 ] && $SUDO usermod -aG docker "$USER" >/dev/null 2>&1 || true
}
install_node(){
  need_root_for_install; ensure_curl
  step "Installing Node.js 20"
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO bash - >/dev/null 2>&1 && $SUDO apt-get install -y nodejs || die "Node install"
  elif command -v dnf >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | $SUDO bash - >/dev/null 2>&1 && $SUDO dnf install -y nodejs || die "Node install"
  elif command -v brew >/dev/null 2>&1; then brew install node || die "Node install"
  else die "couldn't auto-install Node — install Node>=20 manually (https://nodejs.org)"; fi
}

step "Sentinel installer  (dir: $DIR)"

# 1) Prerequisites (auto-installed when missing)
step "Checking prerequisites"
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  NM="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"; [ "$NM" -ge 20 ] && NODE_OK=1
fi
if [ "$NODE_OK" -eq 0 ]; then
  warn "Node.js >=20 not found."
  confirm "Install Node.js 20 now?" && install_node || die "Node.js >=20 required (install manually, then re-run)"
fi
ok "node $(node -v)"
command -v npm >/dev/null 2>&1 || die "npm not found (ships with Node)"
ok "npm $(npm -v)"

if ! command -v docker >/dev/null 2>&1; then
  warn "Docker not found."
  confirm "Install Docker now?" && install_docker || die "Docker required (install manually, then re-run)"
fi
docker info >/dev/null 2>&1 || $SUDO systemctl start docker >/dev/null 2>&1 || $SUDO service docker start >/dev/null 2>&1 || true
if ! docker info >/dev/null 2>&1; then
  [ "$(id -u)" -ne 0 ] \
    && die "Docker daemon not reachable for this user. If Docker was just installed, log out/in once (the 'docker' group applies on next login) then re-run ./sentinel.sh — or run as root." \
    || die "Docker daemon not reachable (is it running?)"
fi
ok "docker $(docker --version | awk '{print $3}' | tr -d ,)"

# 2) Dependencies
step "Installing Node dependencies"
if [ -d node_modules ] && [ "$REBUILD" -eq 0 ]; then ok "node_modules present (use --rebuild to reinstall)";
else npm install --no-audit --no-fund || die "npm install"; ok "dependencies installed"; fi

# 3) Runner image
step "Building the runner image (sentinel-runner:dev)"
# Per-deployment CA for the auth-proxy — baked into the image (idempotent; skips if present).
node_modules/.bin/tsx scripts/gen-ca.ts >/dev/null 2>&1 || warn "gen-ca skipped (auth-proxy will be unavailable)"
if docker image inspect sentinel-runner:dev >/dev/null 2>&1 && [ "$REBUILD" -eq 0 ]; then ok "image present (use --rebuild to rebuild)";
else docker build -f Dockerfile.runner -t sentinel-runner:dev . >/dev/null || die "docker build"; ok "image built"; fi

# 4) Subscription auth
step "Setting up Claude subscription auth"
[ -f .env ] && { set -a; . ./.env; set +a; } || true
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  if command -v claude >/dev/null 2>&1 && [ "$NONINTERACTIVE" -eq 0 ]; then
    warn "No token found — running 'claude setup-token' (login in the browser)…"
    claude setup-token || true
    [ -f .env ] && { set -a; . ./.env; set +a; } || true
  fi
  if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
    [ "$NONINTERACTIVE" -eq 1 ] && die "CLAUDE_CODE_OAUTH_TOKEN not set (export it for --non-interactive)"
    printf "  Paste your Claude Code OAuth token (sk-ant-oat...): "
    read -rs CLAUDE_CODE_OAUTH_TOKEN; echo
  fi
fi
[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] || die "no OAuth token provided"
touch .env; chmod 600 .env
grep -v '^CLAUDE_CODE_OAUTH_TOKEN=' .env 2>/dev/null > .env.tmp || true
echo "CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN" >> .env.tmp
grep -q '^ANTHROPIC_API_KEY=' .env.tmp || echo "ANTHROPIC_API_KEY=" >> .env.tmp
grep -q '^SENTINEL_RUNNER_MODE=' .env.tmp || echo "SENTINEL_RUNNER_MODE=docker" >> .env.tmp
mv .env.tmp .env; chmod 600 .env
ok ".env written (chmod 600)"

step "Verifying the token bills against your subscription"
CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" ANTHROPIC_API_KEY= node_modules/.bin/tsx scripts/verify-auth.ts \
  || die "auth verification (token invalid, or not on the subscription)"
ok "authenticated on the subscription (tokenSource=oauth, apiKeySource=none)"

# 5) Persona
step "Setting up persona"
if [ -d personal/persona ]; then
  ok "personal/persona exists (edit personal/persona/*.md to customize)"
else
  mkdir -p personal/persona
  cp -r config/generic/persona.example/. personal/persona/
  if [ "$NONINTERACTIVE" -eq 0 ]; then
    echo "     Give your agent some personality (press Enter to keep a default):"
    printf "       What should the assistant be called?  [Sentinel]  "; read -r A_NAME
    printf "       Your name (so it knows who it works for):  "; read -r U_NAME
    printf "       One line about you / what you want help with (optional):  "; read -r U_ABOUT
    A_NAME="${A_NAME:-Sentinel}"
    printf '{\n  "name": "%s"\n}\n' "$A_NAME" > personal/persona/persona.json
    {
      echo "# Identity"; echo
      if [ -n "$U_NAME" ]; then echo "You are **$A_NAME**, $U_NAME's personal AI agent.";
      else echo "You are **$A_NAME**, a personal AI agent."; fi
      echo "You run inside an ephemeral, isolated sandbox and act through mediated tools."
      echo
      echo "When asked who you are, say your name. Be warm, sharp, and genuinely useful — a capable partner, not a faceless bot."
    } > personal/persona/identity.md
    {
      echo "# Your human"; echo
      if [ -n "$U_NAME" ]; then echo "You work directly for **$U_NAME** — address them by name.";
      else echo "You work directly for one person — your operator."; fi
      [ -n "$U_ABOUT" ] && { echo; echo "About them: $U_ABOUT"; }
      echo
      echo "Remember what matters to them and act like their agent. Edit personal/persona/*.md to tell yourself more."
    } > personal/persona/user.md
    ok "persona set${U_NAME:+ for $U_NAME} — assistant name: $A_NAME (tweak voice in personal/persona/soul.md)"
  else
    ok "seeded personal/persona from the example (edit personal/persona/*.md)"
  fi
fi

# 6) Surface
step "Pairing a surface"

# Already configured? don't re-ask on a re-run.
SLACK_SKIP=0
if grep -q '^SLACK_BOT_TOKEN=.' .env 2>/dev/null && grep -q '^SLACK_APP_TOKEN=.' .env 2>/dev/null; then
  SURFACE="slack"
  if [ "$NONINTERACTIVE" -eq 1 ] || confirm "Slack is already configured — keep the existing tokens?"; then
    ok "Slack already configured (tokens in .env) — keeping it"; SLACK_SKIP=1
  fi
fi

if [ "$SLACK_SKIP" -eq 0 ]; then
[ -z "$SURFACE" ] && [ "$NONINTERACTIVE" -eq 0 ] && { printf "  Surface? [cli/slack] (default cli): "; read -r SURFACE; }
SURFACE="${SURFACE:-cli}"
if [ "$SURFACE" = "slack" ]; then
  if [ "$NONINTERACTIVE" -eq 1 ]; then
    warn "Non-interactive: add SLACK_APP_TOKEN / SLACK_BOT_TOKEN / SENTINEL_SLACK_ALLOWED_USERS to .env"
  else
    echo
    printf "${cB}  ── Connect Slack ──────────────────────────────────────────────────────${c0}\n"
    echo   "     Six steps, all in your web browser:"
    echo
    echo   "     1.  Open    https://api.slack.com/apps"
    echo   "     2.  Create New App  ->  From a manifest  ->  pick your workspace  ->  Next"
    echo   "     3.  Clear the box (select all, delete), paste the manifest below"
    echo   "         ->  Next  ->  Create"
    echo   "     4.  Install App  ->  Install to Workspace  ->  Allow"
    printf "           then copy the  ${cB}Bot User OAuth Token${c0}   (starts  xoxb-)\n"
    echo   "     5.  Basic Information  ->  App-Level Tokens  ->  Generate Token and Scopes"
    echo   "           add scope  connections:write , click Generate,"
    printf "           then copy the  ${cB}App-Level Token${c0}        (starts  xapp-)\n"
    echo   "     6.  Member id:  your avatar  ->  Profile  ->  the ... menu  ->  Copy member ID"
    echo
    printf "${cB}  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄  paste EVERYTHING below into the box  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄${c0}\n"
    echo
    cat sentinel-slack-manifest.json
    echo
    printf "${cB}  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄  end of manifest  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄${c0}\n"
    echo
    printf "  ${cY}(press Enter at any prompt to skip — set up later: ./sentinel.sh --surface slack)${c0}\n"
    echo
    printf "  Paste  ${cB}Bot User OAuth Token${c0}  (xoxb-...): "; read -r SBT
    printf "  Paste  ${cB}App-Level Token${c0}       (xapp-...): "; read -r SAT
    printf "  Paste  ${cB}your member id${c0}        (U...):     "; read -r SUID
    if [ -n "$SBT" ] && [ -n "$SAT" ]; then
      grep -v -e '^SLACK_APP_TOKEN=' -e '^SLACK_BOT_TOKEN=' -e '^SENTINEL_SLACK_ALLOWED_USERS=' .env > .env.tmp 2>/dev/null || true
      { echo "SLACK_APP_TOKEN=$SAT"; echo "SLACK_BOT_TOKEN=$SBT"; echo "SENTINEL_SLACK_ALLOWED_USERS=$SUID"; } >> .env.tmp
      mv .env.tmp .env; chmod 600 .env
      ok "Slack configured — start the daemon and DM your bot."
    else
      warn "Skipped Slack. Set it up anytime with: ./sentinel.sh --surface slack"
      SURFACE="cli"
    fi
  fi
else
  ok "CLI surface selected"
fi
fi  # end "Slack already configured?" guard

# A Slack bot needs a persistent process — run Sentinel as a service.
SERVICE_RUNNING=0
if [ "$SURFACE" = "slack" ] && [ "$(id -u)" -eq 0 ] && command -v systemctl >/dev/null 2>&1; then
  if systemctl is-active --quiet sentinel.service 2>/dev/null; then
    systemctl restart sentinel.service 2>/dev/null || true   # pick up any config changes
    SERVICE_RUNNING=1
    ok "background service already installed — restarted to apply changes"
  elif [ "$DO_SERVICE" -eq 0 ]; then
    confirm "Run Sentinel as a background service now (auto-starts on boot)?" && DO_SERVICE=1
  fi
fi

# 7) systemd service — install AND start, so it just runs
if [ "$DO_SERVICE" -eq 1 ]; then
  step "Installing + starting the background service"
  [ "$(id -u)" -eq 0 ] || die "the service needs root (re-run with sudo)"
  command -v systemctl >/dev/null 2>&1 || die "systemd not available (no systemctl)"
  sed "s|__DIR__|$DIR|g" systemd/sentinel.service.example > /etc/systemd/system/sentinel.service
  systemctl daemon-reload || die "systemctl daemon-reload"
  systemctl enable --now sentinel.service || die "systemctl enable --now"
  SERVICE_RUNNING=1
  ok "sentinel.service installed, enabled, and started"
fi

# 8) Optional egress jail
if [ "$DO_JAIL" -eq 1 ]; then
  step "Applying egress jail"
  [ "$(id -u)" -eq 0 ] || die "--jail needs root"
  node_modules/.bin/tsx scripts/setup-egress-jail.ts apply || die "egress jail apply"
  grep -v '^SENTINEL_EGRESS=' .env > .env.tmp 2>/dev/null || true
  echo 'SENTINEL_EGRESS=jail' >> .env.tmp; mv .env.tmp .env; chmod 600 .env
  if [ "$SERVICE_RUNNING" -eq 1 ]; then systemctl restart sentinel.service || true; fi
  ok "egress jail applied (SENTINEL_EGRESS=jail set; re-run 'apply' on a timer to refresh IPs)"
fi

# 9) End-to-end check
step "Verifying end-to-end (a hello turn in a container)"
OUT="$(CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" ANTHROPIC_API_KEY= SENTINEL_RUNNER_MODE=docker SENTINEL_MODEL=claude-haiku-4-5 \
  npm run --silent sentinel -- "Reply with exactly: INSTALL-OK" 2>&1 || true)"
if echo "$OUT" | grep -q "INSTALL-OK"; then ok "end-to-end OK — Sentinel answered from inside a container on your sub"; else warn "hello turn did not return INSTALL-OK:"; echo "$OUT" | tail -4; fi

step "Done."
if [ "$SERVICE_RUNNING" -eq 1 ]; then
  printf "  ${cG}Sentinel is running as a service${c0} (and starts on boot).\n"
  [ "$SURFACE" = "slack" ] && printf "  ${cG}Slack is live${c0} — DM your bot or @mention it.\n"
  printf "    status:  ${cB}systemctl status sentinel${c0}\n"
  printf "    logs:    ${cB}journalctl -u sentinel -f${c0}\n"
  printf "    stop:    ${cB}systemctl stop sentinel${c0}\n"
else
  printf "  Try it:       ${cB}npm run sentinel -- 'hi'${c0}\n"
  [ "$SURFACE" = "slack" ] && printf "  Run the bot:  ${cB}npm run sentineld${c0}   (or ${cB}sudo ./sentinel.sh --service${c0} to run it on boot)\n"
fi
[ "$DO_JAIL" -eq 0 ] && printf "  Harden egress: ${cB}sudo ./sentinel.sh --jail${c0}\n"
