# Claude Code Ollama fallback design

## Goal

Provide a repository-scoped fallback workflow that launches Claude Code through Ollama Cloud with `glm-5.3-flash:cloud` and makes the existing Lakomics instructions and project skills difficult for a non-Anthropic model to overlook.

## Current state

- `CLAUDE.md` imports `AGENTS.md`.
- Project skills already live under `.claude/skills/` and Claude Code discovers that location automatically.
- Claude Code 2.1.247 and Ollama 0.33.1 are installed outside `PATH` on the current Windows host.
- No local model is required. Ollama Cloud is the only intended inference path.
- Credentials must remain in Ollama's own authentication storage, never in the repository.

## Architecture

### Project memory

Keep `CLAUDE.md` short. Preserve `@AGENTS.md`, import `.claude/skills/using-superpowers/SKILL.md` so its skill-selection gate is always in context, and add only provider-specific workflow rules that do not belong in `AGENTS.md`.

The imported skill requires Claude to select and read applicable skills before answering, exploring, planning, or editing. `AGENTS.md` remains the single source of truth for repository workflow, verification, branch hygiene, credentials, and domain-document routing.

### Repository launcher

Add `scripts/claude-ollama.ps1` as the only launcher. It will:

1. Resolve `claude` and `ollama` from `PATH`, then fall back to their standard per-user Windows install paths.
2. Modify `PATH` only for the launcher process and its children.
3. Check `http://127.0.0.1:11434/api/version`.
4. If the API is unavailable, start `ollama serve` in a hidden background process and poll the health endpoint for a bounded period.
5. Run `ollama launch claude --model glm-5.3-flash:cloud`, forwarding remaining arguments after `--` to Claude Code.
6. Support `-SmokeTest`, which uses Ollama's non-interactive launch mode and asks Claude Code to read project memory, enumerate relevant project skills, and make no changes.
7. Return the child process exit code and print actionable errors for missing binaries, server startup failure, or unsuccessful cloud launch.

The launcher does not install software, change machine-level environment variables, store credentials, or terminate a pre-existing Ollama server.

### Operator guide

Add `docs/agents/claude-ollama.md` with:

- first-time `ollama signin` guidance;
- ordinary interactive and smoke-test commands;
- `/memory`, `/skills`, `/doctor`, and `/status` checks inside Claude Code;
- the exact default model tag;
- troubleshooting for missing binaries, stopped Ollama, and missing cloud authentication;
- a reminder that a model's claim of success is not evidence without command output.

## Error handling and safety

- Resolve executable paths without embedding a username.
- Bind health checks to loopback only.
- Use a finite startup timeout and fail instead of launching Claude Code against an unavailable endpoint.
- Do not pass or write API keys.
- Do not use `--dangerously-skip-permissions`.
- The smoke test is read-only by prompt and uses Claude Code's normal permission system.
- Project settings are not hardwired to Ollama, so a normal Claude Code invocation remains available outside the launcher.

## Verification

1. Parse the PowerShell script with `System.Management.Automation.Language.Parser` and require no syntax errors.
2. Run a resolver-only check to prove the installed Claude Code and Ollama binaries are found without global `PATH` changes.
3. Run `-SmokeTest` after Ollama Cloud authentication. It must exit successfully and report `CLAUDE.md`, `AGENTS.md`, and applicable project skills without editing files.
4. Confirm `git diff --check` and a clean final working tree after committing.

## Non-goals

- Local model installation or tuning.
- Machine-wide `PATH`, profile, or environment-variable changes.
- Duplicating existing skills or creating custom subagents.
- Automatic fallback from Codex based on quota telemetry.
- Storing Ollama credentials in project files.

## Official references

- Ollama Claude Code integration: https://docs.ollama.com/integrations/claude-code
- GLM-5.3-Flash model: https://ollama.com/library/glm-5.3-flash
- Claude Code skills: https://code.claude.com/docs/en/slash-commands
- Claude Code settings and memory: https://code.claude.com/docs/en/settings
- Claude Code configuration diagnostics: https://code.claude.com/docs/en/debug-your-config
