#!/usr/bin/env bash
set -euo pipefail

# byob installer
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/wxtsky/byob/main/install.sh | bash
#   or:  bash <(curl -fsSL https://raw.githubusercontent.com/wxtsky/byob/main/install.sh)

REPO="${BYOB_REPO:-https://github.com/wxtsky/byob.git}"
REF="${BYOB_REF:-}"
ASSUME_YES="${BYOB_ASSUME_YES:-}"
SKIP_SETUP="${BYOB_SKIP_SETUP:-}"

case "$(uname -s)" in
  Darwin) OS="macos" ;;
  MINGW*|MSYS*|CYGWIN*) OS="windows" ;;
  Linux) OS="linux" ;;
  *) OS="unsupported" ;;
esac

if [ "$OS" = "windows" ]; then
  DEFAULT_INSTALL_DIR="${HOME:-${USERPROFILE:-}}/byob"
else
  DEFAULT_INSTALL_DIR="$HOME/byob"
fi
INSTALL_DIR="${BYOB_INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
if [ "$OS" = "windows" ] && command -v cygpath &>/dev/null; then
  case "$INSTALL_DIR" in
    [A-Za-z]:\\*|[A-Za-z]:/*) INSTALL_DIR="$(cygpath -u "$INSTALL_DIR")" ;;
  esac
fi

if [ -r /dev/tty ] && [ -w /dev/tty ]; then
  HAS_TTY=true
else
  HAS_TTY=false
fi

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

if [ "$OS" = "unsupported" ]; then
  die "Unsupported OS: $(uname -s). This installer supports macOS, Windows Git Bash/MSYS, and Linux."
fi
if [ -z "$INSTALL_DIR" ] || [ "$INSTALL_DIR" = "/byob" ]; then
  die "Could not determine install directory. Set BYOB_INSTALL_DIR explicitly."
fi

is_yes() {
  case "$1" in
    1|y|Y|yes|YES|true|TRUE) return 0 ;;
    *) return 1 ;;
  esac
}

prompt_yes_no() {
  local prompt="$1"
  local default="${2:-y}"
  local reply
  if [ "$HAS_TTY" != true ]; then
    is_yes "$ASSUME_YES"
    return $?
  fi
  if [ "$default" = "y" ]; then
    printf "%s [Y/n] " "$prompt" >/dev/tty
  else
    printf "%s [y/N] " "$prompt" >/dev/tty
  fi
  read -r reply </dev/tty || reply=""
  case "$reply" in
    "") [ "$default" = "y" ] ;;
    [yY]|[yY][eE][sS]) true ;;
    *) false ;;
  esac
}

# ── check prerequisites ────────────────────────────────────────────────
info "Checking prerequisites..."
ok "OS $OS"

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
  if ! prompt_yes_no "     Install bun now?" "y"; then
    die "bun is required. Install manually: curl -fsSL https://bun.sh/install | bash"
  fi
  if [ "$OS" = "windows" ]; then
    if ! command -v powershell.exe &>/dev/null; then
      die "PowerShell is required to install bun on Windows. Install bun manually: https://bun.sh/docs/installation"
    fi
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command 'irm bun.sh/install.ps1 | iex'
    if command -v cygpath &>/dev/null && [ -n "${USERPROFILE:-}" ]; then
      export PATH="$(cygpath -u "$USERPROFILE")/.bun/bin:$PATH"
    else
      export PATH="$HOME/.bun/bin:$PATH"
    fi
  else
    if ! command -v curl &>/dev/null; then
      die "curl is required to install bun. Install curl or install bun manually: https://bun.sh"
    fi
    curl -fsSL https://bun.sh/install | bash
    # Source bun into current shell. Common Linux package managers can install
    # elsewhere, so prepend only the official installer path and then re-check.
    export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
    export PATH="$BUN_INSTALL/bin:$PATH"
  fi
  hash -r 2>/dev/null || true
  if command -v bun &>/dev/null; then
    ok "bun $(bun -v) installed"
  else
    die "bun installation failed. Install manually: curl -fsSL https://bun.sh/install | bash"
  fi
fi

# git
if command -v git &>/dev/null; then
  ok "git $(git --version | awk '{print $3}')"
else
  die "git not found. Install git first."
fi

# Chrome (best-effort check)
CHROME_FOUND=false
case "$OS" in
  macos)
    [ -d "/Applications/Google Chrome.app" ] && CHROME_FOUND=true
    [ -d "/Applications/Brave Browser.app" ] && CHROME_FOUND=true
    [ -d "/Applications/Microsoft Edge.app" ] && CHROME_FOUND=true
    ;;
  windows)
    command -v powershell.exe &>/dev/null && powershell.exe -NoProfile -Command '$pf = [Environment]::GetEnvironmentVariable("ProgramFiles"); $pf86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)"); $local = [Environment]::GetEnvironmentVariable("LOCALAPPDATA"); $paths = @("$pf\Google\Chrome\Application", "$pf86\Google\Chrome\Application", "$local\Google\Chrome\Application", "$pf\BraveSoftware\Brave-Browser\Application", "$local\BraveSoftware\Brave-Browser\Application", "$pf\Microsoft\Edge\Application", "$pf86\Microsoft\Edge\Application"); foreach ($p in $paths) { if ($p -and (Test-Path $p)) { exit 0 } }; exit 1' >/dev/null 2>&1 && CHROME_FOUND=true
    command -v where.exe &>/dev/null && where.exe chrome.exe >/dev/null 2>&1 && CHROME_FOUND=true
    command -v where.exe &>/dev/null && where.exe msedge.exe >/dev/null 2>&1 && CHROME_FOUND=true
    command -v where.exe &>/dev/null && where.exe brave.exe >/dev/null 2>&1 && CHROME_FOUND=true
    ;;
  linux)
    command -v google-chrome &>/dev/null && CHROME_FOUND=true
    command -v google-chrome-stable &>/dev/null && CHROME_FOUND=true
    command -v brave-browser &>/dev/null && CHROME_FOUND=true
    command -v microsoft-edge &>/dev/null && CHROME_FOUND=true
    command -v chromium &>/dev/null && CHROME_FOUND=true
    command -v chromium-browser &>/dev/null && CHROME_FOUND=true
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
  git -C "$INSTALL_DIR" fetch --prune
  if [ -n "$REF" ]; then
    git -C "$INSTALL_DIR" checkout "$REF"
  else
    git -C "$INSTALL_DIR" pull --ff-only
  fi
else
  if [ -e "$INSTALL_DIR" ]; then
    if [ -d "$INSTALL_DIR" ] && [ -z "$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 2>/dev/null)" ]; then
      rmdir "$INSTALL_DIR"
    else
      die "$INSTALL_DIR exists but is not a byob git checkout. Set BYOB_INSTALL_DIR to another path."
    fi
  fi
  info "Cloning byob to $INSTALL_DIR..."
  if [ -n "$REF" ]; then
    git clone "$REPO" "$INSTALL_DIR"
    git -C "$INSTALL_DIR" checkout "$REF"
  else
    git clone --depth 1 "$REPO" "$INSTALL_DIR"
  fi
fi

echo ""

# ── install dependencies ───────────────────────────────────────────────
info "Installing dependencies..."
cd "$INSTALL_DIR"
if [ -f bun.lock ] || [ -f bun.lockb ]; then
  bun install --frozen-lockfile
else
  bun install
fi

echo ""

# ── run setup (key gen + extension build + NM manifest + tool chooser) ─
if is_yes "$SKIP_SETUP"; then
  warn "Skipping setup because BYOB_SKIP_SETUP=$SKIP_SETUP"
else
  info "Running setup..."
  if [ "$HAS_TTY" = true ]; then
    bun run setup </dev/tty
  else
    die "setup is interactive and needs a TTY. Re-run in a terminal, or set BYOB_SKIP_SETUP=1 and run setup later."
  fi
fi

echo ""
info "Installation complete."
if is_yes "$SKIP_SETUP"; then
  printf "Next: cd %s && bun run setup\n" "$INSTALL_DIR"
else
  info "Follow the steps above to finish setup."
fi
echo ""
