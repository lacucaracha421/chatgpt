# PC declutter concepts (2026-09-24)

Design exploration only. These are static mockups, not an implementation contract. Placeholder art is CSS gradients, and all names and counts are fictional. Tokens are copied from `_tools/app/src/styles/tokens.css` and `chrome.css`. Fonts load from the app's bundled font files by relative path.

- Compare: `index.html`
- Live screens: `concept-a.html#library|command|characters|settings`, `concept-b.html#home|library|settings`, `concept-c.html#library|status|collections|settings`
- Renders (1680×1100, headless Chrome): `a-*.png`, `b-*.png`, `c-*.png`
- Yellow numbered notes in the renders are annotations, not UI.

User brief: the direction is right, but the PC app became cluttered as features were added. Hide what should be hidden and give frequently used features a big, prominent place. The mobile app should later borrow from this.

## 1. Audit (current desktop, as the user sees it)

Frequency is estimated from `CONTEXT.md`, `DESIGN.md`, `docs/agents/pc-design-reference.md` and what each feature does. There is no usage telemetry.

| Element | Where now | Frequency | Proposal |
| --- | --- | --- | --- |
| Asset gallery, folder/album index | rail 에셋 + index (`layout/WorkspaceNavigation.tsx`, `classification/ClassificationSidebar.tsx`) | high | promote. Keep it as the hero. |
| Collections (Library/Showcase, types, sort/rating) | rail 컬렉션; index `collections/CollectionBrowser.tsx` | high | keep. Collapse sort and direction into one control. |
| Manga (local/online catalog) | rail 망가 (`manga/MangaBrowser.tsx`, `OnlineCatalogBrowser.tsx`) | high | keep |
| Character series review (`캐릭터 만들기`, references, candidate review) | series header `titleAccessory` (`characters/SeriesBrowser.tsx:308-335`) | high while organising | promote: one primary `후보 확인` with a count |
| 다시보기 (today/date/creator/browse) | its own rail button (`WorkspaceNavigation.tsx:72`) | medium | move into the 에셋 index as a quick view (it is an asset view) |
| 메모 | rail button (`WorkspaceNavigation.tsx:73`) | medium-low | A: palette/overflow. C: keep in rail. |
| 비밀 (private vault) | conditional rail button with import activity dot (`WorkspaceNavigation.tsx:74`) | low | A/B: overflow. C: keep. |
| 관리 menu: 미분류, 휴지통 (n), 통계, 유사 검토 (n), 설정, plus the work list | rail tail; `WorkStatusCenter` merges navigation and job status in one popover (`layout/WorkStatusCenter.tsx`) | mixed: review/unsorted med-high, stats/trash low | split: queues (유사 검토, 미분류, 캐릭터 후보) surface only when non-zero; stats/trash go to overflow; jobs go to one status surface |
| `!` review badge on 관리 | `WorkspaceNavigation.tsx:77`, `WorkStatusCenter.tsx:79` | n/a | replace with a real count on a queue entry |
| `동기화 문제 N` rail button | rail tail, only when problems exist (`WorkspaceNavigation.tsx:76`) | rare (failure) | fold into the single status indicator |
| `가벼운 모드` button (+ `검사 중단 요청`) | titlebar, **always visible** (`app/App.tsx:800`, `app/WorkloadControls.tsx` compact) | low (usually automatic/tray) | remove from the titlebar. Instant toggle goes in the status panel; auto-switch stays in Settings. |
| Disabled `검색 미지원` magnifier | index head on every screen without search (`WorkspaceNavigation.tsx:85`) | never usable | hide until supported |
| `파일 가져오기` + icon | index head on 에셋 (`WorkspaceNavigation.tsx:87`) | medium (drag/drop is the main path) | keep as a quiet icon |
| `보기 설정` dock | index bottom (`layout/WorkspaceChrome.tsx` `ChromeSettingsDock`) | medium | keep, or move to one titlebar icon (A/C) |
| Job/progress (`StatusBar`, `PublicationStatus`, vault import/export, character automation, `WorkTray`) | inside the 관리 popover and a separate bottom `WorkTray` (`App.tsx` `WorkTray`) | only when running | one status indicator and one panel |
| Series header extras: `FaultPlayButton`, `S36 확인`, S36 series control, `과거 미분류 이미지 갱신`, `분류 다시 시작`, `자동 분류 다시 켜기` | series header / series panel (`SeriesBrowser.tsx:322, 422-423`) | rare / experimental / recovery | move to the `시리즈 더보기` overflow; show recovery only as an error state |
| Collection update-alert inbox (MangaDex / Kakao buttons) | collections index (`CollectionBrowser.tsx:218-229`) | low-medium | one `새 알림 N` row, shown only when unread; provider choice inside the inbox |
| Online Catalog DB timestamp | title accessory (`OnlineCatalogBrowser.tsx:505`) | low | move to Settings › 온라인 카탈로그 |
| Statistics `새로고침` | persistent toolbar action (`statistics/StatisticsPanel.tsx:57`) | low | overflow (auto-refresh on open) |
| Settings › 일반 | lightweight mode (4-5 rows), zoom, privacy, character auto-classification, **S36 시험 채점**, **캐릭터 누락 보완**, library folder, manga folder (`settings/SettingsView.tsx:750+`, `CharacterAugmentationSettings.tsx`) | zoom/privacy med; S36/augmentation experimental | 일반 keeps about 7 rows. Character analysis moves to 라이브러리, and S36/augmentation to 고급. |
| Settings › 클라우드 | direction status, server URL, token save/delete, test, receive now, backfill: pre-check, full upload, state recovery (`CloudBackfillSettings.tsx`) | status: med; the rest is maintenance | the first line gives the conclusion (synced or a problem). Connection info collapses. Backfill and recovery go to 고급. |
| Settings › 온라인 카탈로그 | status, visibility, blocked tags, mobile catalog publish, image cache, JA checkpoint reset, catalog replace/recover | low; several are maintenance | keep blocked tags and cache; publish, checkpoint and replace go to 고급 |
| Settings › 데이터 관리 | vault, book folder, metadata import, **legacy package import (7 result rows)**, server backup/restore, local backup recovery | maintenance | move everything except vault setup to 고급 |

