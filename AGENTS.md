# Lakomics Agent Guidelines

## Scope and authority

- Follow host/system instructions, the current user request, and applicable repository instructions. Skills provide methods, not extra permissions or mandatory process gates.
- Make focused changes that complete the requested behavior. Read the affected path first; fix causes rather than symptoms. Preserve unrelated code, user changes, and pre-existing failures.
- Continue clear, authorized work through relevant verification. Ask only when a missing decision materially changes scope, risk, or authorization; do not repeatedly request design approval or stop at the first implementation draft.
- Git writes (commits, pushes, merges, tags, branch/worktree creation or deletion), deployment, service provisioning, and production-data writes require explicit authorization for that action. Implementation, delegation, and skill activation do not authorize them.
- Do not broaden tool access, disable sandboxing, modify managed/plugin caches, or install dependencies merely to satisfy a skill. Use a supported equivalent or work inline when a capability is unavailable.
- Keep explanations concise and truthful. Write new or rewritten instruction and documentation text in English; follow the user's language for conversation. Do not translate unrelated existing documents incidentally.

## Active checkout and compatibility

- Canonical checkouts: `C:\chatgpt` on Windows and `/home/laku/chatgpt` on this Linux host. Verify the actual working directory before host-specific commands.
- Desktop package: `_tools/app/`; React: `_tools/app/src/`; Rust: `_tools/app/src-tauri/`; Android frontend: `_tools/app/mobile-client/`; Android native: `android/`; Cloud API: `server/lakomics-api/`.
- Run npm and Cargo commands from the owning package/crate so pinned tools and configuration apply. Root `app/` is not the desktop package; root `mobile/` is not the Android frontend.
- Active collector: `extension-list/`, including its own `AGENTS.md`. `extension/` is frozen legacy code; modify it only on an explicit legacy-extension request.
- Inspect the current branch, staged/unstaged changes, and relevant untracked files before editing. `main` is the accepted integration baseline, not a substitute for current worktree state.
- Support both Windows and Linux. Preserve portable paths, media protocols, filesystem behavior, and credential backends; report unavailable native verification explicitly.
- Preserve the current framework, custom UI, and package manager. Ordinary work does not authorize Next.js, shadcn, Vercel hosting, AI SDK, new persistence, or another browser runtime. Existing Vercel AI Gateway integration is not approval to adopt that stack.

## Data, credentials, and user work

- The active production library is `C:\New_lakomics_assets` on Windows and `/home/laku/MEGA 다운로드/before-linux-backup/New_lakomics_assets` on this Linux host. The Linux path is the active library despite the `before-linux-backup` directory name. Do not infer another library from old exports, fixtures, desktop folders, or modification times. Other library paths require explicit task scope.
- Necessary read-only audits are allowed. Migration, indexing, metadata updates, file moves, and any other writes to the active library require separate explicit approval.
- Resolve the configured library at runtime; never branch application behavior on the machine-specific production path.
- Never rerun the completed full Cloud Library backfill or replace the catalog database merely to verify a change. Recovery operations require separate approval.
- Never commit credentials, tokens, passwords, signing keys, or machine-specific secrets. Use the application's credential/settings mechanism or an ignored local environment file owned by the component.
- Do not manually edit generated files unless explicitly in scope. Do not commit artifacts, caches, or machine-specific output unless that exact artifact is intentionally tracked.
- Never use blanket restore/reset/checkout, file deletion, or destructive cleanup to remove unrelated changes. Preserve pre-existing work and ask if safe recovery is uncertain.

## Skills and delegation

