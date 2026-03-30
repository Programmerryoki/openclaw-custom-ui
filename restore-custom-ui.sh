#!/bin/bash
# Restore OpenClaw custom UI files after npm update
# Source: ~/.openclaw/custom-ui/
# Target: <npm-global>/node_modules/openclaw/dist/control-ui/
#
# Usage: bash ~/.openclaw/restore-custom-ui.sh
# Or add as npm postinstall hook

set -e

BACKUP="$HOME/.openclaw/custom-ui"
PREFIX=$(npm prefix -g 2>/dev/null)
DEST="$PREFIX/node_modules/openclaw/dist/control-ui"

if [ ! -d "$BACKUP" ]; then
  echo "No custom UI backup found at $BACKUP"
  exit 1
fi

if [ ! -d "$DEST" ]; then
  echo "OpenClaw control-ui not found at $DEST"
  exit 1
fi

# Rename official index.html if it doesn't look like our selector
if [ -f "$DEST/index.html" ] && ! grep -q "oc-model-subtitle\|openclawUIVersion" "$DEST/index.html" 2>/dev/null; then
  mv "$DEST/index.html" "$DEST/index-original.html"
  echo "Renamed official index.html -> index-original.html"
fi

# Copy all custom files
cp "$BACKUP"/*.html "$DEST/" 2>/dev/null
cp "$BACKUP"/*.js "$DEST/" 2>/dev/null

echo "Restored custom UI files to $DEST"
ls "$DEST/"*.html "$DEST/"*.js 2>/dev/null | while read f; do echo "  $(basename "$f")"; done
