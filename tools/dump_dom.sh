#!/usr/bin/env bash
set -euo pipefail

URL="${1:-}"
OUT="${2:-}"

if [[ -z "$URL" ]]; then
  echo "Usage: $(basename "$0") <url> [out.html]" >&2
  echo "Example: $(basename "$0") http://127.0.0.1:7444/ opencode-dom.html" >&2
  exit 1
fi

if [[ -z "$OUT" ]]; then
  OUT="dom-$(date +%Y%m%d-%H%M%S).html"
fi

CHROME_BIN="${CHROME_BIN:-google-chrome}"
if ! command -v "$CHROME_BIN" >/dev/null 2>&1; then
  echo "Chrome not found. Install google-chrome/chromium or set CHROME_BIN." >&2
  exit 1
fi

# --dump-dom prints the post-load DOM (useful for SPAs where Ctrl+U shows only the base HTML).
# --no-sandbox is needed in some environments (containers/CI); harmless on desktop.
"$CHROME_BIN" --headless=new --disable-gpu --no-sandbox --dump-dom "$URL" >"$OUT"
echo "Wrote $OUT" >&2

