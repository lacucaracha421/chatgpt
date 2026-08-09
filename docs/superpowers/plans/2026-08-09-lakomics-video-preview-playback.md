# Lakomics Video Preview and Playback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MP4, WebM, MOV를 기존 이미지와 같은 자산으로 수집하고, Eagle 스타일의 갤러리 호버 미리보기·탐색과 Range 기반 전체 화면 재생을 Windows에서 제공한다.

**Architecture:** 기존 Rust `Library` Module이 수집, SQLite, 관리 경로, 파생 미디어 생명주기를 계속 소유한다. 새 내부 `video_media` Module은 FFprobe/FFmpeg 실행과 영상 준비 정책만 숨기며, React에는 태그된 미디어 요약과 자산 ID 기반 프로토콜만 공개한다. 원본이 WebView2에서 직접 재생되면 원본을 사용하고, 그렇지 않을 때만 H.264/AAC MP4 호환 재생본을 만든다.

**Tech Stack:** Windows 10/11, Tauri 2, Rust stable MSVC, rusqlite(SQLite bundled), FFmpeg/FFprobe 7.1 LGPL shared sidecars, React 19, TypeScript 5.8, Vite 7, Vitest 4, React Testing Library, 기존 Radix 기반 공통 UI와 디자인 토큰

## Global Constraints

- 기준 문서는 `docs/superpowers/specs/2026-08-09-lakomics-video-preview-playback-design.md`, `docs/adr/0025-original-first-video-playback.md`, `CONTEXT.md`, GitHub Issue #2이다.
- 구현은 사용자 지시에 따라 서브에이전트 없이 현재 메인 세션에서 순서대로 수행한다.
- 사용자 경로, 분류 이름, 영상 파일 이름으로 동작을 분기하지 않는다. 실제 Windows 검증에서 라이브러리가 등록되지 않은 경우에만 `C:\Users\namwoojun\Desktop\test`를 테스트 입력으로 사용한다.
- Linux 전용 코드, 경로, 패키징, 검증 단계는 만들지 않는다. Windows x86_64 MSVC만 지원한다.
- 원본은 수집 뒤 수정하지 않는다. 포스터·탐색 프레임·호환 재생본은 언제든 다시 만들 수 있는 파생 미디어다.
- 영상 유사도 검사는 추가하지 않는다. SHA-256 정확 중복만 기존 정책대로 차단한다.
- 영상 준비는 한 번에 하나만 실행한다. 앱 재시작 시 중단된 `processing`을 `pending`으로 되돌리고, `failed`는 사용자가 재시도하기 전까지 자동 반복하지 않는다.
- 파생 파일은 같은 파일시스템의 임시 이름으로 만든 뒤 원자적으로 최종 이름으로 교체한다. 준비 실패가 원본, 분류, 출처, 수집일, 즐겨찾기를 바꾸면 안 된다.
- FFmpeg 명령, 절대 경로, SQLite 필드, 코덱 정책은 React와 공개 오류에 노출하지 않는다.
- 갤러리에서는 동시에 하나의 영상만 재생하고 200ms 지연을 둔다. 타일 이탈·다른 타일 활성화·언마운트 시 `<video>`를 정지하고 `src`를 해제한다.
- 긴 영상은 전체 파일을 메모리에 읽지 않는다. 재생 응답은 단일 Range를 검증해 파일 구간만 읽는다.
- 새 상태 라이브러리, 범용 작업 큐, 범용 미디어 어댑터를 추가하지 않는다. 기존 React 상태, Rust 표준 라이브러리, 현재 의존성을 우선 사용한다.
- 반복되는 간격·색상·모서리·레이어는 `app/src/styles/tokens.css` 토큰을 사용하고 버튼·대화상자는 기존 `shared/ui` Interface를 사용한다.
- 모든 동작 변경은 가장 작은 RED 테스트를 먼저 확인한 뒤 GREEN 구현을 한다. 각 Task 끝에서 지정된 회귀 테스트와 `git diff --check`를 통과시킨다.
- 사용자 소유 `Lakomics (Debug).lnk`, `Lakomics.lnk`는 수정하거나 스테이징하지 않는다.

## File and Responsibility Map

