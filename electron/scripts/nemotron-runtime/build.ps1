<#
.SYNOPSIS
Build the pinned portable Nemotron CPU and CUDA release archives.

.DESCRIPTION
SourceRoot must be a checkout of NVIDIA/NeMo-Speech.cpp at the commit recorded
below. VcpkgRoot must contain x64-windows abseil, protobuf, sentencepiece, and
utf8-range. CudaRoot must contain the CUDA 12.8 compiler plus cuBLAS runtime.
The script applies the pinned upstream ggml patch series, builds both variants
without machine-native CPU instructions, copies runtime dependencies and
licenses, and prints the finished archive sizes and SHA-256 hashes.

.EXAMPLE
.\build.ps1 -SourceRoot C:\src\NeMo-Speech.cpp `
  -VcpkgRoot C:\vcpkg -CudaRoot C:\cuda-12.8 -OutputRoot C:\build\nemotron
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$SourceRoot,
    [Parameter(Mandatory)]
    [string]$VcpkgRoot,
    [Parameter(Mandatory)]
    [string]$CudaRoot,
    [Parameter(Mandatory)]
    [string]$OutputRoot,
    [string]$Version = '0.1.0',
    [string]$CudaArchitectures = '75;86;89;120'
)

$ErrorActionPreference = 'Stop'
$SourceCommit = '9bc876635af36df537d9bc6d3f57ad1b76e4f74a'
$PortableGgml = @(
    '-DGGML_NATIVE=OFF',
    '-DGGML_SSE42=OFF',
    '-DGGML_AVX=OFF',
    '-DGGML_AVX2=OFF',
    '-DGGML_BMI2=OFF'
)

function Require-Path([string]$Value, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Value)) { throw "$Label not found: $Value" }
}

function Apply-Patch([string]$Patch) {
    & git -C $SourceRoot apply --check $Patch 2>$null
    if ($LASTEXITCODE -eq 0) {
        & git -C $SourceRoot apply $Patch
        if ($LASTEXITCODE -ne 0) { throw "Could not apply $Patch" }
        return
    }
    & git -C $SourceRoot apply --reverse --check $Patch 2>$null
    if ($LASTEXITCODE -ne 0) { throw "Patch is neither applicable nor already applied: $Patch" }
}

function Configure-Build([string]$Backend, [string]$BuildRoot) {
    $arguments = @(
        '-S', $SourceRoot,
        '-B', $BuildRoot,
        '-G', 'Ninja',
        '-DCMAKE_BUILD_TYPE=Release',
        "-DCMAKE_TOOLCHAIN_FILE=$VcpkgRoot\scripts\buildsystems\vcpkg.cmake",
        '-DVCPKG_TARGET_TRIPLET=x64-windows',
        '-DNEMO_SPEECH_BUILD_ASR=ON',
        '-DNEMO_SPEECH_BUILD_CLI=ON',
        '-DNEMO_SPEECH_BUILD_DIAR=ON',
        '-DNEMO_SPEECH_BUILD_EXAMPLES=OFF',
        '-DNEMO_SPEECH_BUILD_GRPC=OFF',
        '-DNEMO_SPEECH_BUILD_HTTP=ON',
        '-DNEMO_SPEECH_BUILD_NMT=OFF',
        '-DNEMO_SPEECH_BUILD_TESTS=OFF',
        '-DNEMO_SPEECH_BUILD_TOOLS=OFF',
        '-DNEMO_SPEECH_BUILD_TTS=OFF',
        '-DNEMO_SPEECH_WITH_FLASHLIGHT=OFF',
        '-DNEMO_SPEECH_WITH_GRPC=OFF',
        '-DNEMO_SPEECH_WITH_NMT=OFF',
        '-DNEMO_SPEECH_WITH_NORM=OFF'
    ) + $PortableGgml
    if ($Backend -eq 'cuda') {
        $arguments += '-DGGML_CUDA=ON'
        $arguments += "-DCMAKE_CUDA_COMPILER=$CudaRoot\bin\nvcc.exe"
        $arguments += "-DCMAKE_CUDA_ARCHITECTURES=$CudaArchitectures"
    } else {
        $arguments += '-DGGML_CUDA=OFF'
        $arguments += '-DNEMO_SPEECH_GGML_PATCHED=OFF'
    }
    & cmake @arguments
    if ($LASTEXITCODE -ne 0) { throw "$Backend configure failed" }
    & cmake --build $BuildRoot --config Release --parallel
    if ($LASTEXITCODE -ne 0) { throw "$Backend build failed" }
}

function New-Package([string]$Build, [string]$Package, [string]$Backend) {
    New-Item -ItemType Directory -Path $Package | Out-Null
    Copy-Item -Path "$Build\bin\*.dll", "$Build\bin\nemo-speech.exe" -Destination $Package

    $redistRoot = Get-ChildItem "$vsPath\VC\Redist\MSVC" -Directory |
        Sort-Object Name | Select-Object -Last 1 -ExpandProperty FullName
    foreach ($file in 'msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll') {
        Copy-Item -LiteralPath "$redistRoot\x64\Microsoft.VC143.CRT\$file" -Destination $Package
    }
    Copy-Item -LiteralPath "$redistRoot\x64\Microsoft.VC143.OpenMP\vcomp140.dll" -Destination $Package

    Copy-Item -LiteralPath "$SourceRoot\LICENSE" -Destination "$Package\LICENSE-NEMO-SPEECH.txt"
    Copy-Item -LiteralPath "$SourceRoot\NOTICE" -Destination "$Package\NOTICE-NEMO-SPEECH.txt"
    Copy-Item -LiteralPath "$SourceRoot\THIRD_PARTY_NOTICES.md" -Destination $Package
    foreach ($dependency in 'abseil', 'protobuf', 'sentencepiece') {
        Copy-Item -LiteralPath "$VcpkgRoot\installed\x64-windows\share\$dependency\copyright" `
            -Destination "$Package\LICENSE-$($dependency.ToUpperInvariant()).txt"
    }
    [IO.File]::WriteAllText(
        "$Package\undertone-nemotron-$Backend.txt",
        "Undertone Nemotron runtime $Version ($Backend)`r`nNeMo-Speech.cpp $SourceCommit`r`nCPU baseline: x86-64 SSE2 (GGML_NATIVE=OFF)`r`n"
    )
    if ($Backend -eq 'cuda') {
        foreach ($file in 'cudart64_12.dll', 'cublas64_12.dll', 'cublasLt64_12.dll') {
            Copy-Item -LiteralPath "$CudaRoot\bin\$file" -Destination $Package
        }
        Copy-Item -LiteralPath "$CudaRoot\LICENSE" -Destination "$Package\LICENSE-CUDA.txt"
    }
}

