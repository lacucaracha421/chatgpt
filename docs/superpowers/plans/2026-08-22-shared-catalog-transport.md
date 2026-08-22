# Shared Catalog Chromium Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide one tested hidden-Chromium request module that both online-catalog updates and K-Hentai gallery resolution can reuse.

**Architecture:** `CatalogTransport` owns one invisible Tauri WebviewWindow parked on the K-Hentai origin. Callers pass only validated same-origin paths and receive response text; window creation, callback serialization, timeouts, and HTTP errors stay behind this small interface.

**Tech Stack:** Rust, Tauri 2 `WebviewWindow`, `eval_with_callback`, standard-library channels, serde/serde_json

**Spec:** `docs/superpowers/specs/2026-08-22-online-manga-catalog-design.md`

## Global Constraints

- Do not copy or execute VCK/violet-web implementation code.
- Reuse exactly one invisible WebView labeled `catalog-transport`.
- Create the WebView only from an async Tauri command path on Windows.
- Accept only same-origin absolute paths beginning with `/`; reject schemes, backslashes, fragments, control characters, and protocol-relative paths.
- Use a 60-second timeout and never perform real network requests in automated tests.
- Add no Rust crate and expose no external image or page URL to React.
- Keep the current visible `open_online_catalog_work` fallback until the internal `PageViewer` path is complete.

---

### Task 1: Closed request grammar and callback decoding

**Files:**
- Create: `app/src-tauri/src/catalog_transport.rs`
- Modify: `app/src-tauri/src/library/error.rs`
- Test: `app/src-tauri/src/catalog_transport.rs`

**Interfaces:**
- Produces: `pub(crate) fn search_page_path(cursor: Option<u64>) -> String`.
- Produces: `pub(crate) fn gallery_path(work_id: u64) -> String`.
- Produces: `fn request_script(path: &str) -> Result<String, LibraryError>`.
- Produces: `fn decode_callback(value: &str) -> Result<String, LibraryError>`.
- Produces errors `InvalidCatalogTransportPath`, `CatalogTransportRejected(u16)`, `InvalidCatalogTransportResponse`, `CatalogTransportTimedOut`, and `CatalogTransportUnavailable`.

- [x] **Step 1: Write failing pure tests**

Add tests that require exact generated paths, safe script encoding, rejection of non-origin paths, double-serialized callback decoding, HTTP rejection, and malformed callback rejection:

```rust
#[test]
fn builds_closed_same_origin_paths() {
    assert_eq!(search_page_path(None), "/ajax/search?search=language%3Akorean");
    assert_eq!(
        search_page_path(Some(4_127_793)),
        "/ajax/search?search=language%3Akorean&next-id=4127793",
    );
    assert_eq!(gallery_path(4_127_792), "/r/4127792");
}

#[test]
fn rejects_paths_that_can_leave_the_origin() {
    for path in [
        "https://example.test/",
        "//example.test/",
        "/r/1#fragment",
        "/r\\1",
        "/r/1\nalert(1)",
    ] {
        assert!(matches!(
            request_script(path),
            Err(LibraryError::InvalidCatalogTransportPath)
        ));
    }
}

#[test]
fn decodes_the_json_string_returned_by_eval_with_callback() {
    let callback = serde_json::to_string(
        &serde_json::json!({ "ok": true, "status": 200, "body": "[{\"id\":1}]" })
            .to_string(),
    )
    .unwrap();
    assert_eq!(decode_callback(&callback).unwrap(), "[{\"id\":1}]");
}
```

- [x] **Step 2: Run the tests and verify RED**

Run: `cargo test --lib catalog_transport::tests --manifest-path app/src-tauri/Cargo.toml`

Expected: FAIL because `catalog_transport` and its functions do not exist.

- [x] **Step 3: Implement the pure protocol helpers**

Use the already-installed `url` crate only for form encoding. Generate scripts from validated paths and JSON-encode the path with `serde_json::to_string`:

```rust
#[derive(serde::Deserialize)]
struct TransportResponse {
    ok: bool,
    status: u16,
    body: String,
}

fn request_script(path: &str) -> Result<String, LibraryError> {
    validate_path(path)?;
    let path = serde_json::to_string(path)
        .map_err(|_| LibraryError::InvalidCatalogTransportPath)?;
    Ok(format!(r#"(async () => {{
      try {{
        const response = await fetch({path}, {{ credentials: 'include', cache: 'no-store' }});
        return JSON.stringify({{ ok: response.ok, status: response.status, body: await response.text() }});
      }} catch (error) {{
        return JSON.stringify({{ ok: false, status: 0, body: String(error) }});
      }}
    }})()"#))
}
```

`decode_callback` must first deserialize the callback as `String`, then deserialize that inner string as `TransportResponse`. Return `body` only when `ok` is true and `status` is 200; map nonzero status to `CatalogTransportRejected(status)` and status zero to `CatalogTransportUnavailable`.

- [x] **Step 4: Run the pure tests and verify GREEN**

Run: `cargo test --lib catalog_transport::tests --manifest-path app/src-tauri/Cargo.toml`

Expected: PASS.

- [x] **Step 5: Review the interface**

Confirm no public function accepts a full URL or JavaScript source, and `request_script` plus callback structs remain private.

### Task 2: Lazy hidden WebView lifecycle and timeout

**Files:**
- Modify: `app/src-tauri/src/catalog_transport.rs`
- Modify: `app/src-tauri/src/lib.rs`
- Test: `app/src-tauri/src/catalog_transport.rs`

