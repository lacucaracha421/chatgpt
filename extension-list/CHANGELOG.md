# Changelog

## 3.5.46 — 2026-10-16

- Image translation keeps exactly one overlay and button group per image even when two
  translations start for it, follows an image the page re-renders (pixiv), and skips
  hidden duplicate images.

## 3.5.45 — 2026-10-16

- Translation notes and their button group scroll with the page natively (no jitter);
  they are repositioned only when the layout changes.
- Translating the same image again no longer leaves a second button group behind.
- The save window, its errors and status toasts always appear above translation notes.

## 3.5.44 — 2026-10-16

- Overlapping translation notes are separated (narrower shape first, then a small move,
  4px apart); notes that still overlap stack smallest on top and come forward on hover
  or touch.
- 원문 is a toggle: in original mode only a small 번역 chip stays and the other buttons
  fold away. The button group sits below (or above) the image when there is room.
- Image translation defaults to Claude Sonnet 5.5. Gemini 3.5 Flash Lite image requests
  get room for its mandatory reasoning; an unusable answer says the image was unreadable.

## 3.5.43 — 2026-10-16

- Translation notes follow the visible part of cropped or letterboxed images (X timeline
  crops), and text cut off by the crop gets no note.
- Text boxes are requested in each model's own convention: Claude gets the exact image
  size and answers in pixels; Gemini answers [ymin, xmin, ymax, xmax] on 0–1000.

## 3.5.42 — 2026-10-16

- Image text translation now lays solid translation notes over each text block on the
  picture instead of numbered markers and a list window; notes wrap by word, never go
  below 14px, mark sound effects with a small tag, and a corner bar offers 원문 (hold),
  모두 복사, 저장 and close. Tapping a note shows its original and a copy button.
- Arc save menu: dragging the centre toward the screen edge translates the image
  (violet fill); dragging down saves temporarily at the top level and goes back inside
  a folder; the path chips above the menu are gone; the accent is ivory.
- Touch: the menu opens at the pressed height on the nearer edge. PC: the mouse Back
  button goes up a folder (closes at the top) while the menu is open.
- The two-finger hold translation gesture was removed.

## 3.5.41 — 2026-10-16

- Tablet: after a touch or pen text selection settles, a small "번역" chip appears near
  the selection (above it, clear of the native toolbar, kept on screen) and translates
  the selection in the existing popover; mouse selections never show it.
- The custom right-click menu now opens on more sites: a capture-phase listener runs
  before page handlers but yields to pages that own their menu (editors, maps, games,
  a protected list), with a per-site switch in settings. Chrome's PDF viewer and other
  restricted pages cannot host it; use Chrome's menu or Shift+right-click there.
  Coverage notes: options/context-menu-coverage.md.

## 3.5.40 — 2026-10-13

- Tablet: moving between pictures in the preview keeps the same surface (no flash), and a
  rightward swipe closes the preview or the whole panel; the preview's close button and arrows
  are visible again.

- Server picker batches include signed thumbnail tickets, reused only inside the
  service worker until 30 seconds before expiry. Expired or failed inline tickets
  fall back to the thumbnail ticket route without exposing URLs to the panel.
- First-batch checks verify thumbnails only and reuse permitted HEAD metadata;
  originals are checked when requested for insertion. The panel loads nine
  thumbnails at a time while retaining the decoded-grid swap and 1.5-second cap.

## 3.5.39 — 2026-10-13

- The Arca picker uses the paired Lakomics server directly on Android/Helium or
  without a PC picker key. Desktop tries the PC first and falls back only on an
  unreachable PC; PC authorization and privacy refusals remain final.
- Server media tickets are downloaded only by the service worker. Pairing tokens
  and signed URLs never reach the panel/page, and downloads enforce size limits
  against both Content-Length and streamed bytes.
- Server folder order and pins follow the PC-published display settings; character
  and group membership/order follow the published character projection. Requires
  the new server picker API and PC display publication build.

## 3.5.38 — 2026-10-13

- The Arca Live picker follows the PC sidebar folder arrangement and the series/group
  screens' stored group and character order, including search matches. Groups, loose
  characters and sub-folders retain the series screen's section order.
- PC-pinned folders appear in a top 고정 section in pin order and remain in the full tree.
  Requires the PC picker API with explicit `order`, `pinned` and `pinOrder` fields.
  Older PC responses retain their supplied order and show no pin section.

## 3.5.37 — 2026-10-13

- Arca Live image picker: besides library folders the panel can pick from a character or a
  character group (COLLECTOR-PICKER-001). In the folder popover each series folder lists its
  groups (expandable to their characters), then its characters without a group, then its
  sub-folders, each with its image count and a small folder / group / character icon.
  Searching matches characters and groups by name too and shows their series path beside them.
  The header button names the chosen scope with its path. 하위 폴더 포함 only applies to folders,
  so it is hidden for a character or group (the count keeps its place). The last scope,
  folder or character/group, is remembered like the last folder.
- A character's pictures are the ones the PC's character folders show: every current acceptance
  (manual and automatic) plus its reference pictures; a group is the union of its enabled
  characters and its own 기타. Needs a PC Lakomics build whose `/v1/picker/folders` answers with
  `characters` and whose `/v1/picker/batch` accepts `scope`; an older PC still lists folders only.
- A character or group that disappeared or was switched off on the PC sends you back to the
  popover with a message, like a missing folder.

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
