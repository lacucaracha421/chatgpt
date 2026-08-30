# VPS Capture Inbox Video Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounded X MP4 capture to the VPS and route the bundled extension through it while exactly supporting the completed PC inbound consumer contract.

**Architecture:** Keep one SQLite capture lifecycle and one media staging path. `POST /v1/captures` stores validated X media, while the existing routes and the PC consumer's `/pending`, `/download`, and `/acknowledge` routes are views or aliases over the same records. The extension keeps its current video resolver and only changes Collector eligibility and request serialization.

**Tech Stack:** Production Python 3.14.4 (confirmed from `~/lakomics-api/.venv/bin/python`), standard-library `unittest`, FastAPI/Pydantic, httpx streaming, boto3-compatible R2 client, JavaScript MV3 service worker, Node built-in test runner.

**Spec:** `docs/superpowers/specs/2026-08-31-vps-capture-video-design.md`

## Global Constraints

- Do not modify `app` or the completed `lqc` workstream.
- Do not pull, rebase, reset, stash, discard, commit, push, or overwrite existing local work.
- Do not contact real X or R2 from automated tests.
- Never stage or deploy `.env`, credentials, databases, virtual environments, logs, backups, or temporary files.
- Preserve existing image requests that omit `media_type` and existing `/v1/captures` and `/{id}/imported` routes.
- Treat commit `85027db`'s PC inbound consumer as the concrete compatibility target; its snake_case JSON fields are mandatory. CamelCase aliases may be additive but cannot replace them.
- Do not assume the local Python version represents production. Non-interactive SSH inspection on 2026-08-31 confirmed production `.venv` Python 3.14.4; keep server syntax and dependencies compatible with that runtime.
- Use the existing X highest-bitrate MP4 resolver unchanged.

---

### Task 1: Bounded X media staging and R2 upload

**Files:**
- Modify: `server/lakomics-api/capture_store.py`
- Create: `server/lakomics-api/tests/test_capture_api.py`

**Interfaces:**
- Produces: `fetch_media_to_r2(media_url: str, object_key: str, media_type: str) -> tuple[str, int]`
- Preserves: `fetch_image_to_r2(media_url: str, object_key: str) -> tuple[str, int]` as a compatibility wrapper if any caller still uses it.
- Uses: `r2._s3.put_object`, `r2._s3.delete_object`, and `r2.R2_BUCKET`.

- [ ] **Step 1: Create the standard-library server test harness and failing media tests**

Use `unittest`, `unittest.mock`, a fake streaming response/context manager, and a fake S3 object. Stub the `r2` module in `sys.modules` before importing server modules so tests need neither boto3 nor real credentials. Add focused tests whose assertions include:

```python
self.assertEqual(
    fetch_media_to_r2(video_url, "videos/inbox/capture-1/original", "video"),
    ("video/mp4", len(video_bytes)),
)
self.assertEqual(fake_s3.put_calls[0]["Key"], "videos/inbox/capture-1/original")
self.assertEqual(fake_s3.put_calls[0]["ContentType"], "video/mp4")
```

Cover `pbs.twimg.com` image success, `video.twimg.com` MP4 success, arbitrary host rejection before `httpx.stream`, a 302 response rejection without redirect following, video `text/html` rejection, declared oversize, streamed oversize, interrupted iteration, R2 upload failure, and temporary-file cleanup.

- [ ] **Step 2: Run the media tests and verify RED**

Run:

```powershell
python -m unittest server/lakomics-api/tests/test_capture_api.py -v
```

Expected: failures because `fetch_media_to_r2`, video policy, and bounded video handling do not exist.

- [ ] **Step 3: Implement the minimum shared staging function**

In `capture_store.py`, define policy constants in the owning module:

```python
MAX_CAPTURE_IMAGE_BYTES = 50 * 1024 * 1024
MAX_CAPTURE_VIDEO_BYTES = int(os.environ.get("MAX_CAPTURE_VIDEO_BYTES", 512 * 1024 * 1024))
MEDIA_POLICIES = {
    "image": ({"pbs.twimg.com"}, "image/*", MAX_CAPTURE_IMAGE_BYTES),
    "video": ({"video.twimg.com"}, "video/mp4", MAX_CAPTURE_VIDEO_BYTES),
}
HTTP_TIMEOUT = httpx.Timeout(connect=10.0, read=60.0, write=30.0, pool=10.0)
```

