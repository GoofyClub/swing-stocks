# Windows PowerShell. Docker Desktop must be running in Linux-container mode.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
New-Item -ItemType Directory -Force data | Out-Null
Write-Host 'Stop the old SWING installation before starting this one. Use the same dedicated paper account.'
docker compose version
if ($LASTEXITCODE -ne 0) { throw 'Install/start Docker Desktop with Compose first.' }
docker compose build
if ($LASTEXITCODE -ne 0) { throw 'Image build failed.' }
docker compose run --rm --no-deps swing python3 packaging/configure.py --windows
if ($LASTEXITCODE -ne 0) { throw 'Configuration failed; nothing started.' }
docker compose up -d --wait
if ($LASTEXITCODE -ne 0) { throw 'Startup failed. Inspect docker compose logs --tail=100.' }
Write-Host 'Local dashboard: http://127.0.0.1:8444'
Write-Host 'Verify /healthcheck, /positions and /config in Telegram. Starts paused and DRY_RUN=true; see PC-INSTALL.md.'
