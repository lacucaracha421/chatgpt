# Claude Code Ollama Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Launch Claude Code for Lakomics through Ollama Cloud's `glm-5.3-flash:cloud` model while reliably loading the repository instructions and existing project skills.

**Architecture:** Keep provider selection in one repository-scoped PowerShell launcher that resolves installed binaries, starts only a missing loopback Ollama server, and delegates to `ollama launch claude`. Strengthen the existing short `CLAUDE.md` by importing the mandatory skill gate, and keep operator setup and diagnostics in one agent guide.

**Tech Stack:** Windows PowerShell 7, Claude Code 2.1.247+, Ollama 0.33.1+, Ollama Anthropic-compatible API, Claude Code project memory and Agent Skills

## Global Constraints

- Use only the Ollama Cloud model tag `glm-5.3-flash:cloud`; do not install or tune local models.
- Do not modify machine-level `PATH`, profiles, or environment variables.
- Do not store Ollama credentials, API keys, or tokens in the repository.
- Do not create `.claude/settings.json`, duplicate existing skills, or add custom subagents.
- Do not use `--dangerously-skip-permissions`.
- Keep `AGENTS.md` authoritative and `CLAUDE.md` under 200 lines.
- Use a finite Ollama startup timeout and loopback health checks only.

---

### Task 1: Make the skill gate part of Claude project memory

**Files:**
- Modify: `CLAUDE.md`
- Create: `docs/agents/claude-ollama.md`

**Interfaces:**
- Consumes: `AGENTS.md`, `.claude/skills/using-superpowers/SKILL.md`, and Claude Code's `@path` memory imports.
- Produces: project memory that always includes repository rules and the mandatory skill-selection gate; a human guide for the Ollama launcher.

- [ ] **Step 1: Update `CLAUDE.md` without duplicating repository policy**

Use these imports first:

```markdown
@AGENTS.md
@.claude/skills/using-superpowers/SKILL.md
```

Keep the existing subagent guidance and add concise provider-specific rules:

```markdown
- Treat `AGENTS.md` as authoritative for repository workflow and scope.
- Follow applicable project skills end-to-end; do not skip their approval, TDD, debugging, or verification gates.
- Continue until the requested outcome is complete or a real authority/input blocker remains.
- Support completion claims with fresh command output.
```

- [ ] **Step 2: Add the operator guide**

Document:

```powershell
ollama signin
.\scripts\claude-ollama.ps1 -Check
.\scripts\claude-ollama.ps1 -SmokeTest
.\scripts\claude-ollama.ps1
```

Inside Claude Code, instruct the operator to run `/memory`, `/skills`, `/doctor`, and `/status` when diagnosing missing instructions or skills. State that credentials stay in Ollama and that ordinary `claude` remains untouched.

- [ ] **Step 3: Verify the memory files statically**

Run:

```powershell
(Get-Content CLAUDE.md).Count
Select-String -Path CLAUDE.md -SimpleMatch '@AGENTS.md', '@.claude/skills/using-superpowers/SKILL.md'
Test-Path docs/agents/claude-ollama.md
```

Expected: fewer than 200 lines, both imports found, and the guide exists.

- [ ] **Step 4: Commit project memory and operator guidance**

```powershell
git add CLAUDE.md docs/agents/claude-ollama.md
git commit -m "docs: prepare Claude Code Ollama workflow"
```

---

### Task 2: Add one repository-scoped Ollama launcher

**Files:**
- Create: `scripts/claude-ollama.ps1`

**Interfaces:**
- Consumes: optional `-Check`, optional `-SmokeTest`, optional `-Model`, and remaining Claude Code arguments; installed `claude.exe` and `ollama.exe`.
- Produces: interactive Claude Code through `ollama launch claude`; resolver-only diagnostics; a read-only end-to-end smoke test; the child exit code.

- [ ] **Step 1: Verify RED before the launcher exists**

Run:

```powershell
.\scripts\claude-ollama.ps1 -Check
```

Expected: PowerShell reports that `scripts/claude-ollama.ps1` does not exist.

- [ ] **Step 2: Implement executable resolution and process-scoped PATH**

Define parameters:

```powershell
[CmdletBinding()]
param(
    [switch]$Check,
    [switch]$SmokeTest,
    [string]$Model = "glm-5.3-flash:cloud",
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ClaudeArguments
)
```

Resolve `claude` and `ollama` first with `Get-Command -CommandType Application`, then these username-independent fallbacks:

```powershell
Join-Path $env:USERPROFILE ".local\bin\claude.exe"
Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"
```

Prepend only their parent directories to `$env:PATH`. `-Check` prints the resolved paths, model, and repository root, then exits without starting Ollama.

- [ ] **Step 3: Add bounded loopback server startup**

Use `Invoke-RestMethod http://127.0.0.1:11434/api/version` as the health check. When unavailable, run:

```powershell
Start-Process -FilePath $ollamaPath -ArgumentList "serve" -WindowStyle Hidden -PassThru
```

Poll for at most 20 seconds with 250 ms intervals. Fail with an actionable error if the process exits or the API never becomes ready. Do not stop a server after Claude exits.

- [ ] **Step 4: Add interactive and smoke-test delegation**

Normal mode runs:

```powershell
ollama launch claude --model glm-5.3-flash:cloud
```

and forwards remaining arguments after `--`.

Smoke mode runs:

```powershell
ollama launch claude --model glm-5.3-flash:cloud --yes -- -p <read-only prompt>
```

The prompt tells Claude to make no edits or state changes and to report whether it read `CLAUDE.md`, imported `AGENTS.md`, and discovered `using-superpowers`, `brainstorming`, `systematic-debugging`, `test-driven-development`, and `verification-before-completion`.

- [ ] **Step 5: Verify GREEN and PowerShell syntax**

Run:

```powershell
.\scripts\claude-ollama.ps1 -Check
$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile(
    (Resolve-Path .\scripts\claude-ollama.ps1),
    [ref]$tokens,
    [ref]$errors
) | Out-Null
if ($errors.Count -ne 0) { throw ($errors | Out-String) }
```

Expected: the installed executable paths and default cloud model print, and the parser reports no errors.

- [ ] **Step 6: Run the end-to-end smoke test**

Run:

```powershell
.\scripts\claude-ollama.ps1 -SmokeTest
```

Expected: Ollama starts if needed, cloud authentication is requested only by Ollama when absent, Claude Code exits successfully, and the response identifies the project memory and relevant skills without changing files.

- [ ] **Step 7: Commit the launcher**

```powershell
git add scripts/claude-ollama.ps1
git commit -m "feat: add Claude Code Ollama launcher"
```

---

### Task 3: Final verification and synchronization

**Files:**
- Verify only.

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: a committed, synchronized `main` and reproducible launch evidence.

- [ ] **Step 1: Re-run only invalidated checks**

Run `-Check`, parse the PowerShell script, and run `-SmokeTest` only if the script changed after its last successful execution.

- [ ] **Step 2: Inspect repository integrity**

Run:

```powershell
git diff --check
git status --short --branch
git log --oneline origin/main..main
```

- [ ] **Step 3: Push the approved `main` changes**

```powershell
git push origin main
git fetch --prune origin
git rev-list --left-right --count origin/main...main
```

Expected: `0 0`, a clean working tree, and only `main` locally and remotely.
