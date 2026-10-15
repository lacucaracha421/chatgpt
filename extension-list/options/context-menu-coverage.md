# Right-click menu coverage audit

Code-level audit for COLLECTOR-MENU-SCOPE-001, 2026-10-16. No live site,
installed-browser, PDF runtime, or tablet acceptance was performed.

## Ownership and settings

The default window bubble listener continues to respect page cancellation and
propagation. There is no DOM API for distinguishing an arbitrary registered
custom-menu listener from a right-click blocker. Consequently, capture priority
is **opt-in per top-page host**, in Options > 우클릭 메뉴 > 메뉴를 우선할 사이트.
Subdomains inherit the setting, including child frames. It is empty by default.
The existing excluded-host list and disabled switch take precedence. Removing a
priority host restores normal handling; exclusion turns off the custom menu.

On priority hosts the window capture listener opens only eligible mouse menus
and stops further contextmenu listeners after successful ownership. Earlier
cancellation is respected. Shift, collector sessions, picker ownership, player
controls, extension surfaces, touch entry, and synthetic input retain their
existing guards. Selection-chip and touch implementation is outside this audit.

The explicit protected-area list in `src/context-menu/model.js` is:

- `canvas`, `iframe`, `object`, `embed`;
- ARIA application/menu roles and `aria-haspopup="menu"`;
- Monaco, CodeMirror (both generations), Ace, ProseMirror, Quill, TinyMCE,
  CKEditor editing surfaces;
- Leaflet, Mapbox GL, MapLibre GL, and Google Maps containers;
- inline/property `oncontextmenu` handlers on the visible event path or ancestors.

Open shadow paths and shadow hosts are checked. Ordinary inputs, textareas, and
unmarked contenteditable fields keep the established editing/translation menu.
Unmarked JavaScript menus cannot be recognized reliably: do not enable priority
for a site that depends on one, or remove that host if a conflict occurs. No
hardcoded site-wide denylist is introduced.

## Inventory

| Cause / source | Result in this round | Fallback / remaining acceptance |
| --- | --- | --- |
| Page target/document capture or bubble `stopPropagation` / `stopImmediatePropagation` prevents the old window bubble listener | Fixed for opted-in hosts by window capture before those lower targets | Enable priority only for a known blocker; default mode still respects page ownership |
| Page calls `preventDefault` in a later listener without a real menu | Fixed for opted-in hosts without ownership markers | Indistinguishable from an unmarked real menu; remove priority on conflict |
| Earlier window capture cancellation or `stopImmediatePropagation`, another extension, initialization before registration | Not generically fixable with the current `document_idle` entrypoint | Native/page menu or toolbar settings; priority cannot guarantee registration order |
| Rich editors, maps, games/canvas, application/menu roles, explicit handlers | Intentionally preserved by the protected-area list | Use their own menu; ordinary page areas retain Lakomics. Unknown widgets require priority removal/exclusion |
| Global disabled switch / excluded host and subdomains | Intentional bypass; unchanged, wins over priority | Re-enable or remove the exclusion in Options |
| Own UI, non-idle collector gesture, open picker, player controls, untrusted input, touch-generated contextmenu | Intentional bypass; unchanged | Finish/dismiss the active gesture or use the established picker/touch route |
| HTTP(S), X-specific scripts, HTTP(S) child frames | Already included by manifest; no manifest change | Reload extension and page; Chrome site access must be granted for relevant frame hosts |
| `lacucaracha421.github.io/chatgpt/*`, `*/extension-pair*` | Intentionally excluded by manifest | Native menu / extension toolbar; do not inject collection UI into pairing pages |
| Inherited `about:blank` / `srcdoc` frames | Existing `all_frames` + `match_about_blank` coverage retained | Verify nested/sandboxed instances in Chrome; parent cannot receive child-frame events |
| `blob:`, `data:`, `filesystem:` / opaque related frames | Not covered reliably: manifest has no `match_origin_as_fallback`; outside owned files | Open normal HTTP(S) content if available. Controller follow-up requires manifest and frame/WAR tests; do not inject across frame boundaries manually |
| Open shadow DOM | Existing composed-path inner target retained; protected host/ancestor detection added | Real browser check for links/images and editor/map hosts |
| Closed shadow DOM / UA internals | Hidden inner canvas/editor/media cannot be inspected; only visible host signals are available | Page/native menu; remove priority or exclude host if needed |
| Canvas/WebGL viewers | Intentionally native; pixels do not expose DOM text/image URLs | Viewer export/download or screenshot manually; no automatic pixel capture/upload added |
| Pointer-events overlays | Event target is the hit-tested overlay, not necessarily its image/canvas sibling | Nearby media lookup already exists for bounded player containers. No click-through hit testing: could collect the wrong/private content; use viewer controls/native menu |
| Fullscreen / stacking / pointer-events on menu host | Existing fullscreen-parent mounting, manual popover top layer and interactive menu pointer-events retained; existing fixture test passes | Check fullscreen video/replaced elements and site CSS in Chrome. Fallback to exiting fullscreen; a huge z-index alone cannot beat the top layer |
| Page CSP | Menu is an isolated-world manifest script, not a page-injected script; page script-src does not itself prevent it | MAIN-world helpers are subject to page CSP. Menu stylesheet fetch/storage failure leaves controller uninstalled and native behavior intact; inspect extension console for the actual failure |
| Missing/rejected stylesheet resource or storage, disabled extension, revoked site access, stale pre-update tab | Controller is created only after local CSS fetch and settings load; catch leaves native behavior | Grant access, reload extension and page, inspect console. A toolbar click opens Options independently |
| Chrome Web Store / browser pages / `file:` and other unmatched schemes | Browser restriction or no manifest match; cannot fix in owned files | Native browser controls; changing file permissions alone does not add a file match |
| Chrome built-in PDF viewer (`chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/`) | Not scriptable by Companion; cannot install a custom DOM menu, even if the tab address is HTTPS | Use the viewer's native menu (try Shift+right-click), copy/download/print toolbar. Companion's existing toolbar action opens Options only; it does **not** translate or collect PDF selections |

