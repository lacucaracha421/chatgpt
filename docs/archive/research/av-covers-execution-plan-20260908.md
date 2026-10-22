# AV typed Collections and focused complete covers execution plan

작성일: 2026-09-08. 대상: `C:\chatgpt`, 현재 `main` working tree.

이 문서는 LONG-001 → LONG-002B의 **실행 제안**이다. 상태·우선순위의 원본은 `docs/roadmap/lakomics-backlog.md`이며 이 문서가 대체하지 않는다. 최초 요청은 계획만이었으며, 조사 중 사용자가 계획 후 실행을 승인했다. 이 문서 작성 단계에서는 구현·테스트·빌드·앱 재시작·운영 라이브러리 변경을 수행하지 않았다. 이후 구현은 통합 담당자의 배정에 따라 진행한다.

**Goal:** 기존 Collection 안에서 AV를 수동 등록하고, 식별자가 있는 인물 관계와 실제 앞표지·책등·뒷표지를 관리하며 상세 화면에서 정해진 면으로 이동해 감상한다.

**Architecture:** 기존 Collection CRUD와 Collection-owned WorkArtwork를 유지한다. AV 전용 정보와 인물 관계는 작은 관계형 테이블에 둔다. 앞표지는 기존 `kind='cover'`를 사용하고 `spine`, `back`만 추가한다. 목록은 기존 정적 표지 캐시를 소비하고 전체 표지 감상만 같은 package renderer의 focused 경로를 사용한다.

**Tech Stack:** 현재 React 19 / TypeScript / plain CSS / shared UI / Tauri 2 / Rust / SQLite. 새 의존성, 외부 AV provider, 별도 Works 엔티티, 별도 Shelf 엔진은 도입하지 않는다.

## 1. 범위와 실행 제약

- 포함: AV 타입, 수동 상세 정보, 이름과 분리된 people identity, Collection-person role/order, 로컬 표지 preview/apply/clear, front-only와 전체 면 감상, PC 탐색/검색/Showcase/개인 별점, 기존 Cloud replica와의 호환성.
- 제외: WORKS-001 Film/Series 기능 확장, LONG-004 Display/Shelf 모드, 다운로드·취득·재생·수집 경로 추가, Private Vault/암호화, AV provider 선택/설치/스크래핑, 기존 director 문자열의 일괄 인물 변환.
- 아직 없는 외부 AV provider를 지원 완료로 표시하지 않는다. 첫 배치는 수동 기능으로 독립 사용 가능하게 완료하고 LONG-001의 provider 연동 부분은 남은 범위로 보고한다.
- 사용자의 기존 캐릭터 v44 WIP를 보존한다. 조사 당시 `lib.rs`, `commands.rs`, `library/mod.rs`, `db.rs`, `backup.rs`, `tauri.conf.json`, AssetBrowser/Toolbar 및 캐릭터 파일들이 변경되어 있었다. 일괄 치환·일괄 stage·관련 없는 정리를 하지 않는다.
- 구현 권한은 Git 쓰기, 배포, 운영자료 쓰기 권한이 아니다. `C:\New_lakomics_assets`의 migration/표지 등록/복구점 생성은 별도의 운영 승인을 따른다.
- dev watcher가 운영 라이브러리를 연 상태에서 Rust/migration 파일을 바꾸면 자동 재시작으로 migration이 적용될 수 있다. 통합 담당자가 watcher를 중지하고 종료를 확인한 뒤 구현한다. 이 계획 작업은 프로세스를 조작하지 않았다.
- migration 후보는 `0046_collection_av.sql`이다. v44 캐릭터, v45 영상 계획과 조율된 후보이며 최종 번호·등록은 통합 담당자가 소유한다. 현재 코드가 v46이라는 뜻은 아니다.
- `writing-plans`는 작은 배치, 파일 소유권, 검증 가능한 계약을 만드는 방법으로 적용했다. 그 스킬의 worktree/commit/별도 승인 루틴은 이 작업의 권한을 넓히지 않는다.

## 2. 조사한 현재 사실

근거 줄 번호는 작성 시 working tree 기준이다. 실제 DB·운영 파일 내용은 읽지 않았으며 migration/schema와 현재 저장 코드를 조사했다. 아래는 구현 사실이고 뒤의 설계·배치는 제안이다.

