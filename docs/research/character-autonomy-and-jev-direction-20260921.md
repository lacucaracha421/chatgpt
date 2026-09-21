# Seed-first character automation and Jev evaluation direction

Date: 2026-09-21 (Asia/Seoul)

Status: **Research/design direction; no runtime implementation or production activation.**

Inspected repository baseline: `5b0690b153ac058b9a0cd4ac688bb7ab177f9c71` on `main`.

This record consolidates the user's discussion about character classification, lookalikes, cosplay, multi-character images, reference maintenance, and TypeSafe AI's Jev. It distinguishes user requirements, inspected implementation, hypotheses, and proposed experiments. It is not a claim that the reported failures have been reproduced on the active library.

Execution status remains in [the living backlog](../roadmap/lakomics-backlog.md). Reuse `AI-JEV-001` for decision-model evaluation; do not silently reopen the closed `CHAR-AUTO-001` improvement pass or create a second live backlog here. Activate concrete engineering follow-ups in that backlog before implementation.

## 1. Decision summary

**Keep the existing local detector/CCIP pipeline and durable native owner. Improve its automation contract and evidence first. Evaluate Jev as a replaceable, shadow-mode routing/interpretation component, not as an assumed solution or the owner of classification writes.**

Recommended sequence:

1. Instrument the current rejection/abstention paths and establish a frozen evaluation baseline.
2. Verify multi-person arbitration and resolve the mismatch between initial reference setup and automatic eligibility.
3. Compare existing rules, a deterministic evidence baseline, and Jev on exactly the same evidence. Do not wait for a new vision stack to run this small experiment.
4. Add genuinely new evidence only where existing evidence cannot distinguish identities: more appropriate crops, an alternative visual embedding, or a separately approved reference-conditioned vision model.
5. Introduce bounded automatic reconsideration; introduce automatic supporting-reference growth only after it passes a separate drift/reversibility gate.

The desired result is **less user work with more correctly completed character memberships**, not simply fewer visible warnings or more guesses.

## 2. User requirements

The intended normal workflow is:

> Create a character and provide its initial references. Thereafter, classify new images automatically. Return to reference setup only when those references need correction or replacement.

The following requirements come from the conversation:

- Routine collection must not depend on per-image approval, a review inbox, or manually promoting additional reference images.
- Lookalikes, costume changes, cosplay, and difficult styles should trigger bounded automated investigation before abstention, rather than immediately becoming user work.
- An image containing A and B must appear in both character folders. Character memberships are multi-label at asset level; source files need not be duplicated or moved.
- A clearly recognized person must be committed even when another person in the same image remains unresolved.
- Character creation and reference replacement are acceptable interaction points. A larger initial reference requirement, if evidence justifies it, must be completed within setup rather than emerging as a hidden maintenance task.
- Existing explicit corrections and exclusions remain authoritative. Keeping an optional correction mechanism is compatible with the goal; requiring it for routine operation is not.

A proposed identity convention is to classify the depicted character, not merely the owner of the costume. Costume identity may be separate metadata. A genuinely ambiguous fusion, transformation, obscured face, or insufficiently specified drawing must not be forced into a named identity merely to meet an automation target.

Near-zero routine intervention is the product objective. It does not establish that every image contains enough evidence for a correct identity decision. Unresolved cases must remain observable and measurable; hiding them is not success.

## 3. What the inspected implementation actually does

### 3.1 Existing foundation

The [runtime documentation][R1] describes a detector/cropped-feature/CCIP-metric pipeline, not a generic CLIP classifier. Python workers emit evidence; the Rust native owner controls scope, durable jobs, validation, and publication. Existing reference examples are retrieval data, not online model-weight training.

The native execution path includes `compare_incremental_asset` and `finalize_incremental` in [character_incremental.rs][R2], with automatic-support and competitor predicates in [character_scan.rs][R3]. Preserve these ownership boundaries rather than introducing a second autonomous writer.

### 3.2 Five references are not currently sufficient for automatic approval

Current policy requires:

- five manually selected anchors to initialize the character;
- optional explicit supporting references, up to twenty additional images;
- at least **six distinct matching reference images on the same query crop** for automatic approval;
- a sixth-smallest reference distance of at most **0.16**;
- no whole-image fallback and successful competing-character arbitration.

Recommendation remains a two-reference condition. These are inspected implementation settings, not recommended future universal thresholds. [R1, R3]

