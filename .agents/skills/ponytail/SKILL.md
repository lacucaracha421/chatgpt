---
name: ponytail
description: Keep implementation within the requested scope; choose the simplest correct solution using existing code and dependencies. Use for coding, refactoring, or dependency decisions, not general questions.
---

# Ponytail: Scope Before Size

Follow repository instructions and the requested outcome. Simplicity means less unnecessary behavior, not fewer lines at the expense of correctness.

## Choose the smallest sufficient solution

1. Read the affected code and trace the relevant callers and data flow.
2. Separate explicit requirements from speculative additions. Implement the former; omit the latter.
3. Reuse a suitable existing helper, interface, UI component, or pattern.
4. Prefer standard-library or native facilities when they preserve the required behavior on supported platforms.
5. Reuse installed dependencies when they fit better than new custom code.
6. Add a dependency or abstraction only for a concrete requirement that existing facilities do not reasonably meet.
7. Stop when the requested behavior and appropriate verification are complete.

The ladder is a decision aid, not an exhaustive research assignment. Do not investigate unrelated modules just to rule out every alternative.

## Constraints

- Fix causes at the appropriate shared boundary; do not patch only the reported caller while leaving equivalent callers broken.
- Preserve established module boundaries and shared UI. A small multi-file change can be safer than a single-file shortcut.
- Do not add speculative extension points, configuration, factories, fallback paths, or future scaffolding.
- Do not silently reduce an explicit requirement to a demo or a simplified substitute. Ask only when a material decision is unresolved.
- Preserve validation, accessibility, error handling, credential boundaries, data-loss protection, and required platform behavior.
- Receipts, revisions, outboxes, tombstones, retry semantics, and recovery paths are not automatically over-engineering. Establish their invariants before proposing a change.
- Optimize readability and total maintenance cost, not line count. Do not compress code into clever one-liners or delete working code merely to shrink a diff.
- Use existing test frameworks and fixtures. Add focused regression coverage when an actual uncovered risk warrants it; do not replace coverage with a token smoke test.
- Explain non-obvious tradeoffs with normal project-style comments, not branding or a new debt ledger.

## Modes and reporting

The default is scoped simplicity. If the user asks for `lite`, present a simpler alternative without changing agreed scope. If they ask for `full` or `ultra`, intensify the search for unnecessary complexity, not permission to omit requirements or remove safeguards. Apply only to relevant coding work, not every later response.

Report changed behavior, verification evidence, and important limits concisely. Give detailed explanations when requested; there is no code-first or three-line reporting limit.

Adapted from Ponytail; see [provenance](../README.md) and [license](../LICENSE-PONYTAIL.txt).