| 확인한 사실 | 현재 근거 |
| --- | --- |
| Collection은 작품 모델이며 Asset, Album, WorkArtwork와 다르다. 세 타입만 구현되어 있다. | `CONTEXT.md`의 Collection/Collection Type; `docs/agents/lakomics-works-handoff-v2.md:9-27`; ADR-0031/0032 |
| TS와 Rust의 타입은 game/manga/movie이다. `movie` 안의 TV identity는 별도 기존 계약이다. | `app/src/library/types.ts:303`; `app/src-tauri/src/library/models.rs:733`; `library/tmdb_flow.rs:534-552` |
| DB type은 TEXT이며 enum CHECK가 없다. artwork kind도 nonempty 제약만 있다. 부모 table rebuild는 필요하지 않다. | `migrations/0011_collections_typed_metadata.sql:1`; `0014_collection_work_artworks.sql:1-24` |
| DB에서 모르는 Collection type을 manga로 읽는 fallback이 존재한다. AV 분기를 누락하면 오표시된다. | `library/collection.rs:500-506`, `collection_type_str:551-557` |
| 목록은 selected cover → volume cover fallback을 읽는다. hero/backdrop은 독립 선택이다. | `library/collection.rs:12-75`, `COLLECTION_SUMMARY_SQL` |
| 공통 수정은 메타데이터 일부의 전체 값 갱신이며 genres/overview/provider binding을 그 폼에서 지우지 않는다. | `library/collection.rs:155-217`; `models.rs:1004-1021` |
| Showcase는 type별 수동 순서이고 타입 변경 시 해당 타입 끝 순서로 이동한다. | `library/collection.rs:177-190`, `set_collection_showcase:272`; `CollectionBrowser.tsx:93` |
| artwork identity는 `(collection_id, provider, provider_image_id)`이며 같은 kind의 selected는 최대 하나다. | `0014_collection_work_artworks.sql:18-24` |
| `insert_work_artwork_in_transaction`은 단순 후보 저장이 아니라 해당 kind 선택도 변경한다. 같은 provider image ID를 다른 kind에 재사용하면 현재 upsert는 kind를 바꾸지 않는다. | `library/work_artwork.rs:263-313` |
| 원본·360px thumbnail을 준비하고 미commit 객체 drop 시 파일을 치운다. Collection 삭제 후 참조 없는 artwork/thumbnail을 정리한다. | `work_artwork.rs:15-60,72-141,540-576`; `collection.rs:220-228` |
| 허용 입력은 현재 JPEG/PNG/WebP, 파일당 32 MiB이다. 준비 함수는 Collection UUID를 요구한다. | `work_artwork.rs:15,77-87` |
| 기존 source folder 자동 아트워크 등록은 game/movie만 대상으로 하며 AV용 파일 선택 흐름은 없다. | `library/collection_source.rs:364-379,439-461` |
| 기존 TMDB flow는 preview에서 후보 identity를 확인하고 apply를 분리하며, refresh는 이전 snapshot과 현재 값을 비교해 수동 수정/명시적 clear를 지킨다. | `library/tmdb_flow.rs:559-629,819-968`; tests `1364`, `1412` |
| Collection 검색은 현재 제목만, type별 state 초기값은 세 개다. | `collections/collectionLibrary.ts:15-35` |
| AV를 추가하면 type label, 타입 버튼, 빈 화면, 편집폼, 상세 분기, 저장된 preference guard도 갱신해야 한다. | `CollectionBrowser.tsx:27,189-192,270,363`; `CollectionEditDialog.tsx:112-139`; `CollectionOverlay.tsx:81-117,537-571`; `preferences/uiPreferences.ts:148-150`; `layout/WorkspaceNavigation.tsx:78` |
| 정적 PhysicalCover는 book/game를 공유 캐시에 요청한다. 게임 case의 실제 앞면 2D 투영은 `drawGameCase` 하나다. | `physical/PhysicalCover.tsx:6-42`; `physical/collectibleRuntime.ts:5-66`; `drawGameCase.ts:10-119` |
| book 실시간 소유자는 하나이며 30fps/DPR1.5/1.4Mpx 제한, hidden/idle pause가 있다. | `physical/collectibleRuntime.ts:69-128` |
| 공개 Collection snapshot은 기존 모든 일반 Collection과 그 artwork를 먼저 수집한다. AV를 추가하면 그대로 export될 수 있다. | `cloud/collections.rs:snapshot_from_connection:162-240` |
| 서버가 세 타입만 허용하고 extra field를 거부한다. 한 AV가 전체 replica 422를 만들 수 있다. Mobile도 독립적인 세 타입 DTO다. | `server/lakomics-api/mobile_collections.py:23,56-59,95-98,243`; `app/mobile-client/collectionModel.ts:1`; `Collections.tsx:11` |
| replica 업로드는 전체 Collection snapshot을 교체한다. 부분 목록만 보내는 방식은 다른 작품을 지운다. | `server/lakomics-api/mobile_collections.py:229-236` |
| PC recovery point는 전체 DB snapshot을 업로드한다. WorkArtwork 원본 복구는 managed Asset 복구 대상과 다르다. | `cloud/metadata_backup.rs:34-43,105-145`; `docs/operations/pc-migration.md:8,30,53` |
| 현재 코드 schema는 v44이며 migration 전 검증 snapshot, transaction, FK check가 있다. | `library/db.rs:7,77-108,231-258`; `library/backup.rs:367-431` |
| 통계는 Collection 전체 count/open 기록이고 Revisit은 Asset 기반이다. AV가 통계에 포함되며 인물/표지를 Asset로 만들 필요가 없다. | `library/statistics.rs:162,170,177-194`; `library/revisit.rs:268-280` |

## 3. 최소 변경 대안과 권장안

| 대안 | 비용과 한계 | 판단 |
| --- | --- | --- |
| AV를 movie로 두고 JSON/태그만 추가 | 타입 확장 비용은 작지만 Film/TV 제공자·필터·UI와 섞이고 normalized people/role 제약을 잃는다. | 요구에 맞지 않음 |
| **기존 Collection + AV sidecar + people/relations + 기존 cover/spine/back** | 타입 분기와 작은 schema 추가가 필요하나 기존 CRUD/선택/표지·백업 소유권을 유지한다. | **권장** |
| 별도 AV Work/Person vault와 통합 renderer/새 provider framework 도입 | Collection·동기화·검색을 이중화하고 미정 provider/Private Vault까지 범위를 늘린다. | 제외 |

원격 제공자가 없는 현재는 `collection_external_bindings`에 가짜 provider를 만들지 않는다. 사람이 입력한 값은 그대로 수동 소유이며, local artwork provenance만 `provider='local-manual'`로 기록한다. 이는 네트워크 provider나 external binding을 뜻하지 않는다.

## 4. 데이터·API 계약 제안

### 4.1 AV 타입과 메타데이터

기존 name/description/originalTitle/releaseDate/year/runtimeMinutes/productionCompany/myScore/showcase를 재사용한다. `productCode`, `label`, `series`만 AV sidecar에 둔다. 상품 코드/사람 이름은 identity가 아니며 같은 값만으로 작품/사람을 자동 결합하지 않는다.