- Create `app/src-tauri/migrations/0004_video_media.sql`: `assets`의 영상 허용과 nullable 포스터 경로, `video_assets` 준비 상태·코덱·파생 미디어 메타데이터.
- Modify `app/src-tauri/src/library/db.rs`: schema v4 적용과 검증된 사전 마이그레이션 백업.
- Modify `app/src-tauri/src/library/models.rs`: 태그된 `MediaSummary`, 범용 수집 요청, 영상 준비 상태·진행 모델.
- Create `app/src-tauri/src/library/video_media.rs`: MP4/WebM/MOV 검사, FFprobe JSON 해석, 직접 재생 정책, 포스터·탐색 프레임·호환본 생성, 준비 상태 전이.
- Modify `app/src-tauri/src/library/ingestion.rs`: 이미지와 영상을 하나의 `ingest_media` 진입점으로 라우팅하고 영상 원본을 빠르게 `pending` 등록.
- Modify `app/src-tauri/src/library/query.rs`, `app/src-tauri/src/library/similarity.rs`: 모든 공개 자산 조회에서 태그된 미디어 요약 구성.
- Modify `app/src-tauri/src/library/mod.rs`: 영상 디렉터리 생성, 중단 작업 복구, Range 가능한 미디어 해석 Interface.
- Modify `app/src-tauri/src/library/trash.rs`, `app/src-tauri/src/library/drag_out.rs`: 영상 파생 미디어의 휴지통·복구·영구 삭제·탐색기 복사 생명주기.
- Modify `app/src-tauri/src/library/error.rs`: 영상 입력·준비·Range 오류를 내부 정보 없이 공개.
- Create `app/src-tauri/binaries/README.md`, `app/src-tauri/binaries/THIRD-PARTY-NOTICES.md`, `scripts/fetch-ffmpeg-windows.ps1`: 고정된 LGPL Windows FFmpeg 번들 출처·해시·설치.
- Modify `app/src-tauri/tauri.conf.json`: FFmpeg/FFprobe sidecar와 공유 DLL 리소스 번들.
- Modify `app/src-tauri/src/commands.rs`, `app/src-tauri/src/lib.rs`: 범용 수집, 준비 진행, 재시도 명령과 시작 시 준비 재개.
- Modify `app/src-tauri/src/media_protocol.rs`: `thumbnail`, `playback`, `scrub-frame` 프로토콜과 HTTP Range.
- Modify `app/src/library/types.ts`, `app/src/library/client.ts`, `app/src/library/client.test.ts`: 작은 Tauri `LibraryGateway` 계약.
- Modify `app/src/ingestion/useFileDrop.ts`, `app/src/ingestion/useFileDrop.test.ts`, `app/src/ingestion/WorkTray.tsx`, `app/src/ingestion/WorkTray.test.tsx`: 영상 드롭 등록과 준비 상태 표시·재시도.
- Create `app/src/video/useVideoPreparation.ts`, `app/src/video/useVideoPreparation.test.ts`: 순차 background preparation loop.
- Create `app/src/video/VideoTileMedia.tsx`, `app/src/video/VideoTileMedia.test.tsx`: 한 개만 활성화되는 200ms 호버 재생과 탐색 프레임.
- Create `app/src/video/VideoPlayer.tsx`, `app/src/video/VideoPlayer.test.tsx`: 전체 화면 플레이어 동작.
- Modify `app/src/assets/AssetGallery.tsx`, `app/src/assets/AssetGallery.test.tsx`, `app/src/assets/AssetViewer.tsx`, `app/src/assets/AssetViewer.test.tsx`, `app/src/assets/mediaUrl.ts`, `app/src/assets/mediaUrl.test.ts`: 미디어 종류별 렌더링과 URL 생성.
- Modify `app/src/assets/AssetBrowser.tsx`, `app/src/app/App.tsx`, 해당 테스트: 준비 갱신, 재시도, 전체 화면 플레이어 연결.
- Modify `app/src/styles/tokens.css`, `app/src/styles/global.css`: 기존 UI 토큰을 사용한 영상 타일·플레이어 스타일.
- Modify `app/src-tauri/tests/foundation_flow.rs`: v3→v4 마이그레이션, 영상 수집·중복·생명주기 통합 검증.
- Modify `app/README.md`, Create `docs/acceptance/2026-08-09-video-preview-playback.md`: sidecar 출처, 명령, 실제 Windows 검증 증거.

---

### Task 1: Schema Version 4 and Tagged Media Models

**Files:**
- Create: `app/src-tauri/migrations/0004_video_media.sql`
- Modify: `app/src-tauri/src/library/db.rs`
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/src/library/query.rs`
- Modify: `app/src-tauri/src/library/similarity.rs`
- Modify: `app/src-tauri/src/library/ingestion.rs`
- Modify: `app/src-tauri/src/library/trash.rs`
- Modify: `app/src-tauri/tests/foundation_flow.rs`

**Interfaces:**
- Consumes: schema v3 `assets`, verified pre-migration snapshot helper, current image/gif rows.
- Produces: schema v4, `MediaSummary`, `VideoPreparationState`, nullable internal thumbnail path, public image/gif/video discrimination.

- [x] **Step 1: Write RED migration and serialization tests**

Add a real v3 fixture in `foundation_flow.rs` and prove migration preserves the existing image while permitting a pending video with no poster:

```rust
#[test]
fn version_three_library_migrates_video_state_without_changing_images() {
    let fixture = version_three_library();
    let library = Library::open(fixture.root()).unwrap();
    let connection = Connection::open(library.root().join("library.sqlite")).unwrap();

    assert_eq!(user_version(&library), 4);
    let preserved: (String, String) = connection.query_row(
        "SELECT media_kind, thumbnail_relative_path FROM assets WHERE id = 'asset-1'",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).unwrap();
    assert_eq!(preserved, ("image".into(), "thumbnails/aa/image.webp".into()));
    connection.execute(
        "INSERT INTO assets (id, content_hash, media_kind, original_name, relative_path,
          thumbnail_relative_path, byte_size, width, height, collected_at)
         VALUES ('video-1', 'video-hash', 'video', 'clip.webm', 'assets/vi/clip.webm',
          NULL, 10, 1920, 1080, '2026-08-09T00:00:00Z')",
        [],
    ).unwrap();
    assert_eq!(pre_migration_backups(library.root()).len(), 1);
}
```

Add `models.rs` serialization tests for these exact public shapes and assert managed paths/codecs do not serialize:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum MediaSummary {
    Image,
    Gif,
    Video {
        duration_ms: u64,
        preparation_state: VideoPreparationState,
        scrub_frame_count: u32,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VideoPreparationState { Pending, Processing, Ready, Failed }
```

`AssetSummary.thumbnail_relative_path` becomes `Option<String>` internally and gets a new public `media: MediaSummary` field.

- [x] **Step 2: Run RED tests**

```powershell
cd C:\chatgpt\app\src-tauri
cargo test version_three_library_migrates_video_state_without_changing_images
cargo test video_asset_summary_serialization_hides_internal_media_details
```

Expected: FAIL because schema v4 and tagged media fields do not exist.

- [x] **Step 3: Implement schema and row mapping**

`0004_video_media.sql` rebuilds only `assets` so its existing CHECK and NOT NULL rules can change safely. `db.rs` disables `foreign_keys` before opening the v4 transaction, copies every existing column into `assets_v4`, drops `assets`, renames `assets_v4`, recreates all three asset indexes, commits, re-enables `foreign_keys`, and then requires `PRAGMA foreign_key_check` to return no rows. An error path re-enables `foreign_keys` before returning. The new table keeps existing constraints except:

```sql
media_kind TEXT NOT NULL CHECK (media_kind IN ('image', 'gif', 'video')),
thumbnail_relative_path TEXT UNIQUE,
CHECK (media_kind = 'video' OR thumbnail_relative_path IS NOT NULL)
```

