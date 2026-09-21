# Lakomics Collector

The active extension is `extension-list/`. Load this directory as the unpacked
extension. After updating it, reload the extension and the collecting page so the
new content scripts are active. The existing connection and portable profile are
retained.

## Edge menu

Version 3.0.0.30 uses a semicircle attached to the selected screen edge. Image
dragging on desktop requires a held press of at least 250 ms and movement of
12 px. Touch requires a stationary 500 ms long press. Releasing early, scrolling,
losing window focus, or cancelling the pointer cancels the pending opening. Releasing the opening finger never selects a folder or saves an image.
The menu uses the approved dark One UI-inspired treatment: graphite surfaces,
blue selection, rounded separated sectors and a radial gap around the center.
Selected sectors retain their blue face while hovered; neutral hover/press colors
apply only to unselected sectors.
One continuous central panel contains a larger upper Save action and a smaller
lower Temporary save action, which becomes Back inside folders. Actions use
outline icons with accessible labels and distinct keyboard focus, without repeated
destination text, selection checkmarks or branch chevrons.
Temporary save stays disabled when unsupported and in the settings preview.
Returning to the first screen disables it for 400 ms to guard repeated Back taps.
Folder labels contain only their names. Folders with children expose a subtly
offset rear surface within the sector's bounds. The live collector uses the outer ring as a
bounded rotary dial: six folders stay visible while overflow folders rotate in.
Desktop mouse-wheel/trackpad input drives the ring while the pointer is over the
outer arc; touch and pointer drags follow the semicircle directly. Wheel input adds
bounded momentum to one continuous dial position instead of choosing a target slot
up front. The ring coasts under friction, then captures the nearest slot only after
velocity falls below the detent threshold, producing a late mechanical stop rather
than a page-like snap. Visible folder nodes remain mounted while their geometry is
rebased continuously. Runtime labels are not recycled with the fixed physical
wedge pool: every child label is mounted once when its folder opens, then follows
the continuous dial position directly. Labels use a separate overlay outside each
wedge clip-path and fade smoothly near the arc edge. At rest, runtime labels snap
to device-pixel coordinates for crisper tablet text without quantizing motion. The central Temporary/Back and Save
surfaces never rotate and do not capture wheel scrolling.

- The first screen shows six visible slots, using the order edited in settings. Initially, pinned shortcuts precede
  root classifications. If there are more than six, rotate the outer ring to
  reveal the remaining roots and shortcuts.
- Pinned shortcuts appear only on the first screen, not again among their
  canonical siblings. Unpinning restores them to the original child order.
  This affects menu presentation only; the classification hierarchy is retained.
- Inside a folder, all six wedges can show children. Runtime wedge spacing uses a
  fourteen-position circular geometry so one middle wedge can face the screen center
  while the sixth visible wedge remains fully inside the semicircle. Lists of six or
  fewer are centered as a group. Preserved empty layout slots are compacted out of
  the live dial so scrolling never exposes a blank wedge between real folders.
- On coarse-pointer portrait devices such as a tablet, the live dial radius is
  capped at 208 px to preserve touch targets while reducing visual bulk. Fine-pointer
  desktop use caps at 200 px. Initial wheel and release momentum is deliberately
  restrained; the existing late detent stop remains unchanged.
- Tap any folder once to select it, including a branch or pinned shortcut.
  Double-tap the same folder within 350 ms to enter its children. Selection is
  immediate; neither tap submits media. The central Save button saves to the
  selected folder, so roots and branches are directly saveable.
- Back, below Save, follows visited screens and restores the previous dial
  position and selection. Entering a pinned shortcut and going back returns to
  the first screen, rather than inserting that shortcut's canonical ancestors.
  Dial movement does not add history entries.
- The opening press determines the edge: the left half of the visible screen
  opens the left menu, and the right half opens the right menu. There are no
  direction or close buttons. Tap outside the curved menu, including its
  transparent corners, or press Escape to dismiss it. Saving and the opening
  finger lock prevent accidental dismissal. Short windows allow the panel to
  scroll rather than shrinking targets indefinitely.
- Temporary saving occupies the root screen's smaller lower central area.
  Android retains the image-only temporary album intent; it does not send MP4 to
  that image contract. PC supports images and X progressive MP4/GIF-like videos,
  starting a browser download
  without a save dialog; choose Desktop once in the browser download settings.
  Filename collisions are renamed, and download errors keep the menu available.
  Download-start feedback is not a claim that the file has finished downloading.
  There is no additional temporary-save button below the arc. Permanent saves use the existing server capture
  flow; this change does not alter connection or ingestion behavior.

Entrance fades and moves inward by 8 px over 140 ms. Folder navigation keeps the
ring stationary: one inert, accessibility-hidden outgoing snapshot fades over
140 ms while new controls fade in over 180 ms and work immediately. Repeated
navigation replaces the snapshot instead of queuing transitions. Successful saves
release menu ownership immediately and show a concurrent 100 ms icon/exit effect;
failed or pending saves never receive success feedback. Reduced motion skips these
effects and post-release dial coasting.

Navigation tears down both pending and mounted sessions, including busy or
opening-finger-locked menus, without claiming an accepted save was cancelled.
Committed Navigation API changes and page departure are observed; older browsers
use history/hash events and a session-only URL poll. Stale replies cannot reopen
or unlock a newer menu. Idle pages do not poll.

The server's classification tree and portable pins/order remain authoritative.
Local slot positions are retained across snapshot refreshes: deleting a folder
leaves its stored/editor slot empty, and new folders fill empty slots before
appending. The live collector compacts those preserved holes for presentation
only. Explicit pin or sibling-order edits rebuild the affected slot layout. Local
slot history is not sent as a server profile field.

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
PageUp/PageDown (one dial step in the live collector), ArrowRight to open children,
Ctrl+Enter to save, and Escape to dismiss. The settings editor keeps its existing
page controls and allows normal Tab navigation out to other settings.

