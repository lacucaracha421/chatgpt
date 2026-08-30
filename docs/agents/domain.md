# Domain Docs

Lakomics documentation is intentionally small and current. Historical implementation plans live in Git history rather than the active document tree.

## Before work

Read the smallest relevant set:

- `AGENTS.md`
- `CONTEXT.md`
- `DESIGN.md` for UI/interaction work
- `docs/adr/README.md` and relevant Accepted ADRs for architecture work
- `docs/roadmap/lakomics-backlog.md` when the task comes from the current product backlog
- the relevant subsystem reference under `docs/agents/`

Useful subsystem references:

- Cloud Capture / cloud sync: `docs/agents/cloud-capture.md`
- Works / Collection: `docs/agents/lakomics-works-handoff-v2.md`
- X Collector: `docs/edge-extension.md`

## Current repository document structure

```text
/
├── AGENTS.md
├── CONTEXT.md
├── DESIGN.md
└── docs/
    ├── README.md
    ├── agents/       # current subsystem and implementation references
    ├── adr/          # architecture decisions, including superseded history
    ├── prototypes/   # explicitly retained visual references
    └── roadmap/      # living backlog / bug log
```

## Authority and conflicts

- Current `main` code, migrations, schemas, and type/interfaces are authoritative for implemented behavior.
- `AGENTS.md`, `CONTEXT.md`, and `DESIGN.md` define current repository and product rules.
- Accepted ADRs are active architecture constraints. Superseded ADRs are history only.
- Current `docs/agents/` references define stable subsystem intent, but must still be checked against current code for implementation facts.
- `docs/roadmap/lakomics-backlog.md` is planning state. `TODO`, `HOLD`, or `IN PROGRESS` items are not implemented merely because they are documented.
- Old dated plans/specs are historical evidence only and are intentionally absent from the current tree. Retrieve them from Git history only when the rationale is needed.

If documentation and code disagree, do not silently implement the older description. Verify the current behavior and update the current reference in the same change when appropriate.

## ADR status

Use `docs/adr/README.md` as the status index.

- `Accepted`: current decision
- `Superseded`: historical decision replaced by a later one
- `Proposed`: not yet final

Do not delete superseded ADRs merely to simplify the tree; their purpose is to preserve decision history. Ordinary implementation plans do not receive the same retention treatment.
