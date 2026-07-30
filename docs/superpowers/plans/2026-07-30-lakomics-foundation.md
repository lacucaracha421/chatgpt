# Lakomics Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Windows에서 라이브러리 폴더를 선택하고 이미지 파일을 안전하게 복사·완전 중복 차단·계층 분류한 뒤 justified-row 갤러리에서 볼 수 있는 Lakomics의 첫 작동 가능한 흐름을 만든다.

**Architecture:** `app/` 아래에 Tauri 2 데스크톱 앱을 두고 React + TypeScript UI는 작은 Tauri 명령 Interface만 사용한다. Rust의 `library` Module이 SQLite, 파일 저장, SHA-256, 썸네일과 분류 규칙을 소유하며, UI는 경로나 SQL을 직접 다루지 않는다.

**Tech Stack:** Windows, Tauri 2, React, TypeScript, Vite, npm, Rust stable MSVC, rusqlite(SQLite bundled), image, SHA-256, Vitest, React Testing Library, Cargo tests, TanStack Virtual

## Global Constraints

- 첫 실행 대상은 Windows 데스크톱뿐이다.
- 앱은 계정·서버·자체 클라우드 없이 로컬 우선으로 동작한다.
- 한 번에 하나의 라이브러리만 연다.
- 라이브러리는 `library.sqlite`, `assets/`, `thumbnails/`, `trash/`, `backups/`를 포함한다.
- 사용자 임의 파일은 복사하고 원본을 유지한다.
- 완전 중복은 SHA-256으로 차단하며 기존 자산의 메타데이터를 자동 변경하지 않는다.
- 상위 분류 이름이나 태그 이름으로 앱 동작을 분기하지 않는다.
- 반복되는 간격·색상·글꼴·모서리는 디자인 토큰으로 관리한다.
- UI는 파일 저장, SQLite와 해시 Implementation을 직접 알지 않는다.
- 실제 두 번째 사용처가 없는 Adapter나 설정 계층은 만들지 않는다.
- 이미지·GIF 50,000개를 수용할 수 있도록 조회는 페이지 단위로 하고 화면에 보이는 행만 그린다.
- 구현 중 `CONTEXT.md`, `docs/adr/`, `docs/agents/implementation.md`의 용어와 규칙을 따른다.

## Scope Boundary

이 계획은 로컬 이미지의 직접 끌어놓기, 완전 중복, 분류와 갤러리까지만 구현한다. 유사 이미지, 검토 대기, 휴지통 동작, 백업 실행, 컬렉션, 영상, 브라우저 확장 프로그램과 기존 자료 가져오기는 `2026-07-30-lakomics-implementation-roadmap.md`의 뒤 단계가 담당한다. 다만 이후 마이그레이션으로 추가할 수 있도록 SQLite 스키마 버전 관리는 첫 단계부터 둔다.

## Official References

- Tauri Windows 준비: <https://v2.tauri.app/start/prerequisites/>
- Tauri 프로젝트 생성: <https://v2.tauri.app/start/create-project/>
- Tauri 파일 끌어놓기: <https://v2.tauri.app/reference/javascript/api/namespacewebview/>
- Tauri 테스트: <https://v2.tauri.app/develop/tests/>
- Tauri 사용자 정의 URI 프로토콜: <https://docs.rs/tauri/latest/tauri/struct.Builder.html>
- React Testing Library: <https://testing-library.com/docs/react-testing-library/intro/>

## File Map

```text
app/
├── package.json                         # npm 명령과 프런트엔드 의존성
├── vite.config.ts                       # Vite와 Vitest 설정
├── src/
│   ├── app/
│   │   ├── App.tsx                      # 라이브러리 설정 또는 메인 화면 조립
│   │   └── App.test.tsx
│   ├── assets/
│   │   ├── AssetGallery.tsx             # 가상화된 justified-row 갤러리
│   │   ├── AssetGallery.test.tsx
│   │   ├── AssetDetailDialog.tsx        # 큰 보기와 여러 분류 편집
│   │   ├── AssetDetailDialog.test.tsx
│   │   ├── justifiedRows.ts             # 순수 행 배치 계산
│   │   ├── justifiedRows.test.ts
│   │   └── mediaUrl.ts                  # 자산 ID를 내부 프로토콜 URL로 변환
│   ├── classification/
│   │   ├── ClassificationSidebar.tsx    # 분류 트리와 편집 동작
│   │   ├── ClassificationSidebar.test.tsx
│   │   └── buildTree.ts                 # 평면 분류 목록을 트리로 변환
│   ├── ingestion/
│   │   ├── useFileDrop.ts               # Tauri 끌어놓기 이벤트 연결
│   │   └── useFileDrop.test.ts
│   ├── library/
│   │   ├── LibraryContext.tsx            # 현재 라이브러리와 갱신 동작
│   │   ├── LibrarySetup.tsx              # 폴더 선택 화면
│   │   ├── client.ts                     # Tauri 명령 Interface의 유일한 Adapter
│   │   └── types.ts                      # UI가 아는 직렬화 자료형
│   ├── shared/ui/
│   │   ├── Button.tsx
│   │   ├── Dialog.tsx
│   │   ├── TextField.tsx
│   │   └── Toast.tsx
│   ├── styles/
│   │   ├── tokens.css                    # 공통 색상·간격·글꼴·모서리
│   │   └── global.css
│   ├── test/setup.ts
│   └── main.tsx
└── src-tauri/
    ├── Cargo.toml
    ├── capabilities/default.json
    ├── tauri.conf.json
    ├── migrations/0001_initial.sql       # 첫 SQLite 스키마
    ├── src/
    │   ├── lib.rs                        # Tauri 조립만 담당
    │   ├── commands.rs                   # IPC Adapter
    │   ├── media_protocol.rs             # ID 기반 읽기 전용 이미지 프로토콜
    │   └── library/
    │       ├── mod.rs                    # Library Interface
    │       ├── db.rs                     # 연결·마이그레이션
    │       ├── error.rs                  # LibraryError
    │       ├── models.rs                 # Rust 도메인 자료형
    │       ├── classification.rs         # 분류 불변조건과 저장
    │       ├── ingestion.rs              # 안전한 복사·해시·썸네일
    │       └── query.rs                  # 페이지 조회와 하위 분류 CTE
    └── tests/
        └── foundation_flow.rs             # 실제 임시 라이브러리 통합 검증
```

---

### Task 1: Windows 도구와 테스트 가능한 Tauri 앱 골격

**Files:**
- Create: `app/` through the official Tauri scaffold
- Modify: `app/package.json`
- Modify: `app/vite.config.ts`
- Create: `app/src/test/setup.ts`
- Create: `app/src/app/App.test.tsx`
- Modify: `app/src/app/App.tsx`
- Create: `app/src/styles/tokens.css`
- Create: `app/src/styles/global.css`
- Create: `app/src/shared/ui/Button.tsx`

**Interfaces:**
- Consumes: 없음
- Produces: `npm test`, `npm run build`, `npm run tauri dev`가 가능한 Tauri 2 + React + TypeScript 작업 공간

- [ ] **Step 1: Windows 필수 도구를 설치하고 새 PowerShell에서 확인**

현재 확인 결과 `node`, `npm`, `rustc`, `cargo`, `cl`이 PATH에 없다. 시스템 설치는 저장소 변경보다 범위가 크므로 실행 전에 사용자에게 알리고 다음 공식 구성으로 설치한다.

