# Online Catalog WebView Transport Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make manual online-catalog updates receive completed same-origin WebView fetch responses on Windows and show the actual mapped command error when an update fails.

**Architecture:** Keep the existing hidden provider WebView and its cookie session. Start the asynchronous fetch with `eval`, store its completed transport envelope in one guarded window slot, and retrieve it through short synchronous `eval_with_callback` polls before passing it to the existing decoder.

**Tech Stack:** Rust, Tauri 2.11, WRY/WebView2, React 19, TypeScript, Vitest, Testing Library

## Global Constraints

- Keep the provider origin exactly `https://k-hentai.org`.
- Keep `credentials: 'include'`, `cache: 'no-store'`, path validation, navigation restriction, retries, HTTP 429 handling, checkpoints, and the 60-second overall timeout.
- `CatalogTransport::busy` remains the only overlap guard; use one response slot and reset it for every request.
- Add no dependency, provider, setting, transport abstraction, background service, or unrelated UI refactor.
- Preserve every unrelated tracked and untracked user change.
- The running `lakomics.exe` must not be stopped; every Cargo test command uses `--lib`.

---

### Task 1: Await the WebView Fetch Through a Synchronous Poll Contract

**Files:**
- Modify: `app/src-tauri/src/catalog_transport.rs`

**Interfaces:**
- Consumes: `CatalogTransport::busy`, `request_script(&str) -> Result<String, LibraryError>`, `receive_callback(Receiver<String>, Duration)`, and `decode_callback(&str) -> Result<String, LibraryError>`.
- Produces: `request_script` that starts a fetch and writes its completed JSON envelope to `window.__lakomicsCatalogResponse`; `response_script() -> &'static str` that synchronously consumes the slot; `poll_response(&WebviewWindow) -> Result<String, LibraryError>` that enforces `REQUEST_TIMEOUT`.

- [ ] **Step 1: Write the failing JavaScript-boundary tests**

Update the test import and replace the old direct-Promise script expectation with these contract assertions:

```rust
use super::{
    decode_callback, receive_callback, request_script, response_script,
    search_page_path, CatalogTransport,
};

#[test]
fn starts_async_fetch_without_returning_its_promise_to_webview2() {
    let script = request_script("/ajax/search?search=language%3Akorean").unwrap();

    assert!(script.contains("window.__lakomicsCatalogResponse = null"));
    assert!(script.contains("void (async () =>"));
    assert!(script.contains(
        "window.__lakomicsCatalogResponse = JSON.stringify({ ok: response.ok"
    ));
    assert!(script.contains("fetch(\"/ajax/search?search=language%3Akorean\""));
    assert!(!script.trim_end().ends_with("})()"));
}

#[test]
fn polls_and_consumes_only_a_completed_response_slot() {
    let script = response_script();

    assert!(script.contains("window.__lakomicsCatalogResponse"));
    assert!(script.contains("value === null"));
    assert!(script.contains("delete window.__lakomicsCatalogResponse"));
    assert!(!script.contains("fetch("));
}
```

The production changes that make these tests pass are the split between the start script and the synchronous consume script; the current async-IIFE return cannot satisfy them.

- [ ] **Step 2: Run the transport tests and verify RED**

Run from `C:\chatgpt`:

```powershell
cargo test --manifest-path app/src-tauri/Cargo.toml --lib catalog_transport::tests
```

Expected: compilation fails because `response_script` does not exist, or the new start-script assertions fail against the current directly returned Promise.

- [ ] **Step 3: Split fetch start from response consumption**

Add one poll interval and include `Instant` in the existing time import:

```rust
use std::time::{Duration, Instant};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const RESPONSE_POLL_INTERVAL: Duration = Duration::from_millis(50);
```

Change `request_script` so it resets the single slot, starts but does not return the Promise, and writes either success or network failure into the slot:

```rust
fn request_script(path: &str) -> Result<String, LibraryError> {
    validate_path(path)?;
    let path =
        serde_json::to_string(path).map_err(|_| LibraryError::InvalidCatalogTransportPath)?;
    Ok(format!(
        r#"window.__lakomicsCatalogResponse = null;
        void (async () => {{
          try {{
            const response = await fetch({path}, {{ credentials: 'include', cache: 'no-store' }});
            window.__lakomicsCatalogResponse = JSON.stringify({{ ok: response.ok, status: response.status, body: await response.text() }});
          }} catch (error) {{
            window.__lakomicsCatalogResponse = JSON.stringify({{ ok: false, status: 0, body: String(error) }});
          }}
        }})();"#
    ))
}

fn response_script() -> &'static str {
    r#"(() => {
      const value = window.__lakomicsCatalogResponse;
      if (value === null || value === undefined) return null;
      delete window.__lakomicsCatalogResponse;
      return value;
    })()"#
}
```

- [ ] **Step 4: Add the bounded synchronous polling helper**

Add these helpers next to `receive_callback`:

