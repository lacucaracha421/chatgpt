# SIMILARITY-003 유사 동영상 실행계획

> 실행 담당자는 `subagent-driven-development` 또는 `executing-plans`의 작은 배치·검토 방법을 적용한다. 저장소와 사용자 지시가 스킬의 승인·커밋 절차보다 우선한다.

**Goal:** 사용자가 지정한 정상 영상 자산 집합에서 재인코딩·해상도 변경 후보를 찾고, 기존 유사 검토 화면에서 근거를 비교하고 직접 결정하게 한다.

**Architecture:** 기존 FFmpeg 배포·영상 잠금과 PDQ 계산을 사용하되, 영상 fingerprint·분석 작업·후보쌍은 `video_similarity`가 소유한다. 이미 수집된 `normal` 영상끼리의 검토를 기존 이미지 수집 대기(`normal`/`review`) 처리에 억지로 넣지 않는다. 같은 유사 검토 화면에 영상 전용 pane을 연결하고 휴지통의 현재 생명주기를 재사용한다.

**Tech Stack:** 현재 Rust/Tauri, SQLite/rusqlite, React/TypeScript, `image`, 고정된 `pdqhash = "=0.1.1"`, 번들 FFmpeg/FFprobe. 새 모델·라이브러리·서버·오디오 fingerprint 의존성 없음.

## 0. 문서의 지위와 조사 범위

이 문서는 `docs/roadmap/lakomics-backlog.md`의 **SIMILARITY-003 실행 제안**이며 백로그를 대체하지 않는다. 현황은 아래 파일을 읽어 확인한 사실, 알고리즘·수치는 검증할 제안으로 구분한다. 작업 착수 시 `main` HEAD는 `aabf7b0b3f857fe10ed3359de38757d9558b50f1`이며 캐릭터 v44 관련 tracked/untracked WIP가 있다. 이전 main의 깨끗한 상태를 현재 기준으로 취급하지 않는다.

조사 단계에서는 코드/운영 DB 수정, 테스트 실행, 빌드, Git 쓰기, 앱 재시작, FFmpeg 실행을 하지 않았다. 활성 라이브러리와 개인 영상은 열어 보지 않았다. 재생·추출 품질·속도·실제 false-positive율은 아직 확인되지 않았다. 사용자 후속 요청은 계획 후 구현을 허용했지만 운영 라이브러리 변경/전체 자동 재색인을 허용한 것은 아니다. 실행은 루트가 watcher 충돌을 정리하고 공통 파일 소유권을 배정한 뒤 진행한다.

## 1. 공통 제약

- `C:\chatgpt`와 현재 dirty 작업을 보존한다. v44 캐릭터 코드/fixture/보고서/설정을 수정하지 않는다.
- Git 쓰기, 배포, 운영 데이터/파일 변경은 별도 명시적 권한 대상이다. 운영 `C:\New_lakomics_assets`에서 scan/마이그레이션/검증을 실행하지 않는다.
- 원본과 재생본은 별개다. 영상 fingerprint는 원본에서 만들며 proxy를 새 자산 또는 원본 identity로 취급하지 않는다.
- ingestion exact hash 순서와 이미지/GIF PDQ 의미·기존 review 결정은 보존한다. 자동 인입 차단과 시작 시 전체 분석은 이번 범위에 없다.
- scan은 후보만 만든다. 자동 삭제·자동 merge·점수 기반 metadata 승계·전체 라이브러리 reindex 금지.
- UI는 현재 공통 Button/Dialog/Toast/색·간격 토큰을 쓴다. 기존 복수 선택·스크롤·닫기 경로와 비공개 모드를 보존한다.
- 검증은 임시 fixture 라이브러리부터 시작한다. 브라우저 테스트를 native FFmpeg/Tauri 검증으로 보고하지 않는다.
- `target/debug/lakomics.exe` 직접 실행 금지. 필요하면 승인된 실행 단계에서만 `C:\chatgpt\app`의 `npm run tauri -- dev`를 사용한다.

관련 권위: `CONTEXT.md`의 Asset/Media Derivative/Playback Proxy/Exact Duplicate/Review Queue, Accepted ADR 0001·0007·0011·0018·0019·0022·0023·0025·0033, `DESIGN.md`, `docs/agents/implementation.md`, `docs/agents/pc-design-reference.md`.

## 2. 현재 구현 확인

아래 경로는 저장소 기준 상대 경로이며 줄 번호는 조사 시점 기준이다.

