# Lakomics Repository Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate the completed PC inbound consumer and Capture Inbox server/extension work into GitHub `main`, leaving `C:\chatgpt` as the clean canonical checkout.

**Architecture:** Preserve the current dirty feature branch with explicit allowlist commits, verify the fetched inbound consumer before rebasing, then fast-forward the validated combined history through local and remote `main`. One-use local files are retained through exact `.git/info/exclude` entries, while only repeatable build tooling enters Git.

**Tech Stack:** Git, PowerShell, Rust/Cargo, React/TypeScript/Vitest, Node test runner, Python unittest/FastAPI

**Spec:** `docs/superpowers/specs/2026-08-31-repository-consolidation-design.md`

## Global Constraints

- Work only in `C:\chatgpt`; inspect `lqc` read-only.
- Do not redeploy or contact the production VPS.
- Do not delete `lqc`, local one-use scripts, generated archives, caches, backups, or temporary files.
- Never use `git reset --hard`, `git clean -fd`, force push, broad `git add -A`, or a destructive checkout.
- Stage every commit with an explicit file allowlist and inspect the staged diff before committing.
- Stop on a missing inbound commit, ambiguous conflict, failing integrated test, rejected push, or impossible fast-forward.
- Do not fix the known one-successful-capture-per-invocation behavior in this task.

---

### Task 1: Separate reusable tooling from local one-use artifacts

**Files:**
- Modify locally only: `.git/info/exclude`
- Modify: `scripts/publish-extension-dev.ps1`
- Include unchanged: `scripts/pack-extension-zip.py`
- Include unchanged: `scripts/rebuild-background-worker.py`

**Interfaces:**
- Consumes: manifest icon declarations in `extension/manifest.json`
- Produces: a development distribution stage containing `manifest.json`, `src/`, `options/`, and `icons/`

- [ ] **Step 1: Add exact local-only exclusions**

Append only missing exact paths to `.git/info/exclude`:

```text
/extension.zip
/extension/PATCH_NOTES_15.30.txt
/scripts/cleanup-quetta-tests.py
/scripts/import-vps-lakomics-api.ps1
/scripts/patch-crx-id-compat.py
/scripts/patch-crx-id-tests.py
/scripts/patch-quetta-options-tests.py
/scripts/patch-quetta-options.py
/scripts/revert-quetta-and-setup-titanium.py
```

Edit `.git/info/exclude` with `apply_patch`, adding only lines not already
present. Do not add generic patterns and do not delete any listed file.

- [ ] **Step 2: Make the repeatable publisher include required icons**

In `scripts/publish-extension-dev.ps1`, add this alongside the existing stage
copy operations:

```powershell
Copy-Item (Join-Path $extension "icons") $stage -Recurse
```

- [ ] **Step 3: Validate the reusable packaging path without publishing**

Create a uniquely named temporary directory, copy the same four extension
inputs into its stage, and run:

```powershell
$packageTempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("lakomics-extension-package-" + [guid]::NewGuid())
$packageStage = Join-Path $packageTempRoot "stage"
$packageZip = Join-Path $packageTempRoot "extension.zip"
New-Item -ItemType Directory -Path $packageStage | Out-Null
Copy-Item extension/manifest.json $packageStage
Copy-Item extension/src $packageStage -Recurse
Copy-Item extension/options $packageStage -Recurse
Copy-Item extension/icons $packageStage -Recurse
python scripts/pack-extension-zip.py $packageStage $packageZip
python -c "import sys,zipfile; names=set(zipfile.ZipFile(sys.argv[1]).namelist()); assert {'manifest.json','icons/icon32.png','icons/icon128.png'} <= names" $packageZip
$resolvedPackageTemp = (Resolve-Path -LiteralPath $packageTempRoot).Path
if (-not $resolvedPackageTemp.StartsWith([System.IO.Path]::GetTempPath(), [System.StringComparison]::OrdinalIgnoreCase)) { throw "Unexpected package temp path" }
Remove-Item -LiteralPath $resolvedPackageTemp -Recurse -Force
```

Expected: both commands exit 0. Remove only the explicitly created temporary
directory after resolving its absolute path under the system temp directory.

- [ ] **Step 4: Confirm local-only artifacts no longer dirty status**

Run:

