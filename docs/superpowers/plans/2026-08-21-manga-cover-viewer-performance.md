# Manga Cover Viewer and Thumbnail Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make collection browsing use persistent small WorkArtwork thumbnails while adding the v6-style original-quality manga cover appreciation viewer.

**Architecture:** Keep original WorkArtwork as the canonical presentation file and add a deterministic derived WebP cache with its own media route. Collection cards and Volume tiles use the derived route; the existing detail hero and a focused Radix-based `MangaCoverViewer` use the original route. `CollectionOverlay` remains the data/sync owner and only coordinates viewer state.

**Tech Stack:** Rust, rusqlite, image, Tauri custom media protocol, React 19, TypeScript, Radix Dialog primitives, Vitest, Testing Library, CSS design tokens.

## Global Constraints

- Follow `DESIGN.md` and `docs/prototypes/lakomics-works-v6-reference.html`.
- Browsing uses `work-artwork-thumbnail/{artworkId}`; the detail hero and viewer use `work-artwork/{artworkId}`.
- WorkArtwork thumbnails are WebP files bounded to 360×360 pixels with preserved aspect ratio.
- Do not add a database column or dependency for derived thumbnails.
- MangaDex search stays text-only and does not request cover images.
- Viewer navigation is limited to artwork-bearing Volumes in the active edition, sorted by `volumeNumber`, with no wrapping.
- Placeholder Volumes do not open the viewer and do not issue image requests.
- Use one most relevant targeted check during iteration; do not run the full suite or production build unless targeted evidence identifies broader risk.
- Do not modify or stage the user's existing untracked files.

---

### Task 1: Persistent WorkArtwork Thumbnail Lifecycle

**Files:**
- Modify: `app/src-tauri/src/library/work_artwork.rs`

**Interfaces:**
- Produces: `Library::resolve_work_artwork_thumbnail(&self, artwork_id: &str) -> Result<MediaResponse, LibraryError>`
- Produces: deterministic `work-artwork-thumbnails/{collection_id}/{artwork_id}.webp` cache files.
- Preserves: `Library::resolve_work_artwork` as the original-file resolver.

- [ ] **Step 1: Add a failing preparation and cleanup test**

Extend the `work_artwork` test module with a real large-enough fixture and assert both representations:

```rust
fn png_bytes_at(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = Cursor::new(Vec::new());
    DynamicImage::new_rgb8(width, height)
        .write_to(&mut bytes, ImageFormat::Png)
        .unwrap();
    bytes.into_inner()
}

#[test]
fn prepared_artwork_writes_a_bounded_webp_thumbnail_and_drop_removes_both() {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    let collection = library.create_collection(manga_collection()).unwrap();

    let prepared = library
        .prepare_work_artwork(&collection.id, &png_bytes_at(900, 1350))
        .unwrap();
    let original = library.root().join(&prepared.relative_path);
    let thumbnail = library.root().join(format!(
        "work-artwork-thumbnails/{}/{}.webp",
        collection.id, prepared.id
    ));
    let decoded = image::open(&thumbnail).unwrap();

    assert!(original.exists());
    assert!(decoded.width() <= 360);
    assert!(decoded.height() <= 360);
    assert_eq!(decoded.width() * 3, decoded.height() * 2);

    drop(prepared);
    assert!(!original.exists());
    assert!(!thumbnail.exists());
}
```

Reuse the existing inline `CreateCollection` setup so this test introduces no new fixture abstraction.

- [ ] **Step 2: Run the WorkArtwork test module and confirm failure**

Run from `app/src-tauri`:

```powershell
cargo test library::work_artwork::tests --lib
```

Expected: FAIL because `prepare_work_artwork` does not create a derived thumbnail.

- [ ] **Step 3: Write thumbnails atomically during preparation**

Add the thumbnail path to the prepared lifecycle:

```rust
const WORK_ARTWORK_THUMBNAIL_BOUND: u32 = 360;

pub(crate) struct PreparedWorkArtwork {
    // existing fields
    thumbnail_absolute_path: PathBuf,
}

fn work_artwork_thumbnail_relative_path(collection_id: &str, artwork_id: &str) -> String {
    format!("work-artwork-thumbnails/{collection_id}/{artwork_id}.webp")
}
```

After decoding the original bytes in `prepare_work_artwork`, create the thumbnail directory and write `image.thumbnail(360, 360)` as WebP. Use a newly created file and `BufWriter`; if thumbnail writing fails, remove both created files and return `LibraryError::WriteWorkArtwork`. Extend `Drop` so an uncommitted preparation removes the original and thumbnail. `commit()` preserves both.

Do not re-encode or replace the original.

- [ ] **Step 4: Add a failing lazy-backfill test**

Create and commit a WorkArtwork row, remove its thumbnail to model a pre-feature library, then call the new resolver:

```rust
#[test]
fn thumbnail_resolver_backfills_once_and_returns_webp() {
    let fixture = WorkArtworkFixture::new(900, 1350);
    let artwork_id = fixture.insert_selected();
    let thumbnail = fixture.thumbnail_path(&artwork_id);
    std::fs::remove_file(&thumbnail).unwrap();

    let first = fixture.library.resolve_work_artwork_thumbnail(&artwork_id).unwrap();
    assert_eq!(first.mime, "image/webp");
    assert!(thumbnail.exists());
    let modified = std::fs::metadata(&thumbnail).unwrap().modified().unwrap();

    let second = fixture.library.resolve_work_artwork_thumbnail(&artwork_id).unwrap();
    assert_eq!(second.mime, "image/webp");
    assert_eq!(std::fs::metadata(&thumbnail).unwrap().modified().unwrap(), modified);
}
```

Reuse the existing `selecting_artwork_switches_the_cover_and_resolves_it_by_id` transaction setup directly, then remove the deterministic thumbnail before resolving it.

- [ ] **Step 5: Implement safe lazy backfill and cache cleanup**

Implement:

```rust
pub fn resolve_work_artwork_thumbnail(
    &self,
    artwork_id: &str,
) -> Result<MediaResponse, LibraryError>
```

Query `collection_id` and `relative_path` by artwork ID. Compute the deterministic thumbnail path. If it is absent:

1. open and decode the trusted original path through the library root;
2. write the 360×360-bounded WebP to a UUID-suffixed temporary file in the target directory;
3. rename the temporary file to the deterministic target;
4. if another request already created the target, remove the temporary file and use the winner;
5. remove the temporary file on every error path.

Then serve the cached path through `open_library_media`.

Extend `cleanup_unreferenced_work_artwork` to build referenced sets for both original and deterministic thumbnail paths, scan both managed roots, and remove files not referenced by `collection_work_artworks`. Keep the scan inside those exact managed roots.

- [ ] **Step 6: Run the WorkArtwork test module once after implementation**

Run:

```powershell
cargo test library::work_artwork::tests --lib
```

Expected: PASS for validation, prepared-file rollback, persisted original artwork, bounded thumbnail generation, lazy backfill, cache reuse, and cleanup.

- [ ] **Step 7: Commit Task 1**

```powershell
git add app/src-tauri/src/library/work_artwork.rs
git commit -m "feat: cache WorkArtwork thumbnails"
```

---

### Task 2: WorkArtwork Thumbnail Media Route

**Files:**
- Modify: `app/src-tauri/src/library/mod.rs`
- Modify: `app/src-tauri/src/media_protocol.rs`

**Interfaces:**
- Consumes: `Library::resolve_work_artwork_thumbnail` from Task 1.
- Produces: `MediaVariant::WorkArtworkThumbnail`.
- Produces: `/work-artwork-thumbnail/{artworkId}` custom-protocol route.

- [ ] **Step 1: Add failing route parsing and serving assertions**

