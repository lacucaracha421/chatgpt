# Lakomics Edge Radial X Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Windows Edge extension that opens a radial classification menu when an X image is dragged, then downloads and classifies that image directly through the running Lakomics desktop app.

**Architecture:** A Manifest V3 extension owns X DOM adaptation, the continuous-drag radial UI, slot layout, and a service-worker-only authenticated client. Lakomics owns the classification tree, URL validation, remote download, media ingestion, duplicate policy, and a loopback-only HTTP server; the existing file-ingestion pipeline remains the single media validation and storage path.

**Tech Stack:** Rust 2021, Tauri 2, `tiny_http` 0.12, `ureq` 3, `url` 2, React 19, TypeScript 5.8, Vitest 4, Edge Manifest V3, browser-native JavaScript, Node built-in test runner

## Global Constraints

- Target Windows PC and Microsoft Edge only; do not add touch or mobile behavior.
- Bind the app API only to `127.0.0.1:32145` and allow only the stable extension origin `chrome-extension://nclkmjmmlcdaeomgadndeangccfidfbk`.
- Keep the bearer token outside each library database in Tauri's application config directory.
- Keep the token inside the extension service worker and `chrome.storage.local`; never send it to content scripts.
- Accept only HTTPS media URLs on `pbs.twimg.com` and HTTPS source URLs on `x.com` or `twitter.com`; disable redirects.
- Validate the classification before downloading and cap both JSON request bodies and downloaded image bytes.
- Reuse `Library::ingest_media`; do not alter file-drop exact-duplicate behavior.
- Store one final classification ID only. Ancestor membership continues to be derived by existing classification queries.
- Use 6 stable slots for 1–6 children, 12 stable slots for 7–12 children, and pages of 12 for 13 or more children.
- Open the radial menu at 12px pointer movement and descend or page after a 300ms dwell.
- Use no extension runtime dependency, bundler, UI framework, or duplicate tag database.

---

## File Structure

- `app/src-tauri/src/extension_api.rs`: one loopback interface boundary containing token persistence, request authentication/CORS, routing, remote X-image download, and extension-only duplicate classification policy.
- `app/src-tauri/src/commands.rs`: shareable `AppState` and a small Tauri command exposing connection status/token to the desktop settings UI.
- `app/src-tauri/src/lib.rs`: create shared state once, start the HTTP server during Tauri setup, and register the settings command.
- `app/src/library/types.ts` and `app/src/library/client.ts`: typed desktop gateway contract for extension connection details.
- `app/src/settings/SettingsView.tsx`, its test, and `app/src/styles.css`: desktop connection-key/status UI using existing shared controls.
- `extension/manifest.json`: stable public key, X content-script registration, service worker, storage permission, and loopback host permission.
- `extension/src/layout.js`: pure classification-tree reconciliation, stable slot assignment, and paging.
- `extension/src/gesture.js`: pure continuous-drag geometry and dwell state transitions.
- `extension/src/x-source.js`: the only X-specific DOM and URL normalization adapter.
- `extension/src/background.js`: token storage, 30-second classification cache, and authenticated loopback calls.
- `extension/src/content.js` and `extension/src/content.css`: pointer lifecycle, radial SVG rendering, cancellation, result overlay, and retry.
- `extension/options/*`: connection form, classification refresh, WYSIWYG slot editor, and reset action.
- `extension/tests/*`: Node built-in tests for pure extension logic plus mocked Chrome/service-worker tests.

### Task 1: Bootstrap the authenticated loopback interface

**Files:**
- Modify: `app/src-tauri/Cargo.toml`
- Create: `app/src-tauri/src/extension_api.rs`
- Modify: `app/src-tauri/src/commands.rs:1-94`
- Modify: `app/src-tauri/src/lib.rs:1-58`

**Interfaces:**
- Consumes: `tauri::AppHandle`, `tauri::Manager`, and `AppState::current_library()`
- Produces: `extension_api::ExtensionRuntime`, `extension_api::ExtensionConnection`, `extension_api::start(app_handle, state)`, and Tauri command `get_extension_connection`

- [ ] **Step 1: Add failing token and request-boundary unit tests**

At the bottom of `extension_api.rs`, add tests using `tempfile::TempDir` that assert one 32-character lowercase hexadecimal token is created and reused, `Bearer <token>` is required, only the exact extension origin is accepted, and bodies over 32 KiB are rejected.

