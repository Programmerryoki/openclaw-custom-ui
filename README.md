# OpenClaw Custom UI

Custom chat themes for [OpenClaw](https://docs.openclaw.ai) gateway.

## Themes

| Theme | Description |
|-------|-------------|
| **Dark** | 4-column layout with icon nav, sidebar, chat, and activity panel |
| **Light** | Clean 2-panel layout with live context panel |
| **Retro** | Pixel-art RPG terminal with CRT effects and RPG stats |

## Features

- Persistent sessions (agent context carries across messages)
- Live stats from gateway (context usage, cost, model)
- Model switching (click model name to change)
- Stop button to cancel generation
- Server-side chat history
- Markdown, code blocks, tables, LaTeX math rendering
- Multi-session support (create, switch, delete)
- Real-time activity panel (agent and tool events)
- Collapsible and resizable panels
- Auto-restore after OpenClaw updates

## Install

```bash
git clone <this-repo>
cd openclaw-custom-ui

# Linux / macOS
./install.sh

# Windows (PowerShell)
.\install.ps1
```

Then open with:
```bash
openclaw dashboard
```

## Update OpenClaw (without losing the custom UI)

```bash
bash ~/.openclaw/update-openclaw.sh
```

This runs `npm update -g openclaw` and restores the custom UI automatically.

## Restore (if custom UI was overwritten)

```bash
# Linux / macOS
bash ~/.openclaw/restore-custom-ui.sh

# Windows (PowerShell)
powershell -File $HOME\.openclaw\restore-custom-ui.ps1
```

## Uninstall

Delete the custom UI files from the OpenClaw control-ui directory:

```bash
# Find your OpenClaw install
npm prefix -g
# Remove custom files from: <prefix>/node_modules/openclaw/dist/control-ui/
# Files: index.html, dark.*, light.*, retro.*, chat.js, render.js, panels.js

# Also remove the backup
rm -rf ~/.openclaw/custom-ui
```

The original OpenClaw UI will be restored on the next `npm update -g openclaw`.

## File Structure

```
index.html        Version selector
dark.html/.js     Dark theme
light.html/.js    Light theme
retro.html/.js    Retro theme
chat.js           Shared chat client
render.js         Markdown renderer
panels.js         Panel manager
install.sh/.ps1   Installers
restore-custom-ui.sh   Post-update restore
update-openclaw.sh     Update + restore
```

## License

MIT