**Consequently, a character with only its five initial anchors cannot automatically approve a new image under this policy.** This is a direct mismatch with a seed-only operating goal unless initial setup provides sufficient validated support or a separately calibrated bootstrap policy is introduced.

Simply adding automatic reference promotion would create a circular dependency: a five-anchor character cannot produce an automatically approved example if promotion requires that same six-reference approval. A bootstrap decision must be explicit and independently evaluated. Do not fix this by blindly lowering the existing threshold or by treating repeated crops as independent references.

### 3.3 Multi-character and partial success already exist

`finalize_incremental` iterates candidate characters, finds independently admissible regions, accumulates multiple accepted predictions, and records `Resolved`, `PartiallyResolved`, or `Unresolved`. It writes accepted character decisions even when other regions remain unresolved. [R2]

Therefore the earlier conversational claim that the system fundamentally lacks multi-label or partial-success architecture was too strong. **The user's symptom is real feedback, but its root cause is not yet established.** Do not plan a wholesale rewrite of already implemented functionality.

Specific investigation targets are:

- `same_person` treats boxes as the same person when their intersection is at least **50% of the smaller box's area**. This is not intersection-over-union. Nested duplicate detections and two overlapping people can both satisfy it. [R3]
- Two automatic-strength candidates on overlapping regions deliberately block each other. A recommendation-only competitor is allowed only when its second-smallest distance clears the winner's sixth distance by at least **0.05**. A margin policy already exists. [R1, R3]
- Missing, failed, fallback, or malformed competitor evidence cannot authorize automatic approval. The native all-competitor check can therefore stop an otherwise promising region when another candidate lacks valid evidence. Whether that is occurring in reported examples must be logged, not presumed. [R2, R3]
- Existing decisions, self-reference protection, reference readiness, scope resolution, and single-box handling are additional gates worth distinguishing in a trace. [R2]

For hugging/overlapping characters, reproduce whether person geometry is incorrectly merging independent identities. Also test missed detections, a box containing two people, and duplicate boxes for one person. Changing one overlap constant is not an adequate diagnosis.

### 3.4 Quiet operation is not yet self-improving operation

Current documentation already avoids a mandatory routine review inbox. However, supporting-reference growth is explicit, and historical reconsideration starts through an explicit refresh action. It is not automatically initiated by every reference or policy change. [R1]

The new objective extends that contract: useful evidence changes should eventually cause bounded automatic reconsideration. This is a proposed behavior change, not an existing feature or authorization to rescan the active library now.

### 3.5 Evaluation infrastructure already exists

[HOLDOUT.md][R4] documents a read-only exporter and frozen evidence replay using explicit manual decisions, pre-feedback evidence, competing candidates, and duplicate/reference-leakage checks. Reuse it.

Its reports concern selected labeled pairs, not all incoming assets. It cannot prove whole-library automation coverage, and replaying stored distances cannot evaluate a changed detector, crop, or visual model. Such changes need an additional image-inference evaluation path using the same protected labels and split identities. The older support-only replay does not reproduce full geometry arbitration. [R4, R5]

## 4. Corrections to assumptions from the discussion

| Earlier idea | Grounded direction |
| --- | --- |
| Add image-level multi-label classification from scratch | Preserve existing multi-label/partial-success publication; trace where region arbitration or evidence gates block it. |
| Add a top-1/top-2 margin because none exists | A competitor margin already exists. Compare alternative rules against the real current policy. |
| A face/head crop proves the true identity in cosplay | It may add useful evidence, but stylized faces can be indistinguishable, hair can be part of a costume, and crop distributions may not match model training. Benchmark it. |
| Selecting B means A is a hard negative | Not for an entire multi-character image. A negative needs evidence about the same person and trustworthy label provenance. |
| Automatic decisions can become training truth | Predictions remain predictions. They cannot serve as independent ground truth for the model that produced them. |
| Jev confidence is the probability our folder assignment is correct | TypeSafe distinguishes distribution concentration from workflow correctness. Calibrate on this task. [E1] |
| Jev will recover a particular percentage of unresolved images | No Lakomics Jev evaluation has been run. Earlier illustrative percentages are not forecasts or evidence. |
| A vector database will inherently improve recognition | Retrieval speed and identity accuracy are different. Candidate recall and the compatibility of the index metric with CCIP's final metric must be measured. |
| More repeated attempts mean more confidence | Repeating unchanged evidence does not create independent evidence. Retry only for a meaningful dependency change or a bounded service failure. |

## 5. Proposed architecture and ownership

