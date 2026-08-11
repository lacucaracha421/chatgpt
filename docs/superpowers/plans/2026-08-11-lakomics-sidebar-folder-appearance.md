# Lakomics Sidebar Folder Appearance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not dispatch subagents; the user requested inline execution.

**Goal:** Make the classification sidebar match the approved compact folder-tree design, with persistent per-folder icons and colors, colored hierarchy connectors, and right-click-only actions.

**Architecture:** Add two nullable appearance keys to `classification_entries`, validate updates in the Rust library boundary, and expose one Tauri command through the existing `LibraryGateway`. Keep the 24-icon/12-color presentation catalog in one focused React module, render the picker in a separate dialog component, and let `ClassificationSidebar` remain the coordinator for tree actions and refreshes.

**Tech Stack:** Rust, rusqlite, SQLite migrations, Tauri 2 commands, React 19, TypeScript, Radix UI, Heroicons, Vitest, Testing Library, CSS custom properties.

## Global Constraints

- Preserve all creation, rename, move, delete, asset-drop, selection, and expansion behavior from `docs/superpowers/specs/2026-08-11-lakomics-sidebar-folder-ux-design.md`.
- Store only allowlisted icon and color keys; do not accept SVG uploads, arbitrary CSS colors, or HEX input.
- Use exactly 24 existing `@heroicons/react/24/outline` icons and 12 fixed colors; add no dependency.
- Apply folder color only to the icon and descendant connector line, never to the label or row background.
- New folders do not inherit their parent's appearance.
- Keep quick views unchanged and count only top-level folders in `폴더 (N)`.
- Remove the `…` action button; preserve right-click and keyboard context-menu access.
- Do not change extension integration or operating-system asset paths.
- Do not modify or stage user-owned `manual-skill-commands.txt`, shortcut files, or unrelated worktree changes.
- If execution reveals a safer approach, a materially better UX, or a new risk, pause before changing code and ask the user which path to take.
- Use TDD for every behavior change and commit each task independently.
- Run `cargo` commands from `C:\chatgpt\app\src-tauri`, `npm.cmd` commands from `C:\chatgpt\app`, and `git` commands from `C:\chatgpt`.

---

### Task 1: Migrate and read classification appearance

**Files:**
- Create: `app/src-tauri/migrations/0007_classification_appearance.sql`
- Modify: `app/src-tauri/src/library/db.rs`
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/src/library/classification.rs`
- Modify: `app/src-tauri/src/library/backup.rs`
- Modify: `app/src-tauri/src/library/query.rs`
- Modify: `app/src-tauri/src/extension_api.rs`

**Interfaces:**
- Produces: `ClassificationEntry { icon_key: Option<String>, color_key: Option<String> }` serialized as `iconKey` and `colorKey`.
- Produces: schema version `7` with nullable `classification_entries.icon_key` and `classification_entries.color_key`.
- Consumes: existing schema version 6 and all existing classification queries.

- [ ] **Step 1: Write a failing v6-to-v7 migration test**

Add a `#[cfg(test)]` module to `db.rs` that builds a version-6 in-memory database, inserts one existing folder, migrates it, and verifies nullable appearance columns:

```rust
#[test]
fn migrates_existing_classifications_to_nullable_appearance() {
    let mut connection = Connection::open_in_memory().unwrap();
    for schema in [
        INITIAL_SCHEMA,
        VAULT_SAFETY_SCHEMA,
        SIMILARITY_REVIEW_SCHEMA,
        VIDEO_MEDIA_SCHEMA,
        MANGA_SCHEMA,
        MANGA_MODIFIED_SCHEMA,
    ] {
        connection.execute_batch(schema).unwrap();
    }
    connection.execute(
        "INSERT INTO classification_entries (id, kind, name, parent_id, created_at)
         VALUES ('folder-1', 'root', 'Games', NULL, '2026-08-11T00:00:00Z')",
        [],
    ).unwrap();

    migrate_to_latest(&mut connection, 6).unwrap();

    let appearance = connection.query_row(
        "SELECT icon_key, color_key FROM classification_entries WHERE id = 'folder-1'",
        [],
        |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?)),
    ).unwrap();
    assert_eq!(appearance, (None, None));
    assert_eq!(connection.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0)).unwrap(), 7);
}
```

- [ ] **Step 2: Run the migration test and verify RED**

Run: `cargo test library::db::tests::migrates_existing_classifications_to_nullable_appearance -- --exact`

