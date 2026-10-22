# PC ↔ tablet file exchange (보내기/받기) — design

Status: implemented and accepted 2026-09-25 (server, PC, Android 0.8.10); the long-poll `?wait=25` was not built — clients poll `/v1/sync/status` instead. See `USER-REQ-20260924` in the backlog. The text below is the original proposal.

## User decisions (2026-09-24)

1. Built into Lakomics, not a separate program, but **separate from the Library**:
   - its own server module and its own R2 prefix;
   - its own 보내기/받기 UI on the PC (Tauri) and Android.
2. Both directions: PC → tablet and tablet → PC.
3. Received files go to the device's **Downloads** folder, never into the Library.
4. One-off transfers: the server deletes a file soon after the receiver has it, and undelivered files expire after a short time.
5. The PC app will gain a system tray / close-to-tray mode, so it can receive while its window is hidden.
6. Android: a "Share to Lakomics" share target (`ACTION_SEND` / `ACTION_SEND_MULTIPLE`) is wanted.

## Goals and non-goals

**Goals**
- Send any file type (one file or several) from one of the user's devices to another in a few taps or clicks.
- The receiver notices quickly without heavy polling. Target: within about 5 s while the receiver is open or in the tray.
- Received files land in Downloads under their original name, with collisions handled safely.
- Nothing lasts on the server: delete after acknowledgement, and expire otherwise.
- Resumable downloads; bounded, retry-safe uploads.

**Non-goals (v1)**
- No Library ingestion, classification, thumbnails or deduplication. A received image is just a file. Importing it is a separate, existing user action.
- No sharing with other people, no public links, no web download page.
- No background receive on Android while the app is closed. This would need push (FCM) or a persistent service; see "Delivery".
- No end-to-end encryption in v1 (see "Security"). No folder sync and no clipboard sync.
- No peer-to-peer or LAN transport. Everything goes through the VPS and R2, which already works over Tailscale and mobile data.

## Existing building blocks (evidence)

**Server (`server/lakomics-api/`)**
- **Auth:**
  - `api_auth.client_guard` (`api_auth.py:90`) accepts any unrevoked `api_clients` row or the legacy shared token, which maps to principal `legacy-shared-token`.
  - `publisher_guard` (`:106`) accepts publisher rows only.
  - Tokens are provisioned with the server-local CLI only (`provision_token`, `:120`).
  - The PC and the tablet may currently share the legacy token, so **the principal alone cannot tell the devices apart.**
- **R2:**
  - `presign_put(object_key, content_type, expires_in=600)` (`r2.py:39`) signs `ContentType`.
  - `presign_get(object_key, expires_in=600)` (`r2.py:52`).
  - The bucket is private (ADR-0033). Clients never hold R2 credentials; they only get signed URLs.
- **Upload pattern:**
  - `POST /v1/uploads/presign` (`app.py:383`) is a prefix allowlist plus a `..` check, and returns `{method, object_key, upload_url, expires_in, required_headers}`. Clients upload bytes straight to R2, so **the VPS never proxies file bodies**. This matters because VPS disk was at 82 % (`docs/research/server-review-2026-09-24.md`).
  - It uses `require_auth` (the shared admin token only), so the exchange must not reuse it.
- **Capture inbox (the closest analogue):**
  - create (`app.py:1141`);
  - pending list (`:1327`);
  - download ticket (`:1365`, `presign_get(..., 600)`);
  - acknowledge (`:1469`) marks the capture imported.
  - It is a durable pending → acknowledged state machine polled by the PC.
- **Conditional reads:** `conditional.json_response(payload, if_none_match)` (`conditional.py:45`) returns an ETag and 304. `GET /v1/sync/status` (`sync_status.py`) is the most-polled document and is already 304-friendly.
- **Idempotency:** bookmark receipts are keyed by `operation_id` (`catalog_bookmarks.py:61-72`), and Notes carries an `operationId` (`notes.py`).
- **Background maintenance:**
  - `prune_catalog_artifacts.AutoPruner` (`:397`) is one daemon thread per process. It runs after startup, then every `PRUNE_INTERVAL_SECONDS` (`:54`, 1 h), and on `trigger()`.
  - It is wired with `lifecycle(app).on_startup/on_shutdown` (`mobile_catalog.py:192-195`).
  - `prune_bookmarks.py` is the CLI-only alternative for authority history.
