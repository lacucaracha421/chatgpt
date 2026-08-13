# Lakomics Eagle-Style Sidebar Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refine Lakomics' quick views, folder tree, and album tree into the approved compact Eagle-style sidebar without changing navigation, hierarchy, context-menu, drag-and-drop, or keyboard behavior.

**Architecture:** Keep `ClassificationSidebar` as the only rendering component and add only the DOM hooks needed to separate full-row interaction targets from content-sized selection surfaces. Express row rhythm, triangle geometry, indentation, connector clearance, and neutral states through shared CSS tokens and pseudo-elements; no data model, gateway, command, or dependency changes are required.

**Tech Stack:** React 19, TypeScript 5.8, CSS custom properties and pseudo-elements, Vitest, Testing Library, Tauri 2 on Windows

## Global Constraints

- Follow `DESIGN.md` and `docs/agents/implementation.md`; raw colors belong only in `app/src/styles/tokens.css`.
- Preserve `role="tree"`, `role="treeitem"`, `aria-expanded`, `aria-selected`, roving focus, keyboard menu shortcuts, context menus, inline editing, drag targets, and expand/collapse behavior.
- Do not alter folder or album data, hierarchy rules, commands, gateways, persistence, or asset membership.
- Add no dependency and no new component file.
- Quick-view rows are 34px high with 2px between rows; tree rows are 32px high and their selection surfaces are 30px high with a token-sourced 6px radius.
- Selection is neutral and content-sized. It has no persistent blue left indicator, glow, shadow, gradient, scale, or translation.
- Each tree depth advances exactly 24px. Triangle centers, folder-icon centers, and connector axes derive from the same scoped CSS geometry variables.
- Filled triangles are 8px high, use a transparent background, and retain 4px of connector clearance above and below.
- A same-depth boundary connector is straight, stops at the first following sibling, and ends 8px above that sibling folder icon's top edge.
- The last visible direct child receives a rounded bend only when it has no expansion triangle.
- Folder and album trees must use the same markup and styling rules.
- Preserve unrelated dirty-worktree changes and stage only files named by the active task.

---

### Task 1: Add interaction-preserving visual hooks

**Files:**
- Modify: `app/src/classification/ClassificationSidebar.tsx:359-678`
- Test: `app/src/classification/ClassificationSidebar.test.tsx:180-320`

**Interfaces:**
- Consumes: existing `SidebarTreeNode`, `QuickViewButton`, `TreeItem`, `ClassificationIcon`, and controlled expansion props
- Produces: `.classification-sidebar__quick-view-surface`, `.classification-sidebar__tree-surface`, `.classification-sidebar__tree-toggle`, `.classification-sidebar__tree-toggle-mark[data-state]`, and `li[data-has-next-sibling]` hooks used by Task 2

- [ ] **Step 1: Add failing tests for compact surfaces and structural state**

Add these tests beside the existing quick-view and appearance tests:

```tsx
it("separates compact selection surfaces from full interaction rows", () => {
  renderSidebar();

  const storage = screen.getByRole("button", { name: "저장소" });
  expect(storage).toHaveAttribute("aria-current", "page");
  expect(storage.querySelector(":scope > .classification-sidebar__quick-view-surface")).not.toBeNull();

  const games = screen.getByRole("treeitem", { name: "Games" });
  expect(games).toHaveAttribute("aria-expanded", "true");
  expect(games.querySelector(":scope > .classification-sidebar__tree-toggle")).not.toBeNull();
  expect(games.querySelector(":scope > .classification-sidebar__tree-surface")).not.toBeNull();
  expect(games.querySelector(".classification-sidebar__tree-toggle-mark")).toHaveAttribute("data-state", "expanded");
});

it("marks only expanded items that have a following sibling", () => {
  const siblingEntries = [
    ...entries,
    { id: "root-2", kind: "root", name: "Images", parentId: null, iconKey: null, colorKey: null },
  ] satisfies ClassificationEntry[];
  renderSidebar(gateway(), { entries: siblingEntries });

  const gamesItem = screen.getByRole("treeitem", { name: "Games" }).closest("li");
  const imagesItem = screen.getByRole("treeitem", { name: "Images" }).closest("li");
  expect(gamesItem).toHaveAttribute("data-has-next-sibling", "true");
  expect(imagesItem).not.toHaveAttribute("data-has-next-sibling");
});
```

