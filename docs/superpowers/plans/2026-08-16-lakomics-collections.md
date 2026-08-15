# Lakomics Collections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 표지와 설명을 가진 컬렉션을 만들고 여러 자산을 소속시켜 기존 Lakomics 갤러리로 감상하는 영속 기능을 구현한다.

**Architecture:** SQLite v10의 `collections`/`collection_assets`를 Rust `library::collection` 모듈이 관리한다. 프런트엔드는 전용 컬렉션 목록과 기존 `AssetBrowser` 기반 상세를 `AssetView`에 통합하고, 선택 도구와 정보 패널에서 다대다 소속을 편집한다.

**Tech Stack:** Rust, rusqlite, Tauri 2 commands, React 19, TypeScript, Vitest, Testing Library, CSS design tokens.

## Global Constraints

- 현재 Lakomics가 기준이고 `whatthe3`는 동작 참고 자료로만 사용한다.
- 컬렉션은 앨범·분류 폴더와 다른 별도 도메인 모델이다.
- 핵심 기능에 mock, placeholder, TODO를 남기지 않는다.
- `DESIGN.md`의 조밀하고 조용한 데스크톱 도구 규칙과 기존 공통 UI를 따른다.
- 사용자 데이터에 destructive migration을 하지 않는다.
- 사용자의 지시에 따라 서브에이전트 없이 이 세션에서 직접 실행한다.

---

### Task 1: Persisted collection domain

**Files:**
- Create: `app/src-tauri/migrations/0010_collections.sql`
- Create: `app/src-tauri/src/library/collection.rs`
- Modify: `app/src-tauri/src/library/db.rs`
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/src/library/error.rs`
- Modify: `app/src-tauri/src/library/mod.rs`

**Interfaces:**
- Produces: `CollectionSummary`, `CreateCollection`, `UpdateCollection`, `AssetCollectionPatch` and `Library::{list,create,update,delete}_collection`, `get_asset_collections`, `patch_asset_collections`, `set_collection_cover`.

- [ ] **Step 1: Write failing migration and domain tests** for v9→v10 data preservation, normalized unique names, metadata limits, CRUD, cover membership, idempotent many-to-many add/remove, and collection deletion without asset deletion.
- [ ] **Step 2: Run `cargo test library::collection library::db -j 1`** and confirm failures are missing schema/types/module behavior.
- [ ] **Step 3: Implement schema and the focused Rust module** using transactions, foreign keys, one aggregate collection list query, and explicit domain errors.
- [ ] **Step 4: Run the focused Rust tests** and confirm they pass.
- [ ] **Step 5: Commit** as `feat: persist asset collections`.

### Task 2: Collection asset queries and lifecycle

**Files:**
- Modify: `app/src-tauri/src/library/query.rs`
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/src/library/similarity.rs`
- Modify: `app/src-tauri/src/library/trash.rs`

**Interfaces:**
- Consumes: `AssetQuery.collection_id: Option<String>` and v10 relation tables.
- Produces: cursor-paginated collection detail queries and lifecycle-safe relations.

- [ ] **Step 1: Write failing tests** showing collection scope returns only normal member assets, combines with favorite/sort filters, rejects simultaneous classification/album/collection scopes, hides trash until restore, cascades on purge, and transfers membership on similarity replacement.
- [ ] **Step 2: Run focused query/trash/similarity tests** and confirm expected failures.
- [ ] **Step 3: Extend the four existing paginated SQL queries** with one collection parameter and add membership transfer to the existing replacement transaction.
- [ ] **Step 4: Run focused tests** and confirm they pass without changing non-collection ordering.
- [ ] **Step 5: Commit** as `feat: query and preserve collection membership`.

### Task 3: Tauri and TypeScript gateway

**Files:**
- Modify: `app/src-tauri/src/commands.rs`
- Modify: `app/src-tauri/src/lib.rs`
- Modify: `app/src/library/types.ts`
- Modify: `app/src/library/client.ts`
- Modify: `app/src/library/errorMessage.ts`
- Test: `app/src/library/client.test.ts`
- Test: `app/src/library/errorMessage.test.ts`

**Interfaces:**
- Produces: typed `LibraryGateway` collection CRUD/membership/cover methods and command names matching Rust handlers.

