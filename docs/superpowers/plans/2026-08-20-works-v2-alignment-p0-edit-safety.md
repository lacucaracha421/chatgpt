# Works v2 Alignment and Collection Edit Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store the Works v2 handoff and visual reference in the repository, align the authoritative docs, and prevent ordinary Collection edits from erasing imported/provider metadata.

**Architecture:** The Library Module owns the preservation invariant: its ordinary `UpdateCollection` Interface exposes only fields owned by the edit dialog, and its SQL never writes imported/provider columns. The frontend sends the same narrow shape. The handoff and standalone prototype remain documentation references and are not wired into production React.

**Tech Stack:** Markdown/HTML documentation, React 19, TypeScript, Testing Library/Vitest, Rust, serde, rusqlite, Tauri 2.

## Global Constraints

- Follow `AGENTS.md`, `DESIGN.md`, `CONTEXT.md`, and `docs/agents/implementation.md`.
- Preserve the dense Windows desktop design language; this patch adds no production UI.
- Copy the handoff and prototype verbatim from `C:\Users\namwoojun\Desktop\lakomics-codex-works-v2-package`.
- Do not copy the prototype DOM/CSS/JS into production React.
- Do not implement multiple provider bindings, provider network clients, WorkArtwork, Volume, Release Watch, Showcase behavior, or new Works screens in this plan.
- Do not change the current meaning or validation of the user-editable Collection fields.
- Do not stage or modify pre-existing untracked files outside the paths named by this plan.
- Use `apply_patch` for repository file edits.

---

### Task 1: Store and align the Works v2 documentation

**Files:**
- Create: `docs/agents/lakomics-works-handoff-v2.md`
- Create: `docs/prototypes/lakomics-works-v6-reference.html`
- Modify: `AGENTS.md`
- Modify: `DESIGN.md`
- Modify: `CONTEXT.md`

**Interfaces:**
- Consumes: package handoff SHA-256 `2C9274FAE23130023F892273B15332D5B782C515D83AF59A198DEEAFF0BB5E86`; prototype SHA-256 `7F455DBF778A5476B12808F00AC1A590E3DB3E32BD82F062B73FE9658C33B59B`.
- Produces: repository-local handoff/reference paths named by `AGENTS.md` and the updated Showcase/Metadata Source glossary definitions.

- [ ] **Step 1: Add the two reference files exactly**

Use `apply_patch` to add the exact contents of:

```text
C:\Users\namwoojun\Desktop\lakomics-codex-works-v2-package\docs\agents\lakomics-works-handoff-v2.md
  -> docs/agents/lakomics-works-handoff-v2.md
C:\Users\namwoojun\Desktop\lakomics-codex-works-v2-package\docs\prototypes\lakomics-works-v6-reference.html
  -> docs/prototypes/lakomics-works-v6-reference.html
```

Do not add `README-CODEX.md`, `COPY-INTO-REPO.ps1.txt`, or `codex-docs-alignment.patch`.

- [ ] **Step 2: Add the Works/Collection entry point to AGENTS.md**

Append this section after `### Visual design`:

```markdown
### Works / Collection v2

Works/Collection 기능을 수정하기 전에는
`docs/agents/lakomics-works-handoff-v2.md`를 읽으세요.
시각/상호작용 기준은
`docs/prototypes/lakomics-works-v6-reference.html`을 함께 참고하세요.
프로토타입 코드를 그대로 복사하지 말고 기존 React 구조, 공통 UI, 디자인 토큰에 맞게
시각적 의도와 상호작용만 구현합니다.
Works/Collection에 한해 handoff v2의 최신 결정은 `CONTEXT.md`의 구형 Showcase /
단일 provider 설명보다 우선합니다.
```

- [ ] **Step 3: Add the narrow collectible-motion exception to DESIGN.md**

Insert after the existing `## Motion` paragraphs:

```markdown
### Works collectible interaction exception

Works의 만화 표지 감상 뷰어와 게임 패키지 전시는 일반 UI motion 규칙의 제한적 예외다.
실제 수집품을 집어 들거나 살펴보는 의미를 전달할 때만 작은 translate/scale/3D transform과
접지·부유 shadow를 사용할 수 있다.

- 일반 버튼, toolbar, settings row, 일반 card, Asset tile에는 이 예외를 적용하지 않는다.
- 기본 browsing 상태에서는 효과를 없애거나 매우 약하게 유지한다.
- 큰 bounce/spring, 큰 각도 회전, 강한 holo/glare, 상시 animation은 금지한다.
- 권장 motion 시간은 기존 80~160ms 범위를 우선한다.
- game package는 정면 cover밖에 없는 경우가 많으므로 옆/뒤 빈 면이 드러날 정도로 회전하지 않는다.
- Manga volume cover click의 기본 목적은 metadata dialog가 아니라 cover appreciation이다.

이 예외의 현재 시각 기준은
`docs/prototypes/lakomics-works-v6-reference.html`이며 production 구현은 기존 token/component를 사용한다.
```