Shift+right-click makes Companion yield. It cannot force Chrome's menu when a
page/another extension cancels that event independently. PDF controls are native
fallbacks, not a promise that Companion's selection-only native menu entry works
inside the PDF extension. The existing native cover-lookup entry is HTTPS-only
and requires selection dispatch back into a scriptable frame.

## Platform evidence and source boundaries

- [Chrome content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts):
  frame matching, `match_about_blank`, origin fallback, isolated-world CSP,
  resource exposure and injection timing.
- [Chromium PermissionsData](https://raw.githubusercontent.com/chromium/chromium/main/extensions/common/permissions/permissions_data.cc),
  `IsRestrictedUrl`: normal extensions cannot script another extension's origin.
- [Chromium extension constants](https://raw.githubusercontent.com/chromium/chromium/main/extensions/common/constants.h),
  `kPdfExtensionId`: the built-in PDF viewer's extension identity.
- Local sources: `manifest.json`, `src/content.js` (controller initialization,
  collector/touch/media guards), `src/context-menu/{model,menu,surfaces}.js`,
  `src/background.js` (toolbar opens Options; HTTPS selection context-menu entry).
- The backlog entry and references were read. The referenced 2026-10-12
  context-menu design document was not found under `docs/` or `extension-list/`;
  this round uses the current source and README contract and does not change the
  other worker's selection-chip/touch contract.

## Real-browser checks still required

1. Reload the extension and test tabs. Compare an ordinary HTTP(S) page with a
   right-click-blocking page before/after adding only the latter to priority.
2. Verify native/editor/map/game menus, Shift+right-click, ContextMenu/Shift+F10,
   excluded-host precedence, turning priority off, and no duplicate menus.
3. Test nested same/cross-origin and srcdoc frames, open/closed shadow components,
   overlays, canvas/WebGL, fullscreen video, strict-CSP pages, Chrome site-access
   denial and restricted/PDF pages. Expect the documented fallbacks.
4. Confirm the new Korean settings help wraps correctly at narrow widths.
   DOM tests are not rendering or live-site acceptance.
