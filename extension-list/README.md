# Lakomics Collector

The active extension is `extension-list/`. Load this directory as the unpacked
extension. After updating it, reload the extension and the collecting page so the
new content scripts are active. The existing connection and portable profile are
retained.

## Edge menu

Version 3.0.0.34 uses a semicircle attached to the selected screen edge. Image
dragging on desktop requires a held press of at least 250 ms and movement of
12 px. Touch requires a stationary 500 ms long press. Releasing early, scrolling,
losing window focus, or cancelling the pointer cancels the pending opening. Releasing the opening finger never selects a folder or saves an image.
The menu uses the approved dark One UI-inspired treatment: graphite surfaces,
blue selection, rounded separated sectors and a radial gap around the center.
Selected sectors retain their blue face while hovered; neutral hover/press colors
apply only to unselected sectors.
The live center is one Save button filling the entire half-disc, with a centered
outline icon and no lower button or divider. Its icon uses direct placement on
either edge. It has an accessible name and gesture description, keyboard focus,
and no tooltip or repeated destination text. Without a selection it looks disabled
but still accepts Back and Temporary gestures. Settings keep their existing Open
button and lower Back control.
The live collector shows breadcrumb pills above the arc, or below it in short
windows. Muted ancestor pills follow the folders actually entered (including
shortcut Back history); the selected destination is blue. The row is hidden at
root without selection, keeps the entered path when selection is empty, and
collapses overflowing early ancestors into “…” while retaining the last two
ancestors and selection within two lines. Both edge alignments preserve normal
text order. The pills do not intercept outside taps and are absent in settings.
Only appended pills grow/fade in (180 ms); sibling selections crossfade text and
width in the same pill (140 ms). Back fades removed pills out (120 ms), and another
Back immediately finishes an outstanding removal. Reduced motion is instant.
Drag vertically from the live center: up goes Back one visited level; down starts
Temporary save on any screen. Touch, pen and mouse use the same rules. Movement
under 10 px remains a Save tap; at 10 px the direction locks, and a horizontal or
diagonal tie cancels without saving. Vertical gestures commit at 48 px on release.
Progress reveals a green #2f7d5b face from below for Temporary or a neutral #39495f
face from above for Back. Download rises or Back descends by up to 24 px while
fading in; Save moves away in the opposite direction and fades out. Drag and
trackpad progress follow directly; wheel notch steps ease out over 120 ms. The full
face holds for 120 ms before acting, except an upward notch with no down-progress
still goes Back immediately. Cancelling or releasing below threshold drains in
150 ms; Temporary failures keep the menu and drain too. Pointer capture keeps
tracking outside the panel, and a drag's following click cannot save. Up at root
and unsupported Temporary show no commit state and do nothing. Opening-finger
locks, pending saves and the commit hold block actions. Reduced motion shows
progress instantly without sliding or animated steps/returns; actions still work.
Folder labels contain only their names, without underlines or text outlines.
Keyboard focus changes the wedge face (including selected wedges); opening or
using the menu with a pointer does not highlight the programmatically focused
first wedge. Keyboard opening and subsequent keyboard use show focus. Folders with children expose a subtly
offset rear surface within the sector's bounds. The live collector uses the outer ring as a
bounded rotary dial: six folders stay visible while overflow folders rotate in.
The next hidden folder peeks halfway into each arc end where more folders remain,
with a dimmed wedge and fading label clipped by the semicircle. Tapping a peek
rotates one slot without selecting it; dragging it rotates the ring. The same
wedge and label move continuously into view. Peeks stay out of keyboard navigation
and assistive technology; the ring exposes a folder count and scrolling hint.
Ends without more folders stay empty, including during rubber-band overscroll.
Desktop mouse-wheel/trackpad input drives the ring while the pointer is over the
outer arc. Touch and pointer drags track the finger angle directly, with rubber-band
resistance at either end (0.55 resistance, 1.5-slot span). Release uses the last
100 ms of samples, discards momentum after a 60 ms stationary hold, and projects a
slot with 0.998-per-ms deceleration. One critically damped motion reaches that exact
slot without overshoot or a separate late snap: 250 ms for slow releases,
300–700 ms for flings, and 350 ms for an overscrolled return.
Mouse notches and PageUp/PageDown move one slot in 220 ms. Distinct notches
accumulate smoothly with a three-slot lead limit; same-direction bursts within
110 ms count once. Small trackpad deltas follow the ring directly and settle after
120 ms idle; OS inertia is already included and receives no second momentum boost.
Visible folder nodes remain mounted while their geometry is rebased continuously. Runtime labels are not recycled with the fixed physical
wedge pool: every child label is mounted once when its folder opens, then follows
the continuous dial position directly. Labels use a separate overlay outside each
wedge clip-path and fade smoothly near the arc edge. At rest, runtime labels snap
to device-pixel coordinates for crisper tablet text without quantizing motion.
Both edges use direct geometry without mirrored text or icons. Korean folder
names keep words together within the two-line limit while long strings can wrap.
The center never rotates. Over it, vertical wheel input is consumed. Horizontal-
dominant input is left to the page. Line/page deltas or pixel deltas of at least
40 px count as notches; same-direction bursts within 110 ms count once. Each down
notch adds one third of Temporary progress, so three counted notches commit. An up
notch cancels existing down-progress without Back; at zero progress it immediately
goes Back one visited level. Small trackpad deltas accumulate with opposite deltas
subtracting: Temporary needs 150 px downward, while Back keeps its 48 px threshold.
Uncommitted progress drains in 150 ms after 600 ms idle. After committing, remaining
trackpad Back inertia is ignored until 200 ms idle. Temporary cannot repeat until
300 ms of wheel idle, including events received while saving. Ring wheel input
keeps its existing dial behavior.

