@AGENTS.md
@.claude/skills/using-superpowers/SKILL.md

# Claude Code Integration

- `AGENTS.md` owns scope, permissions, delegation, data safety, and verification policy.
- Canonical shared methods live in `.agents/skills/`. The matching entries under `.claude/skills/` are thin adapters: read their linked canonical `SKILL.md`, not a second copy of the method.
- Existing other Claude skills are optional, task-scoped methods. They do not mandate new approvals, worktrees, commits, deployments, tests, or a full workflow chain.
- Use only tools and agent types actually available. Subagents follow the bounded delegation policy in `AGENTS.md`; workers must not delegate further. Model routing must be verified rather than inferred from a role name.
- Codex workers (Astra or Sol) run only through `codex exec` from Bash, as defined in the user's Claude instructions. The Agent tool starts Claude subagents; use it for Claude-side investigation, not as a Codex substitute.
- If a skill is unavailable, follow the relevant method inline and disclose limitations. Do not install a plugin or change permissions to satisfy a workflow dependency.
- Documentation and backlog entry points are in `docs/README.md`. Do not recreate retired planning files from remembered instructions.
