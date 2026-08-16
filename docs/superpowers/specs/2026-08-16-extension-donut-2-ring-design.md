# Edge Extension Donut 2-Ring Redesign

Date: 2026-08-16

Status: User-approved (brainstorming complete)

## Problem

The current extension donut uses a single ring whose slots are replaced when the pointer dwells on a parent classification. The user perceives this as wrong: the second-level classifications should expand outward from the first-level ring, not replace it. The legacy extension (chromias) already implemented a two-ring donut where an inner ring of primary tags stays visible and an outer ring of related tags expands around the selected primary.

## Goal

Redesign the radial classification donut so that:

1. The first-level ring (primary classifications) is always visible.
2. Dwelling 300ms on a first-level item with children expands a second-level ring outside the first ring, centered on that item's angular position.
3. The second-level ring shows the children of the selected first-level item.
4. Third-level and deeper classifications are not expanded — the donut stops at two rings.

## Structure

### First-level ring (primary)

- **Slot count**: Dynamic, equal to the number of top-level classifications. If the count exceeds 12, page controls (left/right arrows outside the ring) paginate the remaining items.
- **Layout order**: Clockwise from 12 o'clock. The order is the user's saved layout from the options editor. On first run (no saved layout), classifications are auto-arranged in a default order (alphabetical/name-sorted), and the user can rearrange via the options editor.
- **Radius**: Inner 48px, outer 110px.
- **Start angle**: -PI/2 (12 o'clock), clockwise.
- **Sector gap**: 2 degrees between sectors (matching legacy).

### Second-level ring (secondary)

- **Slot count**: Dynamic, equal to the number of children of the selected first-level item. If the count exceeds 12, the same page controls paginate.
- **Radius**: Inner 130px, outer 185px. A 20px gap separates the first and second rings.
- **Expansion trigger**: 300ms dwell on a first-level item that has children. Items without children do not trigger expansion — the pointer can be released immediately to select that item.
- **Angular layout**: The selected first-level item's center angle is the anchor. Second-level sectors are distributed around the full circumference of the outer ring, centered on the anchor angle. This matches the legacy `buildOuterAngles` approach: the anchor is the first-level sector's center, and the outer sectors are evenly spaced across the full circle starting from that anchor.

### Center

- Radius <= 42px: center zone.
- When no second-level ring is open: center = "cancel" (release here cancels).
- When a second-level ring is open: entering the center closes the second-level ring immediately. Releasing in the center selects the current first-level item (the one whose children are shown).
- Label: shows the current first-level item name when a second ring is open, or "취소" when no ring is open.

### Page controls

- Left/right arrows outside the outer ring (x = ±166px, y = 0), matching current and legacy placement.
- Active for whichever ring currently has more than 12 items and has additional pages.
- Dwell 300ms on an arrow to advance pages (same as current behavior).

### Back button

- Removed. The second-level ring closes automatically when the pointer enters the first-level ring's inner area (center zone) or moves to a different first-level item.

## Interaction

### Opening

- Pointer down on an X media image, drag 12px+ → donut opens at the pointer origin.
- First-level ring appears immediately (no animation).

### First-level selection

- Move pointer to a first-level sector → that sector is hovered.
- Release without dwelling → selects that first-level classification.
- If the item has children and the pointer dwells 300ms → second-level ring expands.

### Second-level selection

- Second-level ring is open. Move pointer to a second-level sector → that sector is hovered.
- Release on a second-level sector → selects that second-level classification.
- Release in the center → selects the current first-level classification (the parent).

### Ring switching

- Second-level ring is open for item A. Pointer moves to a different first-level item B.
- If B has children: 300ms dwell on B → second-level ring switches to show B's children.
- If B has no children: second-level ring closes immediately. Releasing on B selects B.
- Entering the center zone while a second-level ring is open → second-level ring closes immediately. Releasing in center selects the current first-level item.

### Third-level and deeper

- Not expanded. A second-level item with children does not trigger another ring. Releasing on it selects that second-level classification. Deeper navigation is done in the desktop app.

### Cancel

- Escape key, pointer cancel, or window blur → donut closes, no selection.
- Releasing outside all rings and controls → cancel.

### Animations

- None. All transitions (ring open, ring close, ring switch, hover) are immediate. The donut is a fast pointer-driven transient UI; animations would feel laggy and cause flicker during rapid pointer movement.

## Visual style

### First-level ring

- Sector fill: `rgb(28 29 34 / 96%)` (current).
- Sector stroke: `#4a4d57`, 1.5px (current).
- Active sector (hovered): `#2f6db5` fill, `#8ec4ff` stroke (current).
- Empty sector: `rgb(24 25 29 / 82%)`, dashed stroke (current).
- Label: 12px, 600 weight, `#f8fafc`, centered in sector (current).

### Second-level ring

- Sector fill: slightly lower contrast than first-level — `rgb(24 25 29 / 92%)`.
- Sector stroke: `#3a3d47`, 1.5px (dimmer than first-level `#4a4d57`).
- Active sector: same accent as first-level (`#2f6db5` / `#8ec4ff`).
- Empty sector: same as first-level empty but with the dimmer stroke.
- Label: 12px, 600 weight, `#d8dbe0` (slightly dimmer than first-level `#f8fafc`).
- The active first-level item (the one whose children are shown) retains the accent highlight to indicate the expansion source.

### Center

- Same as current: `#202127` fill, `#525560` stroke.
- Active (pointer in center): `#2f6db5` / `#8ec4ff`.

### Page controls

- Same as current: `#202127` circle, `#525560` stroke, accent when active.

### Overall

- SVG viewBox: `-200 -200 400 400` (current). The outer ring at 185px fits within this.
- Drop shadow on the SVG container: current `filter: drop-shadow(0 10px 28px rgb(0 0 0 / 55%))`.
- Font: Segoe UI, 12px (current).

## Data flow

### Classification data

The extension receives classifications from the Lakomics desktop app via the background service worker (`classifications:get` message). The response contains:
- `entries`: flat array of `{ id, name, parentId, kind }` classification entries.
- `layout`: saved slot layout (current `reconcileLayout` / `resetLayout` structure).

No changes to the data contract are needed. The existing `layout.js` already groups entries by parentId and supports pagination. The two-ring design uses the same data, just rendered as two concurrent rings instead of one ring with slot replacement.

### Layout (slot arrangement)

- `layout.js` `getLevel` is called for both the first-level (parentId = null) and second-level (parentId = selected first-level id).
- The saved layout stores per-parent page arrays, which already supports both levels.
- `resetLayout` auto-arranges by insertion order on first run. The user can rearrange via the options editor (existing feature).

### Gesture state

The gesture session (`gesture.js`) tracks:
- `path`: array of selected parent entries (max depth 1 for two-ring design — we never push a second parent).
- `page`: current page index for the active level.
- `hover`: current hit-test target.
- `dwellDeadline`: when to trigger expansion or page change.

The session needs to track which ring is active (first or second) and handle:
- First-level hover + dwell → expand second ring.
- Second-level hover → select child on release.
- Center entry → close second ring.
- First-level switch (from second ring open) → 300ms dwell to switch.

## Files to change

| File | Change |
|---|---|
| `extension/src/gesture.js` | Rewrite hit-test for two concentric rings; track active ring; handle second-level expansion/switch/close; remove "back" target. |
| `extension/src/content.js` | Rewrite `renderSectors` to render both rings; render second-level ring when expanded; adjust center label logic; remove "위로" back control rendering. |
| `extension/src/content.css` | Add second-level ring sector styles (dimmer fill/stroke/label); adjust overall container if needed. |
| `extension/src/layout.js` | No structural changes — `getLevel` already supports per-parent levels. May need minor adjustments if page control logic differs for the two-ring case. |

## What stays the same

- Opening threshold (12px), dwell time (300ms).
- Click suppression (12px+ drag consumes the subsequent click).
- X source detection (`x-source.js`).
- Background service worker (`background.js`).
- Options page layout editor.
- Ingestion payload and status feedback.
- Result toast styling.

## Out of scope (first version)

- colorKey/color reflection in sectors (requires API change to pass color info to extension).
- Third-level ring expansion.
- Animation on ring open/close/switch.
- Configurable start angle.
- "위로" back button.
- Changes to the options editor UI (the editor already supports drag-rearrange).

## Verification

- Unit tests (`extension/tests/`): gesture hit-test for two rings, expansion trigger, center close, ring switch with dwell, page control for each ring, no-expansion for childless items.
- Manual: Edge with X.com, real pointer, 12px drag, dwell to expand second ring, select first vs second level, ring switch, center close, page controls for 13+ classifications.