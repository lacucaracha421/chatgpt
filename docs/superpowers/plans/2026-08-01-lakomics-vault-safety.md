# Lakomics Vault Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 한 라이브러리를 동시에 두 앱이 수정하지 못하게 하고, 자산을 복원 가능한 휴지통으로 보내며, SQLite 관리 정보를 자동 백업하고 안전하게 복구할 수 있게 한다.

**Architecture:** React UI는 `LibraryGateway`의 작은 Interface만 사용한다. Rust의 `library` Module이 라이브러리 잠금, SQLite 마이그레이션, 휴지통 보존 정책, 실제 파일 삭제, 백업 검증과 복구 순서를 숨긴다. 휴지통 자산은 파일을 옮기지 않고 SQLite 상태만 바꾸며, 복구 작업은 현재 데이터베이스를 다시 백업한 뒤 검증된 백업으로 교체한다.

**Tech Stack:** Windows, Tauri 2, React 19, TypeScript 5.8, Rust stable MSVC, rusqlite 0.40.1 bundled + backup, SQLite, Vitest, React Testing Library, Cargo tests

## Global Constraints

- 라이브러리는 앱이 관리하는 미디어 금고다.
- 사용자 폴더와 라이브러리 사이의 파일 이동처럼 보이는 동작은 항상 복사다.
- 라이브러리 내부 자산 경로는 앱만 변경한다.
- 한 라이브러리는 한 번에 한 앱 인스턴스만 연다.
- 휴지통 자산은 `assets/` 안의 기존 파일 위치를 유지한다.
- 휴지통 보존 기간 기본값은 30일이며 사용자가 끄거나 변경할 수 있다.
- 자동 백업은 `library.sqlite` 관리 정보만 대상으로 하며 최근 일일 백업 7개를 유지한다.
- 데이터베이스 마이그레이션과 복구 전에 별도 백업을 만든다.
- 복구를 시작하기 전에 선택한 백업을 검증하고 현재 데이터베이스도 다시 백업한다.
- 자동·수동 영구 삭제에 실패한 자산은 관리 정보를 삭제하지 않는다.
- 외부 사용자 폴더의 복사본은 휴지통과 영구 삭제의 영향을 받지 않는다.
- 사용자 정의 분류 이름, 파일명 또는 라이브러리 위치로 앱 동작을 분기하지 않는다.
- UI는 SQLite, 해시 경로, 잠금 파일과 백업 파일명을 직접 다루지 않는다.
- 공통 대화상자, 버튼, 입력란, 선택창과 토스트를 재사용한다.
- 실제 두 번째 구현이 없는 Adapter나 추측성 설정 계층을 만들지 않는다.
- 모든 변경은 RED → GREEN → REFACTOR 순서로 구현한다.

## Scope Boundary

이 계획은 동시 실행 잠금, 휴지통, 보존 기간, 일일 SQLite 백업, 백업 목록과 복구까지만 다룬다. 중단 가능한 수집 작업, 라이브러리 전체 검사, 누락 자산 복구, 앱에서 Windows 탐색기로 드래그 복사는 별도 계획으로 구현한다. Tauri는 현재 들어오는 파일 경로 이벤트는 제공하지만 WebView에서 Windows 탐색기로 내보내는 네이티브 드래그 Interface는 제공하지 않으므로, 드래그 출력은 Windows 네이티브 프로토타입을 먼저 통과해야 한다.

## File Map

```text
app/src-tauri/
├── Cargo.toml
├── migrations/
│   ├── 0001_initial.sql
│   └── 0002_vault_safety.sql       # 휴지통 시각, 보존 정책
└── src/
    ├── commands.rs                 # Tauri IPC Adapter
    └── library/
        ├── mod.rs                  # 작은 Library Interface와 잠금 수명
        ├── db.rs                   # 순차 마이그레이션과 사전 백업
        ├── error.rs                # 안정적인 오류 종류
        ├── models.rs               # 휴지통·정책·백업 직렬화 자료형
        ├── lock.rs                 # 라이브러리 단독 사용 잠금
        ├── trash.rs                # 휴지통 상태, 복원, 영구 삭제
        └── backup.rs               # SQLite 스냅샷, 검증, 순환, 복구

app/src/
├── app/
│   ├── App.tsx
│   └── App.test.tsx
├── classification/
│   ├── ClassificationSidebar.tsx
│   └── ClassificationSidebar.test.tsx
├── library/
│   ├── client.ts
│   ├── types.ts
│   └── errorMessage.ts
├── safety/
│   ├── TrashBrowser.tsx
│   ├── TrashBrowser.test.tsx
│   ├── SafetyDialog.tsx
│   └── SafetyDialog.test.tsx
└── styles/global.css
```

---

### Task 1: Exclusive Library Lease and Verified SQLite Snapshot