- **Module pattern:** `register_notes(app, get_db, require_auth)` (`notes.py`) and `register_sync_status` are wired at the end of `app.py` (`app.py:3175-3210`).

**Android (`android/`)**
- **HTTP:**
  - `CloudClient.authenticatedReply` (`CloudClient.java:31-46`) handles Bearer auth, `If-None-Match`, JSON bodies up to 64 KiB (`:37`), and `stripKeys` removes `object_key` from every response (`:55`).
  - Every API path must pass the allowlist in `NetworkPolicy.api` (`NetworkPolicy.java:24-80`).
- **Downloads:**
  - `CloudClient.download` (`:70-85`) is HTTPS-only with a length check, and `MediaTransfer.copy/verifyTicket` (`MediaTransfer.java:20-47`) checks length and SHA-256.
  - It has a **180 s total deadline** (`MediaTransfer.java:9`), and `CloudClient.copy` has 90 s (`:69`). Both suit media but are too short for multi-GB files, so the exchange needs an idle timeout instead of a total deadline.
  - There is no streaming upload to a presigned URL yet.
- **Saving to public storage:** `TemporaryImageActivity.publish` (`TemporaryImageActivity.java:70-89`) already uses the MediaStore `IS_PENDING=1` → write → `IS_PENDING=0` pattern, with delete on failure, into `Pictures/Lakomics/임시보관/` (`:23`). This is the model for the Downloads writer.
- **Manifest:**
  - Only `INTERNET` is requested; `minSdk 26`, `targetSdk 35`.
  - There is no notification permission, no foreground service and no `SEND` intent filter.
  - The test tablet is a Galaxy Tab S11 (Android 16).
- **Polling:**
  - `ForegroundSchedule` repeats at 5 s and backs off `{5,15,30,60}` s while idle (`ForegroundSchedule.java:38,73,88`).
  - It runs only while the activity is resumed; `onPause` stops it (`MainActivity.java:162-166`).
  - `SyncStatusPass` shares one `/v1/sync/status` read per pass (`SyncStatusPass.java`).
- **Bridge:** `MainActivity` handles JS `request(id, operation, payload)` ops in a `switch` (`MainActivity.java:89-148`).

**PC (`_tools/app/src-tauri/`)**
- **HTTP:** `CloudClient` (`cloud/client.rs`) uses blocking `ureq` with `max_redirects(0)` and per-call timeouts.
  - `download_capture_media` (`:1924`) streams a ticket URL to a file with a size cap.
  - `upload_asset` (`:1815`) streams a presigned PUT.
- **Credential and endpoint:**
  - The token is in the OS store through the credential broker (`library/credential.rs:351`, `read_cloud_api_token_os`).
  - The endpoint is `library_settings.cloud_api_base_url` in the **open library's** DB (`cloud/queue.rs:7`).
- **Polling:** it is driven from the WebView, e.g. `useMobilePublications` with `setInterval(10 s)` (`src/app/useMobilePublications.ts:9`), then native lanes (`cloud/auto_publication.rs:14-40`). Hidden-window WebView timers may be throttled, so **tray receive must be a native thread**. `extension_api::start` in `setup` (`lib.rs:93`) is the precedent.
- **Tray and closing:**
  - The worktree already adds the `tray-icon` feature (`Cargo.toml:21`, uncommitted).
  - The window's `Destroyed` handler exits the app (`lib.rs:101-115`). Close-to-tray changes that.
- **Available crates:** `tauri-plugin-dialog` for file pickers (`Cargo.toml:33`); there is no notification plugin. Tauri 2's `PathResolver::download_dir()` resolves Downloads with no new dependency: `FOLDERID_Downloads` on Windows, `XDG_DOWNLOAD_DIR` on Linux.

## User flows

**PC → tablet**
1. Open 보내기/받기 in the PC shell, a separate utility view outside the Library navigation. Click **보내기**, or drag files onto the panel.
2. The target defaults to the only other registered device, e.g. "Galaxy Tab S11"; a dropdown appears if there are several.
3. Each file row shows upload progress, then "대기 중 (태블릿이 받으면 삭제됨)", then "전달됨".
4. On the tablet:
   - if Lakomics is open, a badge on the 받기 entry and a toast "PC에서 파일 2개" appear within about 5 s;
   - if it is closed, they appear on next open;
   - downloads start automatically (a toggle allows manual 받기), then show "다운로드 폴더에 저장됨"; tap to open.