Create the one-to-one video table:

```sql
CREATE TABLE video_assets (
    asset_id TEXT PRIMARY KEY NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
    container TEXT NOT NULL,
    video_codec TEXT NOT NULL,
    audio_codec TEXT,
    preparation_state TEXT NOT NULL
        CHECK (preparation_state IN ('pending', 'processing', 'ready', 'failed')),
    preparation_error TEXT,
    playback_kind TEXT CHECK (playback_kind IN ('original', 'proxy')),
    poster_relative_path TEXT,
    scrub_relative_dir TEXT,
    scrub_frame_count INTEGER NOT NULL DEFAULT 0 CHECK (scrub_frame_count >= 0),
    proxy_relative_path TEXT,
    preparation_version INTEGER NOT NULL DEFAULT 1 CHECK (preparation_version > 0),
    CHECK (
      (preparation_state IN ('pending', 'processing') AND preparation_error IS NULL)
      OR (preparation_state = 'failed' AND preparation_error IS NOT NULL)
      OR (preparation_state = 'ready' AND preparation_error IS NULL
          AND playback_kind IS NOT NULL AND poster_relative_path IS NOT NULL
          AND scrub_relative_dir IS NOT NULL)
    )
);

CREATE INDEX video_assets_by_preparation
ON video_assets(preparation_state, asset_id);

PRAGMA user_version = 4;
```

Update every asset SELECT to LEFT JOIN `video_assets` and use a single `pub(crate)` `asset_summary_from_row` mapping function in `query.rs`. `similarity.rs` calls that helper rather than maintaining a second field list. Existing image/gif results must serialize `media: { kind: "image" | "gif" }`. Add the correct image/gif media value to existing constructors in `ingestion.rs`, `trash.rs`, model tests, and integration fixtures so Task 1 compiles without making ingestion behavior changes yet.

- [x] **Step 4: Run GREEN and regression tests**

```powershell
cd C:\chatgpt\app\src-tauri
cargo test version_three_library_migrates_video_state_without_changing_images
cargo test asset_summary
cargo test foundation_flow
cargo test query
git diff --check
```

- [x] **Step 5: Commit Task 1**

```powershell
cd C:\chatgpt
git add app/src-tauri/migrations/0004_video_media.sql app/src-tauri/src/library/db.rs app/src-tauri/src/library/models.rs app/src-tauri/src/library/query.rs app/src-tauri/src/library/similarity.rs app/src-tauri/src/library/ingestion.rs app/src-tauri/src/library/trash.rs app/src-tauri/tests/foundation_flow.rs
git commit -m "feat: add persistent video media state"
```

---

### Task 2: Pin and Bundle the Windows LGPL FFmpeg Toolchain

**Files:**
- Create: `scripts/fetch-ffmpeg-windows.ps1`
- Create: `app/src-tauri/binaries/README.md`
- Create: `app/src-tauri/binaries/THIRD-PARTY-NOTICES.md`
- Modify: `app/src-tauri/.gitignore`
- Modify: `app/src-tauri/tauri.conf.json`

**Interfaces:**
- Consumes: BtbN FFmpeg-Builds immutable release `autobuild-2026-08-08-13-06`, asset `ffmpeg-n7.1.5-12-g1fdbca85aa-win64-lgpl-shared-7.1.zip`.
- Produces: local Tauri sidecars `ffmpeg-x86_64-pc-windows-msvc.exe`, `ffprobe-x86_64-pc-windows-msvc.exe` and adjacent shared DLL resources, reproducible hash verification.

- [x] **Step 1: Add a failing packaging contract check**

Create `scripts/fetch-ffmpeg-windows.ps1` first with constants and a preflight assertion that intentionally fails until extraction/copying is implemented. The immutable download is:

```text
https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-08-08-13-06/ffmpeg-n7.1.5-12-g1fdbca85aa-win64-lgpl-shared-7.1.zip
SHA-256 4450e09c6740b39777a195569b61cf415a3e7ccaf0eb17f8ac9e16c84787dab3
```

The check must fail if the archive hash differs, `ffmpeg -version` or `ffprobe -version` fails, or `ffmpeg -version` contains `--enable-gpl`/`--enable-nonfree`.

- [x] **Step 2: Run RED packaging check**

```powershell
cd C:\chatgpt
powershell -ExecutionPolicy Bypass -File scripts/fetch-ffmpeg-windows.ps1 -VerifyOnly
```

Expected: FAIL because the sidecars are not present.

- [x] **Step 3: Implement the idempotent downloader and bundle config**

The script downloads to a unique temp directory, validates SHA-256 before extraction, copies only `ffmpeg.exe`, `ffprobe.exe`, required `av*.dll`, `sw*.dll`, `postproc*.dll`, and upstream license files, then verifies both executables. It never deletes outside its temp directory or `app/src-tauri/binaries` exact targets.

Use Tauri's required target-triple names:

```json
"externalBin": [
  "binaries/ffmpeg",
  "binaries/ffprobe"
],
"resources": {
  "binaries/*.dll": ".",
  "binaries/ffmpeg-license/*": "ffmpeg-license/"
}
```

Ignore fetched executables and DLLs, but commit README, notices, and source/license metadata. `THIRD-PARTY-NOTICES.md` records the pinned release, archive name, SHA-256, BtbN MIT build-script license, FFmpeg LGPL notice, and FFmpeg source/build links.

- [x] **Step 4: Run GREEN packaging checks**

```powershell
cd C:\chatgpt
powershell -ExecutionPolicy Bypass -File scripts/fetch-ffmpeg-windows.ps1
powershell -ExecutionPolicy Bypass -File scripts/fetch-ffmpeg-windows.ps1 -VerifyOnly
app\src-tauri\binaries\ffmpeg-x86_64-pc-windows-msvc.exe -hide_banner -encoders | Select-String 'h264_mf'
app\src-tauri\binaries\ffmpeg-x86_64-pc-windows-msvc.exe -hide_banner -encoders | Select-String 'aac'
git diff --check
```

