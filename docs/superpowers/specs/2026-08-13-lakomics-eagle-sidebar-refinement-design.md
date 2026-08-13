# Lakomics Eagle-Style Sidebar Refinement Design

## Goal

Refine the Lakomics classification sidebar so its hierarchy, spacing, and selection treatment feel as orderly as Eagle Cool while preserving Lakomics' quiet, dense desktop-tool identity.

This change is visual and interaction-preserving. It does not alter folder or album data, hierarchy rules, commands, context menus, drag-and-drop behavior, or keyboard navigation.

## Design Principles

- The sidebar reads as one navigation tree rather than a stack of button-shaped rows.
- Selection uses a compact neutral surface instead of a wide accent bar.
- Hierarchy lines follow folder geometry instead of arbitrary indentation offsets.
- Triangles, folder icons, text, and branch lines share a consistent depth grid.
- The result uses Lakomics design tokens and avoids glow, shadow, gradients, large radii, and decorative animation.

## Quick Views

The quick-view rows are `저장소`, `미분류`, `최근`, `즐겨찾기`, `유사 검토`, and `망가`. The footer rows `휴지통` and `설정` use the same visual treatment.

- Increase quick-view row height slightly to 34px.
- Keep 2px between adjacent quick-view rows.
- Remove the blue left-side selection indicator.
- A selected row uses the same neutral selection surface as a selected folder or album.
- The selection surface wraps only the icon, label, and optional count plus its horizontal padding. It does not fill the sidebar width.
- Selected icons and labels become brighter without glow or shadow.
- Unselected icons remain lower contrast than their labels.
- Counts remain lower contrast than labels in both selected and unselected states.

## Tree Rows and Selection

- Folder and album rows remain 32px high.
- The selection surface is 30px high with a 6px radius, sourced from shared design tokens.
- The surface begins before the folder icon and ends after the title. It uses content width, subject to the available sidebar width.
- Long names truncate with an ellipsis inside the compact selection surface.
- The triangle and hierarchy line remain outside the selection surface.
- A selected row does not add a full-width background or a left accent indicator.
- Keyboard focus remains independently visible using the existing focus treatment. Removing the blue selection indicator must not remove keyboard focus visibility.

## Expansion Triangles

- Use a small filled triangle rather than a chevron stroke icon.
- The triangle background is always transparent.
- Selection changes only the triangle shape color; it does not add a colored or glowing area behind the triangle.
- Closed triangles point right. Open triangles rotate downward around their center.
- The triangle center sits on the same X axis as the parent folder icon center and the associated vertical hierarchy line.

## Hierarchy Geometry

Each depth advances by one shared 24px indentation step. Geometry derives from the folder icon center rather than independent row padding values.

For every expanded folder:

1. The parent folder icon center defines the vertical branch axis.
2. A direct child's expansion triangle center uses that same axis.
3. The child folder icon center defines the next depth's branch axis.
4. Branch colors use the folder's configured appearance color when present; otherwise they use the neutral hierarchy-line token.

The implementation must derive these positions from shared CSS custom properties or design tokens. It must not maintain separate unrelated pixel offsets for triangles, icons, and lines.

## Triangle Clearance

The triangle is 8px high. A vertical hierarchy line never passes behind or through it.

- Leave 4px between a line ending and the triangle's top edge.
- Leave 4px between the triangle's bottom edge and a line starting again.
- Apply the same clearance at every depth and for every branch color.
- When the first direct child immediately below an expanded parent has a triangle, omit the segment from the parent folder icon to that triangle. Start the vertical line 4px below the triangle instead.

This produces the shared rhythm:

```text
line end → 4px → triangle (8px) → 4px → line start
```

## Same-Depth Boundary Line

When an expanded folder's visible descendant block is followed by another folder at the same depth, draw one straight vertical boundary line on the expanded folder's icon-center axis.

- The line passes alongside the visible descendant block without horizontal bends.
- It identifies the boundary between the expanded folder and the first following folder at the same depth.
- It stops before that next same-depth folder rather than continuing through later siblings.
- It ends 8px above the next same-depth folder icon's top edge.
- In the approved example, the line connects the expanded `게임` block toward `기타`; it does not continue to `만화`.
- Folder names are examples only. Rendering is determined by depth and visible tree structure, never by names.

## Last-Child Termination

Child branch termination depends on the last visible direct child:

- If the last child has no expansion triangle, finish the branch with one rounded bend toward that child.
- If the last child has an expansion triangle, do not draw the rounded bend. End the vertical line 4px above the triangle.
- Intermediate children do not each receive a bend. The vertical line continues past them, interrupted only by triangle clearance.

## Color and Surface Hierarchy

- Sidebar background remains a quiet dark neutral surface.
- Selection uses a neutral gray surface shared by quick views, folders, and albums.
- Blue is not used as a persistent selection indicator in the sidebar.
- Folder appearance colors may affect the folder icon and its owned child branch line.
- Selection does not recolor branch lines.
- Hover is weaker than selection and uses no scale or translation.
- No new shadows, gradients, glow effects, or card wrappers are introduced.

## Implementation Scope

The change should stay within the existing sidebar component and design-token styles:

- Reuse `ClassificationSidebar` and its existing semantic tree markup.
- Preserve `role="tree"`, `role="treeitem"`, `aria-expanded`, `aria-selected`, focus handling, context menus, and drag targets.
- Replace visual chevron rendering only if needed to achieve the filled-triangle design; do not change expand/collapse behavior.
- Prefer CSS pseudo-elements and existing icon interfaces over new dependencies or visual wrapper components.
- Add semantic sidebar tokens only when an existing token cannot express the approved spacing or surface.

## Verification

Automated checks must cover:

- quick-view selection no longer relies on the left accent indicator;
- quick-view and tree selection surfaces remain content-sized;
- hierarchy classes and data attributes still reflect expanded state and configured color;
- accessibility roles, selection state, focus, context menu, and keyboard behavior remain intact;
- the full frontend test suite and production build pass.

Windows Tauri visual acceptance must inspect:

1. quick-view spacing and neutral selection;
2. a selected folder with and without an expansion triangle;
3. at least three visible hierarchy depths;
4. equal 4px line clearance above and below triangles;
5. a straight same-depth boundary line ending 8px before the next sibling icon;
6. a last child without a triangle receiving one rounded bend;
7. a last child with a triangle receiving no bend;
8. long folder names and the minimum supported sidebar width;
9. hover, keyboard focus, drag target, and context-menu states;
10. folder and album sections using the same rules without clipping or overlap.
