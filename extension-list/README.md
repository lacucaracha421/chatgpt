# Lakomics Collector

The active extension is `extension-list/`. Load this directory as the unpacked
extension. After updating it, reload the extension and the collecting page so the
new content scripts are active. The existing connection and portable profile are
retained.

## Edge menu

Version 3.0.0.13 uses a semicircle attached to the selected screen edge. Image
dragging on desktop requires a held press of at least 250 ms and movement of
12 px. Touch requires a stationary 500 ms long press. Releasing early, scrolling,
losing window focus, or cancelling the pointer cancels the pending opening. Releasing the opening finger never selects a folder or saves an image.
The menu uses a warm paper palette and thin divisions inspired by NieR. The inner
semicircle is split horizontally into equal upper-action and Save surfaces.
The upper action is Temporary save on the first screen and Back inside folders.
Temporary save stays disabled when unsupported and in the settings preview.
Returning to the first screen disables it for 400 ms to guard repeated Back taps.
Folder labels contain only their names. A thick dark band on a sector's outer
curve marks folders with children; pagination keeps its page count.

- The first screen shows six fixed slots, using the order edited in settings. Initially, pinned shortcuts precede
  root classifications. If there are more than six, the page button below the
  semicircle makes the remaining roots and shortcuts accessible.
- Pinned shortcuts appear only on the first screen, not again among their
  canonical siblings. Unpinning restores them to the original child order.
  This affects menu presentation only; the classification hierarchy is retained.
- Inside a folder, five slots show children and the bottom sixth slot changes
  pages. The last page returns to the first; a single-page folder keeps that slot
  disabled. Empty slots keep their positions.
- Tap any folder once to select it, including a branch or pinned shortcut.
  Double-tap the same folder within 350 ms to enter its children. Selection is
  immediate; neither tap submits media. The central Save button saves to the
  selected folder, so roots and branches are directly saveable.
- Back, above Save, follows visited screens and restores the previous page and
  selection. Entering a pinned shortcut and going back returns to the first
  screen, rather than inserting that shortcut's canonical ancestors. Paging does
  not add history entries.
- The opening press determines the edge: the left half of the visible screen
  opens the left menu, and the right half opens the right menu. There are no
  direction or close buttons. Tap outside the curved menu, including its
  transparent corners, or press Escape to dismiss it. Saving and the opening
  finger lock prevent accidental dismissal. Short windows allow the panel to
  scroll rather than shrinking targets indefinitely.
- Temporary image saving occupies the root screen's central upper half.
  Android uses the existing temporary album intent. PC starts a browser download
  without a save dialog; choose Desktop once in the browser download settings.
  Filename collisions are renamed, and download errors keep the menu available.
  Download-start feedback is not a claim that the file has finished downloading.
  There is no additional temporary-save button below the arc. Permanent saves use the existing server capture
  flow; this change does not alter connection or ingestion behavior.

The server's classification tree and portable pins/order remain authoritative.
Local slot positions are retained across snapshot refreshes: deleting a folder
leaves its slot empty, and new folders fill empty slots before appending. Explicit
pin or sibling-order edits rebuild the affected slot layout. Local slot history
is not sent as a server profile field.

Settings embed the same semicircle. Tap a folder to select it, then use Previous
slot / Next slot to move it, including across pages. Root shortcuts and ordinary
roots can be interleaved. Open children with the central Open button or a double
tap; settings never submit media. Failed order updates retain the current view.

Hide removes the selected folder and all its descendants from the collector,
including their pinned shortcuts. Hidden folders can be restored in settings;
hiding does not delete or reparent classifications. Hidden IDs are stored only in
this browser, separate from the server profile, and survive refresh/reopening.
Visible folders close the hidden gaps; restoration recovers their underlying
positions. Disconnect clears these connection-specific local preferences.

Keyboard users can navigate with Tab, arrow keys, Enter/Space, Backspace,
PageUp/PageDown, ArrowRight to open children, Ctrl+Enter to save, and Escape to
dismiss. The settings editor allows normal Tab navigation out to other settings.

## Connect a PC browser

In PC Lakomics, open Settings → Cloud → PC extension connection. This creates and
copies a short-lived pairing link. Open the Lakomics extension icon in the PC
browser, paste into Connection link, and press Connect. The PC panel also offers
Copy link and Reissue if needed. Tablet QR connection remains a separate button.
Both methods use the existing pairing endpoint and session/profile contract;
no server deployment, extra browser permission, or new credential type is needed.

## X saving and translation

Successful permanent X saves automatically like the saved post when the existing
Save auto-like preference is enabled. Already-liked posts are left liked. Quote
media retains its own post ID, including video thumbnails before a video element
is mounted. If the matching like control is absent or does not confirm, the
existing X session sends a bounded FavoriteTweet request for that exact post ID.
Like failure is reported separately from successful media capture. X can change
this private web endpoint; a fixture success does not establish live acceptance.

AI translation uses only OpenRouter `google/gemini-2.5-flash-lite`, into Korean.
Options retain an API key, one automatic on/off switch and Clear cache. The small
X panel mirrors automatic on/off and Clear cache, and links to options. Other
providers, model selection/fallback, manual translate, diagnostics and tuning are
removed. Existing OpenRouter keys and automatic preferences migrate locally;
retired provider settings and old caches are removed. Keys stay in extension
storage and the worker: they are never returned to X content scripts or synced
with the server profile. Visible tweets are translated, including quote text;
links, hashtags, emoji and explicit line breaks are retained. Results use text
nodes, not model HTML. The bounded cache is shared across tabs. Disabling auto or
clearing the cache invalidates in-flight results; authentication/quota failures
stop new requests until the setting is retried.

Reload the extension and X tabs after updating. The new PC temporary-download
path requires the browser's downloads permission. The extension does not change
the browser's default download directory itself. Windows and Linux use the same
browser setting; Android keeps the native temporary-album path.

## Verification

Run `npm test` from this directory. DOM tests use the existing jsdom installation
in `../_tools/app/node_modules`; no separate dependency installation is needed.
They cover navigation, paging, stable slots, input-release protection, explicit
save, retries, and existing collector behavior. Browser fixture checks do not
establish Android/Titanium native touch or live-server capture acceptance.