Validate the parsed URL and policy before network access. Call `httpx.stream(..., follow_redirects=False, timeout=HTTP_TIMEOUT)`, normalize `Content-Type`, enforce declared and observed sizes, write 256 KiB chunks to `tempfile.mkstemp`, upload the completed file handle, and unlink it in `finally`. Translate httpx and R2 failures to `CaptureDownloadError`; after ambiguous R2 failure, attempt deletion without masking the original error.

- [ ] **Step 4: Run the media tests and verify GREEN**

Run the same `unittest` command. Expected: all Task 1 tests pass and no real network/R2 access occurs.

### Task 2: Unified capture schema and completed consumer routes

**Files:**
- Modify: `server/lakomics-api/app.py`
- Modify: `server/lakomics-api/r2.py`
- Extend: `server/lakomics-api/tests/test_capture_api.py`

**Interfaces:**
- `CaptureCreate.media_type: Literal["image", "video"] = "image"`
- `GET /v1/captures/pending -> {"captures": list[dict]}`
- `GET /v1/captures/{capture_id}/download -> {method, download_url, required_headers}`; camelCase aliases may be additive.
- `POST /v1/captures/{capture_id}/acknowledge` requires `imported_at`; `importedAt` may be accepted as an alias.
- `r2.presign_get(object_key: str, expires_in: int = 600) -> str`

- [ ] **Step 1: Add failing API tests**

Build a temporary SQLite database per test, patch `app.DB_PATH`, `app.API_TOKEN`, `app.fetch_media_to_r2`, and `app.presign_get`/the imported R2 helper, then exercise FastAPI with `TestClient`. Assert:

```python
legacy = client.post("/v1/captures", headers=auth, json={
    "source_url": source_url,
    "media_url": image_url,
    "classification_id": "game",
})
self.assertEqual(legacy.status_code, 200)
self.assertEqual(legacy.json()["capture"]["media_type"], "image")

pending = client.get("/v1/captures/pending", headers=auth).json()["captures"][0]
self.assertEqual(pending["kind"], "video")
self.assertEqual(pending["object_key"], "videos/inbox/capture-1/original")
```

Also test explicit image, video key namespace, pending-only filtering, mandatory snake_case response fields, optional camelCase aliases if emitted, signed GET ticket shape, snake_case acknowledgement input, optional camelCase acknowledgement input if supported, shared imported state, acknowledgement retry preserving the first `imported_at`, duplicate video idempotency, failed storage producing no row, and a pre-existing captures table migrating existing rows to `media_type = 'image'`.

- [ ] **Step 2: Run the API tests and verify RED**

Run:

```powershell
python -m unittest server/lakomics-api/tests/test_capture_api.py -v
```

Expected: the new schema fields and PC consumer routes return validation errors or 404.

- [ ] **Step 3: Implement additive SQLite migration and unified creation**

Add `media_type TEXT NOT NULL DEFAULT 'image' CHECK (media_type IN ('image', 'video'))` to new table creation. After creation, inspect `PRAGMA table_info(captures)` and run this only when the column is absent:

```python
db.execute("ALTER TABLE captures ADD COLUMN media_type TEXT NOT NULL DEFAULT 'image'")
```

Use `Literal` for request validation, select the UUID-derived namespace from `media_type`, call `fetch_media_to_r2`, persist `media_type`, and include it in created and duplicate responses. Do not add `media_type` to the existing unique key.

- [ ] **Step 4: Implement the PC consumer serializers and shared transition**

Create one small `pending_capture_payload(row)` function that maps `published_at` to mandatory `source_published_at`, derives `creator_handle` from the validated X source URL, and may add camelCase aliases without removing snake_case. Create one `mark_capture_imported_state(capture_id, imported_at)` database function used by both POST routes. Its update preserves the first timestamp with `imported_at = COALESCE(imported_at, ?)` so repeated acknowledgements are successful and stable. Validate supplied timestamps with Pydantic's datetime type and serialize consistently.

- [ ] **Step 5: Implement signed download tickets**

Add `presign_get` in `r2.py` with `get_object`, a 600-second expiry, and no credentials in the response. Look up the capture by ID before signing and return 404 for an unknown capture. Emit mandatory `download_url` and `required_headers`; camelCase aliases may be additive.

- [ ] **Step 6: Run the complete server tests and verify GREEN**