```rust
async fn evaluate(
    window: &WebviewWindow,
    script: &str,
    timeout: Duration,
) -> Result<String, LibraryError> {
    let (sender, receiver) = std::sync::mpsc::channel();
    window
        .eval_with_callback(script, move |value| {
            let _ = sender.send(value);
        })
        .map_err(|_| LibraryError::CatalogTransportUnavailable)?;
    tauri::async_runtime::spawn_blocking(move || receive_callback(receiver, timeout))
        .await
        .map_err(|_| LibraryError::CatalogTransportUnavailable)?
}

async fn poll_response(window: &WebviewWindow) -> Result<String, LibraryError> {
    let deadline = Instant::now() + REQUEST_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(LibraryError::CatalogTransportTimedOut);
        }
        let value = evaluate(window, response_script(), remaining).await?;
        if value != "null" {
            return Ok(value);
        }
        tauri::async_runtime::spawn_blocking(|| std::thread::sleep(RESPONSE_POLL_INTERVAL))
            .await
            .map_err(|_| LibraryError::CatalogTransportUnavailable)?;
    }
}
```

Then reduce `fetch_text` to the guarded start, poll, and existing decode path:

```rust
let script = request_script(path)?;
let _guard = self.begin_request()?;
let window = ensure_window(app).await?;
window
    .eval(script)
    .map_err(|_| LibraryError::CatalogTransportUnavailable)?;
let callback = poll_response(&window).await?;
decode_callback(&callback)
```

- [ ] **Step 5: Run the focused Rust checks and verify GREEN**

```powershell
cargo test --manifest-path app/src-tauri/Cargo.toml --lib catalog_transport::tests
cargo test --manifest-path app/src-tauri/Cargo.toml --lib library::catalog_update::tests
```

Expected: both commands exit 0. The transport suite covers path closure, generated-script contract, callback decoding, overlap, and timeouts; the update suite preserves retry/checkpoint/database behavior.

- [ ] **Step 6: Commit the transport fix**

```powershell
git add -- app/src-tauri/src/catalog_transport.rs
git commit -m "fix: await online catalog webview responses"
```

---

### Task 2: Expose the Mapped Manual-Update Error

**Files:**
- Modify: `app/src/manga/OnlineCatalogBrowser.tsx`
- Modify: `app/src/manga/OnlineCatalogBrowser.test.tsx`

**Interfaces:**
- Consumes: existing `commandErrorMessage(error: unknown, fallback: string) -> string` and `LibraryGateway.updateOnlineCatalog()`.
- Produces: manual-update toast text that uses the command's public `message` when present and retains `온라인 카탈로그를 갱신하지 못했습니다` as fallback.

- [ ] **Step 1: Write the failing mapped-error test**

Add next to the existing successful manual-update test:

```tsx
it("shows the public command error when a manual catalog update fails", async () => {
  const gateway = createGateway(true);
  vi.mocked(gateway.updateOnlineCatalog).mockRejectedValue({
    code: "invalid_catalog_transport_response",
    message: "온라인 카탈로그 응답을 처리할 수 없습니다",
  });
  renderBrowser(gateway);

  await userEvent.click(await screen.findByRole("button", { name: "지금 갱신" }));

  expect(await screen.findByText("온라인 카탈로그 응답을 처리할 수 없습니다"))
    .toBeInTheDocument();
});
```

- [ ] **Step 2: Run the browser test and verify RED**

Run from `C:\chatgpt\app`:

```powershell
npm test -- src/manga/OnlineCatalogBrowser.test.tsx
```

Expected: the assertion fails because `updateCatalog` discards the caught value and renders only the generic fallback.

- [ ] **Step 3: Reuse the existing error mapper**

Change only the catch clause in `updateCatalog`:

```tsx
} catch (error) {
  setMessage(commandErrorMessage(error, "온라인 카탈로그를 갱신하지 못했습니다"));
} finally {
```

Do not add another toast component, mapper, or catalog-specific error table.

- [ ] **Step 4: Run the focused frontend check and verify GREEN**

```powershell
npm test -- src/manga/OnlineCatalogBrowser.test.tsx
```

Expected: the file exits 0, including successful update and public-error cases.

- [ ] **Step 5: Verify the complete requested path**

From `C:\chatgpt`, run the final focused checks without repeating successful checks after no further edits:

```powershell
cargo test --manifest-path app/src-tauri/Cargo.toml --lib catalog_transport::tests
cargo test --manifest-path app/src-tauri/Cargo.toml --lib library::catalog_update::tests
Set-Location app
npm test -- src/manga/OnlineCatalogBrowser.test.tsx
npm run build
```

Then use the already-running development app after it recompiles: open `망가 → 온라인 카탈로그`, click `지금 갱신`, and verify the result is `이미 최신`, an added-work count, a page-limit completion, or a specific mapped transport error. The generic message alone is not acceptable evidence.

- [ ] **Step 6: Commit the UI error mapping**

```powershell
git add -- app/src/manga/OnlineCatalogBrowser.tsx app/src/manga/OnlineCatalogBrowser.test.tsx
git commit -m "fix: show online catalog update errors"
```

---

## Completion Evidence

Record the two implementation commit hashes, exact command exit statuses, and the observed live-app update outcome. Run `git status --short` and list unrelated pre-existing changes separately. Do not push unless the user requests it.