Expected: both encoders exist and the version configuration has no GPL/nonfree flags.

- [x] **Step 5: Commit Task 2**

```powershell
git add scripts/fetch-ffmpeg-windows.ps1 app/src-tauri/binaries/README.md app/src-tauri/binaries/THIRD-PARTY-NOTICES.md app/src-tauri/.gitignore app/src-tauri/tauri.conf.json
git commit -m "build: pin Windows LGPL video sidecars"
```

---

### Task 3: Deep VideoMedia Module for Probe and Preparation

**Files:**
- Create: `app/src-tauri/src/library/video_media.rs`
- Modify: `app/src-tauri/src/library/mod.rs`
- Modify: `app/src-tauri/src/library/error.rs`
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/src/commands.rs`

**Interfaces:**
- Consumes: managed original path, `video_assets` row, pinned FFmpeg/FFprobe binaries.
- Produces: `probe_video`, `prepare_pending_videos(limit)`, `retry_video_preparation(asset_id)`, poster/scrub/proxy files and stable public progress.

- [x] **Step 1: Write RED policy and state-machine tests**

Add focused unit tests using an internal test-only `VideoTool` fake. The private trait exists because production sidecars and deterministic tests are two real implementations; it is not exported from `library`:

```rust
trait VideoTool {
    fn probe(&self, source: &Path) -> Result<VideoProbe, LibraryError>;
    fn create_poster(&self, request: &PosterRequest) -> Result<(), LibraryError>;
    fn create_scrub_frames(&self, request: &ScrubRequest) -> Result<(), LibraryError>;
    fn create_proxy(&self, request: &ProxyRequest) -> Result<(), LibraryError>;
}
```

Tests cover:

```rust
#[test] fn webm_vp9_opus_uses_original_playback() { /* direct */ }
#[test] fn mov_prores_uses_proxy_playback() { /* proxy */ }
#[test] fn scrub_plan_uses_one_frame_per_second_up_to_two_hundred_forty() { /* 20s => 20, 3600s => 240 */ }
#[test] fn preparation_installs_complete_outputs_before_marking_ready() { /* atomic */ }
#[test] fn proxy_failure_keeps_directly_playable_original_ready() { /* no failed */ }
#[test] fn interrupted_processing_is_requeued_when_library_opens() { /* processing -> pending */ }
#[test] fn failed_video_is_not_selected_until_explicit_retry() { /* failed stays */ }
```

Direct playback allow-list is owned here:

```rust
fn direct_playback(container: &str, video_codec: &str, audio_codec: Option<&str>) -> bool {
    matches!((container, video_codec, audio_codec),
        ("mp4" | "mov", "h264", None | Some("aac" | "mp3"))
        | ("webm", "vp8" | "vp9" | "av1", None | Some("opus" | "vorbis")))
}
```

- [x] **Step 2: Run RED module tests**

```powershell
cd C:\chatgpt\app\src-tauri
cargo test video_media::tests
```

Expected: FAIL because the module does not exist.

- [x] **Step 3: Implement the minimum module**

Use `std::process::Command` only inside private `ProcessVideoTool`; Tauri `externalBin` still owns sidecar packaging and no shell permission or JavaScript command surface is added. Resolve `ffmpeg.exe`/`ffprobe.exe` beside the packaged executable, beside the cargo-test target, or at the pinned source-binary directory, and convert only exit status/stdout into private probe/preparation results. Command construction remains private to `video_media.rs`.

FFprobe emits JSON with `-show_streams -show_format -of json`. Deserialize only required fields with `serde_json`; normalize container to `mp4`, `webm`, or `mov`; choose the first video stream and optional first audio stream; reject missing/zero duration and invalid dimensions.

Preparation version is a module constant:

```rust
const VIDEO_PREPARATION_VERSION: i64 = 1;
const MAX_SCRUB_FRAMES: u32 = 240;
const SCRUB_SECONDS_PER_FRAME: f64 = 1.0;
const PROXY_MAX_WIDTH: u32 = 1920;
const PROXY_MAX_HEIGHT: u32 = 1080;
const PROXY_MAX_FPS: u32 = 30;
```

Generated layout is content-addressed by asset ID and never public:

```text
video-media/{asset_id}/poster.webp
video-media/{asset_id}/scrub/000.webp ...
video-media/{asset_id}/playback.mp4
```

Commands use argument arrays, never a command string. Poster is WebP; scrub frames are evenly spaced; proxy uses `h264_mf`, `-pix_fmt nv12`, max 1920x1080 preserving aspect ratio, max 30fps, built-in AAC, and `-movflags +faststart`. Each output is written under `.pending-{uuid}` and renamed only after a non-empty file check.

Reserve a pending row atomically:

```sql
UPDATE video_assets
SET preparation_state = 'processing'
WHERE asset_id = (
  SELECT asset_id FROM video_assets
  WHERE preparation_state = 'pending'
  ORDER BY asset_id LIMIT 1
)
RETURNING asset_id;
```

`prepare_pending_videos(limit)` processes at most `limit.clamp(1, 10)` sequentially and returns:

```rust
pub struct VideoPreparationProgress {
    pub processed: u32,
    pub remaining: u32,
    pub failed: u32,
    pub changed_asset_ids: Vec<String>,
}
```

- [x] **Step 4: Run GREEN module tests and clippy**

```powershell
cd C:\chatgpt\app\src-tauri
cargo test video_media::tests
cargo clippy --all-targets -- -D warnings
git diff --check
```

- [x] **Step 5: Commit Task 3**

```powershell
git add app/src-tauri/src/library/video_media.rs app/src-tauri/src/library/mod.rs app/src-tauri/src/library/error.rs app/src-tauri/src/library/models.rs app/src-tauri/src/commands.rs
git commit -m "feat: prepare derived video media"
```

---

### Task 4: Generalize Ingestion and Preserve Exact-Duplicate Semantics

**Files:**
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/src/library/ingestion.rs`
- Modify: `app/src-tauri/src/library/similarity.rs`
- Modify: `app/src-tauri/tests/foundation_flow.rs`