- [ ] **Step 4: Replace the two stale glossary clauses in CONTEXT.md**

Use these exact definitions:

```markdown
**쇼케이스 (Showcase)**:
사용자가 특히 좋아하는 컬렉션을 게임·만화·영화 유형별로 직접 선별하고 순서를 정해 감상하는 별도 전시 보기다. 순위 기능이 아니며 일반 Works 필터와 분리한다.
_Avoid_: 자동 즐겨찾기 그리드, 전체 타입 혼합 보기, 순위표

**메타데이터 출처 (Metadata Source)**:
외부 메타데이터를 가져온 서비스 연결이다. SteamDB, IGDB, 알라딘, MangaDex, TMDB 등이 있으며 한 컬렉션은 목적이 다른 여러 출처와 외부 ID를 동시에 연결할 수 있다. 예를 들어 만화는 MangaDex 작품 정보와 알라딘 한국 정발 정보를 함께 사용할 수 있다.
_Avoid_: 다운로드 경로, 파일 형식
```

- [ ] **Step 5: Verify documentation fidelity and references**

Run from `C:\chatgpt`:

```powershell
Get-FileHash -Algorithm SHA256 `
  .\docs\agents\lakomics-works-handoff-v2.md, `
  .\docs\prototypes\lakomics-works-v6-reference.html
rg -n "lakomics-works-handoff-v2|lakomics-works-v6-reference" AGENTS.md DESIGN.md
rg -n "쇼케이스 \(Showcase\)|메타데이터 출처 \(Metadata Source\)" CONTEXT.md
git diff --check
```

Expected: hashes exactly match the two values in **Interfaces**, all four references/definitions are found, and `git diff --check` exits 0.

- [ ] **Step 6: Commit the documentation alignment**

```powershell
git add -- AGENTS.md DESIGN.md CONTEXT.md docs/agents/lakomics-works-handoff-v2.md docs/prototypes/lakomics-works-v6-reference.html
git commit -m "Document Works v2 product direction"
```

### Task 2: Make the Library Module preserve imported Collection metadata

**Files:**
- Modify: `app/src-tauri/src/library/collection.rs`
- Modify: `app/src-tauri/src/library/models.rs`

**Interfaces:**
- Consumes: `Library::update_collection(id: &str, request: UpdateCollection) -> Result<CollectionSummary, LibraryError>`.
- Produces: a narrower Rust `UpdateCollection` containing `name`, `description`, `collection_type`, `year`, `author`, `director`, `external_score`, and `my_score`; imported/provider columns are preservation-only through this Interface.

- [ ] **Step 1: Write the backend regression test in its initially failing form**

Add this test to `library/collection.rs`. In the initial RED version, retain the currently required `genres`, `overview`, `external_id`, and `external_source` request fields as `None` so the test compiles against the old Interface:

```rust
#[test]
fn ordinary_edit_preserves_imported_metadata_and_provider_identity() {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    let created = create(&library, "Imported Work");

    library.connection().unwrap().execute(
        "UPDATE collections
         SET year = 2024, author = 'Imported Author', genres = 'Fantasy',
             overview = 'Imported overview', external_id = 'provider-42',
             external_source = 'mangadex', external_synced_at = '2026-08-20T01:02:03Z',
             external_metadata_json = '{\"title\":\"Provider title\"}'
         WHERE id = ?1",
        [&created.id],
    ).unwrap();

    let updated = library.update_collection(
        &created.id,
        UpdateCollection {
            name: "Renamed Work".into(),
            description: None,
            collection_type: CollectionType::Manga,
            year: Some(2024),
            author: Some("Imported Author".into()),
            director: None,
            external_score: None,
            my_score: Some(9),
            genres: None,
            overview: None,
            external_id: None,
            external_source: None,
        },
    ).unwrap();

    assert_eq!(updated.name, "Renamed Work");
    assert_eq!(updated.my_score, Some(9));
    assert_eq!(updated.year, Some(2024));
    assert_eq!(updated.author.as_deref(), Some("Imported Author"));
    assert_eq!(updated.genres.as_deref(), Some("Fantasy"));
    assert_eq!(updated.overview.as_deref(), Some("Imported overview"));
    assert_eq!(updated.external_id.as_deref(), Some("provider-42"));
    assert_eq!(updated.external_source.as_deref(), Some("mangadex"));
    assert_eq!(updated.external_synced_at.as_deref(), Some("2026-08-20T01:02:03Z"));
    assert_eq!(
        library.connection().unwrap().query_row(
            "SELECT external_metadata_json FROM collections WHERE id = ?1",
            [&created.id],
            |row| row.get::<_, String>(0),
        ).unwrap(),
        "{\"title\":\"Provider title\"}",
    );
}
```