```text
asset arrival / meaningful evidence-version change
    -> existing durable native job owner
    -> detect person regions and retain geometry/quality evidence
    -> existing local CCIP evidence and candidate discovery
    -> deterministic eligibility and evidence-quality checks
         -> clear case: existing validated automatic path
         -> difficult case: bounded resolver
              -> optional Jev interpretation/route
              -> acquire additional visual or trustworthy source evidence
              -> reevaluate candidate identity for this person
    -> native validated publication
         -> union of accepted identities for the asset
         -> preserve independently unresolved regions
    -> versioned observation store / dependency-aware reconsideration
```

Jev and any alternative model produce **advisory evidence or proposals**. They do not execute SQL, create characters, move files, change references, bypass user exclusions, or overwrite decisions. The current native owner remains the side-effect boundary.

Logical competition belongs to a person instance, not to all identities in the image. Separate regions may select the same character. The final asset membership is a set, with all contributing region evidence retained. Do not impose a global one-character-per-image or one-occurrence-per-character matching constraint.

The resolver must distinguish:

- insufficient or invalid references;
- low-quality or merged/missed person detections;
- two identities competing for the same person;
- independent people that merely overlap geometrically;
- contradictory appearance/identity evidence;
- missing candidate coverage;
- runtime/provider failure;
- insufficient evidence after the bounded pipeline.

These are diagnostic reasons, not additional user chores. They should produce different automated next steps and different measurements.

## 6. Jev: useful experiment, not predetermined adoption

### 6.1 What was verified

TypeSafe's official SDK demonstrates structured `state` plus typed questions. Its official development guide describes Choice, Noul, Score, candidate reranking, bounded routing, parallel independent questions, and code-owned execution. It explicitly says typed output is not a truth guarantee, and that numerical calculations and known rules should remain in code. [E1, E2]

The live documentation pages for state, confidence, and the reranking cookbook could not be fetched during this audit. The official repository guide was retrieved instead. Do not treat every earlier conversational statement about modalities, exact API limits, pricing, gateway availability, or latency as independently reverified here. Recheck the chosen endpoint's current contract before implementation.

**This proposal supplies Jev with text/structured evidence only. It does not rely on raw-image input support.** Sending similarity summaries cannot give Jev visual details absent from those summaries.

### 6.2 Appropriate roles

Evaluate two separate tasks:

1. **Routing:** choose a bounded next action, such as use the already supported candidate, obtain a valid head crop, request an independent visual comparison, or retain an unresolved state.
2. **Evidence interpretation/reranking:** choose among supplied candidate identities plus explicit no-match/insufficient-evidence outcomes when the evidence supports a distinction.

Do not ask Jev to recompute distance thresholds, perform box arithmetic, count reference votes, or infer that unseen facial details prove cosplay. Code computes all numerical features and establishes validity. Jev's output cannot bypass content-hash, reference-version, scope, manual-decision, or publication fences.

Per-person independence is a semantic requirement, **not one HTTP request per person**. Several questions may share one request if each question explicitly names its region and candidate evidence. Independent questions in the same call cannot consume one another's answers. Dependent stages need new state and a later call. [E1]

### 6.3 Minimum evaluation state

A replayable decision record should include:

- opaque asset/person IDs, source generation and content identity retained locally;
- detector/crop identity, geometry, duplicate/merged-person flags, and fallback/quality state;
- candidate IDs, reference-set versions, usable/distinct reference counts;
- per-view reference distance summaries, threshold units/direction, support, and margins;
- whether additional views or model outputs are actually present, rather than guessed;
- trustworthy metadata with provenance, separately marked from inferred hints;
- existing authoritative decisions and exclusions as local policy constraints;
- the complete candidate set considered, and why alternatives were omitted;
- question/template version, requested and returned model version, response, latency, usage, and the final native action.

The outbound payload should be minimized and use opaque identifiers where practical. Names, source URLs, local paths, images, and private library exports are not automatically approved for external transmission. Any future visual API experiment needs explicit data-handling and content-policy compatibility checks. This documentation task sends no library data to Jev.

### 6.4 Experimental comparisons

Use identical frozen evidence and candidate sets:

- **A:** current production policy, including geometry arbitration and all safety gates;
- **B:** deterministic feature-based alternative; with sufficient independent labels, optionally a small local calibrated classifier;
- **C:** Jev with the same evidence;
- **D:** additional visual evidence with B;
- **E:** the same additional evidence with Jev, only if C or the routing experiment justifies it.

This separates improvements caused by more information from improvements caused by the decision model. Otherwise a new crop plus Jev might look better while Jev contributes nothing.