Extend the existing WorkArtwork protocol test in `media_protocol.rs`:

```rust
let thumbnail = media_response(
    Some(&library),
    &Method::GET,
    &format!("/work-artwork-thumbnail/{ARTWORK_ID}"),
);
assert_eq!(thumbnail.status(), StatusCode::OK);
assert_eq!(thumbnail.headers()[CONTENT_TYPE], "image/webp");
assert!(library
    .root()
    .join(format!("work-artwork-thumbnails/{COLLECTION_ID}/{ARTWORK_ID}.webp"))
    .exists());
```

Add malformed-path cases alongside existing UUID/path rejection cases:

```rust
assert_eq!(
    media_response(Some(&library), &Method::GET, "/work-artwork-thumbnail/not-a-uuid").status(),
    StatusCode::BAD_REQUEST,
);
assert_eq!(
    media_response(
        Some(&library),
        &Method::GET,
        &format!("/work-artwork-thumbnail/{ARTWORK_ID}/more"),
    ).status(),
    StatusCode::BAD_REQUEST,
);
```

Use a decodable image fixture rather than the existing arbitrary bytes so lazy backfill is exercised.

- [ ] **Step 2: Run the focused protocol test and confirm failure**

Run:

```powershell
cargo test media_protocol::tests::work_artwork_route_serves_only_the_id_resolved_file --lib
```

Expected: FAIL because the new route is not parsed.

- [ ] **Step 3: Wire the media variant and route**

Add:

```rust
pub enum MediaVariant {
    // existing variants
    WorkArtwork,
    WorkArtworkThumbnail,
}
```

In `Library::resolve_media`:

```rust
MediaVariant::WorkArtworkThumbnail => {
    return self.resolve_work_artwork_thumbnail(asset_id);
}
```

In `parse_path`:

```rust
"work-artwork-thumbnail" if segments.next().is_none() => {
    (MediaVariant::WorkArtworkThumbnail, None)
}
```

Include the new variant in any exhaustive unreachable/fallback match with `WorkArtwork`. Preserve UUID validation and the one-segment path rule.

- [ ] **Step 4: Run the focused protocol test once after implementation**

Run the same focused protocol test. Expected: PASS with WebP content type, lazy cache creation, and invalid-path rejection.

- [ ] **Step 5: Commit Task 2**

```powershell
git add app/src-tauri/src/library/mod.rs app/src-tauri/src/media_protocol.rs
git commit -m "feat: serve WorkArtwork thumbnails"
```

---

### Task 3: Switch Browsing Surfaces to Thumbnail URLs

**Files:**
- Modify: `app/src/assets/mediaUrl.ts`
- Modify: `app/src/assets/mediaUrl.test.ts`
- Modify: `app/src/collections/CollectionBrowser.tsx`
- Modify: `app/src/collections/CollectionBrowser.test.tsx`
- Modify: `app/src/collections/CollectionVolumeGrid.tsx`
- Modify: `app/src/collections/CollectionOverlay.test.tsx`

**Interfaces:**
- Produces: `workArtworkThumbnailUrl(artworkId: string): string`.
- Preserves: `workArtworkUrl` for original-quality hero/viewer use.

- [ ] **Step 1: Change URL expectations first**

In `mediaUrl.test.ts`, import the new helper and assert segment encoding:

```ts
expect(workArtworkThumbnailUrl("art/one")).toBe(
  "http://lakomics.localhost/work-artwork-thumbnail/art%2Fone",
);
```

In `CollectionBrowser.test.tsx`, change the stored WorkArtwork card expectation to:

```ts
expect(screen.getByRole("img", { name: "Astral Chain" })).toHaveAttribute(
  "src",
  "http://lakomics.localhost/work-artwork-thumbnail/artwork-1",
);
```

In `CollectionOverlay.test.tsx`, keep hero expectations on `/work-artwork/`, but change the Volume tile assertion to locate the lazy tile image and expect `/work-artwork-thumbnail/art-10`.