```powershell
git status --short
git status --short --ignored
```

Expected: the exact one-use paths disappear from ordinary status but remain
visible as ignored local files with `--ignored`; legitimate source files remain
visible.

---

### Task 2: Commit the completed Collector and server implementation

**Files:**
- Modify: `.gitignore`
- Modify: `extension/README.md`
- Modify: `extension/TABLET_INSTALL.md`
- Modify: `extension/manifest.json`
- Modify: `extension/options/options.css`
- Modify: `extension/options/options.html`
- Modify: `extension/options/options.js`
- Modify: `extension/src/background.js`
- Modify generated: `extension/src/background-worker.js`
- Modify: `extension/src/defaults.js`
- Modify: `extension/tests/background.test.mjs`
- Create: `extension/icons/icon32.png`
- Create: `extension/icons/icon128.png`
- Create: `server/lakomics-api/.gitignore`
- Create: `server/lakomics-api/app.py`
- Create: `server/lakomics-api/capture_store.py`
- Create: `server/lakomics-api/r2.py`
- Create: `server/lakomics-api/tests/test_capture_api.py`
- Create: `docs/superpowers/specs/2026-08-31-vps-capture-video-design.md`
- Create: `docs/superpowers/plans/2026-08-31-vps-capture-video.md`
- Create: `docs/superpowers/plans/2026-08-31-repository-consolidation.md`
- Create: `scripts/pack-extension-zip.py`
- Create: `scripts/publish-extension-dev.ps1`
- Create: `scripts/rebuild-background-worker.py`

**Interfaces:**
- Consumes: PC consumer snake_case `/pending`, `/download`, and `/acknowledge` contract from commit `85027db`
- Produces: backward-compatible image/video Capture API, extension Collector routing, generated worker, repeatable packaging tooling, and regression tests

- [ ] **Step 1: Rebuild the tracked worker**

Run:

```powershell
python scripts/rebuild-background-worker.py
```

Expected: `background-worker rebuilt`.

- [ ] **Step 2: Inspect the complete allowlist before staging**

Run `git diff --check`, `git status --short`, and inspect diffs for every file
listed in this task. Confirm that server `.env`, DB, `.venv`, logs, `*.bak*`,
`extension.zip`, patch scripts, and `PATCH_NOTES_15.30.txt` are absent.

- [ ] **Step 3: Stage only the explicit implementation allowlist**

Use one `git add --` command containing exactly the paths listed in this
task, including this repository-consolidation plan.

- [ ] **Step 4: Audit staged contents**

Run:

```powershell
git diff --cached --check
git diff --cached --stat
git diff --cached --name-status
git diff --cached
git status --short
```

Search the staged patch for credential assignments or real bearer values.
Expected: only test dummy tokens and environment variable names appear.

- [ ] **Step 5: Commit the completed implementation**

```powershell
git commit -m "feat: add VPS capture inbox collector"
```

Expected: one coherent commit containing the preserved server/extension work
and no one-use artifacts.

---

### Task 3: Verify the inbound consumer on current remote main

**Files:**
- Read only: remote refs and fetched `origin/main`
- Read only: `app/src-tauri/src/cloud/captures.rs`
- Read only: `app/src-tauri/migrations/0029_cloud_capture_imports.sql`
- Read only: `app/src/app/useCloudCaptureSync.ts`

**Interfaces:**
- Consumes: GitHub `origin/main`
- Produces: a hard gate proving the server contract consumer is present before rebase

- [ ] **Step 1: Fetch origin without modifying working files**

```powershell
git fetch origin
```

- [ ] **Step 2: Verify commit reachability**

```powershell
git merge-base --is-ancestor 85027db origin/main
git log --oneline --decorate -10 origin/main
```

Expected: the ancestry command exits 0 and `85027db` is visible or reachable.
If it fails, stop.

- [ ] **Step 3: Verify implementation presence**

Run these read-only checks:

```powershell
git show origin/main:app/src-tauri/src/cloud/captures.rs | rg "/v1/captures/pending|/download|/acknowledge|ingest_media"
git show origin/main:app/src-tauri/migrations/0029_cloud_capture_imports.sql | rg "cloud_capture_imports"
git show origin/main:app/src/app/useCloudCaptureSync.ts | rg "syncCloudCaptures|setInterval|300_000"
```