**Interfaces:**
- Consumes: existing atomic image ingest, `VideoMedia::probe`, exact content hash lock.
- Produces: `ingest_media(IngestMediaRequest) -> IngestOutcome`; images retain similarity review, videos return added/exact duplicate only.

- [x] **Step 1: Write RED integration tests**

Use tiny generated fixture files and a `#[cfg(test)]` probe hook in `ingestion.rs` rather than checking large real videos into git:

```rust
#[test]
fn video_ingest_registers_original_and_pending_job_atomically() {
    let fixture = Fixture::new();
    let source = fixture.video("clip.webm", b"valid-video-fixture");
    let outcome = fixture.library.ingest_media(IngestMediaRequest {
        source_path: source,
        classification_id: Some(fixture.work.id.clone()),
        source_url: Some("https://example.test/post".into()),
    }).unwrap();
    let IngestOutcome::Added { asset } = outcome else { panic!() };
    assert!(matches!(asset.media, MediaSummary::Video {
        preparation_state: VideoPreparationState::Pending, ..
    }));
    assert_eq!(fixture.library.get_asset_classifications(&asset.id).unwrap(), vec![fixture.work.id]);
}

#[test] fn exact_duplicate_video_creates_no_second_asset_or_job() { /* same bytes twice */ }
#[test] fn video_never_creates_a_similarity_review() { /* close names/metadata */ }
#[test] fn unsupported_extension_leaves_no_managed_file_or_database_row() { /* .mkv */ }
#[test] fn existing_image_ingest_and_similarity_behavior_is_unchanged() { /* regression */ }
```

- [x] **Step 2: Run RED ingestion tests**

```powershell
cd C:\chatgpt\app\src-tauri
cargo test video_ingest
cargo test exact_duplicate_video
cargo test existing_image_ingest_and_similarity_behavior_is_unchanged
```

- [x] **Step 3: Implement a single media entry point**

Rename the request without changing JSON field names:

```rust
pub struct IngestMediaRequest {
    pub source_path: PathBuf,
    pub classification_id: Option<String>,
    pub source_url: Option<String>,
}
```

`ingest_media` validates extension first. Image/gif calls the existing image path unchanged. MP4/WebM/MOV uses the same staging copy + SHA-256 + duplicate lookup + atomic install helpers, probes the staged file, then inserts `assets` and `video_assets` plus classification in one transaction. The public asset can appear immediately with source dimensions, duration, `thumbnail_relative_path = NULL`, and `preparation_state = pending`.

Keep `ingest_image` only as a private helper for the image branch; remove the public duplicate command instead of supporting two frontend contracts.

- [x] **Step 4: Run GREEN ingestion and full Rust tests**

```powershell
cd C:\chatgpt\app\src-tauri
cargo test video_ingest
cargo test exact_duplicate_video
cargo test existing_image_ingest_and_similarity_behavior_is_unchanged
cargo test
git diff --check
```

- [x] **Step 5: Commit Task 4**

```powershell
git add app/src-tauri/src/library/models.rs app/src-tauri/src/library/ingestion.rs app/src-tauri/src/library/similarity.rs app/src-tauri/tests/foundation_flow.rs
git commit -m "feat: ingest image and video assets"
```

---

### Task 5: Video Lifecycle, Commands, and Gateway Contract

**Files:**
- Modify: `app/src-tauri/src/library/trash.rs`
- Modify: `app/src-tauri/src/library/drag_out.rs`
- Modify: `app/src-tauri/src/library/mod.rs`
- Modify: `app/src-tauri/src/commands.rs`
- Modify: `app/src-tauri/src/lib.rs`
- Modify: `app/src-tauri/tests/foundation_flow.rs`
- Modify: `app/src/library/types.ts`
- Modify: `app/src/library/client.ts`
- Modify: `app/src/library/client.test.ts`
- Modify: `app/src/app/App.test.tsx`
- Modify: `app/src/assets/AssetBrowser.test.tsx`
- Modify: `app/src/assets/AssetGallery.test.tsx`
- Modify: `app/src/assets/AssetInspector.test.tsx`
- Modify: `app/src/assets/AssetViewer.test.tsx`
- Modify: `app/src/ingestion/useFileDrop.test.ts`
- Modify: `app/src/safety/TrashBrowser.test.tsx`
- Modify: `app/src/similarity/SimilarityReviewBrowser.test.tsx`

**Interfaces:**
- Consumes: existing trash/restore/purge/drag-out ownership rules and `VideoMedia` public methods.
- Produces: `ingest_media`, `prepare_pending_videos`, `retry_video_preparation` Tauri calls; video derivatives follow asset lifecycle.

- [x] **Step 1: Write RED lifecycle and client contract tests**

Rust integration tests prove trash retains derivatives, restore reuses them, permanent purge removes the entire exact `video-media/{asset_id}` directory and row, and drag-out copies only the original. A missing derivative causes library open/check to requeue preparation without replacing the original.

Frontend contract test expects exact invoke payloads:

```ts
expect(invoke).toHaveBeenCalledWith("ingest_media", { request });
expect(invoke).toHaveBeenCalledWith("prepare_pending_videos", { limit: 1 });
expect(invoke).toHaveBeenCalledWith("retry_video_preparation", { assetId: "video-1" });
```

- [x] **Step 2: Run RED tests**

```powershell
cd C:\chatgpt\app\src-tauri
cargo test video_trash
cargo test video_drag_out
cd C:\chatgpt\app
npm.cmd test -- src/library/client.test.ts
```

- [x] **Step 3: Implement lifecycle and public gateway**

`Library::managed_paths_for_asset` returns original, optional thumbnail, poster, scrub directory, and optional proxy; purge validates every resolved target stays under the canonical library root before deletion. Restore changes status only. Drag-out continues resolving the original `relative_path` only.

Expose these TypeScript types exactly:

```ts
export type VideoPreparationState = "pending" | "processing" | "ready" | "failed";
export type MediaSummary =
  | { kind: "image" }
  | { kind: "gif" }
  | { kind: "video"; durationMs: number; preparationState: VideoPreparationState; scrubFrameCount: number };

export type IngestMediaInput = {
  sourcePath: string;
  classificationId: string | null;
  sourceUrl: string | null;
};

export type VideoPreparationProgress = {
  processed: number;
  remaining: number;
  failed: number;
  changedAssetIds: string[];
};
```

Replace `LibraryGateway.ingestImage` with `ingestMedia`; add preparation and retry methods. Register only the new command name in Tauri.

Add `media: { kind: "image" }` to every existing frontend asset fixture found by `rg -l "originalName:" app/src --glob '*.test.ts' --glob '*.test.tsx'`; use video media only in new video-specific cases. This is an explicit type migration, not an optional compatibility field.

- [x] **Step 4: Run GREEN lifecycle and gateway tests**

```powershell
cd C:\chatgpt\app\src-tauri
cargo test video_trash
cargo test video_drag_out
cargo test
cd C:\chatgpt\app
npm.cmd test -- src/library/client.test.ts
npm.cmd run build
git diff --check
```

- [x] **Step 5: Commit Task 5**

```powershell
git add app/src-tauri/src/library/trash.rs app/src-tauri/src/library/drag_out.rs app/src-tauri/src/library/mod.rs app/src-tauri/src/commands.rs app/src-tauri/src/lib.rs app/src-tauri/tests/foundation_flow.rs app/src/library/types.ts app/src/library/client.ts app/src/library/client.test.ts app/src/app/App.test.tsx app/src/assets/AssetBrowser.test.tsx app/src/assets/AssetGallery.test.tsx app/src/assets/AssetInspector.test.tsx app/src/assets/AssetViewer.test.tsx app/src/ingestion/useFileDrop.test.ts app/src/safety/TrashBrowser.test.tsx app/src/similarity/SimilarityReviewBrowser.test.tsx
git commit -m "feat: expose video preparation lifecycle"
```

---

### Task 6: Streaming Media Protocol with HTTP Range

**Files:**
- Modify: `app/src-tauri/src/library/mod.rs`
- Modify: `app/src-tauri/src/media_protocol.rs`
- Modify: `app/src-tauri/src/lib.rs`
- Modify: `app/src/assets/mediaUrl.ts`
- Modify: `app/src/assets/mediaUrl.test.ts`

**Interfaces:**
- Consumes: prepared video metadata and canonical managed path validation.
- Produces: `thumbnail(assetId)`, `playback(assetId)`, `scrubFrame(assetId, frameIndex)` without exposing a path.

- [x] **Step 1: Write RED protocol tests**

Add Rust tests for bounded, open-ended, suffix, un-ranged playback, unsatisfiable, multi-range, missing derivative, and trash asset requests. Required behavior:

```text
no Range       -> 416 for playback, Content-Range: bytes */total
bytes=10-19    -> 206, Content-Range: bytes 10-19/total, exactly 10 bytes
bytes=10-      -> 206 from byte 10
bytes=-10      -> 206 final 10 bytes
invalid/multi  -> 416, Content-Range: bytes */total
```

Add TS URL tests:

```ts
expect(playbackUrl("a/b")).toBe("http://lakomics.localhost/playback/a%2Fb");
expect(scrubFrameUrl("a/b", 12)).toBe("http://lakomics.localhost/scrub-frame/a%2Fb/12");
```

- [x] **Step 2: Run RED protocol tests**

```powershell
cd C:\chatgpt\app\src-tauri
cargo test media_protocol
cd C:\chatgpt\app
npm.cmd test -- src/assets/mediaUrl.test.ts
```

- [x] **Step 3: Implement seekable file responses**

Change `MediaResponse` from `Vec<u8>` to metadata plus an opened `File`. `resolve_media` selects:

```rust
pub enum MediaVariant {
    Asset,
    Thumbnail,
    Playback,
    ScrubFrame(u32),
}
```

`Playback` resolves original or proxy from `video_assets.playback_kind`; `ScrubFrame` validates `frame_index < scrub_frame_count` and builds the private name. Protocol parsing percent-decodes only the asset ID segment and rejects extra segments. Tauri's custom-protocol body is byte-backed rather than a streaming body, so playback requires a single `Range` request and reads only that validated range with `Seek` + `Read::take`; an un-ranged playback or multi-range request returns `416` with `Content-Range: bytes */total` instead of loading the whole video. Thumbnail, scrub frame, and image asset responses keep their current complete-body behavior.

Extend CSP `media-src` to `http://lakomics.localhost` while leaving `connect-src` unchanged.

- [x] **Step 4: Run GREEN protocol tests**

```powershell
cd C:\chatgpt\app\src-tauri
cargo test media_protocol
cd C:\chatgpt\app
npm.cmd test -- src/assets/mediaUrl.test.ts
npm.cmd run build
git diff --check
```

- [x] **Step 5: Commit Task 6**

```powershell
git add app/src-tauri/src/library/mod.rs app/src-tauri/src/media_protocol.rs app/src-tauri/src/lib.rs app/src-tauri/tauri.conf.json app/src/assets/mediaUrl.ts app/src/assets/mediaUrl.test.ts
git commit -m "feat: stream prepared video media"
```

---

### Task 7: Drop Ingestion and Resumable Preparation UI

**Files:**
- Modify: `app/src/ingestion/useFileDrop.ts`
- Modify: `app/src/ingestion/useFileDrop.test.ts`
- Modify: `app/src/ingestion/WorkTray.tsx`
- Modify: `app/src/ingestion/WorkTray.test.tsx`
- Create: `app/src/video/useVideoPreparation.ts`
- Create: `app/src/video/useVideoPreparation.test.ts`
- Modify: `app/src/app/App.tsx`
- Modify: `app/src/app/App.test.tsx`

**Interfaces:**
- Consumes: `LibraryGateway.ingestMedia`, `preparePendingVideos(1)`, `retryVideoPreparation`.
- Produces: images and videos use the same drag/drop queue; added pending videos start one-at-a-time preparation and refresh changed assets.