```powershell
winget install --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
winget install --id Rustlang.Rustup --accept-package-agreements --accept-source-agreements
winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended" --accept-package-agreements --accept-source-agreements
```

설치가 끝나면 터미널을 새로 열고 MSVC Rust를 명시적으로 준비한다.

```powershell
rustup install stable-msvc
rustup default stable-msvc
node --version
npm --version
rustc --version
cargo --version
```

Expected: 네 버전 명령이 모두 exit code 0을 반환한다. Windows 10 1803 이후에는 WebView2가 기본 설치되어 있으므로 `npm run tauri dev`가 WebView2 오류를 낼 때만 Evergreen Runtime을 설치한다.

- [ ] **Step 2: 공식 생성기로 `app/` 프로젝트를 만든다**

Run:

```powershell
npm create tauri-app@latest
```

Prompt answers:

```text
Project name: app
Identifier: com.lakomics.desktop
Frontend language: TypeScript / JavaScript
Package manager: npm
UI template: React
UI flavor: TypeScript
```

Run:

```powershell
Set-Location app
npm install
npm run tauri dev
```

Expected: `Lakomics`로 바꿀 준비가 된 생성 앱 창이 열린다. 확인 후 개발 서버를 종료한다.

- [ ] **Step 3: 최소 테스트 도구를 설치하고 명령을 추가한다**

Run:

```powershell
npm install --save-dev vitest jsdom @testing-library/react @testing-library/dom @testing-library/jest-dom @testing-library/user-event
```

`app/package.json` scripts에 다음을 추가한다.

```json
{
  "test": "vitest run",
  "test:watch": "vitest",
  "check": "npm run test && npm run build"
}
```

`app/vite.config.ts`:

```ts
/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
```

`app/src/test/setup.ts`:

```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 4: 앱 이름을 검증하는 실패 테스트를 작성한다**

`app/src/app/App.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("App", () => {
  it("shows the Lakomics library setup", () => {
    render(<App />);
    expect(
      screen.getByRole("heading", { name: "Lakomics" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "라이브러리 선택" }),
    ).toBeInTheDocument();
  });
});
```

Run:

```powershell
npm test -- --run src/app/App.test.tsx
```

Expected: FAIL because the generated app does not expose `App` with the required heading and button.

- [ ] **Step 5: 디자인 토큰과 최소 앱 화면을 구현한다**

`app/src/styles/tokens.css`:

```css
:root {
  --color-bg: #111216;
  --color-surface: #1a1c22;
  --color-surface-hover: #242731;
  --color-text: #f4f4f5;
  --color-muted: #a1a1aa;
  --color-accent: #f59e0b;
  --color-border: #30333d;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
  --radius-sm: 6px;
  --radius-md: 10px;
  --font-ui: "Segoe UI", sans-serif;
}
```

`app/src/shared/ui/Button.tsx`:

```tsx
import type { ButtonHTMLAttributes, PropsWithChildren } from "react";

export function Button({
  children,
  ...props
}: PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>>) {
  return (
    <button className="ui-button" {...props}>
      {children}
    </button>
  );
}
```

`app/src/app/App.tsx`:

```tsx
import { Button } from "../shared/ui/Button";

export function App() {
  return (
    <main className="setup-screen">
      <h1>Lakomics</h1>
      <p>개인 미디어 라이브러리를 선택해주세요.</p>
      <Button type="button">라이브러리 선택</Button>
    </main>
  );
}
```

생성된 `app/src/App.tsx`와 `app/src/App.css`는 제거한다. `app/src/main.tsx`는 `tokens.css`, `global.css`를 가져오고 `app/App`의 `<App />`을 렌더링한다. `global.css`에는 토큰을 사용하는 body, button, focus-visible 기본 규칙만 둔다.

- [ ] **Step 6: 프런트엔드 테스트와 빌드를 확인한다**

Run:

```powershell
npm test
npm run build
```

Expected: 모든 Vitest 테스트 PASS, TypeScript와 Vite build exit code 0.

- [ ] **Step 7: 골격을 커밋한다**

```powershell
Set-Location C:\chatgpt
git add app
git commit -m "build: scaffold Lakomics desktop app"
```

---

### Task 2: 자체 포함 라이브러리 폴더와 SQLite 기반

**Files:**
- Modify: `app/src-tauri/Cargo.toml`
- Create: `app/src-tauri/migrations/0001_initial.sql`
- Create: `app/src-tauri/src/library/error.rs`
- Create: `app/src-tauri/src/library/models.rs`
- Create: `app/src-tauri/src/library/db.rs`
- Create: `app/src-tauri/src/library/mod.rs`

**Interfaces:**
- Consumes: Task 1의 Rust crate
- Produces:
  - `pub struct Library`
  - `pub fn Library::open(root: impl AsRef<Path>) -> Result<Library, LibraryError>`
  - `pub fn Library::summary(&self) -> Result<LibrarySummary, LibraryError>`
  - `pub fn Library::connection(&self) -> Result<rusqlite::Connection, LibraryError>`

- [ ] **Step 1: 최소 Rust 의존성을 추가한다**

Run from `app/src-tauri`:

```powershell
cargo add rusqlite --features bundled
cargo add serde --features derive
cargo add thiserror
cargo add uuid --features v4,serde
cargo add chrono --features serde
cargo add --dev tempfile
```

- [ ] **Step 2: 라이브러리 생성 실패 테스트를 작성한다**

`app/src-tauri/src/library/mod.rs`에 테스트 Module을 먼저 둔다.

```rust
#[cfg(test)]
mod tests {
    use super::Library;

    #[test]
    fn open_creates_the_self_contained_library_layout() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Lakomics Library");

        let library = Library::open(&root).unwrap();

        assert_eq!(library.root(), root.as_path());
        assert!(root.join("library.sqlite").is_file());
        for directory in ["assets", "thumbnails", "trash", "backups"] {
            assert!(root.join(directory).is_dir(), "{directory} was not created");
        }
        assert_eq!(library.summary().unwrap().asset_count, 0);
    }
}
```

Run:

```powershell
cargo test library::tests::open_creates_the_self_contained_library_layout
```

Expected: FAIL because `Library` is not defined.

- [ ] **Step 3: 첫 스키마를 작성한다**

`app/src-tauri/migrations/0001_initial.sql`:

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE assets (
    id TEXT PRIMARY KEY NOT NULL,
    content_hash TEXT NOT NULL UNIQUE,
    media_kind TEXT NOT NULL CHECK (media_kind IN ('image', 'gif')),
    title TEXT,
    original_name TEXT NOT NULL,
    relative_path TEXT NOT NULL UNIQUE,
    thumbnail_relative_path TEXT NOT NULL UNIQUE,
    byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
    width INTEGER NOT NULL CHECK (width > 0),
    height INTEGER NOT NULL CHECK (height > 0),
    source_url TEXT,
    collected_at TEXT NOT NULL,
    favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
    status TEXT NOT NULL DEFAULT 'normal'
        CHECK (status IN ('normal', 'review', 'trash'))
);

CREATE TABLE classification_entries (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('root', 'work', 'tag')),
    name TEXT NOT NULL COLLATE NOCASE,
    parent_id TEXT REFERENCES classification_entries(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX classification_unique_sibling_name
ON classification_entries(COALESCE(parent_id, ''), name COLLATE NOCASE);

CREATE TABLE asset_classifications (
    asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    classification_id TEXT NOT NULL
        REFERENCES classification_entries(id) ON DELETE RESTRICT,
    PRIMARY KEY (asset_id, classification_id)
);

CREATE INDEX assets_by_collected_at
ON assets(status, collected_at DESC, id DESC);

CREATE INDEX classification_by_parent
ON classification_entries(parent_id, name COLLATE NOCASE);

PRAGMA user_version = 1;
```

