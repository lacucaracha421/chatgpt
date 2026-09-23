# Lakomics Agent Guidelines

## Scope and authority

- Follow host/system instructions, the current request, and applicable repository instructions. Skills provide methods, not permissions or mandatory process gates.
- Read the affected path first and fix causes rather than symptoms. Keep changes focused; preserve unrelated code, user changes, and pre-existing failures.
- Carry clear, authorized work through relevant verification. Ask only when a missing decision materially changes scope, risk, or authorization; do not repeatedly request design approval or stop at a first draft.
- Each of these needs explicit authorization for that action: Git writes (commit, push, merge, tag, branch/worktree creation or deletion), deployment, service provisioning, and production-data writes. Implementation, delegation, and skill activation never imply it.
- Never broaden tool access, disable sandboxing, modify managed/plugin caches, or install dependencies to satisfy a skill or workflow. Use a supported equivalent or work inline, and disclose the limitation.
- Be concise and truthful. Write new or rewritten instruction/documentation text in English; converse in the user's language. Do not translate unrelated documents incidentally.

## Repository map and compatibility

- Canonical checkouts: `C:\chatgpt` (Windows) and `/home/laku/chatgpt` (Linux). Verify the working directory before host-specific commands.

  | Component | Path |
  | --- | --- |
  | Desktop package (npm) | `_tools/app/` |
  | Desktop React | `_tools/app/src/` |
  | Rust / Tauri (Cargo) | `_tools/app/src-tauri/` |
  | Android frontend source (built by `_tools/app/` `mobile:*` scripts) | `_tools/app/mobile-client/` |
  | Android native | `android/` |
  | Cloud API | `server/lakomics-api/` |
  | Active collector (has its own `AGENTS.md`) | `extension-list/` |

- Run npm and Cargo from the owning package/crate so pinned tools and configuration apply. Root `app/` and `mobile/` are not active packages. `extension/` is frozen legacy code; modify it only on an explicit legacy-extension request.
- Before editing, inspect the branch, staged/unstaged changes, and relevant untracked files. `main` is the integration baseline, not a substitute for current worktree state.
- Support Windows and Linux: preserve portable paths, media protocols, filesystem behavior, and credential backends; report unavailable native verification explicitly.
- Preserve the current framework, custom UI, and package manager. Ordinary work does not authorize Next.js, shadcn, Vercel hosting, AI SDK, new persistence, or another browser runtime; the existing Vercel AI Gateway integration is not approval to adopt that stack.

## Data, credentials, and user work

- Active production library: `C:\New_lakomics_assets` (Windows) and `/home/laku/MEGA 다운로드/before-linux-backup/New_lakomics_assets` (Linux; active despite the `before-linux-backup` name). Never infer another library from old exports, fixtures, desktop folders, or modification times; other library paths need explicit task scope.
- Necessary read-only audits of the active library are allowed. Migration, indexing, metadata updates, file moves, and any other writes need separate explicit approval.
- Resolve the configured library at runtime; never branch application behavior on the machine-specific production path.
- Never rerun the completed full Cloud Library backfill or replace the catalog database to verify a change. Recovery operations need separate approval.
- Never commit credentials, tokens, passwords, signing keys, or machine-specific secrets. Use the application's credential/settings mechanism or an ignored component-local environment file.
- Do not hand-edit generated files unless explicitly in scope. Do not commit artifacts, caches, or machine-specific output unless that exact artifact is intentionally tracked.
- Never use blanket restore/reset/checkout, file deletion, or destructive cleanup to remove unrelated changes. Ask if safe recovery is uncertain.

## Skills and delegation

