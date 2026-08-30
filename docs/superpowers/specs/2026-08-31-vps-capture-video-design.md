# VPS Capture Inbox Video Support Design

## Goal

Extend the existing VPS Capture Inbox and bundled X Collector extension to
accept X MP4 video while implementing the already-completed PC inbound
consumer contract exactly. The PC consumer in the completed `lqc` workstream
is the source of truth for inbound list, download, and acknowledgement routes.

## Scope and authority

- Modify `server/lakomics-api`, `extension`, and directly relevant tests and
  documentation only.
- Do not modify or reimplement the completed PC inbound consumer in `lqc`.
- Do not modify `app`.
- Preserve the current image Capture API and its pending/imported lifecycle.
- When the attached task prompt conflicts with the completed PC consumer, the
  consumer's concrete request and response types win.

## Authoritative PC inbound contract

The server must implement these Bearer-authenticated routes:

1. `GET /v1/captures/pending`
   - Returns `{ "captures": [...] }`.
   - Each capture exposes the mandatory snake_case fields `id`, `kind`,
     `object_key`, `content_type`, `size_bytes`, `source_url`,
     `creator_handle`, `source_published_at`, and `created_at`.
   - `kind` is exactly `image` or `video`.
2. `GET /v1/captures/{capture_id}/download`
   - Returns a ticket with `method: "GET"`, `download_url`, and
     `required_headers`.
   - The URL is a short-lived signed R2 GET URL. The PC never receives R2
     credentials.
3. `POST /v1/captures/{capture_id}/acknowledge`
   - Accepts `{ "imported_at": "<RFC3339 timestamp>" }`.
   - Marks the capture imported only after the PC consumer calls it.
   - Repeated acknowledgements succeed without replacing the first stored
     `imported_at` value.

The pushed consumer commit `85027db` directly deserializes these snake_case
names, so they are mandatory and cannot be replaced by camelCase. Server
responses may also include camelCase aliases, and acknowledgement may accept
`importedAt`, but those additions are secondary compatibility conveniences.

The existing `GET /v1/captures` and
`POST /v1/captures/{capture_id}/imported` routes remain available for backward
compatibility. `/pending` is a filtered view of the same records, while
`/acknowledge` and `/imported` call one internal imported-state transition.
They are not a second inbound protocol.

That transition is idempotent. Once a capture is imported, a retry returns
success and preserves the first `imported_at`, covering the case where the
server committed an acknowledgement but its response was lost.

## Capture creation contract

`POST /v1/captures` gains an optional `media_type` field whose accepted values
are `image` and `video`. Omission means `image`, so existing image requests
remain valid. `animated_gif` is normalized by the extension to `video` because
X serves animated GIF media as MP4.

The capture table gains a non-null `media_type` column with default `image`.
Startup migration adds it to an existing database without resetting or
rewriting existing rows. Capture responses expose `media_type`; PC-facing
pending responses map the same value to `kind`.

The existing uniqueness key `(source_url, media_url, classification_id)` is
preserved for both media types. A duplicate submission returns the existing
capture and does not upload another object during the normal sequential path.
The existing conflict cleanup behavior remains for concurrent submissions.

## Media validation and storage

The server remains an X-only downloader:

- Image: HTTPS `pbs.twimg.com`, response MIME must start with `image/`.
- Video: HTTPS `video.twimg.com`, response MIME must be exactly `video/mp4`
  after removing parameters.
- Other schemes and hosts are rejected before network access.
- Redirects are not followed. A redirect response therefore fails without
  contacting its destination.

Both image and video downloads stream in bounded chunks to an untrusted-name-
independent temporary file. Declared and observed sizes are checked while
downloading. Image size remains 50 MiB. Video size defaults to 512 MiB and is
configurable with `MAX_CAPTURE_VIDEO_BYTES`. HTTP connect and read timeouts are
bounded separately. The temporary file is removed in `finally` on success or
failure.

Only a completed temporary file is uploaded to R2. A pending database row is
created only after R2 upload succeeds. Upload failure is reported as a remote
storage failure and must not create a pending row; best-effort object deletion
removes any ambiguous upload result.

Object keys remain UUID-derived:

- Image: `images/inbox/{capture_id}/original`
- Video: `videos/inbox/{capture_id}/original`

Remote filenames and URL paths never influence local temporary filenames or
R2 object keys.

## Extension behavior

The existing X syndication resolver and highest-bitrate MP4 selection remain
unchanged. Collector-supported types expand from `image` to `image`, `video`,
and `animated_gif`. Collector requests send `media_type: "image"` for images
and `media_type: "video"` for video and animated GIF payloads.

Resolved `video.twimg.com` MP4 URLs go directly to the Capture API. Unresolved
video first uses the existing resolver, then sends the selected MP4. A
successful Capture API response does not invoke PC ingestion. Any Collector
failure uses the existing device-download fallback and is never reported as a
successful cloud capture.

`background-worker.js` remains generated from `layout.js`, `defaults.js`, and
`background.js` through the existing rebuild script.

## Testing

Server tests use temporary SQLite state plus fake HTTP and R2 implementations;
they never contact X or R2. They cover legacy and explicit image creation,
video creation and namespace, pending serialization, download tickets,
acknowledgement, host and MIME rejection, redirect rejection, size limits,
interrupted downloads, R2 failures, idempotency, and imported state.

Extension tests cover backward-compatible image requests, resolved and
resolved-through-syndication videos, animated GIF normalization, successful
Collector routing, failure fallback, token secrecy, endpoint validation, and
generated worker synchronization. The complete extension suite runs after the
targeted red/green cycles.

## Deployment boundary

No deployment occurs before all local checks pass. Deployment, if safely
available without passwords, copies only changed server source while
preserving production `.env`, database, virtual environment, logs, and pending
captures. Otherwise the final report supplies minimal manual deployment
commands. No commit or push is created without separate user approval.

Before implementation, non-interactive SSH inspection confirmed that the
production `~/lakomics-api/.venv/bin/python` reports Python 3.14.4. Server code
must remain compatible with that observed runtime rather than assuming the
local interpreter version represents production.
