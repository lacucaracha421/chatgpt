# MOBILE-006 모바일 만화 카탈로그 실행 제안 — 역사 기록

> 상태 정리 (2026-09-09, 소스 `0c61206`): 아래는 2026-09-08 계획과 당시 통합 검증 기록이다.
> 이후 카탈로그 v2 서버/Reader 배포와 Android 0.4.3 리더 구현이 진행되었다.
> 현재 범위와 남은 APK 설치·네이티브 검증은 [MOBILE-006](../roadmap/lakomics-backlog.md#mobile-006--shared-manga-catalog-browsing) 및 [Android README](../../android/README.md)를 따른다.
> 아래의 미구현·미배포·Reader 후속 작업 표현과 체크박스는 해당 시점의 상태이며 현재 실행 지시가 아니다.
> 이 문서 갱신은 운영 상태를 새로 검증하거나 기존 배포·publication 재실행을 승인하지 않는다.

작성일: 2026-09-08. 현재 체크아웃 소스에 대한 read-only 조사로 작성했습니다. 이 문서는 [MOBILE-006](../roadmap/lakomics-backlog.md#mobile-006--shared-manga-catalog-browsing)을 구체화하는 실행 제안이며, 별도 백로그나 구현 완료 기록이 아닙니다. 기존 캐릭터 v44 WIP 및 실행 중인 dev 상태를 변경하지 않았고 테스트·빌드·앱 재시작·Git 쓰기·배포·운영 자료 쓰기를 수행하지 않았습니다.

**목표:** PC가 꺼져 있어도 현재 PC 카탈로그의 그룹 목록, 검색, 상세, 판본 목록, 북마크 필터를 Android에서 읽습니다. 사용자 자료의 권위는 PC에 남습니다.

**추천 구조:** PC가 확정한 카탈로그 내용과 그룹 결과를 명시적으로 내보내고 기존 FastAPI 서버가 버전별 SQLite 검색 복제본으로 게시합니다. Python은 PC의 검색식/조회 의미를 좁게 이식하며, 그룹 정체성이나 사용자 판단을 새로 계산하지 않습니다. 읽기 요청은 내용 버전과 사용자 snapshot 버전에 고정합니다.

**기술:** 현재 Rust/rusqlite/ureq, Python FastAPI/sqlite3, React/TypeScript, 기존 Java Android bridge를 사용합니다. 새 서버 런타임, 검색 엔진, Gradle/Kotlin/Capacitor, npm/Python 의존성 추가는 기본안에 없습니다.

실행자는 `writing-plans` 방법의 파일 소유권·작은 작업·구체적 검증을 사용합니다. 사용자의 후속 구현 승인은 이 제안 작성 중 전달되었지만 이 문서 작성 담당은 계획까지만 수행했습니다. 구현은 통합 담당이 아래 계약과 공통 파일을 조정한 뒤 진행합니다. 운영 배포·서비스 변경·첫 운영 게시/수집·Git 쓰기는 별도의 명시적 승인 경계입니다.

## 1. 확인한 현재 사실

| 근거 | 현재 사실과 계획에 미치는 영향 |
|---|---|
| `CONTEXT.md:55`, `docs/adr/0033-local-authority-with-optional-cloud-sync.md:7` | Online Catalog는 Collection과 독립입니다. 로컬이 권위 원본이고 VPS는 선택적 복제본입니다. Collections나 Capture 테이블에 카탈로그를 넣지 않습니다. |
| `docs/agents/mobile.md:7`, `android/README.md:3`, `app/mobile-client/App.tsx:20` | 현 제품은 독립 Android APK 및 `app/mobile-client`입니다. 기존 `mobile/`, `extension/src/mobile-*`는 이번 변경의 기반이 아닙니다. |
| `server/lakomics-api/app.py:288`, `:382`, `:406` | `/v1/catalog/search-page`와 `/gallery/{id}`는 upstream 운송 프록시입니다. PC의 로컬 검색/차단/그룹/북마크 조회 API가 아닙니다. |
| `app/src-tauri/src/library/catalog_provider.rs:1`, `:81`, `:93` | 공개 identity는 `(provider, providerWorkId)`이며 work ID는 문자열입니다. `kHentai`가 현재 구현 provider이고 `heliotrope`는 namespace만 예약되어 있습니다. |
| `app/src-tauri/src/library/models.rs:1114`, `app/src/library/types.ts:187` | 정렬은 latest/views/hotDay/hotWeek/hotMonth, 범위는 all/bookmarked, 언어는 korean/japanese 또는 전체입니다. |
| `app/src-tauri/src/library/catalog_query.rs:4`, `:238`, `:272`, `:472` | 검색은 UTF-8 4,096바이트/256토큰 한도, OR/AND/NOT·암시적 AND·괄호·인용문·태그·id/category/uploader/pages를 지원합니다. title LIKE wildcard를 escape하며 tag 값은 exact match입니다. |
| `app/src-tauri/src/library/catalog_visibility.rs:9`, `:25` | 숨긴 category와 차단 `(namespace,value)`는 library DB의 사용자 자료입니다. `revealBlocked`만 이 정책을 우회하며 language와 Expunged 조건은 우회하지 않습니다. |
| `app/src-tauri/src/library/catalog_group_query.rs:60`, `:356`, `:426` | eligible=활성+언어+가시성, matching=eligible+검색+북마크+hot입니다. 정렬 donor와 화면 대표판이 다릅니다. 그룹을 고른 뒤 대표판을 고르며 raw page를 프런트에서 합치지 않습니다. |
| `app/src-tauri/src/library/catalog_group_api.rs:42`, `:219`, `:255` | PC는 usable page를 exact count보다 먼저 전달합니다. 그룹 handle은 anchor로 해석하며 언어/정책상 숨은 선택판 ID는 노출하지 않습니다. |
| `app/src-tauri/migrations/0035_online_catalog_groups.sql:1`, `0037_catalog_review.sql:1` | durable handles/preferences/review decisions와 파생 membership이 구분됩니다. confirm/falsePositive/split 결정을 title 유사도로 덮어쓸 수 없습니다. |
| `app/src-tauri/src/library/catalog_preparation.rs:30`, `:114`, `:179` | 전용 읽기 연결과 catalog file lock이 있습니다. 검색은 preparation을 시작하지 않습니다. legacy revision 초기화와 preparation은 쓰기이므로 exporter가 몰래 호출하면 안 됩니다. |
| `app/src-tauri/src/library/online_catalog.rs:58`, `:714`, `catalog_revision.rs:6` | 북마크는 provider-qualified library 행입니다. 썸네일은 인증정보 없는 HTTPS ehgt.org 하위 호스트만 허용합니다. contentRevision은 canonical catalog 내용 변경용이며 사용자 변경 revision을 대신하지 못합니다. |
| `server/lakomics-api/mobile_collections.py:123`, `:180`, `app/src-tauri/src/cloud/collections.rs:71` | 기존 명시적 PC publication, CAS, immutable artwork 선행 처리 패턴을 참고할 수 있습니다. 12MiB Collection JSON과 전체 메모리 적재를 대형 catalog에 복사하지 않습니다. |
| `android/src/com/lakomics/mobile/NetworkPolicy.java:17`, `CloudClient.java:16`, `app/mobile-client/transport.ts:27` | Android는 API 경로/메서드 allowlist, native bearer 보관, 취소와 timeout을 사용합니다. 일반 API 응답은 4MiB, HTTP read timeout은 20초, JS bridge timeout은 45초입니다. |
| `app/package.json:9`, `app/vitest.mobile.config.ts:2`, `android/build.ps1:1` | npm mobile:test/mobile:build, 별도 모바일 tsconfig와 기존 Java compile/test 스크립트가 있습니다. |

파일 메타데이터만 확인한 현 active `catalogs/kdata.db` 크기는 **153,477,120 bytes(약 146.4MiB)**, WAL은 0 bytes였습니다. `suggestions.json`은 3,026,633 bytes, `tag-ko.json`은 372,149 bytes입니다. 이 수치는 행 수·검색 성능·내보낸 파일 크기를 증명하지 않습니다. 운영 DB를 열거나 hash/전체 query를 실행하지 않았습니다. 로컬 migration은 현재 `0044_characters.sql`까지 있으므로 번호를 선점하지 않습니다.

관련 제약: ADR-0022(구조 변경 전 별도 검증 백업), ADR-0023(중단 후 안전한 재시도), ADR-0033(로컬 권위), `docs/agents/catalog-troubleshooting.md`의 bounded canary/기존 DB 보존 원칙을 적용합니다. MOBILE-007 북마크 쓰기 및 MOBILE-008 updater/worker는 `backlog:853-859`의 별도 작업입니다.

## 2. 대안과 기본 결정

| 대안 | 장점 | 비용/문제 | 판단 |
|---|---|---|---|
| PC live query 또는 기존 upstream proxy | 초기 코드가 작음 | PC-off, 그룹/가시성/북마크 의미를 충족하지 않음 | 제외 |
| PC projection + 기존 Python/SQLite 검색 | 운영 런타임 유지, 확정 그룹을 그대로 소비, 독립 게시/rollback | parser/SQL 의미 이식에 drift 위험이 있어 Rust parity gate 필수 | **추천** |
| Rust query core 추출 후 VPS 전용 binary/service | 검색 구현 공유 가능 | 현재 Library/타입/준비상태 결합을 풀고 새 Linux build·배포·프로세스를 관리해야 함 | Python parity나 성능 gate를 충족하지 못할 때만 재검토 |

첫 전달은 수동 PC 게시 버튼, 서버 read API, Android 탐색까지 완성합니다. 전체 검색 엔진 도입·자동 게시 루프·서버 수집 worker·북마크 mutation·로컬 만화파일 업로드·offline 다운로드를 추가하지 않습니다. 검색 자동완성은 필수 첫 전달에서 제외하되 기존 Boolean 검색 자체를 축소하지 않습니다.

기본 UI는 한국어 scope, latest, all, revealBlocked=false, page size 40입니다. 한국어/일본어/전체 선택과 다섯 정렬을 제공합니다. PC의 저장된 category/tag 정책과 대표판을 적용하고, reveal 동작은 검색 세션에서만 유지합니다. PC UI의 마지막 선택 언어를 동기화한다는 뜻은 아닙니다.

## 3. 자료 권위와 버전 계약

세 가지를 분리합니다.

1. **PC canonical 내용**: `catalogs/kdata.db`의 Works/Tags 및 contentRevision. 서버는 직접 upstream crawl하지 않습니다.
2. **PC 사용자 자료**: bookmarks, hidden categories, blocked tags, group handles/preferences, authoritative review decisions. 원본은 library.sqlite에 남습니다. 서버가 내려보낸 자료로 이를 역갱신하지 않습니다.
3. **서버 파생 자료**: schema가 고정된 content artifact, group membership/handle resolution, query indexes, exact default counts, 사용자 read snapshot, publication pointer. 재생성 가능하며 raw PC SQLite를 서버에 올리지 않습니다.

제안 revision 정의:

```text
contentDigest = SHA256(exact canonical UTF-8 NDJSON content artifact bytes)
decisionRevision = SHA256(canonical sorted authoritative review decisions)
userRevision = SHA256(canonical sorted UserSnapshotV1 JSON)
publicationRevision = SHA256("mobile-catalog-v1" + contentDigest + userRevision)
```

artifact manifest의 `sourceRevision`은 PC contentRevision을 그대로 보존하고, `groupGeneration`, `groupDecisionRevision`, `contractVersion:1`, `schemaVersion:1`, 예상 각 row count를 함께 보냅니다. `groupDecisionRevision`과 UserSnapshot의 decisionRevision이 같아야 게시합니다. content artifact의 그룹은 이 사용자 판단으로 확정된 결과이며 서버가 confirm/split을 다시 해석하지 않습니다.

UserSnapshot은 `[provider,workId,createdAt]` bookmark, hidden category, exact blocked tag, `[provider,anchorWorkId,selectedWorkId,editRevision]` preference 및 review decision 원문 필드를 가집니다. content에서 사라진 work의 북마크와 선택은 snapshot에서 삭제하지 않습니다. 조회 결과만 표시할 수 없으며 이후 재등장하면 다시 적용됩니다. Heliotrope bookmark를 지우지 않지만 Heliotrope 검색은 명확히 unsupported입니다.

서버가 받는 snapshot은 PC의 완전한 read snapshot이고 MOBILE-006 중 모바일에서 추가한 자료는 존재하지 않습니다. MOBILE-007이 도입되면 기존 full snapshot 게시로 receipt/ack되지 않은 mobile operation을 덮어쓸 수 없도록 **별도 계약 버전 변경/호환 차단**을 해야 합니다. 이 계획은 미래 mobile writes가 이미 안전하다고 주장하지 않습니다.

## 4. 내보내기와 서버 저장 형태

### 4.1 content artifact

신규 NDJSON record 형식은 `{kind:"manifest"|"work"|"tag"|"member"|"handle"|"translation", value:{...}}`입니다. manifest 한 줄이 먼저 오고 나머지는 kind와 PK 순서로 정렬합니다. 알 수 없는 kind/field, 중복 PK, 부정합 counts, provider, 참조를 거부합니다. 제목 유사도나 crawl token은 서버로 보내지 않습니다.

필드 allowlist:

```text
work: Id,Title,TitleJpn,Category,Uploader,Posted,Updated,FileCount,FileSize,Rating,Views,Thumb,Expunged
tag: WorkId,Namespace,Value
member: provider,work_id,catalog_work_id,group_id,thumbnail_valid,completeness,lineage_terminal
handle: provider,anchor_work_id,group_id,sequence
translation: namespace,value,label
```

null/원래 정수 Posted를 보존합니다. PC와 동일한 sort/hot SQL은 원래 값을 쓰고, 공개 posted/updated 값은 `normalize_legacy_timestamp` 규칙으로 Unix seconds에 맞춥니다. `Id`는 서버 내부 INTEGER, 공개 providerWorkId는 문자열입니다. `Thumb`는 기존 `validated_thumbnail_url` 규칙을 통과할 때만 공개됩니다. 첫 전달에서 표지는 검증된 HTTPS URL로 읽으며 실패 시 빈 표지와 제목이 남습니다. PC 전용 `http://lakomics.localhost/...` URL은 발행하지 않습니다. 지속적인 native thumbnail cache 및 서버 이미지 프록시는 별도 실측 필요가 생길 때 추가합니다.

신규 서버 `mobile_catalog_replica.py`가 artifact를 고정 DDL의 새 SQLite에 적재합니다. 임의 SQLite 파일·SQL·테이블명을 업로드받지 않습니다. query 호환을 위해 `Works`, `Tags`, `online_catalog_group_members`, `online_catalog_group_handles` 이름과 lookup/rank/posted/reverse indexes를 유지하고 read 연결에서 artifact를 `catalog` alias로 attach합니다. UserSnapshot은 publication 준비 시 한 번만 별도 `{publicationRevision}-users.sqlite`로 적재하며 main DB의 bookmarks/hidden_categories/blocked_tags/preferences 이름을 기존 query와 맞춥니다. read마다 JSON을 파싱하거나 사용자 테이블을 다시 만들지 않습니다. 따라서 policy/bookmarks/preferences에 대한 좁은 SQL 포트가 가능합니다.

기본 한도는 NDJSON 전체 512MiB, record 1MiB, UserSnapshot 8MiB, 서버 한 번에 staging upload 1개입니다. 이는 제안 상수이며 실제 scratch export 크기가 초과하면 삭제/생략하지 않고 사전 오류로 중단합니다. 최소 디스크 여유는 `기존 보존 artifact + 입력 NDJSON + 새 SQLite + indexes + 20%`를 측정하여 계산합니다. 처음부터 압축·청크 재개 프로토콜을 추가하지 않습니다. 중단한 upload는 완성본을 다시 보내며 같은 digest의 완료본은 재사용합니다.

### 4.2 source snapshot 안전성

```rust
// library/mobile_catalog.rs의 신규 export_mobile_catalog_snapshot()
let mut reader = self.catalog_read_connection()?; // file read guard 포함
let tx = reader.transaction()?;
let context = catalog_counts::read_context(&tx)?.ok_or(NotPrepared)?;
// read_context 및 sourceRevision을 같은 attached snapshot에서 확인한다.
// 카탈로그와 사용자 tables를 sorted row iterator로 TEMP NDJSON/JSON에 기록한다.
// 크기/row counts/digest를 계산하되 Vec<Work>로 전체 적재하지 않는다.
// missing/stale preparation은 오류; ensure_membership/request_preparation/import 호출 금지.
let exported = export_allowlisted_rows(&tx, &context, scratch)?;
drop(tx); drop(reader); // 네트워크 전송 전에 Library/file locks 반환
return exported;
```

`export_allowlisted_rows`는 신규 함수이며 위 allowlist와 UserSnapshot만 기록합니다. legacy source revision 또는 membership source revision mismatch는 게시 준비 필요 상태로 반환합니다. 사용자에게 준비를 숨겨 실행하지 않습니다. `tag-ko.json`은 제한된 크기로 한 번 읽어 translation으로 직렬화하고 해당 파일 bytes도 artifact digest에 반영합니다. 파일 교체 guard 안에서 읽습니다. 외부 source path, 토큰, Credentials, reading positions, unrelated library rows를 내보내지 않습니다.

### 4.3 atomic publish / rollback

서버 control DB의 신규 additive tables:

```sql
CREATE TABLE mobile_catalog_artifacts (
 digest TEXT PRIMARY KEY, source_revision TEXT NOT NULL,
 group_decision_revision TEXT NOT NULL, schema_version INTEGER NOT NULL,
 relative_file TEXT NOT NULL UNIQUE, row_counts_json TEXT NOT NULL, ready_at TEXT NOT NULL
);
CREATE TABLE mobile_catalog_users (
 revision TEXT PRIMARY KEY, decision_revision TEXT NOT NULL, payload TEXT NOT NULL
);
CREATE TABLE mobile_catalog_publications (
 revision TEXT PRIMARY KEY, content_digest TEXT NOT NULL, user_revision TEXT NOT NULL,
 relative_user_file TEXT NOT NULL, published_at TEXT NOT NULL
);
CREATE TABLE mobile_catalog_current (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), publication_revision TEXT NOT NULL
);
```

`relative_file`과 `relative_user_file`은 서버가 digest에서 생성한 경로이며 request가 정하지 않습니다. content ready는 complete import, PK/reference checks, quick_check, indexes 준비가 끝난 상태입니다. publication은 여기에 사용자 projection과 기본 6개 visibility/language exact count를 추가로 준비해야 게시 가능합니다. 사용자 projection에는 `prepared_counts(language,reveal,exact_count)`와 publication/source/user revision metadata를 두며, 내용·정책이 다른 count를 재사용하지 않습니다. incomplete artifact는 GET 경로에서 접근되지 않습니다.

```python
def publish(body):
    # 신규 함수. validate_user_snapshot은 strict fields/canonical identity를 검증한다.
    users = validate_user_snapshot(body.userSnapshot)
    candidate = require_ready_artifact_readonly(body.contentDigest)
    require_equal(candidate.group_decision_revision, users.decisionRevision)
    # 기존 control DB write lock 밖에서 고정 user SQLite와 6개 count를 준비한다.
    prepared = prepare_user_projection(candidate, users)
    with control_db() as db:
        db.execute("BEGIN IMMEDIATE")
        current = current_publication(db)
        candidate = require_ready_artifact(db, body.contentDigest)
        if current and current.revision == publication_hash(candidate, users):
            return current  # 응답 유실 뒤 같은 완성 요청의 idempotent 재전송
        require_equal(current.revision if current else None, body.baseRevision)
        require_equal(candidate.group_decision_revision, users.decisionRevision)
        store_immutable_users_and_publication(db, candidate, users, prepared)
        replace_current_pointer(db, publication_hash(candidate, users))
        db.commit()
```

staging은 TEMP/new file → validate → fsync/close → 서버 내부 최종 digest 경로로 atomic rename → ready row 등록 순서입니다. rename 뒤 DB commit 전 crash는 orphan ready file이며 startup에서 검증한 뒤 재등록하거나 격리합니다. 포인터가 참조하는 파일이 없는 상태를 만들지 않습니다. 기존 읽기는 immutable 파일을 계속 열고 있어 삭제되지 않습니다.

rollback은 동일 publish endpoint에 **이전 contentDigest + 현재 UserSnapshot**을 지정합니다. `baseRevision` CAS와 groupDecisionRevision 호환성을 검증합니다. 현재 북마크/차단/대표판을 과거 snapshot으로 되돌리는 전체 control DB 복원은 rollback 수단으로 쓰지 않습니다. 그 사이 confirm/split 결정이 바뀌었다면 이전 artifact로 안전히 rollback할 수 없으므로 409를 반환하고, 현재 사용자 결정을 반영한 이전 내용의 projection을 PC에서 scratch 재생성해야 합니다. 운영 PC catalog를 교체해 이를 만들지 않습니다.

기본 보존은 current + previous, cursor TTL 24시간 동안 참조된 publication/content/user snapshot입니다. 활성 TTL을 가진 세대가 늘어날 때 디스크 부족이면 새 publication을 거부합니다. request 경로에서 자동 삭제하지 않으며 정리 함수는 TTL 지난 미참조 artifact만 대상으로 합니다. 최초 운영 배포에는 자동 정리를 켜지 않고 실제 사용량을 먼저 확인합니다.

## 5. HTTP와 모바일 계약

모든 경로는 기존 인증을 사용합니다. 새 prefix는 `/v1/mobile-catalog`이며 legacy `/v1/catalog/*`를 변경하지 않습니다.

| 메서드·경로 | 입력 | 결과 |
|---|---|---|
| GET `/status` | 없음 | `{ready,publicationRevision,publishedAt,sourceRevision,capabilities:{providers:["kHentai"],read:true,bookmarkWrite:false,refreshRequest:false}}` |
| PUT `/replicas/{digest}` | PC-only NDJSON body | `{contentDigest,ready:true,counts}`. 완료된 같은 digest 재전송은 동일 결과 |
| PUT `/publication` | `{version:1,baseRevision:null|string,contentDigest,userSnapshot}` | `{publicationRevision,publishedAt,userRevision}` |
| GET `/search` | 최초 `provider,language=all|korean|japanese,text,sort,scope,revealBlocked,limit`; 다음은 `cursor`만 | 아래 CatalogPageV1 |
| GET `/count` | `token` | `{publicationRevision,totalCount}` 또는 제한시간 오류 |
| GET `/works/{provider}/{providerWorkId}` | `context` | `{publicationRevision,item:CatalogDetailV1}` |
| GET `/groups/{provider}/{groupId}/editions` | `context,cursor?` | `{publicationRevision,groupId,selectedProviderWorkId,items,nextCursor,totalCount}` |

PC-only는 APK allowlist에 없는 관리 경로라는 현재 제품 경계입니다. 현재 `require_auth`는 공용 bearer 하나이며 client 역할별 credential을 구분하지 않습니다. 따라서 이를 암호학적 PC-role authorization이 이미 있다고 설명하지 않습니다. 외부 배포 시 새 관리 경로 접근 범위는 기존 Collection publication과 함께 확인하고, 별도 publisher credential이 필요한 노출 형태라면 배포 전에 좁게 결정합니다. 사용자의 token은 JS/localStorage로 전달하지 않습니다.

```ts
// 신규 app/mobile-client/catalogModel.ts; desktop shared types.ts를 확장하지 않는다.
type CatalogProviderV1 = 'kHentai';
type CatalogIdentityV1 = {provider: CatalogProviderV1; providerWorkId: string};
type CatalogItemV1 = CatalogIdentityV1 & {
  groupId:string; title:string; titleJpn:string|null; artists:string[]; series:string[];
  thumbnailUrl:string|null; fileCount:number; views:number; posted:number;
  bookmarked:boolean; versionCount:number; hasBookmarkedVersion:boolean;
};
type CatalogPageV1 = {
  ready:boolean; publicationRevision:string|null; publishedAt:string|null;
  items:CatalogItemV1[]; nextCursor:string|null; context:string|null;
  countToken:string|null; totalCount:number|null; countStatus:'pending'|'ready'|'unavailable';
};
type CatalogDetailV1 = CatalogIdentityV1 & {
  title:string;titleJpn:string|null;thumbnailUrl:string|null;uploader:string|null;
  category:number|null;posted:number|null;updated:number|null;fileCount:number;
  fileSize:number|null;rating:number|null;views:number;bookmarked:boolean;
  tagGroups:{namespace:string;values:string[];labels?:Record<string,string>}[];
};
```

빈 미게시 상태는 ready=false이고 성공적으로 게시된 empty catalog는 ready=true/items=[]/totalCount=0입니다. 오래된 서버의 404, 인증 401, unsupported provider 400, 잘못된 검색식 422, 만료/없는 snapshot 409, 한도 초과 413, count budget 초과 503을 구별합니다. error payload는 `{code,message,span?:{start,end}}`로 제한하고 SQL·서버 경로·입력 원문을 echo하지 않습니다.

## 6. 검색 동등성과 pagination/count

검색 port의 authoritative 기준은 현재 grouped PC path입니다. 오래된 flat `search_online_catalog`만 기준으로 하면 hot 기준, 대표판, 그룹 수가 달라집니다.

```text
eligible(work) = Expunged=0 AND hard-language(work) AND saved-visibility(work)
matching(work) = eligible(work) AND compiled-expression(work)
                AND bookmarked-scope(work) AND posted>=frozen-hot-cutoff
group included = 한 member가 matching을 모두 만족
sort donor = matching member 중 sort tuple 최대인 행
representative = matching member 중 최신 manual preference, 한국어,
                 thumbnail_valid, completeness, lineage_terminal, Id 내림차순
versionCount = 그 group의 eligible member 수
hasBookmarkedVersion = 그 group의 eligible member 중 북마크 존재
exact count = COUNT(DISTINCT matching.group_id)
```

manual preference가 hidden/language-excluded/검색불일치 member이면 matching 안에서 fallback합니다. 북마크가 A판에 있고 검색이 B판에만 맞으면 그룹을 포함하지 않습니다. hot cutoff는 eligible 최신 Posted와 검색 시작 now 중 작은 값에서 기간을 빼며 모든 후속 페이지/count에 고정합니다. null Posted tie-break와 canonical bookmark string(`01`≠`1`)도 유지합니다.

Python `mobile_catalog_query.py`는 `catalog_query.rs`의 parse/compile, `catalog_group_query.rs`의 matching/donor/대표판 SQL 구조를 옮깁니다. 기존 PK/인덱스와 ID·bookmark·tag seed 및 prepared default count를 우선 보존합니다. 공통 fixture를 Rust 실제 `search_catalog_groups` 및 Python 실제 API에서 실행하여 ordered groupId/representative/versionCount/bookmark/count/detail을 비교합니다. parity 실패를 프런트 filtering으로 숨기지 않습니다.

cursor/context/countToken은 서버가 HMAC 서명한 base64url payload입니다. 포함값은 contractVersion, publicationRevision, 정규화 query 전체, frozen hot cutoff/now, limit, offset, 만료시각, 용도(search/context/count)입니다. 민감한 입력을 로그에 남기지 않습니다. 다음 페이지는 cursor만 받고 추가 query override를 거부합니다. offset은 기존 PC 의미를 유지하는 최소안이며 limit+1로 has-more를 판정합니다. 정렬 tuple을 동일하게 유지하여 고정 publication에서 중복/누락 없이 진행합니다. 깊은 offset이 성능 gate를 넘지 못하면 그때 donor tuple 기반 continuation으로 변경하며 의미 변경 없이 parity를 다시 검사합니다.

미게시에서 검색은 즉시 빈 상태를 반환합니다. 게시본 search는 usable page를 먼저 반환하고 `countToken`을 제공합니다. UI는 별도 `/count` 요청을 병렬로 표시합니다. count는 같은 publication/query/cutoff를 쓰며 10초 query budget을 넘으면 503이고 usable page를 유지합니다. pending/error를 0으로 표시하지 않습니다. 새 publication은 기존 cursor의 내용/사용자 revision을 바꾸지 않습니다. 만료나 제거된 버전은 409와 명시적 새로고침 동작으로 전환하며 old/new items를 append하지 않습니다.

현재 Android 8,192자 path 한도는 4,096 UTF-8-byte Korean 검색의 URL encoding을 수용하지 못할 수 있습니다. 새 read-prefix에 한해서 16,384자로 확장하고 일반 경로 한도는 유지합니다. cursor에는 URL-safe base64를 쓰고 다음 요청에 query를 중복 실어 보내지 않습니다. 서버 ingress URI 한도는 운영 배포 전 실제 구성으로 확인합니다.

## 7. 파일 소유권과 실행 batch

| 담당 | 생성/수정 파일 | 책임 |
|---|---|---|
| 모바일 lane | `app/mobile-client/catalogModel.ts`, `Catalog.tsx`, `Catalog.css`, `Catalog.test.tsx`, `catalogModel.test.ts`, `preview.ts`, `App.tsx` | catalog 계약/상태/화면/fixture 및 navigation. Assets/Collections state 유지 |
| 모바일 lane | `android/src/com/lakomics/mobile/NetworkPolicy.java`, `android/tests/NetworkPolicyTest.java` | GET catalog read 경로 및 제한된 긴 query 허용, PUT/POST 관리 경로 거부 |
| 서버 lane | `server/lakomics-api/mobile_catalog.py`, `mobile_catalog_replica.py`, `mobile_catalog_query.py`, `tests/test_mobile_catalog.py`, `tests/test_mobile_catalog_replica.py` | register 함수/read route, artifact/CAS, PC query port와 isolated tests |
| PC catalog lane | `app/src-tauri/src/library/mobile_catalog.rs`, `app/src-tauri/src/cloud/catalog.rs`, `app/src/library/mobileCatalog.ts`, `app/src/settings/MobileCatalogPublishSettings.tsx` | snapshot/export, transport, feature-owned DTO/client, 명시적 게시 UI |
| 통합 담당 단독 | `app/src-tauri/src/lib.rs`, `commands.rs`, `library/mod.rs`, `cloud/mod.rs`, `cloud/client.rs`, `app/src/settings/SettingsView.tsx`, `server/lakomics-api/app.py` | 신규 entrypoint 등록과 최소 UI hook. 다른 두 작업과 동시 편집 금지 |
| fixture 담당 | `tests/fixtures/mobile-catalog-v1.json`, `app/src-tauri/src/library/mobile_catalog_tests.rs` | 실제 Rust/Python 양쪽이 읽는 동일 입력 및 예상 identity/query corpus |

`library/db.rs`, 공통 `library/models.rs`, desktop `types.ts`/기존 gateway의 대형 확장은 기본안에 필요 없습니다. 신규 publish 결과 DTO는 `cloud/catalog.rs`와 feature-owned TS 파일에 둡니다. v44 WIP나 migration 번호를 수정하지 않습니다. 불가피한 공통 변경은 통합 담당에게 줄 단위 요청으로 넘깁니다.

### Batch A — 계약/fixture와 서버 검색

- [ ] **A1:** 위 wire/schema를 feature-owned 타입과 strict Python parser로 확정하고 아래 fixture를 작성합니다. 코드 단계: `parse_query(text)->Expr`, `compile_query(Expr)->(sql,list)`, `search_groups(connection,query)->page`, `count_groups(connection,query)->int`를 구현합니다. Python 외부 tokenizer package를 도입하지 않습니다.
- [ ] **A2:** `CatalogQueryParity` fixture loader를 Rust/Python에 추가하고 기존 Rust grouped 호출을 oracle로 사용합니다. 잘못된 식은 같은 UTF-8 span을 비교합니다. Python character index를 byte span으로 바꾸어야 합니다.
- [ ] **A3:** 새로운 route에 before/after page/count split을 적용합니다. read snapshot helper `open_publication(revision)`은 immutable content + 정확한 user snapshot만 열고 current를 다시 조회하지 않습니다.

최소 fixture: G1={1 Korean,2 Japanese}, G2={3 Korean}, G3={4 hidden category}, G4={5 exact blocked artist}, G5={6 null Posted,7 Posted=0}; 1/2의 제목·태그·북마크가 서로 다르고 대표 preference는 2입니다. 3에는 같은 문자열의 다른 namespace tag를 둡니다. handles에는 merge 이전 alias, decisions에는 confirm/falsePositive/split을 모두 둡니다. Heliotrope `1` bookmark와 kHentai `01`을 별도로 둡니다.

| 실제 regression case | 검증 결과 |
|---|---|
| `alpha OR beta AND -artist:x`, `(alpha OR beta) pages>=20`, quoted/backslash/%/_ | precedence와 escaped LIKE, 바인딩된 SQL 결과가 Rust와 동일 |
| `id:1 OR NOT id:3`, hard Korean, blocked group member | OR/NOT이 정책을 우회하지 않음 |
| G1: bookmark only 1, text only 2 | bookmarked+text 검색에서 G1 제외 |
| preference=2, Korean scope | 대표=1, 숨은 selectedProviderWorkId 미노출 |
| all scope/전체 언어, 최신 donor=1, preferred representative=2 | 그룹 순서는 donor, 화면 item은 2 |
| 5 sorts × all/Korean/Japanese × reveal on/off × all/bookmarked | exact count, 모든 페이지 합집합, 중복·누락, item field parity |
| null Posted tie, stale latest timestamp, future Posted | 한 donor만 선택되고 frozen hot 결과가 페이지마다 동일 |
| `01`, Heliotrope `1`, 알 수 없는 provider | identity 혼동 없음; unsupported 명시 |
| 4097-byte query, 257 tokens, `pages=10`, unclosed quote, SQL-looking title | bounded validation, correct span, DB 변형 없음 |

**Gate A:** 같은 fixture를 실제 Rust grouped API와 서버 경로로 통과시키기 전 mobile UI나 운영 게시로 넘어가지 않습니다. 성능은 empty/latest, broad tag, selective id, sparse bookmark, 3페이지를 대상으로 query phase와 EXPLAIN을 측정합니다. 현재 소스와 별도로 만든 규모 fixture에서 page p95 500ms 목표, 일반 count 10초 이내를 제안 목표로 둡니다. 측정 전 보장값으로 설명하지 않습니다.

### Batch B — PC export와 안전한 server publication

- [ ] **B1:** 신규 `Library::export_mobile_catalog_snapshot()`으로 TEMP 파일/manifest/UserSnapshot을 얻고 앞서 정의한 read snapshot/guard 경계를 지킵니다. export는 network 이전에 끝납니다.
- [ ] **B2:** `PUT replicas/{digest}`를 stream→spool→strict row import→validate→ready로 구현합니다. `register_mobile_catalog(app,get_db,require_auth,artifact_root)`만 app.py에서 등록합니다. test는 임시 artifact_root/control DB를 전달합니다.
- [ ] **B3:** CAS publication과 same-request idempotence, 현재 사용자 상태 유지 rollback을 구현합니다. `GET status`는 미게시·게시·실패를 구별합니다. 서버 first startup migration은 `CREATE TABLE IF NOT EXISTS`와 한 transaction으로 additive하게 처리합니다.
- [ ] **B4:** 신규 `Library::push_cloud_catalog()`는 remote baseRevision→local export→artifact upload→publication 순서로 실행합니다. ureq의 현 파일/reader body API를 local installed crate source에서 확인해 stream으로 전송하고 upload timeout을 기존 300초급 body timeout 소유 Module에 둡니다. 409는 자동 overwrite하지 않으며 refresh-and-explicit-retry를 제공합니다.
- [ ] **B5:** 설정에 명시적 게시 버튼, 실행 중 상태, 성공 게시시각과 행 수, 재시도 오류를 붙입니다. 일반 동기화·자동 catalog update를 누르는 것만으로 새 publish가 시작되지 않습니다. UI는 `app/src/library/mobileCatalog.ts` Interface만 부릅니다.

구체적 tests: no catalog/missing group readiness; source/user transaction 변경 중 일관된 export; source 파일/사용자 rows byte/hash 또는 SQL digest 변화 없음; no provider/network call; malformed record/duplicate PK/missing member/hash mismatch/oversize reject; 중간 disconnect 후 old current 유지; artifact complete 후 pointer 전 crash; same digest retry; stale base 409; 응답 유실 뒤 identical publish 성공; empty publication; old cursor에서 새 버전 뒤 같은 ordered 결과; bookmark source row absent일 때 보존; rollback에서 현재 북마크 유지; changed decisionRevision rollback 거부; publication final transaction fault rollback.

**Gate B:** isolated end-to-end PC fixture export → local API publish → search/detail/bookmark filter가 성공하고 소스 자료 무변경이 확인됩니다. UI가 실행 경로를 갖추어야 하며 fixture-only script로 완료했다고 하지 않습니다. 실제 운영 게시 버튼은 사용자 운영 승인 전 누르지 않습니다.

### Batch C — Android 목록/상세/북마크 읽기

- [ ] **C1:** `Catalog` area를 기존 App의 Assets/Collections와 형제 영역으로 추가합니다. 방문한 tab은 숨겨 유지하고 back은 상세→판본/목록→이전 영역 순으로 소비합니다. 홈/설정/Collections 재구현을 하지 않습니다.
- [ ] **C2:** 검색/언어/정렬/북마크필터/reveal 정책을 `catalogModel` state에 넣습니다. 새 query는 request generation을 증가시키고 pending page/count/detail을 취소합니다. 응답은 generation+publicationRevision+query를 확인한 후 commit합니다.
- [ ] **C3:** 고정 페이지 40개 및 이전/다음으로 시작합니다. 긴 무한 스크롤/세션 전체 카드 저장을 추가하지 않습니다. 상세→목록으로 복귀하면 query/cursor/scroll 유지, page 실패 시 기존 usable page와 retry 유지입니다.
- [ ] **C4:** 상세는 title/artist/namespace tag/category/pages/views/게시시각과 판본 목록을 보여줍니다. bookmark는 읽기 indicator이며 toggle/edit로 렌더링하지 않습니다. group 판본 query는 text/bookmark 조건을 넘기지 않고 현재 hard-language/reveal만 유지하여 PC editions 의미를 따릅니다.
- [ ] **C5:** 신규 native GET allowlist와 query 길이 예외를 좁게 추가합니다. `/replicas`, `/publication`, bookmark mutation, refresh 요청은 여전히 금지합니다. provider/path traversal, encoded slash, malformed cursor 사례를 거부합니다.

구체적 UI tests: pending count 후 page 유지, count error가 0이 아님, rapid Korean→Japanese 및 search A→B에서 stale response 무시, versions list의 hidden selected ID 없음, detail back scroll 복원, 새 publication 409에서 자동 old/new append 없음, 앱 tab 유지, settings/disconnect에서 abort, bookmark indicator 클릭이 network write하지 않음. native tests는 허용 GET 5종과 PUT/POST publication/replica/bookmark/refresh 거부, 최대 Korean query와 초과 길이, encoded traversal을 포함합니다.

**Gate C:** mobile tsconfig와 targeted tests, native compilation/policy 검사가 통과하고 tablet portrait/landscape browser fixture를 확인합니다. 실제 Galaxy Tab에서 API 조회·회전·back·PC-off 조회·연결 취소를 별도 검증합니다. browser rendering은 Android/native bridge 증거가 아닙니다.

### Batch D — 승인된 운영 rollout

실행 전 별도 운영 승인이 필요합니다. 승인 후 현 server source/control DB/artifact directory backup과 quick_check를 확보하고 server source hash/rollback 파일, 디스크 여유, schema compatibility를 기록합니다. 새 module을 등록한 배포가 정상이어도 ready=false면 정상 미게시입니다. 승인된 PC snapshot 한 번만 게시하고 list/search/detail/bookmark-count를 비교합니다. 모바일 설치/업데이트는 대상 기기 승인 범위를 확인합니다.

게이트: 서비스 health/auth, current artifact 파일 존재/quick_check, PC·API 동일 representative/query fixture와 표본, old publication 유지, PC 프로세스를 필요로 하지 않는 실제 API 읽기, Galaxy Tab 연결 상태와 회전/back. 실패하면 current 사용자 snapshot을 보존하는 호환 이전 publication으로 CAS rollback합니다. broad crawl/일본어 초기수집/reseed/full asset backfill은 하지 않습니다.

## 8. 정확한 검증 명령과 현재 가용 도구

아래는 **향후 구현 검증 명령**이며 이 계획 작성 중 실행하지 않았습니다. 기존 Python은 `C:\Users\namwoojun\AppData\Local\Programs\Python\Python314\python.exe`, Node/npm은 `C:\Program Files\nodejs`, JDK는 `C:\Program Files\Eclipse Adoptium\jdk-17.0.20.8-hotspot`에서 확인했습니다. Android SDK 35 jar와 build-tools 35.0.0 aapt2는 `C:\LakomicsCloudMediaPoC\sdk`에 존재합니다. Python test dependencies의 import 가능 여부나 tool 버전 출력은 이번 조사에서 실행하지 않았습니다.

PowerShell에서 각 명령의 실제 exit code를 보존하며 이전 성공 결과를 새 변경의 증거로 쓰지 않습니다.

```powershell
# server owning cwd: C:\chatgpt\server\lakomics-api
python -m unittest tests.test_mobile_catalog tests.test_mobile_catalog_replica -v
# app owning cwd: C:\chatgpt\app
npm run mobile:test -- mobile-client/catalogModel.test.ts mobile-client/Catalog.test.tsx
npx tsc -p tsconfig.mobile.json --noEmit
# repo root: 실제 Rust grouped oracle + exporter 신규 tests
cargo test --manifest-path app/src-tauri/Cargo.toml --lib mobile_catalog -- --test-threads=1
# 공통 grouped path 변경이 있었다면 기존 실제 의미 regression만 확장
cargo test --manifest-path app/src-tauri/Cargo.toml --lib catalog_group_query_tests -- --test-threads=1
# Android read boundary를 변경한 경우 기존 offline compile/policy checks
.\android\build.ps1 -SdkRoot C:\LakomicsCloudMediaPoC\sdk -CompileOnly
```

server 기존 router registration 또는 shared auth/startup 변경이 실제로 있었다면 `python -m unittest tests.test_catalog_api tests.test_mobile_collections -v`를 추가합니다. PC 설정 JSX/type 수정 후에는 `C:\chatgpt\app`에서 `npx tsc --noEmit`을 추가합니다. 전체 app build나 무관한 전체 suite는 자동 단계가 아닙니다.

모바일 시각 확인이 필요한 구현 gate에서만 기존 `npm --prefix app run mobile:dev`와 `http://127.0.0.1:1448/?demo`를 사용합니다. 실행 중 dev와 충돌 여부는 통합 담당이 먼저 확인합니다. 실 native APK 검증이 승인된 후에만 `npm --prefix app run mobile:build`, `.\android\build.ps1 -SdkRoot C:\LakomicsCloudMediaPoC\sdk`로 패키지를 만듭니다. desktop runtime이 필요하면 유일한 경로는 `C:\chatgpt\app`의 `npm run tauri -- dev`이며 debug exe를 직접 실행하지 않습니다.

## 9. Reader / MOBILE-007 / MOBILE-008 후속 gate

Reader는 A–C의 목록/검색/상세/북마크 read gate가 끝난 뒤 별도 후속 전달입니다. 현재 remote reader는 `library/remote_media.rs`와 `models.rs:1091` 이후 manifest 계약을 참고하되 Android용 provider-qualified ordered page manifest, expiring page access, 취소 가능한 2페이지 이내 prefetch, 최대 2회 재시도, 기기 로컬 `(provider,providerWorkId)` 읽기 위치가 먼저 필요합니다. 기존 `/gallery` HTML을 Android UI가 직접 해석하지 않습니다. cross-device reading position, offline 다운로드, 원본 전체 업로드는 포함하지 않습니다.

MOBILE-007의 idempotent operation ID/receipt/PC application ack/tombstone/concurrent changes는 이 계획에서 구현하지 않습니다. MOBILE-008의 durable refresh jobs나 PC-off server updater도 구현하지 않습니다. `capabilities`는 두 기능을 false로 알립니다. worker authority 전환 및 production ingestion은 해당 후속 설계/승인 이후입니다.

## 10. 비용·불확실성·완료 판단

예상 작업 크기는 작은 CSS 수정 수준이 아니라 **서버 검색 의미 이식 + publication + PC exporter + mobile integration의 4개 검증 가능한 묶음**입니다. 가장 큰 비용은 구현 언어가 다른 query parity와 대형 publication의 실패 복구입니다. 내용 변경이 없을 때 digest 재사용으로 네트워크를 줄이며, 초기 구현은 사용자 snapshot만 갱신할 수 있습니다. 내용 변경마다 전체 artifact 전송이 발생하므로 실제 export bytes/초와 VPS index 생성 시간·디스크 peak를 측정합니다. 월 비용은 VPS/R2 요금이나 실제 변경 빈도를 확인하지 않았으므로 금액을 추정하지 않습니다.

추가 결정이 필요한 경우 기본값은 다음과 같습니다.

- updater authority: 현재 PC 유지. 서버-side updater 결정은 MOBILE-008에서 분리합니다.
- publishing schedule: 명시적 수동 버튼. 자동 루프는 추가하지 않습니다.
- query backend: Python/SQLite parity를 먼저 검증. 실패가 증명되기 전 Rust service를 새로 만들지 않습니다.
- thumbnails: 현재 검증된 ehgt HTTPS URL과 실패 placeholder. native 영속 cache/서버 프록시 필요성은 실기기 측정으로 결정합니다.
- user snapshot rollback: 현재 사용자 자료 우선, decisionRevision 비호환이면 rollback 거부.
- native-first acceptance: Galaxy Tab S11 portrait/landscape. phone 완성도를 선행 gate로 두지 않습니다.

완료 보고는 **구현/정적 검사**, **isolated PC→server fixture roundtrip**, **browser UI**, **Android compile/policy**, **운영 배포/게시**, **Galaxy Tab 및 PC-off 실제 읽기**를 각각 구분합니다. 마지막 두 gate가 없으면 목록/검색의 구현 완료와 운영 준비 상태까지만 주장합니다. 현재 문서는 이 모든 구현·실행 gate가 아직 수행되지 않은 계획입니다.

## 11. 최종 통합 검증 — 2026-09-08

MOBILE-006 read implementation은 PC exporter/publication, Python immutable replica/query,
mobile list/search/detail/edition/bookmark filter, PC publish settings와 Android read boundary까지
연결됐다. Python catalog tests 13개, mobile frontend 53개, mobile production build, Rust parity/export,
Android native compile과 NetworkPolicy 80 / DocumentTree 19 / ThumbnailCache 18 / MediaTransfer 22 /
TemporaryImage 23 및 PickerSnapshot 검사가 통과했다. 전체 desktop frontend/Rust 회귀도 green이다.

남은 것은 Batch D의 운영 rollout과 실제 PC-off Galaxy Tab acceptance, catalog-scale performance다.
서버 배포/첫 publication/device install은 이번 통합 검증에서 실행하지 않았다. MOBILE-007의
bookmark mutation과 MOBILE-008 updater authority도 계속 별도 후속 작업이다.