- [ ] **Step 2: Run the two smallest frontend test files and confirm failure**

Run from `app`:

```powershell
npm test -- src/assets/mediaUrl.test.ts src/collections/CollectionBrowser.test.tsx
```

Expected: FAIL because the helper is missing and the browser still uses the original route.

- [ ] **Step 3: Add the helper and switch only browsing surfaces**

Add to `mediaUrl.ts`:

```ts
export function workArtworkThumbnailUrl(artworkId: string): string {
  return `${MEDIA_ORIGIN}/work-artwork-thumbnail/${encodeURIComponent(artworkId)}`;
}
```

Use it in:

- `CollectionBrowser` when `selectedWorkArtworkId` supplies a card cover;
- `CollectionVolumeGrid` for artwork-bearing Volume tile images.

Do not change `CollectionOverlay` hero URLs. Do not change Asset thumbnails, source previews, or MangaDex search.

- [ ] **Step 4: Run the affected browsing tests once after implementation**

Run:

```powershell
npm test -- src/assets/mediaUrl.test.ts src/collections/CollectionBrowser.test.tsx src/collections/CollectionOverlay.test.tsx
```

Expected: PASS. Confirm the overlay test contains evidence that the hero uses `/work-artwork/` while the tile uses `/work-artwork-thumbnail/`.

- [ ] **Step 5: Commit Task 3**

```powershell
git add app/src/assets/mediaUrl.ts app/src/assets/mediaUrl.test.ts app/src/collections/CollectionBrowser.tsx app/src/collections/CollectionBrowser.test.tsx app/src/collections/CollectionVolumeGrid.tsx app/src/collections/CollectionOverlay.test.tsx
git commit -m "perf: use thumbnails in collection grids"
```

---

### Task 4: Manga Cover Appreciation Viewer

**Files:**
- Create: `app/src/collections/MangaCoverViewer.tsx`
- Create: `app/src/collections/MangaCoverViewer.test.tsx`
- Modify: `app/src/styles/global.css`

**Interfaces:**
- Consumes: ordered artwork-bearing `CollectionVolume[]` and original `workArtworkUrl`.
- Produces:

```ts
export type ViewableCollectionVolume = CollectionVolume & {
  coverArtworkId: string;
};

type MangaCoverViewerProps = {
  workTitle: string;
  volumes: ViewableCollectionVolume[];
  activeVolumeId: string;
  onActiveVolumeChange: (volumeId: string) => void;
  onClose: () => void;
};
```

- [ ] **Step 1: Write the focused viewer behavior test**

Create `MangaCoverViewer.test.tsx` with three artwork-bearing Volumes and cover these behaviors in one interaction-focused test:

```tsx
const user = userEvent.setup();
const onActiveVolumeChange = vi.fn();
const onClose = vi.fn();

render(
  <MangaCoverViewer
    workTitle="던전밥"
    volumes={volumes}
    activeVolumeId="v2"
    onActiveVolumeChange={onActiveVolumeChange}
    onClose={onClose}
  />,
);

expect(screen.getByRole("dialog", { name: "던전밥 2권 표지 감상" })).toBeInTheDocument();
expect(screen.getByRole("img", { name: "2권 표지" })).toHaveAttribute(
  "src",
  "http://lakomics.localhost/work-artwork/art-2",
);
expect(screen.getByText("2 / 3")).toBeInTheDocument();

await user.keyboard("{ArrowRight}");
expect(onActiveVolumeChange).toHaveBeenCalledWith("v3");
await user.keyboard("{Escape}");
expect(onClose).toHaveBeenCalledOnce();
```

Add a boundary assertion that the previous button is disabled on the first Volume and that navigation does not wrap. Add a backdrop-click assertion using a stable `aria-label="표지 감상 닫기"` on the overlay surface.

