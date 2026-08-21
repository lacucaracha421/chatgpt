# WorkArtwork Thumbnail Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기존 컬렉션 표지의 누락된 360px WebP 썸네일을 라이브러리 시작 후 순차적으로 백그라운드 생성한다.

**Architecture:** `work_artwork.rs`가 썸네일 파일 존재 확인, 원본 디코딩, 임시 파일 기록과 원자적 이름 변경을 하나의 재사용 가능한 경로로 담당한다. `Library::open`은 초기 정리 후 복제한 `Library`로 이름 있는 단일 백그라운드 스레드를 시작하며, 열기 결과는 작업 완료를 기다리지 않는다.

**Tech Stack:** Rust, rusqlite, image, std::thread, 기존 `Library`/`LibraryError` 구조

## Global Constraints

- 기존 썸네일 규격인 최대 360px WebP를 유지한다.
- 파일이 존재하면 원본 이미지를 열거나 다시 쓰지 않는다.
- 개별 손상 이미지 또는 파일 쓰기 실패가 뒤 항목 처리를 중단하지 않게 한다.
- 데이터베이스 스키마, 완료 플래그, 설정 UI, 진행 UI, 작업 큐, 새 의존성을 추가하지 않는다.
- 신규 WorkArtwork 저장 시 즉시 썸네일을 만드는 기존 동작을 유지한다.
- 검증은 가장 관련 있는 Rust 테스트 하나로 제한하고, 프런트엔드 테스트·전체 테스트·프로덕션 빌드는 실행하지 않는다.

---

### Task 1: 누락 WorkArtwork 썸네일 순차 백필

**Files:**
- Modify: `app/src-tauri/src/library/work_artwork.rs`
- Test: `app/src-tauri/src/library/work_artwork.rs`

**Interfaces:**
- Consumes: 기존 `work_artwork_thumbnail_relative_path`, `write_work_artwork_thumbnail`, `Library::connection`, `Library::open_library_media`
- Produces: `pub(crate) fn backfill_missing_work_artwork_thumbnails(&self) -> Result<(), LibraryError>` 및 resolver와 백필이 함께 사용하는 private `ensure_work_artwork_thumbnail(&self, collection_id: &str, artwork_id: &str, relative_path: &str) -> Result<String, LibraryError>`

- [ ] **Step 1: 누락·기존·손상 항목을 함께 다루는 실패 테스트 작성**

  `work_artwork.rs` 테스트 모듈에 `backfill_creates_only_missing_thumbnails_and_continues_after_corrupt_artwork`를 추가한다. 하나의 컬렉션에 고정 UUID를 가진 세 레코드를 직접 넣고 원본 상대 경로를 `a-corrupt.png`, `b-valid.png`, `c-existing.png` 순서로 지정한다. 첫 원본은 `b"not an image"`, 나머지는 `png_bytes_at(900, 1350)`로 기록한다. `c-existing` 썸네일에는 `b"keep me"`를 미리 기록한 뒤 백필을 호출한다.

  ```rust
  library.backfill_missing_work_artwork_thumbnails().unwrap();

  assert!(!corrupt_thumbnail.exists());
  assert!(valid_thumbnail.exists());
  assert_eq!(std::fs::read(existing_thumbnail).unwrap(), b"keep me");
  let decoded = image::open(valid_thumbnail).unwrap();
  assert_eq!((decoded.width(), decoded.height()), (240, 360));
  ```

  이 테스트는 손상 항목 뒤의 정상 항목이 생성되고 기존 파일은 유지되는 세 요구를 한 번에 검증한다.

- [ ] **Step 2: 새 집중 테스트가 실패하는지 확인**

  Run:

  ```powershell
  cargo test --manifest-path app/src-tauri/Cargo.toml backfill_creates_only_missing_thumbnails_and_continues_after_corrupt_artwork
  ```

  Expected: `backfill_missing_work_artwork_thumbnails`가 아직 없어 컴파일 실패한다.

- [ ] **Step 3: resolver의 즉석 생성 로직을 공통 ensure 함수로 추출**

  `ensure_work_artwork_thumbnail`은 예상 상대 경로를 만들고 파일이 없을 때만 원본을 디코딩한다. 쓰기는 기존과 같이 고유 `.tmp` 파일을 거쳐 rename하며, rename이 경쟁으로 실패했지만 최종 파일이 이미 있으면 성공으로 처리한다.

  ```rust
  fn ensure_work_artwork_thumbnail(
      &self,
      collection_id: &str,
      artwork_id: &str,
      relative_path: &str,
  ) -> Result<String, LibraryError> {
      let thumbnail_relative_path =
          work_artwork_thumbnail_relative_path(collection_id, artwork_id);
      let thumbnail_path = self.root().join(&thumbnail_relative_path);
      if thumbnail_path.exists() {
          return Ok(thumbnail_relative_path);
      }

      let media = self.open_library_media(relative_path)?;
      let image = image::ImageReader::new(BufReader::new(media.file))
          .with_guessed_format()
          .map_err(|_| LibraryError::InvalidWorkArtwork)?
          .decode()
          .map_err(|_| LibraryError::InvalidWorkArtwork)?;
      let temporary_path = thumbnail_path.with_extension(format!(
          "{}.tmp",
          uuid::Uuid::new_v4()
      ));
      if let Err(error) = write_work_artwork_thumbnail(&image, &temporary_path) {
          let _ = fs::remove_file(&temporary_path);
          return Err(error);
      }
      if let Err(source) = fs::rename(&temporary_path, &thumbnail_path) {
          let _ = fs::remove_file(&temporary_path);
          if !thumbnail_path.exists() {
              return Err(LibraryError::WriteWorkArtwork {
                  path: thumbnail_path,
                  source,
              });
          }
      }
      Ok(thumbnail_relative_path)
  }
  ```

  `resolve_work_artwork_thumbnail`은 DB 조회 후 이 함수를 호출하고 반환된 상대 경로를 `open_library_media`로 연다. UUID 검증과 `MediaNotFound` 동작은 유지한다.

