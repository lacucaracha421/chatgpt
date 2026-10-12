# Changelog

## 3.5.36 — 2026-10-13

- Add the Arca Live image picker (COLLECTOR-PICKER-001, desktop Chrome, new-post page
  `arca.live/b/*/write*` only). A Lakomics button after Arca's "이미지 업로드" toolbar
  button and the `Alt+Shift+L` command (rebindable at chrome://extensions/shortcuts) open a
  docked panel in a closed shadow root. Choose a PC library folder (optionally with its
  sub-folders), browse 18 random thumbnails, press 다른 그림 for more without repeats, select
  in order, then 본문에 넣기. The panel stays open; a failed picture stays selected (red number)
  while the rest continue, and 다시 시도 retries it. The toolbar icon is drawn in the focus blue
  (#2f6fdb light / #7db1ff dark) so it stands out from Arca's grey icons.
- Insertion hands each original to Arca's own editor as a synthetic paste (one drop fallback)
  at the remembered caret, so Arca uploads it; success is a new image hosted on Arca's image
  host, with a 60 s limit per picture. The event is dispatched by a small page-world helper
  (`src/picker/page-bridge.js`, MAIN world, this page only); if it does not answer, the content
  script dispatches the event itself. `#content` is never written and the post is never submitted.
- The service worker is the only holder of the PC connection key and the only caller of the PC
  service (`http://127.0.0.1:32145`, bearer key + `X-Lakomics-Extension-Id`). Thumbnails and
  originals reach the panel as base64 messages and are shown from blob URLs inside the shadow root;
  originals are fetched one at a time, only at insert. Add the key in settings › 연결 › PC 연결 키
  (copy it with PC Lakomics › 설정 › 브라우저 확장 › 키 복사).
- Requires a PC Lakomics build that contains the picker API (`/v1/picker/*`).
Manual acceptance on a real Arca Live draft is still needed (see the task report): the
isolated/page-world paste, large or several pictures, theme colours and the layout with Arca's
own right column were not exercised in a browser.

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
