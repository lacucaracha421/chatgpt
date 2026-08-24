# Online Catalog WebView Transport Fix

## Problem

Manual online-catalog updates consistently fail with the generic UI message `온라인 카탈로그를 갱신하지 못했습니다`. The installed catalog remains searchable and the provider currently returns a valid HTTP 200 JSON array, but `online_catalog_settings.last_error` records `온라인 카탈로그 응답을 처리할 수 없습니다`.

`CatalogTransport` passes an async JavaScript IIFE to `WebviewWindow::eval_with_callback`. On Windows, WRY delegates this to WebView2 `ExecuteScript`, whose callback serializes the immediate evaluation result rather than awaiting the returned Promise. `decode_callback` therefore receives a serialized Promise result instead of the expected transport envelope.

## Decision

Keep the existing hidden, same-origin WebView because it owns the provider cookie session. Replace direct Promise-result decoding with a two-phase exchange:

1. Start the async `fetch` with ordinary `eval` and reset one Lakomics-owned response slot on the hidden window.
2. The JavaScript completion path stores the existing JSON transport envelope in that slot.
3. Rust polls the slot with synchronous `eval_with_callback` until a value appears or the existing 60-second request deadline expires.
4. Decode the completed envelope with the existing `decode_callback` function.

`CatalogTransport::busy` already rejects overlapping requests, so one response slot is sufficient. Each request resets the slot before starting, preventing stale reuse. No new dependency, transport abstraction, provider, setting, or background service is introduced.

## Preserved Behavior

- The origin remains exactly `https://k-hentai.org`.
- Navigation remains restricted to the provider origin.
- Request paths continue through `validate_path` and JSON string encoding.
- Fetch keeps `credentials: 'include'` and `cache: 'no-store'`.
- The overall timeout remains 60 seconds.
- Existing update retry, HTTP 429, checkpoint, page-limit, and database semantics remain unchanged.
- The hidden window remains invisible and excluded from the taskbar.

## Error Handling

Starting or polling JavaScript failures map to `CatalogTransportUnavailable`. If no completed value appears before the deadline, the request maps to `CatalogTransportTimedOut`. The existing decoder continues to distinguish invalid callback data, network failure, and rejected HTTP status.

The online-catalog screen will pass the caught command error through the existing `commandErrorMessage` helper, with the current generic text only as fallback. No new toast or error UI component is added.

## Tests

- A Rust unit test proves that the start script stores the asynchronous result instead of returning the Promise as the callback value.
- A Rust unit test proves that the synchronous poll script returns the completed envelope and clears or consumes it safely.
- Existing path-validation, decoder, timeout, overlap, and update tests remain green.
- A React test proves that a rejected manual update exposes the mapped command error rather than always showing the generic fallback.
- Final verification runs the focused transport/update and `OnlineCatalogBrowser` tests, then the production build only if TypeScript changes create compile risk.

## Out of Scope

- Replacing the WebView transport with a Rust HTTP client.
- Changing provider endpoints or catalog schema.
- Altering automatic-update scheduling.
- Adding progress reporting for individual remote pages.
- Refactoring unrelated online-catalog or manga UI.