```sql
CREATE TABLE collection_av_details (
  collection_id TEXT PRIMARY KEY REFERENCES collections(id) ON DELETE CASCADE,
  product_code TEXT CHECK(product_code IS NULL OR length(product_code) <= 120),
  label TEXT CHECK(label IS NULL OR length(label) <= 240),
  series TEXT CHECK(series IS NULL OR length(series) <= 240),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0)
);
CREATE TABLE collection_people (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL CHECK(length(trim(display_name)) BETWEEN 1 AND 120),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX collection_people_by_name ON collection_people(display_name);
CREATE TABLE collection_person_relations (
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES collection_people(id),
  role TEXT NOT NULL CHECK(role IN ('performer','director')),
  sort_order INTEGER NOT NULL CHECK(sort_order >= 0),
  credit_name TEXT CHECK(credit_name IS NULL OR length(credit_name) <= 120),
  PRIMARY KEY(collection_id, person_id, role),
  UNIQUE(collection_id, role, sort_order)
);
CREATE INDEX collection_person_relations_by_person
  ON collection_person_relations(person_id, collection_id);
-- 통합 담당자가 최종 번호를 확정한 migration 끝에서 user_version을 설정한다.
PRAGMA user_version = 46;
```

이 세 table만으로 첫 범위를 완료한다. 기존 table은 재작성하지 않으며 기존 AV 자료를 추정해 backfill하지 않는다. `create_collection(type=av)`는 공통 row를 생성하고 AV 상세 API는 sidecar가 아직 없으면 revision=0/빈 값으로 읽는다. 최초 save에서 sidecar를 만든다.

사람은 UUID로 식별한다. 같은 이름으로 두 명을 만들 수 있고 검색 결과에서 사용자가 정확한 사람 ID를 선택한다. 한 사람은 여러 작품 및 같은 작품의 다른 role에 연결 가능하다. 동일 `(collection,person,role)` 재입력은 오류로 알려준다. role 내 order는 0부터 연속되게 서버가 입력 배열 순서에서 계산한다. 관계 제거는 person을 지우지 않고 Collection 삭제는 관계만 cascade한다. 전역 사람 이름 수정/병합 화면은 첫 범위에 넣지 않는다. 작품별 표기 차이는 `creditName`에 보존한다.

```ts
// app/src/collections/avTypes.ts; avClient.ts의 전용 기본 API를 props로 주입한다.
export type AvPersonRole = "performer" | "director";
export type AvPerson = { id: string; displayName: string };
export type AvPersonCredit = AvPerson & {
  role: AvPersonRole; order: number; creditName: string | null;
};
export type AvDetails = {
  collectionId: string; revision: number;
  productCode: string | null; label: string | null; series: string | null;
  people: AvPersonCredit[];
};
export type AvPersonInput = {
  person: { kind: "existing"; id: string } | { kind: "new"; displayName: string };
  role: AvPersonRole; creditName: string | null;
};
export type SaveAvDetails = {
  expectedRevision: number;
  productCode: string | null; label: string | null; series: string | null;
  people: AvPersonInput[];
};
export interface AvGateway {
  getDetails(collectionId: string): Promise<AvDetails>;
  saveDetails(collectionId: string, input: SaveAvDetails): Promise<AvDetails>;
  searchPeople(query: string): Promise<AvPerson[]>;
  previewArtwork(path: string, surface: CoverSurface): Promise<LocalArtworkPreview>;
  applyArtwork(collectionId: string, input: ApplyAvArtwork): Promise<AvCoverSet>;
  getCoverSet(collectionId: string): Promise<AvCoverSet>;
}
```

전용 Rust DTO는 `library/av_models.rs`가 소유하고 `library/av_collection.rs`는 persistence/validation을 소유한다. commands/av.rs는 JSON mapping만 담당한다. 공통 Summary에는 큰 people 배열을 넣지 않는다. AvGateway는 `avClient.ts`가 기본 구현하고 props로 주입한다. 기존 LibraryGateway에 필수 필드를 추가해 다른 화면의 mock까지 확장하지 않는다. 첫 검색은 현재 제목 검색 범위를 유지하고 사람 검색은 연결 편집에서만 제공한다. type별 AV 목록/별점/발매일 정렬은 기존 규칙을 사용한다. 향후 사람별 작품 찾기는 relation 인덱스를 사용할 수 있으나 첫 범위에 가짜 인물 필터를 추가하지 않는다.

```text
save_av_details(collectionId, input):
  trim optional text; blank -> null; enforce lengths; people <= 100
  begin transaction; require collections.type == 'av'
  read current revision (missing sidecar = 0)
  if current != expectedRevision: return stale_av_details, no writes
  validate existing IDs; create UUID only for explicit new entries
  reject duplicate resolved person ID + role; retain same-name distinct IDs
  delete this Collection's relations; insert role-specific order from submitted list
  upsert AV fields with revision + 1; bump collections.updated_at
  commit; return persisted details
```

초기에는 type 변경이 AV 경계를 넘지 않게 한다. 기존 작품을 AV로 바꾸거나 AV를 다른 타입으로 바꾸는 공통 update는 거절하고 AV 편집 UI에서는 type을 고정한다. 기존 game/manga/movie 사이의 동작은 유지한다. 외부 binding·volume·AV sidecar가 맞지 않는 타입에 남는 암묵적 변환을 피한다.

### 4.2 Artwork role·소유권·preview/apply

