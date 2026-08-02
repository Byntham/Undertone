$ErrorActionPreference = "Stop"

$electronRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $electronRoot "native\Undertone.WinHost\Program.cs"
$outputDir = Join-Path $electronRoot "dist\native"
$output = Join-Path $outputDir "Undertone.WinHost.exe"
$compiler = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"

if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) {
    throw "The .NET Framework C# compiler is unavailable: $compiler"
}

New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
& $compiler /nologo /target:exe /platform:x64 /optimize+ `
    /reference:System.dll `
    /reference:System.Core.dll `
    /reference:System.Web.Extensions.dll `
    /out:$output $source

if ($LASTEXITCODE -ne 0) {
    throw "Windows host compilation failed with exit code $LASTEXITCODE"
}