Confirm the following concepts from those outputs:

```text
app/src-tauri/src/cloud/captures.rs
app/src-tauri/migrations/0029_cloud_capture_imports.sql
app/src/app/useCloudCaptureSync.ts
/v1/captures/pending
/download
/acknowledge
Library::ingest_media
```

Expected: all concepts are represented. Do not modify `lqc` for this check.

---

### Task 4: Rebase the feature branch onto inbound-enabled main

**Files:**
- Potential conflict scope: implementation files committed in Task 2 and any same paths changed on `origin/main`

**Interfaces:**
- Consumes: clean committed `extension/server-collector` and verified `origin/main`
- Produces: linear feature history containing both inbound PC consumer and Capture Inbox producer

- [ ] **Step 1: Confirm rebase preconditions**

Run:

```powershell
git branch --show-current
git status --short
git log --oneline --decorate -5
```

Expected: branch is `extension/server-collector`; ordinary status is clean
except the uncommitted consolidation plan if it has not yet been committed.
Commit the plan as documentation before rebasing so the worktree is clean.

- [ ] **Step 2: Rebase**

```powershell
git rebase origin/main
```

If conflicts occur, inspect each base/ours/theirs version and preserve both
independent behaviors. Stage only resolved conflict paths and continue with
`git rebase --continue`. Do not use wholesale ours/theirs checkout for a file
containing both valid workstreams.

- [ ] **Step 3: Inspect the rebased result**

```powershell
git status --short
git diff origin/main...HEAD --stat
git log --oneline --decorate -10
```

Confirm inbound files remain under `app/` and Collector/server files remain
under `extension/` and `server/`.

---

### Task 5: Establish the canonical checkout guidance

**Files:**
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: existing Branch hygiene and Active library guidance
- Produces: one concise, non-duplicated rule identifying the canonical local checkout

- [ ] **Step 1: Add the canonical repository rule**

Add this concise section near Core workflow or Branch hygiene:

```markdown
## Canonical checkout

- Use `C:\chatgpt` as the canonical local repository for all Lakomics development.
- Do not use `C:\Users\Laku.LAKU\.gemini\antigravity\scratch\lqc` except when the user explicitly requests recovery or historical comparison.
```

- [ ] **Step 2: Validate and commit guidance**

```powershell
git diff --check -- AGENTS.md
git diff -- AGENTS.md
git add -- AGENTS.md
git diff --cached --stat
git commit -m "docs: mark chatgpt as canonical checkout"
```

Expected: only `AGENTS.md` is staged for this commit.

---

### Task 6: Run the full integrated validation

**Files:**
- Verify generated: `extension/src/background-worker.js`
- Verify only: combined repository

**Interfaces:**
- Consumes: rebased combined history and canonical guidance
- Produces: evidence required before any push

- [ ] **Step 1: Run Rust tests**

```powershell
Set-Location C:\chatgpt\app\src-tauri
cargo test
```

Expected: all Rust tests pass; the count may differ from the historical 461.

- [ ] **Step 2: Run frontend tests**

```powershell
Set-Location C:\chatgpt\app
npm test
```

Expected: all Vitest files and tests pass.

- [ ] **Step 3: Run TypeScript no-emit validation**

```powershell
Set-Location C:\chatgpt\app
npm exec tsc -- --noEmit
```

Expected: exit 0 without diagnostics.

- [ ] **Step 4: Rebuild and test the extension**

```powershell
Set-Location C:\chatgpt
python scripts/rebuild-background-worker.py
npm test --prefix extension
git diff --exit-code -- extension/src/background-worker.js
```

Expected: 150 extension tests pass and rebuilding produces no uncommitted diff.

- [ ] **Step 5: Test and import-check the VPS server locally**

```powershell
Set-Location C:\chatgpt
python -m unittest discover -s server/lakomics-api/tests -v
python -m py_compile server/lakomics-api/app.py server/lakomics-api/capture_store.py server/lakomics-api/r2.py
$env:R2_ENDPOINT = "https://example.invalid"
$env:R2_ACCESS_KEY_ID = "test"
$env:R2_SECRET_ACCESS_KEY = "test"
python -c "import sys; sys.path.insert(0, r'C:\chatgpt\server\lakomics-api'); import r2, capture_store, app"
Remove-Item Env:R2_ENDPOINT,Env:R2_ACCESS_KEY_ID,Env:R2_SECRET_ACCESS_KEY
```

