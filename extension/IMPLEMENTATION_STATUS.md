# Implementation status

alpha.15.1 integrates AI X Translate Lite v1.4.14 OpenRouter edition and simplifies extension settings.

- Mobile radial save: selection only until center Save is tapped.
- PC radial save: existing drag/drop behavior unchanged.
- Remote Lakomics/Tailscale: unchanged.
- X Translate: enabled by default; toggle in extension options; provider/API key/model are configured from the floating 訳 panel on X.
- Userscript GM storage is adapted to chrome.storage.local with isolated prefixed keys.
- Cross-origin translation requests are proxied through the background worker and restricted to four known API hosts.


## alpha.15.4 review fixes
- Browser fallback downloads are serialized to prevent duplicate-save races.
- JSON sidecars follow the browser-resolved image filename when `uniquify` renames the media file.
- Persisted Lakomics classification snapshots are scoped to the active API endpoint; legacy v1 snapshots migrate once to the current endpoint.
- Offline folders now preserve the full classification path (for example `명조/카멜리아`).
- Absolute Android filesystem paths are rejected explicitly because `chrome.downloads` only accepts paths relative to the browser Download directory.
- Lakomics API timeout now covers response body parsing as well as the initial fetch.


## alpha.15.7 gallery rendering optimization
- Replaced per-image full gallery DOM rebuilds with incremental card insertion.
- Initial gallery open renders 36 cards; near-bottom scrolling adds 24 more at a time.
- Auto-harvest defers live card creation so X timeline scrolling gets priority, then refreshes one initial batch when harvesting ends.
- Existing rendered image nodes are preserved during normal collection; saved-state refresh only toggles markers.
- Existing image lazy-loading/async decoding stays intact while the DOM itself is now paged.