- [ ] **Step 4: 오류와 자료형을 구현한다**

`app/src-tauri/src/library/error.rs`:

```rust
use std::path::PathBuf;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum LibraryError {
    #[error("라이브러리 폴더를 만들 수 없습니다: {path}")]
    CreateDirectory {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("SQLite 작업에 실패했습니다")]
    Database(#[from] rusqlite::Error),
    #[error("지원하지 않는 라이브러리 스키마 버전입니다: {0}")]
    UnsupportedSchema(i64),
}
```

`app/src-tauri/src/library/models.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySummary {
    pub root: String,
    pub asset_count: u64,
}
```

- [ ] **Step 5: `Library`와 마이그레이션을 최소 구현한다**

`app/src-tauri/src/library/db.rs`는 연결할 때마다 `foreign_keys`, WAL, 5초 busy timeout을 적용하고 `user_version`이 0일 때만 `0001_initial.sql`을 트랜잭션으로 실행한다.

```rust
use std::{path::Path, time::Duration};
use rusqlite::Connection;
use super::error::LibraryError;

const SCHEMA_VERSION: i64 = 1;
const INITIAL_SCHEMA: &str = include_str!("../../migrations/0001_initial.sql");

pub fn open_database(path: &Path) -> Result<Connection, LibraryError> {
    let mut connection = Connection::open(path)?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.busy_timeout(Duration::from_secs(5))?;

    let version: i64 =
        connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    match version {
        0 => {
            let transaction = connection.transaction()?;
            transaction.execute_batch(INITIAL_SCHEMA)?;
            transaction.commit()?;
        }
        SCHEMA_VERSION => {}
        other => return Err(LibraryError::UnsupportedSchema(other)),
    }
    Ok(connection)
}
```

`app/src-tauri/src/library/mod.rs`:

```rust
mod db;
pub mod error;
pub mod models;

use std::{fs, path::{Path, PathBuf}};
use error::LibraryError;
use models::LibrarySummary;
use rusqlite::Connection;

#[derive(Debug, Clone)]
pub struct Library {
    root: PathBuf,
}

impl Library {
    pub fn open(root: impl AsRef<Path>) -> Result<Self, LibraryError> {
        let root = root.as_ref().to_path_buf();
        fs::create_dir_all(&root).map_err(|source| LibraryError::CreateDirectory {
            path: root.clone(),
            source,
        })?;
        for name in ["assets", "thumbnails", "trash", "backups"] {
            let path = root.join(name);
            fs::create_dir_all(&path).map_err(|source| LibraryError::CreateDirectory {
                path,
                source,
            })?;
        }
        db::open_database(&root.join("library.sqlite"))?;
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn connection(&self) -> Result<Connection, LibraryError> {
        db::open_database(&self.root.join("library.sqlite"))
    }

    pub fn summary(&self) -> Result<LibrarySummary, LibraryError> {
        let connection = self.connection()?;
        let asset_count = connection.query_row(
            "SELECT COUNT(*) FROM assets WHERE status = 'normal'",
            [],
            |row| row.get(0),
        )?;
        Ok(LibrarySummary {
            root: self.root.to_string_lossy().into_owned(),
            asset_count,
        })
    }
}
```

- [ ] **Step 6: Rust 검사와 테스트를 실행한다**

```powershell
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
```

Expected: formatting clean, Clippy 0 warnings, all tests PASS.

- [ ] **Step 7: 라이브러리 기반을 커밋한다**

```powershell
git add app/src-tauri
git commit -m "feat: create self-contained library storage"
```

---

### Task 3: 계층형 분류 규칙과 저장

**Files:**
- Modify: `app/src-tauri/src/library/error.rs`
- Modify: `app/src-tauri/src/library/models.rs`
- Create: `app/src-tauri/src/library/classification.rs`
- Modify: `app/src-tauri/src/library/mod.rs`

**Interfaces:**
- Consumes: `Library::connection()`
- Produces:
  - `ClassificationKind::{Root, Work, Tag}`
  - `CreateClassification { kind, name, parent_id }`
  - `Library::create_classification(request)`
  - `Library::rename_classification(id, name)`
  - `Library::move_classification(id, parent_id)`
  - `Library::delete_classification(id)`
  - `Library::list_classifications()`
  - `Library::set_asset_classifications(asset_id, classification_ids)`
  - `Library::get_asset_classifications(asset_id)`

- [ ] **Step 1: 분류 불변조건 테스트를 작성한다**

`classification.rs`의 테스트는 다음 시나리오를 실제 임시 SQLite로 검증한다.

```rust
#[test]
fn work_requires_a_root_parent_and_tag_can_nest_under_a_work() {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    let root = library.create_classification(CreateClassification {
        kind: ClassificationKind::Root,
        name: "게임".into(),
        parent_id: None,
    }).unwrap();
    let work = library.create_classification(CreateClassification {
        kind: ClassificationKind::Work,
        name: "블루 아카이브".into(),
        parent_id: Some(root.id.clone()),
    }).unwrap();
    let tag = library.create_classification(CreateClassification {
        kind: ClassificationKind::Tag,
        name: "아로나".into(),
        parent_id: Some(work.id.clone()),
    }).unwrap();

    assert_eq!(tag.parent_id, Some(work.id));
}

#[test]
fn moving_a_tag_below_its_descendant_is_rejected() {
    let fixture = ClassificationFixture::new();
    let error = fixture.library
        .move_classification(&fixture.parent_tag.id, Some(&fixture.child_tag.id))
        .unwrap_err();
    assert!(matches!(error, LibraryError::ClassificationCycle));
}

#[test]
fn deleting_a_non_empty_classification_is_rejected() {
    let fixture = ClassificationFixture::new();
    let error = fixture.library
        .delete_classification(&fixture.root.id)
        .unwrap_err();
    assert!(matches!(error, LibraryError::ClassificationNotEmpty));
}
```

`ClassificationFixture`는 같은 테스트 Module 안에서 `게임 → 블루 아카이브 → 학생 → 아로나`를 만드는 작은 helper로 구현한다.

Run:

```powershell
cargo test library::classification::tests
```

Expected: FAIL because classification methods and errors do not exist.

- [ ] **Step 2: 분류 자료형과 명시적 오류를 추가한다**

`models.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ClassificationKind {
    Root,
    Work,
    Tag,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClassificationEntry {
    pub id: String,
    pub kind: ClassificationKind,
    pub name: String,
    pub parent_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateClassification {
    pub kind: ClassificationKind,
    pub name: String,
    pub parent_id: Option<String>,
}
```

`error.rs`에 다음 변형을 추가한다.