Top findings:

1. **Maintenance sits beside daily use.** The 관리 popover mixes 유사 검토 and 설정 with job progress. Settings › 일반 exposes experimental S36 and augmentation controls next to zoom and privacy. Settings has 6 sections with roughly 60 labelled rows/actions, and about half of them are one-time or recovery tools.
2. **Status is scattered across 5 places:** the titlebar mode button, the rail sync-problem button, the 관리 `!` mark, the work list inside 관리, and the bottom `WorkTray`.
3. **Always-visible controls do nothing most of the time:** 가벼운 모드 in the titlebar and a disabled search icon on every non-search screen.
4. **The rail grew to 6-8 entries** (에셋, 컬렉션, 망가, 다시보기, 메모, 비밀, 동기화 문제, 관리). DESIGN.md intends three primary areas plus one management entry.
5. **High-value queues are hidden:** 유사 검토, 미분류 and character candidates are the most actionable work, but they appear as a `!` or buried menu counts.

## 2. Concepts

### A. Focused library (`concept-a.html`)
- Rail: 에셋, 컬렉션, 망가 only. The tail has `이동 (Ctrl K)` and `더보기`, whose count mark appears only when a queue is non-zero.
- The 이동 palette is the single home for hidden features. Non-empty queues sit at the top, then 메모, 비밀, 통계 and 휴지통, then actions (import, lightweight mode, settings). It navigates by name and does **not** fake asset text search (`pc-design-reference.md` §5).
- 다시보기 becomes an 에셋 quick view. The titlebar keeps location and one 보기 icon.
- Character series: one primary `후보 확인 · 37`. S36, refresh, restart and FAULT go into `더보기`.
- Settings: 6 sections plus `고급 › 복구·진단`, and a settings search field.
- Trade-off: 메모 and 비밀 lose rail presence. The palette is new UI to build and learn.