Compute threshold comparisons outside Jev. Check name/option-order sensitivity using opaque candidate IDs and controlled permutations. Include a no-match candidate and test cases where the correct identity is absent from the shortlist. Repeated calls or multiple correlated questions are not independent votes.

Keep Jev only if it provides a measurable coverage/quality or routing-efficiency improvement over the simpler baseline. High confidence alone, schema compliance, low input-token prices, and vendor benchmark claims are not sufficient adoption criteria.

## 7. Additional evidence for hard cases

Acquire evidence according to the failure reason, rather than running every expensive model on every image.

- **Overlapping people:** improve or disambiguate person regions before identity competition. Keep accepted independent identities intact.
- **Lookalikes/cosplay:** evaluate full-character and appropriately detected head/face views against corresponding reference views. A hard-coded face weight such as 0.65 is only a hypothesis, not a universal identity rule.
- **Source metadata:** when already available and trustworthy, use original character tags or other attributable source information as additional evidence. Inferred folder/series hints must not become circular proof; source tags can also be wrong.
- **Insufficient visual separation:** evaluate a second embedding model or a reference-conditioned vision-language comparison on the difficult subset. Provide the candidate references, not merely character names. Measure error, refusal/missing output, cost, and privacy compatibility.

CCIP versus an anime-adapted DINO model must be compared on the same person regions and frozen task. Do not combine raw distances across models or assume their score scales mean the same thing. Global-image CCIP behavior does not establish head-only behavior.

If a candidate is never retrieved or is excluded by the current series scope, reranking cannot recover it. Measure candidate recall and scope-related misses before increasing decision complexity. Broadening scope is a separate explicit contract change, not permission to ignore exclusions or classify every asset globally.

## 8. Reference lifecycle without turning the user into a trainer

Separate four concepts:

| State | Meaning | May authorize stronger future matching? |
| --- | --- | --- |
| Seed anchor | Explicitly supplied identity evidence | Yes, after validation |
| Observation | A machine result with complete provenance | Not by itself |
| Quarantined exemplar | A possible supporting example under evaluation | No production authority |
| Trusted supporting exemplar | Passed an independently evaluated admission policy | Only within that policy's limits |

Do not silently reinterpret current explicit supporting references as automatically learned truth. Initial experiments must leave the existing reference set untouched.

A later automatic-growth policy should require content/near-duplicate diversity, valid person selection, a traceable link to trusted seeds, and checks against known confusers. Different crops of one image are not separate reference votes. Multiple models examining the same image are not automatically independent witnesses.

Most importantly, avoid unrestricted transitive self-training: A admits B, B admits C, and C eventually changes the character identity. Preserve immutable seed versions and provenance for every admission. Support deactivation and reevaluation of dependent results when a seed or exemplar is invalidated. Never rewrite user decisions during rollback.

Confuser statistics can identify which candidates need extra examination. They do not establish ground-truth negatives. Reference inconsistency can trigger a reference-health warning, but without independent labels the system cannot honestly claim a particular reference increased the true error rate.

Automatic reference growth is a separate release gate, later than basic routing and reconsideration. Zero-maintenance operation does not require online weight training as its first implementation.

## 9. Bounded automatic reconsideration

The proposed future behavior is event-driven, not a periodic full-library rescan.

Reconsider affected unresolved regions after a meaningful dependency change: corrected/replaced seeds, a validated supporting-reference revision, an explicitly enabled policy/model version, repaired source evidence, or an approved scope change.

Reuse existing durable jobs, cache separation, generation checks, and stale-result rejection. Keep fresh arrivals ahead of historical work. Deduplicate by asset generation and evidence/policy identity. Persist retry budgets and reasons. Unchanged input must not repeatedly invoke Jev or an expensive visual model.

A service timeout is not a recognition decision. Apply bounded retry/backoff and preserve the local fast path. Offline operation must retain work without converting API failure into rejection, confirmation, or reference promotion.

Expose optional quiet progress/health information: unresolved count and age, reference-health issues, persistent infrastructure failures, and the reason work is waiting. A permanently growing hidden backlog is not an acceptable automation result.

This changes the current explicit historical-refresh policy and therefore needs its own implementation and acceptance review. It does not authorize a historical scan now.

## 10. Evaluation and rollout direction

### Stage 0 — Explain current failures

Add/reuse a machine-readable decision trace around reference eligibility, `automatic_evidence_regions`, `same_person`, `competitor_allows_automatic`, and `finalize_incremental`.

