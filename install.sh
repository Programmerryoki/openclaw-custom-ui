#!/bin/bash
# OpenClaw Custom UI Installer
# Installs all custom UI themes into your OpenClaw control-ui directory

set -e

OPENCLAW_UI=""
for DIR in \
  "$(npm prefix -g 2>/dev/null)/node_modules/openclaw/dist/control-ui" \
  "$HOME/.npm-global/node_modules/openclaw/dist/control-ui" \
  "/usr/local/lib/node_modules/openclaw/dist/control-ui" \
  "/usr/lib/node_modules/openclaw/dist/control-ui"; do
  if [ -d "$DIR" ]; then
    OPENCLAW_UI="$DIR"
    break
  fi
done

if [ -n "$1" ]; then OPENCLAW_UI="$1"; fi

if [ -z "$OPENCLAW_UI" ]; then
  echo "ERROR: Could not find OpenClaw control-ui directory."
  echo "Make sure OpenClaw is installed: npm install -g openclaw"
  echo "Or specify the path: ./install.sh /path/to/control-ui"
  exit 1
fi

echo "Installing Custom UI to: $OPENCLAW_UI"

# Rename official index.html
if [ -f "$OPENCLAW_UI/index.html" ] && ! grep -q "openclawUIVersion" "$OPENCLAW_UI/index.html" 2>/dev/null; then
  mv "$OPENCLAW_UI/index.html" "$OPENCLAW_UI/index-original.html"
  echo "  Renamed official index.html -> index-original.html"
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FILES="index.html chat.js render.js panels.js dark.html dark.js light.html light.js retro.html retro.js"
for FILE in $FILES; do
  if [ -f "$SCRIPT_DIR/$FILE" ]; then
    cp "$SCRIPT_DIR/$FILE" "$OPENCLAW_UI/$FILE"
    echo "  Copied $FILE"
  fi
done

# Also save to ~/.openclaw/custom-ui for auto-restore after updates
BACKUP="$HOME/.openclaw/custom-ui"
mkdir -p "$BACKUP"
for FILE in $FILES; do
  if [ -f "$SCRIPT_DIR/$FILE" ]; then
    cp "$SCRIPT_DIR/$FILE" "$BACKUP/$FILE"
  fi
done
if [ -f "$SCRIPT_DIR/restore-custom-ui.sh" ]; then
  cp "$SCRIPT_DIR/restore-custom-ui.sh" "$HOME/.openclaw/restore-custom-ui.sh"
fi

echo ""
echo "Done! Themes installed:"
echo "  v1 — Dark GitHub theme (4-column layout)"
echo "  v7 — Clean light theme (2-panel layout)"
echo "  v9 — Retro pixel art theme"
echo ""
echo "Open with: openclaw dashboard"
echo "After updates: bash ~/.openclaw/restore-custom-ui.sh"