`front`는 API/UI에서의 의미이며 DB에는 기존 `cover`로 저장한다. `WorkArtworkKind::Spine`, `Back`만 추가한다. 기존 cover의 ID·경로·선택·volume fallback을 rewrite하지 않는다. 전체 표지 세트는 Collection당 하나이며 판본별 package나 펼친 이미지를 자동 분할하는 기능은 범위 밖이다.

```ts
export type CoverSurface = "front" | "spine" | "back";
export type AvCoverSet = {
  frontId: string | null; spineId: string | null; backId: string | null;
  revision: string;
};
export type LocalArtworkPreview = {
  path: string; surface: CoverSurface; sha256: string;
  width: number; height: number; mimeType: string;
  thumbnailDataUrl: string;
};
export type ArtworkDecision =
  | { kind: "keep" }
  | { kind: "clear" }
  | { kind: "local"; path: string; sha256: string };
export type ApplyAvArtwork = {
  expectedRevision: string;
  front: ArtworkDecision; spine: ArtworkDecision; back: ArtworkDecision;
};
```

- 파일 선택은 기존 Tauri dialog를 사용한다. preview는 선택한 한 장을 읽어 format/size를 검증하고 작은 data URL을 반환한다. DB/managed artwork를 쓰거나 네트워크를 호출하지 않는다.
- apply 전에 같은 path를 다시 읽고 hash를 대조한다. 파일이 바뀌거나 사라지면 기존 선택을 유지하며 중단한다. 파일명/비율만으로 spine/back을 추정하지 않고 사용자가 면을 명시한다.
- 한 장 32 MiB 제한은 기존 상수를 재사용한다. AV preview의 decoded pixel 상한은 16,000,000, thumbnail 최대 변은 360px로 제안하며 `av_artwork.rs` 한곳에서 소유한다. dimensions를 먼저 읽어 full decode 전에 거절한다. 세 면은 순서대로 준비하고 UI에서 세 원본을 동시에 decode하지 않는다.
- provenance key는 `local-manual/{surface}/{sha256}`이다. 같은 bytes를 앞·뒷면에 명시적으로 사용해도 kind가 충돌하지 않는다. 재적용은 기존 행의 ID를 다시 선택한다. 기존 upsert helper를 그대로 호출해 유지된 ID와 새 thumbnail 경로가 불일치하지 않게 한다.
- 기존 `PreparedWorkArtwork`로 파일을 준비하고 모든 검증 후 한 transaction에서 면 선택·updated_at을 갱신한다. DB commit 후에만 prepared를 commit한다. 실패/stale revision은 모두 drop되어 기존 면 집합을 유지한다. `expectedRevision`은 현재 selected IDs/Collection updatedAt에서 만든 불투명 문자열이며 apply 안에서 다시 계산한다.
- `clear`는 selected를 해제하고 후보 원본은 유지한다. 후보 행 삭제·Collection 삭제 후 파일 정리는 기존 WorkArtwork 소유자가 처리한다. preview 취소는 managed 파일을 남기지 않는다.
- 앞면 없이 저장할 수 있지만 case 감상은 시작하지 않는다. 앞면만 있어도 유효하다. 앞면 파일이 없거나 손상되면 placeholder, 책등·뒷면 누락은 중립 두께/앞면 보기로 처리한다. hero/screenshot을 임의로 옆면에 채우지 않는다.
- AV 앞면은 기존 CollectionCard의 `selectedWorkArtworkId` 경로로 표시한다. 새 Summary field는 필요 없다. 면 집합은 detail에서만 읽으므로 Cloud strict DTO에 추가 field가 섞이지 않는다.

### 4.3 향후 외부 provider 계약

외부 AV provider는 선정되지 않았으므로 이번 구현에 adapter·자격증명·poller를 넣지 않는다. 기존 TMDB/IGDB/MangaDex도 변경하지 않는다.

나중의 제공자 계약은 provider namespace + external work/person ID + raw snapshot + 동기화 시각, fresh preview 후보 ID 검증, 명시적 apply, field/role별 keep/set/clear이다. 이름 일치는 후보 표시에만 쓰고 identity 결정에 쓰지 않는다. 기존 director/author 문자열을 자동 people로 변환하지 않는다. 첫 AV 값은 모두 수동 소유로 취급하며 향후 provider 연결에서도 보호한다. 명시적 clear를 미입력으로 해석해 다시 채우지 않는다. 해당 provider를 실제로 구현할 때 field override/role provenance schema를 별도 설계한다.

## 5. 표현과 조작 계약

