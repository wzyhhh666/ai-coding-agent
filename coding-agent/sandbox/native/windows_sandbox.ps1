param([Parameter(Mandatory=$true)][string]$Payload)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$plan = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json
$source = Join-Path $PSScriptRoot 'WindowsSandbox.cs'
Add-Type -Path $source
$profile = $null
$sid = $null
$rules = [Collections.Generic.List[string]]::new()
$aclTargets = [Collections.Generic.List[string]]::new()
$drive = $null
$leaseRoot = Join-Path $env:TEMP 'coding-agent-sandbox-leases'
$leasePath = Join-Path $leaseRoot ($plan.executionId + '.json')

function Test-Administrator {
  $principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Remove-StaleLeases {
  [IO.Directory]::CreateDirectory($leaseRoot) | Out-Null
  foreach ($file in Get-ChildItem $leaseRoot -Filter '*.json' -File -ErrorAction SilentlyContinue) {
    try {
      $lease = Get-Content $file.FullName -Raw | ConvertFrom-Json
      if (-not (Get-Process -Id ([int]$lease.hostPid) -ErrorAction SilentlyContinue)) {
        if ($lease.drive) { Start-Process -FilePath 'subst.exe' -ArgumentList @([string]$lease.drive, '/d') -Wait -NoNewWindow | Out-Null }
        if (Test-Administrator) { Get-NetFirewallRule -DisplayName ("CodingAgent-$($lease.hostPid)-*") -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue }
        Remove-Item $file.FullName -Force -ErrorAction SilentlyContinue
      }
    } catch { Remove-Item $file.FullName -Force -ErrorAction SilentlyContinue }
  }
}

function Invoke-Icacls([string[]]$arguments) {
  $process = Start-Process -FilePath 'icacls.exe' -ArgumentList $arguments -Wait -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $env:TEMP 'coding-agent-icacls.out')
  if ($process.ExitCode -ne 0) { throw "icacls failed: $($process.ExitCode)" }
}

function Add-NetworkRules {
  if ($plan.network.mode -eq 'deny-all') { return }
  if (-not (Test-Administrator)) { throw 'Network allowlist requires an elevated process to install temporary firewall rules.' }
  foreach ($range in $plan.network.blockedCidrs) {
    $name = "CodingAgent-$($plan.hostPid)-$($plan.executionId)-$($rules.Count)"
    New-NetFirewallRule -DisplayName $name -Group 'CodingAgentSandbox' -Direction Outbound -Action Block -Package $sid -RemoteAddress $range | Out-Null
    $rules.Add($name)
  }
}

function Grant-WorkspaceAccess {
  Invoke-Icacls @([string]$plan.workspace, '/grant', "*$($sid):(OI)(CI)M", '/Q')
  $aclTargets.Add([string]$plan.workspace)
  Invoke-Icacls @([string]$plan.tempDirectory, '/grant', "*$($sid):(OI)(CI)M", '/Q')
}

function Mount-Workspace {
  foreach ($letter in [char[]](90..68)) {
    $candidate = [string]$letter + ':'
    if (-not (Test-Path $candidate)) {
      $process = Start-Process -FilePath 'subst.exe' -ArgumentList @($candidate, [string]$plan.workspace) -Wait -PassThru -NoNewWindow
      if ($process.ExitCode -eq 0) { $script:drive = $candidate; break }
    }
  }
  if (-not $drive) { throw 'No free drive letter is available for the sandbox workspace.' }
  @{ hostPid=[int]$plan.hostPid; drive=$drive; executionId=[string]$plan.executionId } | ConvertTo-Json -Compress | Set-Content -LiteralPath $leasePath -Encoding ASCII
  $driveRoot = $drive + [IO.Path]::DirectorySeparatorChar
  $workspaceFull = [IO.Path]::GetFullPath([string]$plan.workspace).TrimEnd('\')
  $cwdFull = [IO.Path]::GetFullPath([string]$plan.cwd)
  if (-not $cwdFull.StartsWith($workspaceFull, [StringComparison]::OrdinalIgnoreCase)) { throw 'Sandbox cwd is outside the workspace.' }
  $relative = $cwdFull.Substring($workspaceFull.Length).TrimStart('\')
  $script:mappedCwd = if ($relative -eq '.') { $driveRoot } else { Join-Path $driveRoot $relative }
  $mapPath = { param([string]$value) $full=[IO.Path]::GetFullPath($value); if ($full.StartsWith($workspaceFull, [StringComparison]::OrdinalIgnoreCase)) { Join-Path $driveRoot ($full.Substring($workspaceFull.Length).TrimStart('\')) } else { $value } }
  $script:mappedExecutable = & $mapPath ([string]$plan.executable)
  $script:mappedArguments = @($plan.arguments | ForEach-Object { & $mapPath ([string]$_) })
}

function Add-RestrictedDenyRule {
  if (-not (Test-Administrator)) { throw 'Restricted-token deny-all networking requires an elevated process to install a temporary firewall rule.' }
  $name = "CodingAgent-$($plan.hostPid)-$($plan.executionId)-restricted"
  New-NetFirewallRule -DisplayName $name -Group 'CodingAgentSandbox' -Direction Outbound -Action Block -Program $plan.executable -RemoteAddress Any | Out-Null
  $rules.Add($name)
}

function Remove-AppContainerRules {
  foreach ($rule in $rules.ToArray()) { Remove-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue; [void]$rules.Remove($rule) }
}

try {
  Remove-StaleLeases
  [IO.Directory]::CreateDirectory([string]$plan.tempDirectory) | Out-Null
  Mount-Workspace
  if ($plan.identity -eq 'appcontainer') {
    $profile = "CodingAgent.$($plan.executionId)"
    $sid = [WindowsSandboxNative]::EnsureAppContainer($profile)
    Grant-WorkspaceAccess
    Add-NetworkRules
    $code = [WindowsSandboxNative]::RunAppContainer($profile, $mappedExecutable, [string[]]$mappedArguments, $mappedCwd, $plan.limits.timeoutSeconds, $plan.limits.maxProcesses, $plan.limits.memoryBytes, $plan.limits.cpuSeconds, $plan.network.mode -eq 'allowlist')
  } else {
    if ($plan.network.mode -ne 'deny-all') { throw 'Restricted-token mode cannot enforce a target allowlist; use AppContainer mode.' }
    $sid = [WindowsSandboxNative]::GetLogonSid()
    if (-not $sid) { throw 'Current token does not expose a Logon SID.' }
    Grant-WorkspaceAccess
    Add-RestrictedDenyRule
    $code = [WindowsSandboxNative]::RunRestricted($sid, $mappedExecutable, [string[]]$mappedArguments, $mappedCwd, $plan.limits.timeoutSeconds, $plan.limits.maxProcesses, $plan.limits.memoryBytes, $plan.limits.cpuSeconds)
  }
  exit $code
} finally {
  foreach ($rule in $rules) { Remove-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue }
  if ($sid) { foreach ($target in $aclTargets.ToArray()) { Invoke-Icacls @($target, '/remove:g', "*$sid", '/Q') }; Invoke-Icacls @([string]$plan.tempDirectory, '/remove:g', "*$sid", '/Q') }
  if ($profile) { [void][WindowsSandboxNative]::DeleteAppContainerProfile($profile) }
  if ($drive) { Start-Process -FilePath 'subst.exe' -ArgumentList @($drive, '/d') -Wait -NoNewWindow | Out-Null }
  Remove-Item $leasePath -Force -ErrorAction SilentlyContinue
  Remove-Item ([string]$plan.tempDirectory) -Force -ErrorAction SilentlyContinue
}