**Files:**
- Modify: `app/src-tauri/Cargo.toml`
- Create: `app/src-tauri/src/library/lock.rs`
- Create: `app/src-tauri/src/library/backup.rs`
- Modify: `app/src-tauri/src/library/mod.rs`
- Modify: `app/src-tauri/src/library/error.rs`
- Modify: `app/src-tauri/src/commands.rs`

**Interfaces:**
- Consumes: 현재 `Library::open(root)`와 `LibraryError`
- Produces:

```rust
pub(crate) struct LibraryLease;

impl LibraryLease {
    pub(crate) fn acquire(root: &Path) -> Result<Self, LibraryError>;
}

pub(crate) fn create_verified_snapshot(
    source: &rusqlite::Connection,
    destination: &Path,
) -> Result<(), LibraryError>;
```

`Library`는 `lease: Arc<LibraryLease>`를 소유한다. `Library` 복제본이 모두 사라질 때까지 운영체제 파일 잠금이 유지된다.

- [x] **Step 1: SQLite 온라인 백업 기능을 활성화한다**

`app/src-tauri/Cargo.toml`의 기존 rusqlite 항목만 수정한다.

```toml
rusqlite = { version = "0.40.1", features = ["bundled", "backup"] }
```

별도 잠금 crate는 추가하지 않는다. Windows에서는 `std::os::windows::fs::OpenOptionsExt::share_mode(0)`으로 `.lakomics.lock` 파일을 단독으로 연다.

- [x] **Step 2: 같은 라이브러리를 두 번 여는 실패 테스트를 작성한다**

`lock.rs`에 다음 동작을 검증한다.

```rust
#[test]
fn second_library_open_is_rejected_until_the_first_is_dropped() {
    let temp = tempfile::tempdir().unwrap();
    let first = Library::open(temp.path()).unwrap();

    let error = Library::open(temp.path()).unwrap_err();
    assert!(matches!(error, LibraryError::LibraryInUse));

    drop(first);
    Library::open(temp.path()).unwrap();
}
```

Run:

```powershell
Set-Location app\src-tauri
cargo test second_library_open_is_rejected_until_the_first_is_dropped
```

Expected: FAIL because the second `Library::open` currently succeeds.

- [x] **Step 3: `LibraryLease`를 최소 구현한다**

Windows에서는 잠금 파일을 읽기·쓰기·생성 모드와 공유 모드 0으로 연다. `AlreadyExists`, `PermissionDenied`, Windows sharing violation은 `LibraryInUse`로 변환하고 그 밖의 I/O 오류는 경로를 포함한 `LibraryLock`으로 반환한다. 잠금 파일은 내용이 없는 내부 제어 파일이며 `LibraryLease`가 `File` handle을 보유한다.

`Library::open`은 디렉터리를 만든 직후, SQLite를 열기 전에 잠금을 얻는다.

- [x] **Step 4: WAL 상태에서도 일관된 스냅샷을 만드는 실패 테스트를 작성한다**

```rust
#[test]
fn verified_snapshot_contains_committed_wal_rows() {
    let temp = tempfile::tempdir().unwrap();
    let source_path = temp.path().join("library.sqlite");
    let destination = temp.path().join("snapshot.sqlite");
    let source = db::open_database(&source_path).unwrap();
    source.execute(
        "INSERT INTO classification_entries
         (id, kind, name, parent_id, created_at)
         VALUES ('root', 'root', '게임', NULL, '2026-08-01T00:00:00Z')",
        [],
    ).unwrap();

    create_verified_snapshot(&source, &destination).unwrap();

    let snapshot = rusqlite::Connection::open(destination).unwrap();
    assert_eq!(
        snapshot.query_row(
            "SELECT COUNT(*) FROM classification_entries",
            [],
            |row| row.get::<_, i64>(0),
        ).unwrap(),
        1,
    );
}
```

Run:

```powershell
cargo test verified_snapshot_contains_committed_wal_rows
```

Expected: FAIL because `create_verified_snapshot` does not exist.

- [x] **Step 5: 온라인 백업과 검증을 구현한다**

`source.backup(rusqlite::MAIN_DB, destination, None)`을 사용한다. 대상은 `create_new` 의미를 유지해 기존 백업을 덮어쓰지 않는다. 백업 완료 후 새 연결로 다음 두 검사를 실행한다.

```sql
PRAGMA quick_check;
PRAGMA user_version;
```

`quick_check`가 정확히 `ok`가 아니거나 스키마 버전이 1보다 작거나 현재 지원 버전보다 크면 대상 파일을 제거하고 `InvalidBackup`을 반환한다.

- [x] **Step 6: IPC 오류 코드를 고정한다**

`CommandError` 변환에 다음 코드를 추가하고 직렬화 테스트를 작성한다.

```text
library_in_use
library_lock_failed
backup_failed
invalid_backup
```