- 일반 목록은 앞면만 표시한다. 기존 `PhysicalCover`/`GameCase`의 중립 package preset을 AV에도 사용한다. 플랫폼 로고·가짜 책등 글자·가구를 만들지 않는다.
- `drawGameCase`에 optional focused 면 집합/pose를 추가한다. 인자를 생략하면 기존 front projection/lighting/dimensions를 유지한다. 세 면용 별도 렌더링 라이브러리 대신 같은 package projection에 면 texture를 전달한다.
- `CompleteCoverViewer`는 shared Dialog/BackNavigation을 쓰는 focused UI다. renderer 생성과 입력 image 수명은 `physical/collectibleRuntime.ts`가 소유한다. 목록·Showcase는 정적 앞면 캐시, focused dialog는 canvas 하나만 사용한다.
- 고정 stop은 front=0°, spine=90°, back=180°다. 기본은 앞면이며 존재하는 면만 stop에 포함한다. 좌우 화살표는 이전/다음 stop으로 이동하고 양 끝에서 멈춘다. 버튼에도 앞면/책등/뒷면을 표시한다. Home은 앞면, Esc는 viewer만 닫고 opener로 focus를 돌린다. 입력란/편집 dialog의 화살표는 가로채지 않는다.
- 첫 완결 형태는 즉시 snap으로 구현한다. 연속 drag·관성·자동회전은 넣지 않는다. 짧은 transition을 추가하더라도 reduced-motion에서는 없애고 실제 면만 그린다. 없는 책등/뒷면을 보이게 회전시키지 않는다.
- 읽기 실패한 stop은 빼고 앞면으로 돌아간다. 원본 보기 버튼은 현재 실제 면을 일반 img로 표시한다. 이미지 비율을 지키고 crop하지 않는다.
- book/case 모두 one-live-owner를 공유한다. 다음 focused view가 열리면 이전 owner를 abort/dispose한다. 케이스 면은 최대 세 장, 단변이 아닌 **최대 변 1024px** 상당으로 decode하여 합계 12 MiB 추정 한도를 지킨다. 출력은 DPR1.5/1.4Mpx 상한, hidden/close/scope 변경 시 취소·해제, idle draw는 0이다.
- cache key는 library scope + 각 면 ID/URL + revision + stop + pixel bucket이다. 일반 front grid key에 side/back을 넣어 모든 타일을 다시 만들지 않는다.
- Manga Paperback FINAL의 형상·조작, Movie flat poster를 유지한다. LONG-004는 나중에 이 공유 면 계약/preset을 사용할 수 있지만 여기서 Shelf 화면을 만들지 않는다.
- AV 상세는 앞면, 작품명/품번/출시일/제작사, 출연자·감독, 아트워크, 개인 정보 순서다. 기존 sidebar portal을 쓰고 provider/debug 카드 설명을 나열하지 않는다.
- 기존 privacy mode는 img/canvas를 unmount한다. 감상 중 mode를 켜거나 면을 잃었을 때 focus도 확인한다. 이 표시 가림은 암호화나 Cloud 공개 통제가 아니다.

## 6. 타입 확장의 전체 surface

| Surface | 변경/확인 |
| --- | --- |
| Rust enum·SQL parser·serializer | `CollectionType::Av`, 명시적인 av parse, create/update 검증과 AV 경계 타입 변환 거절 |
| TS shared contract/gateway | CollectionType union, 독립 avClient.ts invoke. AV DTO/API는 feature-owned file |
| 목록·빈 상태·type control | Browser label/options, 수동 추가 AV empty state. 기존 provider action을 AV에 노출하지 않음 |
| preference/shell | 저장된 av type 재읽기, WorkspaceNavigation fallback, per-type av state, App Record 접근 |
| detail/edit | AV detail 명시. generic covers/Manga volume sync/TMDB·IGDB refresh로 빠지지 않음. 공통 AV 출시일/runtime/제작사 유지 |
| 검색·정렬·별점 | AV 제목 검색, 기존 출시일/year/missing-last 정렬과 정확한 별점 필터. 인물 검색은 별도 연결 편집 API |
| Card/Showcase | AV credit은 productionCompany, movie director로 암묵 fallback하지 않음. 타입별 수동 membership/order와 9/10/16/17 경계, 스크롤/focus 복귀 |
| artwork/media | cover=front 호환, spine/back label, 선택 역할 격리, 기존 native artwork/thumbnail route 재사용. 임의 path 배포 route 추가 없음 |
| provider/local legacy/import | 기존 type guard 유지. book import unknown→manga를 AV import로 해석하지 않음. 새 명시적 로컬 파일 flow, source folder 재스캔 없음 |
| Online Catalog | AV 검색/provider 대상으로 사용하지 않음. catalog DB/bookmark/read progress 변경 없음 |
| Asset/Classification/Album | 기존 Collection 참조. people를 Classification/캐릭터 WIP와 섞지 않음. Artwork 자동 Asset화 없음 |
| 통계/Revisit | 전체 Collection count/open에 AV 포함. Asset Revisit scoring/events 변경 불필요. 통계 이름의 privacy는 기존 UI 규칙 확인 |
| Cloud replica | **export SQL에서 type IN ('game','manga','movie')를 AND**. AV를 metadata/file 수집 전에 제외. 기존 OR 괄호 유지 |
| Server/Mobile/Android | 3종 DTO 유지, AV 표시 없음. 서버 배포/APK 업데이트 불필요. 기존 세 타입 전체 snapshot 보존 fixture |
| PC recovery point | 전체 DB backup에는 AV 포함. Mobile 공개 제외와 다른 경로이며 암호화/backup 제외라고 설명하지 않음 |

```sql
WHERE (collection.legacy_kind IS NULL OR collection.legacy_kind <> 'gacha')
  AND collection.type IN ('game','manga','movie')
ORDER BY collection.updated_at DESC, collection.id DESC
```

이 filter는 AV를 Collection replica에 보내지 않는 초기 제품 경계이며 Private Vault가 아니다. 현재 코드 계약에서는 AV remote 공개가 성립하지 않지만 운영 상태는 이 조사에서 확인하지 않았다. 기존 세 타입의 전체 snapshot을 보존해 서버 replace-all로 다른 작품이 사라지지 않게 한다. 지원하지 않는 type을 이유로 빈 배열을 전송하지 않는다.

## 7. 파일 소유권과 실행 배치

통합 담당자가 `lib.rs`, `commands.rs`, `library/mod.rs`, `library/db.rs`, migration 번호, `server/lakomics-api/app.py` 등록을 소유한다. 후속 배정에서 허용하면 AV 담당자가 `models.rs` Collection 타입, `app/src/library/types.ts` Collection/Gateway 절, `client.ts` Collection 절을 편집한다. 다른 절로 범위를 넓히지 않는다. 영상 담당자는 독자 DTO를 사용하고 Collection 타입을 동시에 수정하지 않는다.

### A — 수동 AV와 인물 관계 완결

