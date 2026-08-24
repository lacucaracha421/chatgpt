# Collection Library Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current sparse Collection grid controls with the approved v6 Library shell: stable mode/media navigation, title search, sorting, exact personal-rating filtering, and media-correct cards.

**Architecture:** Keep all browsing derivation in a small pure TypeScript module and keep the authoritative Collection data in the existing `LibraryWorkspace`. `LibraryWorkspace` owns per-media browse state so opening a Collection detail and returning does not reset the list. `CollectionBrowser` remains the orchestration surface, while `CollectionCard` owns only card presentation. No repository query, schema, provider, Online Catalog, or Showcase-reorder work belongs in this plan.

**Tech Stack:** React 19, TypeScript 7, Vitest/Testing Library, existing Lakomics shared UI and CSS tokens.

## Global Constraints

- The user-facing name remains `컬렉션`; internal `Collection` naming remains valid.
- Online Catalog remains entirely separate and must not create, update, or provide metadata to Collections.
- Collection exposes only `게임 | 만화 | 영화`; there is no mixed `전체` view and legacy `gacha` remains excluded by the repository.
- Library and Showcase appear as equal mode choices, not a Showcase filter disguised as a single toggle.
- This plan implements the Library shell only. Showcase exhibition layout and manual ordering remain a separate implementation plan.
- Recently added is the default sort; supported sorts are recently added, name, and media date, each with ascending/descending direction.
- Missing media dates sort after dated Collections in both directions. Full `releaseDate` takes precedence over the existing year fallback.
- Personal rating is an exact single-select filter: `전체`, `5.0` down to `0.0` by `0.5`, and `미평가`.
- Cards show cover/poster, title, media-specific credit, and a real unread-release badge only. They do not show type, asset count, year, external score, or personal rating.
- Credits are never substituted across roles: manga uses `author`, game uses `developer`, movie uses `productionCompany`.
- Game cards may use a restrained generic package frame; manga and movie cards remain flat. No persistent tilt, glare, bounce, or broad 3D UI.
- Reuse existing `ViewToolbar`, `TextField`, `Select`, `Menu`, `Button`, `ContextMenu`, `EmptyState`, design tokens, and focus behavior. Add no dependency or speculative abstraction.
- Preserve all pre-existing dirty worktree changes. `app/src/library/client.test.ts` and other unrelated dirty files are out of scope.

---

### Task 1: Pure Library browse state and derivation

**Files:**
- Create: `app/src/collections/collectionLibrary.ts`
- Create: `app/src/collections/collectionLibrary.test.ts`

**Interfaces:**
- Consumes: `CollectionSummary`, `CollectionType` from `app/src/library/types.ts`.
- Produces:

```ts
export type CollectionLibrarySort = "recent" | "name" | "media_date";
export type CollectionLibraryDirection = "asc" | "desc";
export type CollectionRatingFilter = "all" | "unrated" | number;

export type CollectionLibraryState = {
  query: string;
  sort: CollectionLibrarySort;
  direction: CollectionLibraryDirection;
  rating: CollectionRatingFilter;
};

export type CollectionLibraryStateByType = Record<CollectionType, CollectionLibraryState>;

export function createDefaultCollectionLibraryState(): CollectionLibraryStateByType;
export function deriveCollectionLibrary(
  collections: CollectionSummary[],
  type: CollectionType,
  state: CollectionLibraryState,
): CollectionSummary[];
```

- [ ] **Step 1: Write failing derivation tests**

Create focused fixtures and tests proving composition, not isolated toy branches:

```ts
it("composes media, title, and exact half-star filtering", () => {
  const result = deriveCollectionLibrary(
    [game("NieR:Automata", 4.5), game("NieR Replicant", 5), manga("NieR anthology", 4.5)],
    "game",
    { query: "automata", sort: "recent", direction: "desc", rating: 4.5 },
  );
  expect(result.map((item) => item.name)).toEqual(["NieR:Automata"]);
});

it("filters unrated separately from zero stars", () => {
  expect(names({ rating: "unrated" })).toEqual(["Unrated"]);
  expect(names({ rating: 0 })).toEqual(["Zero"]);
});

it.each(["asc", "desc"] as const)("keeps missing media dates last for %s", (direction) => {
  const result = deriveCollectionLibrary(
    [dated("Exact", "2020-02-03", null), dated("Year", null, 2019), dated("Missing", null, null)],
    "game",
    { query: "", sort: "media_date", direction, rating: "all" },
  );
  expect(result.at(-1)?.name).toBe("Missing");
});
```

Also prove name sorting, recently-added direction, exact-date precedence over year, stable tie-breaking by name then ID, and that calling the function does not mutate the input array.