- [x] **Step 7: Task 1 검증과 커밋**

```powershell
cargo fmt --all --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
git add app/src-tauri
git commit -m "feat: lock open libraries and snapshot metadata"
```

---

### Task 2: Versioned Vault-Safety Migration and Storage Contract

**Files:**
- Create: `app/src-tauri/migrations/0002_vault_safety.sql`
- Modify: `app/src-tauri/src/library/db.rs`
- Modify: `app/src-tauri/src/library/mod.rs`
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/src/library/backup.rs`
- Test: `app/src-tauri/tests/foundation_flow.rs`

**Interfaces:**
- Consumes: Task 1의 `create_verified_snapshot`
- Produces:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrashPolicy {
    pub retention_days: Option<u32>,
}
```

`None`은 자동 삭제 꺼짐이며 기본값은 `Some(30)`이다.

- [x] **Step 1: 기존 v1 라이브러리 마이그레이션 실패 테스트를 작성한다**

임시 데이터베이스에 `0001_initial.sql`만 적용하고 자산 한 개를 넣은 다음 `Library::open`을 실행한다. 다음을 검증한다.

```rust
assert_eq!(user_version(&library), 2);
assert_eq!(library.trash_policy().unwrap().retention_days, Some(30));
assert!(!library.root().join("trash").exists());
assert_eq!(library.summary().unwrap().asset_count, 1);
assert_eq!(pre_migration_backups(library.root()).len(), 1);
```

Run:

```powershell
cargo test migrates_v1_after_creating_a_verified_snapshot
```

Expected: FAIL because schema version 2 and policy do not exist.

- [x] **Step 2: `0002_vault_safety.sql`을 작성한다**

```sql
ALTER TABLE assets ADD COLUMN trashed_at TEXT;

CREATE TABLE library_settings (
    singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
    trash_retention_days INTEGER
        CHECK (trash_retention_days IS NULL OR trash_retention_days BETWEEN 1 AND 3650)
);

INSERT INTO library_settings (singleton, trash_retention_days)
VALUES (1, 30);

CREATE INDEX assets_by_trash_age
ON assets(status, trashed_at, id);

PRAGMA user_version = 2;
```

- [x] **Step 3: 순차 마이그레이션을 구현한다**

`db.rs`는 `(현재 버전, 목표 버전)`을 명시적으로 처리한다.

```rust
const SCHEMA_VERSION: i64 = 2;
const INITIAL_SCHEMA: &str = include_str!("../../migrations/0001_initial.sql");
const VAULT_SAFETY_SCHEMA: &str =
    include_str!("../../migrations/0002_vault_safety.sql");
```

- 새 데이터베이스: v1과 v2 SQL을 한 트랜잭션에서 적용
- 기존 v1: `backups/pre-migration-<UTC timestamp>-v1.sqlite` 스냅샷 생성 후 v2 적용
- v2: 변경 없음
- 그 외: `UnsupportedSchema`

파일명 생성과 최근 백업 정책은 `backup.rs` 한곳에서 소유한다.

- [x] **Step 4: 사용되지 않는 물리 `trash/` 폴더를 제거한다**

`Library::open`이 만드는 폴더 목록을 다음으로 바꾼다.

```rust
for name in ["assets", "thumbnails", "backups"] {
```

기존 라이브러리에 이미 존재하는 빈 `trash/`는 자동 삭제하지 않는다. 앱이 만들지 않게만 바꿔 사용자 파일이 섞여 있을 가능성을 존중한다.

- [x] **Step 5: 정책 읽기·쓰기 검증을 작성하고 구현한다**

```rust
assert_eq!(library.trash_policy().unwrap(), TrashPolicy {
    retention_days: Some(30),
});
library.set_trash_policy(TrashPolicy { retention_days: None }).unwrap();
assert_eq!(library.trash_policy().unwrap().retention_days, None);
```

0일과 3651일은 `InvalidTrashRetention`으로 거부한다. SQL과 Rust가 같은 1..=3650 범위를 사용한다.

- [x] **Step 6: Task 2 검증과 커밋**

```powershell
cargo fmt --all --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
git add app/src-tauri
git commit -m "feat: migrate libraries to vault safety schema"
```

---

### Task 3: Trash Lifecycle Behind the Library Interface

**Files:**
- Create: `app/src-tauri/src/library/trash.rs`
- Modify: `app/src-tauri/src/library/mod.rs`
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/src/library/error.rs`
- Modify: `app/src-tauri/src/commands.rs`
- Modify: `app/src-tauri/src/lib.rs`
- Test: `app/src-tauri/tests/foundation_flow.rs`

**Interfaces:**
- Consumes: Task 2의 `trashed_at`과 `TrashPolicy`
- Produces:

```rust
pub struct TrashAssetSummary {
    pub asset: AssetSummary,
    pub trashed_at: String,
    pub purge_at: Option<String>,
}

