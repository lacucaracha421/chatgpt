# Extension Pinned Classifications

Date: 2026-08-17

Status: Design approved

## Problem

The Lakomics desktop app classifies items in a tree (e.g., `게임 > 리버스`, `게임 > 명조`, `게임 > 젠레스`). The extension radial menu only shows root classifications in the first-level ring. Some frequently used classifications live deep in the tree, so the user wants to surface them in the first-level ring without changing the desktop app's tree structure.

## Goal

Add a "pin" feature to the extension options page. Pinned classifications (including child classifications) appear in the first-level radial ring alongside root classifications. The second-level ring still shows the selected classification's actual children from the desktop app tree.

## Design

### Data model

- `chrome.storage.local` stores `pinnedClassificationIds: string[]`.
- The saved radial layout stores a virtual parent key `__pinned__` to remember slot order and pagination for the first-level ring.
- A classification entry is considered "first-level visible" if:
  - `parentId === null` (root), OR
  - its `id` is in `pinnedClassificationIds`.

### API / message contract

Background service worker handles:
- `pinned:get` → `{ ok: true, pinnedIds: string[] }`
- `pinned:set` with `{ pinnedIds }` → `{ ok: true }`
- `classifications:refresh` response now includes `pinnedIds`.

### Layout functions

In `extension/src/layout.js`:
- Add `PINNED = "__pinned__"`.
- `getPinnedLevel(entries, layout, pinnedIds, page)` returns the first-level ring:
  - Collect root entries + pinned entries.
  - Use `slotCount(total)` for page size.
  - Read/write layout under `__pinned__`.
- `togglePinned(layout, entries, entryId)` adds or removes an id from the pinned set and rebalances the `__pinned__` layout pages.

### Options page

In `extension/options/options.js`:
- Load `pinnedIds` on initialize.
- Render the first-level editor with `getPinnedLevel`.
- Add a pin/unpin toggle button on every slot (except it is disabled/hidden for root slots, since they are always shown).
- Save `pinnedIds` and layout together when "배치 저장" is clicked.
- Remove the previous hardcoded "기본 순서로 정렬" button (replaced by explicit pinning).

### Gesture / rendering

In `extension/src/gesture.js`:
- Use `LakomicsRadial.getPinnedLevel(...)` for the first level.
- The second level still uses the real `parentId` of the selected entry.
- `expandedParentId` and selection logic remain unchanged.

### Tests

- `extension/tests/layout.test.mjs` (new or extend existing): verify `getPinnedLevel`, `togglePinned`.
- `extension/tests/gesture.test.mjs`: add a test where a pinned child classification appears in the first-level ring and selecting it triggers its actual children in the second-level ring.

## Out of scope

- Desktop app changes: the desktop tree is untouched.
- Color/pinned indicator in the desktop app.
- Automatic sync of pinned state across devices.
- Third-level or deeper ring expansion (still stops at two rings).

## Verification

- Extension tests pass.
- Manual: pin `리버스`, `명조`, `젠레스` under `게임`, open the radial menu, and verify they appear in the first ring; selecting `게임` still shows its actual children in the second ring.