Expected: FAIL because schema version 7 and the two columns do not exist.

- [ ] **Step 3: Add migration 0007 and register it**

Create `0007_classification_appearance.sql`:

```sql
ALTER TABLE classification_entries ADD COLUMN icon_key TEXT;
ALTER TABLE classification_entries ADD COLUMN color_key TEXT;
PRAGMA user_version = 7;
```

In `db.rs`, set `SCHEMA_VERSION` to `7`, include the new SQL, allow migration from `0..=6`, and execute it when `version <= 6`.

- [ ] **Step 4: Extend the Rust model and every classification SELECT**

Add the fields:

```rust
pub struct ClassificationEntry {
    pub id: String,
    pub kind: ClassificationKind,
    pub name: String,
    pub parent_id: Option<String>,
    pub icon_key: Option<String>,
    pub color_key: Option<String>,
}
```

Set both to `None` for newly created entries. Change every SQL read in `classification.rs` from four columns to:

```sql
SELECT id, kind, name, parent_id, icon_key, color_key
```

Update `entry_from_values` to accept `(String, String, String, Option<String>, Option<String>, Option<String>)`. Add `icon_key: None, color_key: None` to the struct literals in `models.rs`, `query.rs`, and `extension_api.rs`. In the backup test that currently treats schema 7 as unsupported, use schema 8 so it continues testing a version newer than `SCHEMA_VERSION`.

- [ ] **Step 5: Verify schema and Rust model GREEN**

Run: `cargo test library::db::tests::migrates_existing_classifications_to_nullable_appearance -- --exact`

Expected: PASS.

Run: `cargo test library::classification`

Expected: all classification tests PASS.

- [ ] **Step 6: Commit Task 1**

```powershell
git add -- app/src-tauri/migrations/0007_classification_appearance.sql app/src-tauri/src/library/db.rs app/src-tauri/src/library/models.rs app/src-tauri/src/library/classification.rs app/src-tauri/src/library/backup.rs app/src-tauri/src/library/query.rs app/src-tauri/src/extension_api.rs
git commit -m "feat: store classification appearance"
```

Before committing, inspect `git diff --cached --name-only` and unstage any unrelated file.

---

### Task 2: Validate and update appearance through Tauri

**Files:**
- Modify: `app/src-tauri/src/library/error.rs`
- Modify: `app/src-tauri/src/library/classification.rs`
- Modify: `app/src-tauri/src/commands.rs`
- Modify: `app/src-tauri/src/lib.rs`

**Interfaces:**
- Produces: `Library::update_classification_appearance(&self, id: &str, icon_key: Option<&str>, color_key: Option<&str>) -> Result<(), LibraryError>`.
- Produces: Tauri command `update_classification_appearance(id: String, icon_key: Option<String>, color_key: Option<String>, state: State<AppState>)`.
- Produces: stable error code `invalid_classification_appearance` for keys outside the allowlists.

- [ ] **Step 1: Write failing library tests for save, reset, rejection, and missing ID**

Add focused tests to `classification.rs` using the existing classification fixture:

```rust
#[test]
fn classification_appearance_updates_and_resets() {
    let fixture = fixture();
    fixture.library.update_classification_appearance(
        &fixture.child_tag.id,
        Some("photo"),
        Some("pink"),
    ).unwrap();
    let changed = fixture.library.list_classifications().unwrap()
        .into_iter().find(|entry| entry.id == fixture.child_tag.id).unwrap();
    assert_eq!(changed.icon_key.as_deref(), Some("photo"));
    assert_eq!(changed.color_key.as_deref(), Some("pink"));

    fixture.library.update_classification_appearance(
        &fixture.child_tag.id,
        None,
        None,
    ).unwrap();
    let reset = fixture.library.list_classifications().unwrap()
        .into_iter().find(|entry| entry.id == fixture.child_tag.id).unwrap();
    assert_eq!((reset.icon_key, reset.color_key), (None, None));
}

#[test]
fn classification_appearance_rejects_unknown_keys_without_changing_it() {
    let fixture = fixture();
    assert!(matches!(
        fixture.library.update_classification_appearance(
            &fixture.child_tag.id,
            Some("uploaded-svg"),
            Some("#ffffff"),
        ),
        Err(LibraryError::InvalidClassificationAppearance)
    ));
    let entry = fixture.library.list_classifications().unwrap()
        .into_iter().find(|entry| entry.id == fixture.child_tag.id).unwrap();
    assert_eq!((entry.icon_key, entry.color_key), (None, None));
}
```