pub struct TrashPage {
    pub items: Vec<TrashAssetSummary>,
    pub next_cursor: Option<AssetCursor>,
    pub total_count: u64,
    pub total_bytes: u64,
}

pub struct PurgeSummary {
    pub deleted_count: u64,
    pub failed_asset_ids: Vec<String>,
}

impl Library {
    pub fn trash_asset(&self, asset_id: &str) -> Result<(), LibraryError>;
    pub fn restore_asset(&self, asset_id: &str) -> Result<(), LibraryError>;
    pub fn list_trash(
        &self,
        after: Option<AssetCursor>,
        limit: u32,
    ) -> Result<TrashPage, LibraryError>;
    pub fn empty_trash(&self) -> Result<PurgeSummary, LibraryError>;
    pub fn purge_expired_trash(
        &self,
        now: DateTime<Utc>,
    ) -> Result<PurgeSummary, LibraryError>;
}
```

- [x] **Step 1: 휴지통 이동과 복원 RED 테스트를 작성한다**

자산 파일과 썸네일을 실제로 만든 뒤 다음을 검증한다.

```rust
library.trash_asset(&asset.id).unwrap();
assert_eq!(library.summary().unwrap().asset_count, 0);
assert!(asset_path.is_file());
assert!(thumbnail_path.is_file());
assert_eq!(library.list_trash(None, 20).unwrap().items.len(), 1);

library.restore_asset(&asset.id).unwrap();
assert_eq!(library.summary().unwrap().asset_count, 1);
assert!(library.list_trash(None, 20).unwrap().items.is_empty());
```

Run:

```powershell
cargo test trash_keeps_files_in_place_and_restore_keeps_metadata
```

Expected: FAIL because the Interface does not exist.

- [x] **Step 2: 상태 변경을 트랜잭션으로 구현한다**

휴지통 이동:

```sql
UPDATE assets
SET status = 'trash', trashed_at = ?2
WHERE id = ?1 AND status = 'normal';
```

복원:

```sql
UPDATE assets
SET status = 'normal', trashed_at = NULL
WHERE id = ?1 AND status = 'trash';
```

변경 행이 0이면 현재 상태를 조회해 멱등 호출은 성공시키고 존재하지 않는 ID만 `AssetNotFound`로 반환한다. 분류, 좋아요, 출처 행은 변경하지 않는다.

- [x] **Step 3: 페이지 조회와 만료 시각을 구현한다**

휴지통은 `trashed_at DESC, id DESC` keyset cursor를 사용하고 1..=200 페이지 제한을 재사용한다. `purge_at`은 저장하지 않고 `trashed_at + retention_days`로 계산한다. 자동 삭제가 꺼져 있으면 `purge_at`은 `None`이다.

- [x] **Step 4: 실패해도 기록을 보존하는 영구 삭제 테스트를 작성한다**

테스트에서 자산 파일을 읽기 전용 디렉터리 또는 삭제 실패 hook으로 막고 다음을 검증한다.

```rust
let result = library.empty_trash().unwrap();
assert_eq!(result.deleted_count, 0);
assert_eq!(result.failed_asset_ids, vec![asset.id.clone()]);
assert_eq!(library.list_trash(None, 20).unwrap().items.len(), 1);
```

성공 경로에서는 원본과 썸네일을 지운 뒤 마지막에 SQLite 자산 행을 삭제한다. 파일 하나라도 지우지 못하면 해당 행과 분류 연결을 유지한다. 이미 사라진 파일은 성공한 삭제로 취급해 중단 뒤 재시도가 끝날 수 있게 한다.

- [x] **Step 5: 수동·자동 삭제를 같은 내부 함수로 구현한다**

`empty_trash`와 `purge_expired_trash`는 private `purge_candidates(asset_ids)`를 함께 사용한다. 자동 삭제는 `retention_days IS NOT NULL`일 때만 `trashed_at <= now - retention_days`인 자산을 선택한다.

- [x] **Step 6: Tauri 명령을 연결한다**

다음 명령만 IPC에 노출한다.

```text
trash_asset
restore_asset
list_trash
empty_trash
get_trash_policy
set_trash_policy
```

SQL 상태 문자열이나 내부 경로는 명령 인자에 노출하지 않는다.

- [x] **Step 7: Task 3 검증과 커밋**

```powershell
cargo fmt --all --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
git add app/src-tauri
git commit -m "feat: add recoverable library trash"
```

---

### Task 4: Trash Screen and Retention Controls

**Files:**
- Modify: `app/src/library/types.ts`
- Modify: `app/src/library/client.ts`
- Modify: `app/src/library/errorMessage.ts`
- Modify: `app/src/classification/ClassificationSidebar.tsx`
- Modify: `app/src/classification/ClassificationSidebar.test.tsx`
- Modify: `app/src/assets/AssetBrowser.tsx`
- Modify: `app/src/assets/AssetBrowser.test.tsx`
- Modify: `app/src/assets/AssetToolbar.tsx`
- Modify: `app/src/assets/AssetDetailDialog.tsx`
- Modify: `app/src/assets/AssetDetailDialog.test.tsx`
- Create: `app/src/safety/TrashBrowser.tsx`
- Create: `app/src/safety/TrashBrowser.test.tsx`
- Modify: `app/src/app/App.tsx`
- Modify: `app/src/app/App.test.tsx`
- Modify: `app/src/styles/global.css`

**Interfaces:**
- Consumes: Task 3 IPC 명령
- Produces:

```ts
export type AssetView =
  | { kind: "classification"; classificationId: string | null }
  | { kind: "favorites" }
  | { kind: "recent" }
  | { kind: "trash" };