Expected: 24 tests and all validation commands pass without contacting X or R2.

- [ ] **Step 6: Run final repository checks**

```powershell
git diff --check
git status --short
git log --oneline --decorate origin/main..HEAD
```

Expected: clean ordinary status and only the intended consolidation commits
ahead of `origin/main`.

---

### Task 7: Audit the known inbound throughput follow-up

**Files:**
- Read only: `app/src-tauri/src/cloud/captures.rs`
- Read only: `app/src/app/useCloudCaptureSync.ts`

**Interfaces:**
- Consumes: integrated inbound implementation
- Produces: a yes/no final-report finding; no code change

- [ ] **Step 1: Trace one invocation**

Search the pending loop and return points in `captures.rs`, then the startup and
interval calls in `useCloudCaptureSync.ts`.

- [ ] **Step 2: Record the finding without editing**

State whether one invocation stops after the first successful import and
whether the frontend schedules another invocation only every five minutes.
Do not change either file.

---

### Task 8: Publish through fast-forward-only main

**Files:**
- Git refs only

**Interfaces:**
- Consumes: fully validated feature HEAD
- Produces: matching integrated local `main` and `origin/main`

- [ ] **Step 1: Push the feature branch safely**

```powershell
git push -u origin extension/server-collector
```

Expected: normal new upstream push. On rejection, stop without force.

- [ ] **Step 2: Fast-forward local main to fetched main**

```powershell
git switch main
git pull --ff-only origin main
```

Expected: local main reaches inbound-enabled `origin/main` without a merge commit.

- [ ] **Step 3: Fast-forward main to the feature**

```powershell
git merge --ff-only extension/server-collector
```

If this is not a fast-forward, stop and report.

- [ ] **Step 4: Push main and verify equality**

```powershell
git push origin main
git fetch origin
git rev-parse HEAD
git rev-parse origin/main
git merge-base --is-ancestor 85027db origin/main
```

Expected: local and remote hashes match and inbound commit ancestry exits 0.

- [ ] **Step 5: Remove the merged temporary branch**

After equality is proven:

```powershell
git push origin --delete extension/server-collector
git branch -d extension/server-collector
```

Expected: `main` remains the checked-out canonical branch and all work remains
reachable from `main`.

---

### Task 9: Compare lqc and deliver the final audit

**Files:**
- Read only: `C:\Users\Laku.LAKU\.gemini\antigravity\scratch\lqc`
- Read only: final Git status and refs

**Interfaces:**
- Consumes: final `origin/main`, lqc commit `85027db`, and lqc working tree metadata
- Produces: removal-safety and consolidation report

- [ ] **Step 1: Prove lqc commits are represented**

```powershell
git merge-base --is-ancestor 85027db origin/main
git -C C:\Users\Laku.LAKU\.gemini\antigravity\scratch\lqc log --oneline origin/main..main
```

Also compare the lqc `main` commit with final remote ancestry. Expected: no
unique committed lqc work remains outside final `origin/main`.

- [ ] **Step 2: Classify the lqc Cargo.toml working-tree marker**

Run `git hash-object --path=app/src-tauri/Cargo.toml
app/src-tauri/Cargo.toml` inside lqc and compare it with the index blob ID from
`git status --porcelain=v2`. Equal normalized IDs mean the marker is line-ending
only; do not refresh, stage, or alter the lqc index.

- [ ] **Step 3: Verify the canonical checkout is clean**

```powershell
Set-Location C:\chatgpt
git branch --show-current
git status --short
git status --short --ignored
git log -1 --oneline --decorate
git ls-remote origin refs/heads/main
```

Expected: branch `main`, clean ordinary status, local one-use files preserved
as ignored, and local HEAD equal to remote main.

- [ ] **Step 4: Report all requested evidence**

Report the starting state, committed/excluded categories, commits, inbound
verification, rebase/conflicts, every test result, canonical guidance, final
heads, lqc coverage/removal safety, throughput follow-up, and preserved local
ignored files. Explicitly state that production was not redeployed and lqc was
not modified or deleted.
