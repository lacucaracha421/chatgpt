"""Offline parser checks; run with python3 -m unittest discover -s android/tests -p test_perf_summary.py."""
from contextlib import contextmanager
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


@contextmanager
def log_file(data):
    # A file in the OS temp root also works in restricted Windows hosts where private temp
    # directories are inaccessible. Close before launching the reader (Windows sharing rules).
    with tempfile.NamedTemporaryFile(prefix='lakomics-perf-', suffix='.log', delete=False) as source:
        source.write(data)
        path = Path(source.name)
    try:
        yield path
    finally:
        path.unlink()


class PerfSummaryTest(unittest.TestCase):
    def test_byte_totals_include_failed_and_canceled_operations_separately(self):
        output = io.StringIO()
        perf.report([
            'media status=ok cache=miss bytes=100 totalMs=1',
            'media status=ok cache=miss bytes=250 totalMs=2',
            'media status=error cache=miss bytes=30 totalMs=9',
            'media status=canceled cache=miss bytes=20 totalMs=9',
            'startupRequest route=albums.commands lane=bridge status=ok runMs=1',
            'startupHttp route=albums.commands lane=bridge status=finished runMs=1',
            'startupHttp route=albums.commands lane=bridge status=finished runMs=2',
        ], output)
        text = output.getvalue()
        self.assertIn('total totals/operations media status=ok bytes=350', text)
        self.assertIn('total totals/operations media status=error bytes=30', text)
        self.assertIn('total totals/operations media status=canceled bytes=20', text)
        self.assertIn('total counts/startup operations route=albums.commands status=ok count=1', text)
        self.assertIn('total counts/startup requests route=albums.commands status=finished count=2', text)

    def test_screen_trigger_percentiles_missing_images_and_tap(self):
        output = io.StringIO()
        perf.report([
            'js screen=album trigger=open readyMs=10 imagesReadyMs=30 status=ok',
            'js screen=album trigger=open readyMs=20 imagesReadyMs=50 status=ok',
            'js screen=album trigger=back readyMs=5 imagesReadyMs=-1 status=incomplete',
            'js screen=folder trigger=open readyMs=-1 imagesReadyMs=-1 status=canceled',
            'js event=commit kind=image source=prepared status=ok commitMs=4 tapToDisplayedMs=14',
        ], output)
        self.assertIn('js/screen=album trigger=open status=ok | readyMs | 2 | 15.000 | 20.000 | 20.000', output.getvalue())
        groups, _ = perf.summarize(['js screen=album trigger=back readyMs=5 imagesReadyMs=-1 status=incomplete'])
        self.assertNotIn('imagesReadyMs', groups['js/screen=album trigger=back status=incomplete'])
        self.assertIn('tapToDisplayedMs | 1 | 14.000', output.getvalue())

    def test_session_http_uses_latest_snapshot_not_sum(self):
        groups, _ = perf.summarize([
            'sessionHttp route=download sessionMs=60000 requests=3 bytesIn=100 bytesOut=0 failed=1 failedBytesIn=30 canceled=0 canceledBytesIn=0',
            'sessionHttp route=download sessionMs=120000 requests=5 bytesIn=350 bytesOut=0 finished=3 failed=1 failedBytesIn=30 canceled=1 canceledBytesIn=20 pending=0',
            'sessionHttp route=albums.commands sessionMs=120000 requests=1 bytesIn=10 bytesOut=40 finished=1 failed=0 canceled=0 pending=0',
        ])
        self.assertEqual(groups['session/http route=download']['requests'], [5])
        self.assertEqual(groups['session/http route=download']['bytesIn'], [350])
        self.assertEqual(groups['session/http route=download']['failedBytesIn'], [30])
        self.assertEqual(groups['session/http route=download']['canceledBytesIn'], [20])
        self.assertEqual(groups['session/http route=albums.commands']['bytesOut'], [40])

    def test_windows_encodings_for_files_and_stdin(self):
        expected = subprocess.run([sys.executable, str(SCRIPT)], input=SAMPLE.encode('utf-8'), capture_output=True, check=True).stdout
        for encoding in ('utf-8-sig', 'utf-16', 'utf-16-le', 'utf-16-be'):
            with self.subTest(encoding=encoding), log_file(SAMPLE.encode(encoding)) as path:
                data = SAMPLE.encode(encoding)
                file = subprocess.run([sys.executable, str(SCRIPT), str(path)], capture_output=True, check=True)
                stdin = subprocess.run([sys.executable, str(SCRIPT)], input=data, capture_output=True, check=True)
                self.assertEqual(file.stdout, expected)
                self.assertEqual(stdin.stdout, expected)

    def test_cache_correlation_and_non_overlapping_js_phases(self):
        groups, excluded = perf.summarize(SAMPLE.splitlines())
        self.assertEqual(groups['native/media cache=miss']['batchHttpMs'], [8])
        self.assertEqual(groups['native/media cache=hit']['totalMs'], [4])
        self.assertEqual(groups['viewer/image cache=miss']['decodePhaseMs'], [13])
        self.assertEqual(groups['viewer/image cache=miss']['commitPhaseMs'], [5])
        self.assertEqual(groups['viewer/image cache=hit']['openToCommitMs'], [12])
        self.assertEqual(groups['viewer/image cache=prepared']['openToCommitMs'], [1])
        self.assertEqual(excluded, {'media/canceled': 1, 'viewer/canceled': 1})

    def test_entity_free_request_correlation(self):
        groups, _ = perf.summarize([
            'media req=MEASUREMENT status=ok cache=miss bytes=100 totalMs=70',
            'js event=commit req=MEASUREMENT kind=image source=native status=ok nativeMs=72 decodeMs=85 commitMs=90 tapToDisplayedMs=100',
        ])
        self.assertEqual(groups['viewer/image cache=miss']['openToCommitMs'], [90])
        self.assertEqual(groups['viewer/image cache=miss']['tapToDisplayedMs'], [100])

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

    def test_artwork_catalog_and_unique_batches(self):
        groups, excluded = perf.summarize([
            'collectionArtwork id=A status=ok cache=miss ticketMs=12 downloadMs=34 bytes=23000 totalMs=50',
            'catalogCover id=B status=ok cache=hit jsQueueMs=1 nativeQueueMs=2 storeMs=0 downloads=0 totalMs=3',
            'catalogCover id=C status=error cache=miss rateLimited=1 totalMs=99',
            'thumbnail status=ok cache=miss batch=7:24:112 totalMs=300',
            'thumbnail status=canceled cache=miss batch=7:24:112 totalMs=400',
            'js catalogScreen=S status=ok visible=12 loaded=11 firstCoverMs=120 visible90Ms=300',
            'js catalogScreen=T status=incomplete visible=12 loaded=1 firstCoverMs=120 visible90Ms=-1',
        ])
        self.assertEqual(groups['native/collectionArtwork cache=miss']['ticketMs'], [12])
        self.assertEqual(groups['native/catalogCover cache=hit']['jsQueueMs'], [1])
        self.assertEqual(groups['native/ticketBatches unique']['size'], [24])
        self.assertEqual(groups['native/ticketBatches unique']['httpMs'], [112])
        self.assertEqual(groups['js/catalogScreen']['visible90Ms'], [300])
        self.assertEqual(excluded, {'catalogCover/error': 1, 'thumbnail/canceled': 1, 'catalogScreen/incomplete': 1})

    def test_percentiles(self):
        output = io.StringIO()
        perf.report((f'media status=ok cache=miss totalMs={n}' for n in range(1, 11)), output)
        self.assertIn('totalMs | 10 | 5.500 | 9.000 | 10.000', output.getvalue())

    def test_cli_file_and_stdin(self):
        stdin = subprocess.run([sys.executable, str(SCRIPT)], input=SAMPLE, text=True, capture_output=True, check=True)
        with log_file(SAMPLE.encode('utf-8')) as path:
            file = subprocess.run([sys.executable, str(SCRIPT), str(path)], text=True, capture_output=True, check=True)
        self.assertEqual(stdin.stdout, file.stdout)
        self.assertIn('viewer/image cache=miss | openToCommitMs | 1 | 90.000 | 90.000 | 90.000', file.stdout)


if __name__ == '__main__':
    unittest.main()
