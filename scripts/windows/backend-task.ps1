param([Parameter(Mandatory=$true)][ValidateSet('Start','Stop','Enable','Disable','Upgrade')][string]$Action)
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

function Stop-RunningTask {
    Stop-ScheduledTask -TaskName $name
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    while ((Get-ScheduledTask -TaskName $name).State -eq 'Running') {
        if ([DateTime]::UtcNow -ge $deadline) { throw 'The previous background process is still stopping. Please retry.' }
        Start-Sleep -Milliseconds 100
    }
}

if ($Action -eq 'Stop') {
    if ($existing -and $existing.State -eq 'Running') { Stop-RunningTask }
    return
}
if ($Action -eq 'Disable') {
    if ($existing) {
        $existing.Triggers = @()
        Set-ScheduledTask -InputObject $existing | Out-Null
    }
    return
}
if ($Action -eq 'Upgrade' -and !$existing) { return }

$wasRunning = $existing -and $existing.State -eq 'Running'
if ($Action -ne 'Upgrade' -or $wasRunning) {
    if (!(Test-Path -LiteralPath (Join-Path $root '.env'))) { throw 'Missing project .env.' }
    if (!(Test-Path -LiteralPath (Join-Path $root '.next/BUILD_ID'))) { throw 'Build the website before starting it.' }
}
$launcher = Join-Path $root 'AI WebChat.exe'
if (!(Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'Build AI WebChat.exe before starting it.' }
$node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$taskArguments = '--backend "' + $node + '"'
$oldActions = @($existing.Actions)
$current = $existing -and $oldActions.Count -eq 1 -and
    $oldActions[0].Execute -eq $launcher -and $oldActions[0].Arguments -eq $taskArguments -and
    $oldActions[0].WorkingDirectory -eq $root

if (!$current) {
    if ($wasRunning) { Stop-RunningTask }
    $taskAction = New-ScheduledTaskAction -Execute $launcher -Argument $taskArguments -WorkingDirectory $root
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
    $registration = @{ TaskName=$name; Action=$taskAction; Settings=$settings; Principal=$principal; Force=$true }
    if ($Action -eq 'Enable') {
        $registration.Trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
    } elseif ($existing -and $existing.Triggers.Count -gt 0) {
        $registration.Trigger = $existing.Triggers
    }
    Register-ScheduledTask @registration | Out-Null
} elseif ($Action -eq 'Enable' -and $existing.Triggers.Count -eq 0) {
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
    Set-ScheduledTask -TaskName $name -Trigger $trigger | Out-Null
}

if (($Action -eq 'Start' -and !$wasRunning) -or (!$current -and $wasRunning)) {
    Start-ScheduledTask -TaskName $name
}