Start with a bounded set of real reported failures and existing labeled history. Report how many are blocked by insufficient references, same-person competition, geometry, missing/invalid evidence, scope, existing decisions, and downstream publication/display. Distinguish an absent membership from a committed membership not visible in a client.

**Exit:** each investigated failure has inspectable evidence and a reason code; the current frozen policy can be reproduced. Do not label an inferred cause as confirmed without its affected-asset trace.

### Stage 1 — Repair the automation contract

Resolve setup readiness versus automatic eligibility without restoring previously rejected over-permissive behavior. Evaluate either a complete validated initial reference pack or a separately calibrated seed-only bootstrap route. Select by measured safety and user effort, not by a new unexplained magic number.

Verify/fix independent-person recognition, overlapping-person handling, partial success, and idempotent publication in the existing architecture. Do not replace the established durable queue or membership model.

**Exit:** setup does not silently leave a character permanently in recommendation-only mode; independent identities can be added without requiring approval of the unresolved remainder. Targeted regression evidence accompanies any behavioral change.

### Stage 2 — Jev shadow comparison

Run the same frozen evidence through A/B/C from section 6. A few hundred difficult cases can screen usefulness, but cannot by themselves prove a very low whole-library error rate. Obtain representative incoming-asset evidence as a separate evaluation stream.

Start without online writes or automatic exemplar growth. Historical explicit labels can support the development experiment; routine users must not become a permanent labeling workforce. Where independent labels do not exist, report the uncertainty rather than substituting model outputs for truth.

**Exit:** a keep/drop decision for Jev based on incremental benefit, confidence intervals, failure slices, and measured whole-pipeline cost. No assumed recovery percentage.

### Stage 3 — Add evidence and bounded reprocessing

Address the largest remaining failure class with the smallest justified visual/source-evidence addition. Compare D/E to isolate Jev's contribution. Implement dependency-aware reconsideration only after its scheduling and stale-result behavior are verified.

**Exit:** difficult-case coverage improves without an unacceptable error increase; unchanged evidence does not churn, and new arrivals are not starved.

### Stage 4 — Controlled autonomous operation

After the policy passes evaluation, use a small reversible canary and validate result publication through the existing PC/server/mobile path. Introduce automatic exemplar admission only as a later separately tested change.

**Exit:** reduced real intervention, useful completion coverage, bounded unresolved age, preserved user decisions, and a tested rollback. A Jev adapter may remain disabled or be removed if simpler local logic is better.

These stages are dependency and acceptance guidance, not additional active backlog statuses or authorization to deploy.

## 11. What to measure

Report quality, completion, effort, and cost together:

- **Membership precision/recall:** correct asset-character relations, not only top-1 accuracy per image.
- **Per-person recognition and detection coverage:** distinguish missed people from wrong identities.
- **Exact image-set correctness:** whether every required character and no extra character was assigned; also report useful partial success.
- **End-to-end automation coverage:** completed eligible incoming assets/relations, including initial five-anchor characters and difficult cases in the denominator. Do not quietly exclude unresolved cases.
- **False memberships and interventions per 1,000 incoming assets:** use explicit denominators; include setup/reference-repair effort separately.
- **Pending count/age and reprocessing amplification:** old unresolved work, jobs/calls per evidence version, and fresh-work starvation.
- **Operational cost:** cold/warm extraction, CCIP comparison, Jev/network, any extra visual inference, queue latency, and publication latency measured separately.

Slice at least by same-series lookalikes, cosplay/costume change, multiple people, overlapping people, duplicate detections, same character repeated, unknown/not-registered identities, weak references, style shift, tiny/occluded faces, and missing candidate coverage.

Use calibration data to select thresholds, then a frozen held-out split for the final comparison. Group near-duplicates and keep references out of evaluation groups. Include representative easy inputs as well as difficult historical reviews; those reviews are selected and cannot estimate normal incoming traffic by themselves. [R4]

A new automatic policy must satisfy a predeclared false-positive budget and show useful completion improvement. The user has not specified a numerical error/cost budget in this discussion. Until that deployment decision is made and validated, experiments remain shadow-only. Report uncertainty bounds; zero observed errors in a small or correlated sample is not a guarantee.

Minimum regression scenarios include: two independent characters; one known plus one unresolved; one character repeated; two overlapping people; duplicate nested boxes; two strong candidates for one person; five-anchor bootstrap; fallback/invalid evidence; candidate absent from shortlist; late result after reference replacement; manual correction during inference; duplicate job completion; provider timeout; and unchanged-evidence retry suppression.