Run the full server test file. Expected: all capture creation, failure, migration, consumer route, and lifecycle tests pass.

### Task 3: Route X video and animated GIF through Collector

**Files:**
- Modify: `extension/tests/background.test.mjs`
- Modify: `extension/src/background.js`
- Generate: `extension/src/background-worker.js`

**Interfaces:**
- Collector-supported extension types: `image`, `video`, `animated_gif`.
- Capture request `media_type`: `image` for image, `video` for video and animated GIF.
- Existing failure result flows into `browserDownload` with the Collector failure code.

- [ ] **Step 1: Replace the image-only regression with failing Collector video tests**

Keep the existing image body assertion and add `media_type: "image"`. Replace the test that expects video to call `/v1/ingestions` with tests asserting:

```javascript
assert.equal(harness.fetchCalls.at(-1).url, "http://100.76.119.29:32146/v1/captures");
assert.equal(JSON.parse(harness.fetchCalls.at(-1).options.body).media_type, "video");
assert.equal(harness.downloadCalls.length, 0);
```

Cover an already-resolved MP4, an unresolved video whose syndication response contains low/high MP4 variants, animated GIF normalization, Collector success avoiding PC ingestion, video Collector network failure downloading MP4 plus sidecar, unchanged image fallback, token secrecy, URL validation, and worker synchronization.

- [ ] **Step 2: Run only the background tests and verify RED**

Run:

```powershell
node --test extension/tests/background.test.mjs
```

Expected: video remains routed to the PC path and image request lacks `media_type`.

- [ ] **Step 3: Implement the minimal extension change**

Change the supported set and request body only:

```javascript
const COLLECTOR_SUPPORTED_MEDIA_TYPES = new Set(["image", "video", "animated_gif"]);
// ...
media_type: payload.mediaType === "image" ? "image" : "video",
```

Do not change `prepareMediaPayload`, `resolveXVideoPayload`, or `bestMp4Variant` unless a failing test proves an existing defect.

- [ ] **Step 4: Rebuild the classic worker and verify GREEN**

Run:

```powershell
python scripts/rebuild-background-worker.py
node --test extension/tests/background.test.mjs
```

Expected: background tests pass and the generated worker matches its sources.

### Task 4: Relevant documentation and complete verification

**Files:**
- Modify: `extension/README.md`
- Modify: `extension/TABLET_INSTALL.md`
- Modify only if already canonical and directly relevant: `extension/PATCH_NOTES_15.30.txt`

**Interfaces:**
- Documentation distinguishes outbound `cloud_sync_queue` from inbound Capture Inbox.
- Documentation states animated GIF is transported as MP4 video and pending persists until PC acknowledgement.

- [ ] **Step 1: Update only stale image-only Capture Inbox wording**

Replace claims that video stays on the PC path with the final extension → VPS → R2 → pending → PC import → acknowledge flow. State that the PC importer is separately completed and that no R2 credentials are stored on the PC.

- [ ] **Step 2: Run targeted server validation**

Run:

```powershell
python -m unittest discover -s server/lakomics-api/tests -v
python -m py_compile server/lakomics-api/app.py server/lakomics-api/capture_store.py server/lakomics-api/r2.py
```

With fake environment values sufficient for import, initialize `TestClient`, fetch `/openapi.json`, and verify `CaptureCreate.media_type` is optional with default `image` and all three PC routes are present.

- [ ] **Step 3: Run the complete extension suite**

Run:

```powershell
npm test --prefix extension
```

Expected: all extension tests pass, with the total at least the previous 145.

- [ ] **Step 4: Inspect generated output and repository hygiene**

Run:

```powershell
git diff --check
git status --short
git diff --stat
git diff -- server/lakomics-api extension docs/superpowers/specs/2026-08-31-vps-capture-video-design.md docs/superpowers/plans/2026-08-31-vps-capture-video.md
```

Confirm no `.env`, secrets, DBs, logs, temp files, virtual environments,
backup files, zip artifacts, or unrelated app/lqc changes were introduced.

- [ ] **Step 5: Check deployment access without exposing credentials**

Use non-interactive SSH only. If available, inspect the service start method,
back up only the currently deployed source files, copy only changed server
source, preserve runtime state, restart only Lakomics API, and verify health
and OpenAPI. If SSH requires a password or safety cannot be established, stop
without prompting for a password and provide exact manual commands in the
final report.