export type TrashPolicy = { retentionDays: number | null };
export type TrashAssetSummary = {
  asset: AssetSummary;
  trashedAt: string;
  purgeAt: string | null;
};
export type TrashPage = {
  items: TrashAssetSummary[];
  nextCursor: AssetCursor | null;
  totalCount: number;
  totalBytes: number;
};
export type PurgeSummary = {
  deletedCount: number;
  failedAssetIds: string[];
};
```

`LibraryGateway`에 Rust 명령과 같은 여섯 메서드를 추가한다.

- [x] **Step 1: 휴지통 탐색 RED 테스트를 작성한다**

다음을 한 테스트 흐름으로 검증한다.

```ts
await user.click(screen.getByRole("button", { name: "휴지통 보기" }));
expect(gateway.listTrash).toHaveBeenCalledWith({
  after: null,
  limit: 100,
});
expect(screen.getByText("영구 삭제까지 12일")).toBeVisible();

await user.click(screen.getByRole("button", { name: "복원" }));
expect(gateway.restoreAsset).toHaveBeenCalledWith("asset-1");
```

휴지통 화면에서는 파일 드롭, 좋아요 변경, 분류 편집을 제공하지 않는다.

- [x] **Step 2: 사이드바 빠른 보기를 추가한다**

기존 빠른 보기와 같은 행·아이콘·키보드 동작을 사용한다. 별도 휴지통용 사이드바 레이아웃을 만들지 않는다. 휴지통을 선택하면 `onViewChange({ kind: "trash" })`를 보낸다.

- [x] **Step 3: 선택한 자산을 휴지통으로 보내는 동작을 추가한다**

`AssetToolbar`와 `AssetDetailDialog`는 같은 `gateway.trashAsset(asset.id)` 동작을 사용한다. 성공하면 선택과 상세 대화상자를 닫고 첫 자산 페이지를 새로 읽으며 `휴지통으로 이동했습니다.` Toast를 표시한다. 실패하면 화면의 자산을 제거하지 않고 오류 Toast를 표시한다.

```ts
await user.click(screen.getByRole("button", { name: "휴지통으로 이동" }));
expect(gateway.trashAsset).toHaveBeenCalledWith("asset-1");
expect(screen.getByText("휴지통으로 이동했습니다.")).toBeVisible();
```

휴지통 이동은 복원 가능하므로 별도 확인창을 띄우지 않는다. `emptyTrash`만 영구 삭제 확인창을 사용한다.

- [x] **Step 4: `TrashBrowser`를 구현한다**

공통 `Button`, `Dialog`, `EmptyState`, `Skeleton`, `TextField`, `Toggle`을 사용한다. 목록에는 원래 파일명, 삭제 시각, 남은 기간, 복원 버튼만 먼저 제공한다. 자산 원본 파일은 미디어 프로토콜이 `normal` 상태만 읽으므로 첫 버전 휴지통에서는 이미지 미리보기를 요구하지 않는다.

- [x] **Step 5: 보존 기간 설정 RED 테스트를 작성한다**

```ts
await user.click(screen.getByRole("checkbox", { name: "자동 삭제" }));
expect(gateway.setTrashPolicy).toHaveBeenCalledWith({
  retentionDays: null,
});

