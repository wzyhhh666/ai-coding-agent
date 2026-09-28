$ErrorActionPreference = 'Stop'
$name = 'CodingAgent.Probe.' + [Diagnostics.Process]::GetCurrentProcess().Id
$root = Join-Path $env:TEMP $name
$drive = $null
$sid = $null
Add-Type -Path (Join-Path $PSScriptRoot 'WindowsSandbox.cs')
try {
  [IO.Directory]::CreateDirectory($root) | Out-Null
  $sid = [WindowsSandboxNative]::EnsureAppContainer($name)
  icacls.exe $root /grant ("*$($sid):(OI)(CI)M") /Q | Out-Null
  foreach ($letter in [char[]](90..68)) {
    $candidate = [string]$letter + ':'
    if (-not (Test-Path $candidate)) { subst.exe $candidate $root; if ($LASTEXITCODE -eq 0) { $drive = $candidate; break } }
  }
  if (-not $drive) { exit 1 }
  $code = [WindowsSandboxNative]::RunAppContainer($name, 'C:\Windows\System32\cmd.exe', [string[]]@('/c','exit','0'), ($drive + [IO.Path]::DirectorySeparatorChar), 5, 2, 134217728, 5, $false)
  exit $code
} catch { exit 1 } finally {
  if ($drive) { subst.exe $drive /d | Out-Null }
  if ($sid) { icacls.exe $root /remove:g ("*$sid") /Q | Out-Null }
  [void][WindowsSandboxNative]::DeleteAppContainerProfile($name)
  Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
}
