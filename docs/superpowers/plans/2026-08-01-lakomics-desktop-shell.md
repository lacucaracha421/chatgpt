# Lakomics Desktop Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the approved Eagle-inspired “quiet workshop” desktop shell so the existing local-first image library is comfortable to browse, sort, favorite, classify, and feed by Windows file drop.

**Architecture:** Keep SQLite, file access, sorting, paging, and favorite persistence behind the Rust `Library` interface and small Tauri commands. Keep React state in focused classification, asset, ingestion, layout, preference, and shared-UI modules; retain the existing keyset paging, justified rows, virtualized rendering, media protocol, and FIFO ingestion flow.

**Tech Stack:** Rust 2024, rusqlite, Tauri 2, React 19, TypeScript 5.8, CSS custom properties, Vitest, Testing Library, `@tanstack/react-virtual`, `lucide-react`.

## Global Constraints

- Work only in `C:\chatgpt\.worktrees\lakomics-foundation` on `feature/lakomics-foundation`.
- Read `CONTEXT.md`, relevant `docs/adr/`, and `docs/agents/implementation.md` before editing.
- The binding design is `docs/superpowers/specs/2026-08-01-lakomics-desktop-shell-design.md`.
- Use `gpt-5.6-terra` with `high` reasoning for every implementation, task-review, and re-review subagent.
- Every instruction to a subagent must be written exclusively in English.
- Only one implementation agent may edit the shared worktree at a time.
- Each dispatch must state the role, allowed files, forbidden scope, interfaces, tests, and report path.
- Use TDD: observe a relevant failing test before production changes, then run focused and task-level verification.
- Do not add Tailwind, shadcn, an external font, a motion library, or decorative image assets.
- The only new runtime dependency allowed is `lucide-react`.
- Preserve the 4px spacing scale, `Segoe UI`, dark neutral palette, and restrained orange accent.
- Reuse or deepen shared UI before creating a same-purpose screen-specific control.
- Do not hardcode user classifications, library paths, mutable user settings, repeated visual values, page limits, or time limits in feature components.
- Keep the page size at 100 and the accepted Rust query limit range at 1 through 200.
- Keep SQLite, file operations, duplicate detection, and thumbnail generation private to the Rust library module.
- Preserve the safe `lakomics://` media protocol, FIFO drop batches, source-file preservation, and exact-duplicate immutability.
- Do not add similarity review, browser extension integration, video playback, collection editing, search, multi-selection, or batch actions.
- Never claim the native Explorer-to-Tauri OS drop passed without executing that exact boundary.

---

## Planned File Structure

```text
app/
├── src-tauri/src/
│   ├── commands.rs                       # Add favorite command, pass richer list query
│   ├── lib.rs                            # Register favorite command
│   └── library/
│       ├── error.rs                      # Invalid cursor contract
│       ├── favorite.rs                   # Favorite mutation behind Library
│       ├── mod.rs                        # Register private favorite module
│       ├── models.rs                     # Sort, query, opaque cursor, source metadata
│       └── query.rs                      # Stable four-mode keyset queries
└── src/
    ├── app/
    │   ├── App.tsx                       # Compose library workspace and selected view
    │   └── App.test.tsx
    ├── assets/
    │   ├── AssetBrowser.tsx              # Query generations, paging, sort, favorite
    │   ├── AssetBrowser.test.tsx
    │   ├── AssetDetailDialog.tsx         # Detail and classification editing
    │   ├── AssetGallery.tsx              # Virtual rows, selection, metadata overlay
    │   ├── AssetGallery.test.tsx
    │   └── AssetToolbar.tsx              # Location, sort, range, metadata, favorite
    ├── classification/
    │   ├── ClassificationSidebar.tsx      # Tree, quick views, shared row menu
    │   └── ClassificationSidebar.test.tsx
    ├── layout/
    │   ├── AppShell.tsx                  # Four-region desktop shell
    │   └── StatusBar.tsx                 # Counts, selection and ingestion progress
    ├── library/
    │   ├── client.ts                     # Tauri gateway adapter
    │   ├── constants.ts                  # Shared page-size contract
    │   └── types.ts                      # Frontend contracts and AssetView
    ├── preferences/
    │   ├── uiPreferences.ts              # Validated local UI preferences
    │   └── uiPreferences.test.ts
    ├── shared/ui/
    │   ├── Button.tsx                    # Variants and icon-button support
    │   ├── Dialog.tsx                    # Existing accessible modal
    │   ├── EmptyState.tsx
    │   ├── Menu.tsx                      # Context menu and ellipsis trigger
    │   ├── Menu.test.tsx
    │   ├── Select.tsx
    │   ├── Skeleton.tsx
    │   └── Toggle.tsx
    └── styles/
        ├── global.css                    # Component and shell rules
        └── tokens.css                    # Semantic visual tokens
```