**Interfaces:**
- Consumes: Task 1 `request_script(path)` and `decode_callback(value)`.
- Produces: `CatalogTransport::fetch_text(&self, app: &AppHandle, path: &str) -> Result<String, LibraryError>` as an async method.
- Produces: managed `CatalogTransport` state initialized once in `run()`.

- [x] **Step 1: Write failing state tests**

Keep WebView creation outside unit tests. Test the concurrency guard and blocking channel result helper directly:

```rust
#[test]
fn rejects_an_overlapping_request() {
    let transport = CatalogTransport::default();
    let first = transport.begin_request().unwrap();
    assert!(matches!(
        transport.begin_request(),
        Err(LibraryError::CatalogTransportBusy)
    ));
    drop(first);
    assert!(transport.begin_request().is_ok());
}

#[test]
fn maps_a_missing_callback_to_timeout() {
    let (_sender, receiver) = std::sync::mpsc::channel();
    assert!(matches!(
        receive_callback(receiver, Duration::ZERO),
        Err(LibraryError::CatalogTransportTimedOut)
    ));
}
```

Add `CatalogTransportBusy` to `LibraryError`.

- [x] **Step 2: Run the state tests and verify RED**

Run: `cargo test --lib catalog_transport::tests --manifest-path app/src-tauri/Cargo.toml`

Expected: FAIL because lifecycle helpers are absent.

- [x] **Step 3: Implement one-request-at-a-time state**

Use `AtomicBool::compare_exchange` and a small private drop guard instead of holding a `MutexGuard` across an await:

```rust
#[derive(Default)]
pub(crate) struct CatalogTransport {
    busy: std::sync::atomic::AtomicBool,
}

struct RequestGuard<'a>(&'a std::sync::atomic::AtomicBool);

impl Drop for RequestGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::Release);
    }
}
```

`begin_request` uses `compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)` and returns `CatalogTransportBusy` when another request is running.

- [x] **Step 4: Implement lazy WebView creation**

In `ensure_window`, reuse `app.get_webview_window("catalog-transport")`. Otherwise build:

```rust
WebviewWindowBuilder::new(
    app,
    "catalog-transport",
    WebviewUrl::External(K_HENTAI_ORIGIN.parse().expect("static origin is valid")),
)
.visible(false)
.skip_taskbar(true)
.on_navigation(|url| url.origin().ascii_serialization() == K_HENTAI_ORIGIN)
.on_page_load(move |_window, payload| {
    if matches!(payload.event(), PageLoadEvent::Finished) {
        let _ = ready_sender.send(());
    }
})
.build()?;
```

Wait for the initial `Finished` event using `tauri::async_runtime::spawn_blocking` around `recv_timeout(Duration::from_secs(60))`. Map builder and callback failures to `CatalogTransportUnavailable`.

- [x] **Step 5: Implement `fetch_text`**

Acquire `RequestGuard`, await `ensure_window`, call `eval_with_callback(request_script(path)?, callback)`, then await a second standard-library channel through `spawn_blocking`. Decode the callback only after it arrives. The guard remains alive until the method returns, including every error path.

- [x] **Step 6: Register managed state**

Add `mod catalog_transport;` and `.manage(catalog_transport::CatalogTransport::default())` in `app/src-tauri/src/lib.rs`. Do not add a public Tauri command yet; update and gallery commands consume this managed state in their own plans.

- [x] **Step 7: Run focused verification**

Run: `cargo test --lib catalog_transport::tests --manifest-path app/src-tauri/Cargo.toml`

Expected: PASS.

Run: `cargo check --manifest-path app/src-tauri/Cargo.toml`

Expected: PASS.

Run: `cargo fmt --manifest-path app/src-tauri/Cargo.toml -- --check`

Expected: PASS.

### Task 3: Consumer seam fixtures and plan handoff

**Files:**
- Modify: `app/src-tauri/src/catalog_transport.rs`
- Test: `app/src-tauri/src/catalog_transport.rs`
- Modify: `docs/superpowers/plans/2026-08-22-online-catalog-update.md`
- Modify: `docs/superpowers/plans/2026-08-22-online-manga-quick-view.md`

**Interfaces:**
- Consumes: `search_page_path`, `gallery_path`, and `CatalogTransport::fetch_text`.
- Produces: exact transport seam used by the update and quick-view plans.

- [x] **Step 1: Add fixture contract tests**

Add one fixture for each downstream response shape without making a network call:

```rust
#[test]
fn search_and_gallery_requests_share_the_same_transport_decoder() {
    let search = callback_value(true, 200, r#"[{"id":4127792}]"#);
    let gallery = callback_value(
        true,
        200,
        r#"<script>const gallery = {"files":[]};</script>"#,
    );
    assert!(decode_callback(&search).unwrap().starts_with('['));
    assert!(decode_callback(&gallery).unwrap().contains("const gallery"));
}
```

- [x] **Step 2: Run fixture tests**

Run: `cargo test --lib catalog_transport::tests --manifest-path app/src-tauri/Cargo.toml`

Expected: PASS.

- [x] **Step 3: Verify downstream plans consume, rather than recreate, transport**

Confirm the update plan creates no WebView and calls:

```rust
transport
    .fetch_text(&app, &search_page_path(cursor))
    .await
```

Confirm the quick-view plan creates no K-Hentai WebView and calls:

```rust
transport
    .fetch_text(&app, &gallery_path(work_id))
    .await
```

- [x] **Step 4: Final transport verification**

Run: `cargo test --lib catalog_transport --manifest-path app/src-tauri/Cargo.toml`

Expected: PASS.

Run: `git diff --check`

Expected: no whitespace errors.
