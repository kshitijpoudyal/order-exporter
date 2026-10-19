#!/usr/bin/env bash
# Builds the Chrome Web Store upload zip: only the files the extension needs.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./manifest.json').version")
OUT="dist/order-history-exporter-${VERSION}.zip"
mkdir -p dist
rm -f "$OUT"
zip -qr "$OUT" manifest.json icons popup pages src vendor -x '*.DS_Store'
# Sanity checks: no test files, no remote scripts, no eval.
if unzip -l "$OUT" | grep -qE 'tests/|\.pem|node_modules'; then echo "unexpected files in package"; exit 1; fi
if unzip -p "$OUT" '*.html' | grep -qiE '<script[^>]+src="https?:'; then echo "remote script tag found"; exit 1; fi
if unzip -p "$OUT" 'src/*' 'popup/*.js' 'pages/*.js' | grep -qE '\beval\(|new Function\('; then echo "eval found"; exit 1; fi
echo "Built $OUT ($(du -h "$OUT" | cut -f1))"
unzip -l "$OUT" | tail -1
