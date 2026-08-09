param(
    [switch]$VerifyOnly
)

$ErrorActionPreference = "Stop"

$archiveUrl = "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-08-08-13-06/ffmpeg-n7.1.5-12-g1fdbca85aa-win64-lgpl-shared-7.1.zip"
$archiveSha256 = "4450e09c6740b39777a195569b61cf415a3e7ccaf0eb17f8ac9e16c84787dab3"
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$binaryRoot = Join-Path $repositoryRoot "app\src-tauri\binaries"
$ffmpegPath = Join-Path $binaryRoot "ffmpeg-x86_64-pc-windows-msvc.exe"
$ffprobePath = Join-Path $binaryRoot "ffprobe-x86_64-pc-windows-msvc.exe"
$licenseRoot = Join-Path $binaryRoot "ffmpeg-license"

function Assert-Sidecars {
    if (-not (Test-Path -LiteralPath $ffmpegPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $ffprobePath -PathType Leaf)) {
        throw "FFmpeg sidecars are not installed. Run this script without -VerifyOnly."
    }
    if (-not (Test-Path -LiteralPath $licenseRoot -PathType Container) -or
        -not (Get-ChildItem -LiteralPath $licenseRoot -File | Where-Object { $_.Name -match "^(LICENSE|COPYING)" })) {
        throw "FFmpeg upstream license files are not installed."
    }

    $ffmpegVersion = & $ffmpegPath -version 2>&1
    $ffmpegVersionText = $ffmpegVersion -join "`n"
    if ($LASTEXITCODE -ne 0 -or $ffmpegVersionText -notmatch "ffmpeg version") {
        throw "The bundled ffmpeg executable did not start successfully."
    }
    $configuration = $ffmpegVersionText | Select-String "configuration:"
    if ($configuration -match "--enable-gpl" -or $configuration -match "--enable-nonfree") {
        throw "The bundled ffmpeg configuration is not LGPL-compatible."
    }

    $ffprobeVersion = & $ffprobePath -version 2>&1
    $ffprobeVersionText = $ffprobeVersion -join "`n"
    if ($LASTEXITCODE -ne 0 -or $ffprobeVersionText -notmatch "ffprobe version") {
        throw "The bundled ffprobe executable did not start successfully."
    }

    $encoders = & $ffmpegPath -hide_banner -encoders 2>&1
    $encoderText = $encoders -join "`n"
    if ($LASTEXITCODE -ne 0 -or $encoderText -notmatch "h264_mf" -or $encoderText -notmatch "\baac\b") {
        throw "The bundled ffmpeg is missing the required h264_mf or AAC encoder."
    }
}

if (-not $VerifyOnly) {
    $temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("lakomics-ffmpeg-" + [guid]::NewGuid())
    $archivePath = Join-Path $temporaryRoot "ffmpeg.zip"
    $extractRoot = Join-Path $temporaryRoot "extract"
    try {
        New-Item -ItemType Directory -Path $temporaryRoot | Out-Null
        Invoke-WebRequest -Uri $archiveUrl -OutFile $archivePath
        $actualSha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualSha256 -ne $archiveSha256) {
            throw "FFmpeg archive SHA-256 mismatch."
        }
        Expand-Archive -LiteralPath $archivePath -DestinationPath $extractRoot
        $sourceFfmpeg = Get-ChildItem -LiteralPath $extractRoot -Recurse -File -Filter "ffmpeg.exe" |
            Select-Object -First 1
        if (-not $sourceFfmpeg) {
            throw "The verified FFmpeg archive does not contain ffmpeg.exe."
        }
        $sourceBin = $sourceFfmpeg.Directory.FullName
        $archiveRoot = Split-Path -Parent $sourceBin
        $sourceFfprobe = Join-Path $sourceBin "ffprobe.exe"
        if (-not (Test-Path -LiteralPath $sourceFfprobe -PathType Leaf)) {
            throw "The verified FFmpeg archive does not contain ffprobe.exe."
        }

        New-Item -ItemType Directory -Path $binaryRoot -Force | Out-Null
        New-Item -ItemType Directory -Path $licenseRoot -Force | Out-Null
        Copy-Item -LiteralPath $sourceFfmpeg.FullName -Destination $ffmpegPath -Force
        Copy-Item -LiteralPath $sourceFfprobe -Destination $ffprobePath -Force
        Get-ChildItem -LiteralPath $sourceBin -File -Filter "*.dll" | ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $binaryRoot $_.Name) -Force
        }
        $licenseFiles = Get-ChildItem -LiteralPath $archiveRoot -Recurse -File |
            Where-Object { $_.Name -match "^(LICENSE|COPYING)" } |
            Group-Object Name |
            ForEach-Object { $_.Group | Select-Object -First 1 }
        if (-not $licenseFiles) {
            throw "The verified FFmpeg archive does not contain upstream license files."
        }
        $licenseFiles | ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $licenseRoot $_.Name) -Force
        }
    }
    finally {
        if (Test-Path -LiteralPath $temporaryRoot) {
            Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
        }
    }
}

Assert-Sidecars
Write-Output "FFmpeg Windows sidecars verified."