## Connect a PC browser

In PC Lakomics, open Settings → Cloud → PC extension connection. This creates and
copies a short-lived pairing link. Open the Lakomics extension icon in the PC
browser, paste into Connection link, and press Connect. The PC panel also offers
Copy link and Reissue if needed. Tablet QR connection remains a separate button.
Both methods use the existing pairing endpoint and session/profile contract;
no server deployment, extra browser permission, or new credential type is needed.

## X saving and translation

X GIF-like animations are commonly delivered as MP4. A mounted progressive
`https://video.twimg.com/*.mp4` resource (including a video's `source` child) is
retained without a public lookup. For blob/HLS players, the collector first asks
a small page-world observer for the matching progressive MP4 from GraphQL
responses X has already received. It observes fetch/XHR response copies from
same-origin X GraphQL endpoints without reading cookies or request headers, making
extra network requests, or consuming X's original response. The in-memory cache
retains at most 200 post IDs and their all-media-indexed URLs, not raw tweets. Only
the requested ID, ordinal and validated `video.twimg.com` MP4 cross the bridge;
a page reply never triggers a capture or download by itself. Both permanent saves
and PC temporary downloads use this lookup on explicit save, and navigation
invalidates a pending lookup. No additional extension permission is needed.

If no matching page metadata is available, the worker still resolves the selected
media through X's public syndication endpoint with a bounded request and chooses
the highest-bitrate progressive MP4. Manifests and still posters are not downloaded
as animations. The original MP4 bytes stay MP4 and use the existing `video` capture
contract; this is not GIF conversion. Actual GIF image handling is unchanged.

Media identity includes the selected all-media ordinal, including mixed photo/video
posts and quoted-post boundaries. An unavailable or invalid selected variant fails
rather than falling back to another video. Public resolution may be unavailable
for some posts even when their logged-in page can play the media. Browser temporary
download feedback confirms initiation, not completion. The supplied example post
`2100596455262331116` was not publicly verifiable; this is not a claim that it is
private or deleted, nor live download acceptance. Public lookup for the reported
post `2101939591297294668` returned `TweetTombstone` without media or a reason on
2026-09-21. The user confirmed playback in a logged-in X page. The page-metadata
path now covers this failure class when X supplies a progressive MP4 variant;
actual logged-in download acceptance for that post remains unverified. A post
with neither a mounted MP4 nor usable page/public metadata still fails closed.
Reload both the extension and X tab after updating so the page observer starts
before X requests the tweet. A page refresh clears the metadata cache. This path
requires a Chromium runtime supporting manifest `world: "MAIN"`; Android/Titanium
acceptance has not been verified. HLS-only media without an MP4 variant is not
converted or downloaded as a manifest.

Successful permanent X saves automatically like the saved post when the existing
Save auto-like preference is enabled. Already-liked posts are left liked. Quote
media retains its own post ID, including video thumbnails before a video element
is mounted. If the matching like control is absent or does not confirm, the
existing X session sends a bounded FavoriteTweet request for that exact post ID.
Like failure is reported separately from successful media capture. X can change
this private web endpoint; a fixture success does not establish live acceptance.

AI translation uses OpenRouter into Korean, with `google/gemini-3.1-flash-lite`
as the default and `google/gemma-4-26b-a4b-it` as an optional model. Options
retain an API key, model selection, one automatic on/off switch and Clear cache.
Changing models clears the shared translation cache so results from different
models are not mixed. On X, a
compact floating translation icon opens the same controls in a small popover.
Other providers, automatic model fallback, manual translate, diagnostics and
tuning remain removed. Existing OpenRouter keys and automatic preferences migrate
locally; retired provider settings and pre-3.1 translation caches are removed.
Keys stay in extension storage and the worker: they are never returned to X
content scripts or synced with the server profile. The worker is warmed as soon as
the content script starts, and the first visible scan bypasses the normal debounce.
The tweet nearest the viewport center gets a single fast-lane request whose result
renders immediately, while the second request slot translates up to four more posts
in parallel. Later work remains grouped up to four per model call, with at most two
model calls in flight. Links, hashtags, mentions,
emoji and explicit line breaks are retained; link placeholders must stay in their
original order. Results use text nodes, not model HTML. Translation cards use
X-aware light/dim/lights-out contrast with blue link accents. Network, timeout and
server failures retry once. Unchanged failures are not re-requested by unrelated
page mutations; transient failures can retry after leaving and re-entering the
viewport. Other failures remain parked until the post changes or translation is
reset. Short Han/Kana posts remain eligible even below three letters.
429 responses honor a bounded cooldown (1.5 seconds if `Retry-After` is missing
or invalid), without treating the API key as missing. Each unchanged post stops
automatic retries after three rate-limited content requests; each worker request
still has at most one network retry. Authentication/payment failures pause
new requests until translation settings are refreshed. The bounded cache is
shared across tabs, and disabling auto or clearing it invalidates in-flight results.

Reload the extension and X tabs after updating. The new PC temporary-download
path requires the browser's downloads permission. The extension does not change
the browser's default download directory itself. Windows and Linux use the same
browser setting; Android keeps the native temporary-album path.

## Verification

Run `npm test` from this directory. DOM tests use the existing jsdom installation
in `../_tools/app/node_modules`; no separate dependency installation is needed.
They cover navigation, runtime dial motion, settings paging, stable slots,
input-release protection, explicit save, retries, and existing collector behavior. Browser fixture checks do not
establish Android/Titanium native touch or live-server capture acceptance.
