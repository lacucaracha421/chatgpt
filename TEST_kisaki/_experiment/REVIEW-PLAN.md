# 에이메스 검토 흐름 실험

User-approved scope: independent experiment, same 72 images and cached CCIP matrix. No original file moves, Lakomics integration, uploads or model retraining.

1. Add a pure workflow engine: series/character virtual folders, tentative/confirmed/inbox/held states, explicit reference registration, positive correction and negative evidence. Recompute only unconfirmed, unheld records. Use minimum positive distance plus nearest-negative veto (negative <= positive); keep close competing characters in inbox. This is an experimental rule, not calibrated confidence.
2. Add a local interactive review UI: grouped folders and tabs, bounded visible multi-selection, approve, correct destination, hold, reject, register/remove reference, latest-action undo. Persist dataset-specific browser state, retain undo history, export JSON. Preserve old page and browser storage keys.
3. Compare before/after negative feedback on the SAME remaining unreviewed images, excluding reference/feedback duplicate groups. Folder truth may be used only for initial five reference labels and evaluation; it must not drive recommendations or manual actions.
4. Add focused regression tests for confirmed protection, negative correction reversal, opt-in references, hold semantics, multi-character ambiguity and latest-action undo. Run an actual-data one-rejection diagnostic without applying it to the user's saved experiment.
5. Verify actual browser correction/create-folder/undo flow; finish on a fresh state with 5 reference images, ready for user review. Document limits: only Aimes-vs-other ground truth; other characters require user naming and references; no independent generalization claim from this already-inspected sample.

Files: public/review-engine.mjs, public/review-app.mjs, public/index.html, public/review.css, review-engine.test.mjs, review-evaluate.mjs, REVIEW-README.md.
