#!/bin/bash
# Update OpenClaw and auto-restore custom UI
# Usage: bash ~/.openclaw/update-openclaw.sh

set -e
echo "Updating OpenClaw..."
npm update -g openclaw

echo ""
echo "Restoring custom UI..."
bash "$HOME/.openclaw/restore-custom-ui.sh"

echo ""
openclaw --version
echo "Done!"