- The first screen shows six visible slots, using the order edited in settings. Initially, pinned shortcuts precede
  root classifications. If there are more than six, rotate the outer ring to
  reveal the remaining roots and shortcuts.
- Pinned shortcuts appear only on the first screen, not again among their
  canonical siblings. Unpinning restores them to the original child order.
  This affects menu presentation only; the classification hierarchy is retained.
- Inside a folder, all six wedges can show children. Runtime wedge spacing uses a
  fourteen-position circular geometry with six centered visible wedges and half a
  wedge peeking at either end when more folders remain. Lists of six or
  fewer are centered as a group. Preserved empty layout slots are compacted out of
  the live dial so scrolling never exposes a blank wedge between real folders.
- On coarse-pointer portrait devices such as a tablet, the live dial radius is
  capped at 208 px to preserve touch targets while reducing visual bulk. Fine-pointer
  desktop use caps at 200 px. The same projected-slot settling and bounded wheel
  targets apply on both device classes.
- Tap any fully visible folder once to select it, including a branch or pinned shortcut.
  Double-tap the same folder within 350 ms to enter its children, or save to it
  immediately when it has no visible children. A single tap only selects. Leaf
  double-tap uses the same save flow as the center button, including busy protection
  and failure handling. Peek taps still only rotate. The central Save button saves
  to the selected folder, so roots and branches are directly saveable.
- Back, via an upward center drag or wheel notch, follows visited screens and restores the previous dial
  position and selection. Entering a pinned shortcut and going back returns to
  the first screen, rather than inserting that shortcut's canonical ancestors.
  Dial movement does not add history entries.
- The opening press determines the edge: the left half of the visible screen
  opens the left menu, and the right half opens the right menu. There are no
  direction or close buttons. Tap outside the curved menu, including its
  transparent corners, or press Escape to dismiss it. Saving and the opening
  finger lock prevent accidental dismissal. Short windows allow the panel to
  scroll rather than shrinking targets indefinitely.
