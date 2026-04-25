#!/usr/bin/env bash
set -euo pipefail

# byob installer
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/wxtsky/byob/main/install.sh | bash
#   or:  bash <(curl -fsSL https://raw.githubusercontent.com/wxtsky/byob/main/install.sh)

REPO="https://github.com/wxtsky/byob.git"
INSTALL_DIR="${BYOB_INSTALL_DIR:-$HOME/byob}"

# ── colors ──────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
RESET='\033[0m'

info()  { printf "${BOLD}%s${RESET}\n" "$*"; }
ok()    { printf "  ${GREEN}✓${RESET} %s\n" "$*"; }
warn()  { printf "  ${YELLOW}⚠${RESET} %s\n" "$*"; }
fail()  { printf "  ${RED}✗${RESET} %s\n" "$*"; }
die()   { fail "$*"; exit 1; }

# ── check prerequisites ────────────────────────────────────────────────
info "Checking prerequisites..."

# Node.js >= 20
if command -v node &>/dev/null; then
  NODE_VER=$(node -v | sed 's/^v//' | cut -d. -f1)
  if [ "$NODE_VER" -ge 20 ] 2>/dev/null; then
    ok "Node.js $(node -v)"
  else
    die "Node.js >= 20 required (found $(node -v)). Install from https://nodejs.org"
  fi
else
  die "Node.js not found. Install from https://nodejs.org (>= 20)"
fi

# bun
if command -v bun &>/dev/null; then
  ok "bun $(bun -v)"
else
  warn "bun not found."
  printf "     Install bun now? [Y/n] "
  read -r REPLY </dev/tty 2>/dev/null || REPLY="y"
  case "$REPLY" in
    [nN]*) die "bun is required. Install manually: curl -fsSL https://bun.sh/install | bash" ;;
    *)
      curl -fsSL https://bun.sh/install | bash
      # Source bun into current shell
      export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
      export PATH="$BUN_INSTALL/bin:$PATH"
      if command -v bun &>/dev/null; then
        ok "bun $(bun -v) installed"
      else
        die "bun installation failed. Install manually: curl -fsSL https://bun.sh/install | bash"
      fi
      ;;
  esac
fi

# git
if command -v git &>/dev/null; then
  ok "git $(git --version | awk '{print $3}')"
else
  die "git not found. Install git first."
fi

# Chrome (best-effort check)
CHROME_FOUND=false
case "$(uname -s)" in
  Darwin)
    [ -d "/Applications/Google Chrome.app" ] && CHROME_FOUND=true
    [ -d "/Applications/Brave Browser.app" ] && CHROME_FOUND=true
    [ -d "/Applications/Microsoft Edge.app" ] && CHROME_FOUND=true
    ;;
  *)
    command -v google-chrome &>/dev/null && CHROME_FOUND=true
    command -v google-chrome-stable &>/dev/null && CHROME_FOUND=true
    command -v brave-browser &>/dev/null && CHROME_FOUND=true
    ;;
esac
if [ "$CHROME_FOUND" = true ]; then
  ok "Chrome-based browser detected"
else
  warn "Chrome/Brave/Edge not detected (may still work if installed elsewhere)"
fi

echo ""

# ── clone or update ────────────────────────────────────────────────────
if [ -d "$INSTALL_DIR/.git" ]; then
  info "Updating existing installation at $INSTALL_DIR..."
  git -C "$INSTALL_DIR" pull --ff-only 2>/dev/null || {
    warn "git pull failed — continuing with existing version"
  }
else
  info "Cloning byob to $INSTALL_DIR..."
  git clone "$REPO" "$INSTALL_DIR"
fi

echo ""

# ── install dependencies ───────────────────────────────────────────────
info "Installing dependencies..."
cd "$INSTALL_DIR"
bun install

echo ""

# ── run setup (key gen + extension build + NM manifest + tool chooser) ─
info "Running setup..."
bun run setup </dev/tty

echo ""
info "Installation complete. Follow the steps above to finish setup."
echo ""
