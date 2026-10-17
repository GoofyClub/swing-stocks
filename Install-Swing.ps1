# Run with Windows PowerShell 5.1 or newer. Re-running resumes setup safely.
[CmdletBinding()]
param(
    [string]$InstallDirectory = (Join-Path $HOME 'Swing-PC'),
    [string]$Branch = 'main',
    [switch]$FunctionsOnly
)
$ErrorActionPreference = 'Stop'

function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path', 'User')
}

function Find-Tool([string]$Name, [string[]]$Candidates) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    foreach ($path in $Candidates) {
        if (Test-Path -LiteralPath $path) { return $path }
    }
    return $null
}

function Invoke-Captured([string]$File, [string[]]$Arguments) {
    # Windows PowerShell 5.1 turns redirected native stderr into ErrorRecords.
    # A stopped Docker daemon is an expected polling result, not a fatal error.
    $previous = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = @(& $File @Arguments 2>&1)
        return [PSCustomObject]@{ Code = $LASTEXITCODE; Output = @($output | ForEach-Object { "$_" }) }
    } finally { $ErrorActionPreference = $previous }
}

function Test-PackagePresent([int]$Code) {
    # WinGet's official HRESULTs: UPDATE_NOT_APPLICABLE,
    # PACKAGE_ALREADY_INSTALLED and INSTALL_ALREADY_INSTALLED.
    return $Code -in @(0, -1978335189, -1978335135, -1978334963)
}

