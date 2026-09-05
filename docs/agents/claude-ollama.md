# Claude Code with Ollama Cloud

The repository launcher delegates to `ollama launch claude --model <Model>` and defaults to `glm-5.3-flash:cloud`. The script itself does not edit PATH or machine-wide settings; Ollama/Claude own their launch and authentication behavior.

## First-time sign-in

Ollama owns the cloud credentials. Do not put tokens or API keys in this repository.

```powershell
& "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe" signin
```

The normal launch flow may also request sign-in when cloud authentication is missing.

## Launch

From the canonical repository root:

```powershell
.\scripts\claude-ollama.ps1
.\scripts\claude-ollama.ps1 -Model '<available-model-id>'
```

The script accepts only `-Model`; it does not implement `-Check`, `-SmokeTest`, or `--` passthrough. It resolves Ollama, checks/starts the local Ollama server, changes directory to `C:\chatgpt`, invokes Ollama's Claude launcher, and returns its exit code. Launching it is not a read-only diagnostic and may start a service or consume model quota.

For a read-only check of the launcher interface, inspect `scripts/claude-ollama.ps1` and use `Get-Command ollama, claude -ErrorAction SilentlyContinue` to inspect command availability. Configure additional Claude arguments through a separately understood direct launch workflow, not unsupported wrapper parameters.

## Confirm project instructions inside Claude Code

Use these built-in commands when behavior or configuration looks wrong:

- `/memory` must include the repository `CLAUDE.md` and its imported `AGENTS.md`.
- `/skills` must list the project skills under `.claude/skills/`.
- `/doctor` reports installation, settings, and skill-description problems.
- `/status` shows active model and configuration sources.

`CLAUDE.md` imports the shared repository policy and a lightweight skill selector. Clear authorized work does not require a new approval or skill chain. Support claims with inspected, still-valid evidence under `AGENTS.md`; do not rerun checks merely because a session or task ended. Current repository docs override stale project-memory pointers.

## Troubleshooting

### A binary is missing

The script resolves `ollama` on PATH, then `%LOCALAPPDATA%\Programs\Ollama\ollama.exe`. It does not independently resolve `claude.exe`; `ollama launch claude` handles that integration. Missing software requires an explicit setup decision; do not install it during an instruction or code review.

### Ollama does not start

The launcher checks `http://127.0.0.1:11434/api/version` and starts `ollama serve` in a hidden process when needed. It then makes up to 40 retries with a 500 ms sleep; each API probe can also take up to 2 seconds, so this is not a 20-second total timeout. If it fails, inspect Ollama startup/port status before retrying; do not terminate unrelated processes.

### Cloud launch asks for authentication

Complete the user-controlled `ollama signin` flow, then use the normal launch command. Authentication remains in Ollama's user storage and must not be copied into project files.

### A different cloud model is needed temporarily

Override the default without editing repository files:

```powershell
.\scripts\claude-ollama.ps1 -Model '<available-model-id>'
```

## Official references

- https://docs.ollama.com/integrations/claude-code
- https://ollama.com/library/glm-5.3-flash
- https://code.claude.com/docs/en/slash-commands
- https://code.claude.com/docs/en/debug-your-config