Files: 새 `library/av_models.rs`, `library/av_collection.rs`, `library/av_collection_tests.rs`, `commands/av.rs`, `collections/avTypes.ts`, `AvCollectionDetail.tsx`, `AvEditPanel.tsx`, `AvEditPanel.test.tsx`. 변경 `collection.rs`, `CollectionBrowser.tsx`, `collectionLibrary.ts`, `CollectionEditDialog.tsx`, `CollectionOverlay.tsx`, `CollectionCard.tsx`, `CollectionInfoPanel.tsx`, `preferences/uiPreferences.ts`, `layout/WorkspaceNavigation.tsx`, `cloud/collections.rs`. 공유 등록 파일은 위 소유권을 따른다.

Consumes: 기존 Create/UpdateCollection과 Gateway. Produces: 4절 AvDetails/people API와 수동 AV 화면. 표지 없이도 작성·수정·닫기·재조회·Showcase가 가능하다.

- [ ] 0046 후보와 v44/v45 조합을 통합 담당자와 확정하고 FK 대상을 다시 확인한다.
- [ ] 위 SQL/DTO/transaction을 구현한다. 같은 이름의 다른 사람과 같은 ID의 다른 역할을 fixtures로 구분한다.
- [ ] AV 타입·state·preferences·Cloud export 제외를 **같은 배치**에서 완료한다. 생성은 가능하지만 전체 동기화가 실패하는 중간 상태를 납품하지 않는다.
- [ ] `AvEditPanel`은 품번/label/series/출연자/감독을 편집한다. 기존 사람 선택 또는 명시적 신규 생성이다. 공통 Collection 폼과 별도 저장이므로 서로 다른 API의 두 단계 저장을 원자적 저장처럼 표현하지 않는다.
- [ ] 역할별 위/아래 버튼으로 순서 변경, 행 삭제로 관계 해제. stale save는 입력 draft를 유지하고 재조회 안내를 표시한다.
- [ ] 관련 Rust/React 검사와 공유 타입 검사를 실행한다. 이후 변경이 결과를 무효화하지 않으면 다시 실행하지 않는다.

### B — 로컬 세 면 preview/apply 완결

Files: 새 `library/av_artwork.rs`, `library/av_artwork_tests.rs`, `collections/AvArtworkDialog.tsx`, `AvArtworkDialog.test.tsx`. 변경 `work_artwork.rs`, `av_models.rs`, `commands/av.rs`, `avTypes.ts`, `AvCollectionDetail.tsx`, `WorkArtworkGallery.tsx`. Gateway mapping도 같은 AV 담당자가 소유한다.

Consumes: A의 AV identity, 4.2절 DTO, 기존 PreparedWorkArtwork. Produces: 재시작 후 남고 offline에서 읽는 cover set. C의 renderer가 없어도 앞면/일반 gallery로 감상 가능하다.

- [ ] preview path/hash/치수 제한과 작은 thumbnail을 구현한다.
- [ ] 세 면에 keep/clear/local을 표시하고 apply에서 현재 revision/hash를 재검증한다.
- [ ] kind mapping, role 포함 provenance identity, 후보 재사용, prepared rollback을 구현한다.
- [ ] 오류/취소/재적용/동일 bytes 다른 role/Collection 삭제 fixtures를 확인한다. Asset ingest/provider network 호출이 없어야 한다.

### C — 같은 package renderer의 전체 표지 감상

Files: 변경 `drawGameCase.ts`, `physical/collectibleRuntime.ts`, `physical/PhysicalCover.tsx`, `physical/physicalCollections.css`. 새 `physical/CompleteCoverViewer.tsx`, `physical/CompleteCoverViewer.test.tsx`. `AvCollectionDetail.tsx`에서 연결한다. `GameCase.test.tsx`, `physical/RenderCache.test.ts`에는 실제 회귀 위험에 해당하는 검증만 추가한다.

Consumes: B의 AvCoverSet. Produces: 5절의 세 면 stop/original fallback/one-live-owner 해제. LONG-004 화면은 만들지 않는다.

```ts
type CasePose = "front" | "spine" | "back";
type CaseFaces = {
  front: HTMLImageElement | null;
  spine: HTMLImageElement | null;
  back: HTMLImageElement | null;
};
type FocusedCase = { pose: CasePose; faces: CaseFaces };
// drawGameCase에 focused?: FocusedCase 추가. 기존 3인자 호출의 모양은 유지.
const availableStops = (faces: { frontId: string|null; spineId: string|null; backId: string|null }): CasePose[] =>
  !faces.frontId ? [] : ["front", ...(faces.spineId ? ["spine"] : []), ...(faces.backId ? ["back"] : [])] as CasePose[];
```

- [ ] 같은 draw 함수의 optional focused 인자를 구현하고 기존 front 분기를 보존한다. 새 shader/framework를 도입하지 않는다.
- [ ] runtime live owner를 book/case가 공유한다. 이미지 읽기 중 닫기/전환은 abort하고 현 owner만 결과를 받는다.
- [ ] Dialog/BackNavigation, stop 버튼, 키보드, 원본 보기, privacy/reduced-motion/읽기 실패 처리를 구현한다.
- [ ] D에서 앞뒤 방향·거울상·접합부·비율을 실제 그림으로 확인한다. jsdom canvas stub 결과만으로 완료를 주장하지 않는다.

### D — 경계·이행 확인과 인계

Files: 영향 범위의 기존 tests, `library/db.rs` migration tests는 통합 담당자 소유. 실제 구현 후 `docs/agents/lakomics-works-handoff-v2.md`, `CONTEXT.md`의 구현 범위를 필요한 만큼 수정한다. backlog는 사용자 기록 지시/통합 담당자 판단에 따라 갱신하며 provider/LONG-004를 DONE으로 만들지 않는다.

