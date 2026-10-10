#!/usr/bin/env bash
# Keep full Cargo output while exposing lock waits, failures, and hung tests.
set -uo pipefail

usage() {
    cat <<'EOF'
Usage: bash scripts/cargo-test.sh [--timeout SECONDS] [--jobs N]
       [--allow-concurrent] [--dry-run-preflight] [--] <cargo test args...>
Defaults: timeout 900 seconds; CARGO_BUILD_JOBS=2 unless already set.
--dry-run-preflight exercises rejection with a simulated process; runs no Cargo.
Relative CARGO_TARGET_DIR paths are resolved from the caller's working directory.
EOF
}

timeout_seconds=900
allow_concurrent=0
dry_run=0
while (( $# )); do
    case $1 in
        --timeout|--jobs)
            option=$1
            if (( $# < 2 )) || [[ ! $2 =~ ^[1-9][0-9]*$ ]]; then
                printf 'error: %s requires a positive integer\n' "$option" >&2
                exit 2
            fi
            if [[ $option == --timeout ]]; then timeout_seconds=$2; else export CARGO_BUILD_JOBS=$2; fi
            shift 2 ;;
        --allow-concurrent) allow_concurrent=1; shift ;;
        --dry-run-preflight) dry_run=1; shift ;;
        --help|-h) usage; exit 0 ;;
        --) shift; break ;;
        *) break ;;
    esac
