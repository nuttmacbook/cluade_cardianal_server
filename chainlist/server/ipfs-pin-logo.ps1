# Install IPFS (Kubo) on the Windows chain server and pin the Bluewolfchain logo permanently.
# Run in PowerShell *as Administrator*:
#   powershell -ExecutionPolicy Bypass -File ipfs-pin-logo.ps1 -Icon C:\path\to\icon.png
# Without -Icon it fetches the logo by CID from the IPFS network (another node, e.g. the Mac, must still hold it).
# - Kubo in C:\ipfs\bin, data in C:\ipfs\repo
# - Runs as SYSTEM via Scheduled Task "IPFS daemon" at boot, restarts on failure
# - API (5001) and gateway (8081) listen on 127.0.0.1 only; inbound 4001 TCP/UDP opened in Windows Firewall
# Safe to run again. Does not touch the chain.
param([string]$Icon = "")
$ErrorActionPreference = "Stop"
$CID  = "bafkreig6oeqowtgyt5mvjsrbzzzcqzmpnki4o3kf6dkbxqdmouxucv564a"
$Root = "C:\ipfs"; $Bin = "$Root\bin"; $Exe = "$Bin\ipfs.exe"; $Repo = "$Root\repo"
$TaskName = "IPFS daemon"

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw "Run PowerShell as Administrator" }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = "SilentlyContinue"
$env:IPFS_PATH = $Repo
function ipfs { & $Exe @args; if ($LASTEXITCODE -ne 0) { throw "ipfs $args failed ($LASTEXITCODE)" } }

# 1) Install Kubo (latest non-rc), checking sha512
if (-not (Test-Path $Exe)) {
  $ver = ((Invoke-WebRequest -UseBasicParsing https://dist.ipfs.tech/kubo/versions).Content -split "`n" | Where-Object { $_ -and $_ -notmatch "-rc" } | Select-Object -Last 1).Trim()
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "amd64" }
  $name = "kubo_${ver}_windows-$arch.zip"
  Write-Host "Installing Kubo $ver ($arch)"
  $tmp = Join-Path $env:TEMP "kubo-install"; New-Item -ItemType Directory -Force $tmp | Out-Null
  $zip = Join-Path $tmp $name
  Invoke-WebRequest -UseBasicParsing "https://dist.ipfs.tech/kubo/$ver/$name" -OutFile $zip
  $want = ((Invoke-WebRequest -UseBasicParsing "https://dist.ipfs.tech/kubo/$ver/$name.sha512").Content -split "\s+")[0]
  $got = (Get-FileHash $zip -Algorithm SHA512).Hash
  if ($got -ne $want.ToUpper()) { throw "sha512 mismatch for $name" }
  Expand-Archive $zip -DestinationPath $tmp -Force
  New-Item -ItemType Directory -Force $Bin | Out-Null
  Copy-Item "$tmp\kubo\ipfs.exe" $Exe -Force
  Remove-Item $tmp -Recurse -Force
}
& $Exe version

# 2) Repo
if (-not (Test-Path "$Repo\config")) {
  ipfs init --profile server
  ipfs config Addresses.Gateway /ip4/127.0.0.1/tcp/8081
  ipfs config Addresses.API /ip4/127.0.0.1/tcp/5001
  ipfs config Datastore.StorageMax 5GB
}

# 3) Scheduled task as SYSTEM at boot
$cmd = "set IPFS_PATH=$Repo&& `"$Exe`" daemon --migrate=true"
$action   = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c $cmd"
$trigger  = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -User "SYSTEM" -RunLevel Highest -Force | Out-Null

# 4) Firewall 4001 (swarm) inbound
foreach ($p in "TCP","UDP") {
  $rule = "IPFS swarm 4001 $p"
  if (-not (Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $rule -Direction Inbound -Protocol $p -LocalPort 4001 -Action Allow | Out-Null
  }
}
Write-Host "Windows Firewall: 4001 TCP/UDP open. If the host has a cloud/router firewall, open 4001 there too."

# 5) Start daemon and wait for it
Start-ScheduledTask -TaskName $TaskName
Write-Host "Waiting for daemon..."
$ok = $false
for ($i = 0; $i -lt 45; $i++) { & $Exe id *> $null; if ($LASTEXITCODE -eq 0) { $ok = $true; break }; Start-Sleep 2 }
if (-not $ok) { throw "IPFS daemon did not start. Check Task Scheduler > '$TaskName'." }

# 6) Pin the logo
if ($Icon) {
  $got = (& $Exe add -Q --cid-version=1 --raw-leaves --pin=true $Icon).Trim()
  if ($got -ne $CID) { throw "CID mismatch: got $got, expected $CID (wrong icon file)" }
} else {
  Write-Host "Fetching logo by CID from IPFS (up to 10 min)..."
  $job = Start-Job { param($e,$r,$c) $env:IPFS_PATH = $r; & $e pin add --progress $c } -ArgumentList $Exe,$Repo,$CID
  if (-not (Wait-Job $job -Timeout 600)) { Stop-Job $job; throw "Could not fetch $CID. Run again with -Icon <file>." }
  Receive-Job $job
}
ipfs pin ls --type=recursive $CID
& $Exe routing provide $CID *> $null
Write-Host ""
Write-Host "DONE: this server now pins the logo ($CID)."
Write-Host "You can stop IPFS on the Mac now (ipfs shutdown)."
