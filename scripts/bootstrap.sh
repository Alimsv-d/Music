#!/usr/bin/env bash
# One-shot bootstrap for the Music bot — run once on your host/Termux.
# Checks Node, installs deps, creates .dev.vars, runs tests + live API check,
# and (if `gh` is installed) sets the GitHub secrets needed by the deploy
# workflow. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf "\033[1;36m▸ %s\033[0m\n" "$*"; }
ok()  { printf "\033[1;32m✓ %s\033[0m\n" "$*"; }
warn(){ printf "\033[1;33m! %s\033[0m\n" "$*"; }
die() { printf "\033[1;31m✗ %s\033[0m\n" "$*"; exit 1; }

say "Checking Node.js…"
command -v node >/dev/null || die "node not found. Install Node 18+ (nvm install 20)."
NODEV=$(node -v); ok "node $NODEV"
command -v npm >/dev/null || die "npm not found."

say "Installing dependencies…"
npm install --no-audit --no-fund --prefer-offline || npm install --no-audit --no-fund
ok "deps installed"

say "Creating .dev.vars…"
if [ ! -f .dev.vars ]; then
  cp .dev.vars.example .dev.vars
  warn ".dev.vars created from example — EDIT it and put your real BOT_TOKEN + secrets."
else
  ok ".dev.vars already exists"
fi

# Generate missing secrets if placeholders remain.
gen() { node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"; }
for VAR in WEBHOOK_SECRET LINK_SECRET ADMIN_SETUP_KEY; do
  if grep -q "^${VAR}=change-me" .dev.vars 2>/dev/null; then
    V=$(gen); sed -i "s|^${VAR}=.*|${VAR}=${V}|" .dev.vars; warn "generated ${VAR} in .dev.vars"
  fi
done

say "Running unit tests…"
npm test --silent && ok "unit tests pass" || warn "unit tests had failures (see above)"

say "Running worker E2E…"
node scripts/e2e.mjs && ok "e2e pass" || warn "e2e had failures (see above)"

say "Live backend check…"
node scripts/live-check.mjs || warn "some backends unreachable now"

# ── GitHub secrets via gh ────────────────────────────────────────────────────
if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  say "gh CLI detected — setting repo secrets…"
  read -r -p "Set GitHub secrets now? [y/N] " ANS
  if [ "${ANS:-n}" = "y" ]; then
    val() { grep "^$1=" .dev.vars | cut -d= -f2-; }
    set_secret() { [ -n "$2" ] && printf "%s" "$2" | gh secret set "$1" && ok "secret $1 set"; }
    set_secret BOT_TOKEN "$(val BOT_TOKEN)"
    set_secret WEBHOOK_SECRET "$(val WEBHOOK_SECRET)"
    set_secret LINK_SECRET "$(val LINK_SECRET)"
    set_secret ADMIN_SETUP_KEY "$(val ADMIN_SETUP_KEY)"
    echo "Also set CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID manually (not in .dev.vars):"
    echo "  gh secret set CLOUDFLARE_API_TOKEN"
    echo "  gh secret set CLOUDFLARE_ACCOUNT_ID"
  fi
else
  warn "gh CLI not installed/authed — set secrets in repo Settings > Secrets > Actions."
fi

cat <<EOF

$(ok "Bootstrap complete")

Next steps:
  1. Edit .dev.vars and put your real BOT_TOKEN (from @BotFather).
  2. Add GitHub secrets (if not done): CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID,
     BOT_TOKEN, WEBHOOK_SECRET, LINK_SECRET, ADMIN_SETUP_KEY.
  3. Push to main, then in the repo's Actions tab run "Deploy" (workflow_dispatch).
  4. Enable inline mode in @BotFather: /setinline, /setinlinefeedback,
     /setprivacy -> Disable (for groups), /setjoingroups -> Enable.

See README.md for the full guide.
EOF
