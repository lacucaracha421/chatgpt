# Extension development

Root `AGENTS.md` applies. Read `docs/edge-extension.md` from the repository root for current save/Cloud Library behavior; the README and historical release notes are not separate execution plans.

## Source and generated output

- Maintain `src/background.js`, `src/layout.js`, and `src/defaults.js`. `src/background-worker.js` is an intentionally tracked generated MV3 bundle; do not hand-edit it.
- After changing a bundle input, regenerate with `python scripts/rebuild-background-worker.py` from the repository root. The current helper targets the canonical `C:\chatgpt` checkout; do not run it against another worktree assuming it will target that worktree.
- Inspect the generated diff. `tests/background.test.mjs` already checks bundle parity and the manifest entrypoint; use that coverage rather than inventing a second generator test.

## Verification and packaging

- Choose the relevant existing `node --test` file(s) from `extension/`. For bundle/routing changes, `node --test tests/background.test.mjs` is a focused starting point; expand only for actual cross-module risk.
- Documentation-only changes do not require bundle regeneration, app builds, or browser/device tests.
- `manifest.json` is the version/entrypoint source of truth. Do not copy an older version from installation notes or bump it merely for documentation edits.
- Packaging/Pages workflows can publish on pushes to `main`; no push, workflow dispatch, release, or deployment is implied by a successful local check.

## Boundaries

- Cloud Capture inbox, direct PC ingestion, and read-oriented Cloud Library browsing are separate flows. Do not treat pending captures as the library replica or re-run completed backfill for a mobile check.
- Preserve worker-owned authentication, allowed origins/hosts, bounded retries, timeout confirmation, and sanitized diagnostics. Never expose tokens to page content, logs, or committed files.
- Use the actual supported browser/extension surface. Browser frontend evidence is not native Tauri acceptance; follow the root runtime and production-library safeguards.
