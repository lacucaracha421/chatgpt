# Standalone character classifier

This is an **opt-in, local shadow classifier**, separate from the existing native
scan worker. It does not change the app, references, decisions, jobs, settings,
cache namespaces, or source files. There is no publisher or network client.
Jev is not involved. Existing NumPy, Pillow and ONNX Runtime dependencies suffice.

## Pipeline

1. Reuse or extract person crops using the pinned detector and CCIP-S36 feature
   model. The encoder is frozen; no neural-network fine-tuning is performed.
2. Fit one small L2-regularized linear multiple-instance logistic head per target.
3. Select each head's acceptance boundary using calibration groups only.
4. Score people independently; union independently accepted target IDs for the
   image. A conflict on one crop does not cancel success on another crop.
5. Emit JSON with `accepted`, per-region evidence, hold reasons and
   `publication_allowed: false`. These are **shadow proposals**, not native
   automatic approvals or probabilities of being correct.

Each head has 768 weights and one bias. Training has a fixed iteration budget;
no hyperparameter sweep or test-set-driven refit is performed. ONNX uses two CPU
threads. Set `OPENBLAS_NUM_THREADS=2` before starting Python to bound NumPy's BLAS
threads as well (PowerShell: `$env:OPENBLAS_NUM_THREADS = '2'`).

## What is learned, and what is not

- Hash-matching, latest manual positive decisions mean **at least one detected
  crop** in the image contains the target. Training selects a latent highest-score
  witness; it does not label every person in a positive image as that character.
- A manual negative means no crop may establish that target. The highest-scoring
  crop is the hard negative during each optimization step.
- Missing memberships are unknown and excluded from supervised loss. Other
  accepted characters in a multi-person image never imply a negative for this one.
- Current seeds supply positive bags unless an explicit manual negative overrides
  them. A valid explicit reference-region selection narrows a positive seed bag.
  Earlier automatic/inferred region selections are not used as hard annotations.
- Automatically accepted folder memberships and unlabelled supporting references
  are not training truth. Supporting references with explicit manual labels may be
  used as training examples.
- A duplicate/source group supplies at most one training vote per target. Groups
  with conflicting labels are withheld. Whole-image detector fallbacks and stale
  explicit reference-region bindings do not train the head or authorize a match.
- Latent witnesses are **not** proof of correct person localization. A crop can
  contain multiple people, and a missed detection can make a positive bag invalid.
  No learned witness is saved back as a user reference.

## Data boundaries and split

The input is a frozen, read-only manifest in the previously established
`{"sha256": ..., "dataset": ...}` format. The CLI validates the dataset digest,
manual label provenance, content hashes, candidate scope, and reference identities.
Feature files are bound to S36 weights, detector/extraction identity and code.
There are no machine-specific source paths in implementation: the source library
comes from the manifest and image/model paths are explicit CLI arguments.

`fit` freezes a deterministic source-group-stratified 60/20/20
train/calibration/test assignment **before fitting**. All seed/support reference
source groups are training-only. Historical companion probes are excluded.
References, source groups and content hashes cannot authorize themselves as test
examples. Model bundles record inputs, split, feature files, source code, policy,
training IDs and calibration IDs and are exclusive-create, never updated in place.
Changing any of these requires a new run; training does not modify previous runs.

The current manifest was already inspected in earlier model experiments. A new
split of those images is **development evidence, not fresh generalization**.
`evaluate` states this explicitly and cannot approve deployment. A read-only audit
may discover other existing labelled images, but unlabelled or automatically
labelled arrivals must not be silently treated as new ground truth.

## Holds and uncertainty

At least two positive and two negative source groups are required for fitting and
for calibration. At least two positive calibration bags must clear all observed
negative calibration scores. Otherwise the target is held with a specific reason.
These are small-sample functional guards, **not sufficient production accuracy
criteria**. Zero false positives on two negatives does not establish safety.

Two ready heads passing on the same crop produce `competing_characters` for that
crop; a single ready passing head produces `accepted_shadow`. Unavailable heads
remain visible in `unavailable_heads`; they are not forced to match or inferred to
be negatives. Their absence also means competing-character coverage is incomplete.
Different overlapping boxes are not assumed to represent the same person. No
claim is made that bounding boxes have been deduplicated or segmented.

`predict` withholds exact content hashes used for training or calibration. It has
no live DB query, so it cannot check newly edited manual exclusions or near-duplicate
relationships for arbitrary new images. It must **not** be wired to a publisher
without the native owner rechecking scope, references, current manual judgments,
source identity, duplicate leakage and independently validated acceptance policy.

## Commands

Run from `_tools/app/character-runtime/` with the existing character-runtime Python.
Use `-B`; do not install dependencies or download models to run this tool. Create
new isolated output directories outside the source library first.

```text
python -B character_classifier.py extract --help
python -B character_classifier.py fit --help
python -B character_classifier.py evaluate --help
python -B character_classifier.py predict --help
```

- `extract --manifest PATH --output FEATURE_DIRECTORY --small-model ONNX
  --detector-models DIRECTORY [--reuse-features PREVIOUS_DIRECTORY] [--limit 30]`:
  validates source hashes before and after work, processes a bounded batch and
  writes content-addressed features. It can import the previous multi-character
  experiment's S36 vectors after identity checks. Missing vectors use read-only
  baseline-cache boxes where available, otherwise the local detector. The cache
  reader is constructed only in the isolated output directory.
- `fit --manifest PATH --features DIRECTORY --output EMPTY_RUN_DIRECTORY`:
  writes `split.json` first, then an immutable `model.json` with learned heads and
  per-target readiness/coverage. No test scores participate in fitting/calibration.
- `evaluate --manifest PATH --features DIRECTORY --model MODEL_JSON --output JSON`:
  evaluates only the frozen test groups, including partial labels and multi-label
  completion, and emits a non-adoption result with reasons. Do not tune against it.
- `predict --model MODEL_JSON --image PATH --small-model ONNX
  --detector-models DIRECTORY --output JSON [--candidate TARGET_ID ...]`:
  runs the actual image-to-proposal pipeline without accessing the database.
  Candidate IDs are explicit; by default all heads in the bundle are considered.

Model paths and source-library locations in generated bundles are local/private
artifacts, not portable deployment configuration. Keep bundles, feature files,
reports and manifests in ignored `.acceptance/` directories, never in Git.

## Updating after a user correction

A separately produced read-only snapshot can contain newer manual decisions. Fit
into a **new directory** from that snapshot and its compatible features; provenance
and fingerprints invalidate old evidence automatically. This provides an explicit
local rebuild path, not background retraining, reference promotion, or a mandatory
review inbox. Automatic quiet rebuilding and native activation are not implemented.

## Validation

```text
python -B -m unittest test_character_classifier -v
```

Synthetic tests cover weak bag-label semantics, source/group separation, manual
negative authority, unknown labels, immutable bundles, calibration-only boundaries,
partial success, collisions, fallbacks and output/source safety. Actual model
inference, unseen-image accuracy, Windows runtime and native publication need their
own evidence; synthetic success does not establish them.