| 확인 사실 | 근거 |
| --- | --- |
| SIMILARITY-003은 시간축 제한 샘플링, duration/window gate, 재인코딩·해상도 변형, trim/crop/watermark 평가와 기존 Review 재사용을 요구한다. audio는 후속이다. | `docs/roadmap/lakomics-backlog.md:652-660`, 순서 `1335-1339` |
| 영상 수집은 exact hash를 먼저 확인한 뒤 probe, content-addressed 원본 설치, video row/pending 준비 작업 등록을 수행한다. 유사 후보 경로는 없다. | `app/src-tauri/src/library/ingestion.rs:276-331`, `407-416`, `505-568`; 기존 테스트 `1439`, `1503`, `1567` |
| 현재 ingest/probe에서 지원하는 영상 확장자는 mp4/webm/mov이며 probe는 첫 video stream·폭·높이·양의 format duration을 읽는다. rotation/display aspect/VFR timestamp는 DTO에 없다. | `ingestion.rs:576-593`; `video_media.rs:19-45`, `606-663` |
| 이미지/GIF만 `assets.perceptual_hash` 검색·누락 hash 집계 대상이다. 이미지 정책은 quality ≥50, distance ≤20, aspect ratio factor ≤1.15이다. | `similarity.rs:27-29`, `390-443`, `451-494`; `image_fingerprint.rs:91-100` |
| PDQ는 full와 사방 5% crop 두 256bit hash, 두 quality의 최솟값, 64byte 저장이다. 네 조합 중 minimum Hamming distance를 쓴다. | `image_fingerprint.rs:5-50`, `53-88` |
| 영상 준비는 `video_lock` 아래 1개씩 처리하며 입력 limit은 1~10. normal 영상만 reserve한다. | `video_media.rs:202-238`, `358-386`; `library/mod.rs:136`, `202` |
| 현재 scrub은 길이에 따라 최대 240장, 중간점 timestamp 목록을 만들지만 FFmpeg 실행은 fps filter로 WebP를 생성한다. 장면별 실제 PTS manifest가 없다. | `video_media.rs:125-164`, `599-603` |
| ready가 되기 전 pending directory에서 poster/scrub/필요한 proxy를 검증하고 설치한다. 재시작 시 processing/불완전 ready는 derivatives를 지우고 pending으로 돌린다. | `video_media.rs:257-355`, `389-470` |
| FFmpeg 실행은 숨김 창 `Command.output()`이다. 현재 helper에는 deadline, cancel, stdout/stderr cap, child 명시적 종료 제어가 없다. | `video_media.rs:499-536` |
| 재생 URL은 원본 또는 proxy를 선택하고 ready 자산만 제공한다. 단순 `<img assetUrl>`은 영상 비교 UI가 아니다. | `library/mod.rs:429-470`; `app/src/assets/mediaUrl.ts:9-18`; `SimilarityReviewBrowser.tsx:102-106` |
| 기존 review schema는 candidate ID가 UNIQUE이고 normal/review 쌍을 전제로 한다. listing도 양쪽 상태를 검사한다. | `migrations/0025_pdq_similarity.sql:4-25`; `similarity.rs:120-150` |
| 기존 KeepExisting는 수집 대기 후보 원본/thumbnail을 제거하고 asset row도 DELETE한다. ReplaceExisting는 분류/collection/cover/favorite를 넘기며 기존을 trash로 보낸다. normal-normal 영상에 그대로 호출하면 안 된다. | `similarity.rs:249-364` |
| 기존 검토 UI는 1쌍씩 보며 중복 submit을 막고, 오류 시 후보를 남긴다. 이미지 문구·img preview가 고정돼 있다. | `SimilarityReviewBrowser.tsx:31-75`, `86-116` |
| 휴지통은 파일 이동 없이 상태를 바꾸며 실제 영상 derivative 제거는 purge에서 처리한다. | `trash.rs:49-71`, `210-227`, `279-285` |
| 현재 WIP schema는 v44. 초기화는 구버전 DB를 검증 backup한 뒤 transaction으로 migration, commit 전 FK 검사한다. | `db.rs:7`, `76-94`, `220-242`; restore `249-262`; `backup.rs:372-404`, `425-430` |

메모리의 과거 영상 exact-only 기록은 위 현행 코드를 찾는 단서로만 사용했다. 현재 사실은 소스에서 다시 확인했다.

## 3. 대안과 추천

| 대안 | 장점 | 한계·선택 |
| --- | --- | --- |
| A. 기존 poster/scrub 캐시를 그대로 PDQ 비교 | 새 decode 비용이 적다. | poster 1장으로 영상 identity를 판단할 수 없고 scrub의 실제 sample 시점/버전 계약이 없다. 공통 오프닝·black frame 오탐 위험. **채택하지 않는다.** |
| B. 원본의 제한된 정규화 시간점에서 frame PDQ + 순서·coverage 비교 | 기존 FFmpeg/PDQ 재사용, 정해진 비용, 판단 근거 제시 가능. | trim/crop에 제한, 긴 GOP seek 비용과 VFR 오차를 측정해야 한다. **1차 추천.** |
| C. sliding-window fingerprint/scene alignment 또는 전용 영상 hash/embedding | trim/subclip 등 넓은 변형을 다룰 여지가 있다. | 비용·index·평가 corpus·의존성 부담이 커진다. B의 실패 유형을 모은 뒤 별도 제안. |

1차 기능은 같은 시간축의 재인코딩/다운스케일/업스케일 후보를 찾는다. trim/subclip, letterbox/crop, watermark, rotation/mirror, 속도 변화, 프레임 재배열/삽입, 다른 audio는 corpus에 포함하되 **지원 보장 범위로 표시하지 않는다**. 영상은 같은데 audio가 다를 수 있으므로 어떤 후보도 완전 중복으로 선언하지 않는다.

## 4. 분석 계약과 비용 상한 — 검증 전 초기 제안

아래 숫자는 확인된 영상 임계값이나 성능이 아니다. `video_similarity/policy.rs` 한곳에 정의할 보수적 초기 실험값이며, corpus gate를 통과한 정책 버전만 사용한다.