Require-Path $SourceRoot 'NeMo-Speech.cpp source'
Require-Path "$VcpkgRoot\vcpkg.exe" 'vcpkg'
Require-Path "$CudaRoot\bin\nvcc.exe" 'CUDA compiler'
if (Test-Path -LiteralPath $OutputRoot) { throw "Output directory already exists: $OutputRoot" }

$actualCommit = (& git -C $SourceRoot rev-parse HEAD).Trim()
if ($actualCommit -ne $SourceCommit) { throw "Expected source $SourceCommit, found $actualCommit" }
& git -C $SourceRoot submodule update --init ggml third_party/cpp-httplib
if ($LASTEXITCODE -ne 0) { throw 'Could not initialize required submodules' }
& "$SourceRoot\scripts\windows\apply-ggml-patches.ps1"
if ($LASTEXITCODE -ne 0) { throw 'Could not apply the pinned ggml patches' }
Apply-Patch "$PSScriptRoot\abseil-flags.patch"

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
Require-Path $vswhere 'vswhere'
$vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vsPath) { throw 'Visual Studio 2022 C++ Build Tools are required' }
$vcvars = "$vsPath\VC\Auxiliary\Build\vcvars64.bat"
cmd.exe /s /c "`"$vcvars`" >nul && set" | ForEach-Object {
    if ($_ -match '^([^=]+)=(.*)$') { Set-Item -Path "env:$($Matches[1])" -Value $Matches[2] }
}
$env:CUDA_PATH = $CudaRoot
$env:PATH = "$CudaRoot\bin;$env:PATH"

New-Item -ItemType Directory -Path $OutputRoot | Out-Null
$cpuBuild = "$OutputRoot\build-cpu"
$cudaBuild = "$OutputRoot\build-cuda"
Configure-Build 'cpu' $cpuBuild
Configure-Build 'cuda' $cudaBuild

$cpuPackage = "$OutputRoot\package-cpu"
$cudaPackage = "$OutputRoot\package-cuda"
New-Package $cpuBuild $cpuPackage 'cpu'
New-Package $cudaBuild $cudaPackage 'cuda'

$cpuZip = "$OutputRoot\undertone-nemotron-runtime-$Version-windows-x64-cpu.zip"
$cudaZip = "$OutputRoot\undertone-nemotron-runtime-$Version-windows-x64-cuda.zip"
Compress-Archive -Path "$cpuPackage\*" -DestinationPath $cpuZip -CompressionLevel Optimal
Compress-Archive -Path "$cudaPackage\*" -DestinationPath $cudaZip -CompressionLevel Optimal
Get-Item $cpuZip, $cudaZip | ForEach-Object {
    [pscustomobject]@{
        name = $_.Name
        size = $_.Length
        sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant()
    }
}
