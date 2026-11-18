param([switch]$LauncherOnly)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (!(Test-Path -LiteralPath $compiler)) { throw 'Windows .NET Framework compiler not found.' }

Push-Location $root
try {
    if (!$LauncherOnly) {
        if (!(Test-Path -LiteralPath '.env')) { throw 'Project .env is required. Use -LauncherOnly for first-time setup.' }
        Write-Host 'Checking project dependencies...'
        & node.exe (Join-Path $PSScriptRoot 'check-dependencies.cjs')
        if ($LASTEXITCODE -ne 0) {
            Write-Host 'Installing missing or changed project dependencies...'
            npm.cmd ci --include=dev --no-audit
            if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. Check the npm error above, then rerun this build command.' }
        } else {
            Write-Host 'Project dependencies are up to date; skipping installation.'
        }
        npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw 'Website build failed.' }
        npm.cmd run db:migrate
        if ($LASTEXITCODE -ne 0) { throw 'Database migration failed.' }
    }
    $source = Join-Path $PSScriptRoot 'Launcher.cs'
    $backend = Join-Path $PSScriptRoot 'BackendHost.cs'
    $icon = Join-Path $PSScriptRoot 'app.ico'
    & $compiler /nologo /codepage:65001 /target:winexe '/out:AI WebChat.exe' "/win32icon:$icon" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll $source $backend
    if ($LASTEXITCODE -ne 0) { throw 'Launcher build failed. If AI WebChat is running, stop its backend and close its window before rebuilding.' }
    & (Join-Path $PSScriptRoot 'backend-task.ps1') Upgrade
} finally {
    Pop-Location
}
