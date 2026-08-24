# Asset gallery compositing design

## Problem

During rapid virtual-row replacement, WebView2 can briefly retain pixels from the previous transformed row. Asset Gallery rows are transparent between their tiles, so those stale pixels appear as narrow duplicate-image strips in the horizontal gallery gaps.

The status bar also replaces the loaded asset count with `자산을 불러오는 중입니다.` whenever any asset page is pending. The user no longer wants that loading message.

## Design

- Give each `.asset-gallery__row` an opaque `var(--color-bg)` background so its tile gaps cannot reveal pixels from another composited row.
- Restore `VIRTUAL_OVERSCAN_ROWS` from `8` to its original value of `3`. The increase was based on the superseded gray-band diagnosis; the actual gray band was the pagination skeleton removed in commit `65cb7c2`.
- Make the status bar always render `${status.loadedCount}개 자산` in its leading status slot, regardless of `status.loading`.
- Keep `AssetBrowserStatus.loading` unchanged because other consumers may still use the state and removing it is outside this visual fix.
- Do not change virtual-row positioning, pagination, date-rail behavior, or image layout.

## Verification

- Update the status-bar test to prove that a loading state still shows the loaded asset count and does not show the removed loading sentence.
- Add a gallery rendering assertion that virtual rows use the opaque gallery background.
- Run the focused status-bar and Asset Gallery tests.
- In the running Tauri development app, perform rapid wheel scrolling and date-rail dragging and inspect the tile gaps for duplicate imagery.
