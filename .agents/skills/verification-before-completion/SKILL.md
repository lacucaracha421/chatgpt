---
name: verification-before-completion
description: Match completion and correctness claims to inspected, still-valid evidence. Use before reporting implementation or verification results; reuse valid checks and disclose native or device gaps.
---

# Verification Before Completion

Never claim more than inspected, still-valid evidence establishes. A successful subagent report, confident analysis, or the presence of a test is not an observed passing result.

## Evidence gate

1. Identify the exact claim and the scope it covers.
2. Inspect available evidence: command or manual procedure, working directory, inputs or files covered, result, and exit status where applicable.
3. Check whether later code, dependency, configuration, fixture, or runtime changes invalidate it.
4. If evidence is absent or invalid, run the smallest relevant authorized check. Broaden only for actual risk or a required acceptance gate.
5. State the supported result and any uncovered scope. If blocked, report the blocker instead of claiming success.

Evidence can remain in the conversation or an existing task report. Do not create a permanent verification ledger or rerun checks solely because a new message, review, delegation, commit, or completion step begins.

## Match the claim

| Claim | Required evidence |
| --- | --- |
| A test was added | Inspection of the test and task diff |
| Selected tests passed | Observed successful execution for the named scope on still-valid inputs |
| A regression test caught the old bug | Observed pre-fix failure, or explicitly qualified analysis; analysis is not an observed red-green cycle |
| A build passed | Build execution with a successful exit status, not lint output |
| The original bug is fixed | Evidence exercising the original failure; qualify conclusions when only static or fixture evidence is available |
| A delegated task is complete | Actual changes compared with requirements, plus inspected verification evidence |
| Native behavior works | Appropriate native/runtime evidence on the named platform or device |

Keep static checks, frontend/browser checks, native Tauri acceptance, Android device checks, and production data/deployment verification separate. Linux success is not Windows acceptance. A running window is not proof it loaded current frontend or native code.

## Proportional checks

- Use existing tests and tools. Add tests for requested coverage or a realistic uncovered regression, not to satisfy a ritual.
- Pure visual changes need appropriate visual inspection when available, not an automatic build or full test suite. Disclose when rendering was not checked.
- Inspect supplied subagent output and the actual diff. Do not automatically repeat a valid check on unchanged code, but request or gather evidence if the report lacks enough detail.
- Do not revert user work, write production data, rerun a backfill, or bypass permissions to obtain evidence.
- Do not discard an existing implementation merely to reconstruct a test-first sequence.

## Completion report

State what changed, which checks actually ran and their results, and what remains unverified or blocked. Distinguish pre-existing failures from regressions introduced by the task. No celebratory completion claim should conceal failed acceptance criteria.

Adapted from Superpowers and the repository's prior scoped version; see [provenance](../README.md) and [license](../LICENSE-SUPERPOWERS.txt).
