# Home "발매 예정" game/movie sources and 오늘의 AV 배우 (research, 2026-09-26)

Read-only research for `HOME-DASH-001`. Items marked UNVERIFIED could not be confirmed.

## Today in the PC app
- Manga: Aladin/Kakao release watch (`library/release_watch.rs`, 24 h per subscription) → `release_watch_events` → releases lane (`collection_release_sync.rs`); schedule reaches the tablet as `releaseSchedule` on manga Collections only.
- Games: IGDB already integrated (`library/igdb*.rs`, Twitch client credentials in the keyring, 250 ms spacing); the query fetches `release_dates.date/platform` but not region/status/date_format; only the earliest date is stored.
- Movies: TMDB already integrated (`library/tmdb*.rs`, bearer token in the keyring); per-country release dates (type 1–6) stored; franchise ("collection") parts with dates already fetched.
- No watch/wishlist concept for games or movies; AV is deliberately excluded from the cloud replica; `collection_people` has no portraits.

## Recommended sources
- **Games: IGDB** (4 req/s, batched `where id = (…)`); regions include Japan/Asia/Worldwide — a separate Korea region is UNVERIFIED; fallback KR → Asia → Worldwide → earliest; keep month/quarter/TBD precision. Steam only for an optional public-wishlist import; RAWG not needed.
- **Movies: TMDB** (`release_dates` KR entries; Discover `region=KR` + `with_release_type=2|3` for a Korean coming-soon list; personal non-commercial use, cache ≤ 6 months, attribution required — check the PC shows it). KOBIS only as an optional KR-date fill later.

## Tracking design
1. PC: `release_watch_items` (kind, provider, external id, title, cover, source = collection/franchise/manual/steam_wishlist, collection id, muted) + `release_watch_dates` (region, platform, date, precision, checked_at); events into `release_watch_events` (`date_set`, `date_changed`, `released`). Watched items never become Collections.
2. Polling: 24 h due-check, 6 h within 14 days of release, stop 30 days after; full refetch ≤ 6 months (TMDB rule).
3. Publishing: a new "upcoming" lane → `PUT /v1/home/upcoming` (publisher) / `GET` with ETag (tablet; add to `NetworkPolicy.java`), covers via the Collections artwork blob flow.
4. Tablet: 게임/영화 segments of the 발매 예정 card with date precision ("10월 중", "2027 Q1", "미정").

## 오늘의 AV 배우
Daily seeded pick over performers with ≥ 1 AV Collection (name, work count, latest work code/label/series, one front cover — no portraits exist). AV currently never leaves the PC, so this needs an explicit user decision: PC setting off by default, text-only unless covers are allowed; tablet per-device hide toggle, collapsed/blurred until tapped, never on lock screen/notifications. Separate `PUT/GET /v1/home/av-pick` so turning it off deletes it on the server.

## Effort
Core (games + movies + AV, no Steam/KOBIS) about 6–8 days: IGDB fields 0.5, watch tables + runner 1.5–2, PC watch UI 1–1.5, server module 0.5–1, publication lane 0.5–1, tablet segments 0.5–1, AV pick 1–1.5.

## Decisions needed
- Watch-only (not owned) entries, or only franchise follow-ups of owned items?
- May AV names/covers go to the server and tablet at all?
