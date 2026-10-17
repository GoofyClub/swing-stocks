# Offline helper tests. No Windows settings, installers, accounts or services are touched.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
. (Join-Path $root 'Install-Swing.ps1') -FunctionsOnly
$script:passed = 0
function Assert-True([bool]$Condition, [string]$Name) {
    if (-not $Condition) { throw "FAILED: $Name" }
    $script:passed++
    Write-Host "PASS $Name"
}
function Assert-Rejected([scriptblock]$Action, [string]$Name) {
    $rejected = $false
    try { & $Action } catch { $rejected = $true }
    Assert-True $rejected $Name
}
foreach ($file in @('Install-Swing.ps1', 'start-swing.ps1')) {
    $tokens = $null; $parseErrors = $null
    [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $root $file), [ref]$tokens, [ref]$parseErrors) | Out-Null
    Assert-True ($parseErrors.Count -eq 0) "Parse $file"
}
Assert-True (Test-PackagePresent 0) 'Successful WinGet installation accepted'
Assert-True (Test-PackagePresent -1978335189) 'Already current WinGet package accepted'
Assert-True (Test-PackagePresent -1978335135) 'Already installed WinGet package accepted'
Assert-True (-not (Test-PackagePresent -1)) 'Real WinGet errors remain failures'
Assert-True (-not (Test-PackagePresent 3010)) 'Reboot-required code is not silently ignored'
$locations = Get-DockerLocations
Assert-True ($locations.Cli -contains "$env:LOCALAPPDATA\Programs\DockerDesktop\resources\bin\docker.exe") 'Per-user Docker CLI path searched'
Assert-True ($locations.Desktop -contains "$env:LOCALAPPDATA\Programs\DockerDesktop\Docker Desktop.exe") 'Per-user Docker Desktop path searched'
$backend = 'http://127.0.0.1:8444'
Assert-ServeAvailable ('{}' | ConvertFrom-Json) $backend
Assert-True $true 'Unused Serve configuration accepted'
$own = '{"Web":{"pc.example.ts.net:8444":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8444"}}}},"TCP":{"8444":{"HTTPS":true}}}' | ConvertFrom-Json
Assert-ServeAvailable $own $backend
Assert-True $true 'Existing Swing Serve mapping preserved'
Assert-Rejected {
    Assert-ServeAvailable ('{"Web":{"pc:8444":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:9000"}}}}}' | ConvertFrom-Json) $backend
} 'Unrelated HTTPS application rejected'
Assert-Rejected {
    Assert-ServeAvailable ('{"TCP":{"8444":{"TCPForward":"localhost:9000"}},"Web":{"pc:8444":{"Handlers":{}}}}' | ConvertFrom-Json) $backend
} 'TCP port conflict rejected even with another web listener'
Assert-Rejected {
    Assert-ServeAvailable ('{"AllowFunnel":{"pc:8444":true}}' | ConvertFrom-Json) $backend
} 'Public Funnel endpoint rejected'
$temp = Join-Path ([IO.Path]::GetTempPath()) ('swing-installer-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
try {
    $envFile = Join-Path $temp '.env'
    [IO.File]::WriteAllText($envFile, "ALPACA_API_KEY='test-fixture'`nDASHBOARD_URL='https://old.example'`nDASHBOARD_URL='https://duplicate.example'`n")
    Set-DashboardUrl $envFile 'https://pc.example.ts.net:8444'
    $content = [IO.File]::ReadAllText($envFile)
    Assert-True ($content.Contains("ALPACA_API_KEY='test-fixture'")) 'Unrelated configuration preserved'
    Assert-True (([regex]::Matches($content, 'DASHBOARD_URL=')).Count -eq 1) 'Duplicate URL setting replaced once'
    Assert-Rejected { Set-DashboardUrl $envFile "http://untrusted.example`nINJECTED=1" } 'Non-HTTPS/invalid URL rejected'
    Assert-True ([IO.File]::ReadAllText($envFile) -eq $content) 'Rejected URL leaves file unchanged'
} finally { Remove-Item -Recurse -Force $temp }
$zero = [PSCustomObject]@{ Code=0; Output=@('Current AC: 0x00000000', 'Current DC: 0x0000012c') }
$nonzero = [PSCustomObject]@{ Code=0; Output=@('Aktueller Wechselstromwert: 0x0000003c', 'Aktueller Gleichstromwert: 0x00000000') }
Assert-True ((Get-AcTimeoutSeconds $zero) -eq 0) 'Disabled AC setting distinguished from nonzero battery timeout'
Assert-True ((Get-AcTimeoutSeconds $nonzero) -eq 60) 'Localized nonzero AC setting detected even when battery timeout is zero'
Assert-True ($null -eq (Get-AcTimeoutSeconds ([PSCustomObject]@{Code=1; Output=@()}))) 'Failed query cannot claim verification'
$originalCapture = ${function:Invoke-Captured}
try {
    function Invoke-Captured([string]$File, [string[]]$Arguments) { return $script:PowerReplies.Dequeue() }
    $script:PowerReplies = New-Object System.Collections.Queue
    foreach ($reply in @([PSCustomObject]@{Code=0}, $zero, [PSCustomObject]@{Code=0}, $zero)) { $script:PowerReplies.Enqueue($reply) }
    Assert-True (Set-PluggedInPower) 'Both active AC settings verified after successful changes'
    $script:PowerReplies = New-Object System.Collections.Queue
    foreach ($reply in @([PSCustomObject]@{Code=1}, [PSCustomObject]@{Code=0}, $zero)) { $script:PowerReplies.Enqueue($reply) }
    Assert-True (-not (Set-PluggedInPower)) 'Failed sleep change remains a failure even if hibernation succeeds'
    $script:PowerReplies = New-Object System.Collections.Queue
    foreach ($reply in @([PSCustomObject]@{Code=0}, $nonzero, [PSCustomObject]@{Code=0}, $zero)) { $script:PowerReplies.Enqueue($reply) }
    Assert-True (-not (Set-PluggedInPower)) 'Successful command with unchanged timeout is not reported as verified'
} finally { Set-Item Function:\Invoke-Captured $originalCapture }
$native = Join-Path $PSHOME 'powershell.exe'
if (-not (Test-Path $native)) { $native = Join-Path $PSHOME 'pwsh' }
$result = Invoke-Captured $native @('-NoProfile', '-Command', '[Console]::Error.WriteLine("expected failure"); exit 7')
Assert-True ($result.Code -eq 7 -and ($result.Output -join '').Contains('expected failure')) 'Native failure captured for polling instead of aborting'
Write-Host "$script:passed installer checks passed"