- [ ] **Step 1: Write RED hook and UI tests**

Update drop tests to prove `.webm`, `.mp4`, `.mov` paths call `ingestMedia`, errors remain per-file, and images still work. Add fake-timer preparation tests:

```ts
it("prepares one pending video at a time until remaining is zero", async () => {
  gateway.preparePendingVideos
    .mockResolvedValueOnce({ processed: 1, remaining: 1, failed: 0, changedAssetIds: ["v1"] })
    .mockResolvedValueOnce({ processed: 1, remaining: 0, failed: 0, changedAssetIds: ["v2"] });
  // assert no overlapping promise and onChanged receives v1 then v2
});
```

Tests also prove unmount stops scheduling and a rejected call shows one recoverable work item instead of spinning.

- [ ] **Step 2: Run RED frontend tests**

```powershell
cd C:\chatgpt\app
npm.cmd test -- src/ingestion/useFileDrop.test.ts src/ingestion/WorkTray.test.tsx src/video/useVideoPreparation.test.ts src/app/App.test.tsx
```

- [ ] **Step 3: Implement the small preparation loop**

Rename option `ingestImage` to `ingestMedia`; do not filter by extension in React because Rust owns validation. Add `preparation` as an `IngestionWork.kind` only when a pending/processing video exists. `useVideoPreparation` runs one request, refreshes only `changedAssetIds`, then queues the next microtask if `remaining > 0`; no polling interval and no global store.

`WorkTray` displays `미리보기 준비 중`, `미리보기 준비 완료`, or `미리보기 준비 실패` with the existing Button/Toast patterns. Failed asset retry calls the gateway then restarts the loop.

- [ ] **Step 4: Run GREEN frontend tests**

```powershell
cd C:\chatgpt\app
npm.cmd test -- src/ingestion/useFileDrop.test.ts src/ingestion/WorkTray.test.tsx src/video/useVideoPreparation.test.ts src/app/App.test.tsx
npm.cmd run build
git diff --check
```

- [ ] **Step 5: Commit Task 7**

```powershell
git add app/src/ingestion/useFileDrop.ts app/src/ingestion/useFileDrop.test.ts app/src/ingestion/WorkTray.tsx app/src/ingestion/WorkTray.test.tsx app/src/video/useVideoPreparation.ts app/src/video/useVideoPreparation.test.ts app/src/app/App.tsx app/src/app/App.test.tsx
git commit -m "feat: prepare dropped videos in background"
```

---

### Task 8: Eagle-Style Gallery Hover Preview and Scrubbing

**Files:**
- Create: `app/src/video/VideoTileMedia.tsx`
- Create: `app/src/video/VideoTileMedia.test.tsx`
- Modify: `app/src/assets/AssetGallery.tsx`
- Modify: `app/src/assets/AssetGallery.test.tsx`
- Modify: `app/src/assets/AssetBrowser.tsx`
- Modify: `app/src/assets/AssetBrowser.test.tsx`
- Modify: `app/src/styles/tokens.css`
- Modify: `app/src/styles/global.css`

**Interfaces:**
- Consumes: video `MediaSummary`, `thumbnailUrl`, `playbackUrl`, `scrubFrameUrl`.
- Produces: poster/pending/failed states, 200ms muted hover playback, progress-bar frame preview and seek, globally one active tile.

- [ ] **Step 1: Write RED interaction tests**

Use fake timers and mocked `HTMLMediaElement.play/pause/load`. Tests prove:

- 199ms hover does not attach playback; 200ms attaches and calls muted `play()`.
- activating `video-2` deactivates `video-1`; leaving clears `src`, calls `pause()` and `load()`.
- virtualized unmount performs the same cleanup.
- pointer position maps `x / width` to `round(ratio * (scrubFrameCount - 1))` and `ratio * duration`.
- progress pointer events stop propagation so selection and asset drag callbacks are not called.
- pending shows compact progress state; failed shows retry button; ready shows poster, video icon, duration.

- [ ] **Step 2: Run RED tile tests**

```powershell
cd C:\chatgpt\app
npm.cmd test -- src/video/VideoTileMedia.test.tsx src/assets/AssetGallery.test.tsx src/assets/AssetBrowser.test.tsx
```

- [ ] **Step 3: Implement one-active-tile ownership**

Keep `activePreviewId` in `AssetGallery`, the nearest common owner; do not add context. `VideoTileMedia` receives `active`, `onRequestActive`, `onReleaseActive`, and `onRetry`. It renders `<img>` normally and creates `<video muted playsInline preload="metadata">` only when active.

Progress interaction uses pointer capture. While moving, show the discrete scrub WebP immediately; after a 120ms stable pointer delay set `video.currentTime`. On pointer leave, clear preview frame and release active playback. Double-click/Enter remain owned by the outer tile and open the viewer.

Use design tokens for progress height, overlay background, duration chip, and status badge. Add only semantic video tokens used by both gallery and player.

- [ ] **Step 4: Run GREEN gallery tests and accessibility checks**

```powershell
cd C:\chatgpt\app
npm.cmd test -- src/video/VideoTileMedia.test.tsx src/assets/AssetGallery.test.tsx src/assets/AssetBrowser.test.tsx
npm.cmd run build
git diff --check
```

- [ ] **Step 5: Commit Task 8**

```powershell
git add app/src/video/VideoTileMedia.tsx app/src/video/VideoTileMedia.test.tsx app/src/assets/AssetGallery.tsx app/src/assets/AssetGallery.test.tsx app/src/assets/AssetBrowser.tsx app/src/assets/AssetBrowser.test.tsx app/src/styles/tokens.css app/src/styles/global.css
git commit -m "feat: preview and scrub gallery videos"
```

---

### Task 9: Fullscreen Video Player

**Files:**
- Create: `app/src/video/VideoPlayer.tsx`
- Create: `app/src/video/VideoPlayer.test.tsx`
- Modify: `app/src/assets/AssetViewer.tsx`
- Modify: `app/src/assets/AssetViewer.test.tsx`
- Modify: `app/src/styles/global.css`

