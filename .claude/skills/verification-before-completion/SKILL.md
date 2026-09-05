---
name: verification-before-completion
description: Match completion claims to inspected, still-valid evidence and disclose remaining gaps; use repository risk-based verification without automatic reruns.
---

# Verification Before Completion

## Overview

**Core principle:** Evidence before claims, always.

**Violating the letter of this rule is violating the spirit of this rule.**

## The Iron Law

```
NO COMPLETION CLAIMS BEYOND INSPECTED, STILL-VALID EVIDENCE
```

Evidence may come from a prior inspected run or an appropriate static/native/manual check. Record its scope and result; reuse it when subsequent edits have not invalidated that scope. Follow `AGENTS.md` rather than adding a command just because this skill was invoked.

## The Gate Function

```
BEFORE claiming any status or expressing satisfaction:

1. IDENTIFY: What evidence supports this exact claim and scope?
2. CHECK VALIDITY: Inspect existing evidence and subsequent changes.
3. GATHER ONLY IF NEEDED: Run the smallest relevant check if evidence is missing or invalidated; inspect its result and exit status.
4. VERIFY: Does the evidence confirm the claim, including any required native/device gate?
   - If NO: State actual status with evidence
   - If YES: State claim WITH evidence
5. ONLY THEN: Make the claim

Skip any step = lying, not verifying
```

## Common Failures

| Claim | Requires | Not Sufficient |
|-------|----------|----------------|
| Selected tests pass | Inspected output for the named scope, not invalidated by later edits | An uninspected or invalidated run; "should pass" |
| Linter clean | Linter output: 0 errors | Partial check, extrapolation |
| Build succeeds | Build command: exit 0 | Linter passing, logs look good |
| Bug fixed | Test original symptom: passes | Code changed, assumed fixed |
| Regression test catches the failure | Observed failing/passing behavior or an explicitly bounded analysis of the original failure | A pass alone; claiming red-green without observing it |
| Agent completed | VCS diff shows changes | Agent reports "success" |
| Requirements met | Line-by-line checklist | Tests passing |

## Red Flags - STOP

- Using "should", "probably", "seems to"
- Expressing satisfaction before verification ("Great!", "Perfect!", "Done!", etc.)
- About to commit/push/PR without verification
- Trusting agent success reports
- Claiming broader verification than the checked scope
- Thinking "just this once"
- Tired and wanting work over
- **Claiming success without sufficient inspected evidence**

## Rationalization Prevention

| Excuse | Reality |
|--------|---------|
| "Should work now" | Inspect valid evidence or run the targeted missing check |
| "I'm confident" | Confidence ≠ evidence |
| "Just this once" | No exceptions |
| "Linter passed" | Linter ≠ compiler |
| "Agent said success" | Verify independently |
| "I'm tired" | Exhaustion ≠ excuse |
| "A targeted check is enough" | It proves only its scope; expand only for actual risk or a required acceptance gate |
| "Different words so rule doesn't apply" | Spirit over letter |

## Key Patterns

**Tests:**
```
✅ [Inspect valid output: 34/34 for named scope] "The 34 focused tests pass"
❌ "Should pass now" / "Looks correct"
```

**Regression-test claims and evidence:**

| Claim | Evidence required |
|-------|-------------------|
| "A regression test was added." | Inspect the actual test and diff. This existence claim does not require observed red-green behavior. |
| "The test currently passes." | Inspect still-valid execution evidence for that test; the test/diff alone does not prove a pass. |
| "The test demonstrably detects the pre-fix bug." | An observed pre-fix failure or another explicitly bounded, defensible form of evidence tying the test's assertion to the original failure. State the evidence and its limits; analysis is not an observed execution. |

For new test-first work: reproduce failure → apply fix → observe pass. For existing fixes: preserve working code and disclose unobserved red behavior; use a separately authorized isolated fixture only if needed. Missing pre-fix execution evidence does not require recreating a red-green cycle for already-written implementations.

Never claim to have observed red-green behavior that was not actually observed. Report test existence, current passing state, and pre-fix detection only to the extent their respective evidence supports them.

**Build:**
```
✅ [Run build] [See: exit 0] "Build passes"
❌ "Linter passed" (linter doesn't check compilation)
```

**Requirements:**
```
✅ Re-read plan → Create checklist → Verify each → Report gaps or completion
❌ "Tests pass, phase complete"
```

**Agent delegation:**
```
✅ Agent reports success → Check VCS diff → Verify changes → Report actual state
❌ Trust agent report
```

## When To Apply

Apply before reporting completion or correctness. A transition to planning, delegation, a commit, a PR, or another task does not require more checks by itself and grants no write permissions. Do not rerun a successful check merely to refresh its timestamp.

For native Tauri behavior, browser-only results are insufficient. Keep the real runtime/device acceptance gate explicit when it applies; missing access means unverified, not passed. Reviewers should inspect supplied evidence and changes rather than automatically rerun the implementer's commands.
