# 2026-08-31 · 작가 뷰 + 달력 뷰 세션 핸드오프

이 문서는 "최근/즐겨찾기 제거 → 작가 뷰 → 달력 뷰" 세션의 진행 상태를 다음 세션에
넘기기 위한 것이다. 코드는 커밋 `5b4a067`으로 main에 push 완료.

## 완료된 것 (커밋됨)

### ① 정리
- 사이드바 빠른 보기에서 `최근`·`즐겨찾기` 버튼 제거 (`ClassificationSidebar.tsx`)
- `AssetView` 타입에서 `recent`/`favorites` 제거 (`library/types.ts`)
- App.tsx 숫자키 quickViews는 1(저장소), 2(미분류)만 남김
- `AssetBrowser`의 recent/favorites 특수분기 제거 (effectiveSort 별칭 삭제)
- `AssetQuery.favoriteOnly`는 옵셔널로 유지 (백엔드와 호환)
- 하트(즐겨찾기 표시)와 "좋아요순" 정렬은 남김 — 정렬로 즐겨찾기 볼 수 있음
- 에셋 타일 빠른 미리보기 아이콘: PlusIcon → MagnifyingGlassPlusIcon

### ② 작가 뷰
- **백엔드(`query.rs`)**:
  - `list_asset_creators()` 명령 — CREATORS_SQL로 작가별 그룹핑
  - 그룹핑 키 = `COALESCE(creator_handle, creator_url)` (X 수집 시 자동 채워짐)
  - 초기 버전은 상관 서브쿼리라 1,721명에 ~45초 → **ROW_NUMBER 윈도우 함수 +
    MATERIALIZED CTE로 스캔 1회 재작성 → ~50ms (900배 개선)**
  - `AssetQuery.creator_key` 필터 추가 (creator 뷰에서 그 작가 자산만)
  - DATE_BUCKETS_SQL에도 creator_key 필터 추가 (?9)
- **데이터**: `AssetCreatorSummary { key, creatorName, creatorHandle, creatorUrl,
  assetCount, lastCollectedAt, coverAssetIds[8] }` — 커버는 최근 수집 8장
  (스택 3장 + 호버 프리뷰 5장용)
- **프론트**:
  - `CreatorList.tsx` — 200px 그리드 카드(스라이더 연동), 3장 스택(하단 띠 디자인),
    `assetCount >= 3`만 기본 표시 + "작은 작가 N명 더 보기" 토글
  - 가상화: 행 단위(react-virtual), 카드 높이는 인라인 계산
  - **호버 프리뷰**: 카드 아래로 떠 있는 오버레이(absolute + bottom:-8px, z-10),
    그 작가 이미지 3장@폭×0.42 — 카드 내부 공간과 무관하게 덮어뜌기 방식
  - width 측정은 ref 콜백 기반(useContainerWidth) — 조건부 마운트 대응

### ③ 달력 뷰
- `CalendarView.tsx` — 월 단위 그리드, 일별 수집량을 로그 스케일로 accent 색상 강도
- 날짜 클릭 → `onOpenCalendarDay(date)` → App.tsx `openCalendarDay` →
  최신순 정렬 + "저장소" 뷰 전환 + `requestedDate`로 `jumpToDate(aroundDate)`
- 사이드바에 "작가"(UserIcon), "달력"(CalendarIcon) 버튼 추가

### ④ 기타
- `tauri.conf.json`에 `"devtools": true` (F12로 DevTools 열림 — 디버깅용)
- `AssetBrowser`에 `onViewChange`, `onOpenCalendarDay`, `requestedDate` prop 추가

## 검증 상태
- `tsc --noEmit` 클린, vitest 546/546, `cargo test --lib` 427/427
- 사용자 실화면 확인: 작가 스택/카드/호버 프리뷰 ✅ (스크린샷 기준 만족)
- **달력 뷰는 사용자 실화면 미검증**

## 다음 세션에서 확인할 것 (우선순위)
1. **달력 뷰 실화면 검증** — 사이드바 "달력" → 그리드 색 강도, 날짜 클릭 →
   갤러리 점프(aroundDate) 동작 확인. `onOpenCalendarDay`는 App.tsx에서
   `settingsReturnViewRef`에 calendar를 넣고 저장소 뷰로 전환하는 구조.
2. **호버 프리뷰 패널 닫힘 UX** — 카드를 벗어나면 닫히는데, 프리뷰 패널 자체에
   마우스가 가면(카드-프리뷰 사이 틈) 닫히는지 확인 필요. 필요 시 패널쪽에
   onMouseEnter 유지 로직.
3. ~~카드 크기 슬라이더~~ — **완료 (2026-08-30)**. `UiPreferences.creatorCardSize`
   (기본 200, 클램프 96~320) 추가. 작가 뷰에서만 슬라이더가 이 값을 읽고 쓰고,
   다른 뷰는 기존 `thumbnailRowHeight`를 유지 (App.tsx 분기).
4. **커버 8장 SQL의 rn=8 커버_7** — 개수 늘릴 때 covers CTE 패턴 참고
5. **빌드 배포** — `lakomics-*.tar*`, `.tmp-lakomics-min/` 등 전송용 임시파일은
   untracked로 남음. 필요 없으면 삭제.

## 알아두면 좋은 것
- 작가 데이터는 X 확장 수집분만 자동 잡힘 (드래그 직접 수집은 creator 없음)
- `useContainerWidth`는 ref 콜백 방식 — 조건부 마운트된 DOM에서 첫 측정 보장
- CreatorList의 카드 높이: `cellHeight - 30` (인라인), 행 높이 `cellHeight`
  (간격 30 포함). cellWidth는 `thumbnailRowHeight` 클램프(140~320)
- 사이드바 빠른 보기 순서: 저장소, 미분류, 작가, 달력, 유사 검토, 망가, 컬렉션
- CONTEXT.md의 "쇼케이스(Showcase)"와 컬렉션 쪽 "즐겨찾기" 개념은 이번 변경과 무관