**Interfaces:**
- Consumes: active `AssetSummary`, previous/next assets, `playbackUrl`, `scrubFrameUrl`, existing fullscreen `Dialog` and `Button`.
- Produces: play/pause, time, seek, timeline hover preview, mute/volume, fullscreen, keyboard and sibling navigation.

- [ ] **Step 1: Write RED player tests**

Mock media properties/events and Fullscreen API. Tests prove:

- image/gif still render the existing `<img>` path.
- video uses `playbackUrl` and shows current/total formatted time.
- Space toggles play/pause only when focus is not a button/input/range control.
- Escape closes through the existing Dialog path.
- timeline click and pointer drag set `currentTime`; hover renders correct scrub frame.
- mute and volume stay synchronized with media events.
- fullscreen calls `requestFullscreen`/`exitFullscreen` and reflects `fullscreenchange`.
- previous/next asset navigation pauses, clears, and reloads the prior video source.

- [ ] **Step 2: Run RED viewer/player tests**

```powershell
cd C:\chatgpt\app
npm.cmd test -- src/video/VideoPlayer.test.tsx src/assets/AssetViewer.test.tsx
```

- [ ] **Step 3: Implement native-video-based controls**

Use the browser `<video>` element for buffering/Range behavior. React owns only visible control state derived from `timeupdate`, `durationchange`, `volumechange`, `play`, `pause`, `ended`, and `error`. Do not build a playback engine.

Timeline is one accessible `input type="range"` for keyboard seeking plus an overlaid hover preview that has no pointer ownership. Reuse `Button` for play, mute, fullscreen, previous, next, close. Format time with one local pure helper; no date/media dependency.

`AssetViewer` switches on `asset.media.kind`; it preserves the current fullscreen Dialog, title, previous/next controls and image behavior.

- [ ] **Step 4: Run GREEN player and full frontend tests**

```powershell
cd C:\chatgpt\app
npm.cmd test -- src/video/VideoPlayer.test.tsx src/assets/AssetViewer.test.tsx
npm.cmd test
npm.cmd run build
git diff --check
```

- [ ] **Step 5: Commit Task 9**

```powershell
git add app/src/video/VideoPlayer.tsx app/src/video/VideoPlayer.test.tsx app/src/assets/AssetViewer.tsx app/src/assets/AssetViewer.test.tsx app/src/styles/global.css
git commit -m "feat: play videos in the asset viewer"
```

---

### Task 10: Windows End-to-End Acceptance and Documentation

**Files:**
- Modify: `app/README.md`
- Create: `docs/acceptance/2026-08-09-video-preview-playback.md`
- Modify: `docs/superpowers/plans/2026-08-09-lakomics-video-preview-playback.md`

**Interfaces:**
- Consumes: packaged debug app, `C:\Users\namwoojun\Desktop\test`, copied WebM fixtures and user-provided/locally generated MP4/MOV/20+ minute fixtures.
- Produces: reproducible automated and manual acceptance evidence, completed Issue #2.

- [ ] **Step 1: Run complete automated verification**

```powershell
cd C:\chatgpt\app\src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
cd C:\chatgpt\app
npm.cmd test
npm.cmd run build
npm.cmd run tauri build -- --debug
cd C:\chatgpt
git diff --check
git status --short
```

Expected: all checks pass; only the two user shortcut files may remain untracked.

- [ ] **Step 2: Verify real files without modifying sources**

Use `C:\Users\namwoojun\Desktop\test` as the library only if no library is registered. Verify SHA-256 before and after for:

```text
망니메이션 1화.webm
망니메이션 2화.webm
one MP4
one MOV
one video at least 20 minutes long
```

If MP4/MOV/long fixtures are unavailable, generate deterministic local acceptance fixtures from a color/test source with the pinned FFmpeg under `.acceptance/video-fixtures`; do not add them to git or substitute them for the two real WebMs.

Record:

- ingest result and exact duplicate result,
- pending→ready persistence across one app restart,
- poster and scrub frame counts,
- direct-vs-proxy choice,
- hover start under 500ms by screen observation,
- one-active-tile cleanup,
- Range seeking without full-file memory growth,
- player controls and previous/next navigation,
- trash/restore/purge behavior,
- packaged debug executable launch without system FFmpeg.

Capture screenshots into `.acceptance/video-preview-playback/` and link only their paths in the acceptance document; keep binary fixtures/screenshots untracked.

- [ ] **Step 3: Update docs and close the issue**

`app/README.md` documents the fetch/verify command, dev/build/test commands, supported formats, preparation behavior and test-library fallback. The acceptance report records exact commands, FFmpeg version/configuration, fixture hashes, results and any scoped limitation.

Mark every completed checkbox in this plan, then:

```powershell
cd C:\chatgpt
gh issue close 2 --comment "구현 및 Windows 실제 영상 검증 완료. 설계, 계획, 자동 테스트와 수동 검증 증거를 저장소에 기록했습니다."
```

- [ ] **Step 4: Final self-review and placeholder scan**

```powershell
cd C:\chatgpt
rg -n "TBD|TODO|FIXME|implement later|나중에 구현|임시 구현" app/src app/src-tauri/src docs/superpowers/plans/2026-08-09-lakomics-video-preview-playback.md docs/acceptance/2026-08-09-video-preview-playback.md
rg -n "ingestImage|ingest_image|IngestImage" app/src app/src-tauri/src
rg -n "ffmpeg|ffprobe" app/src
git diff --check
```

Expected: no placeholder, no old public ingestion contract, and no FFmpeg invocation in frontend code.

- [ ] **Step 5: Commit Task 10**

```powershell
git add app/README.md docs/acceptance/2026-08-09-video-preview-playback.md docs/superpowers/plans/2026-08-09-lakomics-video-preview-playback.md
git commit -m "docs: verify Windows video workflow"
```

## Execution Handoff

This plan is ready for task-by-task execution. The repository owner explicitly required no subagents, so execution uses the current main Sol session only, with one Task completed and verified before the next begins.
