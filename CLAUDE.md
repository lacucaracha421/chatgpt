@AGENTS.md
@.claude/skills/using-superpowers/SKILL.md

# Claude Code workflow rules

- Treat `AGENTS.md` as authoritative for repository workflow and scope.
- Follow applicable project skills end-to-end; do not skip their approval, TDD, debugging, or verification gates.
- Continue until the requested outcome is complete or a real authority/input blocker remains.
- Support completion claims with fresh command output.
- Use subagents for independent exploration or research when that meaningfully reduces main-context noise.
- Do not spawn unnecessary subagents for trivial tasks.
