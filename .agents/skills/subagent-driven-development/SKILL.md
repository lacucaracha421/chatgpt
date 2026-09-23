---
name: subagent-driven-development
description: Coordinate independent implementation or investigation tasks with bounded subagents, clear ownership, and evidence-based review. Use for substantive decomposable work, not trivial edits or tightly coupled changes.
---

# Scoped Subagent Development

Use delegation only when it materially reduces elapsed time or main-context load. Follow repository and host policy; this method grants no extra permissions. If delegation is unavailable or the user requests inline work, execute directly and disclose that review was not independent.

## Decide whether to delegate

- Small edits, a few reads, and tightly coupled debugging usually stay inline.
- Independent research questions can run concurrently.
- Implementation tasks must have disjoint write sets and agreed shared interfaces. Serialize tasks that touch the same files or depend on unsettled contracts.
- The controller owns scope, integration, conflict resolution, and final claims. A worker does not inherit conversation history: send only the context it needs.

## Assign a bounded task

Include this contract in each dispatch:

- **Goal and acceptance:** requested behavior and how completion will be judged.
- **Context:** relevant paths, symbols, current decisions, and repository instructions.
- **Ownership:** exact writable paths, or explicitly read-only; exclusions and concurrent work to preserve.
- **Constraints:** supported platforms, security/data boundaries, and prohibited scope expansion.
- **Verification:** the targeted check or evidence needed, with any unavailable native gates.
- **Report:** changed files, cause or rationale, commands and observed results, outstanding concerns, and blockers.
- **No recursive delegation:** workers and reviewers must not spawn helpers or reviewers.
- **No implicit Git or operational writes:** do not commit, create branches/worktrees, push, deploy, migrate, or touch production data without authorization for that action.

Use status labels `DONE`, `DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, or `BLOCKED`. `DONE` must not conceal failed acceptance criteria. For investigations, require concrete file/symbol references and separate observations from inference. Read-only work must not run tests or commands that generate files.

Keep small briefs and reports in the conversation. Use task-owned files only when a long task needs durable recovery; do not create a second product backlog or mandatory per-task paperwork. Batch similar small edits instead of creating an agent per line.

## Model capability

If the actual dispatch interface supports model selection, prefer a fast model for well-specified mechanical work and a stronger model for architecture, difficult debugging, or high-risk review. Use verified configured model identifiers only.

When the worker is Codex CLI launched through `codex exec`, the model and reasoning effort are explicit command arguments; pass the brief through stdin, run from the owning project root, keep the `workspace-write` or `read-only` sandbox, and record the exit status and the model and effort shown in the output header. Choose the Codex model by task difficulty as the host instructions define. A built-in host subagent runs on that host's models, so do not describe it as a Codex worker.

If the interface has no model parameter, do not invent one or claim a worker ran on Astra, Sol, or any other model. Report that routing is host-controlled or unverified. Skill installation does not configure providers, credentials, billing, or model routing.

## Review and integration

1. Read the report and inspect the actual task changes, including relevant staged, unstaged, and untracked files. Use a verified task base, not a guessed `HEAD~1`.
2. Check both requirement compliance and correctness. Verify questionable claims against callers and shared contracts; a worker's confidence is not evidence.
3. Inspect verification output and validity. Reuse valid results; rerun only missing or invalidated coverage.
4. For high-risk or sufficiently large work, use a separate read-only reviewer when available and useful. Otherwise review inline and label it accurately. Do not force a separate review agent for every tiny change.
5. Adjudicate unsupported findings before requesting changes. Resume the original worker for focused fixes when useful; do not duplicate unresolved assignments.
6. Bound retries. After repeated failed attempts, revisit evidence and task decomposition or escalate a real blocker. Do not blindly spend five rounds or mark a known unmet requirement complete.
7. Recheck integration boundaries and final relevant changes. Controller edits remain subject to the same review and verification rules.

Do not repeatedly ask whether to continue an already authorized plan. Ask when an unresolved decision materially changes scope, risk, or permission. Stop at the requested outcome, not at a ceremonial branch/PR workflow.

Apply [verification-before-completion](../verification-before-completion/SKILL.md) to the final report. Include remaining risks and missing independent/native evidence.

Adapted from Superpowers; see [provenance](../README.md) and [license](../LICENSE-SUPERPOWERS.txt).
