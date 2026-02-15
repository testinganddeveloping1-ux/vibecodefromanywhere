#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

GLOBAL=0
for arg in "${@:-}"; do
  case "$arg" in
    --global)
      GLOBAL=1
      ;;
    *)
      echo "Unknown option: $arg" >&2
      echo "Usage: ./install.sh [--global]" >&2
      exit 2
      ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required." >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required." >&2
  exit 1
fi

npm install --no-fund --no-audit
npm run build
chmod +x dist/cli.js 2>/dev/null || true

echo ""
if [ "$GLOBAL" -eq 1 ]; then
  echo "Installing global CLI (fromyourphone)..."
  if npm link >/dev/null 2>&1; then
    echo ""
    echo "Installed. Run:"
    echo "  fromyourphone start"
  else
    echo "Global install failed. You can still run:"
    echo "  npm start"
    echo "or:"
    echo "  node dist/cli.js start"
  fi
else
  echo "Installed. Run:"
  echo "  npm start"
  echo ""
  echo "Tip: install a global 'fromyourphone' command:"
  echo "  ./install.sh --global"
fi
