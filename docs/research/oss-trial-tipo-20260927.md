# OSS trial: KGen / TIPO prompt expansion for the NAI app (2026-09-27)

Scripts/results: `~/.cache/lakomics-oss/tipo/` (llama.cpp built locally; `TIPO-200M-ft2-Q8_0.gguf` 216 MB kept). Code Apache-2.0; weights **Kohaku License 1.0** (free for personal use; bundle the licence + attribution if distributed).

| Model | RAM peak | Median / p90 | New tags in NAI dictionary |
|---|---|---|---|
| TIPO-200M-ft2 Q8_0 | 574 MB | 1.9 / 2.4 s | 98.8 % |
| TIPO-v2.1-1B-A200M Q8_0 | 1.3 GB | 1.8 / 2.2 s | 99.3 % |

Findings: always keeps input tags/characters; useful for scene, props, pose and composition; weak on appearance (redundant for known characters, random colours for OCs, pushes canonical outfits); no multi-character handling ("2girls" → `solo`); v2.1 has a Blue Archive halo bias and drifted to suggestive tags under `rating: safe`; the input must end with "," or the model glues onto the last tag; a few renamed Danbooru tags need remapping.

**Recommendation: later** — an opt-in "✨ 태그 확장" idea helper, not a quality booster. If done: 200M-ft2 Q8_0 as a llama-server sidecar on the Tokyo VPS (~1 day) or on-device via llama.cpp NDK (~3–5 days, unmeasured); request with category lines + `tag: … ,`, stop at the first newline, post-filter (dedupe, drop character/count tags, remap, safe blocklist), suggestion chips the user taps to add.
