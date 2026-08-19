$ErrorActionPreference = "Stop"

$electronRoot = Split-Path -Parent $PSScriptRoot
$hostSource = Join-Path $electronRoot "native\Undertone.WinHost"
$testSource = Join-Path $electronRoot "tests\native\FocusIdentityTests.cs"
$outputDir = Join-Path $electronRoot "dist\native-tests"
$output = Join-Path $outputDir "Undertone.WinHost.Tests.exe"
$compiler = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$frameworkWpf = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\WPF"

if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) {
    throw "The .NET Framework C# compiler is unavailable: $compiler"
}

New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
& $compiler /nologo /target:exe /platform:x64 /optimize+ `
    /main:FocusIdentityTests `
    /reference:System.dll `
    /reference:System.Core.dll `
    /reference:"$(Join-Path $frameworkWpf 'UIAutomationClient.dll')" `
    /reference:"$(Join-Path $frameworkWpf 'UIAutomationTypes.dll')" `
    /reference:"$(Join-Path $frameworkWpf 'WindowsBase.dll')" `
    /out:$output `
    (Join-Path $hostSource "Desktop.cs") `
    (Join-Path $hostSource "FocusReader.cs") `
    (Join-Path $hostSource "FocusSampleAccumulator.cs") `
    $testSource

if ($LASTEXITCODE -ne 0) {
    throw "Native focus tests failed to compile with exit code $LASTEXITCODE"
}

& $output
if ($LASTEXITCODE -ne 0) {
    throw "Native focus tests failed with exit code $LASTEXITCODE"
}
