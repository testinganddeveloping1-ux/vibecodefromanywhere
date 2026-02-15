#!/usr/bin/env bash
set -euo pipefail

# One-command install without git:
#   curl -fsSL https://raw.githubusercontent.com/testinganddeveloping1-ux/vibecodefromanywhere/main/quick-install.sh | bash
#
# Installs into ~/.fromyourphone/app and (best-effort) installs a global `fromyourphone` command via `npm link`.

REPO_TARBALL_URL="${FYP_TARBALL_URL:-https://github.com/testinganddeveloping1-ux/vibecodefromanywhere/archive/refs/heads/main.tar.gz}"
BASE_DIR="${FYP_BASE_DIR:-$HOME/.fromyourphone}"
APP_DIR="${FYP_APP_DIR:-$BASE_DIR/app}"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

need_cmd node
need_cmd npm
need_cmd tar

DL_BIN=""
if command -v curl >/dev/null 2>&1; then
  DL_BIN="curl"
elif command -v wget >/dev/null 2>&1; then
  DL_BIN="wget"
else
  echo "Missing required command: curl or wget" >&2
  exit 1
fi

tmp="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp" || true
}
trap cleanup EXIT

echo "Downloading: $REPO_TARBALL_URL"
tgz="$tmp/src.tgz"
if [ "$DL_BIN" = "curl" ]; then
  curl -fsSL "$REPO_TARBALL_URL" -o "$tgz"
else
  wget -qO "$tgz" "$REPO_TARBALL_URL"
fi

echo "Extracting..."
tar -xzf "$tgz" -C "$tmp"
src_dir="$(find "$tmp" -maxdepth 1 -type d -name 'vibecodefromanywhere-*' | head -n 1)"
if [ -z "${src_dir:-}" ] || [ ! -d "$src_dir" ]; then
  echo "Could not find extracted source directory." >&2
  exit 1
fi

mkdir -p "$BASE_DIR"
if [ -d "$APP_DIR" ]; then
  backup="$BASE_DIR/app.bak.$(date +%s)"
  echo "Backing up existing install to: $backup"
  mv "$APP_DIR" "$backup"
fi

echo "Installing to: $APP_DIR"
mv "$src_dir" "$APP_DIR"

cd "$APP_DIR"
echo "Installing dependencies..."
npm install --no-fund --no-audit

echo "Building..."
npm run build

# Ensure the installed CLI is executable when invoked via the global `fromyourphone` symlink.
chmod +x "$APP_DIR/dist/cli.js" 2>/dev/null || true

echo "Linking global CLI (best-effort)..."
if npm link >/dev/null 2>&1; then
  echo ""
  echo "Installed. Run:"
  echo "  fromyourphone start"
else
  echo ""
  echo "Could not install a global command. You can still run:"
  echo "  node \"$APP_DIR/dist/cli.js\" start"
  echo ""
  echo "If you want a global command, set a writable npm prefix and retry:"
  echo "  npm config set prefix \"$HOME/.npm-global\""
  echo "  export PATH=\"$HOME/.npm-global/bin:\$PATH\""
  echo "  cd \"$APP_DIR\" && npm link"
fi