**Tablet → PC**
1. From any app, tap Share → **Lakomics**. Or use 보내기 inside Lakomics (system document picker, `ACTION_OPEN_DOCUMENT`, multi-select, no permission).
2. A small sheet shows the target PC, file count and total size. Tap 보내기, and upload progress follows.
3. On the PC, even while hidden in the tray:
   - the native receiver downloads into Downloads;
   - the tray icon or tooltip shows "받은 파일 N"; an OS toast is optional and needs a plugin (open question);
   - the panel lists received files with 열기 / 폴더에서 보기.

**Errors (both sides)**
- Every row has a state and a retry. Messages:
  - "서버에 연결할 수 없음 — 자동 재시도"
  - "파일이 너무 큼 (최대 X)"
  - "보관 한도 초과"
  - "만료됨 (받지 않음)"
  - "저장 공간 부족"
  - "받는 기기가 등록 해제됨"
- The sender sees expiry: its outbox list shows the server state.
- Cancel: the sender can withdraw a transfer that has not been acknowledged, and the server deletes the object.

## Server API (new module `file_exchange.py`, prefix `/v1/exchange`)

All routes use `require_client` (`client_guard`), because both the PC token and the tablet token pass it. Publisher is not required: this is not library authority. JSON bodies are bounded. The module is wired like `register_notes`.

**Devices** (single user, several devices)
- `PUT /v1/exchange/devices/{deviceId}` with body `{name, kind: "pc"|"android"}` registers or renames a device and updates `last_seen_at`.
  - `deviceId` is a client-generated UUID, stored locally: Android SharedPreferences; PC the app config dir, *not* the library DB, because the library can be switched.
  - The row records the calling principal. If that principal is a real `api_clients` row, later requests acting as this device must come from the same principal; a mismatch returns 403. The legacy shared token cannot provide this separation (see "Security").
- `GET /v1/exchange/devices` → `{devices:[{deviceId,name,kind,lastSeenAt,self}]}`. The caller identifies itself with the `X-Lakomics-Device` header.
- `DELETE /v1/exchange/devices/{deviceId}` unregisters a device. Its pending inbox is deleted.

**Transfers.** One transfer is one file. A batch is several transfers that share a `batchId`, which is only used for UI grouping.
- `POST /v1/exchange/transfers`:
  - Request body: `{transferId (client UUID), batchId, toDevice, fileName, sizeBytes, sha256, contentTypeHint}`.
  - The server validates:
    - the size limit;
    - the outstanding quota;
    - that the target exists and is not the sender;
    - the name (see "Security").
  - It inserts `state=uploading` and returns `{transferId, upload:{method:"PUT", url, expiresIn:900, requiredHeaders:{"Content-Type":"application/octet-stream"}}, expiresAt}`.
  - Idempotent on `transferId`:
    - the same body returns the same row with a *fresh* upload URL while `uploading`;
    - a different body returns 409 `transferIdReused`.
- `POST /v1/exchange/transfers/{id}/complete`:
  - The server issues `HEAD` for the object. The size must equal `sizeBytes`; otherwise it deletes the object, sets `state=failed`, and returns 409 `sizeMismatch`.
  - Then it sets `state=ready`, bumps the exchange revision, and returns the row.
  - Idempotent: calling it again when the transfer is already `ready`, `delivered` or `deleted` returns the current row.
- `GET /v1/exchange/inbox` (`X-Lakomics-Device` required) returns `{revision, items:[{transferId,batchId,fromDevice,fromName,fileName,sizeBytes,sha256,createdAt,expiresAt}]}` for `ready` rows addressed to the caller, oldest first, bounded to 100. It goes through `conditional.json_response`, so an unchanged inbox returns 304.
  - Optional `?wait=25` long-poll (see "Delivery"). It returns as soon as the device's inbox revision differs from the `If-None-Match` value, or returns 304 after `wait` seconds.
- `POST /v1/exchange/transfers/{id}/ticket` (receiver only) returns `{url, expiresIn:600, sizeBytes, sha256}`, where `url` is `presign_get` with `ResponseContentDisposition=attachment`. A fresh ticket is issued per attempt and per resume.
- `POST /v1/exchange/transfers/{id}/ack` (receiver only), body `{sha256}`:
  - The digest must match.
  - The server sets `state=delivered`, deletes the R2 object in the request (best effort; the sweeper retries), then sets `state=deleted` and records `deliveredAt`.
  - Idempotent: once delivered or deleted it returns 200 with the row.
