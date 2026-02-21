#!/usr/bin/env bash
# setup.sh — installs the conversation extractor hook into OpenClaw
#
# Usage:
#   ./setup.sh          # install
#   ./setup.sh --remove # uninstall

set -euo pipefail

HOOK_NAME="conversation-extractor"
HOOK_DIR="${HOME}/.openclaw/hooks/${HOOK_NAME}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Verify openclaw is installed ─────────────────────────────────────────────
if ! command -v openclaw &>/dev/null; then
  echo "Error: openclaw not found. Install it first:"
  echo "  npm install -g openclaw"
  exit 1
fi

# ── Remove mode ──────────────────────────────────────────────────────────────
if [[ "${1:-}" == "--remove" ]]; then
  echo "Disabling and removing hook: ${HOOK_NAME}"
  openclaw hooks disable "${HOOK_NAME}" 2>/dev/null || true
  rm -rf "${HOOK_DIR}"
  echo "Done. Restart the OpenClaw gateway for changes to take effect:"
  echo "  openclaw gateway stop && openclaw gateway"
  exit 0
fi

# ── Install ──────────────────────────────────────────────────────────────────
echo "Installing hook: ${HOOK_NAME}"
echo "  Destination: ${HOOK_DIR}"

mkdir -p "${HOOK_DIR}"
cp "${SCRIPT_DIR}/hook/HOOK.md"    "${HOOK_DIR}/HOOK.md"
cp "${SCRIPT_DIR}/hook/handler.js" "${HOOK_DIR}/handler.js"

openclaw hooks enable "${HOOK_NAME}"

echo ""
echo "Hook installed and enabled."
echo ""
echo "Output:"
echo "  ~/.openclaw/conversation-extractor.log"
echo ""
echo "Restart the gateway to activate:"
echo "  openclaw gateway stop && openclaw gateway"
