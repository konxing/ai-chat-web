param([switch]$LauncherOnly)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (!(Test-Path -LiteralPath $compiler)) { throw 'Windows .NET Framework compiler not found.' }

Push-Location $root
try {
    if (!$LauncherOnly) {
        if (!(Test-Path -LiteralPath '.env')) { throw 'Project .env is required. Use -LauncherOnly for first-time setup.' }
        npm run build
        if ($LASTEXITCODE -ne 0) { throw 'Website build failed.' }
        npm run db:migrate
        if ($LASTEXITCODE -ne 0) { throw 'Database migration failed.' }
    }
    $source = Join-Path $PSScriptRoot 'Launcher.cs'
    & $compiler /nologo /codepage:65001 /target:winexe '/out:AI WebChat.exe' /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll $source
    if ($LASTEXITCODE -ne 0) { throw 'Launcher build failed.' }
} finally {
    Pop-Location
}
