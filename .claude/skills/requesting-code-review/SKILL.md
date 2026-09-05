---
name: requesting-code-review
description: Request or perform a scoped review when asked or when substantial change risk warrants it, including relevant committed and working-tree changes.
---

# Requesting Code Review

Use a supported reviewer when independent review adds value and delegation is available; otherwise perform the same read-only review inline and state that limitation. Provide requirements, scope, and evidence rather than the entire session history.

**Core principle:** Review early, review often.

## When to Request Review

Request review when the user asks, an agreed acceptance gate requires it, or a substantial change warrants an independent perspective. Task completion alone does not mandate another reviewer or test run.

**Optional but valuable:**
- When stuck (fresh perspective)
- Before refactoring (baseline check)
- After fixing complex bug

## How to Request

**1. Establish the complete review scope:**

Follow [Review scope](../../../docs/agents/implementation.md#review-scope). Record the verified base and head, task paths, committed/staged/unstaged layers, relevant untracked files, concurrent-work exclusions, and evidence. Do not default to `HEAD~1`; a feature branch's own upstream is not its task base. Inspect each layer as well as the combined final state, and disclose any unresolved coverage.

**2. Review with a supported agent or inline fallback:**

Use an available read-only reviewer or `general-purpose` subagent with [code-reviewer.md](code-reviewer.md). If no supported delegation exists, use that template inline; do not install a named reviewer/plugin.

Before treating the fallback as sufficient, check whether the user, task specification, applicable repository rule, or acceptance criteria explicitly require independent review:

- **Independent review is desirable, not required:** perform useful scoped inline/self-review, disclose that it was not independent, and continue ordinary authorized work under the existing verification policy. Unavailable delegation alone does not block completion.
- **Independent review is an explicit completion/approval condition:** perform useful scoped self-review and continue unrelated authorized implementation, but disclose that the review was not independent and keep the independent-review acceptance condition marked incomplete. Self-review cannot satisfy that condition; do not claim the gated completion/approval until the required independent review has occurred.

Do not install tools, expand permissions, invent a reviewer, or mislabel self-review as independent merely to satisfy the condition.

**Placeholders:**
- `{DESCRIPTION}` - Brief summary of what you built
- `{PLAN_OR_REQUIREMENTS}` - What it should do
- `{BASE_SHA}` - Starting commit
- `{HEAD_SHA}` - Verified ending commit
- `{TASK_PATHS}` - Task-owned paths and relevant dependencies
- `{WORKTREE_SCOPE}` - Whether staged/unstaged changes are included
- `{UNTRACKED_FILES}` - Relevant untracked files to read directly
- `{EXCLUSIONS}` - Out-of-scope/pre-existing/concurrent work
- `{EVIDENCE}` - Inspected results and outstanding native/device gates

**3. Act on feedback:**
- In read-only review, report findings without editing
- In an authorized repair task, fix in-scope Critical/Important issues; pause only affected work if a decision or permission is missing
- Note Minor issues for later
- Push back if reviewer is wrong (with reasoning)

## Example

```
[Just completed Task 2: Add verification function]

You: Let me request code review before proceeding.

BASE_SHA=<verified-task-start-commit>
HEAD_SHA=$(git rev-parse HEAD)

[Dispatch code reviewer subagent]
  DESCRIPTION: Added verifyIndex() and repairIndex() with 4 issue types
  PLAN_OR_REQUIREMENTS: Approved task requirements or the current plan path
  BASE_SHA: a7981ec
  HEAD_SHA: 3df7661
  TASK_PATHS: <task-owned paths>
  WORKTREE_SCOPE: include staged and unstaged task changes
  UNTRACKED_FILES: <relevant new files, or none>
  EXCLUSIONS: <unrelated concurrent changes, or none>
  EVIDENCE: <valid checks and remaining acceptance gates>

[Subagent returns]:
  Strengths: Clean architecture, real tests
  Issues:
    Important: Missing progress indicators
    Minor: Magic number (100) for reporting interval
  Assessment: Ready to proceed

You: [Fix progress indicators]
[Continue to Task 3]
```

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "Delegation is unavailable" | Perform scoped self-review and disclose it. Continue unrelated authorized work, but keep any explicitly mandatory independent-review condition incomplete. Do not install tools or expand permissions to satisfy it. |
| "The reviewer needs my whole session history to understand the change" | Hand it precisely crafted context, never your session's history. That keeps the reviewer on the work product, not your thought process. |

## Red Flags

**Never:**
- Skip requested or risk-required review without disclosing the gap
- Ignore Critical issues
- Proceed with unfixed Important issues
- Argue with valid technical feedback

**If reviewer wrong:**
- Push back with technical reasoning
- Show code/tests that prove it works
- Request clarification

See template at: [code-reviewer.md](code-reviewer.md)
