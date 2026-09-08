from pathlib import Path
import subprocess
import sys
import unittest


class OwnershipTests(unittest.TestCase):
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
