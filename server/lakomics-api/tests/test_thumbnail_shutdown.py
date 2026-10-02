"""Cooperative shutdown during media work, using fixture storage and a real child."""
import io
import os
from pathlib import Path
import threading
import time
from unittest import mock

import image_thumbnails as thumbnails
from tests.test_image_thumbnails import Fixture, ASSET_IMAGE, png_bytes


class ThumbnailShutdownTests(Fixture):
    def test_stop_between_download_chunks_closes_body_and_skips_encode(self):
        payload = png_bytes()
        self.seed(ASSET_IMAGE, payload)
        worker = self.worker()
        reads = []
        class Body(io.BytesIO):
            def read(self, size):
                reads.append(size)
                worker.stop(timeout=0)
                return super().read(size)
        body = Body(payload)
        with mock.patch.object(self.s3, 'get_object', return_value={'Body': body}), mock.patch.object(
                worker, '_encode') as encode:
            self.assertTrue(worker.run_once())
        self.assertEqual(len(reads), 1)
        self.assertTrue(body.closed)
        encode.assert_not_called()
        job = self.jobs(ASSET_IMAGE)[0]
        self.assertEqual(job['state'], 'running')
        self.assertIsNone(job['last_error'])
        self.assertIsNone(self.thumbnail_key(ASSET_IMAGE))
        self.assertEqual(self.s3.puts, [])

    def test_stop_after_download_never_starts_encoder(self):
        self.seed(ASSET_IMAGE, png_bytes())
        worker = self.worker()
        with mock.patch.object(worker, '_download', side_effect=lambda *args: worker.stop(0)), mock.patch.object(
                worker, '_encode') as encode:
            self.assertTrue(worker.run_once())
        encode.assert_not_called()
        self.assertIsNone(self.jobs(ASSET_IMAGE)[0]['last_error'])

    def test_stop_before_encode_does_not_spawn(self):
        worker = self.worker()
        worker.stop(0)
        with mock.patch.object(thumbnails.subprocess, 'Popen') as spawn:
            with self.assertRaises(thumbnails._StopRequested):
                worker._encode('unused', 'unused', 'unused')
        spawn.assert_not_called()

    def test_stop_kills_and_reaps_encoder_promptly(self):
        if os.name != 'posix':
            self.skipTest('POSIX encoder process group required')
        pid_file = Path(self.temp.name) / 'encoder.pid'
        script = Path(self.temp.name) / 'encoder.py'
        script.write_text('import os,time\n' + f'open({str(pid_file)!r},"w").write(str(os.getpid()))\n'
                          + 'time.sleep(60)\n')
        worker = self.worker(encoder_script=str(script))
        results = []
        def encode():
            try:
                worker._encode('unused', 'unused', 'unused')
            except BaseException as exc:
                results.append(exc)
        thread = threading.Thread(target=encode)
        thread.start()
        try:
            deadline = time.monotonic() + 3
            while not pid_file.exists() and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue(pid_file.exists())
            began = time.monotonic()
            worker.stop(0)
            thread.join(1)
            self.assertFalse(thread.is_alive())
            self.assertLess(time.monotonic() - began, 1)
            self.assertEqual(len(results), 1)
            self.assertIsInstance(results[0], thumbnails._StopRequested)
            with self.assertRaises(ProcessLookupError):
                os.kill(int(pid_file.read_text()), 0)
        finally:
            worker.stop(0)
            thread.join(2)
