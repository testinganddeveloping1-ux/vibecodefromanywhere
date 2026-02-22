#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

GLOBAL=0
USE_NPM_LINK=0
BIN_DIR="${FYP_BIN_DIR:-$HOME/.local/bin}"

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

Options:
  --global       Install `fromyourphone` command into ~/.local/bin (default bin dir).
  --npm-link     With --global, use `npm link` instead of ~/.local/bin shim.
  --bin-dir DIR  With --global, override shim target directory.
  --help         Show this help.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --global)
      GLOBAL=1
      shift
      ;;
    --npm-link)
      USE_NPM_LINK=1
      shift
      ;;
    --bin-dir)
      BIN_DIR="${2:-}"
      [ -n "$BIN_DIR" ] || { echo "Missing value for --bin-dir" >&2; exit 2; }
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

command -v node >/dev/null 2>&1 || { echo "Node.js is required." >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "npm is required." >&2; exit 1; }

echo "Installing dependencies..."
if [ -f package-lock.json ]; then
  npm ci --no-fund --no-audit || npm install --no-fund --no-audit
else
  npm install --no-fund --no-audit
fi

echo "Building..."
npm run build
chmod +x dist/cli.js 2>/dev/null || true

if [ "$GLOBAL" -eq 1 ]; then
  echo ""
  if [ "$USE_NPM_LINK" -eq 1 ]; then
    echo "Installing global CLI via npm link..."
    if npm link >/dev/null 2>&1; then
      echo "Installed. Run: fromyourphone start"
      exit 0
    fi
    echo "npm link failed; falling back to local shim in $BIN_DIR" >&2
  fi

  mkdir -p "$BIN_DIR"
  ln -sfn "$(pwd)/dist/cli.js" "$BIN_DIR/fromyourphone" 2>/dev/null || {
    cat >"$BIN_DIR/fromyourphone" <<EOF
#!/usr/bin/env bash
exec "$(pwd)/dist/cli.js" "\$@"
EOF
    chmod +x "$BIN_DIR/fromyourphone"
  }

  echo "Installed CLI shim: $BIN_DIR/fromyourphone"
  case ":$PATH:" in
    *":$BIN_DIR:"*)
      echo "Run: fromyourphone start"
      ;;
    *)
      echo "Add to PATH:"
      echo "  export PATH=\"$BIN_DIR:\$PATH\""
      echo "Then run: fromyourphone start"
      ;;
  esac
else
  echo ""
  echo "Installed. Run:"
  echo "  npm start"
  echo ""
  echo "Tip: install a global 'fromyourphone' command:"
  echo "  ./install.sh --global"
fi
