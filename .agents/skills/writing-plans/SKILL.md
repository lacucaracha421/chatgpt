---
name: writing-plans
description: Prepare a concrete plan when requested or when complex dependencies need an explicit handoff; do not re-plan a clear approved implementation.
---

# Writing Plans

## Overview

Provide the affected files, contracts, dependencies, realistic acceptance cases, and minimum relevant verification. Keep enough context for the next engineer without writing the implementation twice. Authorization and verification remain governed by `AGENTS.md`; planning does not imply TDD, commits, or additional approval gates.

Assume they are a skilled developer, but know almost nothing about our toolset or problem domain. Assume they don't know good test design very well.

**Announce at start:** "I'm using the writing-plans skill to create the implementation plan."

**Context:** Inspect the current checkout and ownership of existing changes. Reuse it unless isolation is needed and a separate worktree is authorized; no worktree skill is required.

**Location:** Reuse the user-selected plan or current task context. Persist a new plan only when warranted by the request or an in-scope handoff, using `docs/README.md` for placement. Do not recreate retired plan directories.

## Scope Check

If the spec covers multiple independent subsystems, it should have been broken into sub-project specs during brainstorming. If it wasn't, suggest breaking this into separate plans — one per subsystem. Each plan should produce working, testable software on its own.

## File Structure

Before defining tasks, map out which files will be created or modified and what each one is responsible for. This is where decomposition decisions get locked in.

- Design units with clear boundaries and well-defined interfaces. Each file should have one clear responsibility.
- You reason best about code you can hold in context at once, and your edits are more reliable when files are focused. Prefer smaller, focused files over large ones that do too much.
- Files that change together should live together. Split by responsibility, not by technical layer.
- In existing codebases, follow established patterns. If the codebase uses large files, don't unilaterally restructure - but if a file you're modifying has grown unwieldy, including a split in the plan is reasonable.

This structure informs the task decomposition. Each task should produce self-contained changes that make sense independently.

## Task Right-Sizing

A task is a coherent deliverable with clear ownership and acceptance criteria. Fold setup, configuration, and documentation into the deliverable they support. A task boundary does not itself require another test run or reviewer; reuse relevant evidence and review at meaningful risk boundaries.

## Bite-Sized Task Granularity

Use steps at the granularity needed to execute safely, not a fixed time or line budget. Include tests only for requested coverage or realistic uncovered regressions; exclude Git/deployment/provisioning actions unless separately authorized.

## Plan Document Header

**Suggested header for a written plan:**

```markdown
# [Feature Name] Implementation Plan

> **Execution:** Follow `AGENTS.md`. Use available delegation only when it adds value; otherwise execute inline. This plan grants no additional Git, deployment, provisioning, or production-data permissions.

**Goal:** [One sentence describing what this builds]

**Architecture:** [2-3 sentences about approach]

**Tech Stack:** [Key technologies/libraries]

**Requirements:** [the approved task text or existing spec/design path; do not create a second document merely to fill this field]

## Global Constraints

[The spec's project-wide requirements — version floors, dependency limits,
naming and copy rules, platform requirements — one line each, with exact
values copied verbatim from the spec. Every task's requirements implicitly
include this section.]

---
```

## Task Structure

The example is schematic. Use real package roots/scripts for the target repository; omit an inapplicable test step instead of manufacturing coverage or installing a runner.

````markdown
### Task N: [Component Name]

**Files:**
- Create: `exact/path/to/file.py`
- Modify: `exact/path/to/existing.py:123-145`
- Test: `tests/exact/path/to/test.py`

**Interfaces:**
- Consumes: [what this task uses from earlier tasks — exact signatures]
- Produces: [what later tasks rely on — exact function names, parameter
  and return types. A task's implementer sees only their own task; this
  block is how they learn the names and types neighboring tasks use.]

- [ ] **Step 1: Add a focused regression test, if existing coverage misses this risk**

```python
def test_specific_behavior():
    result = function(input)
    assert result == expected
```

- [ ] **Step 2: For new test-first work, verify the expected failing behavior**

Run: `pytest tests/path/test.py::test_name -v`
Expected: FAIL with "function not defined"

- [ ] **Step 3: Write minimal implementation**

```python
def function(input):
    return expected
```

- [ ] **Step 4: Verify the changed behavior with the selected targeted check**

Run: `pytest tests/path/test.py::test_name -v`
Expected: PASS

- [ ] **Step 5: Record the result and any remaining acceptance gate**

````

## No Placeholders

Every step must contain the actual content an engineer needs. These are **plan failures** — never write them:
- "TBD", "TODO", "implement later", "fill in details"
- "Add appropriate error handling" / "add validation" / "handle edge cases"
- "Write tests for the above" without naming the behavior, relevant test file, and expected result
- Ambiguous cross-task references without an exact contract or source path
- Instructions lacking enough detail to execute; include code only where it resolves real ambiguity
- References to types, functions, or methods not defined in any task

## Self-Review

After writing the complete plan, look at the spec with fresh eyes and check the plan against it. This is a checklist you run yourself — not a subagent dispatch.

**1. Spec coverage:** Skim each section/requirement in the spec. Can you point to a task that implements it? List any gaps.

**2. Placeholder scan:** Search your plan for red flags — any of the patterns from the "No Placeholders" section above. Fix them.

**3. Type consistency:** Do the types, method signatures, and property names you used in later tasks match what you defined in earlier tasks? A function called `clearLayers()` in Task 3 but `clearFullLayers()` in Task 7 is a bug.

If you find issues, fix them inline. No need to re-review — just fix and move on. If you find a spec requirement with no task, add the task.

## Execution Handoff

For plan-only requests, deliver the plan and stop. When implementation is already authorized, continue without asking the user to choose a process again. Use supported subagents for independent work when useful; otherwise execute inline with the available `executing-plans` method or the steps above. A missing orchestration skill is not a reason to install software or delay unblocked work.
