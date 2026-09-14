# X Translation Refresh Implementation Plan

**Goal:** Upgrade the active `extension-list/` X translator to Gemini 3.1 Flash Lite, reduce visible translation latency, recover cleanly from transient failures, and make translated content easier to distinguish and read.

**Architecture:** Keep the current OpenRouter-only background service and safe content-script renderer. Add a bounded batch request interface, a two-slot background scheduler, retry/cooldown handling, and theme-aware translation presentation without reviving legacy provider/model settings.

**Tech Stack:** Chromium MV3 extension, vanilla JavaScript, OpenRouter chat completions, Node test runner, JSDOM.

**Spec:** User-approved chat design from 2026-09-14.

## Global Constraints

- Modify the active `extension-list/` implementation only; do not touch legacy `extension/`.
- Keep API keys in extension storage/background only; never expose them to X content scripts.
- Preserve text-node/anchor rendering; never render model HTML.
- Keep OpenRouter as the only provider and Korean as the only translation target.
- No unrelated repository cleanup, commit, push, branch, or deployment.

---

### Task 1: Model and cache generation

**Files:** `extension-list/src/translate-service.js`, `extension-list/src/x-translate.js`, `extension-list/options/options.html`, `extension-list/README.md`, `extension-list/tests/translation.test.mjs`

- [x] Add failing tests for `google/gemini-3.1-flash-lite` and `lakomics:translation-cache:v2`.
- [x] Verify the new tests fail against the current 2.5/v1 implementation.
- [x] Switch model metadata and retire the v1 translation cache so old-model results are not reused.
- [x] Verify targeted tests pass.
### Task 2: Batch scheduler and resilience

**Files:** `extension-list/src/translate-service.js`, `extension-list/tests/translation.test.mjs`

- [x] Add failing tests for batch translation, ordered placeholder validation, two-request concurrency, and one retry for transient failures.
- [x] Verify each behavior fails for the current serial service.
- [x] Add `translation:request-batch` with at most 4 items and bounded total text.
- [x] Use Gemini structured JSON output for per-item results while preserving existing single-request compatibility.
- [x] Replace the single global promise chain with a two-slot scheduler and abort all active requests on invalidation.
- [x] Retry timeout/network/5xx once; honor `Retry-After` for 429 and keep a shared cooldown.
- [x] Validate link placeholders in exact source order and cache only valid per-item translations.
- [x] Verify targeted service tests pass.

### Task 3: Content batching and retry state

**Files:** `extension-list/src/x-translate.js`, `extension-list/tests/translation.test.mjs`

- [x] Add failing DOM tests for 4-item batching, transient failure retry after re-entry, and explicit `ko/en/ja/und` language decisions.
- [x] Gather visible pending tweets by viewport proximity, up to 4 items / 6000 characters per batch.
- [x] Mark a tweet completed only after success or a confirmed no-translation decision.
- [x] Keep 429 recoverable without pretending the API key disappeared; block only authentication/payment failures until settings refresh.
- [x] Refine language detection to trust explicit foreign-language tags while skipping tiny/non-prose snippets.
- [x] Verify content-script behavior passes.

### Task 4: Translation visibility and compact controls

**Files:** `extension-list/src/x-translate.js`, `extension-list/tests/translation.test.mjs`, `extension-list/options/options.html`, `extension-list/README.md`

- [x] Add failing DOM assertions for theme-aware translation blocks and the compact floating control.
- [x] Render successful translations as subtle themed cards with stronger text contrast, blue accent, and blue links/hashtags/mentions.
- [x] Detect X light, dim, and lights-out backgrounds and update existing rendered translations when the page theme changes.
- [x] Replace the persistent `AI 번역` details panel with a 40px translation icon and click-to-open popover.
- [x] Reflect on/off, busy, and error states in the floating control without exposing noisy permanent labels.
- [x] Keep keyboard/ARIA support, outside-click close, settings, toggle, and cache-clear actions.
- [x] Verify targeted DOM tests pass.

### Task 5: Final verification

**Files:** all task-owned `extension-list/` files plus this plan.

- [x] Run `node --test tests/translation.test.mjs`.
- [x] Run `node --test tests/*.test.mjs` from `extension-list/` if targeted checks are green.
- [x] Inspect `git diff -- extension-list docs/superpowers/plans/2026-09-14-x-translation-refresh.md` and confirm no unrelated file changed.
- [x] Report implementation and verification results; leave commit/push untouched unless separately authorized.

### Follow-up: First-result latency

**Files:** `extension-list/src/x-translate.js`, `extension-list/tests/translation.test.mjs`, `extension-list/README.md`

- [x] Add failing tests for mounting before `DOMContentLoaded`, immediate initial scan, and a single-post fast lane.
- [x] Prefetch translation settings at content-script startup and mount as soon as `document.body` exists.
- [x] Bypass the 120 ms debounce for the first visible scan while retaining it for later observer churn.
- [x] Send the center-nearest post through a single fast lane and render it as soon as it returns while the next four-item batch remains in flight.
- [x] Keep later batches bounded to the existing two-request concurrency limit.
