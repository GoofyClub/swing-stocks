# Control the installed bot without opening Docker Desktop's window.
[CmdletBinding()]
param([ValidateSet('Menu','Status','Start','Restart','Pause','Resume','Stop')][string]$Action = 'Menu')
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
try {
    $docker = $null
    $found = Get-Command docker.exe -ErrorAction SilentlyContinue
    if ($found) { $docker = $found.Source }
    if (-not $docker) {
        foreach ($candidate in @("$env:ProgramFiles\Docker\Docker\resources\bin\docker.exe", "${env:ProgramW6432}\Docker\Docker\resources\bin\docker.exe", "$env:LOCALAPPDATA\Programs\DockerDesktop\resources\bin\docker.exe")) {
            if (Test-Path $candidate) { $docker = $candidate; break }
        }
    }
    if (-not $docker) { throw 'Docker CLI not found. Run the installer first.' }
    if ($Action -eq 'Menu') {
        Write-Host "`nSwing controls"
        Write-Host '1 Status'
        Write-Host '2 Pause new entries (bot and exits keep running)'
        Write-Host '3 Resume new entries (preserves dry-run configuration)'
        Write-Host '4 Restart / apply saved configuration'
        Write-Host '5 Start a previously stopped bot'
        Write-Host '6 Stop the entire bot (managed exits also stop)'
        Write-Host '0 Exit'
        $choice = Read-Host 'Choose a number'
        $choices = @{'1'='Status';'2'='Pause';'3'='Resume';'4'='Restart';'5'='Start';'6'='Stop'}
        if ($choice -eq '0') { exit 0 }
        if (-not $choices.ContainsKey($choice)) { throw 'Unknown choice; nothing changed.' }
        $Action = $choices[$choice]
    }
    & $docker info --format '{{.ServerVersion}}'
    if ($LASTEXITCODE -ne 0) { throw 'Docker engine is not running. Start Docker Desktop once; then rerun this control file.' }
    switch ($Action) {
        'Status' {
            & $docker compose ps
            if ($LASTEXITCODE -ne 0) { throw 'Could not read container status.' }
            & $docker compose exec -T swing python3 packaging/runtime.py health
        }
        'Start' { & $docker compose up -d --wait }
        'Restart' {
            Write-Host 'Waiting for any current worker to finish. This may take several minutes.'
            & $docker compose up -d --force-recreate --wait
        }
        'Stop' {
            Write-Host 'Stopping all bot processes. Managed exits need the bot running. Existing broker orders remain at Alpaca.'
            & $docker compose stop
        }
        default {
            $paused = if ($Action -eq 'Pause') { 'True' } else { 'False' }
            $code = "import json,os; from pathlib import Path; p=Path('/data/control.json'); d=json.loads(p.read_text()); d['paused']=$paused; t=p.with_name(p.name+'.manual.tmp'); t.write_text(json.dumps(d)); os.chmod(t,0o600); t.replace(p); print('Entries paused: '+str(d['paused'])+'; execution/dry-run configuration unchanged')"
            & $docker compose exec -T swing python3 -c $code
        }
    }
    if ($LASTEXITCODE -ne 0) { throw "$Action failed. Read the error above; no success is assumed." }
    Write-Host "$Action completed. Check /healthcheck and /status in Telegram."
} catch {
    Write-Host ("CONTROL FAILED: " + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
