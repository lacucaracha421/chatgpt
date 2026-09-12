# Lakomics Agent Guidelines

## Core workflow

- Prefer focused, minimal changes that directly address the requested task.
- Investigate the relevant code path before making substantial changes.
- Do not refactor, clean up, revert, or overwrite unrelated code or user changes unless explicitly requested.
- When fixing a bug, prefer the root cause over an unnecessary workaround.
- Git writes (including commits, pushes, merges, tags, branch/worktree creation or deletion), deployment, service provisioning, and writes to production data require explicit authorization for that action. Implementation or skill activation alone does not authorize them.
- Ignore unrelated pre-existing warnings or failures unless they block the requested task.
- Keep explanations concise unless detailed analysis is requested.
- All future changes must support both Windows and Linux. Preserve cross-platform library portability and use platform-appropriate paths, media protocols, and credential backends. Verify affected behavior for both platforms where possible; explicitly report any native platform verification that is unavailable.

## Formatting safety

- Do not run write-mode `cargo fmt` (including `--all`, `--manifest-path`, aliases such as `cargo format`, or wrappers that invoke it). Passing file paths after `cargo fmt --` does not safely restrict formatting to those files.
- Never format the entire repository, crate, or workspace as an incidental cleanup step. Only format explicitly identified files changed for the current task; do not use directory targets or broad globs.
- For Rust, invoke `rustfmt` directly with the owning crate's edition and `--config skip_children=true`, for example `rustfmt --edition 2021 --config skip_children=true path/to/changed.rs` for a 2021 crate. Keep `skip_children=true` even for `lib.rs`, `main.rs`, and `mod.rs` so child modules are not rewritten. If the installed formatter cannot honor this option, stop rather than falling back to broader formatting.
- Before formatting, inspect and retain the existing diff for the target files. After formatting, inspect `git status --short`, `git diff --stat`, and the target-file diff to confirm that no unrelated files or user changes were affected. Use check-only formatting when verification alone is needed.
- If formatting unexpectedly changes unrelated content, stop and isolate only the formatter-introduced changes. Never use blanket `git restore`, `git checkout --`, `git reset --hard`, or file deletion to recover a clean worktree; preserve all pre-existing work and ask for direction if safe recovery is uncertain.

## No subagents

- Do not spawn, resume, reuse, or delegate work to subagents. Perform investigation, implementation, review, and verification directly in the current agent.
- Do not create or use separate tasks/threads as a workaround for this prohibition. Skill instructions recommending parallel agents or independent subagent reviews do not authorize delegation; perform the scoped review inline and do not claim independent review evidence.

## Canonical checkout

- Use `C:\chatgpt` as the canonical local repository for all Lakomics development.
- `main` is the accepted integration baseline for the Lakomics app and the active `extension-list/` extension. `extension/` is a legacy frozen implementation: do not modify it unless the user explicitly asks for legacy-extension work. For ongoing work, inspect the current branch, staged/unstaged changes, and relevant untracked files; do not treat an older `main` snapshot as the current task state.

## Instruction and skill applicability

- Subject to host/system instructions, the current user request and applicable repository instructions govern scope, authorization, and verification. Skills supply methods, not additional authority or mandatory process gates.
- Continue clear, authorized implementation without repeating design approval. Ask only when an unresolved decision materially changes scope, risk, or authorization; continue independent unblocked work.
- Use skills for an explicit request or a concrete task need. Before a platform/runtime recipe, verify the actual package, owning directory, callable tools, and permissions. A cached skill is not proof of an available capability.
- Ordinary Lakomics work does not authorize adopting Vercel hosting, Next.js, shadcn, AI SDK, new persistence, or another browser runtime. Existing direct Vercel AI Gateway integration is not consent to adopt that stack. Preserve the current framework, custom UI, and package manager.
- Do not edit managed/plugin caches, broaden tool access, disable sandboxing, or install dependencies merely to activate a skill. If a named skill is unavailable, use a supported equivalent or perform the scoped method inline; disclose any missing independent/native evidence. Subagent use remains prohibited.
- Current repository sources outrank stale remembered workflow facts. Do not recreate retired backlog/plan files referenced by memory.

## Repository docs

Before changing code, use `docs/README.md` as the document map.

- Product language and domain boundaries: `CONTEXT.md`
- Visual/UI rules: `DESIGN.md`; detailed current PC reference: `docs/agents/pc-design-reference.md`
- Architecture decisions: `docs/adr/README.md` and relevant Accepted ADRs
- Implementation rules, review scope, and verification evidence: `docs/agents/implementation.md`
- Living bugs, priorities, and future work: `docs/roadmap/lakomics-backlog.md`
- Cloud Capture work: `docs/agents/cloud-capture.md`
- Works / Collection work: `docs/agents/lakomics-works-handoff-v2.md`
- X Collector behavior: `docs/edge-extension.md`; active list-extension rules: `extension-list/AGENTS.md`; legacy frozen extension rules: `extension/AGENTS.md`
- Catalog changes, production deployment/canary safeguards: `docs/agents/catalog-troubleshooting.md`
- Backup, recovery, and PC migration: `docs/operations/pc-migration.md`

Current code, migrations, and type/contracts are authoritative for implemented behavior. The backlog describes intended work and must not be treated as already implemented.

Historical dated implementation plans/specs were removed from the current tree after consolidation. Use Git history only when historical rationale is genuinely needed; do not resurrect an old plan as current instruction.

## Issue and backlog tracking

- Ongoing product bugs, UX tasks, architecture follow-ups, and long-term ideas belong in `docs/roadmap/lakomics-backlog.md` when the user asks to record them.
- Use GitHub Issues for discrete tickets only when the user explicitly wants issue tracking or an existing task already lives there.
- Do not maintain competing copies of the same backlog in multiple documents.

## Branch hygiene

- Treat non-`main` branches as temporary working branches.
- After a verified merge into `main`, remove the remote branch only when that deletion is explicitly authorized; otherwise leave it in place and report its state.
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
- Distinguish static checks, browser/frontend checks, and native Tauri acceptance. Browser rendering does not prove native commands, filesystem integration, or production sync. Preserve required native/device gates and report them unverified when unavailable.
- Never reseed/rerun the completed full Cloud Library backfill or replace the catalog database merely to verify a change; recovery/active-data writes require separate approval.

## Lakomics runtime rule

- NEVER launch `app/src-tauri/target/debug/lakomics.exe` directly.
- For development/runtime verification, always run:
  `cd C:\chatgpt\app && npm run tauri -- dev`
- Use `target/release/lakomics.exe` only for standalone release verification.
- A localhost/Vite failure from directly launching the debug executable is not an application regression.

## Works / Collection

Before substantial Works/Collection changes, read `docs/agents/lakomics-works-handoff-v2.md`, `docs/agents/pc-design-reference.md`, and `docs/agents/works-viewer-design.md`. `docs/prototypes/lakomics-works-v6-reference.html` is retained historical interaction/reference material only. Do not copy prototype code directly; preserve current intent through the React structure, shared UI, and design tokens.
