#!/usr/bin/env bash
# Run every suite, retain full logs, and return nonzero if any suite fails.
set -uo pipefail
repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
app_dir="$repo_root/_tools/app"
log_dir=$(mktemp -d "${TMPDIR:-/tmp}/lakomics-check.XXXXXX") || exit 1
export CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-2}
started=$SECONDS
failed=0
rows=()
free_kib=$(df -Pk "$repo_root" | awk 'END {print $4}')
if [[ "$free_kib" =~ ^[0-9]+$ ]] && (( free_kib < 20 * 1024 * 1024 )); then
    printf 'WARNING: less than 20 GiB free on the repository filesystem.\n' >&2
fi
printf 'Logs: %s\n' "$log_dir"

run_check() {
    local label=$1 directory=$2 log_name=$3
    shift 3
    local begin=$SECONDS result=0 status=PASS
    printf 'Running %s...\n' "$label"
    (cd -- "$directory" && timeout --kill-after=10 "${CHECK_TIMEOUT_SECONDS:-900}" "$@") >"$log_dir/$log_name.log" 2>&1 || result=$?
    if (( result != 0 )); then
        status="FAIL($result)"
        failed=1
        tail -n 12 "$log_dir/$log_name.log"
    fi
    rows+=("$(printf '%-20s %-10s %6ss' "$label" "$status" "$((SECONDS - begin))")")
}

run_check 'PC Vitest' "$app_dir" pc-vitest npm test -- --maxWorkers=2
run_check 'Tablet Vitest' "$app_dir" tablet-vitest npm run mobile:test -- --maxWorkers=2
run_check 'PC TypeScript' "$app_dir" pc-tsc ./node_modules/.bin/tsc --noEmit
run_check 'Tablet TypeScript' "$app_dir" tablet-tsc ./node_modules/.bin/tsc -p tsconfig.mobile.json --noEmit
run_check 'Rust lib tests' "$app_dir/src-tauri" rust cargo test --lib
server_python=${SERVER_PYTHON:-"$repo_root/server/lakomics-api/.venv/bin/python"}
run_check 'Server unittest' "$repo_root/server/lakomics-api" server "$server_python" -m unittest discover -s tests
run_check 'Perf kit Node' "$repo_root" perf node --test --test-isolation=none _tools/app/scripts/native-check/perf.test.mjs _tools/app/scripts/perf/report.test.mjs
run_check 'Collector tests' "$repo_root/extension-list" collector npm test
printf '\n%-20s %-10s %7s\n' 'Check' 'Result' 'Time'
printf '%s\n' "${rows[@]}"
printf 'Total: %ss | Logs: %s\n' "$((SECONDS - started))" "$log_dir"
exit "$failed"