- [ ] **Step 1: Add failing client and error mapping tests** for every new command and domain error code.
- [ ] **Step 2: Run `npm test -- src/library/client.test.ts src/library/errorMessage.test.ts`** and confirm failures.
- [ ] **Step 3: Add thin Tauri commands, register handlers, and mirror models in TypeScript** without a second state layer.
- [ ] **Step 4: Run the focused tests plus `cargo test commands -j 1`** and confirm they pass.
- [ ] **Step 5: Commit** as `feat: expose collection commands`.

### Task 4: Collection list and management UI

**Files:**
- Create: `app/src/collections/CollectionBrowser.tsx`
- Create: `app/src/collections/CollectionBrowser.test.tsx`
- Create: `app/src/collections/CollectionDialog.tsx`
- Create: `app/src/collections/CollectionDialog.test.tsx`
- Modify: `app/src/library/types.ts`
- Modify: `app/src/app/App.tsx`
- Modify: `app/src/classification/ClassificationSidebar.tsx`
- Modify: `app/src/styles/global.css`
- Test: `app/src/app/App.test.tsx`
- Test: `app/src/classification/ClassificationSidebar.test.tsx`

**Interfaces:**
- Produces: `{kind: "collections"}` and `{kind: "collection", collectionId}` views, collection list refresh, create/edit/delete dialogs, and navigation callbacks.

- [ ] **Step 1: Write failing component tests** for sidebar navigation, zero collections, cover/count rendering, ellipsis-safe long metadata, create validation, edit, delete confirmation, disabled pending actions, retryable load failure, and opening detail.
- [ ] **Step 2: Run the focused Vitest files** and confirm failures are missing components/views.
- [ ] **Step 3: Implement the dense media-first list** with existing `ViewToolbar`, `Dialog`, `TextField`, `Button`, `ContextMenu`, `EmptyState`, `Skeleton`, `Toast`, and media URL helper.
- [ ] **Step 4: Integrate collection refresh and navigation in `App`** and add token-based styles with no ornamental card nesting.
- [ ] **Step 5: Run focused tests** and confirm they pass.
- [ ] **Step 6: Commit** as `feat: add collection management UI`.

### Task 5: Membership and detail browsing

**Files:**
- Modify: `app/src/assets/AssetBrowser.tsx`
- Modify: `app/src/assets/AssetToolbar.tsx`
- Modify: `app/src/assets/AssetInspector.tsx`
- Modify: `app/src/app/App.tsx`
- Modify: `app/src/styles/global.css`
- Test: `app/src/assets/AssetBrowser.test.tsx`
- Test: `app/src/assets/AssetToolbar.test.tsx`
- Test: `app/src/assets/AssetInspector.test.tsx`

**Interfaces:**
- Consumes: collection gateway methods and `AssetView.kind === "collection"`.
- Produces: paginated collection detail, add/remove membership from batch tools and inspector, remove-from-current-collection, and set/unset cover.

- [ ] **Step 1: Write failing tests** for collection-scoped query construction/title/empty state, multi-select add/remove, mixed membership checkboxes, immediate refresh, current collection removal, cover assignment, and failure feedback.
- [ ] **Step 2: Run focused tests** and confirm failures.
- [ ] **Step 3: Extend existing browser/toolbar/inspector props and handlers minimally** so the current gallery/viewer/selection infrastructure is reused unchanged.
- [ ] **Step 4: Run focused tests** and confirm all new and existing asset interaction tests pass.
- [ ] **Step 5: Commit** as `feat: manage collection assets`.

### Task 6: Regression and release verification

**Files:**
- Modify only files required by discovered regressions.

**Interfaces:**
- Produces: a clean, mergeable `codex/collection` branch.

- [ ] **Step 1: Run `npm.cmd run check`** and fix only collection-caused type, unit, or production-build failures.
- [ ] **Step 2: Run `cargo test --all-targets -j 1`** and fix collection-caused failures.
- [ ] **Step 3: Run `npm.cmd run tauri build`** and confirm the desktop bundle compiles with schema v10.
- [ ] **Step 4: Inspect `git diff --check`, `git status`, and commit history**; remove accidental generated or unrelated files.
- [ ] **Step 5: Merge `codex/collection` into `main` without rewriting user history**, rerun representative checks on main, and report only verified outcomes and real limitations.