- [ ] **Step 2: Run the focused test and observe RED**

Run:

```powershell
cargo test library::collection::tests::ordinary_edit_preserves_imported_metadata_and_provider_identity -- --exact
```

Working directory: `C:\chatgpt\app\src-tauri`.

Expected: FAIL because the current update SQL replaces genres, overview, external ID, and external source with `NULL`.

- [ ] **Step 3: Narrow the Rust request model**

Change `UpdateCollection` in `library/models.rs` to exactly:

```rust
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCollection {
    pub name: String,
    pub description: Option<String>,
    #[serde(rename = "type")]
    pub collection_type: CollectionType,
    pub year: Option<i64>,
    pub author: Option<String>,
    pub director: Option<String>,
    pub external_score: Option<i64>,
    pub my_score: Option<i64>,
}
```

Remove the four obsolete fields from every Rust `UpdateCollection` initializer. In the new regression test, delete the initial RED-only `genres`, `overview`, `external_id`, and `external_source` lines.

- [ ] **Step 4: Make the SQL update only owned fields**

Replace the update statement and params in `library/collection.rs` with:

```rust
"UPDATE collections
 SET name = ?1, description = ?2, type = ?3,
     year = ?4, author = ?5, director = ?6,
     external_score = ?7, my_score = ?8,
     updated_at = ?9
 WHERE id = ?10"
```

```rust
params![
    name,
    description,
    type_str,
    request.year,
    request.author,
    request.director,
    request.external_score,
    request.my_score,
    chrono::Utc::now().to_rfc3339(),
    id,
]
```

- [ ] **Step 5: Run focused and module tests and observe GREEN**

Run from `app/src-tauri`:

```powershell
cargo test library::collection::tests::ordinary_edit_preserves_imported_metadata_and_provider_identity -- --exact
cargo test library::collection::tests
```

Expected: both commands exit 0; the focused regression proves every imported/provider field remains present.

- [ ] **Step 6: Commit the backend preservation invariant**

```powershell
git add -- app/src-tauri/src/library/collection.rs app/src-tauri/src/library/models.rs
git commit -m "Preserve imported metadata on collection edits"
```

### Task 3: Narrow the frontend Collection edit payload

**Files:**
- Create: `app/src/collections/CollectionEditDialog.test.tsx`
- Modify: `app/src/collections/CollectionEditDialog.tsx`
- Modify: `app/src/library/types.ts`

**Interfaces:**
- Consumes: `CollectionSummary` with both editable and imported/provider fields.
- Produces: TypeScript `UpdateCollection` matching the narrowed Rust request and `CollectionEditDialog.onSubmit(input)` that never sends imported/provider fields.

- [ ] **Step 1: Write the failing dialog payload test**

Create `CollectionEditDialog.test.tsx`:

```tsx
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { CollectionSummary, CreateCollection, UpdateCollection } from "../library/types";
import { CollectionEditDialog } from "./CollectionEditDialog";

afterEach(cleanup);

it("submits only fields owned by ordinary collection editing", async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn(async (_input: CreateCollection | UpdateCollection) => undefined);
  const collection: CollectionSummary = {
    id: "work-1", name: "Provider title", description: "description", type: "manga",
    coverAssetId: null, assetCount: 0, year: 2024, author: "Imported Author",
    director: null, externalScore: 91, myScore: null, genres: "Fantasy",
    overview: "Imported overview", externalId: "provider-42", externalSource: "mangadex",
    externalSyncedAt: "2026-08-20T01:02:03Z", showcase: false,
    createdAt: "2026-08-20T00:00:00Z", updatedAt: "2026-08-20T00:00:00Z",
  };

  render(
    <CollectionEditDialog
      open
      mode={{ kind: "edit", collection }}
      onClose={vi.fn()}
      onSubmit={onSubmit}
    />,
  );

  const name = screen.getByRole("textbox", { name: "이름" });
  await user.clear(name);
  await user.type(name, "Renamed Work");
  await user.click(screen.getByRole("button", { name: "저장" }));

  expect(onSubmit).toHaveBeenCalledWith({
    name: "Renamed Work",
    description: "description",
    type: "manga",
    year: 2024,
    author: "Imported Author",
    director: null,
    externalScore: 91,
    myScore: null,
  });
});
```

