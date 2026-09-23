@AGENTS.md

# Claude Code Integration

- `AGENTS.md` owns scope, permissions, delegation, data safety, and verification policy.
- Project skills are listed in the Skill tool; `.claude/skills/` adapters load the canonical `.agents/skills/<name>/SKILL.md`. Invoke a skill only when it adds concrete value to the task; ordinary questions and bounded implementation need no skill chain. Other Claude skills are optional and never mandate approvals, worktrees, commits, deployments, or tests.
- Codex workers (Astra/Sol) run only through `codex exec` from Bash as defined in the user's global Claude instructions. The Agent tool starts Claude subagents, not Codex workers.
- If a skill or tool is unavailable, follow the method inline and disclose the limitation; do not install plugins or change permissions to satisfy it.