| 항목 | 초기 제한 |
| --- | --- |
| 분석 범위 | 명시적으로 선택한 정상 영상 2~100개 사이의 쌍. library 전체/임의 경로 없음. 중복 ID 제거 후 범위 초과는 오류. |
| 한 영상 | duration 2초~20분, 원본 최대 2GiB; 범위 밖은 `out_of_scope`, 오류나 비슷하지 않음으로 섞지 않음. |
| 샘플 | 12개 정규화 중간점 `t_i = floor((2i+1)D/24)`, i=0..11. 원본 비율 유지, 최대 512×512. |
| 동시성 | library별 scan 1개, FFmpeg frame subprocess 1개. 기존 video preparation의 `video_lock`을 공유하고 frame 사이에 반환. |
| 시간 | FFprobe 10초, frame 5초, asset 60초, 전체 scan 10분. 대기·hash·비교 시간을 전체 wall budget에 포함. |
| 출력 | frame 파일당 2MiB, asset 임시 폴더 24MiB, stderr 보관 16KiB. stdout은 null 또는 제한된 probe JSON. |
| 비교 | 최대 4,950쌍. duration/aspect 검사 후만 frame 비교; pair당 12×12 상한. |
| cache | 완성된 frame hash만 SQLite에 저장. 임시 raster는 계산 후 제거. 총 frame hash 1,200개/scan. 전체 cache 상한 10,000개 영상; 넘으면 신규 scan을 보류하고 명시적 cache 정리 제공. |

예상 frame hash 원자료는 `12 × (64byte hash + timestamp + quality)` 수준이며 DB index/row overhead를 포함한 실제 크기는 측정한다. 512 frame와 hash만 다루지만 디코더 내부 RAM은 출력 해상도만으로 제한되지 않는다. probe dimensions 상한은 8,192×8,192다. 실행 검토에서 루트가 Windows Job Object 추가를 허용했다. 신규 분석 child는 `KILL_ON_JOB_CLOSE`와 1GiB process memory limit를 적용하며, 기존 `windows-sys`의 JobObjects/Threading feature만 사용한다. 정상 취소도 kill/wait하고 앱 강제 종료 시에는 job handle close로 child를 종료한다.

### 샘플 추출과 프로세스 생명주기

`VideoMedia`가 소유한 tool lookup을 재사용하고 그 안에 제한된 원본-frame 추출 API를 추가한다. 재생 proxy 생성이나 기존 240장 scrub을 먼저 실행하는 API를 호출하지 않는다. 정상 원본을 `asset_id`로 조회하고 canonical path가 현재 library의 assets 아래인지, regular file인지, symlink/reparse escape가 아닌지 검사한다. 사용자 입력 경로를 FFmpeg에 직접 전달하지 않는다.

```text
extract_similarity_frame(source, at_ms, temp_path, cancellation, deadline):
  seconds = integer_seconds + '.' + three_digit_milliseconds
  spawn bundled ffmpeg directly with OsString args, CREATE_NO_WINDOW,
    -nostdin -hide_banner -v error -threads 1
    -ss seconds -i source -map 0:v:0 -an -sn -dn
    -frames:v 1 -vf scale=512:512:force_original_aspect_ratio=decrease
    -c:v png -threads 1 temp_path
  drain stderr concurrently; retain at most 16KiB while continuing to drain
  poll try_wait + cancellation + deadline + output size
  on cancel/timeout/overflow: kill then wait; no ready cache commit
  on successful exit: validate dimensions/file cap, decode one frame, hash
  finally: child reaped and owned temp_path removed
```