- `GET /v1/exchange/outbox` (sender) lists the caller's transfers from the last 7 days with their state, so the sender sees 대기/전달됨/만료됨. ETag/304.
- `DELETE /v1/exchange/transfers/{id}` (sender or receiver) withdraws or declines a transfer. The object is deleted and the state becomes `cancelled`.

**Change notification without extra polls**
- Add one additive field to `GET /v1/sync/status`: `"exchange":{"revision":<int>}`.
  - It is a single server-wide counter, bumped on every transfer state change.
  - It is not device-specific, so the status ETag stays shared and cacheable.
  - Old clients ignore the unknown field.
- A client fetches `/v1/exchange/inbox` only when that revision changed. **This costs zero additional requests in steady state.**
- ADR-0037 describes `sync/status` as authority discovery, so extending it is a small contract decision. The alternative, a separate `/v1/exchange/status` poll, costs one extra 304 per tick.

## Storage layout, limits, lifecycle

**R2 key**
- `exchange/<toDeviceId>/<transferId>`, with `transferId` a UUID.
- **The filename never enters the key.** The object is stored as `application/octet-stream` so a leaked URL never renders inline.
- R2 bucket lifecycle rule on prefix `exchange/`: delete after 2 days. This is an operator step and a safety net if the sweeper stops.

**SQLite (control DB)**
- `exchange_devices(id PK, name, kind, principal, created_at, last_seen_at, revoked_at)`
- `exchange_transfers(id PK, batch_id, from_device, to_device, file_name, size_bytes, sha256, content_type_hint, state, object_key, created_at, ready_at, expires_at, delivered_at, deleted_at, failure)`, with an index on `(to_device, state, created_at)`.
- `exchange_state(singleton, revision)`.
- Rows are kept 7 days after they reach a terminal state, for the outbox view, then pruned. **Filenames are the only personal data kept, and only for those 7 days.**

**Proposed limits (open question 1)**

| Limit | Proposal | Reason |
| --- | --- | --- |
| Max file | 2 GiB | One presigned PUT (R2 single-PUT ceiling is about 5 GiB); multipart deferred |
| Outstanding total (uploading + ready) | 10 GiB | Cost/abuse bound; R2 egress is free, storage is negligible for hours |
| Files per batch | 100 | UI and inbox page bound |
| Upload URL TTL | 15 min, re-issuable | A slow 2 GiB upload over mobile data |
| Download ticket TTL | 10 min, re-issuable | Matches captures |
| Undelivered expiry | 24 h after `ready` (`uploading` rows: 2 h) | "Short time" decision |
| Content types | any; the hint is only for the receiver's MIME guess | User decision |

**States:** `uploading → ready → delivered → deleted`. Side exits: `failed`, `expired` and `cancelled` all end with the object deleted.

**Sweeper:** an `ExchangeSweeper` thread modelled on `AutoPruner`, running at startup and every 10 min, plus `trigger()` after ack or cancel. It:
- expires `ready` rows past `expires_at` and `uploading` rows older than 2 h;
- deletes the objects of every `delivered`, `expired`, `cancelled` or `failed` row whose object is not yet deleted;
- deletes orphaned `exchange/` objects with no live row (bounded list per run);
- prunes terminal rows older than 7 days.

It never touches any other prefix, and it has an environment switch like `auto_prune_enabled`.

## Delivery mechanism and battery

**Android (foreground only)**
- The existing `ForegroundSchedule` pass already reads `/v1/sync/status`, at 5 s backing off to 60 s. With the `exchange.revision` field, noticing a new transfer costs nothing extra.
- The worst-case delay equals the current backoff, up to 60 s idle. Two things shorten it:
  - opening the 받기 screen, or any resume (`lakomics-resume`), calls `wake()`, which returns the interval to 5 s;
  - while the 받기 screen is visible, the client uses `?wait=25` long-poll: about 2 requests/min, near-instant.
- When the activity pauses, nothing runs. **No new wakeups, services or permissions**, so battery use is unchanged.
- Rejected for v1:
  - FCM push needs Google Play services, Firebase config and a Gradle-less integration (`android/build.py` uses plain `javac`), and it adds a third-party dependency.
  - A persistent foreground service costs battery and needs notification permissions.

