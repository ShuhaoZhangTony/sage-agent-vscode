#!/usr/bin/env bash
# ── sage-agent-vscode quickstart ───────────────────────────────────────────
set -euo pipefail

echo "Installing Node dependencies…"
npm install

echo "Building extension…"
npm run compile

echo ""
echo "Done. Open this folder in VS Code and press F5 to launch the Extension Development Host."
echo ""
echo "To package:"
echo "  npm run package && npx vsce package"
