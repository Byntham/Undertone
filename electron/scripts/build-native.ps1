$ErrorActionPreference = "Stop"

$electronRoot = Split-Path -Parent $PSScriptRoot
$sourceDir = Join-Path $electronRoot "native\Undertone.WinHost"
$sources = Get-ChildItem -LiteralPath $sourceDir -Filter "*.cs" |
    Sort-Object Name |
    ForEach-Object { $_.FullName }
$outputDir = Join-Path $electronRoot "dist\native"
$output = Join-Path $outputDir "Undertone.WinHost.exe"
$compiler = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$frameworkWpf = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\WPF"

if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) {
    throw "The .NET Framework C# compiler is unavailable: $compiler"
}

New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
& $compiler /nologo /target:exe /platform:x64 /optimize+ `
    /reference:System.dll `
    /reference:System.Core.dll `
    /reference:System.Security.dll `
    /reference:System.Web.Extensions.dll `
    /reference:"$(Join-Path $frameworkWpf 'UIAutomationClient.dll')" `
    /reference:"$(Join-Path $frameworkWpf 'UIAutomationTypes.dll')" `
    /reference:"$(Join-Path $frameworkWpf 'WindowsBase.dll')" `
    /out:$output $sources

if ($LASTEXITCODE -ne 0) {
    throw "Windows host compilation failed with exit code $LASTEXITCODE"
}