```rust
#[test]
fn creates_and_reuses_one_install_token() {
    let root = tempfile::tempdir().unwrap();
    let first = load_or_create_token(root.path()).unwrap();
    let second = load_or_create_token(root.path()).unwrap();
    assert_eq!(first, second);
    assert_eq!(first.len(), 32);
    assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()));
}

#[test]
fn requires_exact_origin_and_bearer_token() {
    assert!(authorize(Some(EXTENSION_ORIGIN), Some("Bearer abc"), "abc").is_ok());
    assert_eq!(authorize(Some("https://x.com"), Some("Bearer abc"), "abc"), Err(ApiError::ForbiddenOrigin));
    assert_eq!(authorize(Some(EXTENSION_ORIGIN), Some("Bearer wrong"), "abc"), Err(ApiError::Unauthorized));
}

#[test]
fn rejects_oversized_json_body() {
    let bytes = vec![b'x'; MAX_JSON_BYTES + 1];
    assert_eq!(read_json_limited(bytes.as_slice()).unwrap_err(), ApiError::BodyTooLarge);
}
```

- [ ] **Step 2: Run the focused Rust test to verify RED**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml extension_api`

Expected: FAIL because the module, constants, token loader, authorization, and body limiter do not exist.

- [ ] **Step 3: Add dependencies and the minimal runtime boundary**

Add these exact dependencies:

```toml
tiny_http = "0.12.0"
ureq = "3.4.0"
url = "2"
```

Create these public contracts and constants in `extension_api.rs`:

```rust
pub const API_ADDRESS: &str = "127.0.0.1:32145";
pub const API_BASE_URL: &str = "http://127.0.0.1:32145";
pub const EXTENSION_ORIGIN: &str = "chrome-extension://nclkmjmmlcdaeomgadndeangccfidfbk";
const MAX_JSON_BYTES: usize = 32 * 1024;

#[derive(Clone, Default)]
pub struct ExtensionRuntime(Arc<RwLock<RuntimeStatus>>);