- [ ] **Step 2: Run tests to verify RED**

Run:

```powershell
npm test --prefix app -- src/collections/collectionLibrary.test.ts --run
```

Expected: FAIL because `collectionLibrary.ts` and its exports do not exist.

- [ ] **Step 3: Implement the minimal pure module**

Use a direct filter/copy/sort pipeline:

```ts
export function createDefaultCollectionLibraryState(): CollectionLibraryStateByType {
  const initial = (): CollectionLibraryState => ({
    query: "",
    sort: "recent",
    direction: "desc",
    rating: "all",
  });
  return { game: initial(), manga: initial(), movie: initial() };
}

export function deriveCollectionLibrary(
  collections: CollectionSummary[],
  type: CollectionType,
  state: CollectionLibraryState,
): CollectionSummary[] {
  const query = state.query.trim().toLocaleLowerCase();
  return collections
    .filter((item) => item.type === type)
    .filter((item) => !query || item.name.toLocaleLowerCase().includes(query))
    .filter((item) => matchesRating(item.myScore, state.rating))
    .slice()
    .sort((left, right) => compareCollections(left, right, state));
}
```

For media-date sorting, derive a numeric key from `releaseDate.replaceAll("-", "")`; otherwise use `year * 10_000`; otherwise use `null`. Handle null before applying direction so missing values remain last in both directions. Do not parse or guess dates from titles or provider snapshots.

- [ ] **Step 4: Run tests to verify GREEN**

Run the command from Step 2.

Expected: all `collectionLibrary` tests pass.

- [ ] **Step 5: Commit Task 1**

```powershell
git add -- app/src/collections/collectionLibrary.ts app/src/collections/collectionLibrary.test.ts
git diff --cached --check
git commit -m "feat: add collection library browsing model"
```

---

### Task 2: Stable Library controls and per-media state

**Files:**
- Modify: `app/src/app/App.tsx`
- Modify: `app/src/app/App.test.tsx`
- Modify: `app/src/collections/CollectionBrowser.tsx`
- Modify: `app/src/collections/CollectionBrowser.test.tsx`
- Modify: `app/src/styles/global.css`

**Interfaces:**
- Consumes: Task 1 `CollectionLibraryState`, `CollectionLibraryStateByType`, `createDefaultCollectionLibraryState`, and `deriveCollectionLibrary`.
- Changes `CollectionBrowserProps` to consume:

```ts
libraryState: CollectionLibraryState;
onLibraryStateChange: (next: CollectionLibraryState) => void;
```

- `LibraryWorkspace` owns one `CollectionLibraryStateByType` state value. It passes the active media entry to `CollectionBrowser` and updates only that entry. This state must survive `collections → collection → collections` navigation without adding query/sort fields to `AssetView` or local storage.

- [ ] **Step 1: Write failing state-preservation and control tests**

In `App.test.tsx`, add a navigation regression that changes the game title search, opens a Collection, exits detail, and asserts the search value is unchanged.

In `CollectionBrowser.test.tsx`, add tests proving:

```ts
it("renders stable mode, media, search, sort, direction, and rating controls", () => {
  renderBrowser({ libraryState: defaults.game, showcase: false });
  expect(screen.getByRole("button", { name: "라이브러리" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "쇼케이스" })).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByRole("textbox", { name: "제목 검색" })).toBeVisible();
  expect(screen.getByRole("combobox", { name: "정렬" })).toHaveValue("recent");
  expect(screen.getByRole("combobox", { name: "내 별점" })).toHaveValue("all");
});

it("updates only the active media browse state", async () => {
  const onLibraryStateChange = vi.fn();
  renderBrowser({ libraryState: defaults.game, onLibraryStateChange });
  await userEvent.setup().type(screen.getByRole("textbox", { name: "제목 검색" }), "nier");
  expect(onLibraryStateChange).toHaveBeenLastCalledWith({ ...defaults.game, query: "nier" });
});
```

Also prove:

- direction toggles between `desc` and `asc` with an accessible label;
- the rating select contains `전체`, `5.0..0.0`, and `미평가`, and converts numeric option values to numbers;
- switching mode emits `{ kind: "collections", typeFilter, showcase: true/false }`;
- Library results come from `deriveCollectionLibrary`;
- empty Library offers an active-media add button; manga opens MangaDex while game/movie open manual creation;
- game/movie add menus do not misleadingly offer MangaDex.

- [ ] **Step 2: Run focused tests to verify RED**

```powershell
npm test --prefix app -- src/collections/CollectionBrowser.test.tsx src/app/App.test.tsx --run
```

Expected: FAIL because the new browse-state props and controls do not exist.