await user.clear(screen.getByRole("spinbutton", { name: "보존 기간" }));
await user.type(screen.getByRole("spinbutton", { name: "보존 기간" }), "45");
await user.click(screen.getByRole("button", { name: "저장" }));
expect(gateway.setTrashPolicy).toHaveBeenCalledWith({
  retentionDays: 45,
});
```

1..=3650 검증은 UI 메시지를 제공하지만 Rust 검증을 대체하지 않는다.

- [x] **Step 6: 휴지통 비우기 확인창을 구현한다**

버튼을 누르면 현재 휴지통의 전체 개수와 총용량을 별도 summary 명령 없이 현재 로드한 페이지로 추측하지 않는다. `listTrash` 응답에 `totalCount`와 `totalBytes`를 포함하도록 Task 3 자료형을 함께 보강한다.

확인 문구:

```text
휴지통의 자산 {count}개({size})를 영구 삭제합니다.
이 작업은 되돌릴 수 없습니다.
```

삭제 후 실패 ID가 있으면 성공 개수와 실패 개수를 Toast로 표시하고 목록을 새로 읽는다.

- [x] **Step 7: App 조립과 드롭 차단을 구현한다**

`view.kind === "trash"`이면 `TrashBrowser`를 렌더링하고 기존 `AssetBrowser`를 렌더링하지 않는다. 기존 `dropEnabled` 식은 휴지통에서 자연스럽게 false가 되어야 하며 휴지통 전용 조건문을 `useFileDrop`에 추가하지 않는다.

- [x] **Step 8: Task 4 검증과 커밋**

```powershell
Set-Location app
npm.cmd test -- src/safety src/classification src/app
npm.cmd run build
git add src
git commit -m "feat: add trash recovery and retention controls"
```

---

### Task 5: Rotating Daily Backups and Safe Restore

**Files:**
- Modify: `app/src-tauri/src/library/backup.rs`
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/src/library/error.rs`
- Modify: `app/src-tauri/src/library/mod.rs`
- Modify: `app/src-tauri/src/commands.rs`
- Modify: `app/src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: Task 1의 검증된 SQLite 스냅샷과 Task 2의 스키마 버전
- Produces:

```rust
pub enum BackupKind {
    Daily,
    PreMigration,
    PreRestore,
}

pub struct MetadataBackup {
    pub id: String,
    pub kind: BackupKind,
    pub created_at: String,
    pub byte_size: u64,
}

impl Library {
    pub fn ensure_daily_backup(
        &self,
        now: DateTime<Utc>,
    ) -> Result<Option<MetadataBackup>, LibraryError>;
    pub fn list_backups(&self) -> Result<Vec<MetadataBackup>, LibraryError>;
    pub fn restore_backup(&self, backup_id: &str) -> Result<(), LibraryError>;
}
```

- [x] **Step 1: 하루 한 번과 최근 7개 순환 RED 테스트를 작성한다**

8개의 서로 다른 UTC 날짜로 `ensure_daily_backup`을 호출하고 같은 날짜에는 두 번 호출한다.

```rust
assert!(library.ensure_daily_backup(day_1).unwrap().is_some());
assert!(library.ensure_daily_backup(day_1).unwrap().is_none());
assert_eq!(
    library.list_backups().unwrap()
        .into_iter()
        .filter(|backup| backup.kind == BackupKind::Daily)
        .count(),
    7,
);
```

Run:

```powershell
cargo test daily_backup_runs_once_and_keeps_seven
```

Expected: FAIL because 순환 정책이 없다.

- [x] **Step 2: 안전한 파일명과 순환을 구현한다**

백업 ID는 UUID이며 사용자 입력을 경로로 직접 결합하지 않는다. 백업 파일명은 Module 내부에서만 다음 형식을 사용한다.

```text
daily-YYYYMMDD-HHMMSS-<uuid>.sqlite
pre-migration-YYYYMMDD-HHMMSS-v<version>-<uuid>.sqlite
pre-restore-YYYYMMDD-HHMMSS-<uuid>.sqlite
```

목록은 파일을 열어 `quick_check`, `user_version`, 파일 크기를 검증한 결과만 반환한다. 일일 백업 7개를 넘으면 오래된 일일 백업만 삭제하고 `pre-migration`, `pre-restore`는 건드리지 않는다.

- [x] **Step 3: 손상 백업 거부와 복구 직전 백업 RED 테스트를 작성한다**

```rust
std::fs::write(corrupt_backup_path, b"not sqlite").unwrap();
assert!(matches!(
    library.restore_backup(&corrupt_id),
    Err(LibraryError::InvalidBackup)
));
assert_eq!(current_favorite(&library, asset_id), true);