### B. Task-first home (`concept-b.html`)
- New `홈` destination as the landing screen, with:
  - large `이어 보기` tiles (last asset folder position, a manga volume in progress, an online catalog chapter);
  - `확인할 것` queue tiles with real counts that vanish at zero;
  - `다시보기` and `최근 추가` strips;
  - one quiet tool row (메모, 비밀, 통계, 휴지통) with a sync/job line.
- The rail keeps 홈, 에셋, 컬렉션, 망가 and 설정. 홈 carries the queue count.
- Settings › 동기화 opens with a one-line conclusion. Connection info and the 고급 동기화 도구 are collapsed rows.
- Trade-off: needs new data that does not exist today (resume positions, a unified queue count). This is the concept most likely to drift into the dashboard/card wall that `DESIGN.md` §11 forbids. It must stay artwork-led, with no stat cards.

### C. Quiet chrome (`concept-c.html`)
- Keeps the current information architecture and rail entries. The index head and titlebar merge into one continuous 44px bar.
- One status indicator (`작업 2`) opens a single panel with:
  - sync state;
  - running jobs with pause;
  - waiting jobs;
  - `확인할 것` queues;
  - the 가벼운 모드 toggle.

  This replaces the titlebar mode button, the rail sync-problem button, the work list in 관리, and the `WorkTray`.
- Selection commands appear only in a floating selection bar. Search and add icons appear only where they work.
- Collections: MangaDex/Kakao become one `새 알림 3` row. Sort becomes a single select, and rating filters are neutral grey chips.
- Settings › 일반 is cut to 7 rows. 고급 holds maintenance.
- Trade-off: least disruption, but it only partly meets "give frequent features a big place".

## 3. What moves where (common to all concepts)

- **Hide until needed:** disabled search icon, sync-problem button, recovery buttons (`자동 분류 다시 켜기`, retry), update-alert inbox, queue counts at zero.
- **Move to overflow:** FAULT play, S36 review, historical refresh, restart classification, series cover, statistics refresh, catalog timestamp.
- **Move to Settings › 고급:** S36 scoring, character augmentation and analysis environment, cloud pre-check/full upload/state recovery, server restore point, local backup recovery, metadata import, legacy package import, book folder, mobile catalog publish, JA checkpoint reset, catalog replace/recover.
- **Promote:** gallery space, `후보 확인` with count, 유사 검토 and 미분류 counts as actionable entries, continue-viewing (B).

## 4. Recommendation

Start with **C** as the cleanup baseline, since it is low-risk and mostly relocation. Then adopt **A's** `Ctrl K` 이동 palette and trim the rail to three areas plus 이동/더보기. Before building a separate 홈, prototype **B's** `확인할 것` queue row inside 에셋, for example above the gallery when queues are non-zero.

## 5. What transfers to mobile

- **One status surface.** Mobile's shared top bar gets one quiet status dot/panel instead of scattered banners.
- **Queues only when non-zero.** This matches "one screen = one conclusion". Each queue is its own focused screen with one primary action (`후보 확인`, `검토`).
- **Neutral filters.** Grey multi-select chips (already the PC rule) match the mobile brief's "neutral, not always-highlighted filter buttons".
- **Icon-first search.** Search appears only where supported, which is consistent with the mobile brief.
- **Settings split.** Everyday settings stay separate from 고급, with sync shown as a one-line conclusion first.
- **B's continue-viewing tiles** are the strongest candidate for a mobile landing screen.

## Evidence and gaps

- Rendered all 11 PNGs with `google-chrome --headless --window-size=1680,1100` and inspected each one. Overlapping annotations and clipped labels were fixed.
- Not checked: narrow windows (~800×640), DPR 1.125/1.25, keyboard and focus paths. None of this is native or app evidence.
