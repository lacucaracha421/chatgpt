# Marcus reference search experiment

Standalone experiment approved in the task conversation. No Lakomics integration.

- Read only images directly in the parent directory and its `man` directory.
- `man` is the user-provided positive label; all other input images are negative.
- Ignore videos, report unreadable images, retain file hashes to verify no source changes.
- Download CCIP ONNX feature and metric models from the official DeepGHS repository; record revision and hashes. Local CPU inference only.
- Cache features by content hash and model/preprocessing identity.
- Reserve a deterministic five-image positive reference pool. Compare 1/3/5 references against the same remaining positives and all negatives. Exclude detected reference duplicates.
- Rank by minimum official CCIP distance to a reference, never by folder/name. Folder labels are only for reference selection and evaluation.
- Show a localhost-only interactive gallery with reference controls, ground-truth reveal and precision/recall counts. Similarity distance is not probability.
- Verify real inference, reference exclusion, source hashes, HTTP and browser interaction. No app builds, Git operations or production library writes.

Files: analyze.py (local inference and report), index.html (interactive results), serve.py (restricted localhost serving), run.ps1 (one-command entry point), README.md (usage and evidence).
