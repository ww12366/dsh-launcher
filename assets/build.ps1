# Rebuild the DeepSeek Harness splash launcher.
#
#   powershell -ExecutionPolicy Bypass -File build.ps1
#
# Produces DshLauncher.exe next to this script: a /target:winexe binary, so it
# never allocates a console window. The logo is embedded as a managed resource,
# so the .exe is self-contained.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$csc  = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'

if (-not (Test-Path $csc)) { throw "csc.exe not found at $csc" }

$ico = Join-Path $here 'dsh.ico'
if (-not (Test-Path $ico)) { throw "logo not found: $ico" }

$out = Join-Path $here 'DshLauncher.exe'

& $csc `
    /nologo `
    /target:winexe `
    /platform:anycpu `
    /optimize+ `
    /langversion:5 `
    "/out:$out" `
    "/win32icon:$ico" `
    "/win32manifest:$(Join-Path $here 'app.manifest')" `
    "/resource:$ico,DshIcon.ico" `
    /reference:System.dll `
    /reference:System.Drawing.dll `
    /reference:System.Windows.Forms.dll `
    (Join-Path $here 'DshLauncher.cs')

if ($LASTEXITCODE -ne 0) { throw "compile failed ($LASTEXITCODE)" }

$f = Get-Item $out
Write-Host ("built {0}  ({1:N0} bytes)  {2}" -f $f.Name, $f.Length, $f.LastWriteTime)
