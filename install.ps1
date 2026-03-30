# OpenClaw Custom UI Installer (Windows)
param([string]$Path)

$ErrorActionPreference = "Stop"

$globalPrefix = (npm prefix -g 2>$null).Trim()
$candidate = Join-Path $globalPrefix "node_modules\openclaw\dist\control-ui"
if ($Path) { $candidate = $Path }

if (-not (Test-Path $candidate)) {
    Write-Host "ERROR: Could not find OpenClaw control-ui at: $candidate" -ForegroundColor Red
    Write-Host "Make sure OpenClaw is installed: npm install -g openclaw"
    exit 1
}

Write-Host "Installing Custom UI to: $candidate" -ForegroundColor Cyan

$origIndex = Join-Path $candidate "index.html"
$origBackup = Join-Path $candidate "index-original.html"
if ((Test-Path $origIndex) -and -not (Test-Path $origBackup)) {
    $content = Get-Content $origIndex -Raw -ErrorAction SilentlyContinue
    if ($content -and -not ($content -match "openclawUIVersion")) {
        Move-Item $origIndex $origBackup -Force
        Write-Host "  Renamed official index.html -> index-original.html" -ForegroundColor Yellow
    }
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$files = @("index.html", "chat.js", "render.js", "panels.js", "dark.html", "dark.js", "light.html", "light.js", "retro.html", "retro.js")
foreach ($file in $files) {
    $src = Join-Path $scriptDir $file
    if (Test-Path $src) {
        Copy-Item $src (Join-Path $candidate $file) -Force
        Write-Host "  Copied $file" -ForegroundColor Green
    }
}

# Save to ~/.openclaw/custom-ui for auto-restore
$backup = Join-Path $env:USERPROFILE ".openclaw\custom-ui"
New-Item -ItemType Directory -Force -Path $backup | Out-Null
foreach ($file in $files) {
    $src = Join-Path $scriptDir $file
    if (Test-Path $src) { Copy-Item $src (Join-Path $backup $file) -Force }
}

Write-Host ""
Write-Host "Done! Themes: v1 (dark), v7 (light), v9 (retro)" -ForegroundColor Green
Write-Host "Open with: openclaw dashboard"
Write-Host "After updates: powershell -File ~/.openclaw/restore-custom-ui.ps1"
