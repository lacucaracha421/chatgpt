---
name: ponytail-review
description: Review a requested diff for unnecessary complexity without modifying files. Use for explicit simplification or over-engineering reviews; this does not replace correctness or security review.
---

# Complexity Review

A review is read-only unless repairs are separately authorized. Establish the requested files or revision range, include relevant working and untracked changes, and distinguish task changes from pre-existing work.

## Review method

1. Read requirements, the actual diff, and enough surrounding code to understand the behavior.
2. Look for duplicated existing functionality, speculative abstractions, unused flexibility, unnecessary dependencies, and avoidable custom implementations.
3. Before recommending removal, identify what contract the code protects and show that the replacement preserves it.
4. Check platform behavior, callers, error paths, and tests relevant to the proposed simplification.
5. Prefer a small number of substantiated findings over a deletion quota. A single caller or implementation is not, by itself, proof that a boundary is unnecessary.

Never recommend removing security checks, accessibility, meaningful tests, transaction boundaries, idempotency, retry guarantees, or recovery state merely to reduce size. A native control is not interchangeable with a custom component unless it meets the actual UX and platform requirements.

## Findings

For each finding report:

- File and symbol or line.
- Unnecessary complexity and concrete evidence.
- Simpler replacement and the behavior it must preserve.
- Verification needed before applying it.

If a suspected issue requires unverified assumptions, label it as a question rather than a defect. Report significant correctness or security concerns separately; do not silently ignore them or claim this limited review establishes overall safety.

If nothing is substantiated, report "No unnecessary complexity found in the reviewed scope." Do not say "Ship" or claim tests passed. Never apply changes during this review without authorization.

Adapted from Ponytail; see [provenance](../README.md) and [license](../LICENSE-PONYTAIL.txt).