```rust
#[error("분류 이름은 비어 있을 수 없습니다")]
EmptyClassificationName,
#[error("요청한 분류 항목을 찾을 수 없습니다")]
ClassificationNotFound,
#[error("같은 위치에 같은 이름의 분류 항목이 있습니다")]
DuplicateClassificationName,
#[error("상위 분류는 부모를 가질 수 없고 작품은 상위 분류 아래에 있어야 합니다")]
InvalidClassificationParent,
#[error("분류 항목을 자신의 하위 항목으로 옮길 수 없습니다")]
ClassificationCycle,
#[error("하위 항목이나 자산이 연결된 분류 항목은 삭제할 수 없습니다")]
ClassificationNotEmpty,
```

- [ ] **Step 3: 생성·이름 변경·이동·삭제를 구현한다**

구현 규칙:

```text
Root: parent_id가 반드시 없음
Work: parent kind가 반드시 Root
Tag: Root, Work, Tag 중 어느 항목 아래에도 둘 수 있음
Name: trim 후 1자 이상
Move: recursive CTE로 대상의 모든 자손을 구해 새 부모가 그 안에 있으면 거부
Delete: 자식 또는 asset_classifications가 하나라도 있으면 거부
Sibling name: SQLite unique index 위반을 DuplicateClassificationName으로 변환
```

`classification.rs`의 공개 Implementation은 모두 `impl Library` 안에 두고 SQL 행을 `ClassificationEntry`로 바꾸는 private 함수 하나를 공유한다. 호출자는 SQL과 트랜잭션 순서를 알지 않는다.

- [ ] **Step 4: 자산의 여러 분류 연결 교체를 구현한다**

`set_asset_classifications`는 한 트랜잭션에서 현재 연결을 지우고 요청한 연결을 넣는다. 존재하지 않는 자산이나 분류가 있으면 전체를 rollback한다.

```rust
pub fn set_asset_classifications(
    &self,
    asset_id: &str,
    classification_ids: &[String],
) -> Result<(), LibraryError>
```

중복 ID는 `BTreeSet`으로 한 번만 처리한다. `get_asset_classifications(asset_id)`는 직접 연결된 분류 ID만 이름순으로 반환한다. 분류의 상위 항목은 별도로 저장하지 않고 조회 시 recursive CTE로 포함한다.

- [ ] **Step 5: 분류 테스트와 전체 Rust 검사를 실행한다**

```powershell
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test library::classification
cargo test
```

Expected: all PASS, 0 warnings.

- [ ] **Step 6: 분류 Module을 커밋한다**

```powershell
git add app/src-tauri/src/library
git commit -m "feat: add hierarchical classification model"
```

---

### Task 4: 안전한 이미지 수집과 완전 중복 차단

**Files:**
- Modify: `app/src-tauri/Cargo.toml`
- Modify: `app/src-tauri/src/library/error.rs`
- Modify: `app/src-tauri/src/library/models.rs`
- Create: `app/src-tauri/src/library/ingestion.rs`
- Modify: `app/src-tauri/src/library/mod.rs`

**Interfaces:**
- Consumes: `Library`, `set_asset_classifications`
- Produces:
  - `IngestImageRequest { source_path, classification_id, source_url }`
  - `IngestOutcome::Added { asset }`
  - `IngestOutcome::ExactDuplicate { existing_asset_id }`
  - `Library::ingest_image(request)`

- [ ] **Step 1: 이미지·해시 의존성을 추가한다**

Run from `app/src-tauri`:

```powershell
cargo add sha2
cargo add hex
cargo add image --features jpeg,png,gif,webp
```

- [ ] **Step 2: 사용자 원본 보존과 중복 차단 실패 테스트를 작성한다**

테스트에서 별도 binary fixture를 커밋하지 말고 `image::RgbImage`로 PNG를 만든다.

```rust
fn write_test_png(path: &std::path::Path, rgb: [u8; 3]) {
    let image = image::RgbImage::from_pixel(8, 6, image::Rgb(rgb));
    image.save_with_format(path, image::ImageFormat::Png).unwrap();
}

#[test]
fn ingest_copies_the_image_and_keeps_the_user_source() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source.png");
    write_test_png(&source, [10, 20, 30]);
    let library = Library::open(temp.path().join("library")).unwrap();

    let outcome = library.ingest_image(IngestImageRequest {
        source_path: source.clone(),
        classification_id: None,
        source_url: None,
    }).unwrap();

    let IngestOutcome::Added { asset } = outcome else {
        panic!("first ingest must add an asset");
    };
    assert!(source.is_file());
    assert!(library.root().join(&asset.relative_path).is_file());
    assert!(library.root().join(&asset.thumbnail_relative_path).is_file());
}

#[test]
fn ingesting_the_same_bytes_twice_returns_the_existing_asset() {
    let fixture = IngestionFixture::new();
    let first = fixture.ingest();
    let second = fixture.ingest();

    let IngestOutcome::Added { asset } = first else {
        panic!("first ingest must add an asset");
    };
    assert_eq!(
        second,
        IngestOutcome::ExactDuplicate {
            existing_asset_id: asset.id,
        },
    );
    assert_eq!(fixture.library.summary().unwrap().asset_count, 1);
}
```

Run:

```powershell
cargo test library::ingestion::tests
```

Expected: FAIL because ingestion types and method do not exist.

- [ ] **Step 3: 수집 자료형과 오류를 정의한다**

`models.rs`:

```rust
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestImageRequest {
    pub source_path: std::path::PathBuf,
    pub classification_id: Option<String>,
    pub source_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AssetSummary {
    pub id: String,
    pub title: Option<String>,
    pub original_name: String,
    pub relative_path: String,
    pub thumbnail_relative_path: String,
    pub byte_size: u64,
    pub width: u32,
    pub height: u32,
    pub collected_at: String,
    pub favorite: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum IngestOutcome {
    Added { asset: AssetSummary },
    ExactDuplicate { existing_asset_id: String },
}
```

`error.rs`에 다음 오류를 추가한다.

```rust
#[error("원본 파일을 읽을 수 없습니다: {path}")]
ReadSource {
    path: PathBuf,
    #[source]
    source: std::io::Error,
},
#[error("이미지 형식을 지원하지 않거나 파일이 손상됐습니다")]
UnsupportedImage,
#[error("라이브러리 파일을 저장할 수 없습니다: {path}")]
WriteAsset {
    path: PathBuf,
    #[source]
    source: std::io::Error,
},
```

- [ ] **Step 4: 안전한 수집 순서를 구현한다**

`Library::ingest_image`의 순서를 다음으로 고정한다.

```text
1. source_path가 일반 파일인지 확인
2. classification_id가 있으면 존재 확인
3. assets/.staging/{uuid}.part로 스트리밍 복사하면서 SHA-256 계산
4. image crate로 실제 형식과 크기 확인
5. content_hash UNIQUE 조회
6. 완전 중복이면 staging 제거 후 기존 ID 반환
7. 최대 폭 360px WebP 썸네일을 thumbnails/{hash[0..2]}/{hash}.webp에 저장
8. 원본을 assets/{hash[0..2]}/{hash}.{detected_extension}으로 rename
9. SQLite transaction으로 assets와 선택 분류 연결 삽입
10. transaction 실패 시 이번에 만든 최종 원본과 썸네일 제거
11. Added 반환; 사용자 source_path는 어떤 경우에도 삭제하지 않음
```

