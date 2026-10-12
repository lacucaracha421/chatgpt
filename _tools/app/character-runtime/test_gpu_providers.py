"""Fixture-only provider selection and unchanged CPU feature identities."""
import io
from pathlib import Path
import subprocess
import unittest
from unittest.mock import Mock, patch

import onnxruntime as ort

import character_encoder
import feature_cache
import gpu_providers as gpu
import scan_worker
from character_head import fingerprint
from runtime import BASELINE


class GPUProviderTests(unittest.TestCase):
    def setUp(self):
        self.models = Path("/fixture/models")
        self.encoder_args = (self.models / "small.onnx", self.models / "character-detector.onnx")

    def test_flag_off_never_queries_providers_and_uses_original_cpu_constructors(self):
        with patch.object(gpu, "Runtime") as runtime, patch.object(gpu, "SmallEncoder") as encoder, \
                patch.object(gpu.ort, "get_available_providers") as available:
            self.assertIs(gpu.create_runtime(self.models), runtime.return_value)
            self.assertIs(gpu.create_encoder(*self.encoder_args), encoder.return_value)
            available.assert_not_called()
            runtime.assert_called_once_with(self.models)
            encoder.assert_called_once_with(*self.encoder_args, intra_threads=2, inter_threads=1)

    def test_flag_on_without_directml_uses_original_cpu_constructors(self):
        with patch.object(gpu, "Runtime") as runtime, patch.object(gpu, "SmallEncoder") as encoder, \
                patch.object(gpu.ort, "get_available_providers", return_value=["CPUExecutionProvider"]), \
                patch.object(gpu, "DirectMLSessions") as sessions:
            gpu.create_runtime(self.models, gpu=True)
            gpu.create_encoder(*self.encoder_args, gpu=True)
            runtime.assert_called_once()
            encoder.assert_called_once()
            sessions.assert_not_called()

    def test_directml_first_for_every_b36_and_s36_session(self):
        session = Mock()
        session.get_providers.return_value = ["DmlExecutionProvider", "CPUExecutionProvider"]
        hashes = list(BASELINE["sha256"].values()) + [gpu.SMALL_SHA256, BASELINE["sha256"]["character-detector.onnx"]]
        with patch.object(gpu.ort, "get_available_providers", return_value=session.get_providers()), \
                patch.object(gpu, "sha256", side_effect=hashes), \
                patch.object(gpu.ort, "InferenceSession", return_value=session) as create:
            runtime = gpu.create_runtime(self.models, gpu=True)
            encoder = gpu.create_encoder(*self.encoder_args, gpu=True, intra_threads=4)
        self.assertIsInstance(runtime, gpu.DirectMLRuntime)
        self.assertIsInstance(encoder, gpu.DirectMLSmallEncoder)
        self.assertIs(encoder.detector, session)
        self.assertEqual(create.call_count, 5)
        for index, call in enumerate(create.call_args_list):
            self.assertEqual(call.kwargs["providers"], ["DmlExecutionProvider", "CPUExecutionProvider"])
            options = call.kwargs["sess_options"]
            self.assertFalse(options.enable_mem_pattern)
            self.assertEqual(options.execution_mode, ort.ExecutionMode.ORT_SEQUENTIAL)
            self.assertEqual(options.intra_op_num_threads, 6 if index < 3 else 4)
            self.assertEqual(options.inter_op_num_threads, 1)
        self.assertEqual(encoder.options.get_session_config_entry("session.intra_op.allow_spinning"), "0")
        self.assertIs(gpu.DirectMLRuntime.extract, gpu.Runtime.extract)
        self.assertIs(gpu.DirectMLSmallEncoder.detect, gpu.SmallEncoder.detect)
        self.assertIs(gpu.DirectMLSmallEncoder.extract, gpu.SmallEncoder.extract)

    def test_directml_failure_falls_back_with_cpu_options_and_one_stderr_line(self):
        cpu_session = Mock()
        hashes = list(BASELINE["sha256"].values()) * 2
        with patch.object(gpu.ort, "get_available_providers", return_value=["DmlExecutionProvider"]), \
                patch.object(gpu, "sha256", side_effect=hashes), \
                patch("runtime.sha256", side_effect=list(BASELINE["sha256"].values())), \
                patch.object(gpu.ort, "InferenceSession", side_effect=[RuntimeError("fixture DML failure")] + [cpu_session] * 3) as create, \
                patch.object(gpu, "_fallback_reported", False), patch("sys.stderr", new_callable=io.StringIO) as stderr:
            runtime = gpu.create_runtime(self.models, gpu=True)
        self.assertIs(type(runtime), gpu.Runtime)
        self.assertEqual(len(stderr.getvalue().splitlines()), 1)
        for call in create.call_args_list[1:]:
            self.assertEqual(call.kwargs["providers"], ["CPUExecutionProvider"])
            self.assertTrue(call.kwargs["sess_options"].enable_mem_pattern)
            self.assertEqual(call.kwargs["sess_options"].intra_op_num_threads, 6)

    def test_s36_silent_provider_fallback_rebuilds_original_lazy_cpu_encoder(self):
        session = Mock()
        session.get_providers.return_value = ["CPUExecutionProvider"]
        hashes = [gpu.SMALL_SHA256, BASELINE["sha256"]["character-detector.onnx"]]
        with patch.object(gpu.ort, "get_available_providers", return_value=["DmlExecutionProvider"]), \
                patch.object(gpu, "sha256", side_effect=hashes), \
                patch("character_encoder.sha256", side_effect=hashes), \
                patch.object(gpu.ort, "InferenceSession", return_value=session) as create, \
                patch("sys.stderr", new_callable=io.StringIO):
            encoder = gpu.create_encoder(*self.encoder_args, gpu=True, intra_threads=4)
        self.assertIs(type(encoder), gpu.SmallEncoder)
        self.assertIsNone(encoder.detector)
        self.assertEqual(create.call_args.kwargs["providers"], ["CPUExecutionProvider"])
        self.assertTrue(encoder.options.enable_mem_pattern)
        self.assertEqual(encoder.options.intra_op_num_threads, 4)

    def test_frozen_model_checks_are_not_bypassed(self):
        with patch.object(gpu, "sha256", return_value="wrong"), \
                patch.object(gpu.ort, "InferenceSession") as session:
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                gpu.DirectMLRuntime(self.models)
            with self.assertRaisesRegex(ValueError, "Unexpected S36"):
                gpu.DirectMLSmallEncoder(*self.encoder_args)
            session.assert_not_called()

    def test_scan_worker_gpu_flag_reaches_s36_factory(self):
        args = scan_worker.runtime_arguments(["--models", str(self.models), "--cache", "/fixture/cache",
                                             "--augmentation-model", str(self.encoder_args[0]), "--gpu"])
        with patch.object(gpu, "create_encoder") as create:
            scan_worker.configured_encoder(args)
        create.assert_called_once_with(*self.encoder_args, gpu=True, intra_threads=2, inter_threads=1)

    def test_equivalence_cli_uses_the_same_gpu_factories(self):
        import feature_equivalence as tool
        report = {"equivalent": True, "errors": []}
        with patch.object(tool, "verify", return_value=report) as verify, \
                patch.object(gpu, "create_runtime") as runtime, patch.object(gpu, "create_encoder") as encoder, \
                patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(tool.main(["--library", "/fixture/library", "--models", str(self.models), "--gpu"]), 0)
            self.assertTrue(verify.call_args.kwargs["require_gpu"])
            verify.call_args.kwargs["runtime_factory"](self.models)
            verify.call_args.kwargs["encoder_factory"](*self.encoder_args)
        runtime.assert_called_once_with(self.models, gpu=True)
        encoder.assert_called_once_with(*self.encoder_args, gpu=True)

    def test_gpu_equivalence_refuses_a_cpu_fallback_receipt(self):
        import feature_equivalence as tool
        entries = [Path(f"{index:064x}.npz") for index in range(tool.MIN_SAMPLE)]
        db = Mock()
        db.execute.return_value = [(entry.stem,) for entry in entries]
        session = Mock()
        session.get_providers.return_value = ["CPUExecutionProvider"]
        engine = Mock(feature=session, detector=session, metric=session)
        factory = Mock(return_value=engine)
        for kind in ("b36", "s36"):
            with patch.object(tool, "old_namespace", return_value=("a" * 64, Path("/fixture/cache"))), \
                    patch.object(tool, "cache_entries", return_value=entries):
                report = tool.verify_kind(db, Path("/fixture/library"), self.models, kind,
                                          tool.MIN_SAMPLE, None, factory, factory, require_gpu=True)
            self.assertFalse(report["equivalent"])
            self.assertEqual(report["sample_size"], 0)
            self.assertIn("requires active DirectML", report["errors"][0])

    def test_cpu_extraction_fingerprint_and_s36_feature_id_match_head(self):
        root = Path(__file__).resolve().parents[3]
        def head_source(name):
            return subprocess.check_output(["git", "show", f"HEAD:_tools/app/character-runtime/{name}"],
                                           cwd=root, encoding="utf-8")
        baseline = feature_cache.extraction_fingerprint(head_source("runtime.py"))
        self.assertEqual(feature_cache.extraction_fingerprint(), baseline)
        with patch.object(character_encoder, "extraction_fingerprint", return_value=baseline):
            head_id = fingerprint(character_encoder.contract(head_source("character_encoder.py")))
        self.assertEqual(character_encoder.feature_id(), head_id)


if __name__ == "__main__":
    unittest.main()
