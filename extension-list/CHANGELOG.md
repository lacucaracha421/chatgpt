# Changelog

## 3.5.35 — 2026-10-13

- Enable the custom menu on HTTP pages and in HTTP(S), inherited about:blank,
  and srcdoc frames. Site exclusions use the top page host. Page downloads remain
  whole-tab actions and are unavailable from frames.
- Add video/audio URL copy, video poster download, and current-frame PNG download.
  Explain CORS, DRM, and unavailable video frames in Korean. Current-frame saving
  to Lakomics requires an image-byte upload API; the existing remote-URL capture
  API cannot accept a canvas image, so that item explains the limitation.
- Let Shift+right-click reach the browser while collection or translation owns
  a gesture.
- Open the custom menu after a 500 ms touch hold on links or existing selections.
  Preserve image picker holds, native selection gestures, and two-finger
  translation. Cancel pending holds on movement, scrolling, or multiple touches.
- Hide direct page clipboard actions when the Clipboard API is unavailable.
  Translated-copy actions continue using the extension's offscreen clipboard.

Manual acceptance is still needed in Chromium/Helium for cross-origin and
inherited frames, touch selection handles, duplicate native menus/clicks, player
controls, viewport placement, and animation. No browser automation was used.