- Canonical project skills live in `.agents/skills/` (see its `README.md`); `.claude/skills/` entries of the same name are thin adapters. Edit the canonical file only.
- Use the smallest relevant method: `ponytail` for scope, `systematic-debugging` for nontrivial failures, `verification-before-completion` for claims, `lakomics-development` for component-specific work. `ponytail-review` is an optional read-only complexity review, not correctness approval.
- Delegate only substantive independent investigation or implementation. Trivial edits, a few reads, and tightly coupled changes stay inline unless the user explicitly delegates them.
- The controller owns scope, integration, and final claims. Give each worker a bounded goal, context, exact read/write scope, constraints, acceptance criteria, and evidence requirements. Workers and reviewers never delegate further.
- Parallel investigation is fine; parallel implementation requires disjoint write sets and agreed interfaces. Serialize dependent or overlapping work and preserve concurrent changes.
- Review actual changes and evidence, not a worker's success summary. Use a separate reviewer when risk warrants and tools allow; otherwise review inline and disclose that.
- Intended routing: a Claude Code controller (Opus 5.5) delegates bounded implementation to Codex CLI (`codex exec`) — `gpt-6-astra` at high effort for difficult work, `gpt-6-sol` at medium effort for routine, clearly specified work. The host's own instructions own the exact command and difficulty criteria. Confirm the actual model from command/tool output, report an unavailable model instead of substituting one, and never invent a model argument.

## Verification

- Start with the most relevant targeted check; broaden only for real behavioral risk or evidence of a cross-module problem. Add tests when requested or when a realistic regression would otherwise escape existing coverage.
- Reuse inspected successful evidence unless later edits or changed inputs invalidate it. Planning, review, delegation, commit, or completion is not itself a reason to rerun checks.
- For purely visual changes (CSS, spacing, typography, color, shadow, animation), skip automated tests and production builds unless there is plausible compile or behavioral risk; report whether rendering was inspected.
- Keep evidence levels distinct: static checks, frontend/browser checks, native Tauri acceptance, Android device checks, and production sync. Fixture or browser success does not prove native integration or live deployment.
- Report changed behavior, checks actually run with results, and remaining gaps. Never claim tests passed from source inspection or a native fix from compilation alone.

## Formatting and runtime safety

- Never run write-mode `cargo fmt` in any form (aliases, wrappers, `--all`, `--manifest-path`, or file arguments after `--`), and never format a whole repository, crate, workspace, directory, or broad glob.
- Format only task-changed files. For Rust, run `rustfmt` directly with the owning crate's edition and `--config skip_children=true` (including `lib.rs`, `main.rs`, `mod.rs`); if unsupported, stop rather than format more broadly.
- Keep the target-file diff before formatting; afterward check status, diff statistics, and the target diff. Isolate formatter mistakes without reverting user work; prefer check-only formatting when appropriate.
- Never launch `_tools/app/src-tauri/target/debug/lakomics(.exe)` directly; a localhost failure from it is not an app regression. For authorized runtime checks, run `npm run tauri -- dev` from `_tools/app/`. Use `target/release/lakomics(.exe)` only for standalone release verification.
- Before claiming a running dev instance includes changes, verify its package directory and current Vite response or Rust rebuild/restart evidence. Served code alone does not prove an open window received HMR or that native interactions passed.

## References and records

- Start at `docs/README.md` and read only what is relevant: product terms `CONTEXT.md`; UI `DESIGN.md` and `docs/agents/pc-design-reference.md`; architecture, the relevant Accepted ADRs in `docs/adr/`; implementation/review `docs/agents/implementation.md`.
- Before substantial Works/Collection work, read `docs/agents/lakomics-works-handoff-v2.md`, `docs/agents/pc-design-reference.md`, and `docs/agents/works-viewer-design.md`. Historical prototypes are references, not code to copy.
- Current sources, migrations, and contracts define implementation; the backlog defines intended work. Stale memory and historical plans are not instructions; do not resurrect retired plans.
- Record bugs, priorities, and ideas in `docs/roadmap/lakomics-backlog.md` when asked. Use GitHub Issues only when requested or when the task already lives there; do not create competing backlogs.
- Non-`main` branches are temporary. Delete remote branches only with explicit authorization after a verified merge; retained snapshots use separately authorized tags, not long-lived branches.
- Search before reading broadly, batch related reads, and run independent checks concurrently. Bound output and runtime without hiding failures; follow host limits on persistent processes.