`ingestion.rs`가 소유하는 `MAX_IMAGE_BYTES = 512 * 1024 * 1024`와 `MAX_IMAGE_PIXELS = 200_000_000`을 넘으면 `UnsupportedImage`로 거부한다. 이 제한은 호출 화면마다 복사하지 않는다.

썸네일과 최종 파일 경로를 기록하는 private `PendingFiles` guard를 두고, 성공 표시 전에 함수가 끝나면 `Drop`에서 이번 수집이 만든 파일만 제거한다. transaction commit 뒤 `PendingFiles::commit()`을 호출해 guard를 해제한다. 따라서 썸네일 저장 후 원본 rename이 실패하는 경우도 잔여 파일이 남지 않는다.

확장자는 파일명에서 믿지 않고 감지한 `ImageFormat`을 다음처럼 변환한다.

```rust
fn extension_for(format: image::ImageFormat) -> Option<&'static str> {
    match format {
        image::ImageFormat::Jpeg => Some("jpg"),
        image::ImageFormat::Png => Some("png"),
        image::ImageFormat::Gif => Some("gif"),
        image::ImageFormat::WebP => Some("webp"),
        _ => None,
    }
}
```

`collected_at`은 `chrono::Utc::now().to_rfc3339()`로 기록한다. GIF는 `media_kind = 'gif'`, 나머지는 `image`로 기록한다.

- [ ] **Step 5: 실패 후 잔여 파일 정리 테스트를 추가한다**

존재하지 않는 분류 ID를 요청해 수집을 실패시킨 뒤 사용자 원본은 남고 `assets/`와 `thumbnails/`에 정식 파일이 없는지 검증한다.

```rust
#[test]
fn failed_ingest_keeps_source_and_does_not_leave_a_registered_file() {
    let fixture = IngestionFixture::new();
    let result = fixture.library.ingest_image(IngestImageRequest {
        source_path: fixture.source.clone(),
        classification_id: Some("missing-classification".into()),
        source_url: None,
    });

    assert!(result.is_err());
    assert!(fixture.source.is_file());
    assert_eq!(fixture.library.summary().unwrap().asset_count, 0);
}
```

- [ ] **Step 6: Rust 전체 검증을 실행한다**

```powershell
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
```

Expected: all PASS, 0 warnings.

- [ ] **Step 7: 수집 Module을 커밋한다**

```powershell
git add app/src-tauri
git commit -m "feat: ingest images with exact duplicate protection"
```

---

### Task 5: 작은 Tauri 명령 Interface와 라이브러리 선택 화면

**Files:**
- Modify: `app/src-tauri/src/lib.rs`
- Create: `app/src-tauri/src/commands.rs`
- Modify: `app/src-tauri/capabilities/default.json`
- Modify: `app/src/library/types.ts`
- Create: `app/src/library/client.ts`
- Create: `app/src/library/LibraryContext.tsx`
- Create: `app/src/library/LibrarySetup.tsx`
- Modify: `app/src/app/App.tsx`
- Modify: `app/src/app/App.test.tsx`

**Interfaces:**
- Consumes: `Library::open`, `Library::summary`, classification and ingestion methods
- Produces:
  - Tauri commands `open_library`, `current_library`, `list_classifications`, `create_classification`, `rename_classification`, `move_classification`, `delete_classification`, `get_asset_classifications`, `set_asset_classifications`, `ingest_image`
  - TypeScript `LibraryGateway`
  - React `LibraryProvider` and `useLibrary()`

- [ ] **Step 1: 공식 폴더 선택 plugin을 추가한다**

Run from `app/`:

```powershell
npm run tauri add dialog
```

Expected: Rust plugin, JavaScript package와 필요한 capability가 추가된다.

- [ ] **Step 2: Tauri 명령 Adapter의 직렬화 테스트를 작성한다**

`commands.rs`는 내부 오류를 UI에 안정적으로 전달하기 위해 다음 오류만 직렬화한다.

```rust
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: &'static str,
    pub message: String,
}
```

테스트:

```rust
#[test]
fn command_error_has_stable_json_fields() {
    let error = CommandError::from(LibraryError::ClassificationNotFound);
    let value = serde_json::to_value(error).unwrap();
    assert_eq!(value["code"], "classification_not_found");
    assert_eq!(
        value["message"],
        "요청한 분류 항목을 찾을 수 없습니다",
    );
}
```

Run:

```powershell
cargo test commands::tests::command_error_has_stable_json_fields
```

Expected: FAIL because `CommandError` does not exist.

- [ ] **Step 3: 현재 라이브러리 상태와 명령을 구현한다**

```rust
#[derive(Default)]
pub struct AppState {
    library: std::sync::RwLock<Option<Library>>,
}
```

각 command는 lock을 잡은 채 파일 작업을 하지 않는다. 현재 `Library`를 clone한 뒤 lock을 놓고 Method를 호출한다.

```rust
#[tauri::command]
pub fn open_library(
    path: String,
    state: tauri::State<'_, AppState>,
) -> Result<LibrarySummary, CommandError>

#[tauri::command]
pub fn current_library(
    state: tauri::State<'_, AppState>,
) -> Result<Option<LibrarySummary>, CommandError>

#[tauri::command]
pub async fn ingest_image(
    request: IngestImageRequest,
    state: tauri::State<'_, AppState>,
) -> Result<IngestOutcome, CommandError>
```

`ingest_image`는 clone한 `Library`를 `tauri::async_runtime::spawn_blocking` 안에서 호출한다. `lib.rs`는 `AppState`, dialog plugin과 command 목록을 조립할 뿐 도메인 규칙을 갖지 않는다.

- [ ] **Step 4: TypeScript Interface와 실패하는 설정 화면 테스트를 작성한다**

`app/src/library/types.ts`는 Rust의 `camelCase` JSON과 정확히 맞춘다.

```ts
export type LibrarySummary = {
  root: string;
  assetCount: number;
};

export type ClassificationKind = "root" | "work" | "tag";

export type ClassificationEntry = {
  id: string;
  kind: ClassificationKind;
  name: string;
  parentId: string | null;
};

export type AssetSummary = {
  id: string;
  title: string | null;
  originalName: string;
  relativePath: string;
  thumbnailRelativePath: string;
  byteSize: number;
  width: number;
  height: number;
  collectedAt: string;
  favorite: boolean;
};

export type CreateClassification = {
  kind: ClassificationKind;
  name: string;
  parentId: string | null;
};

export type IngestImageInput = {
  sourcePath: string;
  classificationId: string | null;
  sourceUrl: string | null;
};

export type IngestOutcome =
  | { status: "added"; asset: AssetSummary }
  | { status: "exact_duplicate"; existingAssetId: string };
```

`LibraryGateway`:

```ts
export interface LibraryGateway {
  openLibrary(path: string): Promise<LibrarySummary>;
  currentLibrary(): Promise<LibrarySummary | null>;
  listClassifications(): Promise<ClassificationEntry[]>;
  createClassification(
    input: CreateClassification,
  ): Promise<ClassificationEntry>;
  renameClassification(id: string, name: string): Promise<void>;
  moveClassification(id: string, parentId: string | null): Promise<void>;
  deleteClassification(id: string): Promise<void>;
  setAssetClassifications(
    assetId: string,
    classificationIds: string[],
  ): Promise<void>;
  getAssetClassifications(assetId: string): Promise<string[]>;
  ingestImage(input: IngestImageInput): Promise<IngestOutcome>;
}
```

