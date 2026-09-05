@AGENTS.md
@.claude/skills/using-superpowers/SKILL.md

# Claude Code workflow rules

- Treat `AGENTS.md` as authoritative for repository workflow and scope.
- Use applicable skills as scoped methods under `AGENTS.md`, not as independent approval, test, documentation, Git, or deployment policies.
- Continue until the requested outcome is complete or a real authority/input blocker remains.
- Support claims with inspected, still-valid evidence; rerun only checks invalidated by later changes, and distinguish native acceptance from static/browser checks.
- Use subagents for independent exploration or research when that meaningfully reduces main-context noise.
- Do not spawn unnecessary subagents for trivial tasks. Use an available agent type (such as `general-purpose`) or perform the review/execution inline when delegation is unavailable; do not install a plugin to satisfy a workflow dependency.
- Project memory is a hint, not authority: `docs/README.md` and `docs/roadmap/lakomics-backlog.md` replace retired feature-candidate/product-change documents. Do not recreate them from remembered instructions.