- [ ] **Step 3: Lift per-media state into `LibraryWorkspace`**

Add:

```ts
const [collectionLibraryState, setCollectionLibraryState] =
  useState<CollectionLibraryStateByType>(createDefaultCollectionLibraryState);

function updateCollectionLibraryState(type: CollectionType, next: CollectionLibraryState) {
  setCollectionLibraryState((current) => ({ ...current, [type]: next }));
}
```

Pass the active state and update callback to `CollectionBrowser`. Do not put these fields into the global top bar, `AssetView`, or Online Catalog preferences.

- [ ] **Step 4: Replace the Showcase boolean-looking toggle with explicit mode/media segments**

Keep `ViewToolbar` title and add action stable. Inside its compact content render:

```tsx
<ModeSegment showcase={showcase} onChange={setShowcase} />
<TypeSegment current={typeFilter} onChange={setTypeFilter} />
```

`ModeSegment` exposes two buttons, `라이브러리` and `쇼케이스`, both with `aria-pressed`. Library-only search/sort/rating controls render when `showcase === false`; the existing provisional Showcase grid remains usable but receives no production exhibition or reordering behavior in this plan.

- [ ] **Step 5: Add compact Library controls with shared UI**

Use existing controls:

```tsx
<TextField
  label="제목 검색"
  value={libraryState.query}
  placeholder="제목 검색"
  onChange={(event) => patchLibraryState({ query: event.target.value })}
/>
<Select
  label="정렬"
  value={libraryState.sort}
  onChange={(event) => patchLibraryState({ sort: event.target.value as CollectionLibrarySort })}
>
  <option value="recent">최근 추가</option>
  <option value="name">제목</option>
  <option value="media_date">출시·출간·개봉일</option>
</Select>
<button
  type="button"
  aria-label={libraryState.direction === "desc" ? "내림차순" : "오름차순"}
  onClick={() => patchLibraryState({
    direction: libraryState.direction === "desc" ? "asc" : "desc",
  })}
/>
<Select
  label="내 별점"
  value={String(libraryState.rating)}
  onChange={(event) => patchLibraryState({
    rating: event.target.value === "all" || event.target.value === "unrated"
      ? event.target.value
      : Number(event.target.value),
  })}
>
  <option value="all">전체</option>
  {[5, 4.5, 4, 3.5, 3, 2.5, 2, 1.5, 1, 0.5, 0].map((rating) => (
    <option key={rating} value={rating}>{rating.toFixed(1)}</option>
  ))}
  <option value="unrated">미평가</option>
</Select>
```

Extend the existing toolbar shared-control styling only enough to visually hide the `TextField` label while preserving its accessible name. Do not make a new search or select component.

- [ ] **Step 6: Derive visible Library rows and keep provisional Showcase order deterministic**

For Library:

```ts
const visible = deriveCollectionLibrary(collections, typeFilter, libraryState);
```

For the provisional Showcase view, filter to the active type and `showcase === true`, then sort by `showcaseOrder` with null last and name/ID tie-breakers. Do not apply Library search, rating, or sort controls to Showcase.

- [ ] **Step 7: Correct active-media add behavior and empty action**

The add menu contains `MangaDex에서 만화 추가` only for manga, plus `직접 입력`. The empty Library action uses MangaDex for manga and manual creation for game/movie. The empty Showcase only explains how to add from Library and does not auto-fill.

- [ ] **Step 8: Run focused tests to verify GREEN**

Run the command from Step 2.

Expected: both test files pass.

- [ ] **Step 9: Commit Task 2**

Stage only intended files. `App.tsx` and its tests were clean at plan start; unrelated dirty files must remain unstaged.

```powershell
git add -- app/src/app/App.tsx app/src/app/App.test.tsx app/src/collections/CollectionBrowser.tsx app/src/collections/CollectionBrowser.test.tsx app/src/styles/global.css
git diff --cached --check
git commit -m "feat: build collection library controls"
```

---

### Task 3: Media-correct Collection cards and Library visual pass

**Files:**
- Modify: `app/src/collections/CollectionCard.tsx`
- Create: `app/src/collections/CollectionCard.test.tsx`
- Modify: `app/src/collections/CollectionBrowser.test.tsx`
- Modify: `app/src/styles/global.css`

**Interfaces:**
- Consumes: existing `CollectionSummary` typed-credit fields and the existing `coverUrl`, `selected`, and click props.
- Produces one exported helper for testable role selection:

```ts
export function collectionCredit(collection: CollectionSummary): string;
```

It returns only `author` for manga, `developer` for game, or `productionCompany` for movie, trimmed; otherwise `""`.

- [ ] **Step 1: Write failing card semantics tests**

