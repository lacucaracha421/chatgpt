# Domain Docs

Lakomics distinguishes current rules and plans from intentionally retained history. Retired implementation plans live in Git history; labeled investigations, ADRs, measurements, and rollout/migration evidence may remain in the tree without becoming current instructions.

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
- X Collector: `docs/edge-extension.md` and `extension/AGENTS.md`
- Catalog changes and deployment/canary safeguards: `docs/agents/catalog-troubleshooting.md`
- Backup/recovery and PC migration: `docs/operations/pc-migration.md`
- Review scope and evidence reuse: `docs/agents/implementation.md`

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

- Current checkout code, migrations, schemas, and type/interfaces describe implemented behavior; `main` is the integration baseline, not a substitute for inspecting in-progress task changes. Code is evidence, not authorization to change data or override repository policy.
- `AGENTS.md`, `CONTEXT.md`, and `DESIGN.md` define current repository and product rules.
- Accepted ADRs are active architecture constraints. Superseded ADRs are history only.
- Current `docs/agents/` references define stable subsystem intent, but must still be checked against current code for implementation facts.
- `docs/roadmap/lakomics-backlog.md` is planning state. `TODO`, `HOLD`, or `IN PROGRESS` items are not implemented merely because they are documented.
- Retired dated plans/specs are historical evidence, not executable task lists. Retrieve them from Git history only when needed; preserve explicitly retained investigation/rollout records as history.

If documentation and code disagree, do not silently implement the older description. Verify the current behavior and update the current reference in the same change when appropriate.

## ADR status

Use `docs/adr/README.md` as the status index.

- `Accepted`: current decision
- `Superseded`: historical decision replaced by a later one
- `Proposed`: not yet final

Do not delete superseded ADRs merely to simplify the tree. Preserve intentionally retained investigations, completed rollout evidence, and migration records as well. A plan can be retired through a scoped documentation decision, not automatic cleanup at task completion.
