# Android Local Media Cache Performance Implementation Plan

> **For agentic workers:** Execute this plan directly in the current checkout. Do not spawn subagents. Preserve all unrelated working-tree changes and do not commit, push, deploy, or touch production data unless separately authorized.

**Goal:** Make already-cached Lakomics images reopen faster on Android by giving WebView a stable local media URL and cacheable response semantics, without changing server APIs or authority state.

**Architecture:** Keep `ThumbnailCache` as the source of truth for cached bytes and its existing generation/key invalidation. Remove the per-request `System.nanoTime()` cache-buster from the WebView URL, then let WebView cache the local response for no longer than the native cache lifetime. A manual cache clear or connection replacement already changes cache generation / clears native bytes, so the URL namespace remains safely invalidated.

**Tech Stack:** Java, Android WebView, existing `MediaRepository` / `ThumbnailCache`.

**Spec:** Direct user-approved parallel optimization scope from 2026-09-16; no separate spec file.

## Global Constraints

- Do not modify anything under `server/` or `_tools/app/src/manga/`.
- Do not change media ticket contracts, account scoping, cache key derivation, download concurrency, or the 1 GiB native cache budget.
- Preserve manual cache clear and connection-change invalidation behavior.
- The local media response must never become publicly cacheable or usable outside the app-local origin.
- Preserve Windows/Linux PC behavior; this task is Android-only and must not modify PC code.

---

### Task 1: Stabilize the app-local media URL

**Files:**
- Modify: `android/src/com/lakomics/mobile/MediaRepository.java`
- Test/verify: Android Java compile through `android/build.py`

**Interfaces:**
- Consumes: existing `Scope { key, generation }` and `local(Scope,String)`.
- Produces: the same JSON ticket shape and same `https://app.lakomics.local/media-cache/...` origin, but with a deterministic URL for the lifetime of one cached object.
- [ ] **Step 1: Capture the current URL behavior in a focused source-level assertion or helper test if practical.**

The regression to prevent is a changing URL for the same `Scope`. If extracting a tiny platform-free helper would require more code than the production change, do not add an abstraction only for testing; rely on compile verification plus targeted diff review.

- [ ] **Step 2: Remove only the per-call cache-buster.**

Change `MediaRepository.local(...)` from the current shape:

```java
"https://app.lakomics.local/media-cache/"+scope.generation+"/"+scope.key+"?mime="+Uri.encode(mime)+"&v="+System.nanoTime()
```

to the same URL without `&v=...`. Keep the encoded MIME query and `expires_in` field unchanged.

- [ ] **Step 3: Verify no other caller depends on URL uniqueness.**

Search for `/media-cache/`, `thumbnail-cache`, and `expires_in` under `android/src` and `_tools/app/mobile-client`. Confirm callers treat the returned URL as an opaque image URL and do not use the changing query value as a refresh signal.

### Task 2: Align WebView caching with the native cache lifetime

**Files:**
- Modify: `android/src/com/lakomics/mobile/ThumbnailCache.java`
- Modify: `android/src/com/lakomics/mobile/MainActivity.java`

**Interfaces:**
- Consumes: the existing seven-day native cache expiry.
- Produces: a package-visible cache lifetime constant and a private WebView `Cache-Control` header that cannot outlive native cache validity.

- [ ] **Step 1: Expose one canonical lifetime value.**

Refactor the existing private seven-day millisecond constant so the package has one source of truth, for example:

```java
static final long MAX_AGE_SECONDS=7L*24*60*60;
private static final long MAX_AGE=MAX_AGE_SECONDS*1000;
```

Do not change the actual seven-day lifetime in this task.
- [ ] **Step 2: Cache only the app-local media response.**

In `MainActivity.asset(...)`, replace `Cache-Control: no-store` only for the `/media-cache/` / `/thumbnail-cache/` branch with a private lifetime bounded by `ThumbnailCache.MAX_AGE_SECONDS`, for example:

```java
cacheHeaders.put("Cache-Control","private, max-age="+ThumbnailCache.MAX_AGE_SECONDS+", immutable");
```

Keep bundled HTML/JS/CSS responses on their existing `no-store` policy. Keep `X-Content-Type-Options: nosniff` and the local-origin checks unchanged.

- [ ] **Step 3: Check invalidation paths.**

Confirm `MediaRepository.clear()` increments cache generation, configuration replacement clears media cache, and disconnect clears media cache. Do not alter those paths.

### Task 3: Verification

- [ ] Run the smallest Android compile/test path available on this host. From the repository root, first ensure the mobile web assets already exist, then run the existing Android builder with the configured SDK/JDK:

```bash
python3 android/build.py
```

If signing/build prerequisites prevent the full builder, compile the affected Android sources through the existing project build path and report the unavailable APK/signing evidence explicitly; do not install dependencies or create keys.

- [ ] Inspect only the task diff:

```bash
git diff -- android/src/com/lakomics/mobile/MediaRepository.java \
  android/src/com/lakomics/mobile/ThumbnailCache.java \
  android/src/com/lakomics/mobile/MainActivity.java
```

Verify there are no server, authority, PC manga, or unrelated formatting changes.

- [ ] Do **not** commit or push. Report changed files, verification evidence, and any device-only acceptance still needed. Device acceptance is simple: open a gallery, revisit the same visible images within one app session, and confirm they render without fresh network transfer while cache clear still forces a reload.
