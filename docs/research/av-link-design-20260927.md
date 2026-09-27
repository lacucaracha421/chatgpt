# AV Collection link: collector → server → PC (design, 2026-09-27)

Approved by the user 2026-09-27 from `docs/prototypes/av-link-20260927/` (recommendations accepted): received codes live at the top of Collections › AV (screen 1A) plus a count-only line on the PC Home (hidden in privacy mode, opens Collections › AV); candidate chooser = screen 2 / 2-new; new collection default name = the product code; "거절" discards the candidate only (sending the code again fetches again); the collector offers "컬렉션에 보내기" next to the product code on JAVLibrary work pages and in the product-code selection chip. Source decisions: LibreDMM for metadata and the wrap jacket, Wikidata for Korean performer names (see LONG-001 and `av-sources-20260926.md`). Nothing is applied without the user choosing it in the chooser.

## 1. Server contract (Cloud API, `server/lakomics-api/`)

New module `av_lookup_requests.py`, registered from `app.py`.

- `POST /v1/av-lookups` — auth: the same client/extension credential that `POST /v1/captures` accepts.
  Body (pydantic, `extra="forbid"`, strict): `{"requestId": uuid4 string, "productCode": string 1..40 chars, "sourceUrl": https URL ≤ 2048 or null}`.
  The server normalizes nothing beyond trimming; the PC normalizes. Idempotent on `requestId` (same id + same body → the original response; same id + different body → 409 `avLookupConflict`).
  Response 200: `{"requestId", "sequence": int, "receivedAt": ISO-8601 UTC}`.
  Byte cap 4 KB before parsing. Rate: at most 30 requests/minute per credential (429 beyond).
- `GET /v1/av-lookups?after=<int>&limit=<1..100>` — auth: publisher (the PC). Returns `{"items": [{"sequence", "requestId", "productCode", "sourceUrl", "receivedAt"}], "nextAfter": int, "hasMore": bool}` ordered by `sequence`, `after`-exclusive.
- Storage: table `av_lookup_requests(sequence INTEGER PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, product_code TEXT NOT NULL, source_url TEXT, body_sha256 TEXT NOT NULL, received_at TEXT NOT NULL)`. Retention: rows older than 30 days are deleted by the existing periodic pruning path (or on insert, bounded).
- The PC keeps its own cursor; there is no server-side ack.

## 2. Collector (`extension-list/`)

- "컬렉션에 보내기" button next to the product code on JAVLibrary work pages (`/vl_searchbyid.php` results that land on a work page and `/?v=` work pages; read the code from the page's ID field) and a "보내기" action in the existing product-code selection chip and the right-click menu ("AV 컬렉션에 보내기: “%s”").
- Sends `POST /v1/av-lookups` through the existing paired API client with a fresh `requestId`, the normalized code (`normalizeProductCode`) and the page URL. Toast: "PC로 보냈어요 · SSIS-001"; on failure "보내지 못했어요 · 다시" with retry using the same `requestId`.
- Button states: 처음 / 보내는 중 / 보냄 (per page load).

## 3. PC (`_tools/app/`)

- Poll `GET /v1/av-lookups` alongside the capture poll (same cadence/lightweight-mode rules), store the cursor locally, insert each item into the local inbox (idempotent on `requestId`).
- Local tables (next migration): `av_link_inbox` (request id, product code as sent, normalized code, source url, received_at, status `queued|fetching|found|not_found|error|dismissed|applied`, attempts, last_error, fetched_at, matched `collection_id` or null) and `av_link_candidates` (inbox id, LibreDMM JSON snapshot, jacket file path, jacket width/height, default split x1/x2, performer name mapping JSON).
- Fetch worker: LibreDMM `https://www.libredmm.com/movies/{CODE}.json`, ≥ 2 s between requests, 202 = queued upstream → retry with backoff (up to ~10 minutes total), 404 → `not_found`. Download `cover_image_url` (the `pl` wrap jacket) into the library's app-owned candidate folder. Performer Korean names: Wikidata SPARQL by Japanese label (`rdfs:label|skos:altLabel "<name>"@ja`), taking the `ko` label and FANZA actress id `P9781`; cache per name; only names are sent.
- Split defaults: if width/height ≥ 1.2 treat as a wrap; front width = height × 0.703 from the right; back = same width from the left; spine = the middle, kept only if 1–12 % of the width.
- Matching: normalized product code equal to an existing AV Collection's `product_code` (normalize both sides) → "기존 컬렉션에 후보 추가"; otherwise "새 AV 컬렉션 만들기".
- Apply (one transaction, revision-checked like `apply_av_artwork`): crop the jacket at the user's split lines into front/spine/back artwork (provider `libredmm`), write the chosen metadata fields, link or create people (Korean display name from Wikidata when the user keeps it, Japanese name stored separately), mark the inbox item `applied`. New collection: create an AV Collection named by the product code first. Manual choices (`local-manual`) are never overwritten unless the user chose "후보 사용" for that surface.
- UI per the mockup: received list at the top of Collections › AV with 후보 보기 / 다시 시도 / 품번 고치기 / 버리기; Home count line; chooser dialog (draggable split lines, per-surface 후보 사용/유지/비우기, metadata diff with only empty fields checked by default, performers linked/new, genres toggled, 거절 / 나중에 / 적용).