`-ss` input seek는 nearest preceding seek point로 접근한 뒤 기본 accurate seeking에서 남는 구간을 decode/discard한다. 따라서 frame 수 제한만으로 decode 비용이 제한되는 것은 아니며 위 deadline이 필요하다. 실제 output frame PTS를 읽는 구현이 없으면 요청 시점을 `requestedAtMs`로 표시하고 정확히 그 PTS를 뽑았다고 주장하지 않는다. [FFmpeg 공식 문서](https://ffmpeg.org/ffmpeg.html#Main-options)

`Child` handle을 버리는 것만으로 종료되지 않는다. 모든 error/cancel/drop 경로에서 child를 kill/wait하는 guard가 필요하다. pipe drain 없이 `wait()`만 호출해 pipe가 차는 정지를 만들지 않는다. [Rust std::process::Child 공식 문서](https://doc.rust-lang.org/std/process/struct.Child.html)

FFmpeg rotation metadata와 sample-aspect ratio는 현재 VideoProbe 계약에 없으므로 raw width/height를 display aspect라고 단정하지 않는다. 1차 extractor probe에서는 rotation/SAR를 식별하고, 비기본 rotation 또는 non-square SAR는 `unsupported_geometry`로 보류한다. display normalization은 별도 fixture 통과 후 정책 버전을 올려 도입한다.

### 매칭과 반증

1. 두 asset가 normal/video이고 content hash가 다르며 현재 profile로 완성된 fingerprint인지 검사한다. exact hash는 기존 수집 규칙의 역할이다.
2. duration 차이가 `max(250ms, shorter×1%)` 이하, display aspect 차이가 2% 이하일 때만 진행한다. 폭/높이는 해상도 변형을 허용하되 0/unknown은 보류한다. 이미지의 factor 1.15를 영상에 그대로 적용하지 않는다.
3. sample별 기존 full+crop PDQ/quality를 계산한다. quality 50과 distance 20은 **이미지 정책에서 출발한 실험값**이며 영상 정확도로 검증되지 않았다.
4. 같은 normalized slot만 먼저 비교한다. 인접 slot 중 최솟값을 무제한 고르면 다른 장면을 맞춘 척할 수 있으므로 v1에서는 order-preserving same-slot 비교만 사용한다.
5. 유효 sample 최소 8/12, matched sample 최소 8/12 및 유효 sample의 75%, 시간축 앞/중간/뒤 thirds 각각 2개 이상 일치가 초기 gate다. 저품질 slot을 분모에서 제거해 짧은 공통 오프닝만으로 통과시키지 않는다.
6. self distance 기반 최소 4개 서로 다른 frame 묶음이 양쪽 모두 필요하다. static/slide/black credit/공통 오프닝만 있는 pair는 `insufficient_evidence`로 남긴다. distinct-frame 분리 거리 역시 초기 20에서 corpus로 검증한다.
7. evidence에는 matched/attempted/valid counts, span coverage, duration delta, aspect delta, matched slot의 요청 시각과 거리/quality를 남긴다. 하나의 유사도 퍼센트 또는 가장 잘 맞은 한 장만 표시하지 않는다.

```rust
// Actual small interface; has_usable_evidence marks insufficient inputs in scan items.
pub(super) fn compare(
    left: &VideoFingerprint,
    right: &VideoFingerprint,
    profile: &str,
) -> Option<VideoMatchEvidence>;
```

특정 실험값에 맞춘 synthetic fixture를 늘리는 것으로 검증을 끝내지 않는다. 동일 캐릭터/장면/오프닝의 다른 영상, 같은 영상의 순서 뒤집기, 동일 포스터 뒤 전혀 다른 영상에서 통과하는지 먼저 반증한다. threshold를 느슨하게 하기 전에 실패한 gate와 의도된 범위를 설명한다.

## 5. 전용 API·저장 계약

### 파일별 소유권

| 소유자 | 파일과 책임 |
| --- | --- |
| 영상 담당 | 새 `app/src-tauri/src/library/video_similarity/{mod.rs,models.rs,policy.rs,fingerprint.rs,scan.rs,review.rs,tests.rs}` — 작은 facade, DTO, 순수 정책/비교, job/cache, 검토 transaction. 규모가 작으면 policy와 fingerprint는 한 파일에 두되 추상 adapter를 추가하지 않는다. |
| 영상 담당 | 새 `app/src-tauri/src/commands/video_similarity.rs` — start/status/cancel/resume/list/decide wrapper, public error mapping. |
| 영상 담당 | 새 `app/src/similarity/video/{api.ts,types.ts,VideoSimilarityPanel.tsx,VideoSimilarityPanel.test.tsx}` — 영상 전용 invoke와 UI. 기존 LibraryGateway 대형 mock에 새 필수 필드를 퍼뜨리지 않는다. |
| 영상 담당 | `video_media.rs` — 기존 tool lookup visibility, frame extractor/cancellable child helper. `trash.rs` — 동일 transaction용 상태 전환 helper만 추출. `SimilarityReviewBrowser.tsx` — 동일 surface 안 이미지/영상 pane 전환과 공통 닫기/privacy 유지. |
| 루트 통합 담당 | `library/mod.rs` — module 선언, `Arc<Mutex<video_similarity::ScanState>>`, 초기화/중단 복구 연결. `commands.rs`, `lib.rs` — command module/handler 연결. |
| 루트 통합 담당 | `db.rs`, migration 순서와 `backup.rs` schema 검증 연계. `0045_video_similarity.sql` 하나를 예약하되 실제 번호와 merge 순서는 최종 소유자가 확정한다. AV는 뒤의 v46 예정. |
| 루트/현재 Asset WIP 소유자 | `AssetBrowser.tsx`의 선택 메뉴 entry 한곳과 `App.tsx` navigation/selected IDs 전달. 기존 캐릭터 선택 메뉴를 덮어쓰지 않는다. |

공통 `library/models.rs`/`app/src/library/types.ts` 수정은 기본적으로 필요 없다. 기존 `AssetSummary`를 영상 DTO 안에서 재사용한다. 영상 분석 요청은 갤러리에서 선택한 IDs를 전달하거나, 유사 검토 영상 pane에서 기존 영상 목록 API로 페이지 단위 선택한다. 첫 구현은 선택 메뉴 진입을 추천하며 2~100 정상 영상 조건을 UI와 Rust 양쪽에서 검사한다.

### 명령과 DTO

```ts
// Proposed new module: app/src/similarity/video/types.ts
type VideoScanState = "queued" | "running" | "paused" | "completed" | "cancelled" | "failed";
type VideoReviewDecision = "keep_left" | "keep_right" | "keep_both" | "not_similar";
type VideoScanRequest = { assetIds: string[] };
type VideoScanProgress = {
  id: string; state: VideoScanState; total: number; completed: number;
  failed: number; skipped: number; candidateCount: number;
  activeAssetId: string | null; reason: string | null;
};
type VideoMatchEvidence = {
  profile: string; leftDurationMs: number; rightDurationMs: number;
  matchedFrames: number; attemptedFrames: number; validFrames: number;
  matchingSpanPermille: number;
  matches: { leftRequestedAtMs: number; rightRequestedAtMs: number;
             distance: number; leftQuality: number; rightQuality: number }[];
};
type VideoReview = {
  id: string; left: AssetSummary; right: AssetSummary;
  evidence: VideoMatchEvidence; createdAt: string;
};
type VideoReviewPage = { items: VideoReview[]; totalCount: number; nextCursor: string | null };
// api.ts functions; Rust equivalents snake_case command names.
startVideoSimilarityScan(request: VideoScanRequest): Promise<VideoScanProgress>;
getVideoSimilarityScan(scanId: string): Promise<VideoScanProgress>;
cancelVideoSimilarityScan(scanId: string): Promise<VideoScanProgress>;
resumeVideoSimilarityScan(scanId: string): Promise<VideoScanProgress>;
listVideoSimilarityReviews(query: { after: string | null; limit: number }): Promise<VideoReviewPage>;
decideVideoSimilarityReview(request: { reviewId: string; decision: VideoReviewDecision }): Promise<void>;
```

`scanId`/reviewId는 UUID, cursor는 timestamp+ID의 opaque encoding으로 검증한다. UI로 raw path/hash/codec stderr를 반환하지 않는다. 공개 reason은 `out_of_scope`, `unsupported_geometry`, `source_changed`, `decode_failed`, `timeout`, `cancelled`, `insufficient_evidence`, `capacity_reached`로 제한하고 한국어로 짧게 표시한다.

### 단일 migration 구조

아래는 구현용 제안 schema다. 기존 `similarity_reviews` rebuild, image hash NULL 처리, video preparation state 재설정은 하지 않는다.

```sql
CREATE TABLE video_similarity_fingerprints (
  asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL, profile TEXT NOT NULL,
  duration_ms INTEGER NOT NULL CHECK(duration_ms > 0),
  width INTEGER NOT NULL CHECK(width > 0), height INTEGER NOT NULL CHECK(height > 0),
  source_bytes INTEGER NOT NULL CHECK(source_bytes >= 0), source_mtime TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE video_similarity_frames (
  asset_id TEXT NOT NULL REFERENCES video_similarity_fingerprints(asset_id) ON DELETE CASCADE,
  sample_index INTEGER NOT NULL CHECK(sample_index BETWEEN 0 AND 11),
  requested_at_ms INTEGER NOT NULL CHECK(requested_at_ms >= 0),
  pdq BLOB NOT NULL CHECK(length(pdq) = 64),
  quality INTEGER NOT NULL CHECK(quality BETWEEN 0 AND 100),
  PRIMARY KEY(asset_id, sample_index)
);
CREATE TABLE video_similarity_scans (
  id TEXT PRIMARY KEY, profile TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','running','paused','completed','cancelled','failed')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, reason TEXT
);
CREATE TABLE video_similarity_scan_items (
  scan_id TEXT NOT NULL REFERENCES video_similarity_scans(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
  source_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','running','ready','skipped','failed')),
  reason TEXT,
  PRIMARY KEY(scan_id, ordinal), UNIQUE(scan_id, asset_id)
);
CREATE TABLE video_similarity_reviews (
  id TEXT PRIMARY KEY,
  left_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
  right_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
  left_hash TEXT NOT NULL, right_hash TEXT NOT NULL,
  profile TEXT NOT NULL, evidence_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('open','resolved','stale')),
  decision TEXT CHECK(decision IN ('keep_left','keep_right','keep_both','not_similar')),
  created_at TEXT NOT NULL, resolved_at TEXT,
  UNIQUE(left_hash, right_hash), CHECK(left_hash < right_hash),
  CHECK((state = 'open' AND decision IS NULL AND resolved_at IS NULL
         AND left_asset_id IS NOT NULL AND right_asset_id IS NOT NULL)
     OR (state = 'resolved' AND decision IS NOT NULL AND resolved_at IS NOT NULL)
     OR state = 'stale')
);
CREATE INDEX video_similarity_reviews_pending
ON video_similarity_reviews(state, created_at, id);
PRAGMA user_version = 45;
```

canonical pair는 hash 순서로 정한다. `left/right`는 화질 순위가 아니다. UI는 수집일·해상도·출처를 보여주되 우열을 자동 결정하지 않는다. `UNIQUE(left_hash,right_hash)`로 역순 scan과 다른 profile 재계산에서도 사람의 판단을 보존한다. open pair의 evidence는 갱신할 수 있지만 resolved pair는 명시적 재검토 없이 다시 열지 않는다. 자산 삭제 시 unresolved row를 stale로 처리한다. FK SET NULL과 open CHECK가 충돌하지 않도록 **migration에 BEFORE DELETE ON assets trigger를 추가해 관련 open review를 stale로 변경**한 후 FK를 적용한다. resolved evidence/history는 남긴다.

fingerprint는 12frame 성공과 입력 stat/identity 재확인 뒤 동일 transaction에서 교체한다. 중간 실패로 기존 완료 cache를 훼손하지 않는다. cache profile은 예를 들어 `video-pdq-slots12-v1/ffmpeg-build-id/pdq-0.1.1`이며 sampling·정규화·quality·비교 정책이 바뀌면 profile도 바꾼다. 향후 이미지 S1/S2 변경이 영상 fingerprint에 조용히 영향을 주지 않도록 영상 담당이 정책 버전을 관리한다.

scan 재개 시 완료 item의 source hash/profile/stat를 확인해 건너뛴다. processing item을 queued로, scan을 paused로 바꾸는 시작 시 복구는 메타데이터 정리만 수행하며 decode를 시작하지 않는다. 사용자가 재개를 선택한다. 이전에 명시적으로 시작한 scan 범위를 보존하며 새 전체 scan으로 확대하지 않는다.

## 6. 사람의 판단과 기존 화면 연결

- `SimilarityReviewBrowser`에 이미지/영상 전환을 두고 같은 비교/닫기/처리 중/오류 계약을 사용한다. 별도 중복 관리 화면을 만들지 않는다.
- 영상 선택 메뉴 `선택한 영상 비교` → 선택 ID와 함께 기존 Review 이동 → `N개 분석`으로 명시 시작한다. 선택하지 않은 영상을 포함하지 않는다.
- preview는 기존 `VideoPlayer`/`playbackUrl`을 사용한다. ready가 아니면 thumbnail과 재생 준비 상태를 표시한다. 분석 완료와 재생 준비 완료를 구분한다. 초기에는 독립 재생·수동 seek를 사용하며 동기화 player는 만들지 않는다.
- 비교 근거는 `일치한 추출 프레임 9/12`, 비교 시각, 길이/해상도/용량/출처다. PDQ 거리만으로 동일 영상이라고 쓰지 않는다. 새 frame 이미지 제공 endpoint 없이도 시각과 기존 player로 확인할 수 있게 한다.
- 결정 문구는 `왼쪽 보관 · 오른쪽 휴지통`, `오른쪽 보관 · 왼쪽 휴지통`, `둘 다 보관`, `다른 영상`이다. 보관 선택에도 metadata를 자동 승계하지 않는다.
- `keep_both`와 `not_similar`는 asset 변경 없이 판단만 저장하며 재scan에서 다시 표시하지 않는다. `not_similar`를 후속 hard-negative corpus로 활용할 때 개인 파일을 무단 export하지 않는다.

결정 처리 순서는 양쪽 **실제 원본 SHA-256 재계산** → 해당 파일 handle 유지 → trash lock → transaction → pair와 양쪽 asset normal/hash 재확인 → 기존 trash 상태 변경 helper → review resolve → commit이다. Windows에서는 파일 handle의 공유를 읽기만 허용해 commit 전 원본 덮어쓰기/삭제를 막는다. DB에 기록된 hash만 확인하고 실제 원본이 바뀐 자산을 휴지통으로 보내지 않는다. 파일 삭제/rename/신규 asset 생성은 호출하지 않는다. `trash.rs::update_trash_status`의 SQL을 `pub(crate) fn update_trash_status_in_transaction(tx, ids, from, to, trashed_at)`으로 작게 추출하고 기존 메서드도 이를 사용한다. lock을 보유한 채 public `trash_assets`를 호출하면 이중 lock이므로 금지한다.

같은 결정 재전송은 성공, 다른 결정 재전송은 conflict다. 한쪽이 이미 trash/missing/삭제/변경 상태면 stale로 표시하고 다시 읽는다. 변경된 자산을 포함하는 다른 open pair도 같은 transaction에서 stale로 만든다. 복원은 기존 휴지통 UI를 사용하며 복원했다고 dismissed pair를 다시 열지 않는다.

## 7. 실행 배치와 통과 조건

아래는 모두 **앞으로 실행할 절차**이며 계획 조사 중 실행한 결과가 아니다. 각 배치에서 관련 diff와 실제 결과를 확인하고, 무관한 기존 실패 수정으로 범위를 넓히지 않는다.

### Batch 1 — 순수 sampling/matching과 반증 fixture

**Files:** 새 `video_similarity/{mod.rs,models.rs,policy.rs,fingerprint.rs,tests.rs}`. 루트는 module 선언만 연결한다.

- [x] sample 시점·상한·duration/aspect/quality/coverage를 순수 함수로 작성한다. 정수는 영상 전용 `fingerprint.rs`가 소유한다.
- [x] 12frame 메모리 fixture로 동일/해상도 변형, 공통 opening+다른 본편, 역순, black/static, 낮은 quality, 불완전 sample, duration/aspect 초과를 검증한다. 실제 재압축은 native 배치에서 다룬다.
- [x] 완료된 fingerprint라도 근거가 부족하면 `skipped/insufficient_evidence`로 분리한다. 모든 비교 gate를 통과한 경우만 `Some(VideoMatchEvidence)`를 반환하며 나머지는 review를 만들지 않는다. 제안했던 별도 assessment enum은 필요하지 않아 만들지 않았다.
- [x] 최소 검사를 실행하고 인자·결과·fixture 적용 범위를 기록한다.

```powershell
# C:\chatgpt\app\src-tauri
cargo test --lib library::video_similarity::tests -- --nocapture
```

기대 명세 예:

```rust
assert!(compare(&a, &same_timeline, PROFILE).is_some());
assert!(compare(&a, &same_poster_other_story, PROFILE).is_none());
assert!(!has_usable_evidence(&black));
assert_eq!(sample_times(12_000), vec![500,1500,2500,3500,4500,5500,6500,7500,8500,9500,10500,11500]);
```

**Gate:** 순수 hard-negative에서 false candidate 0. 이것만으로 실제 영상 검증을 완료했다고 하지 않는다.

### Batch 2 — 제한된 FFmpeg 추출, v45 cache/job, 명시적 scan

**Files:** `video_media.rs`、新`video_similarity/scan.rs`、新command module、v45/root wiring。

- [x] 루트가 v44 WIP를 유지하면서 v45→v46 migration/schema tests를 연결했다. v44 관계 및 restore copy 보존을 포함한 DB 28개 검사가 통과했다.
- [x] frame extractor의 cancel/deadline/output cap/child reap을 구현했다. 초 문자열은 정수 초와 3자리 millisecond로 생성한다. 실제 deadline/취소 동작은 아래 native 검증으로 구분한다.
- [x] start는 선택 범위를 저장한 뒤 worker를 시작한다. 상태 조회는 가볍게, cancel은 worker 완료를 기다리지 않고 flag를 설정한다. decode 중 DB lock을 보유하지 않는다. resume은 spawn 전에 queued 상태를 transaction으로 저장한다.
- [ ] cache hit/mtime·profile 변경, 중간 cancel, timeout, source 누락, 삭제 경쟁, 재시작 paused→resume, 중복 start를 검증한다.
- [ ] test tool/fixture library로 상태 전이를 확인하고 실제 로컬 FFmpeg로 만든 짧은 합성 positive/negative를 각각 최소 1쌍 실행한다. 외부 다운로드는 필요 없다.

```powershell
# C:\chatgpt\app\src-tauri
cargo test --lib library::video_similarity::tests -- --nocapture
cargo test --lib library::video_media::tests -- --nocapture
cargo test --lib library::db::tests -- --nocapture
```

**Gate:** cancel/timeout 뒤 child가 남지 않고 ready cache는 완전하며 원본/기존 video_assets는 불변이다. 기존 `preparation_installs_complete_outputs_before_marking_ready`, `failed_video_waits_for_explicit_retry`, `ready_video_with_missing_scrub_frame_is_requeued_when_library_opens`를 포함한 현행 검사를 보존한다.

### Batch 3 — 영상 review 판단과 기존 화면의 완결 동선

**Files:** 새 `video_similarity/review.rs`, `trash.rs` transaction helper, 새 `similarity/video/*`, `SimilarityReviewBrowser.tsx`, 루트의 선택 entry/navigation.

- [x] scan 완료 시 후보 pair만 upsert한다. asset는 normal을 유지하며 기존 이미지 review 상태로 바꾸지 않는다.
- [ ] 4개 결정을 구현한다. keep-left/right가 동일 transaction의 trash 변경만 수행하고 파일 제거를 호출하지 않는지 fixture로 확인한다.
- [x] 루트가 기존 Review에 영상 pane/선택 분석 시작/progress/cancel/resume/독립 재생/결정 후 재조회를 연결했다. pane을 열기만 해서는 scan하지 않는다. `latest_video_similarity_scan` 조회로 재시작 후 이전 작업을 찾는다.
- [x] 루트가 중복 결정, 실패 시 pair 유지, privacy, Escape, 초기 latest/start 경쟁, 취소/poll 경쟁을 검증했다. 최종 관련 UI 4개 파일 32개 검사 및 영상 선택 entry 2개 검사가 통과했다.
- [ ] image review와 영상 exact ingest 회귀를 관련 범위에서 확인한다.

```powershell
# C:\chatgpt\app
npm run test -- src/similarity/SimilarityReviewBrowser.test.tsx src/similarity/video/VideoSimilarityPanel.test.tsx
npx tsc --noEmit
# C:\chatgpt\app\src-tauri
cargo test --lib library::video_similarity::tests -- --nocapture
cargo test --lib library::similarity::tests -- --nocapture
cargo test --lib library::trash::tests -- --nocapture
cargo test --lib library::ingestion::tests::exact_duplicate_video_creates_no_second_asset_or_job -- --exact
cargo test --lib library::ingestion::tests::video_ingest_never_creates_a_similarity_review -- --exact
```

PowerShell에서 각 외부 command의 `$LASTEXITCODE`를 그대로 기록하고 실패를 후속 성공으로 덮지 않는다. 현행 Cargo/Vitest 구조에 맞는 명령이며 기존 test 이름은 source에서 확인했다. 새 `video_similarity::tests`와 frontend test는 구현 때 작성할 대상이다.

**Gate:** 명시 선택→분석→후보 비교→사람 결정→재scan suppression까지 완결된다. 휴지통에서 복원할 수 있고 분류/favorite/source를 다른 쪽에 임의 승계하지 않는다. native media 재생/FFmpeg pipeline은 별도 gate다.

### Batch 4 — 실제 영상 corpus, native 제약, 정책 확정

**Files:** 새 `app/src-tauri/tests/fixtures/video-similarity/manifest.json`과 재현 가능한 로컬 fixture 생성법. 개인 영상은 commit하지 않는다. 결과는 이 문서에 실행 기록으로 덧붙이고 백로그 완료 여부는 실제 결과로만 판단한다.

- [ ] 즉시 실행 단계에서는 서로 다른 scene 구성의 합성 source를 로컬 FFmpeg로 생성한다. 움직임 많음/적음, portrait/landscape, CFR/VFR, long GOP를 포함한다. 외부 다운로드 없이 재현 가능하게 만들고, 실제 촬영/animation corpus를 대신하지 못한다는 한계를 기록한다.
- [ ] 합성 source별 재encode 3조건×해상도 2조건을 만든다. 사용 가능한 번들 encoder/build를 실제 확인하고 허용된 codec만 사용한다. 최소 positive/negative 각 1쌍의 native 추출과 판정이 즉시 구현 검증의 필수 조건이다.
- [ ] 후속 일반화 검증은 허가된 실제 source 12본/72 positive pair와 hard-negative 200쌍 이상을 목표로 한다. 서로 다른 영상, 같은 작품·캐릭터, 공통 opening/credit/logo, 같은 thumbnail, 정지 slide, 역순, 부분 공통 loop를 포함한다. audio만 바뀐 영상은 시각 일치여도 사람의 판단이 필요한 별도 label이다.
- [ ] trim 5/20/50%, subclip, letterbox, crop, watermark, rotation/SAR/VFR 경계를 별도 challenge split에 두고 v1 recall 분모에 섞지 않는다.
- [ ] source 단위로 calibration/holdout을 나누며 같은 source의 변형이 양쪽에 걸치지 않게 한다. holdout에 맞춰 threshold를 바꾸면 새 holdout으로 검증한다.
- [ ] 임계값 확정 전에 같은 장면의 다른 episode가 후보가 되는 반례를 찾는다. 판단 근거/시간/quality, 범위 내 recall, negative 오탐, Insufficient 비율을 각각 기록한다.
- [ ] 일반화 목표는 범위 내 positive 90% 이상, 고정 hard-negative 오탐 0/200 이상, cancel 응답 2초 이내, wall budget 준수, 동시 FFmpeg 1개, 원본/metadata/이미지 review 불변이다. 목표를 관측 실적으로 표현하지 않는다. 합성 fixture 통과만으로 실제 영상의 해당 정확도를 주장하지 않는다.
- [ ] native 임시 library에서 start→cancel→resume→review→trash→restore→재scan, 이전 backup restore, source 누락, 손상 media, tool 부재를 확인한다. 남은 device/FFmpeg 환경 차이는 미검증으로 적는다.

**통과 조건:** 합성 영상 재현과 기능 검증이 통과하면 명시적 제한 분석을 제공할 수 있다. 실제 corpus gate가 남아 있으면 일반화된 정확도·trim 지원을 주장하지 않는다. 실패 유형을 기록하며 ingestion 자동 차단 활성화는 포함하지 않는다.

## 8. Migration·백업·복구

- v45는 side table 추가이며 v44 캐릭터/기존 이미지 hash/review/원본/video-media를 바꾸지 않는다. 임시 library에서 v44→v45, 빈 DB→latest, v43→v44→v45를 검사한다. 후속 v46와 충돌하면 루트가 migration 순서와 SCHEMA_VERSION을 함께 정합시킨다.
- `db::initialize_database`의 pre-migration backup 경로를 사용하고 v44 backup의 quick_check/FK/row count와 v45를 확인한다. live WAL DB의 단순 파일 복사를 검증된 backup이라 하지 않는다.
- rollback은 user_version 값만 되돌리는 작업이 아니다. 이전 binary로 새 schema를 열지 않고 기존 backup restore 경로에서 선택 backup 검증→현재 DB pre-restore backup→원본 유지 복구를 수행한다. restore 임시 copy를 migration하는 현재 WIP `prepare_snapshot_for_restore`를 보존한다.
- cache는 원본에서 재생성 가능하지만 사람의 결정은 DB에 남는다. cache 정리로 review decision을 삭제하지 않는다. 자산 삭제 시 frame/cache는 FK CASCADE, decision은 hash 기반 이력으로 보존한다.
- 시작 시 scan 복구는 queued/paused 정리만 한다. 임시 directory는 이 기능의 고유 prefix 아래만 canonical 검증 후 정리하며 `video-media/` 전체를 지우지 않는다.
- backup 복원 후 running scan을 paused로 만들고 명시 재개 전에는 FFmpeg를 시작하지 않는다. 오래된 profile cache는 무효로 취급하되 전부 다시 계산하지 않는다.
- 복원 entry는 backup/catalog/database lock보다 먼저 `video_similarity_restore_guard()`를 획득한다. 이 guard는 취소 후 최대 2초 동안 worker 종료를 기다리고, active worker가 남으면 SQLite BUSY로 복원을 거절한다. idle scan-state guard를 복원 종료까지 유지해 start/resume을 차단한다. DB 교체 뒤 database guard를 놓은 다음 `recover_video_similarity_scans()`를 호출한다. scan worker는 완료 DB 기록을 마친 뒤 active state를 해제하므로 이전 worker가 복원된 DB에 이어 쓰지 않는다.

## 9. 이번에 남기는 경계

첫 완성 단위는 지정한 영상 집합의 제한 분석과 기존 Review 화면에서 사람의 판단이다. 자동 ingestion quarantine, audio fingerprint, whole-library index, BK-tree, trim sliding alignment, crop/letterbox 제거, watermark 전용 모델, 동기화 player는 포함하지 않는다. 후속 범위는 Batch 4 challenge split의 실패와 실제 비용으로 정한다.

조사 단계에서는 native test/실제 FFmpeg/운영 DB를 실행하지 않았다. 구현자는 배치별 실제 결과를 기록하고 계획의 기대값을 검증 완료로 읽지 않는다.

## 10. 최종 통합 검증 — 2026-09-08

명시 선택 기반 bounded video similarity 구현은 통합 완료 상태다. 기본 video similarity
검사는 11 passed / 1 explicit ignored였고, ignored native FFmpeg 검사를 별도로 실행해
재인코딩/해상도 변형이 12/12 slot으로 일치하고 reversed timeline이 거부되는 것을 확인했다.
FFmpeg child timeout/cancellation lifecycle도 별도 native 검사로 통과했다. 전체 Rust는
769 passed / 0 failed, 전체 frontend는 893 passed / 0 failed이며 bundled Tauri app도 정상 기동했다.

Batch 4의 대표 실제 영상 corpus는 계속 accuracy/generalization gate다. 따라서 현재 기능은
제한된 명시 분석 도구로 사용할 수 있지만 real-world recall/FP, trim/subclip/crop/watermark
지원률을 보장하는 근거로 확대 해석하지 않는다. 운영 라이브러리 scan은 이번 검증에서 실행하지 않았다.
