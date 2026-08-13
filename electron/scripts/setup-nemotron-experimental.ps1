$ErrorActionPreference = "Stop"

$sourceCommit = "9bc876635af36df537d9bc6d3f57ad1b76e4f74a"
$sourceUrl = "https://github.com/NVIDIA/NeMo-Speech.cpp.git"
$sourcePatch = Join-Path $PSScriptRoot "patches\nemo-speech-windows-sentencepiece.patch"
$vcpkgCommit = "e12aaf7336cc1e348c43a1244f348451b534c0a9"
$vcpkgUrl = "https://github.com/microsoft/vcpkg.git"
$vcpkgTriplet = "x64-windows"
$modelName = "nemotron-speech-streaming-en-0.6b.q8_0.gguf"
$modelUrl = "https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b/resolve/main/$modelName"
$modelSha256 = "d9a01898d2a611c8764e23a1c2f45e70bbd5a425dc4de93692ac951dd603812d"
$modelSize = 699872960

if (-not $env:LOCALAPPDATA) { throw "LOCALAPPDATA is unavailable." }
foreach ($tool in @("git", "cmake", "ninja", "nvcc", "curl.exe")) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        throw "$tool is required. Install CMake, Ninja, Visual Studio 2022 Build Tools, and the CUDA Toolkit first."
    }
}

$undertoneRoot = Join-Path $env:LOCALAPPDATA "Undertone"
$runtimePrefix = Join-Path $env:LOCALAPPDATA "Programs\NeMoSpeech"
$modelPath = Join-Path $undertoneRoot "models\$modelName"
$modelDownload = "$modelPath.download"

