# Claude Code with Ollama Cloud

Lakomics can run Claude Code through Ollama Cloud without changing the machine-wide `PATH` or Claude Code settings. The repository launcher defaults to `glm-5.3-flash:cloud`.

## First-time sign-in

Ollama owns the cloud credentials. Do not put tokens or API keys in this repository.

```powershell
& "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe" signin
```

The normal launch flow may also request sign-in when cloud authentication is missing.

## Launch

Run from the repository root:

```powershell
.\scripts\claude-ollama.ps1 -Check
.\scripts\claude-ollama.ps1 -SmokeTest
.\scripts\claude-ollama.ps1
```

- `-Check` resolves Claude Code and Ollama without starting either service.
- `-SmokeTest` runs one read-only, non-interactive request that reports project memory and relevant skills.
- With no switch, the script opens an interactive Claude Code session.
- Pass Claude Code arguments after `--`, for example:

```powershell
.\scripts\claude-ollama.ps1 -- --permission-mode plan
```

The launcher modifies `PATH` only for its own process tree. Running ordinary `claude` elsewhere remains unaffected.

## Confirm project instructions inside Claude Code

Use these built-in commands when behavior or configuration looks wrong:

- `/memory` must include the repository `CLAUDE.md` and its imported `AGENTS.md`.
- `/skills` must list the project skills under `.claude/skills/`.
- `/doctor` reports installation, settings, and skill-description problems.
- `/status` shows active model and configuration sources.

The always-imported `using-superpowers` gate requires Claude to select applicable skills before answering or acting. A model saying that work is complete is not evidence; require fresh command output as specified by `AGENTS.md` and `verification-before-completion`.

## Troubleshooting

### A binary is missing

Install current Claude Code and Ollama, then rerun `-Check`. The launcher searches `PATH` first and then the standard per-user Windows locations:

- `%USERPROFILE%\.local\bin\claude.exe`
- `%LOCALAPPDATA%\Programs\Ollama\ollama.exe`

### Ollama does not start

The launcher checks `http://127.0.0.1:11434/api/version`, starts `ollama serve` in a hidden process when needed, and waits for at most 20 seconds. If it still fails, close stale Ollama processes from Task Manager, open the Ollama app once, and rerun the launcher.

### Cloud launch asks for authentication

Complete `ollama signin`, then rerun `-SmokeTest`. Authentication remains in Ollama's user storage and must not be copied into project files.

### A different cloud model is needed temporarily

Override the default without editing repository files:

```powershell
.\scripts\claude-ollama.ps1 -Model kimi-k2.5:cloud
```

## Official references

- https://docs.ollama.com/integrations/claude-code
- https://ollama.com/library/glm-5.3-flash
- https://code.claude.com/docs/en/slash-commands
- https://code.claude.com/docs/en/debug-your-config