library.restore_backup(&valid_old_backup.id).unwrap();
assert_eq!(current_favorite(&library, asset_id), false);
assert_eq!(pre_restore_backups(library.root()).len(), 1);
```

- [x] **Step 4: 복구를 임시 파일 교체로 구현한다**

순서:

1. 백업 ID를 `list_backups` 결과에서 찾아 허용된 경로로 해석
2. 선택한 백업 `quick_check`와 `user_version` 검증
3. 현재 연결에서 WAL checkpoint
4. 현재 데이터베이스를 `pre-restore`로 스냅샷
5. 선택한 백업을 `library.sqlite.restore.part`로 다시 스냅샷
6. 임시 DB를 다시 검증
7. 현재 `library.sqlite`를 `library.sqlite.restore-old-<uuid>`로 rename
8. 임시 DB를 `library.sqlite`로 rename
9. 새 DB를 `db::open_database`로 열어 필요한 마이그레이션 실행
10. 성공 후 UUID가 붙은 `restore-old`, `-wal`, `-shm` 정리

7 이후 실패하면 새 파일을 치우고 UUID가 붙은 `restore-old`을 원래 이름으로 되돌린다. 기존 DB를 복구할 수 없으면 `RestoreFailed`에 복구용 파일 경로를 포함하고 어떤 파일도 추가 삭제하지 않는다.

- [x] **Step 5: IPC 명령과 안정적인 오류를 연결한다**

```text
list_metadata_backups
restore_metadata_backup
```

`backup_id`만 받고 절대·상대 파일 경로는 받지 않는다.

앱 시작용 `ensure_daily_backup` 명령도 함께 노출한다. 날짜는 UI에서 받지 않고 Rust에서 현재 UTC 시각을 구한다.

- [x] **Step 6: Task 5 검증과 커밋**

```powershell
cargo fmt --all --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
git add app/src-tauri
git commit -m "feat: rotate and restore metadata backups"
```

---

### Task 6: Backup Recovery UI and Startup Maintenance

**Files:**
- Modify: `app/src/library/types.ts`
- Modify: `app/src/library/client.ts`
- Modify: `app/src/library/errorMessage.ts`
- Create: `app/src/safety/SafetyDialog.tsx`
- Create: `app/src/safety/SafetyDialog.test.tsx`
- Modify: `app/src/app/App.tsx`
- Modify: `app/src/app/App.test.tsx`
- Modify: `app/src/styles/global.css`

**Interfaces:**
- Consumes: Task 5의 백업 목록과 복구 IPC
- Produces:

```ts
export type MetadataBackup = {
  id: string;
  kind: "daily" | "pre_migration" | "pre_restore";
  createdAt: string;
  byteSize: number;
};
```

- [x] **Step 1: 앱 시작 일일 백업 RED 테스트를 작성한다**

라이브러리가 열린 뒤 `ensureDailyBackup()`이 정확히 한 번 호출되는지, 실패해도 라이브러리 탐색은 유지되고 경고 Toast만 표시되는지 검증한다.

`LibraryGateway`에 다음을 추가한다.

```ts
ensureDailyBackup(): Promise<MetadataBackup | null>;
listMetadataBackups(): Promise<MetadataBackup[]>;
restoreMetadataBackup(backupId: string): Promise<void>;
```

- [x] **Step 2: 일일 백업 시작 동작을 연결한다**

`LibraryWorkspace`의 한 effect에서 `ensureDailyBackup`을 호출한다. 백업 생성 여부는 UI가 판단하지 않으며 날짜나 7개 제한을 TypeScript에 복사하지 않는다.

- [x] **Step 3: 복구 화면 RED 테스트를 작성한다**

```ts
await user.click(screen.getByRole("button", { name: "라이브러리 안전 설정" }));
expect(await screen.findByText("2026. 8. 1.")).toBeVisible();

