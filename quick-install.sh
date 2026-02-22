#!/usr/bin/env bash
set -euo pipefail

# FromYourPhone one-command installer.
# Works with:
#   curl -fsSL https://raw.githubusercontent.com/testinganddeveloping1-ux/vibecodefromanywhere/main/quick-install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/testinganddeveloping1-ux/vibecodefromanywhere/main/quick-install.sh | bash -s -- --start
#
# Env overrides:
#   FYP_REPO=org/repo
#   FYP_BRANCH=main
#   FYP_GIT_URL=https://github.com/org/repo.git
#   FYP_TARBALL_URL=https://github.com/org/repo/archive/refs/heads/main.tar.gz
#   FYP_INSTALL_METHOD=auto|git|tarball
#   FYP_BASE_DIR=$HOME/.fromyourphone
#   FYP_APP_DIR=$HOME/.fromyourphone/app
#   FYP_BIN_DIR=$HOME/.local/bin
#   FYP_BACKUP_OLD=1|0
#   FYP_NPM_LINK_MODE=1|0

DEFAULT_REPO="testinganddeveloping1-ux/vibecodefromanywhere"
REPO="${FYP_REPO:-$DEFAULT_REPO}"
BRANCH="${FYP_BRANCH:-main}"
INSTALL_METHOD="${FYP_INSTALL_METHOD:-auto}" # auto|git|tarball

BASE_DIR="${FYP_BASE_DIR:-$HOME/.fromyourphone}"
APP_DIR="${FYP_APP_DIR:-$BASE_DIR/app}"
BIN_DIR="${FYP_BIN_DIR:-$HOME/.local/bin}"

BACKUP_OLD="${FYP_BACKUP_OLD:-1}"
NPM_LINK_MODE="${FYP_NPM_LINK_MODE:-0}"

START_AFTER=0
START_LAN=0
QUIET=0
FORCE=0

usage() {
  cat <<'EOF'
FromYourPhone quick installer

Usage:
  quick-install.sh [options]

Options:
  --start            Start the server after installation.
  --lan              With --start, expose server on LAN (same as `fromyourphone start --lan`).
  --quiet            Reduce installer output.
  --force            Overwrite existing app without prompt.
  --no-backup        Replace existing install without keeping backup.
  --method <m>       Install method: auto | git | tarball
  --repo <org/repo>  GitHub repository override.
  --branch <name>    Git branch/tag name override.
  --base-dir <path>  Base install directory (default: ~/.fromyourphone).
  --app-dir <path>   App directory (default: <base-dir>/app).
  --bin-dir <path>   Binary directory for `fromyourphone` shim (default: ~/.local/bin).
  --help             Show this help.
EOF
}

log() {
  if [ "$QUIET" -eq 0 ]; then
    printf '%s\n' "$*"
  fi
}

warn() {
  printf 'warning: %s\n' "$*" >&2
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

resolve_download_bin() {
  if command -v curl >/dev/null 2>&1; then
    printf 'curl\n'
    return 0
  fi
  if command -v wget >/dev/null 2>&1; then
    printf 'wget\n'
    return 0
  fi
  return 1
}

download_file() {
  local url="$1"
  local out="$2"
  local dl
  dl="$(resolve_download_bin || true)"
  [ -n "$dl" ] || die "Need curl or wget to download source archives."
  if [ "$dl" = "curl" ]; then
    curl -fsSL "$url" -o "$out"
  else
    wget -qO "$out" "$url"
  fi
}

stop_running_server() {
  local pid_file="$BASE_DIR/server.pid"
  [ -f "$pid_file" ] || return 0

  local pid=""
  pid="$(
    node -e '
      const fs = require("fs");
      try {
        const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        process.stdout.write(String(j && j.pid ? j.pid : ""));
      } catch {
        process.stdout.write("");
      }
    ' "$pid_file" 2>/dev/null || true
  )"

  if [ -z "$pid" ]; then
    rm -f "$pid_file" >/dev/null 2>&1 || true
    return 0
  fi

  if kill -0 "$pid" >/dev/null 2>&1; then
    log "Stopping running FromYourPhone server (pid $pid)..."
    kill -INT "$pid" >/dev/null 2>&1 || true
    local i=0
    while kill -0 "$pid" >/dev/null 2>&1; do
      i=$((i + 1))
      if [ "$i" -ge 60 ]; then
        warn "Server did not exit in time; sending SIGKILL."
        kill -KILL "$pid" >/dev/null 2>&1 || true
        break
      fi
      sleep 0.1
    done
  fi

  rm -f "$pid_file" >/dev/null 2>&1 || true
}

fetch_source_git() {
  local target="$1"
  local git_url="${FYP_GIT_URL:-https://github.com/${REPO}.git}"
  need_cmd git
  log "Cloning source via git (${REPO}@${BRANCH})..."
  git clone --depth 1 --branch "$BRANCH" "$git_url" "$target" >/dev/null 2>&1
}

fetch_source_tarball() {
  local target="$1"
  local tmp="$2"
  local tarball_url="${FYP_TARBALL_URL:-https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz}"
  need_cmd tar
  log "Downloading source tarball (${REPO}@${BRANCH})..."
  local tgz="$tmp/src.tgz"
  download_file "$tarball_url" "$tgz"
  tar -xzf "$tgz" -C "$tmp"
  local extracted
  extracted="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  [ -n "$extracted" ] || die "Could not locate extracted source directory."
  mv "$extracted" "$target"
}