- [ ] **Step 2: Run the viewer test and confirm failure**

Run:

```powershell
npm test -- src/collections/MangaCoverViewer.test.tsx
```

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the viewer with existing Radix primitives**

Use the already installed `@radix-ui/react-dialog` primitives directly so modal focus trapping and opener focus restoration are native to the established dependency. Do not add a library or extend the generic form-dialog chrome.

Implementation outline:

```tsx
export function MangaCoverViewer({ workTitle, volumes, activeVolumeId, onActiveVolumeChange, onClose }: MangaCoverViewerProps) {
  const activeIndex = volumes.findIndex((volume) => volume.id === activeVolumeId);
  const active = volumes[activeIndex];
  if (!active) return null;

  function move(offset: -1 | 1) {
    const next = volumes[activeIndex + offset];
    if (next) onActiveVolumeChange(next.id);
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowLeft") { event.preventDefault(); move(-1); }
    if (event.key === "ArrowRight") { event.preventDefault(); move(1); }
  }

  return (
    <RadixDialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="manga-cover-viewer__backdrop" aria-label="표지 감상 닫기" />
        <RadixDialog.Content
          className="manga-cover-viewer"
          aria-describedby={undefined}
          onKeyDown={handleKeyDown}
        >
          <RadixDialog.Title className="sr-only">
            {workTitle} {active.displayLabel}권 표지 감상
          </RadixDialog.Title>
          {/* original artwork, position, close, previous, next */}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
```

Radix Overlay already closes through `onOpenChange` for outside interaction; if the separate overlay element does not receive a click in the test environment, use `onPointerDown={() => onClose()}` and stop propagation inside Content.

For pointer tilt, keep two CSS custom properties on the collectible element. Compute normalized pointer coordinates from `getBoundingClientRect`, clamp both rotations to ±3 degrees, and set a small shadow offset. Clear inline properties on pointer leave. This is presentation-only local state; do not trigger React renders on pointer movement.

- [ ] **Step 4: Add restrained token-based styles**

Add only viewer-specific rules to `global.css`:

- fixed inset backdrop using existing overlay/background tokens where available;
- fixed centered content with no card background;
- cover bounded by viewport height and width, `object-fit: contain`, 0–2 px radius;
- 120–160 ms opacity/transform transition;
- compact square navigation and close controls;
- weak glare layer and moving shadow only on the collectible cover;
- position text in muted typography;
- `@media (prefers-reduced-motion: reduce)` override removing transform, glare, and transition.

Do not add gradients outside the weak pointer glare layer allowed by the collectible exception. Do not add metadata copy, a boxed panel, spring animation, or hover scale to controls.

- [ ] **Step 5: Run the viewer test once after implementation**

Run the same viewer test. Expected: PASS for dialog naming, original image URL, position, disabled boundaries, arrow navigation, Escape, and backdrop close.

- [ ] **Step 6: Commit Task 4**

```powershell
git add app/src/collections/MangaCoverViewer.tsx app/src/collections/MangaCoverViewer.test.tsx app/src/styles/global.css
git commit -m "feat: add manga cover appreciation viewer"
```

---

### Task 5: Connect Volume Tiles to the Viewer

**Files:**
- Modify: `app/src/collections/CollectionVolumeGrid.tsx`
- Modify: `app/src/collections/CollectionOverlay.tsx`
- Modify: `app/src/collections/CollectionOverlay.test.tsx`

**Interfaces:**
- Consumes: `MangaCoverViewer` from Task 4.
- Changes `CollectionVolumeGrid.onSelect` semantics: an artwork-bearing tile requests selection/viewer open; placeholders remain inert.
- Preserves: Volume loading, background MangaDex synchronization, edition drawers, hero fallback, and non-manga `CollectionCoverGrid` behavior.

- [ ] **Step 1: Add the failing overlay integration test**