- [ ] **Step 2: Run the focused frontend test and observe RED**

Run from `app`:

```powershell
npx vitest run src/collections/CollectionEditDialog.test.tsx
```

Expected: FAIL because the current dialog also submits `genres: null` and `overview: null`.

- [ ] **Step 3: Narrow the TypeScript Interface and dialog payload**

Define `UpdateCollection` in `library/types.ts` as:

```ts
export type UpdateCollection = {
  name: string;
  description: string | null;
  type: CollectionType;
  year: number | null;
  author: string | null;
  director: string | null;
  externalScore: number | null;
  myScore: number | null;
};
```

In `CollectionEditDialog.handleSubmit`, keep the existing normalization but remove:

```ts
genres: null,
overview: null,
```

- [ ] **Step 4: Run focused tests and type checking and observe GREEN**

Run from `app`:

```powershell
npx vitest run src/collections/CollectionEditDialog.test.tsx src/collections/CollectionBrowser.test.tsx
npx tsc --noEmit
```

Expected: both commands exit 0 and the payload test passes.

- [ ] **Step 5: Run complete verification**

Run from `app/src-tauri`:

```powershell
cargo test
```

Run from `app`:

```powershell
npx tsc --noEmit
npx vitest run --reporter=dot
```

Run from repository root:

```powershell
git diff --check
git status --short
```

Expected: all non-ignored Rust tests pass, TypeScript exits 0, all Vitest files pass, `git diff --check` exits 0, and status contains only this task's three tracked changes plus the pre-existing untracked paths.

- [ ] **Step 6: Commit the frontend Interface and regression test**

```powershell
git add -- app/src/collections/CollectionEditDialog.test.tsx app/src/collections/CollectionEditDialog.tsx app/src/library/types.ts
git commit -m "Narrow collection edit payload"
```

### Task 4: Completion audit

**Files:**
- Verify: all files named by Tasks 1–3
- Verify: `docs/superpowers/specs/2026-08-20-works-v2-alignment-p0-edit-safety-design.md`

**Interfaces:**
- Consumes: the three task commits and their verification output.
- Produces: evidence that every design requirement is implemented without expanding into P1 or UI work.

- [ ] **Step 1: Audit each explicit requirement**

Run from repository root:

```powershell
rg -n "Works / Collection v2|Works collectible interaction exception" AGENTS.md DESIGN.md
rg -n -A 2 "쇼케이스 \(Showcase\)|메타데이터 출처 \(Metadata Source\)" CONTEXT.md
rg -n "genres: null|overview: null" app/src/collections/CollectionEditDialog.tsx
rg -n "external_id =|external_source =|genres =|overview =" app/src-tauri/src/library/collection.rs
git log -4 --oneline --decorate
git status --short
```

Expected:

- the two documentation entry points are found;
- the two glossary definitions match handoff v2;
- the frontend stale-null search returns no matches;
- the backend search finds test fixture setup only, not the ordinary update SQL;
- commits are present and only pre-existing untracked paths remain.

- [ ] **Step 2: Compare package reference hashes again**

```powershell
Get-FileHash -Algorithm SHA256 `
  .\docs\agents\lakomics-works-handoff-v2.md, `
  .\docs\prototypes\lakomics-works-v6-reference.html
```

Expected: hashes remain `2C9274FAE23130023F892273B15332D5B782C515D83AF59A198DEEAFF0BB5E86` and `7F455DBF778A5476B12808F00AC1A590E3DB3E32BD82F062B73FE9658C33B59B` respectively.

- [ ] **Step 3: Confirm no implementation scope leaked into P1+**

```powershell
git diff a73041b..HEAD --name-only
```

Expected: only the documentation and P0 files named in Tasks 1–3 appear; there are no migrations, provider clients, artwork cache modules, Volume models, Showcase behavior changes, or new Works production UI files.