- [ ] **Step 2: Run the focused test and verify the new assertions fail**

Run from `C:\chatgpt\app`:

```powershell
npm.cmd test -- ClassificationSidebar.test.tsx
```

Expected: FAIL because the surface, toggle-mark, and sibling-state hooks do not exist yet.

- [ ] **Step 3: Wrap quick-view visual content without shrinking its button hit target**

Replace the one-line `QuickViewButton` return with:

```tsx
return (
  <button
    type="button"
    className="classification-sidebar__quick-view"
    aria-label={count === undefined ? undefined : `${label} ${count}개`}
    aria-current={selected ? "page" : undefined}
    onClick={onClick}
  >
    <span className="classification-sidebar__quick-view-surface">
      {icon}
      <span className="classification-sidebar__quick-view-label">{label}</span>
      {count !== undefined && <span className="classification-sidebar__badge" aria-hidden="true">{count}</span>}
    </span>
  </button>
);
```

The button remains the accessible and clickable row. Only its child surface receives hover and selected backgrounds in Task 2.

- [ ] **Step 4: Pass explicit sibling state at every tree depth**

Change the folder map callback from `tree.map((node) => (` to `tree.map((node, index) => (` and insert this prop immediately after `node={node}`:

```tsx
hasNextSibling={index < tree.length - 1}
```

Change the album map callback from `albumTree.map((node) => (` to `albumTree.map((node, index) => (` and insert this prop immediately after `node={node}`:

```tsx
hasNextSibling={index < albumTree.length - 1}
```

Add `hasNextSibling` immediately after `editName` in the existing `TreeItem` destructuring, and add the property immediately after `editName: string;` in its inline prop type:

```tsx
hasNextSibling: boolean;
```

Change the recursive callback from `node.children.map((child) =>` to `node.children.map((child, index) =>` and insert this prop immediately after `node={child}`:

```tsx
hasNextSibling={index < node.children.length - 1}
```

Do not derive this from folder names. The flag always describes the current node's next sibling in its own `node.children` array.

- [ ] **Step 5: Add the compact tree surface and filled-triangle hook**

Set the structural state on the existing list item:

```tsx
<li
  className="classification-sidebar__tree-item"
  data-has-next-sibling={hasNextSibling ? "true" : undefined}
>
```

Keep the existing `Button`, click cancellation, keyboard cancellation, and accessible label, but replace the Heroicon child:

```tsx
<Button
  type="button"
  size="icon"
  variant="ghost"
  className="classification-sidebar__tree-toggle"
  aria-label={`${node.entry.name} ${expanded ? "접기" : "펼치기"}`}
  onClick={(event) => {
    event.stopPropagation();
    onToggleExpanded(node.entry);
  }}
  onKeyDown={(event) => event.stopPropagation()}
>
  <span
    className="classification-sidebar__tree-toggle-mark"
    data-state={expanded ? "expanded" : "collapsed"}
    aria-hidden="true"
  />
</Button>
```

Keep the spacer for leaf rows. Wrap only the icon, title, and inline rename field in the visual surface:

```tsx
<span className="classification-sidebar__tree-surface">
  <ClassificationIcon
    className="classification-sidebar__tree-folder"
    kind={node.entry.kind}
    iconKey={node.entry.iconKey}
    style={{ color: classificationColor(node.entry.colorKey) }}
  />
  {editingName ? (
    <InlineFolderInput
      name={editName}
      error={editError}
      onNameChange={onEditNameChange}
      onSave={onEditSave}
      onCancel={onEditCancel}
    />
  ) : (
    <span className="classification-sidebar__tree-label">{node.entry.name}</span>
  )}
</span>
```

Apply the same `.classification-sidebar__tree-surface` wrapper to `InlineFolderEditor`, around its folder icon and `InlineFolderInput`, so create and rename fields retain the same geometry.

- [ ] **Step 6: Remove now-unused tree-row chevron imports**

Retain the heading chevrons used for the `폴더` and `앨범` section buttons. Remove only an import that is no longer referenced after the tree toggle changes; do not replace heading behavior in this task.

