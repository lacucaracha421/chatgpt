"""Offline parser checks; run with python3 -m unittest discover -s android/tests -p test_perf_summary.py."""
import importlib.util
import io
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'tools/perf_summary.py'
spec = importlib.util.spec_from_file_location('perf_summary', SCRIPT)
perf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(perf)

SAMPLE = '''09-24 12:00:00.000 123 456 I LakomicsPerf: media id=A req=S-1 status=ok cache=miss queueMs=2 lockMs=1 ticketMs=20 batch=1:2:8 permitMs=1 downloadMs=40 bytes=100 commitMs=3 obtainMs=43 totalMs=70 inflightThumb=2 inflightMedia=0 queuedThumb=1 queuedMedia=0 queued=1
I/LakomicsPerf(123): js event=commit id=A req=S-1 kind=image prepared=0 source=native status=ok elapsedMs=90 nativeMs=72 decodeMs=85 commitMs=90
I/LakomicsPerf(123): media id=A req=S-2 status=ok cache=hit queueMs=1 lockMs=1 ticketMs=0 batch=- permitMs=0 downloadMs=0 bytes=0 commitMs=0 obtainMs=0 totalMs=4 inflightThumb=0 inflightMedia=0 queuedThumb=0 queuedMedia=0 queued=0
I/LakomicsPerf(123): js event=commit id=A req=S-2 kind=image prepared=0 source=native status=ok elapsedMs=12 nativeMs=6 decodeMs=10 commitMs=12
I/LakomicsPerf(123): js event=commit id=A req=S-3 kind=image prepared=1 source=prepared status=ok elapsedMs=1 commitMs=1
I/LakomicsPerf(123): media id=B req=S-4 status=canceled cache=miss totalMs=9999
I/LakomicsPerf(123): js event=end id=B req=S-4 kind=image prepared=0 source=native status=canceled elapsedMs=9999
'''


class PerfSummaryTest(unittest.TestCase):
    def test_cache_correlation_and_non_overlapping_js_phases(self):
        groups, excluded = perf.summarize(SAMPLE.splitlines())
        self.assertEqual(groups['native/media cache=miss']['batchHttpMs'], [8])
        self.assertEqual(groups['native/media cache=hit']['totalMs'], [4])
        self.assertEqual(groups['viewer/image cache=miss']['decodePhaseMs'], [13])
        self.assertEqual(groups['viewer/image cache=miss']['commitPhaseMs'], [5])
        self.assertEqual(groups['viewer/image cache=hit']['openToCommitMs'], [12])
        self.assertEqual(groups['viewer/image cache=prepared']['openToCommitMs'], [1])
        self.assertEqual(excluded, {'media/canceled': 1, 'viewer/canceled': 1})

    def test_retries_unmatched_memory_prefetch_and_malformed_numbers(self):
        groups, _ = perf.summarize([
            'thumbnail id=A status=ok cache=miss batch=1:2:8,2:1:4 totalMs=NaN',
            'js event=commit id=A req=missing kind=image source=native status=ok commitMs=5',
            'js event=commit id=A req=memory kind=image source=memory status=ok commitMs=2',
            'js event=prefetch_finish id=B req=prefetch kind=image source=memory status=ok elapsedMs=3',
            'unrelated output',
        ])
        self.assertEqual(groups['native/thumbnail cache=miss']['batchHttpMs'], [12])
        self.assertEqual(groups['native/thumbnail cache=miss']['batchSize'], [3])
        self.assertNotIn('totalMs', groups['native/thumbnail cache=miss'])
        self.assertEqual(groups['viewer/image cache=unmatched']['openToCommitMs'], [5])
        self.assertEqual(groups['viewer/image cache=memory']['openToCommitMs'], [2])
        self.assertEqual(groups['prefetch/image cache=memory']['totalMs'], [3])

    def test_percentiles(self):
        output = io.StringIO()
        perf.report((f'media status=ok cache=miss totalMs={n}' for n in range(1, 11)), output)
        self.assertIn('totalMs | 10 | 5.500 | 9.000 | 10.000', output.getvalue())

    def test_cli_file_and_stdin(self):
        stdin = subprocess.run([sys.executable, str(SCRIPT)], input=SAMPLE, text=True, capture_output=True, check=True)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'logcat.txt'
            path.write_text(SAMPLE)
            file = subprocess.run([sys.executable, str(SCRIPT), str(path)], text=True, capture_output=True, check=True)
        self.assertEqual(stdin.stdout, file.stdout)
        self.assertIn('viewer/image cache=miss | openToCommitMs | 1 | 90.000 | 90.000 | 90.000', file.stdout)


if __name__ == '__main__':
    unittest.main()
