# Windows Video Preview and Playback Acceptance

Verified on 2026-08-09 on Windows with the isolated WebView profile under `.acceptance/webview-profile` and the designated test library at `C:\Users\namwoojun\Desktop\test`. Existing registered user-library state was not changed.

## Automated verification

```powershell
cd C:\chatgpt\.worktrees\video-preview-playback\app\src-tauri
cargo fmt --all --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test

cd C:\chatgpt\.worktrees\video-preview-playback\app
npm.cmd test
npm.cmd run build
npm.cmd run tauri build -- --debug
```

- Rust: 108 unit tests passed, 18 integration tests passed, and one compile-fail doctest passed. The two opt-in real-file acceptance tests and the existing 50,000-item performance test remained intentionally ignored in the ordinary run.
- Frontend: 31 files and 208 tests passed.
- TypeScript/Vite production build passed.
- Tauri produced the debug executable, MSI, and NSIS installer. The executable directory contained `ffmpeg.exe`, `ffprobe.exe`, and eight required shared DLLs.

## FFmpeg and fixtures

Pinned sidecar:

```text
ffmpeg n7.1.5-12-g1fdbca85aa-20260808
BtbN win64 LGPL shared build
GPL/nonfree disabled; h264_mf, AAC, libwebp and libwebp_anim available
```

The ignored `video_acceptance` integration test was run with explicit environment-variable paths. It ingested all five fixtures into a temporary library, checked an exact duplicate, prepared media, reopened the library, exercised trash/restore/purge, and compared every source hash after completion.

| Fixture | Duration/type | Playback | Scrub frames | SHA-256 |
| --- | --- | --- | ---: | --- |
| `망니메이션 1화.webm` | real AV1/Opus WebM, 6:29 | original | 240 | `98a1dbb755d2fa6d57e0ed00f4064d12c2ef5f0eeeb5f87df51f07c3647ccd31` |
| `망니메이션 2화.webm` | real AV1/Opus WebM, 6:34 | original | 240 | `d29cb8ff0fd9a71518d754dbe527d1d614b9172fdd0cba23df65d358f16ef431` |
| `direct-h264.mp4` | generated H.264 MP4 | original | 3 | `7128461a58c2a8da5dd8fb3d709754f940bec9e4594c921f76460175fe19bb79` |
| `proxy-source.mov` | generated MPEG-4 MOV | proxy | 4 | `5f1fcca845c41a74ba40e8a5939ddd1636f8ba920d1e5ffcd697f5c1352b2bdc` |
| `long-20m01s.mp4` | generated MPEG-4 MP4, 20:01 | proxy | 240 | `703a1681421b536ddfad95beb62d82f2cb1aae42e83b2a26cefd83caf2d94cca` |

The real run exposed an FFmpeg 7 behavior change: extension-only WebP output selected `libwebp_anim` and produced one animated file. Lakomics now explicitly selects `libwebp`, and the acceptance run produced every numbered still frame. A 320×240 MOV proxy remained 320×240, confirming the 1080p ceiling does not upscale smaller sources.

## Windows UI evidence

- Gallery ready state: `.acceptance/video-preview-playback/video-gallery-ready.png`
- First hover active: `.acceptance/video-preview-playback/video-hover-active.png`
- Second hover active with the first restored to its poster: `.acceptance/video-preview-playback/video-second-hover-active.png`
- DPI-aware fullscreen player and controls: `.acceptance/video-preview-playback/video-player-dpi-aware.png`
- Final packaged debug launch with no development server and a system-only `PATH`: `.acceptance/video-preview-playback/packaged-debug-final.png`

Observed results:

- Hover playback was active after a measured 372ms wait, below the 500ms acceptance threshold.
- Moving to the second video restored the first poster, proving one-active-tile cleanup.
- Play changed to Pause, Mute changed to Unmute, and Fullscreen changed to Exit fullscreen through native media/fullscreen events.
- Newest order correctly disabled Previous on the first loaded item; Next navigated from episode 2 to episode 1 and reset time to zero.
- Ten seeks across a 63.1MB real WebM increased the Lakomics plus descendant WebView process working set by 31.1MB, rather than the full source size. Range unit tests separately cover bounded, open-ended, suffix, invalid, unsatisfiable, and multi-range requests.
- Temporary-library trash, restore, and purge removed managed media and derivatives without changing any external source hash.

## Scoped limitation

The automated Windows cursor attempted an Explorer-to-app OLE drag, but the synthetic mouse path did not emit an OS file-drop event. This is not recorded as a successful manual drag. File-drop orchestration, multi-file sequencing, video use of the shared `ingestMedia` contract, failure retry, and source preservation remain covered by 18 focused frontend tests, while real video ingest and preparation were exercised through the public Rust library API. A final human Explorer drag remains the only unautomated gesture check.
