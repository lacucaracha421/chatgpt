# Lakomics Documentation Map

This directory contains only current or intentionally retained Lakomics documentation.

## Read first

1. `../AGENTS.md` — repository workflow, safety boundaries, and document routing.
2. `../CONTEXT.md` — product vocabulary and domain boundaries.
3. `../DESIGN.md` — current visual and interaction language.
4. `adr/README.md` — architecture decision status index.
5. `roadmap/lakomics-backlog.md` — living bugs, priorities, and future work.

## Current reference documents

- `agents/domain.md` — how to interpret repository documentation and resolve conflicts.
- `agents/implementation.md` — implementation and shared-UI rules.
- `agents/cloud-capture.md` — current Cloud Capture / inbound-outbound sync architecture and known gaps.
- `agents/lakomics-works-handoff-v2.md` — current Works / Collection product and architecture reference.
- `agents/claude-ollama.md` — repository-local Claude Code + Ollama Cloud launcher notes.
- `agents/issue-tracker.md` — when to use the living backlog versus GitHub Issues.
- `edge-extension.md` — current bundled X Collector behavior and save paths.
- `prototypes/lakomics-works-v6-reference.html` — retained Works visual/interaction reference only; not production code.

## Source-of-truth order

When documents disagree:

1. Current `main` code, migrations, schemas, and type/contracts define implemented behavior.
2. `AGENTS.md`, `CONTEXT.md`, and `DESIGN.md` define repository/product rules.
3. Accepted ADRs define active architecture constraints.
4. Current domain references under `docs/agents/` describe stable subsystem intent.
5. `docs/roadmap/lakomics-backlog.md` describes work that is planned, in progress, or intentionally deferred; it does not prove a feature is implemented.
6. Git history is historical context only.

## Historical plans

The old dated `docs/superpowers/plans/`, `docs/superpowers/specs/`, one-off acceptance notes, `feature-candidates.md`, and the previous `product-change-backlog.md` were useful during implementation but became duplicated and stale.

They are intentionally not kept in the current tree. Their full contents remain recoverable from Git history if historical rationale is needed. New long-lived decisions should be promoted into an ADR or a current reference document; new bugs and product ideas should go into the living roadmap instead of creating another parallel backlog.