function Test-PinnedModel([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    if ((Get-Item -LiteralPath $Path).Length -ne $modelSize) { return $false }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -eq $modelSha256
}

$installModel = -not (Test-PinnedModel $modelPath)
if ($installModel) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $modelPath) | Out-Null
    Write-Host "Downloading the pinned Nemotron streaming model..."
    & curl.exe --location --fail --retry 10 --retry-delay 2 --retry-all-errors `
        --connect-timeout 30 --continue-at - --output $modelDownload $modelUrl
    if ($LASTEXITCODE -ne 0) { throw "Nemotron model download failed." }
    if (-not (Test-PinnedModel $modelDownload)) {
        throw "Nemotron model size or SHA-256 did not match the pinned artifact."
    }
}

$work = Join-Path ([IO.Path]::GetTempPath()) ("undertone-nemotron-" + [Guid]::NewGuid().ToString("N"))
$source = Join-Path $work "source"
$build = Join-Path $work "build"
$vcpkg = Join-Path $work "vcpkg"
$stagedRuntime = Join-Path $work "runtime"

New-Item -ItemType Directory -Path $work | Out-Null
try {
    Write-Host "Cloning pinned NeMo-Speech.cpp source..."
    & git clone --filter=blob:none $sourceUrl $source
    if ($LASTEXITCODE -ne 0) { throw "NeMo-Speech.cpp clone failed." }
    & git -C $source checkout --detach $sourceCommit
    if ($LASTEXITCODE -ne 0) { throw "Could not check out the pinned NeMo-Speech.cpp commit." }
    & git -C $source submodule update --init ggml third_party/cpp-httplib
    if ($LASTEXITCODE -ne 0) { throw "NeMo-Speech.cpp submodule setup failed." }
    & git -C $source apply --check $sourcePatch
    if ($LASTEXITCODE -ne 0) { throw "The pinned NeMo-Speech.cpp dependency patch no longer applies." }
    & git -C $source apply $sourcePatch
    if ($LASTEXITCODE -ne 0) { throw "Could not apply the NeMo-Speech.cpp dependency patch." }

    Write-Host "Building the pinned SentencePiece dependency..."
    & git clone --filter=blob:none --no-checkout $vcpkgUrl $vcpkg
    if ($LASTEXITCODE -ne 0) { throw "vcpkg clone failed." }
    & git -C $vcpkg checkout --detach $vcpkgCommit
    if ($LASTEXITCODE -ne 0) { throw "Could not check out the pinned vcpkg commit." }
    & (Join-Path $vcpkg "bootstrap-vcpkg.bat") -disableMetrics
    if ($LASTEXITCODE -ne 0) { throw "vcpkg bootstrap failed." }
    & (Join-Path $vcpkg "vcpkg.exe") install "sentencepiece:$vcpkgTriplet" --disable-metrics
    if ($LASTEXITCODE -ne 0) { throw "SentencePiece build failed." }

    Write-Host "Building the Windows CUDA ASR server..."
    $dependencyPrefix = Join-Path $vcpkg "installed\$vcpkgTriplet"
    $env:CMAKE_TOOLCHAIN_FILE = Join-Path $vcpkg "scripts\buildsystems\vcpkg.cmake"
    $env:CMAKE_PREFIX_PATH = $dependencyPrefix
    $env:CMAKE_INCLUDE_PATH = Join-Path $dependencyPrefix "include"
    $env:CMAKE_LIBRARY_PATH = Join-Path $dependencyPrefix "lib"
    $env:VCPKG_DEFAULT_TRIPLET = $vcpkgTriplet
    & (Join-Path $source "scripts\windows\build.ps1") `
        -Backend cuda -BuildDir $build -Config Release -AsrOnly -Http
    if ($LASTEXITCODE -ne 0) { throw "NeMo-Speech.cpp build failed." }
    & cmake --install $build --config Release --prefix $stagedRuntime
    if ($LASTEXITCODE -ne 0) { throw "NeMo-Speech.cpp staging failed." }
    Copy-Item -Path (Join-Path $dependencyPrefix "bin\*.dll") `
        -Destination (Join-Path $stagedRuntime "bin") -Force
    $vcpkgLicenseRoot = Join-Path $stagedRuntime "share\licenses\vcpkg"
    Get-ChildItem -Path (Join-Path $dependencyPrefix "share") -Filter copyright -Recurse | ForEach-Object {
        $packageName = Split-Path -Leaf (Split-Path -Parent $_.FullName)
        $licenseTarget = Join-Path $vcpkgLicenseRoot $packageName
        New-Item -ItemType Directory -Force -Path $licenseTarget | Out-Null
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $licenseTarget "copyright") -Force
    }
    $stagedExe = Join-Path $stagedRuntime "bin\nemo-speech.exe"
    if (-not (Test-Path -LiteralPath $stagedExe -PathType Leaf)) {
        throw "The NeMo-Speech.cpp build did not produce nemo-speech.exe."
    }

    $runtimeBackup = "$runtimePrefix.previous"
    if (Test-Path -LiteralPath $runtimeBackup) {
        throw "Remove or recover the existing runtime backup first: $runtimeBackup"
    }
    if (Test-Path -LiteralPath $runtimePrefix) {
        Move-Item -LiteralPath $runtimePrefix -Destination $runtimeBackup
    }
    try {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $runtimePrefix) | Out-Null
        Move-Item -LiteralPath $stagedRuntime -Destination $runtimePrefix
    } catch {
        if (Test-Path -LiteralPath $runtimeBackup) {
            Move-Item -LiteralPath $runtimeBackup -Destination $runtimePrefix
        }
        throw
    }
    if (Test-Path -LiteralPath $runtimeBackup) {
        Remove-Item -LiteralPath $runtimeBackup -Recurse -Force
    }

    if ($installModel) {
        $modelBackup = "$modelPath.previous"
        if (Test-Path -LiteralPath $modelBackup) {
            throw "Remove or recover the existing model backup first: $modelBackup"
        }
        if (Test-Path -LiteralPath $modelPath) {
            Move-Item -LiteralPath $modelPath -Destination $modelBackup
        }
        try {
            Move-Item -LiteralPath $modelDownload -Destination $modelPath
        } catch {
            if (Test-Path -LiteralPath $modelBackup) {
                Move-Item -LiteralPath $modelBackup -Destination $modelPath
            }
            throw
        }
        if (Test-Path -LiteralPath $modelBackup) {
            Remove-Item -LiteralPath $modelBackup -Force
        }
    }

    Write-Host "Nemotron streaming is ready. Select it in Undertone Settings > Speech & AI."
} finally {
    if (Test-Path -LiteralPath $work) {
        Remove-Item -LiteralPath $work -Recurse -Force
    }
}
