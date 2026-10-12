"""Optional DirectML constructors, outside the frozen CPU extraction contracts."""
from pathlib import Path
import sys

import onnxruntime as ort

from character_encoder import SmallEncoder, SMALL_SHA256
from runtime import Runtime, BASELINE, sha256


class DirectMLSessions:
    def __init__(self, intra_threads, inter_threads, *, no_spinning=False):
        self.options = ort.SessionOptions()
        self.options.intra_op_num_threads = intra_threads
        self.options.inter_op_num_threads = inter_threads
        if no_spinning:
            self.options.add_session_config_entry("session.intra_op.allow_spinning", "0")
        self.options.enable_mem_pattern = False
        self.options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL

    def session(self, path):
        session = ort.InferenceSession(str(path), sess_options=self.options,
                                       providers=["DmlExecutionProvider", "CPUExecutionProvider"])
        # ORT can silently retry with CPU after a provider initialization failure.
        if "DmlExecutionProvider" not in session.get_providers():
            raise RuntimeError("DirectML provider initialization failed")
        return session


class DirectMLRuntime(Runtime):
    def __init__(self, model_dir):
        for name, expected in BASELINE["sha256"].items():
            if sha256(model_dir / name) != expected:
                raise ValueError(f"Frozen model hash mismatch: {name}")
        sessions = DirectMLSessions(6, 1)
        self.detector = sessions.session(model_dir / "character-detector.onnx")
        self.feature = sessions.session(model_dir / "model_feat.onnx")
        self.metric = sessions.session(model_dir / "model_metrics.onnx")
        self.max_metric_vectors = 0


class DirectMLSmallEncoder(SmallEncoder):
    def __init__(self, small_model, detector_model, *, intra_threads=2, inter_threads=1):
        if sha256(Path(small_model)) != SMALL_SHA256:
            raise ValueError("Unexpected S36 model")
        if sha256(Path(detector_model)) != BASELINE["sha256"]["character-detector.onnx"]:
            raise ValueError("Unexpected detector")
        sessions = DirectMLSessions(intra_threads, inter_threads, no_spinning=True)
        self.feature = sessions.session(small_model)
        self.detector_path, self.options = detector_model, sessions.options
        # Populate it now so the inherited, frozen detect() does not create a CPU session.
        self.detector = sessions.session(detector_model)


_fallback_reported = False


def _create(cpu, directml, args, kwargs, gpu):
    global _fallback_reported
    if gpu and "DmlExecutionProvider" in ort.get_available_providers():
        try:
            return directml(*args, **kwargs)
        except Exception as error:
            if not _fallback_reported:
                print(f"DirectML unavailable; using CPU: {error}", file=sys.stderr, flush=True)
                _fallback_reported = True
    return cpu(*args, **kwargs)


def create_runtime(models, *, gpu=False):
    return _create(Runtime, DirectMLRuntime, (models,), {}, gpu)


def create_encoder(small_model, detector_model, *, gpu=False, intra_threads=2, inter_threads=1):
    return _create(SmallEncoder, DirectMLSmallEncoder, (small_model, detector_model),
                   {"intra_threads": intra_threads, "inter_threads": inter_threads}, gpu)
