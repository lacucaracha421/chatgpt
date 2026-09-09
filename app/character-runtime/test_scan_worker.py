from pathlib import Path
import subprocess
import sys
import unittest
import os
import json
import hashlib
import tempfile
import queue
import threading


class OwnershipTests(unittest.TestCase):
    @unittest.skipUnless(os.environ.get("LAKOMICS_CHARACTER_TEST_MODELS"), "explicit model directory required")
    def test_resident_query_matches_legacy_and_reuses_reference_bundle(self):
        from PIL import Image, ImageDraw
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            items = []
            for index in range(6):
                path = root / f"image-{index}.png"
                image = Image.new("RGB", (128, 128), (30 + index * 20, 70, 110))
                ImageDraw.Draw(image).rectangle((20, 15 + index, 80, 100), fill=(180, 100 + index, 50))
                image.save(path)
                items.append({"path": str(path), "hash": hashlib.sha256(path.read_bytes()).hexdigest(), "assetId": str(index)})
            process = subprocess.Popen([sys.executable, "-B", str(Path(__file__).with_name("scan_worker.py")),
                                        "--models", os.environ["LAKOMICS_CHARACTER_TEST_MODELS"], "--cache", str(root / "cache")],
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            responses = queue.Queue()
            def read():
                for line in process.stdout:
                    responses.put(line)
            threading.Thread(target=read, daemon=True).start()
            def receive():
                return json.loads(responses.get(timeout=45))
            def request(kind, **kwargs):
                process.stdin.write(json.dumps({"type": kind, **kwargs}) + "\n")
                process.stdin.flush()
                return receive()
            try:
                self.assertEqual(receive()["type"], "ready")
                prepared = request("prepare", references=items[:5])
                self.assertEqual(prepared["type"], "prepared")
                legacy = request("query", **items[5])
                self.assertEqual(legacy["type"], "result")
                loaded = request("load_query", **items[5])
                self.assertEqual(loaded["type"], "query_loaded")
                again = request("prepare", references=items[:5])
                self.assertEqual(again["cacheHits"], loaded["cacheHits"])
                compared = request("compare_query", assetId="5", hash=items[5]["hash"])
                comparable = lambda result: {k: v for k, v in result.items() if k not in ("cacheHits", "extractions")}
                self.assertEqual(comparable(legacy), comparable(compared))
                self.assertEqual(compared["extractions"], loaded["extractions"])
                self.assertEqual(compared["cacheHits"], loaded["cacheHits"])
            finally:
                process.kill()
                process.wait(timeout=5)
                process.stdin.close()
                process.stdout.close()
                process.stderr.close()

    def test_stdin_owner_loss_exits_while_main_thread_is_busy(self):
        code = """import queue,threading,time
from scan_worker import read_requests
threading.Thread(target=read_requests,args=(queue.Queue(1),),daemon=True).start()
print('ready',flush=True)
time.sleep(30)
"""
        process = subprocess.Popen([sys.executable, "-B", "-c", code],
                                   cwd=Path(__file__).parent, stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(process.stdout.readline().strip(), "ready")
            process.stdin.close()
            self.assertEqual(process.wait(timeout=3), 0)
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()
            process.stdout.close()
            process.stderr.close()
