"""Media queue and metadata publication against disposable SQLite and fake R2."""
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
from unittest import mock

from tests.test_image_thumbnails import Fixture, Image, png_bytes, requires_pillow, requires_posix
import image_thumbnails as worker_module


def _process_alive(pid):
    """True while ``pid`` exists and is not a zombie.

    The process can exit and be reaped between any two reads, so a missing
    ``/proc/<pid>/stat`` at any point means the process is gone.
    """
    try:
        stat = (Path('/proc') / str(pid) / 'stat').read_text()
    except (FileNotFoundError, ProcessLookupError):
        return False
    # The comm field is parenthesized and may contain spaces; the state follows it.
    return stat.rsplit(')', 1)[1].split()[0] != 'Z'


def gif_bytes():
    sink = io.BytesIO()
    frames = [Image.new('RGB', (800, 400), color) for color in ('red', 'blue')]
    frames[0].save(sink, 'GIF', save_all=True, append_images=frames[1:], duration=120)
    return sink.getvalue()


@requires_pillow
@requires_posix
class MediaWorkerTests(Fixture):
    def metadata(self, asset):
        return tuple(self.db.execute('SELECT width,height,duration_ms FROM assets WHERE id=?', [asset]).fetchone())

    def test_new_image_metadata_is_published_with_thumbnail_not_tile_dimensions(self):
        self.seed('image', png_bytes((1600, 900)))
        self.assertEqual(self.metadata('image'), (None, None, None))
        self.worker().run_once()
        self.assertEqual(self.metadata('image'), (1600, 900, None))
        self.assertIsNotNone(self.thumbnail_key('image'))
        self.assertEqual(self.jobs('image')[0]['state'], 'done')

    def test_existing_complete_metadata_is_preserved(self):
        self.seed('image', png_bytes())
        self.db.execute('UPDATE assets SET width=700,height=500,duration_ms=0 WHERE id=?', ['image'])
        self.db.commit()
        self.worker().run_once()
        self.assertEqual(self.metadata('image'), (700, 500, 0))

    def test_partial_dimensions_are_filled_only_when_the_existing_side_agrees(self):
        for asset, width, expected in [('matching', 800, (800, 600, None)),
                                       ('conflicting', 700, (700, None, None))]:
            with self.subTest(asset=asset):
                self.seed(asset, png_bytes())
                self.db.execute('UPDATE assets SET width=? WHERE id=?', [width, asset])
                self.db.commit()
                self.worker().run_once()
                self.assertEqual(self.metadata(asset), expected)
                self.assertIsNotNone(self.thumbnail_key(asset))

    def test_download_closes_body_when_get_object_exhausts_the_budget(self):
        body = io.BytesIO(b'body')
        worker = self.worker()
        with mock.patch.object(self.s3, 'get_object', return_value={'Body': body}), mock.patch.object(
                worker_module.time, 'monotonic', side_effect=[0, 61]):
            with self.assertRaises(worker_module._TransientError):
                worker._download('test', str(Path(self.temp.name) / 'download'), 4, 'unused')
        self.assertTrue(body.closed)

    def test_gif_and_legacy_image_gif_use_pillow_without_ffmpeg(self):
        for asset, kind in [('gif', 'gif'), ('legacy', 'image')]:
            self.seed(asset, gif_bytes(), kind=kind, content_type='image/gif')
        with mock.patch.dict(os.environ, {'LAKOMICS_FFMPEG': '/missing/ffmpeg', 'LAKOMICS_FFPROBE': '/missing/ffprobe'}):
            worker = self.worker()
            worker.run_once()
            worker.run_once()
        for asset in ('gif', 'legacy'):
            self.assertEqual(self.metadata(asset), (800, 400, None))
            key = self.thumbnail_key(asset)
            self.assertIn('/gif/', key)
            with Image.open(io.BytesIO(self.s3.objects[key]['body'])) as tile:
                self.assertEqual(tile.size, (512, 256))
                self.assertEqual(getattr(tile, 'n_frames', 1), 1)
        self.assertEqual(self.thumbnail_key('gif'), self.thumbnail_key('legacy'))

    def test_missing_video_tools_is_terminal_but_next_image_still_works(self):
        self.seed('video', b'video', kind='video', content_type='video/mp4')
        self.seed('image', png_bytes())
        worker = self.worker()
        with mock.patch.dict(os.environ, {'LAKOMICS_FFMPEG': '/missing/ffmpeg', 'LAKOMICS_FFPROBE': '/missing/ffprobe'}):
            worker.run_once()
            worker.run_once()
        job = self.jobs('video')[0]
        self.assertEqual((job['state'], job['attempts'], job['last_error']), ('failed', 1, 'encodeToolUnavailable'))
        self.assertIsNone(self.thumbnail_key('video'))
        self.assertIsNotNone(self.thumbnail_key('image'))

    def test_video_and_gif_mp4_route_container_without_changing_asset_kind(self):
        ffmpeg = shutil.which('ffmpeg')
        if not ffmpeg or not shutil.which('ffprobe'):
            self.skipTest('FFmpeg/FFprobe unavailable; real video decode not checked')
        source = Path(self.temp.name) / 'clip.mp4'
        subprocess.run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-nostdin',
                        '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=10', '-t', '1',
                        '-threads', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(source)],
                       check=True, timeout=20, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for asset, kind in [('video', 'video'), ('gif-mp4', 'gif')]:
            self.seed(asset, source.read_bytes(), kind=kind, content_type='video/mp4')
        worker = self.worker()
        worker.run_once()
        worker.run_once()
        for asset, kind in [('video', 'video'), ('gif-mp4', 'gif')]:
            self.assertEqual(self.jobs(asset)[0]['state'], 'done', self.jobs(asset))
            width, height, duration = self.metadata(asset)
            self.assertEqual((width, height), (160, 90))
            self.assertTrue(900 <= duration <= 1100)
            self.assertEqual(self.db.execute('SELECT kind FROM assets WHERE id=?', [asset]).fetchone()[0], kind)
            self.assertIn('/video/', self.thumbnail_key(asset))

    def test_install_upgrades_old_image_only_trigger_without_historical_enqueue(self):
        self.db.executescript("DROP TRIGGER image_thumbnail_jobs_insert; CREATE TRIGGER image_thumbnail_jobs_insert AFTER INSERT ON assets WHEN NEW.kind='image' BEGIN INSERT OR IGNORE INTO image_thumbnail_jobs(asset_id,state,created_at,updated_at) VALUES(NEW.id,'queued',0,0); END;")
        self.seed('historical-video', b'old', kind='video', content_type='video/mp4')
        self.assertEqual(self.jobs(), [])
        worker_module.install(self.db)
        worker_module.install(self.db)
        self.assertEqual(self.jobs(), [])
        self.seed('new-video', b'new', kind='video', content_type='video/mp4')
        self.assertEqual([job['asset_id'] for job in self.jobs()], ['new-video'])

    def test_video_source_bound_is_enforced_before_download(self):
        self.seed('video', b'video', kind='video', content_type='video/mp4')
        self.db.execute('UPDATE assets SET size_bytes=? WHERE id=?', [worker_module.MAX_VIDEO_SOURCE_BYTES + 1, 'video'])
        self.db.commit()
        with mock.patch.object(self.s3, 'get_object', wraps=self.s3.get_object) as download:
            self.worker().run_once()
            download.assert_not_called()
        self.assertEqual(self.jobs('video')[0]['last_error'], 'sourceTooLarge')

    def test_same_digest_but_changed_kind_cannot_publish_metadata(self):
        self.seed('image', png_bytes())
        original = self.s3.put_object
        def change(**kwargs):
            self.db.execute("UPDATE assets SET kind='video' WHERE id='image'")
            self.db.commit()
            return original(**kwargs)
        self.s3.put_object = change
        self.worker().run_once()
        self.assertEqual(self.jobs('image')[0]['last_error'], 'assetChanged')
        self.assertEqual(self.metadata('image'), (None, None, None))
        self.assertIsNone(self.thumbnail_key('image'))

    def test_upload_failure_and_visibility_race_do_not_publish_metadata(self):
        self.seed('image', png_bytes())
        self.s3.put_failures = 1
        worker = self.worker()
        worker.run_once()
        self.assertEqual(self.metadata('image'), (None, None, None))
        self.db.execute("UPDATE image_thumbnail_jobs SET lease_until=0 WHERE asset_id='image'")
        self.db.commit()
        original = self.s3.put_object
        def hide(**kwargs):
            self.hide(worker._connection(), 'image')
            return original(**kwargs)
        self.s3.put_object = hide
        worker.run_once()
        self.assertEqual(self.jobs('image')[0]['last_error'], 'assetNotVisible')
        self.assertEqual(self.metadata('image'), (None, None, None))

    def test_invalid_sidecar_is_rejected_before_upload(self):
        bad_values = [b'{}', b'not-json', b'x' * 4097,
                      b'{"width":true,"height":1,"duration_ms":null}',
                      b'{"width":1.0,"height":1,"duration_ms":null}',
                      b'{"width":-1,"height":1,"duration_ms":null}',
                      b'{"width":5000,"height":5000,"duration_ms":null}',
                      b'{"width":1,"height":1,"duration_ms":120}',
                      b'{"width":1,"height":1,"duration_ms":null,"extra":0}']
        worker = self.worker()
        for index, raw in enumerate(bad_values):
            with self.subTest(raw=raw[:60]):
                asset = 'bad-' + str(index)
                self.seed(asset, png_bytes())
                def encode(_asset, _source, output, _kind):
                    Path(output).write_bytes(b'bounded placeholder')
                    Path(output + '.json').write_bytes(raw)
                with mock.patch.object(worker, '_encode', side_effect=encode):
                    worker.run_once()
                self.assertEqual(self.jobs(asset)[0]['last_error'], 'metadataInvalid')
                self.assertIsNone(self.thumbnail_key(asset))
                self.assertEqual(self.metadata(asset), (None, None, None))
        self.assertEqual(self.s3.puts, [])

    def test_video_duration_sidecar_requires_sqlite_integer_bounds(self):
        path = Path(self.temp.name) / 'metadata.json'
        for value in [True, -1, 1.2, 2**63]:
            path.write_text(json.dumps({'width': 1, 'height': 1, 'duration_ms': value}))
            with self.assertRaises(worker_module._TerminalError):
                worker_module.ImageThumbnailWorker._read_metadata(path, 'video')
        path.write_text('{"width":1,"height":1,"duration_ms":0}')
        self.assertEqual(worker_module.ImageThumbnailWorker._read_metadata(path, 'video')['duration_ms'], 0)

    def test_outer_timeout_or_early_exit_kills_tool_descendants(self):
        if not Path('/proc/self/stat').exists():
            self.skipTest('Linux process-state inspection required')
        for early_exit in (False, True):
            with self.subTest(early_exit=early_exit):
                pid_file = Path(self.temp.name) / ('pid-' + str(early_exit))
                script = Path(self.temp.name) / ('supervisor-' + str(early_exit) + '.py')
                script.write_text('import subprocess,sys,time\n'
                                  "child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(120)'])\n"
                                  f'open({str(pid_file)!r},"w").write(str(child.pid))\n'
                                  + ('' if early_exit else 'time.sleep(120)\n'))
                worker = self.worker(encoder_script=str(script))
                with mock.patch.object(worker_module, 'ENCODE_TIMEOUT_SECONDS', 0.5):
                    if early_exit:
                        worker._encode('test', 'unused', 'unused')
                    else:
                        with self.assertRaises(worker_module._TransientError):
                            worker._encode('test', 'unused', 'unused')
                pid = int(pid_file.read_text())
                deadline = time.monotonic() + 2
                while _process_alive(pid) and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertFalse(_process_alive(pid), 'tool survived encoder cleanup')