**PC (window hidden in the tray)**
- A native `exchange` receiver thread starts in `setup` next to `extension_api::start` and is independent of the WebView.
- It long-polls `/v1/exchange/inbox?wait=25` with ETag. On network errors it backs off 5 → 15 → 60 s, with jitter.
- It pauses when no library or credential is configured, and when the machine is offline.
- It emits `exchange://changed` events to the UI when the window is visible.

**Server cost of long-poll:** each waiting request holds one worker thread for up to 25 s (sync FastAPI routes run in the threadpool). With one PC and one tablet that is at most two threads. The wait loop checks an in-process `threading.Condition` notified on revision bumps, plus a 1 s DB re-check fallback. **Assumption:** a single API process. This matches the current deployment, but has to be verified before rollout.

## Android specifics

**Save path**
- API 29+: `MediaStore.Downloads.EXTERNAL_CONTENT_URI` with:
  - `DISPLAY_NAME=<sanitised name>`;
  - `RELATIVE_PATH="Download/"` (or `Download/Lakomics/`, open question 4);
  - `MIME_TYPE` from `MimeTypeMap` by extension, falling back to the hint, then `application/octet-stream`;
  - `IS_PENDING=1`, stream, then `IS_PENDING=0`, deleting on failure. This is the `TemporaryImageActivity.publish` pattern.
- **No new permission is needed** for the app's own inserts.
- MediaStore resolves name collisions itself by appending ` (1)`. The client reads back the final `DISPLAY_NAME` to show it.

**API 26–28:** writing public Downloads there would need `WRITE_EXTERNAL_STORAGE`. Proposal: hide 받기 below API 29 (the tablet is API 36), rather than adding a legacy permission.

**Resume:** download into app cache as `exchange/<transferId>.part` with a new ticket and a `Range: bytes=<n>-` header. The server's presigned R2 GET supports Range; this has to be verified. Verify length and SHA-256 with `MediaTransfer.verifyTicket`, copy into MediaStore, then ack.
- The copy is a second write. It keeps an interrupted transfer from ever appearing in Downloads as a partial file.
- **Assumption:** the extra temporary space (up to the file size) is acceptable.

**Transfer engine:** a new `ExchangeTransfer` class with:
- an idle timeout (for example, no bytes for 30 s) instead of `MediaTransfer.DEADLINE_NANOS`;
- `setFixedLengthStreamingMode(long)` for the presigned PUT, streaming from `ContentResolver.openInputStream(uri)`;
- a SHA-256 computed in a pre-pass. This reads the file twice; an acceptable trade-off, because it has to be known before `POST /transfers`.

**Share target:** a new `ExchangeShareActivity`, exported, with `SEND`/`SEND_MULTIPLE` filters for `*/*`. It shows a compact sheet (target, count, size, 보내기).
- The upload runs inside that activity with visible progress. URI read grants from the sharing app are only reliable while the receiving activity lives; this has to be verified on the device.
- If the user leaves, the activity continues until finished. If the process is killed, the transfer stays `uploading` and the next attempt reuses `transferId`, restarting the PUT.
- A later option is Android 14+ user-initiated data transfer jobs. They need the `RUN_USER_INITIATED_JOBS` normal permission and a notification, so they are deferred.

**Bridge and allowlist**
- New ops: `exchangeDevices`, `exchangeSend` (document-picker URIs), `exchangeInbox`, `exchangeReceive`, `exchangeOpen` (`ACTION_VIEW` on the MediaStore URI), `exchangeCancel`.
- Add the exact exchange paths to `NetworkPolicy.api`.
- `stripKeys` already removes any `object_key`, and the API never returns one anyway.

**Received ledger:** a small `SharedPreferences` or `ReplicaDb` table of acknowledged `transferId`s (7 days). A lost ack response then never saves the same file twice.

## PC specifics

**Save path**
- Resolve Downloads with `app.path().download_dir()`: `FOLDERID_Downloads` on Windows, `XDG_DOWNLOAD_DIR` or `~/Downloads` on Linux. If the folder is missing, fall back to asking once via the dialog plugin, and remember the choice in the app config (not the library).
- Write steps:
  1. Stream to `<Downloads>/.<sanitised>.<transferId>.lakomics-part`; resume with Range.
  2. Verify size and SHA-256.
  3. Reserve the final name with `OpenOptions::create_new`, trying `name.ext`, `name (1).ext`, … up to 999.
  4. `rename` the part file over the reservation.
  5. `fsync` best effort, then ack.