- [ ] **Step 4: DB 잠금을 짧게 잡고 순차 처리하는 백필 구현**

  DB 연결 범위 안에서는 작업 목록만 `relative_path` 순으로 수집한 뒤 연결을 drop한다. 이후 각 항목을 순서대로 ensure하며 개별 오류는 무시하고 다음 항목으로 진행한다. 목록 조회 자체가 실패한 경우에만 호출자에게 오류를 반환한다.

  ```rust
  pub(crate) fn backfill_missing_work_artwork_thumbnails(
      &self,
  ) -> Result<(), LibraryError> {
      let artworks = {
          let connection = self.connection()?;
          let mut statement = connection.prepare(
              "SELECT id, collection_id, relative_path
               FROM collection_work_artworks ORDER BY relative_path",
          )?;
          statement
              .query_map([], |row| {
                  Ok((
                      row.get::<_, String>(0)?,
                      row.get::<_, String>(1)?,
                      row.get::<_, String>(2)?,
                  ))
              })?
              .collect::<Result<Vec<_>, _>>()?
      };

      for (artwork_id, collection_id, relative_path) in artworks {
          let _ = self.ensure_work_artwork_thumbnail(
              &collection_id,
              &artwork_id,
              &relative_path,
          );
      }
      Ok(())
  }
  ```

- [ ] **Step 5: 같은 집중 테스트가 통과하는지 확인**

  Run:

  ```powershell
  cargo test --manifest-path app/src-tauri/Cargo.toml backfill_creates_only_missing_thumbnails_and_continues_after_corrupt_artwork
  ```

  Expected: 새 테스트 1개 PASS.

- [ ] **Step 6: 백필 로직 커밋**

  ```powershell
  git add -- app/src-tauri/src/library/work_artwork.rs
  git commit -m "feat: backfill missing WorkArtwork thumbnails"
  ```

### Task 2: 라이브러리 열기 후 백그라운드 실행

**Files:**
- Modify: `app/src-tauri/src/library/work_artwork.rs`
- Modify: `app/src-tauri/src/library/mod.rs`

**Interfaces:**
- Consumes: Task 1의 `Library::backfill_missing_work_artwork_thumbnails(&self) -> Result<(), LibraryError>`와 `Library: Clone + Send + 'static`
- Produces: `pub(crate) fn start_work_artwork_thumbnail_backfill(&self)`; `Library::open`은 초기 정리 뒤 이 함수를 호출한다.

- [ ] **Step 1: 최소 백그라운드 시작 함수 구현**

  `work_artwork.rs`에 라이브러리 복제본을 이름 있는 OS 스레드로 옮기는 함수를 추가한다. 스레드 생성 실패나 캐시 백필 실패는 라이브러리 열기 실패로 승격하지 않는다.

  ```rust
  pub(crate) fn start_work_artwork_thumbnail_backfill(&self) {
      let library = self.clone();
      let _ = std::thread::Builder::new()
          .name("work-artwork-thumbnail-backfill".into())
          .spawn(move || {
              let _ = library.backfill_missing_work_artwork_thumbnails();
          });
  }
  ```

- [ ] **Step 2: Library::open의 초기 정리 뒤 작업 시작 연결**

  `library/mod.rs`에서 `cleanup_unreferenced_work_artwork()` 다음, `Ok(library)` 이전에 호출한다. 호출은 join이나 채널 수신을 하지 않으므로 라이브러리 열기 응답이 백필 완료를 기다리지 않는다.

  ```rust
  library.cleanup_unreferenced_work_artwork()?;
  library.start_work_artwork_thumbnail_backfill();
  Ok(library)
  ```

- [ ] **Step 3: 이후 편집이 Task 1 결과를 깨지 않았는지 한 번 확인**

  Run:

  ```powershell
  cargo test --manifest-path app/src-tauri/Cargo.toml backfill_creates_only_missing_thumbnails_and_continues_after_corrupt_artwork
  ```

  Expected: 새 테스트 1개 PASS. 이 검사는 Task 2 편집이 스레드 시작 경계와 메서드 가시성을 바꾸므로 Task 1의 이전 결과를 무효화할 수 있어 한 번만 재실행한다.

- [ ] **Step 4: 시작 연결 커밋**

  ```powershell
  git add -- app/src-tauri/src/library/work_artwork.rs app/src-tauri/src/library/mod.rs
  git commit -m "feat: start thumbnail backfill when library opens"
  ```
