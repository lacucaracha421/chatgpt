# 기능 후보 조사 — 2026-08-29

4개 영역(자산 탐색, 컬렉션·프로바이더, 망가·온라인 카탈로그, 수집·데이터 관리)에 대해
코드 전수 조사를 수행한 결과를 정리한 문서다.

- 조사 방법: 영역별 코드 탐색 (프론트 + `src-tauri/src/library/` + 관련 commands/migrations)
- 공통 발견: TODO/FIXME/unimplemented가 프론트·백엔드 모두 0건. 미완성 stub 없음.
  대신 **"데이터는 이미 저장·구현해두고 UI나 경로가 없어서 안 쓰이는" 빈틈**이 많다.
- 아래 분류 태그: `[저비용]`(표시·insert 수준), `[중간]`(백엔드 쿼리/커맨드 추가 동반),
  `[큰 공사]`(스키마 마이그레이션 또는 신규 뷰).

선택된 항목은 실제 착수 시 `docs/product-change-backlog.md`에 정식 항목으로 승격한다.

---

## 1순위 — 이미 갖춘 데이터 활용 (표시·insert 수준, 위험도 낮음)

### 1.1 자산 상세에 게시 시각 표시
- 15.29 확장부터 `source_published_at`을 저장하지만 `AssetInspector` 출처 섹션
  (출처 URL·제작자만 렌더링, `AssetInspector.tsx:177~192`)에는 표시되지 않는다.
- 출처 `<dl>`에 한 줄 추가로 끝난다.

### 1.2 로컬 망가 ↔ 온라인 카탈로그 매칭
- `manga.rs:126,217`이 `info.txt`의 갤러리 넘버를 `manga_series.gallery_id`로
  저장하지만 `list_series`(manga.rs:285)가 반환하지 않는 죽은 컬럼.
- `MangaSeries`에 `galleryId` 노출만으로 kHentai 상세 딥링크·표지 매칭이 가능해진다.

### 1.3 권 출간일·출간예정 배지
- `CollectionVolume.localReleaseDate`/`releaseStatus`가 이미 응답에 있고
  표시 컴포넌트(`CollectionVolumePanel.tsx`)도 만들어져 있으나
  어디서도 import되지 않는 죽은 코드. 타일 배지로 "다음 권 언제 나오나" 노출.

### 1.4 컬렉션 description 표시
- `CollectionEditDialog.tsx:108`에서 편집되지만 `GameCollectionDetail`·
  `MovieCollectionDetail`·`CollectionInfoPanel` 어디서도 렌더링하지 않는다(전부 `overview`만).
  사실상 버그.

### 1.5 온라인 카드 썸네일 디스크 캐시 사용
- `/remote-manga-thumbnail/{work_id}` 라우트가 이미 구현돼 있으나
  (`media_protocol.rs:214`) `mediaUrl.ts`에 함수가 없어 프론트가 CDN 직접 URL을 쓴다.
- URL 교체만으로 오프라인에서도 표지 유지.

### 1.6 IGDB 스크린샷 전량 저장
- `igdb_flow.rs:252-268`이 cover 1장 + hero 1장만 insert하고 screenshots은 hero 후보로만 사용.
  결과적으로 방금 추가한 `WorkArtworkGallery`가 1~2장뿐.
- `collection_work_artworks.kind`에 CHECK 제약이 없어 `screenshot` kind 추가 + insert 루프만 늘리면 됨.
- 같은 맥락: 갤러리가 게임 상세에만 있고 영화 상세에는 없음.

## 2순위 — 체감 큰 기능

### 2.1 자산 검색 (제목·파일명·제작자)
- `AssetQuery`(models.rs:456)에 검색 필드가 없고 `query.rs` SQL에도 LIKE 절이 없다
  (유일한 LIKE는 트위터 URL 목록). 프론트 단독으로는 불가, 백엔드가 선행.
- 검색 대상은 `AssetSummary`에 이미 존재: title, original_name, source_url, creator_name/handle.
- `CHRONO_*_HALF_SQL` 3개 + random 쿼리에 검색 절 추가가 작업 본체.

### 2.2 뷰어 확대/축소·팬 + 로드 페이지 밖 이동
- `AssetViewer.tsx`는 44줄 — 원본 `<img>` 1장이 전부. 확대/팬/회전/원본 크기 없음.
- 뷰어가 `AssetBrowser`의 현재 로드분(페이지당 100건)만 받아 마지막 자산에서 멈춘다.
  `onNeedNextPage` 콜백 + `loadNextPage` 재사용으로 해결.

