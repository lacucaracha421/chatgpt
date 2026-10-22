---
name: using-superpowers
description: Select a relevant skill when a task needs a specialized method; preserve repository scope, permissions, and risk-based verification.
---

<SUBAGENT-STOP>
If you were dispatched as a subagent to execute a specific task, ignore this skill.
</SUBAGENT-STOP>

## Selecting a skill

Inspect the task and repository context first. Load an explicitly requested skill or the smallest relevant method when it adds concrete value; do not invoke skills merely because a topic might be related. Ordinary questions and bounded implementation do not need a process chain.

Repository instructions control approval, Git, deployment, data safety, documentation, and verification. An already clear, authorized request does not need renewed design approval. Reuse still-valid evidence; do not add tests, builds, plans, reviews, or subagents just to complete a checklist.

For ambiguous design use brainstorming. For a nontrivial failure use systematic-debugging. For an approved multi-step task, execute it directly or use executing-plans. Use a specialist only when the framework/runtime and tools actually match; do not provision, install, or change permissions to make a skill applicable.

If a named skill or subagent is unavailable, use a supported equivalent or carry out the relevant method inline. Report limitations rather than inventing tool names or blocking independent work.

## Platform Adaptation

Only when a tool mapping is needed, consult the matching reference below. Verify it against callable tools; do not assume a reference enables a capability or overrides host permissions:

- Codex: `references/codex-tools.md`
- Pi: `references/pi-tools.md`
- Antigravity: `references/antigravity-tools.md`
- Hermes Agent: `references/hermes-tools.md`

## User Instructions

The current request and applicable repository instructions take precedence over this method, subject to host/system rules. Omit inapplicable workflow steps without seeking permission for the omission. Never infer authorization for external or destructive actions.
