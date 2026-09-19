---
name: lakomics-development
description: Locate the active Lakomics component, trace cross-client and authority boundaries, and choose task-specific documentation and checks. Use for substantive Desktop, Android, Collector, Cloud, or Works development.
---

# Lakomics Development

Repository paths below are relative to the checkout root. Read applicable `AGENTS.md` instructions first. This skill routes work; it does not duplicate product specifications or grant operational permissions.

## Locate the owner

| Area | Active sources | Start with |
| --- | --- | --- |
| Desktop frontend | `_tools/app/src/` | `_tools/app/README.md`, `docs/agents/implementation.md` |
| Desktop native | `_tools/app/src-tauri/` | Owning Rust module, migrations, tests, platform guide |
| Android frontend | `_tools/app/mobile-client/` | `android/README.md`, `docs/agents/mobile.md` |
| Android native | `android/src/` | `android/README.md`, native bridge and provider tests |
| Browser collector | `extension-list/` | `extension-list/AGENTS.md`, `extension-list/README.md`, `docs/edge-extension.md` |
| Cloud API | `server/lakomics-api/` | `docs/agents/cloud-capture.md`, relevant authority modules and tests |
| Works / Collection | Owning desktop/mobile Collection modules | References below before substantial changes |

Root `app/` is not the desktop package. Root `mobile/` is not the Android-bundled React client. `extension/` is frozen legacy code. `_tools/lakomics-cloudmedia-poc/` is a separate experiment. Do not redirect an active task to these paths based on an old document.

## Load only relevant context

Use `docs/README.md` as the map:

- Product vocabulary: `CONTEXT.md`; accepted architectural decisions: `docs/adr/README.md` and relevant Accepted ADRs.
- UI: `DESIGN.md`, `docs/agents/pc-design-reference.md`; preserve shared UI and design tokens.
- Substantial Works/Collection changes: `docs/agents/lakomics-works-handoff-v2.md`, `docs/agents/pc-design-reference.md`, `docs/agents/works-viewer-design.md`. Historical prototype HTML is not production code to copy.
- Catalog operations: `docs/agents/catalog-troubleshooting.md`.
- Linux: `docs/operations/linux-desktop.md`; backup and migration: `docs/operations/pc-migration.md`.
- Pending work: `docs/roadmap/lakomics-backlog.md`. Intended work is not implemented behavior; dated acceptance covers only its recorded revision and inputs.

## Trace the requested behavior

For an ordinary UI edit, stay in the affected component. For persistence or cross-client behavior, trace as needed:

`UI -> client/bridge -> native command or HTTP route -> domain handler -> transaction/state -> read projection or replica -> UI refresh`

Inspect callers, schemas, migrations, and tests before changing a contract. For authority work, identify activation/fences, library/epoch identity, entity versus assignment revisions, receipts/idempotency, outbox delivery, changes/baselines, deletion semantics, and legacy read/write fallbacks. Confirm reachability before labeling a fallback an authority violation. Do not assume production activation from source presence.

Do not branch application behavior on user-editable names or machine-specific paths. Resolve configured paths and stable identifiers. Keep filesystem, SQLite, media processing, and native credentials behind their owning interfaces.

## Select the method and evidence

- Scope control: [ponytail](../ponytail/SKILL.md).
- Nontrivial failures: [systematic-debugging](../systematic-debugging/SKILL.md).
- Independent substantial tasks: [subagent-driven-development](../subagent-driven-development/SKILL.md).
- Completion claims: [verification-before-completion](../verification-before-completion/SKILL.md).

Run npm commands from `_tools/app/` and Cargo commands from `_tools/app/src-tauri/`; inspect package scripts and installed tools before choosing exact arguments. Select the owning test, not every suite. Use `npm run tauri -- dev` from the active desktop package only when runtime execution is permitted by the host and task. Never launch the debug binary directly.

Preserve Windows/Linux portability and distinguish static, browser, native desktop, Android device, and production evidence. Existing dev windows must be tied to the current frontend/native build before claiming they show a change. Never test by modifying the active production library or repeating a backfill without separate authorization.

## Efficient execution

Search symbols before guessing paths; batch known related reads and independent searches. With a remote bridge, reuse a session only if the tool supports it. Bound output and long-running checks without hiding exit status or failure context. Keep dev servers in supported dedicated sessions; do not bypass a tool's prohibition on persistent processes.

Before reporting completion, inspect the task diff for unrelated changes, check supplied evidence, and name any blocked or unverified behavior. Keep new or rewritten instruction documents in English.