Create `CollectionCard.test.tsx` with one fixture per medium and prove:

```ts
it.each([
  ["manga", { author: "Kui Ryoko", developer: "Wrong", productionCompany: "Wrong" }, "Kui Ryoko"],
  ["game", { author: "Wrong", developer: "PlatinumGames", productionCompany: "Wrong" }, "PlatinumGames"],
  ["movie", { author: "Wrong", developer: "Wrong", productionCompany: "Warner Bros." }, "Warner Bros."],
])("shows only the %s credit role", (type, credits, expected) => {
  const collection = { ...sample, ...credits, type } as CollectionSummary;
  render(<CollectionCard collection={collection} coverUrl={null} selected={false} onClick={vi.fn()} />);
  expect(screen.getByText(expected)).toHaveClass("collection-card__credit");
  expect(screen.queryByText("Wrong")).not.toBeInTheDocument();
});
```

Also prove:

- the active media type label is absent from the card;
- asset count, year, external score, and personal rating are absent;
- the credit line remains in the DOM but empty when the correct role is missing, even if a wrong-role field is populated;
- unread-release badge renders only above zero;
- game cards expose a package element while manga/movie remain flat;
- click and accessible cover alt behavior remain unchanged.

- [ ] **Step 2: Run focused card tests to verify RED**

```powershell
npm test --prefix app -- src/collections/CollectionCard.test.tsx --run
```

Expected: FAIL because the helper/package semantics do not exist and old type/count text is present.

- [ ] **Step 3: Implement sparse media-correct markup**

Replace the old type/name/count stack with:

```tsx
<span className={`collection-card__object collection-card__object--${collection.type}`}>
  <span className="collection-card__cover">
    {coverUrl ? (
      <img src={coverUrl} alt={collection.name} loading="lazy" draggable={false} />
    ) : (
      <span className="collection-card__placeholder" aria-hidden="true" />
    )}
    {collection.unreadReleaseCount > 0 && (
      <span className="collection-card__release-badge">신간 {collection.unreadReleaseCount}</span>
    )}
  </span>
</span>
<span className="collection-card__meta">
  <span className="collection-card__name">{collection.name}</span>
  <span className="collection-card__credit">{collectionCredit(collection)}</span>
</span>
```

The package shell/spine for games may use pseudo-elements on `collection-card__object--game`; do not add JS tilt or decorative DOM layers. Keep the release badge inside the cover.

- [ ] **Step 4: Tune the Library grid and card CSS against the v6 reference**

Use existing tokens for spacing, borders, radii, focus, and surfaces. Required outcomes:

- dense `auto-fill` cover grid without card panels;
- manga/movie aspect ratio remains `2 / 3`;
- game front cover remains authentic inside a subtle dark shell/spine and modest contact shadow;
- manga/movie covers remain flat;
- title and reserved credit line have stable two-line metadata geometry;
- ordinary hover/focus remains restrained with no persistent tilt, glare, bounce, or large-angle transform;
- remove the decorative `LIBRARY`/`CURATED SELECTION` eyebrow from the Library heading;
- keep focus-visible outlines and button semantics intact.

- [ ] **Step 5: Run focused UI tests to verify GREEN**

```powershell
npm test --prefix app -- src/collections/CollectionCard.test.tsx src/collections/CollectionBrowser.test.tsx --run
```

Expected: both test files pass.

- [ ] **Step 6: Run compile-level integration check**

```powershell
npm run build --prefix app
```

Expected: TypeScript and Vite build succeed; the existing large-chunk warning is non-blocking.

- [ ] **Step 7: Commit Task 3**

```powershell
git add -- app/src/collections/CollectionCard.tsx app/src/collections/CollectionCard.test.tsx app/src/collections/CollectionBrowser.test.tsx app/src/styles/global.css
git diff --cached --check
git commit -m "feat: refine collection library cards"
```

---

## Final verification for this plan

After all three task reviews are clean, run fresh checks once:

```powershell
npm test --prefix app -- src/collections/collectionLibrary.test.ts src/collections/CollectionCard.test.tsx src/collections/CollectionBrowser.test.tsx src/app/App.test.tsx --run
npm run build --prefix app
```

Then inspect `git diff --check` for the plan range and confirm:

- Online Catalog files and behavior are unchanged;
- no `전체` Collection media tab exists;
- Library controls compose media, title, sort, direction, and exact rating filtering;
- missing media dates remain last in both directions;
- returning from detail preserves per-media Library state;
- cards never substitute the wrong credit role;
- the current provisional Showcase remains usable and ordered by persisted `showcaseOrder` but receives no production Showcase scope;
- all pre-existing dirty files remain uncommitted and unchanged by this plan.