- This never overwrites an existing user file.
- **Windows:** write a `Zone.Identifier` alternate data stream (`ZoneId=3`) on the final file, so SmartScreen and Office treat it as downloaded content. Low effort, and a real malware mitigation.
- **Linux:** no execute bit is set (default `0644`, from the umask).

**Tray:** the native receiver keeps running while the window is hidden. This depends on close-to-tray changing the `Destroyed` → `exit(0)` path in `lib.rs:101-115`, which is separate in-flight work.
- Unseen receipts appear as a tray tooltip or menu entry "받은 파일 N개 — 폴더 열기".
- A native OS toast needs `tauri-plugin-notification`, a new dependency (open question 5).

**Endpoint and token:** the same Cloud API token and endpoint as the rest of the cloud client. The endpoint comes from the open library's settings, so **the exchange is unavailable while no library is open.** This is acceptable for v1; a device-level endpoint is a later option.

**Send:** file dialog (`tauri-plugin-dialog`) or drop onto the panel. Uploads stream with `ureq` and have their own timeout profile (a long `timeout_send_body`, like `UPLOAD_BODY_TIMEOUT`).

## Security

- **Auth scope:**
  - Only client-authenticated devices can use the exchange.
  - The receiver-only routes (`ticket`, `ack`) check that `X-Lakomics-Device` equals `to_device`; withdraw checks the sender or the receiver.
  - The publisher role grants nothing extra.
  - **Limit:** with the legacy shared token, the device header is self-declared. Any holder of the shared token can read any device's inbox. For a single user this is already true of the whole library. Recommended hardening: provision one `client` token per device with the existing CLI and bind devices to principals (open question 6).
- **No public URLs:**
  - R2 is reachable only through presigned URLs that live 15 min (PUT) or 10 min (GET).
  - Objects are `application/octet-stream` with `Content-Disposition: attachment`.
  - URLs never appear in logs or `PerfLog`.