Consumes: A-C 최종 코드. Produces: fixture/static/browser/native를 구분한 결과와 남은 운영 승인 gate.

- [ ] 아래 fixture 중 변경 범위에 대응하는 검사를 실행한다.
- [ ] 격리 fixture library에서 native picker → preview → apply → offline 재조회 → 삭제를 검증한다. 운영 라이브러리를 쓰지 않는다.
- [ ] 운영 migration/앱 시작 승인은 별도로 남긴다. 테스트 합격을 운영 적용 권한으로 간주하지 않는다.

## 8. 구체적 fixture와 기존 명령

**아래는 실행 예정이며 문서 작성 중에는 실행하지 않았다.** 현재 `app/package.json`의 `test=vitest run`/`mobile:test`, 확인한 `app/src-tauri/Cargo.toml`을 사용한다.

| Fixture | 기대 결과 |
| --- | --- |
| Fixture AV, UUID-A와 UUID-B의 동일 이름 | 두 identity 유지, 다른 작품에 A를 재사용해도 B와 합치지 않음 |
| A performer + A director, 또는 A performer 중복 | 다른 role은 허용, 같은 ID/role 중복은 transaction 실패 및 기존 관계 유지 |
| 사람 순서 B→A, creditName 별도 표기 | 재조회 후 순서/표기 유지, global displayName 불변 |
| 빈 이름/121자 이름/100인 초과/없는 ID/비AV ID | 입력 오류, 일부 person/sidecar만 저장되는 상태 없음 |
| revision3을 두 panel에서 저장 | 하나는 revision4, 나머지는 stale 및 draft 유지 |
| 빨간 FRONT/초록 SPINE/파란 BACK synthetic 이미지 | 정확한 면, 실제 이미지 사용, 좌우/뒷면 거울상 없음 |
| 앞면만/앞+뒤/앞+책등/세 면/앞면 없음 | 실재 stop만 표시, 누락은 중립/앞면, 앞면 없으면 case 시작 안 함 |
| preview 뒤 파일 변경/손상PNG/33MiB/16Mpx 초과/둘째 준비 실패 | rollback과 기존 선택 유지, managed 파일 잔여 없음 |
| 동일 bytes 앞·뒤 적용 및 재적용 | role identity 충돌/불필요 후보 증가/thumbnail ID 불일치 없음 |
| 뒷면 clear/앞면 clear/Collection 삭제 | 무관한 hero/volume/Asset 불변, 후보와 선택 구별, 삭제 시 소유 파일 정리 |
| game/manga/movie/av/gacha Cloud fixture | 기존 세 종류 전부, AV/gacha 제외, AV artwork path를 열거나 업로드하지 않음 |
| v44→v45→v46, 기존 cover/hero/volume/binding/Showcase/characters | ID·선택·관계 수 유지, 새 table 추가, FK check 빈 결과, 재open 중복 없음 |
| 800×640 / 1536×960, DPR1.125/1.25/2, 긴 한일 이름 | overflow 없음, 표지와 조작 영역 비중첩, 목록 scroll/focus 복원 |
| case→book→case→privacy/hidden/close | live owner 최대1, pending load 해제, idle draw 증가0, 가려진 이미지 잔류 없음 |

각 배치에 해당하는 명령만 선택한다. PowerShell에서 프로세스 종료코드를 보존하고 뒤 명령으로 tsc 실패를 가리지 않는다.

```powershell
# cwd C:\chatgpt\app\src-tauri — A
cargo test --lib av_collection
# B
cargo test --lib av_artwork
cargo test --lib work_artwork::tests
# Cloud filter와 migration 등록 담당자가 변경 후 확인
cargo test --lib cloud::collections::tests
cargo test --lib library::db::tests

# cwd C:\chatgpt\app — A
npm test -- src/collections/AvEditPanel.test.tsx src/collections/CollectionBrowser.test.tsx src/collections/CollectionEditDialog.test.tsx src/collections/collectionLibrary.test.ts src/preferences/uiPreferences.test.ts
# B
npm test -- src/collections/AvArtworkDialog.test.tsx src/collections/WorkArtworkGallery.test.tsx
# C
npm test -- src/collections/physical/CompleteCoverViewer.test.tsx src/collections/GameCase.test.tsx src/collections/physical/RenderCache.test.ts src/collections/MangaCoverViewer.test.tsx
# 최종 공유 타입 변경에 한 번
npx tsc --noEmit
$avTypeCheckExit = $LASTEXITCODE
Write-Output "tsc exit=$avTypeCheckExit"
exit $avTypeCheckExit
```

추가 tests의 fixture는 위 표와 일치시킨다. Cargo filter가 0 tests면 성공으로 취급하지 않고 module 등록을 확인한다. 초기 계획은 server/mobile 코드 변경이 없으므로 운영 HTTP/server·Android 전체 build가 필요 없다. 변경이 실제로 이어질 때만 `server/lakomics-api/tests/test_mobile_collections.py` / `npm run mobile:test -- Collections.test.tsx`를 선택한다.

UI는 격리 fixture로 실제 렌더를 확인하며 static 결과와 구분한다. native 검증은 `cd C:\chatgpt\app` 이후 `npm run tauri -- dev`만 사용한다. debug 실행파일 직접 실행은 금지이며 운영 library가 자동 선택될 상태로 시작하지 않는다.

## 9. Backup / migration / rollback gate

