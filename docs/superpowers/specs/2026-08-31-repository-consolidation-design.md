# Lakomics Repository Consolidation Design

## Goal

Consolidate the completed PC inbound consumer and VPS Capture Inbox work into
GitHub `main`, then make `C:\chatgpt` the canonical Lakomics development
checkout. Production is already deployed and is outside this task.

## Safety boundaries

- Preserve every legitimate source, test, documentation, and reusable tooling
  change currently present in `C:\chatgpt`.
- Do not modify or delete
  `C:\Users\Laku.LAKU\.gemini\antigravity\scratch\lqc`.
- Do not contact or redeploy the VPS and do not touch its source backup.
- Do not use destructive Git cleanup, force push, history rewriting that loses
  work, or broad `git add -A` staging.
- Never commit credentials, environment files, databases, virtual
  environments, logs, caches, backup files, or generated distribution
  archives.
- Stop instead of guessing when a conflict, failed test, rejected push, or
  non-fast-forward integration cannot be resolved conservatively.

## Inventory policy

Commit the completed extension/server implementation, its tests, required
icons, directly relevant documentation, and tooling that remains useful in the
canonical checkout.

Reusable tooling consists of:

- `scripts/rebuild-background-worker.py` for the tracked generated MV3 worker;
- `scripts/pack-extension-zip.py` for deterministic extension packaging;
- `scripts/publish-extension-dev.ps1` for the repeatable local development
  distribution flow.

The publish script must include the manifest-referenced `icons` directory. No
other behavior is changed merely to clean up the scripts.

Keep the following local and untracked without deleting them:

- `patch-crx-*` and `patch-quetta-*`;
- `cleanup-quetta-tests.py`;
- `revert-quetta-and-setup-titanium.py`;
- the completed VPS source import helper and any other one-use migration,
  patch, or debug script;
- `extension.zip` and other generated distributions.

Add an exact root ignore for `extension.zip`. Existing server-local ignore
rules continue to exclude `.env`, database files, virtual environments, logs,
caches, and `*.bak*` files.

## Commit structure

Use a small number of coherent commits:

1. this repository-consolidation design;
2. the completed Capture Inbox server, extension Collector, tests,
   documentation, required assets, and reusable tooling;
3. the canonical-checkout guidance in `AGENTS.md` after rebasing onto current
   `origin/main`.

The Collector and server changes stay in one implementation commit because
their API contract, generated worker, tests, and documentation are one
completed behavior. Avoid patch-level history surgery solely to manufacture a
prettier split.

Every commit uses an explicit file allowlist. Before committing, inspect
`git diff --check`, staged status and statistics, and the staged diff for
secrets or excluded artifacts.

## Integration sequence

1. Commit the legitimate completed work on `extension/server-collector`.
2. Fetch `origin` only after the local work is safely committed.
3. Verify commit `85027db` is reachable from `origin/main` and confirm the
   inbound implementation is present, including capture models/routes,
   `cloud_capture_imports`, library ingestion, and `useCloudCaptureSync`.
4. Rebase `extension/server-collector` onto the fetched `origin/main`.
5. Resolve conflicts narrowly, preserving both the inbound app consumer from
   main and the server/extension producer contract from the feature branch.
6. Add a concise `AGENTS.md` rule naming `C:\chatgpt` as canonical and `lqc` as
   historical/recovery-only unless explicitly requested, then commit it.

If the inbound commit or its equivalent code is absent, stop before the
rebase. If a conflict cannot be resolved from the two known independent
contracts, abort the integration decision and report it rather than choosing
one side wholesale.

## Validation

Run the combined repository checks from `C:\chatgpt` after the rebase and
guidance update:

- the repository's normal Rust/Tauri test command;
- frontend unit tests;
- TypeScript no-emit validation;
- rebuild the generated extension worker and run `npm test --prefix
  extension`;
- run all server unit tests and Python syntax/import validation;
- run `git diff --check` and inspect final status.

Tests must not contact real X, R2, or production. A failing integrated check
blocks pushing and is investigated only within the consolidation scope.

## Publishing the integrated history

Only after all checks pass:

1. push `extension/server-collector` without force;
2. update local `main` from `origin/main` with `--ff-only`;
3. fast-forward local `main` to `extension/server-collector`;
4. push local `main` to `origin/main`;
5. verify local `main`, remote `main`, inbound consumer, and Capture Inbox work
   all share the intended integrated history.

Because the remote feature branch does not currently exist, the first feature
push should be a normal upstream-creating push. Any unexpected rejection stops
the process; it does not authorize a force push.

## Final audit

Compare the important `lqc` commit history and code with final `origin/main`
without modifying `lqc`. Report whether all unique completed work is present
and whether `lqc` is safe for the user to archive or delete. A line-ending-only
working-tree difference is reported separately from semantic unique work.

Inspect the integrated inbound sync loop and report whether it still imports
only one successful pending capture per invocation, but do not fix that
behavior in this task.

The final report lists commits, conflicts, validation results, final local and
remote heads, excluded local artifacts, `lqc` coverage, and the known inbound
throughput follow-up.