- **Filename handling:**
  - Server:
    - NFC-normalise;
    - strip C0/C1 control characters and bidi overrides (U+202A–U+202E, U+2066–U+2069), which prevents `gpj.exe` spoofing;
    - take the basename only (drop anything up to the last `/` or `\`);
    - reject empty, `.` and `..`;
    - cap at 255 UTF-8 bytes, keeping the extension.
  - Receiver, again per OS:
    - Windows: replace `<>:"/\|?*`, trim trailing dots and spaces, prefix the reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`) with `_`;
    - Linux: replace `/` and NUL.
  - Never join a server-supplied string as a path: only the sanitised leaf goes under the resolved Downloads directory, and the parent is checked after joining.
- **Integrity:** the SHA-256 is declared by the sender and verified by the receiver before saving and before ack. The server verifies only the size, so it never reads the bodies.
- **Zip bombs** are irrelevant: nothing is unpacked or parsed, and no thumbnails are made.
- **Malware:** files are stored and delivered as opaque bytes and never opened automatically. The PC applies Mark-of-the-Web; Android relies on the platform. Opening a file is always an explicit user tap.
- **No E2EE in v1:** R2 sees plaintext, as with Library media today (ADR-0033). An optional client-side AES-GCM wrap, like Notes, is possible later if the user wants the server blind.

## Idempotency and retries

- **Sender:** `transferId` is created before the first request and persisted with the pending send, so every step is retry-safe:
  - `POST /transfers` is idempotent;
  - a PUT can be repeated with a fresh URL;
  - `complete` and `withdraw` are idempotent.
- **Receiver:**
  - the local ledger is checked before saving;
  - `ack` is idempotent;
  - a `ticket` 404 or 410 for a delivered, expired or cancelled transfer is terminal and removes the row from the UI.
- **Backoff:** network and 5xx failures retry at 2 s, 10 s, 30 s, then every 60 s. 4xx is terminal with a message. 413 and 409 `quotaExceeded` are not retried until the user acts.

## Large files and resume

- Downloads resume with Range on both clients (above).
- Uploads in v1 restart the whole PUT on failure. For files up to 2 GiB on Tailscale/Wi-Fi this is acceptable.
- **v2:** R2 multipart upload, with parts of 32 MiB each presigned (`POST /transfers/{id}/parts?n=`), `complete` taking the part ETags, and abort on expiry. This lifts the limit above 5 GiB and makes uploads resumable. It is built only if needed (open question 1).

## Testing plan

**Server unit tests** (`tests/test_file_exchange.py`, stub R2 like `test_capture_api_stub.py`):
- registration and principal binding;
- validation: limits, quota, self-target, filenames (traversal, control characters, bidi, reserved names, length);
- idempotency of `transfers`, `complete`, `ack` and `withdraw`; `transferId` reuse → 409;
- `complete` size mismatch deletes the object;
- receiver-only checks;
- inbox ETag/304 and the long-poll wake and timeout;
- the `sync/status` `exchange.revision` field and ETag stability;
- the sweeper: expiry, orphan deletion, 7-day pruning, prefix confinement, the disable switch.

**Android JVM tests** (the `build.py` checks):
- a filename sanitiser shared with the PC through golden cases;
- the ledger;
- the `ExchangeTransfer` idle timeout and Range-resume bookkeeping;
- the `NetworkPolicy` allowlist accepts only exact exchange paths.

**Mobile client (`npm run mobile:test`):** the 보내기/받기 screen states and the badge from `exchange.revision`.

**PC Rust tests:**
- name reservation and collision numbering;
- part-file rename, never overwriting;
- the sanitiser golden cases;
- resume and digest mismatch;
- receiver backoff;
- on Windows, the Zone.Identifier write (Windows only).

**Native and device acceptance** (separate evidence levels):
- tablet: a share-sheet send of 1 file and of 20 mixed files; a large (≥1 GiB) video;
- receive into Downloads with a name collision; visible in the Files app; opens;
- kill the app mid-download, then resume;
- airplane mode mid-upload, then retry;
- PC in the tray receives within 5 s; Windows and Linux Downloads paths; SmartScreen prompt on a received `.exe`;
- the server object is gone after ack; an unreceived file is gone after 24 h;
- battery: no new wakeups while the app is backgrounded (`dumpsys` alarms/jobs unchanged).

## Rollout stages

1. **Server module:** tables, routes, sweeper and the `sync/status` field, deployed behind `LAKOMICS_EXCHANGE_ENABLED`. The R2 lifecycle rule is set by the operator. Needs deployment authorization.
2. **PC send and receive, window open:** panel, native receiver thread, Downloads writer.
3. **Android receive and in-app send:** screen, MediaStore writer, document picker.
4. **Android share target:** `ExchangeShareActivity`.
5. **PC tray receive:** after close-to-tray lands; optional notifications.
6. **Optional later:** multipart uploads, per-device tokens, E2EE, a device-level PC endpoint.

## Open questions for the user

1. **Size limits:** max file size 2 GiB and outstanding total 10 GiB? Are files above about 5 GiB needed? That requires multipart (v2).
2. **Expiry:** delete undelivered files after 24 h? Keep the sender's outbox history for 7 days?
3. **Auto-receive:** save automatically on arrival, or show the item and wait for a tap on 받기? The proposal is automatic on the PC and on the tablet while the app is open.
4. **Folder:** save directly into `Download/`, or into `Download/Lakomics/`?
5. **PC notifications:** is a tray tooltip/badge enough, or are OS toast notifications wanted? Toasts need a new dependency (`tauri-plugin-notification`).
6. **Device tokens:** keep the shared token (simple, but any token holder can read any inbox), or provision a separate client token per device (the server CLI; each device re-enters it once)?
7. **Status field:** may `/v1/sync/status` carry the small `exchange.revision` field (zero extra polling), or should the exchange have its own status poll?
8. **Android background:** is "arrives when you open Lakomics" acceptable on the tablet, or is background receive (push or a service, with a battery cost) wanted later?

## User decisions (2026-09-24)

All recommendations accepted:
1. Max 2 GiB per file, 10 GiB total on the server.
2. Undelivered files are deleted after 24 h; the sent-history record is kept 7 days.
3. Arriving files are saved automatically (no "receive" tap).
4. Save folder: `Download/Lakomics/` on both devices.
5. PC arrival notice: tray indicator only (OS toast notifications later; they need a new plugin).
6. Per-device tokens for exchange (the shared legacy token must not see another device's inbox).
7. Arrival is noticed through one extra counter in `/v1/sync/status` (no extra polling).
8. Tablet receives when the app is open; no background receive for now.