function Get-DockerLocations {
    $roots = @("$env:ProgramFiles\Docker\Docker", "${env:ProgramW6432}\Docker\Docker",
               "$env:LOCALAPPDATA\Programs\DockerDesktop")
    if ($env:OS -eq 'Windows_NT') {
        foreach ($key in @(
            'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Docker Desktop',
            'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Docker Desktop',
            'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Docker Desktop',
            'HKLM:\SOFTWARE\Docker Inc.\Docker Desktop',
            'HKCU:\SOFTWARE\Docker Inc.\Docker Desktop')) {
            $entry = Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue
            foreach ($location in @($entry.InstallLocation, $entry.InstallPath)) {
                if ($location) { $roots += "$location".Trim('"').TrimEnd('\') }
            }
        }
    }
    return [PSCustomObject]@{
        Cli = @($roots | Select-Object -Unique | ForEach-Object { "$_\resources\bin\docker.exe" })
        Desktop = @($roots | Select-Object -Unique | ForEach-Object { "$_\Docker Desktop.exe" })
    }
}

function Install-Tool([string]$Id) {
    Write-Host "Installing $Id from the Windows package manager. Approve its installer if Windows asks."
    & winget install --id $Id --exact --source winget --accept-source-agreements --accept-package-agreements
    $result = $LASTEXITCODE
    # MSI/WinGet can signal a successful installation that needs a reboot.
    if ($result -eq 3010 -or $result -eq 1641) {
        throw 'Installation requires a Windows restart. Restart, then run this same installer again.'
    }
    if (-not (Test-PackagePresent $result)) { throw "Installation of $Id failed ($result). Resolve the displayed error and run this installer again." }
    if ($result -ne 0) { Write-Host "$Id is already installed/up to date. Checking its executable next..." }
    Refresh-Path
}

function Get-AcTimeoutSeconds($Probe) {
    if ($Probe.Code -ne 0) { return $null }
    # powercfg prints the current AC index then DC index at the end of a
    # setting query. Match hex values, not localized Windows label text.
    $indices = [regex]::Matches(($Probe.Output -join "`n"), '(?im)0x([0-9a-f]{8})\s*$')
    if ($indices.Count -lt 2) { return $null }
    return [Convert]::ToUInt32($indices[$indices.Count - 2].Groups[1].Value, 16)
}

function Set-PluggedInPower {
    $verified = $true
    $settings = @(
        @{ Name = 'Sleep'; Option = 'standby-timeout-ac'; Guid = '29f6c1db-86da-48c5-9fdb-f2b67b1f44da' },
        @{ Name = 'Hibernation'; Option = 'hibernate-timeout-ac'; Guid = '9d7815a6-7ee4-497e-8888-515a05f02364' }
    )
    foreach ($setting in $settings) {
        $change = Invoke-Captured 'powercfg.exe' @('/change', $setting.Option, '0')
        if ($change.Code -ne 0) {
            Write-Warning "$($setting.Name): change FAILED (exit $($change.Code)). Set it to Never while plugged in using Windows Power settings."
            $verified = $false
            continue
        }
        $query = Invoke-Captured 'powercfg.exe' @('/query', 'SCHEME_CURRENT',
            '238c9fa8-0aad-41ed-83f4-97be242c8f20', $setting.Guid)
        $seconds = Get-AcTimeoutSeconds $query
        if ($null -eq $seconds) {
            Write-Warning "$($setting.Name): change command succeeded, but Windows settings could not be verified. Check Windows Power settings manually."
            $verified = $false
        } elseif ($seconds -ne 0) {
            Write-Warning "$($setting.Name): NOT disabled; the active plugged-in timeout is $seconds seconds. Check Windows Power settings or organization policy."
            $verified = $false
        } else {
            Write-Host "VERIFIED: $($setting.Name) while plugged in is set to NEVER." -ForegroundColor Green
        }
    }
    Write-Host 'Battery settings and lid-close behavior were not changed. Keep the laptop plugged in with its lid open.'
    return $verified
}

function Set-DashboardUrl([string]$EnvFile, [string]$Url) {
    if ($Url -notmatch '^https://[A-Za-z0-9.-]+:8444/?$') { throw 'Unexpected Tailscale HTTPS address; configuration was not changed.' }
    $lines = [IO.File]::ReadAllLines($EnvFile)
    $kept = @($lines | Where-Object { $_ -notmatch '^\s*DASHBOARD_URL\s*=' })
    $text = (($kept + "DASHBOARD_URL='$Url'") -join "`n") + "`n"
    [IO.File]::WriteAllText($EnvFile, $text, (New-Object Text.UTF8Encoding $false))
}

function Assert-ServeAvailable($Config, [string]$Backend) {
    # Don't overwrite an unrelated Tailscale Serve application on this PC.
    if ($Config.Web) {
        foreach ($web in $Config.Web.PSObject.Properties) {
            if ($web.Name -match ':8444$') {
                foreach ($handler in $web.Value.Handlers.PSObject.Properties) {
                    if ($handler.Name -ne '/' -or $handler.Value.Proxy -ne $Backend) {
                        throw 'Tailscale HTTPS port 8444 already serves another application. Keep that configuration and follow PC-INSTALL.md to choose a separate endpoint.'
                    }
                }
            }
        }
    }
    if ($Config.AllowFunnel) {
        foreach ($funnel in $Config.AllowFunnel.PSObject.Properties) {
            if ($funnel.Name -match ':8444$' -and $funnel.Value) {
                throw 'Tailscale Funnel already exposes port 8444 publicly. Disable that route deliberately before installing the private Swing dashboard.'
            }
        }
    }
    if ($Config.TCP) {
        foreach ($tcp in $Config.TCP.PSObject.Properties) {
            if ($tcp.Name -eq '8444' -and ($tcp.Value.TCPForward -or -not $tcp.Value.HTTPS -or -not @($Config.Web.PSObject.Properties | Where-Object { $_.Name -match ':8444$' }).Count)) {
                throw 'Tailscale port 8444 already has a TCP configuration; not overwriting it.'
            }
        }
    }
}

function Install-Swing {
    if ($env:OS -ne 'Windows_NT') { throw 'This installer is for Windows. Linux/macOS: use start-swing.sh.' }
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw 'Install/update Microsoft App Installer from the Microsoft Store (provides winget), then run this installer again.'
    }
    Write-Host "`nSwing PC setup - PAPER TRADING ONLY"
    Write-Host 'The old Swing installation must be stopped and the paper account must be flat.'
    if ((Read-Host 'Type YES to confirm both before continuing').Trim() -ine 'YES') {
        throw 'Setup stopped without starting Swing. Finish the migration checks first.'
    }

    $gitCandidates = @("$env:ProgramFiles\Git\cmd\git.exe", "$env:LOCALAPPDATA\Programs\Git\cmd\git.exe")
    if (-not (Find-Tool 'git.exe' $gitCandidates)) { Install-Tool 'Git.Git' }
    $git = Find-Tool 'git.exe' $gitCandidates
    if (-not $git) { throw 'Git was installed but is not available yet. Reopen PowerShell and run this installer again.' }

    # Enabling WSL can require Windows authorization and a reboot. Never reboot
    # automatically or change permanent PowerShell execution policy.
    $wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue
    if ($wsl) { $probe = Invoke-Captured $wsl.Source @('--status'); $wslReady = ($probe.Code -eq 0) }
    else { $wslReady = $false }
    if (-not $wslReady) {
        Write-Host 'Windows needs WSL 2 for Docker. Approve the Windows administrator prompt.'
        $process = Start-Process wsl.exe -ArgumentList '--install', '--no-distribution' -Verb RunAs -Wait -PassThru
        if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 3010) {
            throw 'WSL installation did not complete. Follow the Windows error message, then rerun this installer.'
        }
        throw 'WSL setup requested. Restart Windows, then run this same installer again.'
    }

    $locations = Get-DockerLocations
    if (-not (Find-Tool 'docker.exe' $locations.Cli)) { Install-Tool 'Docker.DockerDesktop' }
    $locations = Get-DockerLocations
    $docker = Find-Tool 'docker.exe' $locations.Cli
    if (-not $docker) { throw 'Docker Desktop is registered but docker.exe could not be found. Open Docker Desktop once, then reopen PowerShell and rerun. If Docker is installed in a custom folder, add its resources\bin folder to PATH.' }
    Write-Host 'Starting Docker Desktop. Complete any first-run terms/WSL screens it displays.'
    $relativeDesktop = Join-Path (Split-Path (Split-Path (Split-Path $docker))) 'Docker Desktop.exe'
    $desktop = Find-Tool 'Docker Desktop.exe' (@($relativeDesktop) + $locations.Desktop)
    if ($desktop) { Start-Process $desktop }
    $ready = $false
    for ($attempt = 0; $attempt -lt 120; $attempt++) {
        $probe = Invoke-Captured $docker @('info', '--format', '{{.OSType}}')
        if ($probe.Code -eq 0 -and ($probe.Output -join "`n").Trim() -eq 'linux') { $ready = $true; break }
        if ($attempt % 6 -eq 0) { Write-Host 'Waiting for Docker Linux engine. Check the Docker Desktop window...' }
        Start-Sleep -Seconds 5
    }
    if (-not $ready) { throw 'Docker Linux engine is not ready. Finish Docker setup (or switch to Linux containers), then rerun this installer.' }
    & $docker compose version
    if ($LASTEXITCODE -ne 0) { throw 'Docker Compose is unavailable. Update Docker Desktop and rerun.' }

    $tailscaleCandidates = @("$env:ProgramFiles\Tailscale\tailscale.exe")
    if (-not (Find-Tool 'tailscale.exe' $tailscaleCandidates)) { Install-Tool 'Tailscale.Tailscale' }
    $tailscale = Find-Tool 'tailscale.exe' $tailscaleCandidates
    if (-not $tailscale) { throw 'Tailscale is not available yet. Reopen PowerShell and rerun this installer.' }
    Refresh-Path
    # start-swing.ps1 invokes Docker by name, including before a new login.
    $env:Path = (Split-Path $docker) + ';' + (Split-Path $git) + ';' + $env:Path

    if ((Test-Path (Join-Path $PSScriptRoot 'compose.yaml')) -and (Test-Path (Join-Path $PSScriptRoot '.git'))) {
        $checkout = $PSScriptRoot
    } else {
        $checkout = $InstallDirectory
        if (-not (Test-Path $checkout)) {
            Write-Host 'Downloading Swing. Sign into GitHub if asked; the repository is private.'
            & $git clone --branch $Branch https://github.com/GoofyClub/swing-stocks.git $checkout
            if ($LASTEXITCODE -ne 0) { throw 'Clone failed. Confirm GitHub access; do not delete an existing Swing folder.' }
            # Before the packaging PR is merged, a fresh main clone lacks the
            # package. Only that brand-new checkout may switch automatically.
            if ($Branch -eq 'main' -and -not (Test-Path (Join-Path $checkout 'start-swing.ps1'))) {
                & $git -C $checkout fetch origin feat/local-rsi2-bot
                if ($LASTEXITCODE -ne 0) { throw 'Portable package is not on main and its preview branch is unavailable. Ask for the packaging change to be merged.' }
                & $git -C $checkout checkout -b swing-portable-setup FETCH_HEAD
                if ($LASTEXITCODE -ne 0) { throw 'Could not select the portable package in the new checkout.' }
            }
        }
    }
    if (-not (Test-Path (Join-Path $checkout 'start-swing.ps1'))) {
        throw "This folder does not contain the portable package: $checkout. Use a new installation folder or update the existing checkout deliberately."
    }
    Set-Location $checkout
    & (Join-Path $checkout 'start-swing.ps1')
    & $docker compose exec -T swing python3 packaging/runtime.py verify
    if ($LASTEXITCODE -ne 0) { throw 'Account/bot verification failed. Keep entries paused; check the local credentials and rerun.' }

    Write-Host 'Signing into Tailscale. Follow its sign-in instructions; use the same account on your phone.'
    $statusText = & $tailscale status --json
    if ($LASTEXITCODE -ne 0) { throw 'Tailscale service is not ready. Open Tailscale and rerun this installer.' }
    $status = $statusText | ConvertFrom-Json
    if ($status.BackendState -ne 'Running') {
        & $tailscale up
        if ($LASTEXITCODE -ne 0) { throw 'Finish Tailscale sign-in, then rerun this installer.' }
        $status = (& $tailscale status --json) | ConvertFrom-Json
    }
    $dns = "$($status.Self.DNSName)".TrimEnd('.')
    if ($status.BackendState -ne 'Running' -or -not $dns) { throw 'Tailscale login/MagicDNS is not ready. Complete it in Tailscale, then rerun.' }
    $mapping = (& $docker compose port swing 8444)
    if ($LASTEXITCODE -ne 0 -or "$mapping".Trim() -notmatch '^127\.0\.0\.1:\d+$') {
        throw 'Expected a loopback-only dashboard port. Inspect Compose before enabling remote access.'
    }
    $backend = 'http://' + "$mapping".Trim()
    $serveText = & $tailscale serve status --json
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect Tailscale Serve configuration. Update Tailscale and rerun.' }
    $serve = $serveText | ConvertFrom-Json
    Assert-ServeAvailable $serve $backend
    Write-Host "`nOn the Tailscale approval page:" -ForegroundColor Cyan
    Write-Host '  ENABLE HTTPS certificates and Serve.'
    Write-Host '  LEAVE Tailscale Funnel OFF (it is optional).' -ForegroundColor Yellow
    Write-Host 'Funnel exposes services to the public Internet. Swing only needs private access through Tailscale.'
    Write-Host 'HTTPS certificate provisioning publishes your device hostname in a public certificate log, not your dashboard contents or credentials.'
    Write-Host 'Approve/save the settings, then return here. If setup stops, run this installer again.'
    & $tailscale serve --bg --https=8444 $backend
    if ($LASTEXITCODE -ne 0) { throw 'Follow the HTTPS/Serve approval instructions above, then rerun this installer. Swing stays paused for a new installation.' }
    $url = 'https://' + $dns + ':8444'
    Set-DashboardUrl (Join-Path $checkout 'swing-config/swing.env') $url
    & $docker compose up -d --force-recreate --wait
    if ($LASTEXITCODE -ne 0) { throw 'Restart failed. Inspect docker compose logs --tail=100.' }

    if ((Read-Host 'Prevent sleep/hibernation while plugged in? [Y/n]') -notmatch '^[nN]') {
        $null = Set-PluggedInPower
    } else {
        Write-Host 'Sleep/hibernation settings left unchanged. Make sure the PC stays awake while Swing runs.'
    }
    if ($desktop -and (Test-Path $desktop)) {
        $startup = [Environment]::GetFolderPath('Startup')
        $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $startup 'Swing Docker Desktop.lnk'))
        $shortcut.TargetPath = $desktop
        $shortcut.Save()
    }
    Write-Host "`nSetup complete. Dashboard: $url"
    Write-Host 'Install/connect Tailscale on your phone, then open that address and log in.'
    Write-Host 'In Telegram: /healthcheck, /positions, /config. New setup is PAUSED and DRY_RUN=true; follow PC-INSTALL.md to enable paper orders.'
    Write-Host 'Keep the PC awake and lid open. After reboot, sign into Windows and verify Docker/Swing.'
    Start-Process $url
}

if (-not $FunctionsOnly) {
    try { Install-Swing }
    catch { Write-Host "`nSETUP PAUSED: $($_.Exception.Message)" -ForegroundColor Yellow; exit 1 }
}