Extend `CollectionOverlay.test.tsx` with a stable resolved Volume list containing base-edition Volumes `1`, `2`, and a placeholder `3`:

```tsx
const user = userEvent.setup();
renderOverlay({
  listCollectionVolumes: vi.fn().mockResolvedValue(volumes),
});

const opener = await screen.findByRole("button", { name: "2권 표지" });
await user.click(opener);

expect(screen.getByRole("dialog", { name: "던전밥 2권 표지 감상" })).toBeInTheDocument();
expect(screen.getByRole("img", { name: "2권 표지" })).toHaveAttribute(
  "src",
  "http://lakomics.localhost/work-artwork/art-2",
);
expect(screen.getByRole("button", { name: "3권 표지 불러오는 중" })).toBeInTheDocument();

await user.keyboard("{Escape}");
await waitFor(() => expect(opener).toHaveFocus());
```

Assert that clicking the placeholder does not create a dialog. Preserve the earlier assertion that its tile contains no `<img>`.

- [ ] **Step 2: Run the overlay test and confirm failure**

Run:

```powershell
npm test -- src/collections/CollectionOverlay.test.tsx
```

Expected: FAIL because tile selection does not open `MangaCoverViewer`.

- [ ] **Step 3: Add minimal viewer coordination to the overlay**

Add:

```ts
const [viewerVolumeId, setViewerVolumeId] = useState<string | null>(null);

const viewerVolumes = (volumes ?? [])
  .filter((volume): volume is CollectionVolume & { coverArtworkId: string } => (
    volume.editionIndex === editionIndex && volume.coverArtworkId !== null
  ))
  .sort((left, right) => left.volumeNumber - right.volumeNumber);
```

On an artwork-bearing tile selection:

```ts
function openVolume(volumeId: string) {
  const volume = volumes?.find((candidate) => candidate.id === volumeId);
  if (!volume?.coverArtworkId) return;
  setSelectedVolumeId(volumeId);
  setViewerVolumeId(volumeId);
}
```

Render the viewer only when `viewerVolumeId` belongs to `viewerVolumes`:

```tsx
{viewerVolumeId && viewerVolumes.some((volume) => volume.id === viewerVolumeId) && (
  <MangaCoverViewer
    workTitle={collection?.name ?? "컬렉션"}
    volumes={viewerVolumes}
    activeVolumeId={viewerVolumeId}
    onActiveVolumeChange={(volumeId) => {
      setViewerVolumeId(volumeId);
      setSelectedVolumeId(volumeId);
    }}
    onClose={() => setViewerVolumeId(null)}
  />
)}
```

Close the viewer when changing edition drawers. Keep `CollectionVolumeGrid` free of dialog state. Ensure a placeholder tile either stays a disabled/non-opening button or guards its click without changing the existing accessible loading label.

- [ ] **Step 4: Run the overlay test once after implementation**

Run the same overlay test. Expected: PASS for one-click opening, original-quality viewer image, placeholder behavior, Escape close, focus restoration, existing sync refresh, and non-manga preservation.

- [ ] **Step 5: Commit Task 5**

```powershell
git add app/src/collections/CollectionVolumeGrid.tsx app/src/collections/CollectionOverlay.tsx app/src/collections/CollectionOverlay.test.tsx
git commit -m "feat: open manga covers from volume shelf"
```

---

## Completion Evidence

Use the successful checks already run after the last relevant edits. Do not rerun them merely for completion:

- Rust lifecycle evidence: `cargo test library::work_artwork::tests --lib`
- Rust route evidence: the focused WorkArtwork media protocol test
- Frontend URL/grid evidence: `mediaUrl`, `CollectionBrowser`, and `CollectionOverlay` test files
- Viewer behavior evidence: `MangaCoverViewer.test.tsx`

Inspect `git diff --check` and `git status --short`. Confirm only known pre-existing untracked files remain outside committed work. Push the feature branch only after implementation is complete and the user has requested or authorized remote integration.
