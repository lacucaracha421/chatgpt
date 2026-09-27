# Tagger character signal and newer taggers (2026-09-27)

Read-only experiments for `AUTO-TAG-001`. The active library was only read (`mode=ro`); scripts and outputs are machine-local (`~/.cache/lakomics-oss/{pixai,canary}/`).

## PixAI v0.9 character tags vs. the user's character decisions
- Backfill finished: 8,915 images, mean 54 tags/image at score ≥ 0.35, 11,737 distinct tags; top 500 general tags cover ~62 % of occurrences.
- 30 of 64 character targets exist in the v0.9 vocabulary (by name; mapping made by hand, e.g. 아사/요루 → `mitaka_asa` + `yoru_(chainsaw_man)`). Membership = latest accepted decision ∪ references ∪ learned references ∪ relations.

| Comparison (30 targets) | Result |
|---|---|
| Manually confirmed images, PixAI ≥ 0.85 for the same character | 413 / 465 (89 %); ≥ 0.5: 95 % |
| Manually rejected images, PixAI ≥ 0.85 anyway | 3 / 136 (2 %) |
| Automatic acceptances, PixAI ≥ 0.85 agrees | 378 / 457 (83 %); 29 below 0.2 |
| Undecided images with PixAI ≥ 0.85 | 451 (396 inside the character's series folder) |

Uses discussed with the user: agreement of both signals → automatic acceptance; disagreement → review first; PixAI-only → review candidates. Candidate correctness is unverified (nobody has looked at the 451).

## Newer taggers (web research 2026-09-27; CPU timings are estimates unless measured)

| Model | Data cut-off | Tags | Notes |
|---|---|---|---|
| PixAI v0.9 (in use) | ~early 2025 | 9,741 general + 3,720 character | 4.7 s/image measured on the laptop CPU |
| [wd-eva02-tagger-2026-canary](https://huggingface.co/ashen-sensored/wd-eva02-tagger-2026-canary) (Apache-2.0) | 2026-05-18 (card) | 11,601 general + 4,868 character + 4 rating | Same EVA02-L 448 backbone; 5.3 s/image measured (torch, 3 threads). Knows ~46 of 64 targets by name incl. most 명조/젠레스 2025 characters. Trial on 1,147 labelled images running. |
| [PixAI v1.0](https://huggingface.co/pixai-labs/pixai-tagger-v1.0) (Apache-2.0) | "May 2026" (card; card dates inconsistent) | 15,043 general, 8,308 character, 2,460 copyright (series), 4,917 style (artist), 145 meta, 4 rating | Only model with series and artist tags; also knows 안조, 마르차나, 마츄. 1008 px input: ~30 s/image, 7.5 GB RAM on the laptop → ~75 h for the library. |

Not useful for this: Camie v2 (2024 data), WD v3 (early 2024), animetimm dbv4 (gated, likely ≤ early 2025), Redstonexs (no character tags), taggerine (5 GB, no 2025 targets).

## Running PixAI v1.0 on a GPU (idea, not approved)
- Main PC (RTX 5070 Ti 16 GB, 5600X, 24 GB) — estimated 0.2–0.4 s/image (30–60 min for the library); not available for now.
- Rented GPU (estimate, prices unverified): RunPod Secure Cloud RTX 4090 (~$0.4–0.7/h) or Modal (per-second billing, monthly free credit to be checked); Vast.ai cheaper but third-party hosts; Colab not recommended (content policy). Whole run ~1–2 h ≈ $1–2 including setup. Upload 1008 px copies named by asset id only (~2–3 GB, estimate), delete the pod and volume afterwards. Needs the user's account/payment, approval for images leaving the PC, and service-provisioning approval.
- Hugging Face Jobs (checked 2026-09-27 on huggingface.co docs): any account with a positive prepaid credit balance, per-second billing, no Pro needed. `t4-small` $0.40/h, `l4x1` $0.80/h, `a10g-small` $1.00/h; default timeout 30 min (set `timeout`). Local folders upload to a private `jobs-artifacts` Storage Bucket via `hf jobs uv run -v ./in:/input -v ./out:/output:rw`; outputs sync back. Plan: a 50-image paid trial to measure s/image, then the full run on the cheapest GPU that fits, then delete the bucket. HF content policy for private adult images not checked.

## Canary trial result (2026-09-27, 1,145 labelled images sampled per character: ≤15 manual, ≤5 automatic, ≤8 rejected)
Score ≥ 0.85 for the mapped character tag(s) (costume variants included).

| Set | Manual confirmations | Rejected but tagged | Automatic acceptances agreeing |
|---|---|---|---|
| PixAI v0.9, its 30 targets | 343/389 (88 %) | 3/110 (2.7 %) | 135/167 (81 %) |
| Canary, the same 30 targets | 358/389 (92 %) | 2/110 (1.8 %) | 149/167 (89 %) |
| Canary, 16 targets only it knows | 360/395 (91 %) | 6/172 (3.5 %) | 57/75 (76 %) |
| Canary, all 46 targets | 718/784 (92 %) | 8/282 (2.8 %) | 206/242 (85 %) |

Weak spots: 마커스 15/23, 치사 18/24, 아사/요루 10/15 (v0.9 14/15), 수나 3/9 rejected images tagged anyway. Unknown to both: 안조, 라플라스, 백합 except 카구야, 수수, 청초, 여우의 별자리, 레미엘, 록시, 클라렛, 마르차나, 마츄. Scripts: session scratchpad `pixai-char/compare_canary.py`, `map_canary.json`; outputs `~/.cache/lakomics-oss/canary/out/trial.npz`.

## Canary over the whole library (Hugging Face Jobs, 2026-09-27)
8,899 images (L4, 0.05 s/image; 22 minor-looking sexual images kept off the upload). Score ≥ 0.85 for the mapped tag(s), 46 targets, all labelled images instead of the earlier sample:
- manual confirmations detected 1,152/1,257 (92 %); automatic acceptances agreeing 508/619 (82 %); rejected pairs still detected 13/411 (3.2 %).
- 525 new candidates (image detected, no decision yet), 441 of them inside the character's series folder — largest: 리버스 버틴 90, 젠레스 제인 도 37, 엘렌 36, 건담 슬레타 36 / 미오리네 35, 젠레스 아리아 30, 걸밴크 에비즈카 토모 29.
Script: session scratchpad `canary_full.py` (read-only on the library).

## PixAI v1.0 over the whole library (Hugging Face Jobs, 2026-09-27)
L4, 0.575 s/image, 8,899 images, 0 errors; whole job 109 min ≈ $1.45 (+ trial). Buckets deleted afterwards. Outputs: `~/.cache/lakomics-oss/hfjob/out/{pixai-lib,canary-lib,canary-thumb}` (sparse scores ≥ 0.1; canary also pooled features).
- Series (copyright) tag ≥ 0.5 on 7,221 images (81 %); top: reverse:1999 2,240, zenless_zone_zero 776, blue_archive 510, wuthering_waves 462, hololive 267, pokemon 229.
- Artist tag ≥ 0.5 on 778 images (8 %). Against the 242 of those with a known creator handle, 49 match by exact name — a lower bound: most "mismatches" are the same artist under a different Danbooru name (batta18th ↔ batta_16-sei, tohirokonno ↔ konno_tohiro, daiji_1031 ↔ satou_daiji).
- Characters (46 targets, score ≥ 0.85):

| Signal | Manual confirmations | Automatic agreeing | Rejected but detected | New candidates |
|---|---|---|---|---|
| PixAI v1.0 | 1,139/1,257 (90 %) | 517/619 (83 %) | 7/411 (1.7 %) | 482 |
| canary | 1,152/1,257 (91 %) | 508/619 (82 %) | 13/411 (3.2 %) | 525 |
| both agree | 1,092/1,257 (86 %) | 495/619 (79 %) | 6/411 (1.5 %) | 438 |
| either | 1,199/1,257 (95 %) | 530/619 (85 %) | 14/411 (3.4 %) | 569 |

Proposal: both agree → automatic acceptance candidate; only one → review; neither but existing CCIP candidate → unchanged.

## User check of automatic acceptances the taggers reject (2026-09-27)
Of 619 automatic acceptances on the 46 tagger-known targets: both taggers agree 520; both score < 0.3 → 73; mixed/weak 26. The user judged a stratified sample of 20 of the 73: **19 were wrong automatic acceptances**, 1 correct. So "both taggers < 0.3" is a strong veto (~95 % of those are wrong, roughly 11 % of automatic acceptances on these targets). Page: session scratchpad `char-check.html`, picks `char-check-pick.json`.