#[derive(Clone, Default)]
enum RuntimeStatus { #[default] Starting, Ready { token: String }, BindFailed }

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionConnection {
    pub base_url: &'static str,
    pub token: String,
    pub status: ConnectionStatus,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionStatus { Ready, BindFailed }
```

Implement `load_or_create_token(config_dir)` with `create_dir_all`, `OpenOptions::create_new(true)`, and `Uuid::new_v4().simple().to_string()`. If another process wins file creation, read the resulting file. Implement exact string checks in `authorize`; compare only after parsing the `Authorization` value with `strip_prefix("Bearer ")`. Implement `read_json_limited` with `Read::take((MAX_JSON_BYTES + 1) as u64)` and reject the extra byte before deserialization.

Change `AppState` to clone an `Arc` rather than duplicating library ownership:

```rust
#[derive(Clone, Default)]
pub struct AppState {
    library: Arc<RwLock<Option<Library>>>,
}
```

Create one `AppState` and one `ExtensionRuntime` in `lib.rs`, manage both, and start the server in `.setup(...)`. The `start` function must obtain `app.path().app_config_dir()`, load the token, bind `tiny_http::Server::http(API_ADDRESS)`, update runtime status, and spawn a named `lakomics-extension-api` thread. Bind/token failures update `BindFailed` and let the desktop app continue running.

Add the command:

```rust
#[tauri::command]
pub fn get_extension_connection(
    runtime: State<'_, ExtensionRuntime>,
) -> ExtensionConnection {
    runtime.connection()
}
```

Register `commands::get_extension_connection` in the existing `tauri::generate_handler!` list.

- [ ] **Step 4: Run the focused tests to verify GREEN**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml extension_api`

Expected: PASS, including token reuse, exact origin/auth checks, and the body limit.

- [ ] **Step 5: Commit the loopback bootstrap**

```powershell
git add app/src-tauri/Cargo.toml app/src-tauri/Cargo.lock app/src-tauri/src/extension_api.rs app/src-tauri/src/commands.rs app/src-tauri/src/lib.rs
git commit -m "feat: bootstrap authenticated extension api"
```

### Task 2: Route classification reads with strict CORS and errors

**Files:**
- Modify: `app/src-tauri/src/extension_api.rs`
- Modify: `app/src-tauri/src/library/ingestion.rs:25-27`

**Interfaces:**
- Consumes: `AppState::current_library()` and `Library::list_classifications()`
- Produces: `OPTIONS /v1/*`, `GET /v1/classifications`, JSON error envelope `{ "code", "message" }`, and `handle_request(Request, &AppState, &str)`

- [ ] **Step 1: Add failing route tests around a temporary library**

Start an in-process server on `127.0.0.1:0` through a test helper and assert these exact cases: OPTIONS returns 204 with the fixed origin and allowed headers; missing auth returns 401; wrong origin returns 403; no open library returns 409 `library_not_open`; authenticated GET returns the existing `ClassificationEntry` camelCase contract; unknown routes return 404.

```rust
#[test]
fn classification_route_requires_auth_and_returns_existing_contract() {
    let fixture = ApiFixture::with_open_library();
    fixture.create_tag("Character");
    let response = fixture.get("/v1/classifications", true, EXTENSION_ORIGIN);
    assert_eq!(response.status, 200);
    assert_eq!(response.json["entries"][0]["name"], "Character");
    assert!(response.json["entries"][0].get("parentId").is_some());
}
```

- [ ] **Step 2: Run the route tests to verify RED**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml extension_api::tests::classification_route`

Expected: FAIL because request routing and response serialization are absent.

- [ ] **Step 3: Implement one synchronous request dispatcher**

Add private response helpers that always attach:

```text
Access-Control-Allow-Origin: chrome-extension://nclkmjmmlcdaeomgadndeangccfidfbk
Vary: Origin
Content-Type: application/json; charset=utf-8
```

OPTIONS additionally returns `Access-Control-Allow-Methods: GET, POST, OPTIONS` and `Access-Control-Allow-Headers: Authorization, Content-Type`. Authenticate every GET/POST before routing. Serialize classifications directly as `{"entries": entries}` without a second extension-specific model. Map `library_not_open` to 409, malformed JSON/URL to 400, unauthorized to 401, forbidden origin to 403, missing classification to 404, oversized bodies/downloads to 413, upstream download errors to 502, and internal I/O/database failures to 500.

- [ ] **Step 4: Run the complete extension API tests**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml extension_api`

Expected: PASS with exact statuses, JSON envelopes, and CORS headers.

- [ ] **Step 5: Commit classification routing**

```powershell
git add app/src-tauri/src/extension_api.rs
git commit -m "feat: expose classifications to Edge extension"
```

### Task 3: Download and ingest one validated X image

**Files:**
- Modify: `app/src-tauri/src/extension_api.rs`

**Interfaces:**
- Consumes: `Library::ingest_media(IngestMediaRequest)`, `Library::list_classifications()`, `Library::get_asset_classifications()`, and `Library::patch_asset_classifications(AssetClassificationPatch)`
- Produces: `POST /v1/ingestions`, `XIngestionRequest`, `XIngestionResponse`, `ImageDownloader::download`, and extension-only statuses `added | duplicate_tagged | duplicate_unchanged | review_pending`

- [ ] **Step 1: Add failing validation, cleanup, and outcome tests**

Use a local test HTTP source only through an injected `ImageDownloader` test seam; production URL validation still requires `pbs.twimg.com`. Cover: unsupported `source`, HTTP scheme, misleading host suffix, non-X source host, redirect response, missing classification rejected before downloader invocation, byte limit, invalid image bytes, staging cleanup on failure, new asset classification/source URL, duplicate classification add, duplicate no-op, and similarity-review propagation.

```rust
#[test]
fn validates_classification_before_downloading() {
    let downloader = RecordingDownloader::default();
    let error = ingest_x_image(&library, request_with_classification("missing"), &downloader).unwrap_err();
    assert_eq!(error, ApiError::ClassificationNotFound);
    assert_eq!(downloader.calls(), 0);
}

#[test]
fn exact_duplicate_adds_only_the_requested_classification() {
    let first = fixture.ingest_png("first", &fixture.tag_a);
    let result = fixture.ingest_same_png_through_extension(&fixture.tag_b);
    assert_eq!(result.status, IngestionStatus::DuplicateTagged);
    assert_eq!(result.asset_id.as_deref(), Some(first.id.as_str()));
    assert_eq!(fixture.direct_classifications(&first.id), vec![fixture.tag_a.clone(), fixture.tag_b.clone()]);
}
```

- [ ] **Step 2: Run ingestion API tests to verify RED**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml extension_api::tests::ingestion`

Expected: FAIL because the request model, URL checks, downloader, and duplicate adapter are absent.

- [ ] **Step 3: Implement the minimal remote adapter**

Define exact wire models:

```rust
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct XIngestionRequest {
    source: String,
    media_url: String,
    source_url: String,
    classification_id: String,
}

#[derive(Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct XIngestionResponse {
    status: IngestionStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    asset_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    review_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum IngestionStatus { Added, DuplicateTagged, DuplicateUnchanged, ReviewPending }

trait ImageDownloader: Send + Sync {
    fn download(
        &self,
        media_url: &Url,
        destination: &Path,
        maximum_bytes: u64,
    ) -> Result<(), ApiError>;
}
```

Parse with `url::Url`; require `source == "x"`, exact schemes/hosts, and a non-empty classification ID. Check the classification list before starting network I/O. Configure a production `ureq::Agent` with `https_only(true)` and `max_redirects(0)`. Stream at most `MAX_IMAGE_BYTES + 1` bytes to `<library root>/assets/.staging/remote-<uuid>.png`; the `.png` suffix only selects the existing image pipeline, while `image` crate detection remains authoritative. Use an RAII temporary-file guard so every return path removes this first-stage file.

Change the existing limit declaration to `pub(crate) const MAX_IMAGE_BYTES: u64 = 512 * 1024 * 1024;` and import it into `extension_api.rs`, so the file and remote ingestion paths cannot drift to different limits.

Call existing ingestion with:

```rust
library.ingest_media(IngestMediaRequest {
    source_path: temporary_path,
    classification_id: Some(request.classification_id.clone()),
    source_url: Some(request.source_url.clone()),
})
```

Map `Added` to `added`, `ReviewPending` to `review_pending`, and `ExactDuplicate` by reading direct classifications. If absent, invoke the existing patch method with one asset and one added classification and return `duplicate_tagged`; otherwise return `duplicate_unchanged`. Do not change `Library::ingest_media` itself.

- [ ] **Step 4: Run Rust regression tests**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml extension_api && cargo test --manifest-path app/src-tauri/Cargo.toml library::ingestion`

Expected: PASS; extension duplicate tests differ from, and existing file-ingestion duplicate tests preserve, their respective policies.

- [ ] **Step 5: Commit remote ingestion**

```powershell
git add app/src-tauri/src/extension_api.rs app/src-tauri/src/library/ingestion.rs
git commit -m "feat: ingest classified X images"
```

### Task 4: Show extension connection details in Lakomics settings

**Files:**
- Modify: `app/src/library/types.ts`
- Modify: `app/src/library/client.ts`
- Modify: every test-local `LibraryGateway` mock reported by `rg -l "LibraryGateway" app/src -g "*.test.tsx"`
- Modify: `app/src/settings/SettingsView.tsx`
- Modify: `app/src/settings/SettingsView.test.tsx`
- Modify: `app/src/styles.css`

**Interfaces:**
- Consumes: Tauri command `get_extension_connection`
- Produces: `ExtensionConnection`, `LibraryGateway.getExtensionConnection()`, and a desktop settings section named `browser_extension`

- [ ] **Step 1: Add failing gateway and settings tests**

Add the type and mock response:

```ts
export type ExtensionConnection = {
  baseUrl: string;
  token: string;
  status: "ready" | "bind_failed";
};
```

Test that opening “브라우저 확장” calls the gateway, renders running/unavailable status and base URL, keeps the token in a read-only input, and copies it only after the Copy button is clicked. Mock `navigator.clipboard.writeText` and assert the token is not logged or placed in any data attribute.

- [ ] **Step 2: Run settings tests to verify RED**

Run: `npm.cmd test --prefix app -- src/settings/SettingsView.test.tsx`

Expected: FAIL because the gateway method and settings section do not exist.

- [ ] **Step 3: Add the typed gateway and focused UI**

Extend `LibraryGateway` with:

```ts
getExtensionConnection(): Promise<ExtensionConnection>;
```

Implement it in `client.ts` as `invoke<ExtensionConnection>("get_extension_connection")`. Add `getExtensionConnection: vi.fn()` to every concrete test mock so TypeScript remains exhaustive.

Extend the section union with `"browser_extension"`. Fetch connection details only when that section is selected. Render existing `Button`, `Toast`, and field styles; add only `.settings-view__extension`, `.settings-view__token-row`, and `.settings-view__token` rules. The token input uses `type="password"`, `readOnly`, and an accessible label. The copy handler calls `navigator.clipboard.writeText(connection.token)` and shows transient “연결 키를 복사했습니다” feedback; a rejected copy shows a retryable error.

- [ ] **Step 4: Run frontend tests and build**

Run: `npm.cmd test --prefix app -- src/settings/SettingsView.test.tsx && npm.cmd run build --prefix app`

Expected: PASS with no TypeScript omissions in gateway mocks.

- [ ] **Step 5: Commit desktop settings integration**

```powershell
git add app/src/library/types.ts app/src/library/client.ts app/src/settings/SettingsView.tsx app/src/settings/SettingsView.test.tsx app/src/styles.css
git diff --name-only -- app/src | Where-Object { $_ -like '*.test.tsx' } | ForEach-Object { git add -- $_ }
git commit -m "feat: show Edge extension connection key"
```

### Task 5: Create the zero-build extension client and settings shell

**Files:**
- Create: `extension/manifest.json`
- Create: `extension/package.json`
- Create: `extension/src/background.js`
- Create: `extension/options/options.html`
- Create: `extension/options/options.css`
- Create: `extension/options/options.js`
- Create: `extension/tests/background.test.mjs`

**Interfaces:**
- Consumes: `GET /v1/classifications`, `POST /v1/ingestions`, and fixed API base URL
- Produces: runtime messages `settings:get`, `settings:set-token`, `layout:get`, `layout:set`, `classifications:get`, `classifications:refresh`, and `ingestion:create`

- [ ] **Step 1: Add failing service-worker tests with a mocked Chrome API**

Load `background.js` in a `vm` context. Assert the token is read from `chrome.storage.local`, only the worker creates `Authorization`, classifications are cached for exactly 30 seconds, an offline app never falls back to stale entries, refresh bypasses the cache, and ingestion error codes remain available to the content script.

```js
test("does not return stale classifications while Lakomics is offline", async () => {
  clock.now = 31_001;
  fetchMock.reject(new TypeError("Failed to fetch"));
  const response = await dispatch({ type: "classifications:get" });
  assert.deepEqual(response, { ok: false, code: "app_offline" });
});
```

- [ ] **Step 2: Run Node tests to verify RED**

Run: `npm.cmd test --prefix extension`

Expected: FAIL because the extension package and worker do not exist.

- [ ] **Step 3: Add the manifest, worker, and connection form**

Use this manifest shape and the approved public key:

```json
{
  "manifest_version": 3,
  "name": "Lakomics X Collector",
  "version": "0.1.0",
  "key": "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAoVaw8+c/BZaPfB7fgI7o7qQIZ9MGdYQIGIsbmh/UchG2oiDupRA6UYCaqIku4muCPY7f4EP5rI94UitEkUrPmDFWIvAPqY+1fkESWsHR5qwPKdGxCNPITtoSS7CyRp5m1WwErsAyhRU1q7qZ1+ahjExqYwKC401+058dUGNqGivgfF0rcU9h6RjUfifhC7fg14bwRmI8q63JcetjS3LTMt0USJpnWctvS5NjAzGAycbFiOySrheunxgIcEx81W/Ywz+zexzlVeMtOabo+VaDzM6npx8DiOiPrDHXlz0rDlFCABmcjnWJO1DwMvWeqOnONMHw/ocMMpqWQzzyi22MBQIDAQAB",
  "permissions": ["storage"],
  "host_permissions": ["http://127.0.0.1:32145/*"],
  "background": { "service_worker": "src/background.js" },
  "options_page": "options/options.html"
}
```

Use `extension/package.json` with only `{"private":true,"scripts":{"test":"node --test tests/*.test.mjs"}}`. In the worker, keep `API_BASE_URL`, `CACHE_MS = 30_000`, cached entries, and cache timestamp in module memory. Read/write only `connectionToken` and later `radialLayout` in local storage. The options form has a password input, Save, Test/Refresh, status text, and an empty editor mount; it never displays the token after saving.

- [ ] **Step 4: Run worker tests**

Run: `npm.cmd test --prefix extension`

Expected: PASS for authentication isolation, cache expiry, forced refresh, offline behavior, and error propagation.

- [ ] **Step 5: Commit extension connectivity**

```powershell
git add extension/manifest.json extension/package.json extension/src/background.js extension/options extension/tests/background.test.mjs
git commit -m "feat: connect Edge extension to Lakomics"
```

### Task 6: Reconcile the classification tree into stable radial slots

**Files:**
- Create: `extension/src/layout.js`
- Create: `extension/tests/layout.test.mjs`
- Modify: `extension/src/background.js`
- Modify: `extension/options/options.html`
- Modify: `extension/options/options.css`
- Modify: `extension/options/options.js`

**Interfaces:**
- Consumes: `ClassificationEntry[]` from the worker and stored `RadialLayoutV1`
- Produces: `LakomicsRadial.reconcileLayout(entries, stored)`, `getLevel(entries, layout, parentId, page)`, `moveSlot(layout, parentId, from, to)`, and `resetLayout(entries)`

- [ ] **Step 1: Add failing pure layout tests**

Define the storage contract in the test:

```js
const stored = {
  version: 1,
  parents: {
    __root__: [["a", null, "b", null, null, null]],
    a: [["a1", "a2", null, null, null, null]],
  },
};
```

Assert 1–6 children yield six slots, 7–12 yield twelve, 13 yield two twelve-slot pages, empty slots remain empty, names can change without movement, deleted/moved IDs disappear, new IDs occupy the first empty slot then append to the last page, and moving/resetting persists a deterministic version-1 layout.

- [ ] **Step 2: Run layout tests to verify RED**

Run: `npm.cmd test --prefix extension -- tests/layout.test.mjs`

Expected: FAIL because `layout.js` does not exist.

- [ ] **Step 3: Implement pure reconciliation and the WYSIWYG editor**

Wrap the classic script in an IIFE and expose only one isolated-world namespace:

```js
(() => {
  const ROOT = "__root__";
  function slotCount(childCount) { return childCount <= 6 ? 6 : 12; }
  globalThis.LakomicsRadial = { ROOT, slotCount, reconcileLayout, getLevel, moveSlot, resetLayout };
})();
```

Build the live editor from `getLevel`: render the same circular slot angles as the content menu, a parent breadcrumb, previous/next page controls outside the ring, and clickable source/destination slots for swaps. Empty slots are explicit buttons. Navigation changes only editor state; Save sends the complete `radialLayout`, and Reset replaces it with `resetLayout(entries)`. The worker reconciles before every classification response and persists only when reconciliation changes data.

Load `../src/layout.js` before `options.js` in the options page. Implement Save and Reset through the `layout:set` worker message and initial loading through `layout:get`; the options page must not access `chrome.storage.local` directly.

- [ ] **Step 4: Run all extension tests**

Run: `npm.cmd test --prefix extension`

Expected: PASS, including stable placement across rename, delete, move, and add operations.

- [ ] **Step 5: Commit layout and editor**

```powershell
git add extension/src/layout.js extension/src/background.js extension/options extension/tests/layout.test.mjs
git commit -m "feat: edit stable radial classification slots"
```

### Task 7: Isolate X image and post URL discovery

**Files:**
- Create: `extension/src/x-source.js`
- Create: `extension/tests/x-source.test.mjs`

**Interfaces:**
- Consumes: a pointer target inside X's dynamic DOM
- Produces: `LakomicsXSource.findCandidate(target)` returning `{ image, mediaUrl, sourceUrl } | null`

- [ ] **Step 1: Add failing adapter tests with minimal DOM-shaped fakes**

Cover direct `pbs.twimg.com/media/...` images, `srcset` preference for the largest candidate, conversion to `name=orig` while retaining/normalizing the supported `format`, the nearest `/status/<digits>` anchor, `twitter.com` normalization, avatars/emoji/video posters rejected, and unrelated DOM returning null.

```js
test("normalizes an X media image and its nearest post", () => {
  const candidate = findCandidate(fakePhoto({
    src: "https://pbs.twimg.com/media/ABC?format=jpg&name=small",
    href: "https://x.com/user/status/123/photo/1",
  }));
  assert.equal(candidate.mediaUrl, "https://pbs.twimg.com/media/ABC?format=jpg&name=orig");
  assert.equal(candidate.sourceUrl, "https://x.com/user/status/123/photo/1");
});
```

- [ ] **Step 2: Run adapter tests to verify RED**

Run: `npm.cmd test --prefix extension -- tests/x-source.test.mjs`

Expected: FAIL because the X adapter does not exist.

- [ ] **Step 3: Implement the single X-specific adapter**

Resolve an image with `target.closest("img")`; require URL hostname `pbs.twimg.com` and pathname prefix `/media/`. Find the nearest article and then an anchor whose pathname matches `/\/status\/\d+/`. Parse `srcset` candidates and choose the greatest numeric `w` descriptor, falling back to `currentSrc` then `src`. Normalize only the `name` query to `orig`; preserve `format` when it is `jpg`, `jpeg`, `png`, `webp`, or `gif`. Return null if any required URL is invalid. Keep every X selector and URL rule in this file.

- [ ] **Step 4: Run adapter and full extension tests**

Run: `npm.cmd test --prefix extension -- tests/x-source.test.mjs && npm.cmd test --prefix extension`

Expected: PASS without importing DOM frameworks.

- [ ] **Step 5: Commit the X adapter**

```powershell
git add extension/src/x-source.js extension/tests/x-source.test.mjs
git commit -m "feat: resolve original X image sources"
```

### Task 8: Implement continuous-drag radial navigation and collection feedback

**Files:**
- Modify: `extension/manifest.json`
- Create: `extension/src/gesture.js`
- Create: `extension/src/content.js`
- Create: `extension/src/content.css`
- Create: `extension/tests/gesture.test.mjs`
- Create: `extension/tests/content-controller.test.mjs`

**Interfaces:**
- Consumes: `findCandidate`, `getLevel`, worker messages, pointer coordinates, and timestamps
- Produces: `LakomicsGesture.createSession(origin, entries, layout)`, one radial SVG overlay, one nearby result toast, and retry of the identical ingestion payload

- [ ] **Step 1: Add failing geometry and controller tests**

Use fake time and event targets to cover: movement below 12px preserves normal click, movement at 12px opens once, only candidate-image `dragstart` is prevented, angular hit testing maps to stable slots, sector enter/leave starts/cancels a 300ms dwell, release before dwell selects the hovered classification, dwell descends, release in the center selects the current parent, the exterior bottom target dwells back one level, exterior left/right targets dwell between pages, final release sends one request, and Escape/pointercancel/window blur cancels with zero requests.

```js
test("release before child dwell selects the hovered parent", () => {
  const session = createSession({ x: 100, y: 100 }, tree, layout);
  session.move({ x: 112, y: 100 }, 0);
  session.move(pointForSlot(0), 299);
  assert.deepEqual(session.release(pointForSlot(0), 299), { type: "select", classificationId: "parent-a" });
});
```

- [ ] **Step 2: Run gesture/controller tests to verify RED**

Run: `npm.cmd test --prefix extension -- tests/gesture.test.mjs tests/content-controller.test.mjs`

Expected: FAIL because the gesture state machine and controller do not exist.

- [ ] **Step 3: Implement the state machine, SVG renderer, and feedback overlay**

Keep constants in `gesture.js`:

```js
const OPEN_DISTANCE_PX = 12;
const DWELL_MS = 300;
const INNER_RADIUS = 42;
const OUTER_RADIUS = 126;
```

The session owns origin, path IDs, parent ID, page, highlighted slot, dwell deadline, and whether the menu opened. Compute selection geometrically because pointer capture keeps DOM event targets fixed. `content.js` registers capture-phase `pointerdown`, `pointermove`, `pointerup`, `pointercancel`, `dragstart`, `keydown`, and `blur`; it accepts only `button === 0` and `pointerType === "mouse"`. Before opening, do not call `preventDefault`. Begin the cached classification request when a candidate image receives pointerdown, but preserve normal click behavior. At opening, capture the pointer if available, prevent subsequent moves/releases, and render one fixed-position SVG centered on the original pointer-down point; if classifications are still loading, show a non-selectable loading ring and cancel a release rather than guessing a classification.

Render 6 or 12 equal sectors with classification names, visible empty slots, breadcrumb text, a center region that represents the current parent, an exterior bottom back target below the first depth, and exterior left/right page targets. On final selection, close the ring, show “Lakomics로 수집 중”, and send exactly:

```js
{
  type: "ingestion:create",
  payload: { source: "x", mediaUrl, sourceUrl, classificationId }
}
```

Map outcomes to the approved Korean messages: `added` → “수집 완료”, `duplicate_tagged` → “기존 자산에 분류 추가”, `duplicate_unchanged` → “이미 저장됨”, `review_pending` → “유사 이미지 검토 대기”. Map `app_offline`, `unauthorized`, `classification_not_found`, and download failures to actionable text. Only retriable failures render a Retry button; store the immutable payload in the controller and resend it unchanged.

Add the content-script declaration only now that every referenced file exists:

```json
"content_scripts": [{
  "matches": ["https://x.com/*", "https://twitter.com/*"],
  "js": ["src/layout.js", "src/gesture.js", "src/x-source.js", "src/content.js"],
  "css": ["src/content.css"],
  "run_at": "document_idle"
}]
```

- [ ] **Step 4: Run the complete extension suite**

Run: `npm.cmd test --prefix extension`

Expected: PASS for click preservation, opening threshold, dwell transitions, pagination, cancellation, one-request semantics, and retry payload identity.

- [ ] **Step 5: Commit radial interaction**

```powershell
git add extension/manifest.json extension/src/gesture.js extension/src/content.js extension/src/content.css extension/tests/gesture.test.mjs extension/tests/content-controller.test.mjs
git commit -m "feat: collect X images with radial drag menu"
```

### Task 9: Verify the installed Edge workflow and document operation

**Files:**
- Create: `docs/edge-extension.md`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-11-lakomics-edge-radial-x-ingestion-design.md` only if verified behavior requires a factual correction

**Interfaces:**
- Consumes: the completed Tauri app and unpacked `extension/` directory
- Produces: reproducible install, connection, troubleshooting, and acceptance instructions

- [ ] **Step 1: Write the operator guide before manual acceptance**

Document exact steps: run Lakomics and open a library; open `edge://extensions`; enable Developer mode; Load unpacked and select `C:\chatgpt\extension`; confirm ID `nclkmjmmlcdaeomgadndeangccfidfbk`; copy the desktop settings token; save it in extension options; refresh classifications; open X; and perform the drag gesture. Include recovery for app offline, wrong key, stale/deleted classification, and a failed download retry. State that browser downloads remain empty because Lakomics writes its media vault directly.

- [ ] **Step 2: Run automated verification from a clean process**

Run:

```powershell
cargo fmt --manifest-path app/src-tauri/Cargo.toml -- --check
cargo test --manifest-path app/src-tauri/Cargo.toml
npm.cmd run check --prefix app
npm.cmd test --prefix extension
```

Expected: every command exits 0. If formatting fails, run `cargo fmt --manifest-path app/src-tauri/Cargo.toml`, inspect the diff, and rerun the full block.

- [ ] **Step 3: Perform the Windows Edge acceptance matrix**

Verify and record PASS/FAIL for these exact cases in the guide: ordinary click unchanged; 12px threshold; multi-level 300ms dwell; release-before-dwell parent selection; 6/12/13+ layouts; slot stability after rename/add/move/delete; new image stored with source/direct classification; same image to another classification adds only that link; repeat same link is unchanged; similarity review result; Escape/cancel/blur; app closed; bad token; deleted classification; failed download and Retry.

- [ ] **Step 4: Inspect final scope and secret hygiene**

Run:

```powershell
git diff --check
git status --short
rg -n "connectionToken|Authorization|Bearer" extension app/src-tauri/src app/src
rg -n "touchstart|touchmove|touchend|downloads\.download" extension
```

Expected: no whitespace errors; only intended files are modified; token reads/header construction occur only in `background.js` and server/settings boundaries; the touch/downloads search has no matches.

- [ ] **Step 5: Commit verified documentation**

```powershell
git add README.md docs/edge-extension.md docs/superpowers/specs/2026-08-11-lakomics-edge-radial-x-ingestion-design.md
git commit -m "docs: explain Edge radial collection setup"
```

## Final Verification

- [ ] Run `cargo test --manifest-path app/src-tauri/Cargo.toml` and confirm all Rust tests pass.
- [ ] Run `npm.cmd run check --prefix app` and confirm frontend tests and production build pass.
- [ ] Run `npm.cmd test --prefix extension` and confirm all zero-build extension tests pass.
- [ ] Run `git diff --check` and confirm no whitespace errors.
- [ ] Confirm the manual Edge acceptance matrix in `docs/edge-extension.md` contains no unverified PASS entry.
- [ ] Confirm the unrelated existing `manual-skill-commands.txt`, `Lakomics (Debug).lnk`, and `Lakomics.lnk` worktree changes were not staged.