1. **실행 전 확인:** HEAD/status, schema, watcher, library 설정을 재확인한다. v44 WIP와 v45 통합을 보존한다.
2. **fixture 선행:** 기존 자료가 있는 v44/v45 fixture로 schema/FK/CRUD/삭제/재조회/표지·권 identity를 확인한다. 운영 DB에 fixture를 넣지 않는다.
3. **운영 적용 권한:** `C:\New_lakomics_assets`에 쓰기 전 사용자 승인이 필요하다. 구현 승인만 받은 경우 여기서 운영 검증을 구분해 보고한다.
4. **일관된 snapshot:** 기존 `create_verified_snapshot` SQLite backup API를 사용한다. WAL이 열린 DB 파일을 단순 복사하지 않는다. snapshot quick_check/user_version/FK/기존 수를 확인하고 pre-migration backup을 덮어쓰지 않는다.
5. **원본 보호:** DB backup에는 이미지 bytes가 없다. 로컬 표지 source를 보존하고 `work-artwork/` 원본과 DB의 대응을 별도로 보호한다. thumbnail은 다시 만들 수 있지만 DB 복원만으로 AV 표지까지 돌아온다고 설명하지 않는다.
6. **적용:** 기존 migration runner의 transaction/FK check를 사용한다. table rebuild/Collection type 일괄변경/legacy 재import/catalog 또는 full Cloud backfill을 하지 않는다.
7. **받아들이기:** 승인된 운영 실행에서 기존 세 타입과 이미지 읽기를 확인한다. 새 AV 쓰기는 승인된 자료만 사용한다. Cloud publication은 별도 권한이며 수동 AV 사용에 필수는 아니다.
8. **되돌리기:** 새 schema를 구 binary로 강제로 읽거나 PRAGMA만 낮추지 않는다. 새 변경분 손실 범위를 설명하고 승인된 복구 시 검증한 이전 DB와 대응 원본을 기존 restore 절차로 복구한다. v44 캐릭터 상태를 포함한 직전 backup을 보존한다.

## 10. 계획 검토 결과와 남은 판단

PC navigation/preferences/CRUD/Showcase/legacy/provider/Cloud·Mobile/통계/backup까지 타입 확장 영향을 조사했다. 부모 table 재작성과 기존 앞표지 이행은 필요 없다. 단일 v46 후보 schema와 A→B→C의 작은 완결 배치를 권장한다.

외부 AV provider의 사양·자격증명·제공 표지/인물 ID는 미조사·미선정이다. 수동 기능 완료와 구분해 이후 선택한다. 실기기 렌더링/native picker/운영 schema 수용 결과는 이 계획이 증명하지 않는다. LONG-004나 Private Vault를 시작하는 판단도 포함하지 않는다.

## 11. 승인 후 구현 기록

2026-09-08 후속 실행 승인에 따라 A/B/C를 구현했다. 원래 계획과 비교해 실제 native preview wire는 PNG `thumbnailBytes`이며 frontend가 표준 `btoa`로 작은 data URL을 만든다. 새 base64 의존성을 추가하지 않았다. API는 독립 `avClient.ts`를 주입한다.

focused 감상의 초기 구현은 회전 애니메이션 없이 실제 선택면을 정면으로 보는 snap이다. `drawGameCase`의 같은 projection을 사용하며 기존 3인자 grid 호출은 보존한다. native 360px thumbnail 한 장으로 제한된 표지 보기를 그리고 원본 보기에서만 원본을 읽는다. 따라서 큰 감상창의 기본 snap 화질은 원본보다 낮을 수 있으며, 실기기 시각 수용 전까지 고해상도 품질을 검증했다고 보고하지 않는다. 앞·책등·뒤의 임의 각도 3D 회전은 구현 범위에서 제외했다.

첫 targeted frontend 실행은 실제 exit 0, 22 files / 193 tests였다. jsdom canvas 미구현 경고가 있었으므로 이 결과는 interaction/상태·기존 UI 회귀 증거이며 실제 렌더 증거는 아니다. 최초 `npx tsc --noEmit`은 동시 작업 중 SettingsView의 새 MobileCatalogPublishSettings 파일이 아직 없어 exit 1이었다. 최종 타입 검사는 통합 담당자가 최종 파일 상태에서 확인한다. native 결과와 최종 검사 결과는 통합 보고에 남긴다.

통합 담당자가 확인한 native 증거: 컴파일된 Cargo test binary의 `av_` filter가 exit 0 / 9 passed, `cloud::collections::tests`가 exit 0 / 8 passed + 운영 게시용 1 ignored, DB migration tests 28 passed였다. 수정된 preference/기존 GameCase/focused interaction 후속 검사는 7 files / 41 tests, 새 AV 상세/privacy 검사는 exit 0 / 1 test였다. 독립 native picker·실제 canvas 외형·운영 migration은 실행하지 않았다.

## 12. 최종 통합 검증 — 2026-09-08

수동 AV/people/세 면 artwork와 focused cover 구현은 schema 46 통합 상태에서 닫혔다.
AV artwork/backup restore 4개 검사가 통과했고 전체 Rust는 769 passed / 0 failed,
전체 frontend는 893 passed / 0 failed였다. 실제 `tauri build --debug --no-bundle`도
성공했고 새 WebView2 profile에서 `http://tauri.localhost/`, title `Lakomics`, dev server
미사용 상태로 창이 정상 응답하는 것을 확인했다.

남은 항목은 구현 결함이 아니라 운영/제품 수용 범위다: `C:\New_lakomics_assets`의 실제
schema migration, native file picker로 real cover 선택, focused cover의 주관적 native visual
수용, 그리고 아직 선정하지 않은 외부 AV provider이다. 이번 검증은 그 경계를 실행하지 않았다.
상세 로그는 `parallel-roadmap-execution-20260908.md`를 따른다.
