"""Small process-local caches of immutable read projections.

Keys are read inside the caller's SQLite read snapshot. No database writes or
locks are taken here; concurrent misses may compute twice but cannot serve a
body under a different revision. In-memory databases bypass caching.
"""
from collections import OrderedDict
from pathlib import Path
from threading import Lock


class ProjectionCache:
    def __init__(self, capacity=8):
        self.capacity = capacity
        self.entries = OrderedDict()
        self.lock = Lock()

    def key(self, db, *revision):
        # Isolated/older schemas without the startup invalidation DDL remain
        # uncached. Serving stale bodies is worse than retaining the old cost.
        if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' "
                          "AND name='projection_generation'").fetchone():
            return None
        generation = db.execute("SELECT generation FROM projection_generation WHERE singleton=1").fetchone()
        if generation is None:
            return None
        path = next((row[2] for row in db.execute('PRAGMA database_list') if row[1] == 'main'), '')
        if not path:
            return None
        stat = Path(path).stat()
        return (path, stat.st_dev, stat.st_ino, generation[0], *revision)

    def get(self, key):
        if key is None:
            return None
        with self.lock:
            body = self.entries.get(key)
            if body is not None:
                self.entries.move_to_end(key)
            return body

    def put(self, key, body):
        if key is not None:
            with self.lock:
                self.entries[key] = body
                self.entries.move_to_end(key)
                while len(self.entries) > self.capacity:
                    self.entries.popitem(last=False)
        return body


def heads(db, names):
    """Optional state tables support isolated fixtures and rolling upgrades."""
    present = {row[0] for row in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}
    return tuple(tuple(tuple(row) for row in db.execute(f'SELECT * FROM {name}'))
                 if name in present else None for name in names)


def install_generation_triggers(db):
    """Count writes to live projection inputs that no existing revision covers.

    This is a private counter (``projection_generation``); it deliberately does
    not touch ``asset_list_generation``, so list generations, cursors and client
    cache identities are unchanged. Install after component startup DDL. Each
    trigger only updates the singleton inside its writer's own transaction, so no
    new lock is taken and reads never write. Installation does not backfill or
    increment anything.
    """
    db.execute("CREATE TABLE IF NOT EXISTS projection_generation("
               "singleton INTEGER PRIMARY KEY CHECK(singleton=1),generation INTEGER NOT NULL)")
    db.execute("INSERT OR IGNORE INTO projection_generation VALUES(1,0)")
    present = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    tables = ('asset_classifications', 'library_asset_ratings', 'asset_authority_state',
              'classification_authority_state', 'classification_authority_assignments',
              'classification_snapshots', 'mobile_collections', 'collection_authority_projection')
    for table in tables:
        if table not in present:
            continue
        for operation in ('INSERT', 'UPDATE', 'DELETE'):
            db.execute(f"CREATE TRIGGER IF NOT EXISTS projection_{table}_{operation.lower()} "
                       f"AFTER {operation} ON {table} BEGIN "
                       "UPDATE projection_generation SET generation=generation+1 WHERE singleton=1; END")
