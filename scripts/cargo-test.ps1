# Windows/PowerShell twin of cargo-test.sh for shells where Git Bash cannot start (the Codex
# Windows sandbox): keep full Cargo output in a log while showing lock waits, failures and hung tests.
# Usage: powershell -File scripts/cargo-test.ps1 [-Timeout S] [-Jobs N] [-AllowConcurrent] [-DryRunPreflight]
#        [--] <cargo test args...>   (several filters: -- -- <f1> <f2>)
# No param block: PowerShell's binder rejects a bare `--`, so options are read from $args by hand.
$ErrorActionPreference = 'Stop'
$Timeout = 900; $Jobs = 0; $AllowConcurrent = $false; $DryRunPreflight = $false
$rest = [Collections.Generic.Queue[string]]::new([string[]]@($args))
$CargoArgs = @()
while ($rest.Count) {
    $arg = $rest.Dequeue()
    if ($arg -in '-Timeout', '-Jobs') {
        $value = 0
        if (-not $rest.Count -or -not [int]::TryParse($rest.Peek(), [ref]$value) -or $value -lt 1) {
            Write-Error "$arg requires a positive integer"; exit 2
        }
        [void]$rest.Dequeue()
        if ($arg -eq '-Timeout') { $Timeout = $value } else { $Jobs = $value }
    } elseif ($arg -eq '-AllowConcurrent') { $AllowConcurrent = $true }
    elseif ($arg -eq '-DryRunPreflight') { $DryRunPreflight = $true }
    elseif ($arg -eq '--') { $CargoArgs = @($rest); break }
    else { $CargoArgs = @($arg) + @($rest); break }
}
if ($Jobs -gt 0) { $env:CARGO_BUILD_JOBS = "$Jobs" } elseif (-not $env:CARGO_BUILD_JOBS) { $env:CARGO_BUILD_JOBS = '2' }
$repoRoot = Split-Path -Parent $PSScriptRoot
# Cargo runs in the crate, but worker paths are normally supplied relative to the caller.
# Windows PowerShell 5.1 (.NET Framework) has no GetFullPath(path, base); resolve against the current directory by hand.
if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR = [IO.Path]::GetFullPath([IO.Path]::Combine((Get-Location).Path, $env:CARGO_TARGET_DIR)) }
$log = Join-Path ([IO.Path]::GetTempPath()) ("lakomics-cargo-test.{0}.log" -f [IO.Path]::GetRandomFileName())
New-Item -ItemType File -Path $log | Out-Null
"Log: $log"

function Get-RustProcesses {
    if ($DryRunPreflight) { return @("424242`t2026-01-01T00:00:00Z`tcargo test simulated-lock-holder") }
    try {
        @(Get-CimInstance Win32_Process -Filter "Name = 'cargo.exe' OR Name = 'rustc.exe'" | ForEach-Object {
            "{0}`t{1}`t{2}" -f $_.ProcessId, $_.CreationDate.ToString('o'), $_.CommandLine })
    } catch {
        # A sandboxed shell may not reach WMI; names and start times still show a lock holder.
        @(Get-Process -Name cargo, rustc -ErrorAction SilentlyContinue | ForEach-Object {
            "{0}`t{1}`t{2}" -f $_.Id, $(try { $_.StartTime.ToString('o') } catch { '?' }), $_.ProcessName })
    }
}
$processes = Get-RustProcesses
if ($processes.Count) {
    $report = @('Other Rust processes (PID / start time / command line):') + $processes +
        ($processes | ForEach-Object { "Stop only after checking ownership: taskkill.exe /PID $(($_ -split "`t")[0]) /T /F" })
    $report | Tee-Object -FilePath $log -Append
    if (-not $AllowConcurrent -or $DryRunPreflight) {
        'Preflight rejected concurrent Rust processes (exit 3). Use -AllowConcurrent deliberately.' | Tee-Object -FilePath $log -Append
        exit 3
    }
}
if ($DryRunPreflight) { exit 0 }
$target = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { 'target' }
"Running cargo test (timeout=${Timeout}s, jobs=$($env:CARGO_BUILD_JOBS), target=$target)"

$errLog = "$log.stderr"
$quoted = @('test') + $CargoArgs | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }
$cargo = Start-Process -FilePath cargo -ArgumentList $quoted -WorkingDirectory (Join-Path $repoRoot '_tools/app/src-tauri') `
    -NoNewWindow -PassThru -RedirectStandardOutput $log -RedirectStandardError $errLog
# On .NET Framework a process started with -PassThru reports no ExitCode unless its handle was taken while it ran.
$null = $cargo.Handle
$slow = [Collections.Generic.HashSet[string]]::new()
$seen = @{ $log = 0; $errLog = 0 }
function Show-NewLines {
    foreach ($file in @($log, $errLog)) {
        if (-not (Test-Path $file)) { continue }
        $lines = @(Get-Content -LiteralPath $file -Encoding utf8 -ErrorAction SilentlyContinue)
        # Leave the last line until it is complete; Cargo may still be writing it.
        $complete = if ($cargo.HasExited) { $lines.Count } else { [Math]::Max(0, $lines.Count - 1) }
        for ($i = $seen[$file]; $i -lt $complete; $i++) {
            $line = $lines[$i]
            if ($line -match '^test (.+) has been running for over') { [void]$slow.Add($Matches[1]) }
            elseif ($line -match '^test (.+) \.\.\. (ok|FAILED|ignored)') { [void]$slow.Remove($Matches[1]) }
            # Match Cargo/libtest markers only; identifiers such as CredentialError are noise.
            if ($line -match 'Blocking waiting for file lock|Compiling lakomics|has been running for over|test result:| FAILED|^failures:|panicked at|^error') { $line }
        }
        $seen[$file] = [Math]::Max($seen[$file], $complete)
    }
}
$watch = [Diagnostics.Stopwatch]::StartNew()
$timedOut = $false
while (-not $cargo.HasExited) {
    Show-NewLines
    if ($watch.Elapsed.TotalSeconds -ge $Timeout) {
        $timedOut = $true
        "Timeout after ${Timeout}s; stopping Cargo process tree $($cargo.Id)."
        & taskkill.exe /PID $cargo.Id /T /F *> $null
        if (-not $cargo.WaitForExit(10000)) {
            "error: process-tree termination failed; processes may remain. Stop command: taskkill.exe /PID $($cargo.Id) /T /F"
        }
        break
    }
    Start-Sleep -Milliseconds 100
}
$cargo.WaitForExit()
Show-NewLines
Get-Content -LiteralPath $errLog -Encoding utf8 -ErrorAction SilentlyContinue | Add-Content -LiteralPath $log -Encoding utf8
Remove-Item -LiteralPath $errLog -ErrorAction SilentlyContinue
$result = if ($timedOut) { 124 } else { $cargo.ExitCode }
if ($timedOut) {
    if ($slow.Count) { 'Tests still running at timeout:'; $slow | ForEach-Object { "  $_" } }
    else { 'No slow-test warning received; Cargo may still have been compiling or waiting for a lock.' }
}
"Cargo test summary: exit=$result, elapsed=$([int]$watch.Elapsed.TotalSeconds)s, log=$log"
exit $result
