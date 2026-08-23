@AGENTS.md

# Claude Code workflow rules

- Prefer focused and minimal changes.
- Do not refactor unrelated code unless explicitly requested.
- Do not change unrelated files just to clean them up.
- Investigate the relevant code path before making substantial changes.
- Use subagents for independent exploration or research when that meaningfully reduces main-context noise.
- Do not spawn unnecessary subagents for trivial tasks.
- Run only the minimum validation reasonably necessary for the changed code.
- Do not repeatedly run the same tests or builds after they have already passed.
- Do not perform broad project-wide validation for a small localized change unless necessary.
- Ignore unrelated pre-existing warnings or failures unless they block the requested task.
- Do not spend excessive time investigating unrelated issues.
- Do not push to a remote Git repository unless I explicitly request it.
- Do not create commits unless I explicitly request them.
- Do not revert or overwrite unrelated user changes.
- When fixing a bug, prefer addressing the root cause rather than adding unnecessary workarounds.
- Keep explanations concise unless I ask for detailed analysis.