`App.test.tsx`에서는 fake gateway와 fake folder picker를 전달하고 `라이브러리 선택` 클릭 후 선택한 경로가 표시되는지 검증한다.

Run:

```powershell
npm test -- --run src/app/App.test.tsx
```

Expected: FAIL because provider and setup flow do not exist.

- [ ] **Step 5: 설정 화면과 마지막 경로 복원을 구현한다**

`LibrarySetup`은 `@tauri-apps/plugin-dialog`의 `open({ directory: true, multiple: false })`를 호출한다. 성공한 경로만 `localStorage`의 `lakomics.libraryPath`에 저장한다.

앱 시작 시 저장 경로가 있으면 `openLibrary`를 호출한다. 열기 실패 시 새 라이브러리를 자동 생성하거나 다른 경로로 바꾸지 않고 설정 화면에 오류를 보여준다. 테스트에서는 dialog 호출을 prop으로 주입해 운영체제 창 없이 검증한다.

- [ ] **Step 6: 양쪽 검증을 실행한다**

```powershell
npm test
npm run build
Set-Location src-tauri
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
```

Expected: all PASS, 0 warnings.

- [ ] **Step 7: Interface와 설정 화면을 커밋한다**

```powershell
Set-Location C:\chatgpt
git add app
git commit -m "feat: open a library through the Tauri interface"
```

---

### Task 6: 분류 트리와 공통 입력 UI

**Files:**
- Create: `app/src/shared/ui/Dialog.tsx`
- Create: `app/src/shared/ui/TextField.tsx`
- Create: `app/src/shared/ui/Toast.tsx`
- Create: `app/src/classification/buildTree.ts`
- Create: `app/src/classification/ClassificationSidebar.tsx`
- Create: `app/src/classification/ClassificationSidebar.test.tsx`
- Modify: `app/src/app/App.tsx`
- Modify: `app/src/styles/global.css`

**Interfaces:**
- Consumes: `LibraryGateway` classification methods
- Produces:
  - `buildClassificationTree(entries)`
  - `ClassificationSidebar { entries, selectedId, onSelect, onChanged }`
  - 재사용 가능한 `Dialog`, `TextField`, `Toast`

- [ ] **Step 1: 트리 변환과 분류 UI 실패 테스트를 작성한다**

`buildTree` 테스트:

```ts
it("orders roots and children alphabetically without losing type", () => {
  const tree = buildClassificationTree([
    { id: "tag", kind: "tag", name: "아로나", parentId: "work" },
    { id: "work", kind: "work", name: "블루 아카이브", parentId: "root" },
    { id: "root", kind: "root", name: "게임", parentId: null },
  ]);

  expect(tree[0].entry.name).toBe("게임");
  expect(tree[0].children[0].entry.kind).toBe("work");
  expect(tree[0].children[0].children[0].entry.name).toBe("아로나");
});
```

Sidebar 사용자 테스트:

```tsx
it("creates a work below the selected root", async () => {
  const user = userEvent.setup();
  render(<ClassificationSidebar {...fixtureProps} />);

  await user.click(screen.getByRole("button", { name: "게임 선택" }));
  await user.click(screen.getByRole("button", { name: "하위 작품 추가" }));
  await user.type(screen.getByLabelText("이름"), "블루 아카이브");
  await user.click(screen.getByRole("button", { name: "추가" }));

  expect(fixtureGateway.createClassification).toHaveBeenCalledWith({
    kind: "work",
    name: "블루 아카이브",
    parentId: "root",
  });
});
```

Run:

```powershell
npm test -- --run src/classification
```

Expected: FAIL because the tree and sidebar do not exist.

- [ ] **Step 2: native `<dialog>` 기반 공통 UI를 구현한다**

`Dialog`는 `open` prop이 바뀔 때 `showModal()`과 `close()`를 호출하고, `cancel` 이벤트를 `onClose`로 전달한다. 제목은 `aria-labelledby`로 연결한다. `TextField`는 label과 error를 함께 렌더링한다. `Toast`는 `role="status"`를 사용한다.

공통 UI의 색상, 간격, radius는 `tokens.css`만 참조한다. 화면 전용 숫자를 복사하지 않는다.

- [ ] **Step 3: 트리와 CRUD 화면을 구현한다**

`ClassificationSidebar` 규칙:

```text
맨 위 추가: Root만 생성
Root 선택 후 추가: Work 또는 Tag
Work/Tag 선택 후 추가: Tag
이름 변경: 모든 kind 허용
이동: drag UI는 이 단계에서 만들지 않고 부모 선택 Dialog 사용
삭제: Rust가 non-empty를 거부하면 해당 오류 메시지 표시
선택: 한 항목만 selectedId로 부모에게 전달
```

`buildClassificationTree`는 orphan 항목을 조용히 버리지 않고 별도 `orphans` 배열로 반환한다. 정상 UI에서는 orphans가 있으면 오류 배너를 보여준다.

- [ ] **Step 4: 테스트와 접근성 기본 동작을 확인한다**

```powershell
npm test -- --run src/classification src/shared
npm run build
```

Expected: all PASS. 키보드 `Tab`, `Enter`, `Escape` 경로가 테스트에 포함된다.

- [ ] **Step 5: 분류 UI를 커밋한다**

```powershell
git add app/src
git commit -m "feat: manage classifications from the sidebar"
```

---

### Task 7: 페이지 조회, 안전한 미디어 프로토콜과 justified-row 갤러리

**Files:**
- Create: `app/src-tauri/src/library/query.rs`
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/src/library/mod.rs`
- Create: `app/src-tauri/src/media_protocol.rs`
- Modify: `app/src-tauri/src/lib.rs`
- Modify: `app/src-tauri/src/commands.rs`
- Modify: `app/src-tauri/tauri.conf.json`
- Modify: `app/src/library/types.ts`
- Modify: `app/src/library/client.ts`
- Create: `app/src/assets/mediaUrl.ts`
- Create: `app/src/assets/justifiedRows.ts`
- Create: `app/src/assets/justifiedRows.test.ts`
- Create: `app/src/assets/AssetGallery.tsx`
- Create: `app/src/assets/AssetGallery.test.tsx`
- Modify: `app/src/app/App.tsx`

**Interfaces:**
- Consumes: stored assets and classifications
- Produces:
  - `AssetQuery { classification_id, direct_only, after, limit }`
  - `AssetPage { items, next_cursor }`
  - `Library::list_assets(query)`
  - Tauri command `list_assets`
  - `LibraryGateway.listAssets(query)`
  - `LibraryGateway.getAssetClassifications(assetId)`
  - `Library::resolve_media(asset_id, variant)`
  - read-only `lakomics://thumbnail/{assetId}` and `lakomics://asset/{assetId}`
  - `buildJustifiedRows(items, containerWidth, targetHeight, gap)`

- [ ] **Step 1: 하위 분류 포함과 keyset pagination 실패 테스트를 작성한다**

Rust 테스트는 `게임 → 블루 아카이브 → 아로나`에 연결된 자산이 `게임` 조회에 나타나고, `direct_only = true`에서는 나타나지 않는지 확인한다. 3개 자산을 page size 2로 조회해 두 페이지 사이에 중복이 없는지도 검증한다.

