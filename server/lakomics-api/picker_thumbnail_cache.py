"""Immutable picker thumbnail cache; no storage downloads on the request path."""
import argparse
import hashlib
import logging
import os
from pathlib import Path
import queue
import sqlite3
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing

MAX_BYTES = 8 * 1024 * 1024
WORKERS = 4
logger = logging.getLogger(__name__)


class ThumbnailCache:
    def __init__(self, root, mimes):
        self.root = Path(root)
        self.mimes = mimes

    def path(self, key):
        if not isinstance(key, str) or not key.startswith('derived/'):
            return None
        digest = hashlib.sha256(key.encode('utf-8')).hexdigest()
        return self.root / digest[:2] / digest[2:]

    def read(self, key, expected_size=None):
        path = self.path(key)
        if path is None:
            return None
        try:
            with path.open('rb') as cached:
                mime = cached.readline(128).decode('ascii').rstrip('\n')
                if mime not in self.mimes:
                    return None
                data = cached.read(MAX_BYTES + 1)
            if len(data) > MAX_BYTES or (expected_size is not None and len(data) != expected_size):
                return None
            return data, mime
        except (OSError, UnicodeError):
            return None

    def fill(self, client, bucket, key, expected_size=None):
        """Return done/skipped/failed. One file contains an ASCII MIME line and bytes."""
        path = self.path(key)
        if path is None:
            return 'skipped'
        temporary = None
        try:
            if self.read(key, expected_size) is not None:
                return 'skipped'
            if expected_size is not None and not 0 <= expected_size <= MAX_BYTES:
                return 'failed'
            response = client.get_object(Bucket=bucket, Key=key)
            with closing(response['Body']) as body:
                mime, declared = response.get('ContentType'), response.get('ContentLength')
                if mime not in self.mimes or (declared is not None and (
                        type(declared) is not int or not 0 <= declared <= MAX_BYTES
                        or (expected_size is not None and declared != expected_size))):
                    return 'failed'
                path.parent.mkdir(parents=True, exist_ok=True)
                with tempfile.NamedTemporaryFile(dir=path.parent, prefix=path.name + '.',
                                                 suffix='.tmp', delete=False) as output:
                    temporary = Path(output.name)
                    output.write(mime.encode('ascii') + b'\n')
                    size = 0
                    while True:
                        chunk = body.read(min(64 * 1024, MAX_BYTES + 1 - size))
                        if not chunk:
                            break
                        size += len(chunk)
                        if size > MAX_BYTES:
                            return 'failed'
                        output.write(chunk)
                    if ((declared is not None and size != declared)
                            or (expected_size is not None and size != expected_size)):
                        return 'failed'
                os.replace(temporary, path)
                temporary = None
            return 'done'
        except Exception as error:
            # Do not log credentials, URLs, response bodies, or one traceback per miss.
            logger.warning('Picker thumbnail cache fill failed (%s)', type(error).__name__)
            return 'failed'
        finally:
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass


class BackgroundFill:
    def __init__(self):
        self.queue = queue.Queue(maxsize=256)
        self.pending = set()
        self.lock = threading.Lock()
        self.started = False

    def enqueue(self, cache, client, bucket, key, expected_size=None):
        if cache.path(key) is None or (expected_size is not None and not 0 <= expected_size <= MAX_BYTES):
            return
        identity = (cache.root, bucket, key)
        with self.lock:
            if identity in self.pending:
                return
            if not self.started:
                for _ in range(WORKERS):
                    threading.Thread(target=self._work, name='picker-thumbnail-fill', daemon=True).start()
                self.started = True
            try:
                self.queue.put_nowait((identity, cache, client, bucket, key, expected_size))
            except queue.Full:
                return
            self.pending.add(identity)

    def _work(self):
        while True:
            identity, cache, client, bucket, key, expected_size = self.queue.get()
            try:
                cache.fill(client, bucket, key, expected_size)
            finally:
                with self.lock:
                    self.pending.discard(identity)
                self.queue.task_done()


background = BackgroundFill()


def warm(db_path, client, bucket):
    """Read eligible committed keys without writing the DB, with at most four GETs."""
    import asset_visibility
    from picker import ELIGIBLE, MIMES

    db_path = Path(db_path).resolve()
    cache = ThumbnailCache(db_path.parent / 'picker-thumbnails', MIMES)
    counts = dict(done=0, skipped=0, failed=0)
    with closing(sqlite3.connect(db_path.as_uri() + '?mode=ro', uri=True)) as db:
        asset_visibility.install(db)
        rows = db.execute('SELECT asset.thumbnail_key, MAX(CASE WHEN asset.thumbnail_metadata_key='
                          'asset.thumbnail_key THEN asset.thumbnail_size_bytes END) '
                          'FROM visible_assets AS asset WHERE ' + ELIGIBLE
                          + " AND asset.thumbnail_key GLOB 'derived/*' GROUP BY asset.thumbnail_key").fetchall()
    # Release the read snapshot before network work so a running API can checkpoint its WAL.
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for start in range(0, len(rows), 64):
            for result in pool.map(lambda row: cache.fill(client, bucket, row[0], row[1]), rows[start:start + 64]):
                counts[result] += 1
    print('done={done} skipped={skipped} failed={failed}'.format(**counts))
    return counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--warm', action='store_true', required=True)
    parser.parse_args()
    import app as api
    counts = warm(api.DB_PATH, api._s3, api.R2_BUCKET)
    return 1 if counts['failed'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