await user.click(screen.getByRole("button", { name: "이 시점으로 복구" }));
expect(screen.getByText(/현재 상태를 별도로 보존한 뒤/)).toBeVisible();
await user.click(screen.getByRole("button", { name: "복구 시작" }));
expect(gateway.restoreMetadataBackup).toHaveBeenCalledWith("backup-1");
```

- [x] **Step 4: 공통 UI로 `SafetyDialog`를 구현한다**

기존 `Dialog`, `Button`, `Select`, `Toggle`, `TextField`, `Skeleton`, `Toast`만 사용한다. 새 대화상자 기반이나 독립적인 입력 스타일을 만들지 않는다.

백업 목록에는 날짜, 종류, 크기를 표시한다. `pre_migration`은 `업데이트 전`, `pre_restore`는 `복구 직전`, `daily`는 `자동 백업`으로 번역한다.

- [x] **Step 5: 복구 성공 후 화면 상태를 다시 읽는다**

복구 중에는 대화상자 밖의 수정 동작을 막는 하나의 `maintenance` 상태를 `LibraryWorkspace`가 소유한다. 성공하면 분류 목록과 현재 자산 페이지를 새로 읽고 대화상자를 닫는다. 이 계획에서는 아직 전체 라이브러리 검사를 구현하지 않으므로 `복구가 완료되었습니다. 다음 단계에서 파일 검사를 실행할 수 있습니다.`라는 Toast를 보여준다.

- [x] **Step 6: 자동 휴지통 정리를 시작 시 한 번 실행한다**

`LibraryGateway`에 `purgeExpiredTrash(): Promise<PurgeSummary>`를 추가한다. 일일 백업 성공 여부와 관계없이 백업 시도 뒤에 실행한다. 실패 자산이 있으면 개수만 알리고 관리 정보는 그대로 둔다.

- [x] **Step 7: Task 6 검증과 커밋**

```powershell
npm.cmd test -- src/safety src/app src/library
npm.cmd run build
git add app/src
git commit -m "feat: add backup recovery and startup maintenance"
```

---

### Task 7: Whole-Slice Verification and Windows Acceptance

**Files:**
- Modify: `app/README.md`
- Modify: `docs/superpowers/plans/2026-08-01-lakomics-vault-safety.md` only to mark executed checkboxes during implementation

**Interfaces:**
- Consumes: Tasks 1–6
- Produces: 안전 기능에 대한 자동화 증거와 Windows 수동 점검 기록

- [x] **Step 1: 전체 자동 검증을 실행한다**

```powershell
Set-Location app
npm.cmd test
npm.cmd run build
Set-Location src-tauri
cargo fmt --all --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
Set-Location ..
npm.cmd run tauri build -- --debug --no-bundle
```

Expected: 모든 명령 exit code 0, `app/src-tauri/target/debug/app.exe` 존재.

- [x] **Step 2: 실제 라이브러리 잠금 경계를 확인한다**

1. 디버그 실행 파일로 테스트 라이브러리를 연다.
2. 두 번째 디버그 실행 파일에서 같은 폴더를 연다.
3. 두 번째 앱에 `다른 Lakomics에서 사용 중인 라이브러리입니다.`가 표시되는지 확인한다.
4. 첫 번째 앱을 종료한 뒤 두 번째 앱에서 다시 열 수 있는지 확인한다.

- [x] **Step 3: 실제 휴지통 흐름을 확인한다**

1. PNG 한 장을 넣고 태그와 좋아요를 지정한다.
2. 휴지통으로 보낸 뒤 일반 갤러리에서 사라지는지 확인한다.
3. 탐색기에서 라이브러리 `assets/` 파일이 제자리에 있는지 확인한다.
4. 복원 후 태그와 좋아요가 유지되는지 확인한다.
5. 보존 기간을 1일과 꺼짐으로 각각 저장해 다시 열어도 유지되는지 확인한다.

- [x] **Step 4: 실제 백업과 복구를 확인한다**

1. 자동 백업을 만든다.
2. 태그 이름과 좋아요를 변경한다.
3. 이전 백업을 선택해 복구한다.
4. 변경 전 상태로 돌아왔는지 확인한다.
5. `pre-restore` 백업이 목록에 생겼는지 확인한다.
6. 손상된 임의 파일을 `backups/`에 넣어도 복구 후보로 표시되지 않는지 확인한다.

- [x] **Step 5: README에 현재 동작과 한계를 기록한다**

다음만 문서화한다.

- 라이브러리 단독 사용
- 상태 기반 휴지통
- 기본 30일 자동 삭제와 설정 범위
- 일일 관리 정보 백업 7개
- 복구가 이미지 원본을 되돌리지는 않는다는 점
- 전체 미디어 백업은 앱을 닫고 라이브러리 폴더 전체를 다른 위치에 복사해야 한다는 점
- 여러 PC에서는 앞선 앱을 닫고 동기화 완료 후 다음 PC에서 열어야 한다는 점

- [x] **Step 6: 최종 리뷰와 커밋**

`requesting-code-review` 스킬로 전체 diff를 검토한 뒤 발견 사항을 수정하고 자동 검증을 다시 실행한다.

```powershell
git add app docs
git commit -m "docs: verify Lakomics vault safety"
```

---

## Self-Review

- **설계 범위:** 미디어 금고, 복사 의미, 단독 사용, 상태 기반 휴지통, 기본 30일 정책, SQLite 전용 백업, 복구 직전 백업을 모두 Task 1–7에 연결했다.
- **의도적 분리:** 중단 수집, 전체 검사, 누락 자산, 네이티브 드래그 출력은 이 계획에 placeholder로 남기지 않고 별도 계획 대상으로 명시했다.
- **Module 깊이:** UI는 경로와 SQL을 모르며 `Library` Interface만 호출한다. 백업 파일명, 보존 수, 휴지통 만료 계산과 삭제 순서는 Rust Implementation에 숨긴다.
- **하드코딩:** 30일 기본값, 7개 보존 수, 1..=3650 범위는 각각 정책을 소유한 Rust Module 한곳에서 정의하고 UI는 서버가 반환한 값과 오류를 사용한다.
- **복구 안전:** 선택 백업 검증 → 현재 스냅샷 → 임시 복원 → 검증 → 교체 → 실패 시 롤백 순서를 명시했다.
- **파괴적 동작:** 실제 파일 삭제가 실패하면 SQLite 행을 보존하며 외부 복사본에는 접근하지 않는다.
- **테스트:** 각 Task가 독립적인 RED/GREEN 검증과 커밋으로 끝나고 마지막에 Windows 네이티브 경계를 확인한다.