Add the missing-ID assertion:

```rust
assert!(matches!(
    fixture.library.update_classification_appearance(
        "missing-folder",
        Some("folder"),
        Some("blue"),
    ),
    Err(LibraryError::ClassificationNotFound)
));
```

- [ ] **Step 2: Run the new library tests and verify RED**

Run: `cargo test classification_appearance`

Expected: FAIL because the method and error variant do not exist.

- [ ] **Step 3: Implement exact allowlists and one UPDATE**

Use these exact keys:

```rust
const CLASSIFICATION_ICON_KEYS: [&str; 24] = [
    "folder", "photo", "film", "music", "book", "star", "heart", "user",
    "users", "academic-cap", "briefcase", "home", "globe", "map", "calendar",
    "clock", "bookmark", "tag", "sparkles", "bolt", "fire", "trophy", "puzzle", "cube",
];
const CLASSIFICATION_COLOR_KEYS: [&str; 12] = [
    "red", "orange", "amber", "yellow", "lime", "green",
    "teal", "cyan", "blue", "indigo", "purple", "pink",
];
```

Reject any non-null value outside its list, then execute:

```sql
UPDATE classification_entries
SET icon_key = ?1, color_key = ?2
WHERE id = ?3
```

Return `ClassificationNotFound` when the affected-row count is zero.

- [ ] **Step 4: Expose and register the command**

Map `InvalidClassificationAppearance` in `commands.rs` to code `invalid_classification_appearance` and Korean message `지원하지 않는 폴더 아이콘 또는 색상입니다.`. Add the command beside rename/move and register it in `tauri::generate_handler!`.

- [ ] **Step 5: Verify Task 2 GREEN**

Run: `cargo test library::classification`

Expected: all classification tests PASS.

Run: `cargo test commands::tests`

Expected: command error mapping tests PASS.

- [ ] **Step 6: Commit Task 2**

```powershell
git add -- app/src-tauri/src/library/error.rs app/src-tauri/src/library/classification.rs app/src-tauri/src/commands.rs app/src-tauri/src/lib.rs
git commit -m "feat: update classification appearance"
```

---

### Task 3: Add the frontend contract and appearance catalog

**Files:**
- Create: `app/src/classification/classificationAppearance.tsx`
- Create: `app/src/classification/classificationAppearance.test.tsx`
- Modify: `app/src/library/types.ts`
- Modify: `app/src/library/client.ts`
- Modify: `app/src/library/client.test.ts`
- Modify: `app/src/app/App.test.tsx`
- Modify: `app/src/assets/AssetBrowser.test.tsx`
- Modify: `app/src/classification/ClassificationSidebar.test.tsx`
- Modify: `app/src/library/LibrarySetup.test.tsx`
- Modify: `app/src/manga/MangaBrowser.test.tsx`
- Modify: `app/src/safety/TrashBrowser.test.tsx`
- Modify: `app/src/settings/SettingsView.test.tsx`
- Modify: `app/src/similarity/SimilarityReviewBrowser.test.tsx`

**Interfaces:**
- Produces: `ClassificationEntry.iconKey: string | null` and `colorKey: string | null`.
- Produces: `LibraryGateway.updateClassificationAppearance(id, iconKey, colorKey): Promise<void>`.
- Produces from `classificationAppearance.tsx`: `CLASSIFICATION_ICONS`, `CLASSIFICATION_COLORS`, `classificationColor`, and `ClassificationIcon`.

- [ ] **Step 1: Write failing client and catalog tests**

In `client.test.ts`, assert the exact command payload:

```ts
await libraryGateway.updateClassificationAppearance("folder-1", "photo", "pink");
expect(invoke).toHaveBeenCalledWith("update_classification_appearance", {
  id: "folder-1",
  iconKey: "photo",
  colorKey: "pink",
});
```

In the new catalog test, assert 24 unique icon keys, 12 unique color keys, exact fallback behavior, and `work`'s default book icon:

```tsx
expect(new Set(CLASSIFICATION_ICONS.map(({ key }) => key)).size).toBe(24);
expect(new Set(CLASSIFICATION_COLORS.map(({ key }) => key)).size).toBe(12);
render(<ClassificationIcon kind="work" iconKey={null} />);
expect(screen.getByTestId("classification-icon")).toHaveAttribute("data-icon-key", "book");
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm.cmd test -- src/library/client.test.ts src/classification/classificationAppearance.test.tsx`