Existing `justifiedRows.ts`, `mediaUrl.ts`, `useFileDrop.ts`, library setup/context, common text field/toast, and their tests remain in place unless a task explicitly names them.

---

### Task 1: Stable Sort Queries and Favorite Persistence

**Role:** Rust library and Tauri contract implementer.

**Allowed files:**
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/src/library/query.rs`
- Modify: `app/src-tauri/src/library/error.rs`
- Create: `app/src-tauri/src/library/favorite.rs`
- Modify: `app/src-tauri/src/library/ingestion.rs`
- Modify: `app/src-tauri/src/library/mod.rs`
- Modify: `app/src-tauri/src/commands.rs`
- Modify: `app/src-tauri/src/lib.rs`
- Modify: `app/src-tauri/tests/foundation_flow.rs`

**Forbidden scope:** Frontend files, schema migration files, ingestion behavior beyond populating the new `AssetSummary.source_url` field, media protocol, classification behavior, direct SQLite exposure.

**Interfaces:**
- Produces:

```rust
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AssetSort {
    Newest,
    Oldest,
    Favorites,
    Random,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AssetCursor {
    pub token: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetQuery {
    pub classification_id: Option<String>,
    pub direct_only: bool,
    pub favorite_only: bool,
    pub sort: AssetSort,
    pub random_pivot: Option<String>,
    pub after: Option<AssetCursor>,
    pub limit: u32,
}

impl Library {
    pub fn set_asset_favorite(
        &self,
        asset_id: &str,
        favorite: bool,
    ) -> Result<(), LibraryError>;
}
```

- `AssetSummary` additionally exposes `source_url: Option<String>`.
- The cursor token is produced and consumed only by Rust. It serializes a private tagged payload with the exact last-row keys for the active sort.
- `LibraryError::InvalidAssetCursor` maps to command code `invalid_asset_cursor`.
- `set_asset_favorite` updates exactly one normal asset and returns `AssetNotFound` when no normal asset matches.

- [ ] **Step 1: Add RED tests for favorite mutation and filtering**

Add focused tests in `library/favorite.rs` and `library/query.rs`:

```rust
#[test]
fn favorite_can_be_toggled_and_filtered() {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    insert_asset(&library, "asset-a", "hash-a", "2026-07-30T00:00:00Z");
    insert_asset(&library, "asset-b", "hash-b", "2026-07-31T00:00:00Z");

    library.set_asset_favorite("asset-a", true).unwrap();
    let page = library.list_assets(query(AssetSort::Newest, true, 20)).unwrap();

    assert_eq!(ids(&page), ["asset-a"]);
    assert!(page.items[0].favorite);

    library.set_asset_favorite("asset-a", false).unwrap();
    assert!(library.list_assets(query(AssetSort::Newest, true, 20)).unwrap().items.is_empty());
}
```

Also assert that a missing asset returns `LibraryError::AssetNotFound`.

- [ ] **Step 2: Run the focused Rust tests and observe RED**

Run:

```powershell
cargo test library::favorite library::query --lib
```

Expected: compilation fails because the new query fields, sort type, or `set_asset_favorite` do not exist.

- [ ] **Step 3: Add RED tests for all stable sort cursors**

Create fixtures with tied timestamps and mixed favorite values. Assert:

```rust
assert_eq!(two_pages(AssetSort::Newest), ["d", "c", "b", "a"]);
assert_eq!(two_pages(AssetSort::Oldest), ["a", "b", "c", "d"]);
assert_eq!(two_pages(AssetSort::Favorites), ["d", "b", "c", "a"]);
assert_eq!(
    two_random_pages("8"),
    two_random_pages("8"),
    "the same pivot must return the same complete order"
);
```

For random sorting, insert distinct 64-character hexadecimal `content_hash` values around pivot `"8"`. Assert that two pages contain each ID exactly once. Assert a malformed token and a token from a different sort return `InvalidAssetCursor`.

- [ ] **Step 4: Implement the minimal Rust query contracts**

Use a private payload:

```rust
#[derive(Serialize, Deserialize)]
#[serde(tag = "sort", rename_all = "snake_case")]
enum CursorPayload {
    Newest { collected_at: String, id: String },
    Oldest { collected_at: String, id: String },
    Favorites { favorite: bool, collected_at: String, id: String },
    Random {
        pivot: String,
        bucket: i64,
        content_hash: String,
        id: String,
    },
}
```

Encode and decode with `serde_json`; return `InvalidAssetCursor` for malformed tokens, sort mismatches, or random-pivot mismatches.

Use four explicit SQL statements rather than interpolating user input into `ORDER BY`.

- Newest: `collected_at DESC, id DESC`
- Oldest: `collected_at ASC, id ASC`
- Favorites: `favorite DESC, collected_at DESC, id DESC`
- Random: `CASE WHEN content_hash >= ?pivot THEN 0 ELSE 1 END ASC, content_hash ASC, id ASC`

Every statement must apply the same normal-status, classification-descendant, `direct_only`, and `favorite_only` filters. Select `source_url` and `content_hash` only as needed to build the response and cursor. Request `limit + 1`, truncate, and create the next cursor from the last returned row.

- [ ] **Step 5: Implement favorite mutation and Tauri command**

In `favorite.rs`:

```rust
let changed = connection.execute(
    "UPDATE assets SET favorite = ?2 WHERE id = ?1 AND status = 'normal'",
    params![asset_id, favorite],
)?;
if changed == 0 {
    return Err(LibraryError::AssetNotFound);
}
Ok(())
```

Add `commands::set_asset_favorite(asset_id, favorite, state)` and register it in `tauri::generate_handler!`.

- [ ] **Step 6: Update public integration coverage**

In `foundation_flow.rs`, use only public `Library` methods to:

1. ingest two images,
2. favorite one,
3. query `favorite_only`,
4. page newest and oldest,
5. query random twice with the same pivot,
6. verify source URL survives in `AssetSummary`.

- [ ] **Step 7: Run Task 1 verification**

Run:

```powershell
cargo fmt --all --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
```

Expected: all commands exit 0 with no Clippy warnings.

- [ ] **Step 8: Commit**

```powershell
git add app/src-tauri/src/library app/src-tauri/src/commands.rs app/src-tauri/src/lib.rs app/src-tauri/tests/foundation_flow.rs
git commit -m "feat: sort and favorite library assets"
```

---

### Task 2: Frontend Contracts and Validated UI Preferences

**Role:** TypeScript contract and local preference implementer.

**Allowed files:**
- Modify: `app/src/library/types.ts`
- Modify: `app/src/library/client.ts`
- Create: `app/src/library/constants.ts`
- Create: `app/src/preferences/uiPreferences.ts`
- Create: `app/src/preferences/uiPreferences.test.ts`
- Modify for contract compatibility only: `app/src/assets/AssetGallery.tsx`
- Modify for fixtures and gateway compatibility only: `app/src/app/App.test.tsx`
- Modify for fixtures and gateway compatibility only: `app/src/assets/AssetDetailDialog.test.tsx`
- Modify for fixtures and gateway compatibility only: `app/src/assets/AssetGallery.test.tsx`
- Modify for gateway compatibility only: `app/src/classification/ClassificationSidebar.test.tsx`

**Forbidden scope:** React visual behavior, CSS, Rust, sidebar behavior, ingestion. Changes to the old `AssetGallery.tsx` in this task may only supply the new query defaults and shared page-size constant so the branch continues to build.

**Interfaces:**

```ts
export type AssetSort = "newest" | "oldest" | "favorites" | "random";
export type AssetView =
  | { kind: "classification"; classificationId: string | null }
  | { kind: "favorites" }
  | { kind: "recent" };

export type AssetCursor = { token: string };

export type AssetQuery = {
  classificationId: string | null;
  directOnly: boolean;
  favoriteOnly: boolean;
  sort: AssetSort;
  randomPivot: string | null;
  after: AssetCursor | null;
  limit: number;
};

export interface LibraryGateway {
  setAssetFavorite(assetId: string, favorite: boolean): Promise<void>;
}

export type UiPreferences = {
  metadataVisible: boolean;
  sidebarWidth: number;
  expandedClassificationIds: string[];
  assetSort: AssetSort;
};
```

Defaults:

```ts
export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  metadataVisible: true,
  sidebarWidth: 232,
  expandedClassificationIds: [],
  assetSort: "newest",
};
```

Storage key: `lakomics.uiPreferences.v1`. Clamp sidebar width to 184 through 360 pixels. Deduplicate string IDs. Invalid JSON or invalid fields fall back per field without throwing.

`app/src/library/constants.ts` exports:

```ts
export const ASSET_PAGE_SIZE = 100;
```

- [ ] **Step 1: Write RED preference tests**

Cover default loading, round-trip saving, malformed JSON, invalid enum, duplicate IDs, and width clamping:

```ts
expect(loadUiPreferences(storage)).toEqual(DEFAULT_UI_PREFERENCES);

storage.setItem(
  UI_PREFERENCES_KEY,
  JSON.stringify({
    metadataVisible: false,
    sidebarWidth: 999,
    expandedClassificationIds: ["a", "a", 3],
    assetSort: "random",
  }),
);
expect(loadUiPreferences(storage)).toEqual({
  metadataVisible: false,
  sidebarWidth: 360,
  expandedClassificationIds: ["a"],
  assetSort: "random",
});
```

- [ ] **Step 2: Run the focused test and observe RED**

Run:

```powershell
npm.cmd test -- src/preferences/uiPreferences.test.ts
```

Expected: module resolution fails because `uiPreferences.ts` does not exist.

- [ ] **Step 3: Implement the minimum preference parser**

Use `JSON.parse`, `Set`, `Math.min`, and `Math.max`; do not add a schema-validation dependency. Export `loadUiPreferences(storage = localStorage)` and `saveUiPreferences(value, storage = localStorage)`.

- [ ] **Step 4: Update TypeScript gateway contracts**

Add `sourceUrl: string | null` to `AssetSummary`, replace the cursor and query shapes exactly as specified, and map:

```ts
setAssetFavorite: (assetId, favorite) =>
  invoke("set_asset_favorite", { assetId, favorite }),
```

Update the named test gateway factories to include the method and `sourceUrl` fixture field. Update the old asset browser’s list calls to supply `favoriteOnly: false`, `sort: "newest"`, `randomPivot: null`, and `ASSET_PAGE_SIZE`, without changing its behavior yet.

- [ ] **Step 5: Run Task 2 verification**

Run:

```powershell
npm.cmd test -- src/preferences/uiPreferences.test.ts src/library
npm.cmd run build
```

Expected: all focused tests and TypeScript build pass.

- [ ] **Step 6: Commit**

```powershell
git add app/src/library app/src/preferences app/src/app/App.test.tsx app/src/assets/AssetDetailDialog.test.tsx app/src/assets/AssetGallery.tsx app/src/assets/AssetGallery.test.tsx app/src/classification/ClassificationSidebar.test.tsx
git commit -m "feat: define desktop browsing preferences"
```

---

### Task 3: Shared Desktop UI and Visual Tokens

**Role:** Shared UI and design-system implementer.

**Allowed files:**
- Modify: `app/package.json`
- Modify: `app/package-lock.json`
- Modify: `app/src/styles/tokens.css`
- Modify: `app/src/styles/global.css`
- Modify: `app/src/shared/ui/Button.tsx`
- Modify: `app/src/shared/ui/Dialog.tsx`
- Create: `app/src/shared/ui/Menu.tsx`
- Create: `app/src/shared/ui/Menu.test.tsx`
- Create: `app/src/shared/ui/Select.tsx`
- Create: `app/src/shared/ui/Toggle.tsx`
- Create: `app/src/shared/ui/EmptyState.tsx`
- Create: `app/src/shared/ui/Skeleton.tsx`
- Modify: existing shared UI tests when required

**Forbidden scope:** App composition, asset data flow, classification mutations, Rust, Tauri commands.

**Interfaces:**

```ts
export type MenuItem = {
  id: string;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
  onSelect: () => void;
};

export function Menu(props: {
  label: string;
  items: MenuItem[];
  trigger: React.ReactNode;
  contextTarget?: React.RefObject<HTMLElement | null>;
}): React.ReactNode;
```

The trigger and context target open the same menu. The menu supports ArrowUp, ArrowDown, Home, End, Enter, Space, Escape, outside click, and trigger-focus return.

`Button` accepts `variant: "primary" | "secondary" | "ghost" | "danger"` and `size: "sm" | "md" | "icon"`. Icon buttons require `aria-label`.

- [ ] **Step 1: Add Lucide**

Run:

```powershell
npm.cmd install lucide-react
```

Verify that no other dependency was added.

- [ ] **Step 2: Write RED Menu interaction tests**

Write tests that open via the visible `···` trigger and via `contextmenu`, move focus with ArrowDown, select with Enter, close with Escape, and restore focus:

```ts
await user.click(screen.getByRole("button", { name: "분류 작업" }));
expect(screen.getByRole("menu")).toBeVisible();
await user.keyboard("{ArrowDown}{Enter}");
expect(rename).toHaveBeenCalledOnce();

fireEvent.contextMenu(screen.getByText("블루 아카이브"));
expect(screen.getByRole("menu")).toBeVisible();
await user.keyboard("{Escape}");
expect(screen.queryByRole("menu")).not.toBeInTheDocument();
```

- [ ] **Step 3: Run the focused test and observe RED**

Run:

```powershell
npm.cmd test -- src/shared/ui/Menu.test.tsx
```

Expected: module resolution fails because `Menu.tsx` does not exist.

- [ ] **Step 4: Implement shared primitives**

Build `Menu` with semantic `role="menu"` and `role="menuitem"` buttons. Keep one item model for both opening paths. Use React state and document pointer listeners; do not add an overlay dependency.

Implement small wrappers for native `<select>` and checkbox-backed toggle. `EmptyState` and `Skeleton` are presentational shared components without business logic.

Deepen the existing native `<dialog>` without replacing it: preserve title association and Escape handling, restore the opener’s focus after close, and expose class hooks for compact desktop styling.

- [ ] **Step 5: Implement semantic visual tokens and shared styles**

Keep the 4px scale and add semantic tokens, including:

```css
--color-bg: #0d0f12;
--color-sidebar: #14171c;
--color-toolbar: #14171b;
--color-surface: #191d22;
--color-surface-hover: #22272f;
--color-selected: rgba(232, 138, 45, 0.14);
--color-accent: #e88a2d;
--sidebar-width-default: 232px;
--toolbar-height: 48px;
--statusbar-height: 28px;
--gallery-target-row-height: 180px;
```

Use orange on selection, progress, and primary actions only. Remove the global rule that paints every `button` orange. Define consistent focus-visible outlines, disabled states, compact control heights, and reduced-motion behavior.

- [ ] **Step 6: Run Task 3 verification**

Run:

```powershell
npm.cmd test -- src/shared/ui
npm.cmd run build
```

Expected: all shared UI tests and build pass.

- [ ] **Step 7: Commit**

```powershell
git add app/package.json app/package-lock.json app/src/shared app/src/styles
git commit -m "feat: add the shared desktop UI system"
```

---

### Task 4: Dense Classification Sidebar and Quick Views

**Role:** Classification navigation implementer.

**Allowed files:**
- Modify: `app/src/classification/ClassificationSidebar.tsx`
- Modify: `app/src/classification/ClassificationSidebar.test.tsx`
- Modify: `app/src/classification/buildTree.ts` only if expansion metadata requires it
- Create: `app/src/layout/AppShell.tsx` only for the sidebar slot and resize handle
- Modify for new controlled props only: `app/src/app/App.tsx`
- Modify for new controlled props only: `app/src/app/App.test.tsx`
- Modify: `app/src/styles/global.css` only for classification and sidebar selectors

**Forbidden scope:** Asset query behavior, gallery algorithms, Rust, Tauri gateway, ingestion, shared UI internals. `App.tsx` changes in this task are limited to holding `AssetView`, expanded IDs, and sidebar width so the branch builds; final shell and persistence wiring belong to Task 6.

**Interfaces:**

```ts
type ClassificationSidebarProps = {
  entries: ClassificationEntry[];
  view: AssetView;
  expandedIds: string[];
  sidebarWidth: number;
  onViewChange: (view: AssetView) => void;
  onExpandedIdsChange: (ids: string[]) => void;
  onSidebarWidthChange: (width: number) => void;
  onChanged: () => void;
};
```

Actual classification rows choose `{ kind: "classification", classificationId: entry.id }`. Quick rows choose `{ kind: "favorites" }` and `{ kind: "recent" }`. Root-level “all assets” chooses `{ kind: "classification", classificationId: null }`.

- [ ] **Step 1: Write RED sidebar behavior tests**

Cover:

- all-assets, favorites, and recent quick views,
- expand/collapse without changing selection,
- row click selection,
- `+` create behavior at root and selected parents,
- identical rename/move/delete actions from `···` and right-click,
- controlled expanded IDs,
- resize clamping callbacks at 184 and 360.

Example:

```ts
await user.click(screen.getByRole("treeitem", { name: /블루 아카이브/ }));
expect(onViewChange).toHaveBeenCalledWith({
  kind: "classification",
  classificationId: "work-blue-archive",
});

await user.click(screen.getByRole("button", { name: "좋아요 보기" }));
expect(onViewChange).toHaveBeenCalledWith({ kind: "favorites" });
```

- [ ] **Step 2: Run the focused test and observe RED**

Run:

```powershell
npm.cmd test -- src/classification/ClassificationSidebar.test.tsx
```

Expected: failures because the current component has only `selectedId` and inline action buttons.

- [ ] **Step 3: Implement the controlled tree and quick views**

Use Lucide icons as imported components, not string keys. Keep row height and indentation in CSS tokens. The expand button must stop propagation so it does not change the selected view. Preserve the existing classification validation and dialogs.

Replace the bottom action strip with one shared `Menu`. The row’s context target and `···` trigger pass the same `MenuItem[]`.

- [ ] **Step 4: Implement sidebar resizing**

Use pointer capture on one resize handle. Emit clamped integer widths only; do not write local storage here. `App` will persist the controlled value in Task 6.

- [ ] **Step 5: Run Task 4 verification**

Run:

```powershell
npm.cmd test -- src/classification
npm.cmd run build
```

Expected: classification and build checks pass.

- [ ] **Step 6: Commit**

```powershell
git add app/src/classification app/src/layout/AppShell.tsx app/src/app/App.tsx app/src/app/App.test.tsx app/src/styles/global.css
git commit -m "feat: rebuild classification navigation"
```

---

### Task 5: Asset Toolbar, Stable Paging, Selection, and Detail

**Role:** Asset browsing implementer.

**Allowed files:**
- Create: `app/src/assets/AssetBrowser.tsx`
- Create: `app/src/assets/AssetBrowser.test.tsx`
- Modify: `app/src/assets/AssetGallery.tsx`
- Modify: `app/src/assets/AssetGallery.test.tsx`
- Create: `app/src/assets/AssetToolbar.tsx`
- Create: `app/src/assets/AssetDetailDialog.tsx`
- Modify: `app/src/assets/AssetDetailDialog.test.tsx`
- Modify: `app/src/assets/justifiedRows.ts` only for a proven regression
- Modify for the new browser contract only: `app/src/app/App.tsx`
- Modify for the new browser contract only: `app/src/app/App.test.tsx`
- Modify: `app/src/styles/global.css` only for asset selectors
- Delete obsolete code from `AssetGallery.tsx` after the split

**Forbidden scope:** Sidebar, final app-shell composition, preferences parser, Rust, gateway types, ingestion hook, media protocol. `App.tsx` may only adapt to the new `AssetBrowser` props so the branch builds.

**Interfaces:**

```ts
export type AssetBrowserStatus = {
  loadedCount: number;
  selectedAsset: AssetSummary | null;
  loading: boolean;
};

export function AssetBrowser(props: {
  view: AssetView;
  classifications: ClassificationEntry[];
  sort: AssetSort;
  metadataVisible: boolean;
  refreshVersion: number;
  onSortChange: (sort: AssetSort) => void;
  onMetadataVisibleChange: (visible: boolean) => void;
  onStatusChange: (status: AssetBrowserStatus) => void;
}): React.ReactNode;
```

Query mapping:

```ts
const queryBase = {
  classificationId:
    view.kind === "classification" ? view.classificationId : null,
  directOnly: view.kind === "classification" ? directOnly : false,
  favoriteOnly: view.kind === "favorites",
  sort: view.kind === "recent" ? "newest" : sort,
  randomPivot: effectiveSort === "random" ? randomPivot : null,
  limit: ASSET_PAGE_SIZE,
};
```

Random pivot uses `crypto.randomUUID().replaceAll("-", "")`. Create it when random sort becomes active and replace it only when the user presses “다시 섞기”.

- [ ] **Step 1: Write RED query and paging tests**

Cover all view mappings, four sort modes, direct-only availability, stable random pivot across first and next page, reshuffle replacing the pivot, first-page generation guards, next-page error with retained items, and first-page retry.

Example:

```ts
expect(gateway.listAssets).toHaveBeenLastCalledWith({
  classificationId: null,
  directOnly: false,
  favoriteOnly: true,
  sort: "favorites",
  randomPivot: null,
  after: null,
  limit: 100,
});
```

- [ ] **Step 2: Run browser tests and observe RED**

Run:

```powershell
npm.cmd test -- src/assets/AssetBrowser.test.tsx src/assets/AssetGallery.test.tsx
```

Expected: missing module and changed interaction failures.

- [ ] **Step 3: Implement AssetBrowser request ownership**

Move query generations, first-page loading, next-page loading, error states, and refresh behavior from the old combined component into `AssetBrowser.tsx`. Keep stale-response guards. Render:

- Skeleton while the first page is pending,
- EmptyState when a successful first page is empty,
- retained rows plus retry when a next page fails,
- first-page error plus retry when nothing loaded.

- [ ] **Step 4: Implement toolbar behavior**

`AssetToolbar` renders the current location, native shared `Select`, direct-only `Toggle`, metadata `Toggle`, favorite button for the selected asset, and random reshuffle only for random sort.

For the recent quick view, force newest and disable the sort selector. For favorites quick view, default to the user’s selected sort and query `favoriteOnly`.

- [ ] **Step 5: Implement single selection and double-open**

`AssetGallery` remains virtualized. Add:

```tsx
aria-selected={selectedAssetId === asset.id}
onClick={() => onSelect(asset)}
onDoubleClick={() => onOpen(asset)}
onKeyDown={(event) => {
  if (event.key === "Enter") onOpen(asset);
}}
```

Clicking the gallery background clears selection. Metadata overlays show `new URL(sourceUrl).hostname` when parseable and a locale date derived from `collectedAt`; malformed URLs show no host and never throw.

Read `--gallery-target-row-height` through the existing gallery measurement path instead of retaining a visual pixel constant in TypeScript.

- [ ] **Step 6: Implement favorite mutation**

Optimistically update only the selected item, call `gateway.setAssetFavorite`, and roll back plus Toast on failure. If the active view is favorites or the sort is favorites, refresh the first page after success because membership or order may change.

- [ ] **Step 7: Split and retain detail behavior**

Move the existing dialog logic into `AssetDetailDialog.tsx`. Preserve classification fetch/save generation guards. Add source URL, collected date, and favorite display. Do not add direct filesystem or browser opener behavior.

- [ ] **Step 8: Run Task 5 verification**

Run:

```powershell
npm.cmd test -- src/assets
npm.cmd run build
```

Expected: all asset tests and build pass.

- [ ] **Step 9: Commit**

```powershell
git add app/src/assets app/src/app/App.tsx app/src/app/App.test.tsx app/src/styles/global.css
git commit -m "feat: add the desktop asset browser"
```

---

### Task 6: App Shell Integration, Setup, Status, and Drop States

**Role:** Final frontend integration implementer.

**Allowed files:**
- Modify: `app/src/app/App.tsx`
- Modify: `app/src/app/App.test.tsx`
- Modify: `app/src/layout/AppShell.tsx`
- Create: `app/src/layout/StatusBar.tsx`
- Modify: `app/src/library/LibrarySetup.tsx`
- Modify or create: `app/src/library/LibrarySetup.test.tsx`
- Modify: `app/src/ingestion/useFileDrop.ts`
- Modify: `app/src/ingestion/useFileDrop.test.ts`
- Modify: `app/src/styles/global.css`
- Modify: `app/src/styles/tokens.css` only to resolve a proven missing semantic token
- Modify: `app/README.md` only for current controls and verification commands

**Forbidden scope:** Rust, gateway contracts, query internals, shared UI internals, ingestion queue/order/result semantics, new product features. The only allowed ingestion-hook behavior change is an explicit `enabled` gate tested to prevent new batches while disabled.

**Interfaces consumed:**

- `AssetView`, `UiPreferences`, `ClassificationSidebar`, `AssetBrowser`, `AssetBrowserStatus`, `AppShell`, `StatusBar`.
- Existing `useFileDrop` FIFO and result contracts remain unchanged.
- `useFileDrop` gains `enabled: boolean`; when false it remains subscribed but ignores new drop events without starting a batch, changing progress, or emitting results.

- [ ] **Step 1: Write RED app-flow tests**

Cover:

- restored library renders the four-region shell without a large path heading,
- selecting classification updates toolbar and drop target,
- favorites/recent views disable ingestion and show the classification-selection hint,
- successful drop refreshes assets and updates status,
- exact duplicate does not refresh,
- persisted metadata, sort, expanded IDs, and sidebar width are loaded and saved,
- setup screen opens a selected folder and shows errors in the common visual language.

Example:

```ts
await user.click(screen.getByRole("button", { name: "좋아요 보기" }));
act(() => drop?.(["C:\\images\\a.png"]));
expect(libraryGateway.ingestImage).not.toHaveBeenCalled();
expect(screen.getByText("파일을 저장할 분류를 먼저 선택하세요.")).toBeVisible();
```

- [ ] **Step 2: Run the focused app tests and observe RED**

Run:

```powershell
npm.cmd test -- src/app/App.test.tsx src/library/LibrarySetup.test.tsx
```

Expected: shell, quick-view drop, and preference assertions fail.

- [ ] **Step 3: Compose the four-region workspace**

`App.tsx` owns:

- classification entries,
- current `AssetView`,
- loaded UI preferences,
- drop-result Toast,
- asset refresh version,
- current asset-browser status.

`AppShell` receives slots for sidebar, toolbar/content, and status. Do not duplicate component markup inside `App.tsx`.

- [ ] **Step 4: Wire preferences**

Load once with `loadUiPreferences`. Save a complete validated object when metadata visibility, sort, expanded IDs, or sidebar width changes. Do not scatter local-storage keys across components.

- [ ] **Step 5: Wire safe drop behavior**

Compute:

```ts
const dropEnabled =
  view.kind === "classification" && view.classificationId !== null;
```

Pass `enabled: dropEnabled` and the concrete classification ID. Add hook coverage proving a drop received while disabled performs no ingest, result, or progress work; re-enabling permits the next event. When the view has no concrete classification, show the exact hint `파일을 저장할 분류를 먼저 선택하세요.` Do not alter the ingestion hook’s FIFO queue or exact duplicate behavior.

- [ ] **Step 6: Finish setup, empty, progress, and status presentation**

Polish `LibrarySetup` with the same tokens and shared controls. `StatusBar` displays loaded count, selected filename when present, and exact drop progress. Toast remains a transient result; status remains persistent context.

- [ ] **Step 7: Update current README controls**

Document only current behavior:

- classification navigation and row menu,
- four sorts,
- direct-only and metadata toggles,
- single-click selection and double-click detail,
- current-classification file drop.

Do not document deferred extension, video, collection, similarity, or search features.

- [ ] **Step 8: Run Task 6 verification**

Run:

```powershell
npm.cmd test
npm.cmd run build
cargo fmt --all --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
npm.cmd run tauri build -- --debug --no-bundle
```

Expected: all commands exit 0. Verify `app/src-tauri/target/debug/app.exe` exists and report its size.

- [ ] **Step 9: Commit**

```powershell
git add app/src/app app/src/layout app/src/library/LibrarySetup.tsx app/src/library/LibrarySetup.test.tsx app/src/ingestion app/src/styles app/README.md
git commit -m "feat: complete the Lakomics desktop shell"
```

---

## Post-Task Visual and Native Acceptance

After every task has passed independent review:

1. Run a fresh whole-frontend and whole-Rust verification gate.
2. Launch Vite with an injected mock Tauri gateway and inspect at 1440×900, 1280×720, and a narrow supported desktop width.
3. Use Playwright to verify classification navigation, toolbar controls, single selection, double-click detail, keyboard Enter/Escape, context menu, retry state, and no horizontal overlap.
4. Launch the exact debug Tauri executable.
5. If the desktop can be controlled safely, drag real PNG, JPEG, and GIF files from Windows Explorer into a concrete classification and verify source preservation, progress, gallery refresh, and exact duplicate blocking.
6. If step 5 cannot be executed safely, record it as unverified and retain the automated adapter, hook, Rust integration, and source-preservation evidence without claiming the OS boundary passed.
7. Dispatch a final whole-branch reviewer on `gpt-5.6-terra/high` with the full branch diff, plan, spec, ledger, and deferred findings.