```rust
let first = library.list_assets(AssetQuery {
    classification_id: Some(root.id.clone()),
    direct_only: false,
    after: None,
    limit: 2,
}).unwrap();
let second = library.list_assets(AssetQuery {
    classification_id: Some(root.id),
    direct_only: false,
    after: first.next_cursor.clone(),
    limit: 2,
}).unwrap();

assert_eq!(first.items.len(), 2);
assert_eq!(second.items.len(), 1);
assert_ne!(first.items[0].id, second.items[0].id);
```

Run:

```powershell
cargo test library::query::tests
```

Expected: FAIL because query types and method do not exist.

- [ ] **Step 2: recursive CTE와 keyset pagination을 구현한다**

자료형:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetCursor {
    pub collected_at: String,
    pub id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetQuery {
    pub classification_id: Option<String>,
    pub direct_only: bool,
    pub after: Option<AssetCursor>,
    pub limit: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetPage {
    pub items: Vec<AssetSummary>,
    pub next_cursor: Option<AssetCursor>,
}
```

`limit`은 1~200으로 제한한다. `classification_id = None`이면 모든 정상 자산을 조회한다. `direct_only = false`이면 `WITH RECURSIVE descendants(id)`로 선택 항목과 자손을 구하고, `EXISTS` subquery로 `asset_classifications` 연결을 확인해 여러 하위 분류에 연결된 같은 자산이 중복 행으로 나오지 않게 한다. 정렬은 `(collected_at DESC, id DESC)`이고 cursor 조건은 두 열을 함께 비교한다.

`commands.rs`와 TypeScript Interface도 같은 자료형을 노출한다.

```ts
export type AssetCursor = {
  collectedAt: string;
  id: string;
};

export type AssetQuery = {
  classificationId: string | null;
  directOnly: boolean;
  after: AssetCursor | null;
  limit: number;
};

export type AssetPage = {
  items: AssetSummary[];
  nextCursor: AssetCursor | null;
};

export interface LibraryGateway {
  listAssets(query: AssetQuery): Promise<AssetPage>;
  getAssetClassifications(assetId: string): Promise<string[]>;
}
```

위 snippet은 Task 5에서 만든 `LibraryGateway`를 대체하는 별도 Interface가 아니라 같은 선언에 `listAssets` method를 추가한다.

- [ ] **Step 3: 임의 경로를 받지 않는 미디어 프로토콜을 구현한다**

`Library::resolve_media(asset_id, variant)`는 DB에서 `relative_path` 또는 `thumbnail_relative_path`를 찾고, canonicalized 경로가 라이브러리 root 안에 있는지 확인한 뒤 bytes와 MIME을 반환한다.

```rust
pub enum MediaVariant {
    Asset,
    Thumbnail,
}

pub struct MediaResponse {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
}
```

`media_protocol.rs`는 URL path가 정확히 `/thumbnail/{uuid}` 또는 `/asset/{uuid}`인 요청만 허용한다. `..`, 슬래시가 포함된 ID, 찾을 수 없는 자산은 각각 400 또는 404를 반환한다. 웹페이지가 파일 경로를 요청하는 Interface는 만들지 않는다.

Windows UI용 URL 생성은 한 파일이 소유한다.

`app/src/assets/mediaUrl.ts`:

```ts
const MEDIA_ORIGIN = "http://lakomics.localhost";

export function thumbnailUrl(assetId: string): string {
  return `${MEDIA_ORIGIN}/thumbnail/${encodeURIComponent(assetId)}`;
}

export function assetUrl(assetId: string): string {
  return `${MEDIA_ORIGIN}/asset/${encodeURIComponent(assetId)}`;
}
```

`tauri.conf.json` CSP의 `img-src`에 `'self' http://lakomics.localhost`만 추가한다.

- [ ] **Step 4: justified-row 순수 계산 실패 테스트를 작성한다**

```ts
it("fills a completed row without changing aspect ratios", () => {
  const rows = buildJustifiedRows(
    [
      { id: "a", width: 400, height: 200 },
      { id: "b", width: 200, height: 200 },
      { id: "c", width: 300, height: 200 },
    ],
    900,
    180,
    8,
  );

  expect(rows).toHaveLength(1);
  expect(rows[0].items[0].width / rows[0].height).toBeCloseTo(2, 2);
  const used =
    rows[0].items.reduce((sum, item) => sum + item.width, 0) +
    8 * (rows[0].items.length - 1);
  expect(used).toBeCloseTo(900, 0);
});

it("keeps the final incomplete row at target height", () => {
  const rows = buildJustifiedRows(
    [{ id: "a", width: 400, height: 200 }],
    900,
    180,
    8,
  );
  expect(rows[0].height).toBe(180);
});
```

Run:

```powershell
npm test -- --run src/assets/justifiedRows.test.ts
```

Expected: FAIL because the function does not exist.

- [ ] **Step 5: 행 계산과 가상화 갤러리를 구현한다**

Run:

```powershell
npm install @tanstack/react-virtual
```

행 계산식:

```ts
const completedHeight =
  (containerWidth - gap * (rowItems.length - 1)) /
  rowItems.reduce((sum, item) => sum + item.width / item.height, 0);
```

예상 행 너비가 container width에 도달하면 completed row로 확정한다. 마지막 행만 `targetHeight`를 사용한다. `AssetGallery`는 TanStack Virtual로 보이는 행과 overscan 3개만 렌더링하며, 스크롤 끝 5행 이내에서 다음 cursor page를 요청한다. 갤러리 toolbar의 `이 항목만` toggle은 `directOnly`를 바꿔 첫 page부터 다시 조회한다.

이미지 클릭 시 `AssetDetailDialog`가 공통 `Dialog` 안에 `assetUrl(id)`를 사용해 큰 이미지를 표시한다. `alt`는 사용자 제목, 없으면 원본 파일명을 사용한다. 분류 편집을 열면 `getAssetClassifications`로 직접 연결된 항목을 체크하고 저장 시 기존 `setAssetClassifications`를 호출한다. 따라서 브라우저 도넛과 달리 데스크톱에서는 한 자산을 여러 분류 항목에 연결할 수 있다.

`AssetGallery.test.tsx`에서는 500개의 fake `AssetSummary`를 넘기고 고정 높이 scroll container를 설정한 뒤 렌더링된 `<img>`가 100개 미만인지 검증한다. 이 테스트가 전체 자산 카드를 DOM에 만드는 회귀를 막는다.

`AssetDetailDialog.test.tsx`는 두 분류 항목을 체크해 저장하고 `setAssetClassifications(assetId, ["tag-arona", "tag-clean"])`가 한 번 호출되는지 검증한다.

- [ ] **Step 6: backend와 frontend 검증을 실행한다**

```powershell
Set-Location app\src-tauri
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
Set-Location ..
npm test
npm run build
```

Expected: all PASS, 0 warnings.

- [ ] **Step 7: 조회와 갤러리를 커밋한다**

```powershell
Set-Location C:\chatgpt
git add app
git commit -m "feat: browse classified assets in a virtual gallery"
```

---

### Task 8: 파일 끌어놓기와 첫 수직 흐름 완성

**Files:**
- Create: `app/src/ingestion/useFileDrop.ts`
- Create: `app/src/ingestion/useFileDrop.test.ts`
- Modify: `app/src/app/App.tsx`
- Modify: `app/src/shared/ui/Toast.tsx`
- Create: `app/src-tauri/tests/foundation_flow.rs`
- Modify: `app/README.md`

**Interfaces:**
- Consumes: Tauri `getCurrentWebview().onDragDropEvent`, `LibraryGateway.ingestImage`, selected classification
- Produces: 파일 drop → 수집 결과 toast → 갤러리 갱신의 완성된 사용자 흐름

- [ ] **Step 1: 끌어놓기 결과 처리 실패 테스트를 작성한다**

Tauri event를 hook 안에서 직접 고정하지 않고 구독 함수를 주입해 테스트한다.

```ts
export type DropSubscriber = (
  handler: (paths: string[]) => void,
) => Promise<() => void>;
```

테스트:

```tsx
it("ingests dropped paths with the selected classification", async () => {
  let drop: ((paths: string[]) => void) | undefined;
  const subscribe: DropSubscriber = async (handler) => {
    drop = handler;
    return () => undefined;
  };
  const ingestImage = vi.fn().mockResolvedValue({
    status: "added",
    asset: fixtureAsset,
  });

  renderHook(() =>
    useFileDrop({
      subscribe,
      classificationId: "tag-arona",
      ingestImage,
      onResult: vi.fn(),
    }),
  );
  act(() => drop?.(["C:\\images\\arona.png"]));

  await waitFor(() =>
    expect(ingestImage).toHaveBeenCalledWith({
      sourcePath: "C:\\images\\arona.png",
      classificationId: "tag-arona",
      sourceUrl: null,
    }),
  );
});
```

Run:

```powershell
npm test -- --run src/ingestion/useFileDrop.test.ts
```

Expected: FAIL because the hook does not exist.

- [ ] **Step 2: Tauri drop Adapter와 순차 수집을 구현한다**

운영 Adapter:

```ts
import { getCurrentWebview } from "@tauri-apps/api/webview";

export const subscribeToTauriDrops: DropSubscriber = async (handler) =>
  getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type === "drop") {
      handler(event.payload.paths);
    }
  });
```

hook은 drop 한 번의 파일을 순차 처리해 디스크 과부하를 피한다. Added는 `저장했습니다`, ExactDuplicate는 `이미 보관된 파일입니다`와 기존 자산 ID를 전달한다. 실패는 원본을 지우지 않고 `CommandError.message`를 toast로 보여준다. component unmount 때 반드시 unlisten한다.

- [ ] **Step 3: 선택 분류, drop 상태와 갤러리 갱신을 App에서 연결한다**

```text
분류가 선택됨: 해당 classificationId로 수집
분류가 선택되지 않음: classificationId = null로 수집
수집 성공: 첫 asset page를 다시 요청
완전 중복: 기존 자산 메타데이터와 분류를 변경하지 않음
처리 중: drop 영역에 파일 수와 현재 순번 표시
오류: Toast 표시 후 다음 파일 계속 처리
```

미분류함 전용 화면은 Phase 2에서 추가한다. Phase 1에서는 분류 없는 자산을 전체 자산 화면에서 볼 수 있다.

- [ ] **Step 4: Rust 통합 테스트로 핵심 흐름을 검증한다**

`foundation_flow.rs`는 public `library` crate Interface를 통해 다음을 한 테스트에서 실행한다.

```rust
#[test]
fn image_can_be_ingested_classified_queried_and_deduplicated() {
    let fixture = FoundationFixture::new();
    let classification = fixture.create_game_work_tag();
    let added = fixture.ingest(&classification.tag_id);
    let page = fixture.query(&classification.root_id);

    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].id, added.id);
    assert!(fixture.source_path.is_file());

    let duplicate = fixture.ingest_raw(&classification.tag_id);
    assert_eq!(
        duplicate,
        IngestOutcome::ExactDuplicate {
            existing_asset_id: added.id,
        },
    );
}
```

같은 파일 안의 `FoundationFixture`는 `tempfile::TempDir`, `Library`, 생성한 PNG의 `source_path`를 소유한다. `new()`는 8×6 PNG와 빈 라이브러리를 만들고, `create_game_work_tag`, `ingest`, `ingest_raw`, `query`는 이 계획에 정의된 public Interface만 호출한다. SQL이나 내부 파일 함수를 테스트에서 직접 호출하지 않는다.

이를 위해 `src-tauri/src/lib.rs`에서 `pub mod library;`를 노출하되 DB나 파일 helper는 `pub(crate)`로 유지한다.

- [ ] **Step 5: 사용자용 실행 안내를 작성한다**

`app/README.md`에 다음 내용만 기록한다.

```text
필수 도구 확인
npm install
npm run tauri dev
npm test
cd src-tauri && cargo test

첫 사용:
1. 라이브러리 폴더 선택
2. 상위 분류와 작품 또는 태그 생성
3. 분류 선택
4. 이미지 파일을 창으로 끌어놓기
5. 같은 파일을 다시 놓아 중복 알림 확인
```

설치되지 않은 미래 기능이나 배포 방법은 적지 않는다.

- [ ] **Step 6: 전체 검증을 새로 실행한다**

Run from `app/`:

```powershell
npm test
npm run build
Set-Location src-tauri
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
Set-Location ..
npm run tauri build -- --debug --no-bundle
```

Expected:

```text
Vitest: 0 failed
TypeScript/Vite build: exit 0
cargo fmt: exit 0
Clippy: 0 warnings
cargo test: 0 failed
Tauri debug build: exit 0 and app executable produced
```

- [ ] **Step 7: Windows에서 수동 수용 검사를 수행한다**

```text
1. 빈 폴더를 라이브러리로 선택한다.
2. 게임 → 블루 아카이브 → 아로나를 만든다.
3. 아로나를 선택하고 PNG, JPEG, GIF를 끌어놓는다.
4. 원본 파일이 기존 위치에 남아 있는지 확인한다.
5. 같은 PNG를 다시 놓고 자산 수가 늘지 않는지 확인한다.
6. 게임을 선택하면 세 파일이 보이는지 확인한다.
7. "이 항목만"을 켜면 아로나에만 연결된 파일이 게임 화면에서 빠지는지 확인한다.
8. 이미지를 눌러 큰 보기 Dialog가 열리고 Esc로 닫히는지 확인한다.
```

500개 항목 가상화는 Task 7의 자동 frontend test가 검증한다. 수동 검사 결과는 `app/README.md` 아래가 아니라 커밋 메시지 전 로컬 체크 기록으로 남긴다. 실패하면 원인을 수정하고 Step 6부터 다시 실행한다.

- [ ] **Step 8: 핵심 기반을 커밋한다**

```powershell
Set-Location C:\chatgpt
git add app
git commit -m "feat: complete the local image library foundation"
git status --short
```

Expected: commit succeeds and working tree is clean.

## Plan Completion Gate

이 계획을 완료했다고 말하기 전에 다음 증거가 모두 같은 실행 회차에 있어야 한다.

```powershell
Set-Location C:\chatgpt\app
npm test
npm run build
Set-Location src-tauri
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
Set-Location ..
npm run tauri build -- --debug --no-bundle
Set-Location ..
git status --short
```

통과 후 `2026-07-30-lakomics-implementation-roadmap.md`의 2단계인 라이브러리 안전성과 정리 계획을 작성한다.
