param([Parameter(Mandatory=$true)][ValidateSet('Start','Stop','Enable','Disable')][string]$Action)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$hash = [Security.Cryptography.SHA256]::Create()
try {
    $digest = $hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($root.ToUpperInvariant()))
    $instance = [BitConverter]::ToString($digest, 0, 8).Replace('-', '')
} finally {
    $hash.Dispose()
}
$name = "AI WebChat $($identity.User.Value) $instance"
$existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue

if ($Action -eq 'Stop') {
    if ($existing -and $existing.State -eq 'Running') { Stop-ScheduledTask -TaskName $name }
    return
}
if ($Action -eq 'Disable') {
    if ($existing) {
        $existing.Triggers = @()
        Set-ScheduledTask -InputObject $existing | Out-Null
    }
    return
}

if (!(Test-Path -LiteralPath (Join-Path $root '.env'))) { throw 'Missing project .env.' }
if (!(Test-Path -LiteralPath (Join-Path $root '.next/BUILD_ID'))) { throw 'Build the website before starting it.' }

if (!$existing -or $Action -eq 'Enable') {
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $taskAction = New-ScheduledTaskAction -Execute $node -Argument 'scripts/windows/backend.cjs' -WorkingDirectory $root
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
    $registration = @{ TaskName=$name; Action=$taskAction; Settings=$settings; Principal=$principal; Force=$true }
    if ($Action -eq 'Enable') { $registration.Trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name }
    Register-ScheduledTask @registration | Out-Null
}

if ($Action -eq 'Start') { Start-ScheduledTask -TaskName $name }