### 2.2 미디어 종류 필터 + GIF 타일
- `media_kind` 컬럼과 `MediaSummary::Image|Gif|Video`(models.rs:315)가 이미 있으나
  `AssetQuery`에 필터가 없고 타일은 `kind === "video"`만 분기한다.
- GIF 타일이 정적 WebP 첫 프레임으로만 보임. `mediaKind` 필터 1개 + 타일 분기.

### 2.3 X 수집 자동 분류 규칙
- 확장이 `author`·`postId`·동영상 메타를 `buildSidecarMetadata`에서 만들지만
  `XIngestionRequest`(`deny_unknown_fields`)가 받지 않아 폐기됨.
  `author_name` 필드 하나로 시작 가능(확장 수정 사실상 불필요).
- `ingest_x_image`가 `creator_handle` 확정 후 `ingest_media`를 호출하는 구조라
  "핸들 → 분류" 매핑 테이블 + classification 덮어쓰기 훅 하나로 규칙 엔진 시작 가능.

### 2.4 휴지통 일괄 복원·페이지네이션
- `TrashBrowser.tsx:40`이 `listTrash`를 1회 호출하고 끝. 복원도 항목당 1개씩.
- 백엔드의 `restore_assets`·커서·`total_count/total_bytes`가 모두 준비돼 UI만 작업.

### 2.3 쇼케이스 순서 변경
- `showcase_order` 컬럼·부분 인덱스·자동 채번(`collection.rs:267`)은 있는데
  순서 변경 커맨드와 드래그 UI가 없다.

### 2.4 릴리즈 워치 요약 화면 + 주기 재실행
- `run_due_release_watch`가 앱 시작 1회만 호출되고 재실행이 없다.
- 이벤트는 컬렉션에 직접 들어가야만 보인다. 미읽음 전체 목록 쿼리
  (`release_watch_events_by_collection_unread` 인덱스 존재) + 사이드바 진입점이면
  "이번에 새로 나온 권" 모아보기가 된다.

### 2.5 유사 검토 일괄·자동 처리
- exact-hash 중복은 자동 처리되지만 PDQ 리뷰는 distance≤20·quality≥50이면 무조건 open.
- `decide_similarity_review`를 루프 도는 커맨드 하나로
  "distance 0 자동 keep_existing"·건너뛰기·일괄 처리가 가능하다.

## 큰 공사 (별도 결정 필요)

- **사용자 태그·메모** — `AssetSummary`에 tags/memo 필드 자체가 없어 마이그레이션 필요.
  분류 트리가 사실상 태그 역할이라 우선순위 낮음.
- **플레이 기록·진행 상태** — owned/purchased_at/progress/finished 컬럼이 전무.
  "미완성 표시" 필터의 전제.
- **시리즈·프랜차이즈 묶기** — IGDB 쿼리가 `franchises`를, TMDB가
  `belongs_to_collection`을 아예 요청하지 않음. provider_data 스냅샷 구조는 있어 3단 분할 가능.
- **온라인 작품 오프라인 보관함** — 현재 캐시는 만료 URL + 임시 페이지 캐시뿐.
- **로컬 망가 권/챕터·zip(cbz)** — `list_page_files`가 1단계 폴더의 숫자 파일만 인식.

## 잡정보 (조사 과정 발견)

- `CollectionVolumePanel.tsx`는 죽은 코드(어디서도 import 안 됨) — 1.3에서 부활 대상.
- 확장 수집 실패 폴백(브라우저 다운로드) 파일에는 사이드카 JSON이 남지만
  앱 수집 경로가 이를 읽지 않아 출처·게시 시각 없이 유입된다. 별도 과제 후보.
- 확장 수집은 `ingestion_lock` 직렬화라 대량 저장 시 응답이 밀리고
  브라우저 다운로드 폴백으로 새는 위험이 있다.
- IGDB/TMDB/MangaDex 새로고침 성공 시 피드백이 없다(Aladin만 정량 요약 존재).
  `ReleaseWatchRunResult.skipped/stopReason`도 UI에서 폐기 중.

## 조사 방법

2026-08-29 기준. 자산 탐색 / 컬렉션·프로바이더 / 망가·온라인 카탈로그 / 수집·데이터 관리
4개 영역을 병렬 코드 탐색으로 조사했다. TODO/FIXME/unimplemented는 전 영역 0건.