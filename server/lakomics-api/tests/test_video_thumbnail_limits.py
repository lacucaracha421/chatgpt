"""Video thumbnails get wider limits, and running out of time is retried, not terminal."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from tests.test_image_thumbnails import Fixture, requires_posix
import image_thumbnail_encode as encoder
import image_thumbnails as worker_module

SERVER_DIR = Path(__file__).resolve().parents[1]


class EncoderVideoLimitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.source = Path(self.temp.name) / "source"
        self.source.write_bytes(b"\x00\x00\x00\x18ftypmp42")
        self.original_run, self.original_probe = encoder._run_bounded, encoder._probe_display

    def tearDown(self):
        encoder._run_bounded, encoder._probe_display = self.original_run, self.original_probe
        encoder._last_run_timed_out = False
        self.temp.cleanup()

    def decode_with(self, code, timed_out):
        def fake(command, timeout, limit_bytes=None):
            encoder._last_run_timed_out = timed_out
            return code, b""
        encoder._run_bounded = fake
        encoder._probe_display = lambda _path: (3840, 2160, 12678)
        return encoder._video_thumbnail(str(self.source))

    def test_a_decode_that_runs_out_of_wall_clock_is_a_timeout(self):
        with self.assertRaises(encoder._TimedOut):
            self.decode_with(None, True)

    def test_a_decode_killed_for_cpu_time_is_a_timeout(self):
        import signal
        with self.assertRaises(encoder._TimedOut):
            self.decode_with(-signal.SIGXCPU, False)

    def test_an_output_overrun_or_a_decoder_error_stays_an_encode_failure(self):
        for code in (None, 1, 245):
            with self.subTest(code=code), self.assertRaises(encoder._EncodeFailed):
                self.decode_with(code, False)

    def test_a_probe_that_runs_out_of_wall_clock_is_a_timeout(self):
        def fake(command, timeout, limit_bytes=None):
            encoder._last_run_timed_out = True
            return None, b""
        encoder._run_bounded = fake
        with self.assertRaises(encoder._TimedOut):
            encoder._probe_display(str(self.source))

    def test_main_reports_a_timeout_with_its_own_exit_code(self):
        program = (
            "import sys\n"
            f"sys.path.insert(0, {str(SERVER_DIR)!r})\n"
            "import image_thumbnail_encode as encoder\n"
            "encoder._apply_own_resource_limits = lambda: True\n"
            "encoder._pillow_available = lambda: True\n"
            "encoder._toolchain_available = lambda: True\n"
            "def timed_out(_path):\n"
            "    raise encoder._TimedOut\n"
            "encoder._video_thumbnail = timed_out\n"
            "sys.exit(encoder.main(['encoder', sys.argv[1], sys.argv[2], 'video']))\n"
        )
        completed = subprocess.run(
            [sys.executable, "-c", program, str(self.source), str(Path(self.temp.name) / "out")],
            capture_output=True, timeout=60, check=False)
        self.assertEqual(completed.returncode, encoder.EXIT_TIMED_OUT, completed.stderr[-400:])

    @requires_posix
    def test_a_video_run_applies_the_wider_address_space_and_cpu_limits(self):
        program = (
            "import sys, resource\n"
            f"sys.path.insert(0, {str(SERVER_DIR)!r})\n"
            "import image_thumbnail_encode as encoder\n"
            "encoder._use_kind_limits('video')\n"
            "assert encoder._apply_own_resource_limits() is True\n"
            "soft, _hard = resource.getrlimit(resource.RLIMIT_AS)\n"
            "assert soft == encoder.VIDEO_ADDRESS_SPACE_BYTES, soft\n"
            "cpu, _hard = resource.getrlimit(resource.RLIMIT_CPU)\n"
            "assert cpu == encoder.VIDEO_CPU_LIMIT_SECONDS, cpu\n"
            "assert encoder._active_limits['decode_timeout'] == encoder.VIDEO_DECODE_TIMEOUT_SECONDS\n"
            "print('video-bounded')\n"
        )
        completed = subprocess.run([sys.executable, "-c", program], capture_output=True,
                                   timeout=60, check=False)
        self.assertEqual(completed.returncode, 0, completed.stderr[-400:])
        self.assertEqual(completed.stdout.strip(), b"video-bounded")

    def test_image_runs_keep_the_original_limits(self):
        encoder._use_kind_limits("video")
        encoder._use_kind_limits("image")
        self.assertEqual(encoder._active_limits["address_space"], encoder.ADDRESS_SPACE_BYTES)
        self.assertEqual(encoder._active_limits["decode_timeout"], encoder.DECODE_TIMEOUT_SECONDS)
        self.assertLess(encoder.ADDRESS_SPACE_BYTES, encoder.VIDEO_ADDRESS_SPACE_BYTES)


class WorkerTimeoutTests(Fixture):
    def script(self, body):
        path = Path(self.temp.name) / "encoder.py"
        path.write_text(body)
        return str(path)

    @requires_posix
    def test_an_encoder_timeout_is_transient_and_retried(self):
        worker = self.worker(encoder_script=self.script("import sys\nsys.exit(8)\n"))
        with self.assertRaises(worker_module._TransientError) as raised:
            worker._encode("asset", "unused", "unused", "video")
        self.assertEqual(str(raised.exception), worker_module.E_RETRY["encodeTimedOut"])

    @requires_posix
    def test_a_video_run_gets_the_wider_outer_bound(self):
        # Sleeps past the image bound but well inside the video bound.
        body = "import time\ntime.sleep(1.2)\n"
        worker = self.worker(encoder_script=self.script(body))
        original = (worker_module.ENCODE_TIMEOUT_SECONDS, worker_module.VIDEO_ENCODE_TIMEOUT_SECONDS)
        worker_module.ENCODE_TIMEOUT_SECONDS, worker_module.VIDEO_ENCODE_TIMEOUT_SECONDS = 0.5, 5.0
        try:
            worker._encode("asset", "unused", "unused", "video")
            with self.assertRaises(worker_module._TransientError):
                worker._encode("asset", "unused", "unused", "image")
        finally:
            worker_module.ENCODE_TIMEOUT_SECONDS, worker_module.VIDEO_ENCODE_TIMEOUT_SECONDS = original


if __name__ == "__main__":
    unittest.main()