- Canonical project skills live in `.agents/skills/`; see `.agents/skills/README.md`. Matching `.claude/skills/` adapters load the same instructions. Do not maintain divergent copies of these methods.
- Use the smallest relevant method: `ponytail` for scope, `systematic-debugging` for nontrivial failures, `verification-before-completion` for claims, and `lakomics-development` for component-specific work. `ponytail-review` is an optional read-only complexity review, not correctness approval.
- Subagents are allowed for substantive independent investigation or implementation when they materially help. Trivial edits, a few reads, and tightly coupled changes stay inline unless explicitly delegated by the user.
- The controller owns scope, integration, and final claims. Give each worker a bounded goal, relevant context, exact read/write scope, constraints, acceptance criteria, and evidence requirements. Workers and reviewers must not delegate further.
- Parallel investigation is allowed; parallel implementation requires disjoint write sets and agreed interfaces. Serialize dependent or overlapping changes and preserve concurrent work.
- Review actual changes and evidence, not just a worker's success summary. Use a separate reviewer when risk warrants it and tools support it; otherwise review inline and disclose the lack of independent review.
- Model routing depends on the real tool and host configuration. The intended split is a Claude Code controller (Opus 5.5) delegating bounded implementation to Codex CLI (`codex exec`): `gpt-6-astra` at high effort for difficult work and `gpt-6-sol` at medium effort for routine, clearly specified work. The host's own instructions own the exact command and difficulty criteria. Claude Code's built-in subagents are Claude models, not Codex workers. Confirm routing from the actual command or tool output, report an unavailable model instead of substituting one, and never invent a model argument. Delegation does not grant Git or operational permissions.

## Verification

- Begin with the most relevant targeted check and broaden only for actual behavioral risk or evidence of a cross-module problem. Use existing coverage; add tests when requested or a realistic regression would otherwise escape it.
- Reuse inspected successful evidence unless later edits or changed inputs invalidate it. A planning, review, delegation, commit, or completion step is not itself a reason to rerun checks.
- For purely visual CSS, spacing, typography, color, shadow, or animation changes, skip automated tests and production builds unless there is plausible compile or behavioral risk. Report whether rendering was inspected.
- Distinguish static checks, frontend/browser checks, native Tauri acceptance, Android device checks, and production sync. Fixture or browser success does not prove native integration or live deployment behavior.
- Report changed behavior, checks actually run and their results, and remaining gaps. Do not claim tests passed from source inspection or a native fix from compilation alone. Stop when evidence is sufficient or a concrete blocker remains.

## Formatting and runtime safety

- Do not run write-mode `cargo fmt`, aliases, or wrappers, including with `--all`, `--manifest-path`, or file arguments after `--`. Do not incidentally format a repository, crate, workspace, directory, or broad glob.
- Format only identified task-changed files. For Rust, invoke `rustfmt` directly with the owning crate's edition and `--config skip_children=true`, including for `lib.rs`, `main.rs`, and `mod.rs`. If unsupported, stop rather than formatting more broadly.
- Before formatting, retain the target-file diff. Afterward inspect status, diff statistics, and the target diff for unintended changes. Isolate formatter-only mistakes without reverting user work; prefer check-only formatting when appropriate.
- Never launch `_tools/app/src-tauri/target/debug/lakomics.exe` or `_tools/app/src-tauri/target/debug/lakomics` directly. For authorized development runtime checks, enter `_tools/app/` and use `npm run tauri -- dev` with host-supported process/session tools.
- Use the corresponding `target/release/lakomics.exe` or `target/release/lakomics` only for standalone release verification. A localhost failure from a directly launched debug binary is not an app regression.
- Before claiming a running dev instance includes changes, verify its package directory and current Vite response or Rust build/restart evidence. Current served code alone does not prove an open window received HMR or native interactions passed.

## References and records

- Start with `docs/README.md` and read only relevant references. Product terms: `CONTEXT.md`; UI: `DESIGN.md` and `docs/agents/pc-design-reference.md`; architecture: relevant Accepted ADRs under `docs/adr/`; implementation/review: `docs/agents/implementation.md`.
- Before substantial Works/Collection work, read `docs/agents/lakomics-works-handoff-v2.md`, `docs/agents/pc-design-reference.md`, and `docs/agents/works-viewer-design.md`. Historical prototypes are reference material, not code to copy.
- Current sources, migrations, and contracts establish implementation; the backlog establishes intended work. Stale memory and historical plans are not current instructions. Do not resurrect retired plans.
- Record product bugs, priorities, and ideas in `docs/roadmap/lakomics-backlog.md` when asked. Use GitHub Issues only when explicitly requested or the task already lives there. Do not create competing backlogs.
- Non-`main` branches are temporary. Remove remote branches only when explicitly authorized after a verified merge. Do not use long-lived feature/agent/backup branches as archives; meaningful retained snapshots use separately authorized tags.
- Search before reading broadly, batch known related reads, and run independent checks concurrently when supported. Reuse remote sessions when available; bound output/runtime without hiding failures. Follow host limits on persistent processes.