## 12. External projects: reusable ideas, not adopted replacements

| Reference | Useful comparison | Decision for this direction |
| --- | --- | --- |
| [AnimeCV][E3] | Reference-based identity matching; per-character score aggregation; face-region variants | Borrow evaluation/aggregation ideas. No claim it outperforms current CCIP. |
| [ZACI-20][E4] | Held-out identities and difficult comparison design | A reference for benchmark design, not a substitute for the user's real distributions. |
| [Anime Character Re-Identification][E5] | Detector, anime-adapted DINOv3, multiple identity observations, vector-store lookup | Optional visual/retrieval comparator. Its demo thresholds and automatic identity creation are not Lakomics policy. |
| [CCIP][E6] | Character-oriented comparison model family | Retain as the local baseline; distinguish pair metrics from asset-level automation. |
| [clip-anime-patch400-10k-v1][E7] | An anime retrieval model candidate discussed earlier | No default replacement, size/performance assumption, or adoption without a task-specific test. |
| [Animesion][E8] / [GLSim][E9] | Supervised fine-grained recognition and discriminative-region ideas | Research comparators, not immediate replacements for seed-based extensibility. |
| [TypeSafe Jev][E1] | Structured decisions, evidence interpretation, routing | Shadow-mode experiment with deterministic baselines and code-owned safety. |

These pointers preserve the conversation's research context. No cross-project accuracy ranking or benchmark result is established by this document. Recheck exact model availability, license/weight terms, preprocessing, runtime requirements, and maintenance before importing anything. A vector index is a later measured performance decision; if used with CCIP, retrieve candidates conservatively and preserve the validated final metric.

## 13. Scope and verification limits

This task documents requirements and direction only. It does not change thresholds, models, references, runtime code, credentials, production data, service configuration, or deployments. It does not call Jev, upload user images, execute a library scan, or establish benchmark results.

Evidence inspected here is GitHub source/documentation at the recorded baseline and the named first-party external sources. The locally installed application, active SQLite library, and affected real images were not inspected. Source inspection is not test execution or proof of current deployed behavior.

Before implementation, re-search the live checkout for the affected symbols and callers, check current changes and applicable instructions, reuse existing tests, and verify the runtime/reference/policy versions behind each reported failure. Keep the existing authority/publication boundaries; this work does not activate the deferred server-owned worker architecture.

**Recommended next deliverable:** a bounded failure-reason report plus a frozen current-policy replay, followed by a same-evidence Jev shadow comparison. The first production change should be the smallest demonstrated improvement, not an unconditional model replacement or self-training loop.

## Sources

Repository sources below are pinned to the inspected commit. External sources were accessed or retained as research pointers on 2026-09-21; pointers are not claims of local validation.

[R1]: https://github.com/lacucaracha421/chatgpt/blob/5b0690b153ac058b9a0cd4ac688bb7ab177f9c71/_tools/app/character-runtime/README.md
[R2]: https://github.com/lacucaracha421/chatgpt/blob/5b0690b153ac058b9a0cd4ac688bb7ab177f9c71/_tools/app/src-tauri/src/library/character_incremental.rs
[R3]: https://github.com/lacucaracha421/chatgpt/blob/5b0690b153ac058b9a0cd4ac688bb7ab177f9c71/_tools/app/src-tauri/src/library/character_scan.rs
[R4]: https://github.com/lacucaracha421/chatgpt/blob/5b0690b153ac058b9a0cd4ac688bb7ab177f9c71/_tools/app/character-runtime/HOLDOUT.md
[R5]: https://github.com/lacucaracha421/chatgpt/blob/5b0690b153ac058b9a0cd4ac688bb7ab177f9c71/_tools/app/character-runtime/shadow_rule_replay.py
[E1]: https://github.com/typesafe-ai/skills/blob/main/skills/typesafe-ai/SKILL.md
[E2]: https://github.com/typesafe-ai/typesafe-sdk-python/blob/main/README.md
[E3]: https://github.com/kosuke1701/AnimeCV
[E4]: https://github.com/kosuke1701/ZACI-20-dataset
[E5]: https://github.com/BeUnMerreHuman/Anime-Character-Re-Identification
[E6]: https://huggingface.co/deepghs/ccip
[E7]: https://huggingface.co/aki-0421/clip-anime-patch400-10k-v1
[E8]: https://github.com/arkel23/animesion
[E9]: https://github.com/arkel23/GLSim