install_source() {
  local target="$1"
  local tmp="$2"
  case "$INSTALL_METHOD" in
    git)
      fetch_source_git "$target"
      ;;
    tarball)
      fetch_source_tarball "$target" "$tmp"
      ;;
    auto)
      if command -v git >/dev/null 2>&1; then
        if fetch_source_git "$target"; then
          return 0
        fi
        warn "Git clone failed; falling back to tarball."
      fi
      fetch_source_tarball "$target" "$tmp"
      ;;
    *)
      die "Invalid --method '$INSTALL_METHOD' (expected auto|git|tarball)."
      ;;
  esac
}

install_cli_shim() {
  mkdir -p "$BIN_DIR"
  local target="$BIN_DIR/fromyourphone"
  if ln -sfn "$APP_DIR/dist/cli.js" "$target" 2>/dev/null; then
    return 0
  fi
  cat >"$target" <<EOF
#!/usr/bin/env bash
exec "$APP_DIR/dist/cli.js" "\$@"
EOF
  chmod +x "$target"
}

path_contains() {
  case ":$PATH:" in
    *":$1:"*) return 0 ;;
    *) return 1 ;;
  esac
}

confirm_replace_if_needed() {
  [ -d "$APP_DIR" ] || return 0
  if [ "$FORCE" -eq 1 ]; then
    return 0
  fi
  if [ ! -t 0 ]; then
    return 0
  fi
  printf 'Existing install found at %s. Replace it? [Y/n] ' "$APP_DIR"
  read -r reply
  case "${reply:-y}" in
    y|Y|yes|YES|"") return 0 ;;
    *) die "Install cancelled." ;;
  esac
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --start)
      START_AFTER=1
      shift
      ;;
    --lan)
      START_LAN=1
      shift
      ;;
    --quiet)
      QUIET=1
      shift
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --no-backup)
      BACKUP_OLD=0
      shift
      ;;
    --method)
      INSTALL_METHOD="${2:-}"
      [ -n "$INSTALL_METHOD" ] || die "Missing value for --method."
      shift 2
      ;;
    --repo)
      REPO="${2:-}"
      [ -n "$REPO" ] || die "Missing value for --repo."
      shift 2
      ;;
    --branch)
      BRANCH="${2:-}"
      [ -n "$BRANCH" ] || die "Missing value for --branch."
      shift 2
      ;;
    --base-dir)
      BASE_DIR="${2:-}"
      [ -n "$BASE_DIR" ] || die "Missing value for --base-dir."
      shift 2
      ;;
    --app-dir)
      APP_DIR="${2:-}"
      [ -n "$APP_DIR" ] || die "Missing value for --app-dir."
      shift 2
      ;;
    --bin-dir)
      BIN_DIR="${2:-}"
      [ -n "$BIN_DIR" ] || die "Missing value for --bin-dir."
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown option: $1 (use --help)."
      ;;
  esac
done

need_cmd node
need_cmd npm

tmp="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp" >/dev/null 2>&1 || true
}
trap cleanup EXIT

src_dir="$tmp/source"
install_source "$src_dir" "$tmp"

mkdir -p "$BASE_DIR"
confirm_replace_if_needed
stop_running_server

if [ -d "$APP_DIR" ]; then
  if [ "$BACKUP_OLD" = "1" ]; then
    backup="$BASE_DIR/app.bak.$(date +%s)"
    log "Backing up existing install to: $backup"
    mv "$APP_DIR" "$backup"
  else
    log "Removing existing install: $APP_DIR"
    rm -rf "$APP_DIR"
  fi
fi

log "Installing app to: $APP_DIR"
mv "$src_dir" "$APP_DIR"

cd "$APP_DIR"
log "Installing dependencies..."
if [ -f package-lock.json ]; then
  npm ci --no-fund --no-audit || npm install --no-fund --no-audit
else
  npm install --no-fund --no-audit
fi

log "Building..."
npm run build
chmod +x "$APP_DIR/dist/cli.js" 2>/dev/null || true

install_cli_shim

if [ "$NPM_LINK_MODE" = "1" ]; then
  if npm link >/dev/null 2>&1; then
    log "Installed npm global link."
  else
    warn "npm link failed; continuing with local shim in $BIN_DIR."
  fi
fi

echo ""
echo "FromYourPhone installed successfully."
echo "App: $APP_DIR"
echo "CLI: $BIN_DIR/fromyourphone"
echo ""

if path_contains "$BIN_DIR"; then
  echo "Run:"
  echo "  fromyourphone start"
  echo "  fromyourphone start --lan    # optional"
else
  echo "Add this to your shell profile:"
  echo "  export PATH=\"$BIN_DIR:\$PATH\""
  echo ""
  echo "Then run:"
  echo "  fromyourphone start"
  echo ""
  echo "Immediate fallback command:"
  echo "  node \"$APP_DIR/dist/cli.js\" start"
fi

if [ "$START_AFTER" -eq 1 ]; then
  echo ""
  log "Starting FromYourPhone now..."
  if path_contains "$BIN_DIR"; then
    if [ "$START_LAN" -eq 1 ]; then
      exec fromyourphone start --lan
    fi
    exec fromyourphone start
  else
    if [ "$START_LAN" -eq 1 ]; then
      exec node "$APP_DIR/dist/cli.js" start --lan
    fi
    exec node "$APP_DIR/dist/cli.js" start
  fi
fi
