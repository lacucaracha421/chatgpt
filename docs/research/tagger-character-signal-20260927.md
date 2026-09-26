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
