---
name: systematic-debugging
description: Investigate a nontrivial bug, failing test, or unexpected behavior by tracing evidence to the root cause before editing. Use targeted checks and preserve read-only, data-safety, and platform boundaries.
---

# Evidence-Driven Debugging

Do not propose a confident fix before investigating the failing path. Scale investigation to uncertainty and risk; a simple failure does not require a full architectural audit.

## 1. Establish the failure

- Separate observed behavior, expected behavior, and assumptions.
- Inspect the relevant error, stack trace, inputs, runtime, and recent task changes.
- Reproduce with an existing focused test or disposable fixture when authorized and available. If reproduction is unavailable, say so and distinguish code-derived evidence from observed execution.
- Locate the client entry point, callers, shared handler, persistence, and read-back path relevant to the symptom. Follow the bad value or state transition to its origin.
- Compare a working path where useful. Read the necessary implementation, not just its name or comment.

For cross-component failures, identify which boundary first disagrees with the expected contract. Existing logs and source inspection come first. Add narrow instrumentation only when missing evidence warrants it and writes are authorized. Never print credentials, signed URLs, raw private payloads, or the full environment.

## 2. Test one hypothesis

State the suspected cause, supporting evidence, and a check that could disprove it. Change one causal variable at a time. Do not stack speculative fixes or add retries to conceal an unexplained failure.

If a check contradicts the hypothesis, return to the evidence. Repeated failed fixes indicate an inadequate hypothesis or scope; they do not prove the architecture must be replaced. Respect host limits on diagnostic attempts. Escalate a concrete missing input or material redesign decision instead of looping blindly.

## 3. Fix the cause

- Change the appropriate shared boundary and check other relevant callers.
- Preserve intended invariants, platform differences, and existing user work.
- Avoid bundled cleanup, speculative fallbacks, or unrelated warning fixes.
- Reuse the smallest existing reproduction. Add a focused regression test when the failure would otherwise escape coverage.
- Prefer observed failure before a new regression fix and pass afterward. Do not discard existing correct code just to recreate test-first history; disclose missing pre-fix execution evidence.

Read-only investigation stops at evidence and recommendations. It does not authorize instrumentation, temporary database writes, migrations, fixtures, or repairs.

## 4. Verify and report

Use [verification-before-completion](../verification-before-completion/SKILL.md). Start with the changed behavior; broaden only for a plausible dependent regression. Report the cause, fix, inspected evidence, and remaining uncertainty. Native Tauri or Android behavior is not established by browser tests, compilation, or fixture API success alone.

For an external or timing-dependent cause, document what was ruled out before recommending bounded retries, timeouts, or observability. Do not claim certainty the evidence does not support.

Adapted from Superpowers and the repository's prior scoped version; see [provenance](../README.md) and [license](../LICENSE-SUPERPOWERS.txt).
