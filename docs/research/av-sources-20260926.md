# AV metadata, cover and performer sources (research, 2026-09-26)

Read-only research for `LONG-001` and the Home "오늘의 AV 배우" card. Probes ran from Korea (headers, robots, 400 errors, JPEG header range reads). UNVERIFIED = could not confirm.

## Today's model
`collection_av_details` (product_code/label/series, revision; migration 0046); `collection_people` has only `display_name`; `collection_person_relations` (performer/director, credit_name); front/spine/back = `collection_work_artworks.kind` cover/spine/back with `selected`, manual files `provider='local-manual'`; `apply_av_artwork` already takes Keep/Clear/Local per surface. Missing: title, release date, runtime, genres, maker, external binding; performer ruby/aliases/ids/portrait. Provider pattern to copy: `igdb.rs`/`igdb_flow.rs`/`provider_requests.rs`/`credential.rs` (limiter, keyring target, search → preview → apply, `collection_external_bindings`).

## Sources
| Source | Coverage | Access from KR | Verdict |
|---|---|---|---|
| DMM/FANZA Web Service API v3 (`ItemList`, `ActressSearch`, …) | JA title, date, maker, label, series, actresses (id, name, ruby), director, genres, runtime, images | endpoint answers (400 without keys); docs site geo-blocked; authenticated calls from KR UNVERIFIED | **Primary** (official, free, needs API ID + affiliate ID ending -990…-999) |
| LibreDMM (`libredmm.com/movies/{CODE}.json`, open-source) | normalized id, JA title, date, makers, labels, genres, volume, actresses + photo URLs, `pl`/`ps` covers; also MGStage titles | works, no key | **Fallback** (unofficial, no terms; throttle ≥ 2 s) |
| R18.dev | EN/romaji mirror | Cloudflare-blocked | not usable |
| MGStage | Prestige/amateur | site 403 from KR | only via LibreDMM |
| JavLibrary / JavBus / JavDB | scraping | challenge / no connection | reject |
| JAVStash (stash-box GraphQL) | community performer data | account + API key (likely invite) | optional later |
| Wikidata P9781 (FANZA actress ID) | 7,020 people; 6,372 with a Korean label; 950 with a free photo | open (needs User-Agent) | **performer enrichment** (Korean names, aliases) |

No source has Korean titles; Korean performer names only from Wikidata `ko` labels or the user.

## Covers
- Digital jacket `pics.dmm.co.jp/digital/video/{cid}/{cid}pl.jpg` 800×538, full wrap back | spine | front; high-res `awsimgsrc.dmm.co.jp/pics_dig/…pl.jpg` 2184×1468 (GET+Range; HEAD is 405); high-res `ps` 1032×1468 → front = right 47.25 %, spine ≈ 5.5 %.
- DVD/BD `mono/movie/adult/{cid}/{cid}pl.jpg` 800×438 — different ratio, so no fixed split.
- Missing image = 302 to `now_printing.jpg`.
- Split: if width/height ≥ ~1.2 treat as wrap; front width = H × ps.w/ps.h (or H × 0.703); back = left same width; spine = middle, shown only if 1–12 % of width; user adjusts split lines and confirms.
- Performer photos from DMM are 125×125 — too small; prefer Commons image or a user-picked crop of a front cover.

## Product-code normalisation
Display `LABEL-NNN` (upper, ≥ 3 digits). Digital cid `[prefix]label + 5-digit number` (`ssis00001`, `118abw00001`, `h_1472smkcx00003`); mono cid varies (`1stars123`, `k9ssis001`). Match by stripping `^(?:\d+|h_\d+)?([a-z]+\d+.*)$` and suffixes (`r`, `bod`, `tk`); search by keyword on both floors, store resolved digital and mono cids in the binding. FC2-PPV and amateur codes (SIRO, 259LUXU) are separate families.

## Integration (fits LONG-001)
1. `library/fanza.rs` (limiter ≥ 1 s, keyring `Lakomics/Fanza` {api_id, affiliate_id}); optional `library/libredmm.rs` fallback behind a setting.
2. Fetch writes only candidates (`av_source_candidates`, `av_image_candidates` with split geometry); apply uses the existing artwork insert with provider `fanza`/`libredmm` and records `collection_external_bindings`.
3. Chooser: `AvArtworkDialog` gets candidate crops with split-line editing next to 파일 선택/선택 해제/유지; a per-field metadata diff; performers matched by FANZA actress id, then name.
4. Refresh re-fetches candidates only; a field auto-updates only if it still equals the last provider-applied value; `local-manual` choices are final.
5. Schema: `collection_av_details` + title_ja, release_date, maker, runtime_minutes, genres_json; `collection_people` + name_ja, ruby, aliases_json, fanza_actress_id, wikidata_id, portrait_artwork_id.
6. 오늘의 AV 배우 uses person id, display name (user override → Wikidata ko → JA), work count, latest work, portrait (user pick → Commons → latest front cover), with the off-by-default privacy gating.

Effort ≈ 6–8 days (FANZA client 1–1.5, LibreDMM 0.5, candidates/refresh 1.5, chooser 1.5–2, performers + Wikidata 1–1.5, Home pick 0.5–1).

## Decisions needed
1. Register a DMM affiliate account and API ID (instant after applying; site registration/review may be required; non-Japan residency and KR calls UNVERIFIED).
2. Accept the affiliate terms' grey area for private caching/cropping, or store only what the user picks.
3. Allow the keyless LibreDMM fallback?
4. Confirm no scraper sources.
5. Allow Wikidata lookups (sends only the FANZA actress id)?

## Probe from the Tokyo VPS (2026-09-26, user asked about routing through the Japan server)
Browser User-Agent, 3 s apart, a handful of requests:
- **JavBus:** reachable; redirects to an age-verification page unless an age cookie is sent (`existmag=all` etc.); with it, `https://www.javbus.com/SSIS-001` returns the work page (JA title, `bigImage` cover link). Usable as a VPS-routed fallback (scraping: fragile, terms grey area, keep request rate very low, cache results).
- **JavDB:** HTTP 200 but a Cloudflare challenge page (1.3 KB) on home and search — not usable without a browser/challenge solver.
- **JavLibrary:** 403 Cloudflare "Just a moment…" — not usable.
Plan: LibreDMM + Wikidata first; add a VPS-routed JavBus fallback provider only if LibreDMM misses many of the user's codes.