- Temporary saving is available by downward center drag or wheel on every live screen.
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
navigation replaces the snapshot instead of queuing transitions. Saving closes the
menu as soon as the request is handed to the worker (after any page-video lookup)
with the 100 ms icon/exit effect; the server's download and storage of the original
continue in the background, so the next image can be collected immediately. A
compact page-level save pill, separate from menu toasts and stacked with them, shows
a spinner with "저장 중" (and a count chip for concurrent saves), then a check with
the destination folder name, "이미 있음" for duplicates, a filled/grey heart for the
auto-like result and a spinner chip with the number of saves still running; success
disappears after 1.8 seconds and the full wording stays in its accessible label.
Failures show a warning icon, the short reason and folder for 9 seconds (two lines
at most) with a 재시도 button that resubmits the same capture once; revoked, stale
classification, unsupported/unavailable media and other 4xx rejections offer no
retry. A full page reload or departure from X before the answer still completes the
save in the worker but loses that status and auto-like. Reduced motion skips these
effects and jumps directly to the chosen dial slot.

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
Ctrl+Enter to save, and Escape to dismiss. Enter/Space on a leaf still only select
it. Unmodified t/T starts Temporary when supported, except while an input-like
element is focused. The settings editor keeps its existing page controls, Open
and lower Back buttons, never saves on leaf double-tap, and allows normal Tab
navigation out to other settings.

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
as the default and `google/gemini-3.5-flash-lite` and `google/gemma-4-26b-a4b-it`
as optional models. Options
retain an API key, model selection, one automatic on/off switch and Clear cache.
Changing models clears the shared translation cache so results from different
models are not mixed. On X, a
compact floating translation icon opens the same controls in a small popover.
A sub model (default Gemma 4 26B A4B; "사용 안 함" turns it off; never the main
model) answers when the main model hits a rate limit, 5xx, timeout, network error or
another non-auth rejection, and gets one try when the main model's answer is invalid;
batch items the main model answered badly are re-asked of the sub model first.
Auth/payment failures never fall back. Without a sub model the main model is retried
once as before. Requests turn reasoning off (3.1 Flash Lite, Gemma) or keep it at the
minimum where it is mandatory (3.5 Flash Lite), and ask OpenRouter to route to the
lowest-latency provider. Other providers, manual translate, diagnostics and tuning
remain removed. Existing OpenRouter keys and automatic preferences migrate
locally; retired provider settings and pre-3.1 translation caches are removed.
Keys stay in extension storage and the worker: they are never returned to X
content scripts or synced with the server profile. The worker is warmed as soon as
the content script starts, and the first visible scan bypasses the normal debounce.
Posts up to 1.5 screens below the viewport (and a quarter screen above) are
translated ahead while slots are free, so they are usually ready on arrival; work is
ordered by distance from the viewport centre, so posts on screen always go first.
Two request slots run continuously: whenever one frees, the next group starts
without waiting for the other. After new posts come into view, the one nearest the
viewport center is sent alone first so it renders first; other work is grouped up
to four per model call, with at most two model calls in flight. A batch item whose
output is invalid is re-asked alone in its own slot turn without blocking others.
Single requests time out after 12 seconds and batches after 18 seconds. Links,
hashtags, mentions, emoji and explicit line breaks are retained; the translation may
move link placeholders (Korean word order), and a link it drops is re-attached at
the end of the card, while unknown or duplicated placeholders are invalid. A valid
answer without Korean (names, Latin terms, "www") means nothing to translate: no
card is shown and the result is cached. Results use text nodes, not model HTML.
Translation cards use X-aware light/dim/lights-out contrast with blue link accents
and a line height close to X's. A request still unanswered after 250 ms shows a quiet
"번역 중…" line that the result replaces in place (fast answers never flash it). When a
translation is shown, an original taller than two lines folds to two lines, with a
원문 펼치기/접기 button under the card that never opens the post. The floating
translation button has no hover tooltip and sits above X's bottom-right messages
drawer on wide pointer screens (76 px up; 12 px elsewhere).
Network, timeout and server failures retry once. Unchanged failures are not
re-requested by unrelated page mutations; transient failures can retry after leaving
and re-entering the viewport. Other failures get one such re-entry retry
("번역 실패 · 다시 보이면 재시도"), then remain parked until the post changes or
translation is reset. Short Han/Kana posts remain eligible even below three letters.
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