- [ ] **Step 7: Run focused interaction tests**

```powershell
npm.cmd test -- ClassificationSidebar.test.tsx
```

Expected: all sidebar tests PASS, including expand/collapse, roving focus, keyboard context menu, inline edit, appearance, and drag-related assertions.

- [ ] **Step 8: Commit the visual hooks**

```powershell
git add app/src/classification/ClassificationSidebar.tsx app/src/classification/ClassificationSidebar.test.tsx
git commit -m "refactor: expose compact sidebar visual states"
```

---

### Task 2: Implement neutral selection and shared hierarchy geometry

**Files:**
- Modify: `app/src/classification/ClassificationSidebar.tsx:604-607`
- Modify: `app/src/styles/tokens.css:1-55`
- Modify: `app/src/styles/global.css:450-790`
- Test: `app/src/classification/ClassificationSidebar.test.tsx`

**Interfaces:**
- Consumes: the surface, toggle-mark, expanded ARIA state, sibling-state, and `--classification-branch-color` hooks produced by Task 1
- Produces: a single tokenized 24px tree grid shared by folders and albums, content-sized neutral states, triangle clearance, same-depth boundary continuation, and last-child termination

- [ ] **Step 1: Add a failing test for the neutral default connector token**

Add this assertion to the existing `counts top-level folders and renders custom icon and connector colors` test after its pink connector assertion:

```tsx
const defaultGroup = screen
  .getByRole("treeitem", { name: "Blue Archive" })
  .closest("li")
  ?.querySelector(":scope > [role='group']") as HTMLElement;
expect(defaultGroup.style.getPropertyValue("--classification-branch-color"))
  .toBe("var(--color-sidebar-connector)");
```

- [ ] **Step 2: Run the focused test and verify the neutral-token assertion fails**

```powershell
npm.cmd test -- ClassificationSidebar.test.tsx
```

Expected: FAIL because a folder with no configured color currently writes `var(--color-muted)` to `--classification-branch-color`.

- [ ] **Step 3: Add semantic sidebar color and radius tokens**

Add these tokens to `:root` in `tokens.css`; keep all raw color literals in this file:

```css
--color-sidebar-selection: #30343a;
--color-sidebar-hover: #23272c;
--color-sidebar-connector: #59616b;
--radius-selection: 6px;
```

Do not change global `--color-selected`; other views still use its blue-tinted state.

- [ ] **Step 4: Make unconfigured connectors consume the neutral token**

Change the existing group style in `TreeItem` to:

```tsx
style={{
  "--classification-branch-color": node.entry.colorKey
    ? classificationColor(node.entry.colorKey)
    : "var(--color-sidebar-connector)",
} as CSSProperties}
```

Configured colors still use `classificationColor`; only the unconfigured fallback changes.

- [ ] **Step 5: Define one scoped geometry system for the tree**

Replace the existing tree geometry variables with this derived set on `.classification-sidebar__tree`:

```css
.classification-sidebar__tree {
  --classification-row-height: 32px;
  --classification-selection-height: 30px;
  --classification-depth-step: 24px;
  --classification-row-start: 4px;
  --classification-toggle-size: 16px;
  --classification-triangle-height: 8px;
  --classification-triangle-width: 6px;
  --classification-triangle-clearance: 4px;
  --classification-toggle-center-x: calc(var(--classification-row-start) + var(--classification-toggle-size) / 2);
  --classification-icon-center-x: calc(var(--classification-toggle-center-x) + var(--classification-depth-step));
  --classification-branch-x: var(--classification-icon-center-x);
  margin: 0;
  padding: 0;
  list-style: none;
}
```

Set each nested group to `padding-inline-start: var(--classification-depth-step)`. A child triangle then lands on its parent's `--classification-icon-center-x`, and the child's icon becomes the next depth's connector axis without a second indentation formula.

- [ ] **Step 6: Style quick views as compact neutral rows**

Update the quick-view rules to use a 34px button row, a 2px grid gap, and a content-sized surface:

```css
.classification-sidebar__quick-views,
.classification-sidebar__footer {
  gap: 2px;
}

.classification-sidebar__quick-view {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 34px;
  padding: 0;
  color: var(--color-text);
  text-align: left;
  background: transparent;
}

.classification-sidebar__quick-view-surface {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  min-width: 0;
  height: var(--classification-selection-height, 30px);
  gap: var(--space-2);
  padding: 0 var(--space-2);
  border-radius: var(--radius-selection);
}

.classification-sidebar__quick-view[aria-current="page"] > .classification-sidebar__quick-view-surface {
  color: var(--color-text);
  background: var(--color-sidebar-selection);
}

.classification-sidebar__quick-view:hover > .classification-sidebar__quick-view-surface {
  background: var(--color-sidebar-hover);
}

.classification-sidebar__quick-view[aria-current="page"]:hover > .classification-sidebar__quick-view-surface {
  background: var(--color-sidebar-selection);
}
```

Delete the old quick-view inset `box-shadow` selection indicator. Move the badge away from `margin-left: auto`; keep it inline with `margin-left: var(--space-1)` and muted in every state. Keep unselected icons muted, but brighten the selected surface's icon to `currentColor`.

- [ ] **Step 7: Style tree rows and compact selection surfaces**

Keep `.classification-sidebar__tree-row` as the full-width focus, click, context-menu, and drop target. Size only its children:

```css
.classification-sidebar__tree-row {
  position: relative;
  z-index: 1;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  width: 100%;
  min-width: 0;
  min-height: var(--classification-row-height);
  gap: var(--space-2);
  padding: 0 var(--space-1);
  background: transparent;
}

.classification-sidebar__tree-toggle,
.classification-sidebar__tree-spacer {
  flex: none;
  width: var(--classification-toggle-size);
  min-width: var(--classification-toggle-size);
  height: var(--classification-toggle-size);
  min-height: var(--classification-toggle-size);
  padding: 0;
  background: transparent;
}

.classification-sidebar__tree-surface {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  min-width: 0;
  max-width: calc(100% - var(--classification-toggle-size) - var(--space-2));
  height: var(--classification-selection-height);
  gap: var(--space-compact);
  margin-left: calc(var(--space-1) * -1);
  padding: 0 var(--space-compact) 0 var(--space-1);
  border-radius: var(--radius-selection);
}

.classification-sidebar__tree-row[aria-selected="true"] > .classification-sidebar__tree-surface {
  color: var(--color-text);
  background: var(--color-sidebar-selection);
}

.classification-sidebar__tree-row:hover > .classification-sidebar__tree-surface {
  background: var(--color-sidebar-hover);
}

.classification-sidebar__tree-row[aria-selected="true"]:hover > .classification-sidebar__tree-surface {
  background: var(--color-sidebar-selection);
}
```

Remove the old full-row selected and hover backgrounds. Keep the existing row-level `:focus-visible` outline and all drop-state selectors independent so keyboard focus and drag validity remain visible.

- [ ] **Step 8: Render the filled triangle with transparent hit-area background**

Use the existing 16px button as the accessible hit target and draw only the mark:

```css
.classification-sidebar__tree-toggle-mark {
  display: block;
  width: 0;
  height: 0;
  border-top: calc(var(--classification-triangle-height) / 2) solid transparent;
  border-bottom: calc(var(--classification-triangle-height) / 2) solid transparent;
  border-left: var(--classification-triangle-width) solid var(--color-muted);
  transform-origin: calc(var(--classification-triangle-width) / 2) 50%;
}

.classification-sidebar__tree-toggle-mark[data-state="expanded"] {
  transform: rotate(90deg);
}

.classification-sidebar__tree-row[aria-selected="true"] .classification-sidebar__tree-toggle-mark {
  border-left-color: var(--color-text);
}
```

The toggle button itself stays transparent in default, hover, selected, and focus states. Do not add a transition, glow, or background behind the triangle.

- [ ] **Step 9: Rebuild branch connectors from direct-child segments**

Replace the existing group-wide connector and last-child pseudo-elements with direct-child segments. Use `--classification-branch-color` with `var(--color-sidebar-connector)` as its neutral fallback and keep the existing color mix for configured colors.

Implement these exact state rules with `ul[role="group"] > .classification-sidebar__tree-item` pseudo-elements and `:has()` selectors:

```text
non-last direct child without a toggle:
  vertical segment from the previous row boundary through the entire li

non-last direct child with a toggle:
  the same segment, masked from 4px above the 8px triangle to 4px below it

first direct child with a toggle:
  omit the parent-icon-to-triangle segment and start 4px below the triangle

last direct child without a toggle and no following parent sibling:
  vertical segment to the row center plus one 4px-radius bend toward the folder icon

last direct child with a toggle and no following parent sibling:
  end 4px above the triangle and draw no bend

expanded parent with data-has-next-sibling="true":
  continue one straight segment through the visible descendant block to the parent li bottom;
  draw no closing bend on that boundary segment
```

Use a neutral sidebar-colored mask on `.classification-sidebar__tree-toggle::before` sized to:

```css
height: calc(
  var(--classification-triangle-clearance) * 2
  + var(--classification-triangle-height)
);
```

Center the mask on the toggle and place the triangle above it. This creates equal 4px gaps without giving the toggle a selected or glowing background. Set the straight continuation's end from the next row geometry as:

```css
bottom: calc(
  var(--classification-row-height) / 2
  + var(--classification-icon-size) / 2
  + 8px
);
```

This resolves to the boundary before the following sibling row: 8px above that sibling's 16px icon top. Keep all connector X positions derived from `--classification-branch-x`, `--classification-depth-step`, and `--classification-toggle-center-x`; introduce no independent `left` pixel constants.

- [ ] **Step 10: Remove superseded sidebar rules**

Delete the old selectors that would compete with the new system:

```css
.classification-sidebar__tree ul[role="group"]::before
.classification-sidebar__tree ul[role="group"] > .classification-sidebar__tree-item:last-child::before
.classification-sidebar__tree ul[role="group"] > .classification-sidebar__tree-item:last-child::after
.classification-sidebar__quick-view[aria-current="page"] {
  box-shadow: inset var(--selection-indicator-width) 0 var(--color-accent);
}
.classification-sidebar__quick-view[aria-current="page"],
.classification-sidebar__tree-row[aria-selected="true"] {
  background: var(--color-selected);
}
```

Retain unrelated shared UI, drag overlay, toast, toolbar, inspector, and gallery styles unchanged.

- [ ] **Step 11: Run automated verification**

From `C:\chatgpt\app`, run each command separately:

```powershell
npm.cmd test -- ClassificationSidebar.test.tsx
```

Expected: all sidebar tests PASS.

```powershell
npm.cmd run check
```

Expected: the complete Vitest suite and TypeScript/Vite production build PASS with no unused imports or type errors.

- [ ] **Step 12: Perform Windows Tauri visual acceptance**

Start the existing live-development launcher from `C:\chatgpt` or run this command in `C:\chatgpt\app`:

```powershell
npm.cmd run tauri dev
```

Inspect all of these concrete states before closing the verification session:

1. `저장소`, `미분류`, `최근`, `즐겨찾기`, `유사 검토`, `망가`, `휴지통`, and `설정` have 34px rows, 2px gaps, compact neutral selection, and no blue left bar.
2. Selected leaf and expandable folder rows show a 30px content-sized neutral surface; the triangle itself brightens while its background remains transparent.
3. At least three expanded depths keep every child triangle on the parent icon/line axis and every child icon on the next 24px axis.
4. Every triangle has visually equal 4px line gaps above and below; a first expandable child has no line segment descending into its triangle.
5. An expanded folder followed by a same-depth sibling has one straight line ending with visible breathing room before the next sibling icon; it does not continue to a later sibling.
6. A last leaf child has one rounded bend; a last expandable child has no bend.
7. A long name ellipsizes inside the surface at the 176px minimum sidebar width.
8. Folder and album sections do not clip or overlap.
9. Hover remains weaker than selection, focus remains visible, valid/invalid drag targets remain visible, and right-click and keyboard context menus still open above inline editors.

- [ ] **Step 13: Commit the sidebar styling**

```powershell
git add app/src/classification/ClassificationSidebar.tsx app/src/classification/ClassificationSidebar.test.tsx app/src/styles/tokens.css app/src/styles/global.css
git commit -m "style: refine Eagle-style sidebar hierarchy"
```