Expected: FAIL because the gateway method and catalog module do not exist.

- [ ] **Step 3: Extend frontend types and gateway**

Add nullable fields to `ClassificationEntry` and the gateway method:

```ts
updateClassificationAppearance(
  id: string,
  iconKey: string | null,
  colorKey: string | null,
): Promise<void>;
```

Implement the Tauri invoke with camelCase payload. Add `updateClassificationAppearance: vi.fn().mockResolvedValue(undefined)` to every typed test gateway fixture returned by the `rg` command.

- [ ] **Step 4: Implement the single catalog module**

Map the approved 24 keys to the matching Heroicons. Export the approved 12 colors with exact hex values:

```ts
export const CLASSIFICATION_COLORS = [
  { key: "red", value: "#ef6b73", label: "빨강" },
  { key: "orange", value: "#f28c52", label: "주황" },
  { key: "amber", value: "#dba84b", label: "호박" },
  { key: "yellow", value: "#c9b94d", label: "노랑" },
  { key: "lime", value: "#8fbd52", label: "연두" },
  { key: "green", value: "#58b67a", label: "초록" },
  { key: "teal", value: "#47b6a7", label: "청록" },
  { key: "cyan", value: "#4fabc9", label: "하늘" },
  { key: "blue", value: "#5b8def", label: "파랑" },
  { key: "indigo", value: "#7c7ee8", label: "남색" },
  { key: "purple", value: "#aa75df", label: "보라" },
  { key: "pink", value: "#df6fa7", label: "분홍" },
] as const;
```

`classificationColor(null)` and unknown keys return `var(--color-muted)`. `ClassificationIcon` falls back to `book` for `work` and `folder` for every other kind, and exposes `data-icon-key` for stable tests.

- [ ] **Step 5: Verify Task 3 GREEN**

Run: `npm.cmd test -- src/library/client.test.ts src/classification/classificationAppearance.test.tsx`

Expected: both test files PASS.

Run: `npm.cmd run build`

Expected: TypeScript and Vite build PASS, proving every gateway fixture and entry literal was updated.

- [ ] **Step 6: Commit Task 3**

```powershell
git add -- app/src/classification/classificationAppearance.tsx app/src/classification/classificationAppearance.test.tsx app/src/library/types.ts app/src/library/client.ts app/src/library/client.test.ts app/src/app/App.test.tsx app/src/assets/AssetBrowser.test.tsx app/src/classification/ClassificationSidebar.test.tsx app/src/library/LibrarySetup.test.tsx app/src/manga/MangaBrowser.test.tsx app/src/safety/TrashBrowser.test.tsx app/src/settings/SettingsView.test.tsx app/src/similarity/SimilarityReviewBrowser.test.tsx
git commit -m "feat: add classification appearance catalog"
```

Inspect the staged file list before committing and exclude unrelated files.

---

### Task 4: Build the appearance picker dialog

**Files:**
- Create: `app/src/classification/ClassificationAppearanceDialog.tsx`
- Create: `app/src/classification/ClassificationAppearanceDialog.test.tsx`
- Modify: `app/src/styles/global.css`

**Interfaces:**
- Consumes: `ClassificationEntry`, `LibraryGateway.updateClassificationAppearance`, `CLASSIFICATION_ICONS`, `CLASSIFICATION_COLORS`, `ClassificationIcon`, shared `Dialog`, `Button`, and `commandErrorMessage`.
- Produces: `ClassificationAppearanceDialog({ entry, onClose, onSaved })`, where `entry: ClassificationEntry | null` and callbacks return `void`.

- [ ] **Step 1: Write failing dialog behavior tests**

Cover current selection, preview, save, reset, cancel, and rejected save. Use a real `LibraryProvider` with only the gateway boundary stubbed. The save assertion must be:

```ts
await user.click(screen.getByRole("radio", { name: "사진" }));
await user.click(screen.getByRole("radio", { name: "분홍" }));
await user.click(screen.getByRole("button", { name: "저장" }));
await waitFor(() => expect(gateway.updateClassificationAppearance)
  .toHaveBeenCalledWith("folder-1", "photo", "pink"));
expect(onSaved).toHaveBeenCalledOnce();
```

The reset test must prove that reset changes only the draft until save:

```ts
await user.click(screen.getByRole("button", { name: "기본값으로 초기화" }));
expect(gateway.updateClassificationAppearance).not.toHaveBeenCalled();
await user.click(screen.getByRole("button", { name: "저장" }));
await waitFor(() => expect(gateway.updateClassificationAppearance)
  .toHaveBeenCalledWith("folder-1", null, null));
```

Add a cancel test that clicks reset and then cancel, asserting no gateway call. For a rejected save promise, assert the dialog remains visible and displays `폴더 모양을 저장하지 못했습니다.`.

- [ ] **Step 2: Run the dialog tests and verify RED**

Run: `npm.cmd test -- src/classification/ClassificationAppearanceDialog.test.tsx`

Expected: FAIL because the dialog component does not exist.

- [ ] **Step 3: Implement the focused dialog component**

Use local `iconKey`, `colorKey`, `saving`, and `error` state reset from `entry` whenever it changes. Render:

- title `아이콘 및 색상`
- preview containing `ClassificationIcon` and the folder name
- 24 native radio buttons labelled with icon names
- 12 native radio buttons labelled with color names
- `기본값으로 초기화`, `취소`, and `저장` buttons

Disable all mutation buttons while saving. Keep the dialog open on error. Call `onSaved` only after the gateway promise resolves.

- [ ] **Step 4: Add compact picker styles**

Add `.classification-appearance` styles to `global.css`: a six-column icon grid, six-column color grid, 28px square controls, visible `:focus-visible`, `aria-checked` selection ring, circular color swatches, and a preview row. Use existing spacing, border, focus, surface, and radius tokens.

- [ ] **Step 5: Verify Task 4 GREEN**

Run: `npm.cmd test -- src/classification/ClassificationAppearanceDialog.test.tsx`

Expected: all dialog tests PASS.

Run: `npm.cmd run build`

Expected: build PASS.

- [ ] **Step 6: Commit Task 4**

```powershell
git add -- app/src/classification/ClassificationAppearanceDialog.tsx app/src/classification/ClassificationAppearanceDialog.test.tsx app/src/styles/global.css
git commit -m "feat: add folder appearance picker"
```

---

### Task 5: Integrate the compact colored folder tree

**Files:**
- Modify: `app/src/classification/ClassificationSidebar.tsx`
- Modify: `app/src/classification/ClassificationSidebar.test.tsx`
- Modify: `app/src/styles/global.css`
- Modify: `app/src/styles/tokens.css`

**Interfaces:**
- Consumes: `ClassificationAppearanceDialog`, `ClassificationIcon`, and `classificationColor`.
- Preserves: every existing `ClassificationSidebar` prop and mutation callback.
- Produces: right-click action `아이콘 및 색상…`, `폴더 (N)` heading, colored icon and connector CSS variable `--classification-branch-color`.

- [ ] **Step 1: Rewrite sidebar expectations first and verify RED**

Update ellipsis-based tests to open rows with `fireEvent.contextMenu`. Add tests that assert:

```ts
expect(screen.getByText("폴더 (2)")).toBeVisible();
expect(screen.queryByRole("button", { name: /추가 작업/ })).not.toBeInTheDocument();

fireEvent.contextMenu(screen.getByRole("treeitem", { name: "Games" }));
expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
  "하위 폴더 만들기",
  "이름 변경",
  "아이콘 및 색상…",
  "이동 — 최상위 폴더",
  "삭제 — 하위 폴더 있음",
]);
```

Add a custom entry with `iconKey: "photo"` and `colorKey: "pink"`; assert its icon has `data-icon-key="photo"`, the label does not have an inline color, and its child `<ul role="group">` has `--classification-branch-color: #df6fa7`. Assert a child with null keys still uses `folder` and the neutral color.

Add keyboard tests for both `Shift+F10` and `ContextMenu` by focusing a row, firing the key, and asserting the same menu appears.

- [ ] **Step 2: Run sidebar tests and verify RED**

Run: `npm.cmd test -- src/classification/ClassificationSidebar.test.tsx`

Expected: FAIL because the heading, appearance action, custom icons, connector variable, and keyboard menu path do not exist and the ellipsis button still renders.

- [ ] **Step 3: Remove ellipsis UI and add appearance coordination**

Remove `EllipsisHorizontalIcon`, `Menu`, and the trigger span. Add `appearanceEntry` state. Insert the appearance action after rename:

```ts
{
  id: "appearance",
  label: "아이콘 및 색상…",
  onSelect: () => setAppearanceEntry(node.entry),
}
```

Render `ClassificationAppearanceDialog` once at sidebar level. On save, close it and call `onChanged()`.

- [ ] **Step 4: Add heading, icons, connector variables, and keyboard menu dispatch**

Render `<p className="classification-sidebar__tree-heading">폴더 ({tree.length})</p>` immediately above the tree.

Replace hard-coded folder/work icons with:

```tsx
<ClassificationIcon kind={node.entry.kind} iconKey={node.entry.iconKey} />
```

Give every expanded child group the parent color:

```tsx
<ul
  role="group"
  style={{
    "--classification-branch-color": classificationColor(node.entry.colorKey),
  } as CSSProperties}
>
```

Import `type CSSProperties` from React beside the component's existing React imports.

For `Shift+F10` or `ContextMenu`, prevent the default action and dispatch one bubbling `contextmenu` event from the focused row using its bounding rectangle. Continue routing every other key through the existing tree keyboard handler.

- [ ] **Step 5: Implement the approved compact tree CSS**

In `tokens.css`, add named classification connector opacity/indent tokens rather than repeated literals. In `global.css`:

- reduce tree row spacing while keeping the existing minimum pointer target height
- add rounded selected background without the tree-row left selection bar
- keep labels white and single-line with ellipsis
- position nested `ul` with a parent-colored low-opacity vertical `::before`
- draw the direct-child horizontal elbow from the same CSS variable
- mask the vertical continuation after the final child
- keep focus and drag/drop outlines above connector lines
- remove styles that only served `.ui-menu__trigger` inside tree rows

Use `color-mix(in srgb, var(--classification-branch-color) 55%, transparent)` for connector lines; do not compute RGBA values in React.

- [ ] **Step 6: Verify Task 5 GREEN and regression behavior**

Run: `npm.cmd test -- src/classification/ClassificationSidebar.test.tsx src/shared/ui/ContextMenu.test.tsx`

Expected: all sidebar and context-menu tests PASS.

Run: `npm.cmd run build`

Expected: build PASS with no unused ellipsis/menu imports.

- [ ] **Step 7: Commit Task 5**

```powershell
git add -- app/src/classification/ClassificationSidebar.tsx app/src/classification/ClassificationSidebar.test.tsx app/src/styles/global.css app/src/styles/tokens.css
git commit -m "feat: style classification folders"
```

---

### Task 6: Full verification and real Tauri acceptance

**Files:**
- Verify only; do not change files unless a failing check identifies a concrete defect.

**Interfaces:**
- Consumes the complete schema, command, gateway, dialog, and sidebar implementation.
- Produces evidence that the approved design works in the Windows Edge WebView/Tauri runtime.

- [ ] **Step 1: Run the full Rust suite**

Run: `cargo test`

Working directory: `app/src-tauri`

Expected: all non-ignored Rust tests PASS, including migration, backup, classification, query, and command tests.

- [ ] **Step 2: Run the full frontend check**

Run: `npm.cmd run check`

Working directory: `app`

Expected: all Vitest files PASS and `tsc && vite build` exits 0.

- [ ] **Step 3: Inspect scope and commit history**

Run:

```powershell
git diff --check
git status --short
git log -6 --oneline
```

Expected: no unstaged implementation files, no whitespace errors, one commit for each completed implementation task, and only pre-existing user-owned changes left uncommitted.

- [ ] **Step 4: Verify the actual Tauri development window**

Run `npm.cmd run tauri dev` from `app` if it is not already running. In the Lakomics window verify, without deleting or renaming user data:

1. quick views remain unchanged
2. `폴더 (N)` counts top-level folders
3. no `…` button appears
4. right-click opens the five-item menu
5. `Shift+F10` opens the same menu
6. the appearance dialog shows 24 icons and 12 colors
7. choose an icon and color on a disposable test folder and save
8. the icon and descendant connector line change while the label stays white
9. reload the app and confirm the appearance persists
10. reset the disposable folder to defaults

Creating a disposable test folder is reversible. Ask for confirmation immediately before deleting it, because deletion through Windows UI requires action-time confirmation.

- [ ] **Step 5: Report acceptance evidence**

Report the final commit IDs, Rust pass count, frontend pass count, build result, and the exact Tauri interactions verified. Mention any unrelated dirty files without modifying or staging them.
