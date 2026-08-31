# Lakomics Agent Guidelines

## Core workflow

- Prefer focused, minimal changes that directly address the requested task.
- Investigate the relevant code path before making substantial changes.
- Do not refactor, clean up, revert, or overwrite unrelated code or user changes unless explicitly requested.
- When fixing a bug, prefer the root cause over an unnecessary workaround.
- Do not create commits or push to a remote repository unless explicitly requested.
- Ignore unrelated pre-existing warnings or failures unless they block the requested task.
- Keep explanations concise unless detailed analysis is requested.

## Canonical checkout

- Use `C:\chatgpt` as the canonical local repository for all Lakomics development.
- `main` is the single source of truth for the current Lakomics app and bundled `extension/` code.

## Repository docs

Before changing code, use `docs/README.md` as the document map.

- Product language and domain boundaries: `CONTEXT.md`
- Visual/UI rules: `DESIGN.md`
- Architecture decisions: `docs/adr/README.md` and relevant Accepted ADRs
- Implementation rules: `docs/agents/implementation.md`
- Living bugs, priorities, and future work: `docs/roadmap/lakomics-backlog.md`
- Cloud Capture work: `docs/agents/cloud-capture.md`
- Works / Collection work: `docs/agents/lakomics-works-handoff-v2.md`
- X Collector behavior: `docs/edge-extension.md`

Current code, migrations, and type/contracts are authoritative for implemented behavior. The backlog describes intended work and must not be treated as already implemented.

Historical dated implementation plans/specs were removed from the current tree after consolidation. Use Git history only when historical rationale is genuinely needed; do not resurrect an old plan as current instruction.

## Issue and backlog tracking

- Ongoing product bugs, UX tasks, architecture follow-ups, and long-term ideas belong in `docs/roadmap/lakomics-backlog.md` when the user asks to record them.
- Use GitHub Issues for discrete tickets only when the user explicitly wants issue tracking or an existing task already lives there.
- Do not maintain competing copies of the same backlog in multiple documents.

## Branch hygiene

- Treat non-`main` branches as temporary working branches.
- After a branch has been merged into `main`, delete the remote branch promptly instead of keeping merged work branches around.
- Do not use long-lived feature, `codex/*`, `agent/*`, or backup branches to preserve old states. Use tags for meaningful snapshots that must be retained.

## Credentials and generated files

- Never commit API keys, access tokens, passwords, generated credentials, extension connection tokens, or other machine-specific secrets.
- Store credentials through the application's credential/settings mechanism or an ignored local environment file appropriate to the owning Module.
- Do not manually edit generated files unless the task explicitly targets generated output.
- Do not commit build artifacts, temporary files, local caches, or machine-specific output unless the repository intentionally tracks that exact artifact.

## Active library boundary

- The active production library is `C:\New_lakomics_assets`. Do not infer the active library from similarly named directories, old exports, desktop folders, test fixtures, or recently modified paths.
- Paths other than the active library are excluded unless the user explicitly places them in scope.
- Read-only audits of the active library are allowed when needed to validate behavior. Any migration, indexing run, metadata update, file move, or other write to it requires separate explicit approval.
- Application behavior must not branch on this machine-specific path. Resolve the configured library at runtime; this path exists only to guide agent operations.

## Verification

- Start with the single most relevant targeted check and expand only when the change has broader behavioral risk or the targeted evidence reveals a cross-module problem.
- For visual-only CSS, spacing, typography, color, shadow, or animation changes, skip automated tests and production builds unless there is plausible compile or behavioral risk.
- Do not rerun a successful check unless later edits could invalidate it, and do not add tests unless requested or existing coverage would miss a realistic regression introduced by the change.
- Stop once there is sufficient evidence that the requested change works; generic planning, worktree, commit, push, PR, or completion steps are not reasons to run broader checks.

## Lakomics runtime rule

- NEVER launch `app/src-tauri/target/debug/lakomics.exe` directly.
- For development/runtime verification, always run:
  `cd C:\chatgpt\app && npm run tauri -- dev`
- Use `target/release/lakomics.exe` only for standalone release verification.
- A localhost/Vite failure from directly launching the debug executable is not an application regression.

## Works / Collection

Before substantial Works/Collection changes, read `docs/agents/lakomics-works-handoff-v2.md` and use `docs/prototypes/lakomics-works-v6-reference.html` for visual/interaction intent. Do not copy prototype code directly; preserve the intent through the current React structure, shared UI, and design tokens.