done
export CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-2}
repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P) || exit 1
windows=0
case $OSTYPE in msys*|cygwin*|win32*) windows=1 ;; esac
if [[ -n ${CARGO_TARGET_DIR:-} ]]; then
    # Cargo runs in the crate, but worker paths are normally supplied at repo root.
    if (( windows )); then
        CARGO_TARGET_DIR=$(cygpath -am -- "$CARGO_TARGET_DIR") || exit 1
    elif [[ $CARGO_TARGET_DIR != /* ]]; then
        CARGO_TARGET_DIR="$PWD/$CARGO_TARGET_DIR"
    fi
    export CARGO_TARGET_DIR
fi
temp_dir=${TMPDIR:-/tmp}
if (( windows )); then
    temp_dir=$(cygpath -u -- "${TMPDIR:-${TEMP:-${TMP:-/tmp}}}") || exit 1
fi
log_file=$(mktemp "$temp_dir/lakomics-cargo-test.XXXXXX.log") || exit 1
printf 'Log: %s\n' "$log_file"

preflight() {
    if (( dry_run )); then
        printf 'SIMULATED process list (no process will be stopped):\n' >&2
        printf '424242\t2026-01-01T00:00:00Z\tcargo test simulated-lock-holder\n'
    elif (( windows )); then
        # shellcheck disable=SC2016 # These variables belong to PowerShell.
        powershell.exe -NoProfile -NonInteractive -Command '
            $ErrorActionPreference = "Stop"
            try {
                Get-CimInstance Win32_Process -Filter "Name = '\''cargo.exe'\'' OR Name = '\''rustc.exe'\''" | ForEach-Object {
                    "{0}`t{1}`t{2}" -f $_.ProcessId, $_.CreationDate.ToString("o"), $_.CommandLine
                }
            } catch { Write-Error $_; exit 1 }
        '
    else
        local entries status pid command started
        entries=$(pgrep -a -x 'cargo|rustc')
        status=$?
        (( status == 1 )) && return 0
        (( status == 0 )) || return "$status"
        while read -r pid command; do
            started=$(ps -p "$pid" -o lstart=) || started='exited during preflight'
            printf '%s\t%s\t%s\n' "$pid" "$started" "$command"
        done <<< "$entries"
    fi
}
processes=$(preflight) || { printf 'error: process preflight failed; refusing to run\n' | tee -a "$log_file"; exit 2; }
processes=${processes//$'\r'/}
if [[ -n $processes ]]; then
    {
        printf 'Other Rust processes (PID / start time / command line):\n%s\n' "$processes"
        while IFS=$'\t' read -r pid _; do
            if (( windows )); then
                printf 'Stop only after checking ownership: MSYS_NO_PATHCONV=1 taskkill.exe /PID %s /T /F\n' "$pid"
            else
                printf 'Stop only after checking ownership: kill -TERM %s\n' "$pid"
            fi
        done <<< "$processes"
    } | tee -a "$log_file"
    if (( ! allow_concurrent || dry_run )); then
        printf 'Preflight rejected concurrent Rust processes (exit 3). Use --allow-concurrent deliberately.\n' | tee -a "$log_file"
        exit 3
    fi
fi
(( dry_run )) && exit 0
cd -- "$repo_root/_tools/app/src-tauri" || exit 1
printf 'Running cargo test (timeout=%ss, jobs=%s, target=%s)\n' "$timeout_seconds" "$CARGO_BUILD_JOBS" "${CARGO_TARGET_DIR:-target}"

# Job control gives Cargo and its descendants a separate Linux process group.
# Use a regular log, not a pipe: the PID belongs to Cargo, and output is unbuffered.
set -m
cargo test "$@" >>"$log_file" 2>&1 &
cargo_pid=$!
set +m
tree_pid=$cargo_pid
if (( windows )); then
    # Git Bash PIDs differ from native Windows PIDs (WINPID column in MSYS ps).
    tree_pid=$(ps -p "$cargo_pid" | awk 'NR == 1 {for (i=1;i<=NF;i++) if ($i == "WINPID") column=i} NR == 2 && column {print $column}')
    if [[ ! $tree_pid =~ ^[0-9]+$ ]]; then
        # A very short Cargo invocation can already have exited; it needs no guard.
        if kill -0 "$cargo_pid" 2>/dev/null; then
            printf 'error: could not resolve native Cargo PID\n' >&2
            kill -TERM "$cargo_pid" 2>/dev/null
            wait "$cargo_pid"
            exit 2
        fi
    fi
fi

stop_tree() {
    if (( windows )); then
        if [[ $tree_pid =~ ^[0-9]+$ ]]; then
            # Prevent MSYS from rewriting /PID, /T and /F as filesystem paths.
            # taskkill prints in the console code page; keep it in the log only.
            if MSYS_NO_PATHCONV=1 taskkill.exe /PID "$tree_pid" /T /F >>"$log_file" 2>&1; then
                printf 'Stopped Cargo process tree %s.\n' "$tree_pid"
            else
                # Do not turn a denied taskkill into another indefinite wait.
                if kill -0 "$cargo_pid" 2>/dev/null; then
                    printf 'error: process-tree termination failed; processes may remain. Stop command: MSYS_NO_PATHCONV=1 taskkill.exe /PID %s /T /F\n' "$tree_pid" | tee -a "$log_file"
                    return 1
                fi
            fi
        fi
    else
        kill -TERM -- "-$cargo_pid" 2>/dev/null || true
        sleep 1
        kill -KILL -- "-$cargo_pid" 2>/dev/null || true
    fi
}
trap 'stop_tree && wait "$cargo_pid" 2>/dev/null; exit 130' INT
trap 'stop_tree && wait "$cargo_pid" 2>/dev/null; exit 143' TERM HUP

declare -A slow_tests=()
show_line() {
    local line=$1 name
    if [[ $line == *'has been running for over'* ]]; then
        name=${line#test }
        name=${name%% has been running for over*}
        slow_tests["$name"]=1
    elif [[ $line =~ ^test\ (.+)\ \.\.\.\ (ok|FAILED|ignored) ]]; then
        name=${BASH_REMATCH[1]}
        unset "slow_tests[$name]"
    fi
    # Match Cargo/libtest markers only; identifiers such as CredentialError are noise.
    case $line in
        *'Blocking waiting for file lock'*|*'Compiling lakomics'*|*'has been running for over'*|*'test result:'*|*' FAILED'*|'failures:'*|*'panicked at'*|'error'*) printf '%s\n' "$line" ;;
    esac
}
exec 3<"$log_file"
pending=''
drain_log() {
    local line=''
    while IFS= read -r line <&3; do
        show_line "$pending$line"
        pending=''
    done
    # Preserve a partially written line across EOF, instead of losing its prefix.
    pending+=$line
}
started=$SECONDS
timed_out=0
tree_stopped=1
while kill -0 "$cargo_pid" 2>/dev/null; do
    drain_log
    if (( SECONDS - started >= timeout_seconds )); then
        timed_out=1
        printf 'Timeout after %ss; stopping Cargo process tree %s.\n' "$timeout_seconds" "$tree_pid" | tee -a "$log_file"
        stop_tree || tree_stopped=0
        break
    fi
    sleep 0.1
done
result=0
if (( tree_stopped )); then
    wait "$cargo_pid" || result=$?
fi
drain_log
[[ -z $pending ]] || show_line "$pending"
exec 3<&-
trap - INT TERM HUP
if (( timed_out )); then
    result=124
    if (( ${#slow_tests[@]} )); then
        printf 'Tests still running at timeout:\n'
        printf '  %s\n' "${!slow_tests[@]}"
    else
        printf 'No slow-test warning received; Cargo may still have been compiling or waiting for a lock.\n'
    fi
fi
printf 'Cargo test summary: exit=%s, elapsed=%ss, log=%s\n' "$result" "$((SECONDS - started))" "$log_file"
exit "$result"
