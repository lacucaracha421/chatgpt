---
name: executing-plans
description: Execute an approved implementation plan with scoped ownership and risk-based evidence, inline or using available delegation.
---

# Executing Plans

## Overview

Load plan, review critically, execute all tasks, report when complete.

**Announce at start:** "I'm using the executing-plans skill to implement this plan."

**Authority:** Follow `AGENTS.md` and the current request. Use available subagents only for meaningfully independent work; otherwise execute inline. Do not require or install an orchestration skill, create a worktree, or repeat approval merely because this plan exists.

## The Process

### Step 1: Load and Review Plan
1. Inspect current Git state and ownership of existing changes. Reuse the checkout; create a separate worktree only when needed and explicitly authorized
2. Read plan file
3. Review critically - identify any questions or concerns about the plan
4. Resolve concerns from repository evidence first. Ask only about consequential unresolved scope, risk, or authority; continue independent unblocked tasks
5. If no concerns: Create todos for the plan items and proceed

### Step 2: Execute Tasks

For each task:
1. Mark as in_progress
2. Implement the approved outcome, adapting obsolete mechanics to current code/tools without changing scope
3. Use the selected risk-based checks; reuse still-valid evidence instead of rerunning checklist commands
4. Mark as completed

### Step 3: Complete Development

Report the actual changed files, evidence, and remaining acceptance gaps. Keep the checkout and Git state as-is unless integration was explicitly requested. Use the available branch-finishing method only for an authorized integration task; do not add a test run or integration menu to ordinary completion.

## When to Stop and Ask for Help

Pause only the affected work when required authorization is missing, a material decision cannot be resolved from the repository, or repeated failures require reconsidering the approach. A missing optional skill/subagent uses an inline fallback. Preserve unrelated changes and do not repair unrelated pre-existing test failures.

## When to Revisit Earlier Steps

**Return to Review (Step 1) when:**
- Partner updates the plan based on your feedback
- Fundamental approach needs rethinking

Do not force through permission or safety blockers. Continue independent authorized work where possible.

## Remember
- Review plan critically first
- Preserve the approved outcome, adapting mechanics only when evidence warrants it
- Keep verification risk-based and evidence reusable
- Treat named skills as optional methods, not capability guarantees
- Report real blockers and continue independent work
- Do not switch branches or create Git state without authorization
