"""Offline SQL audit using only a freshly generated library; no sockets or user DBs.

Run: .venv/bin/python tools/query_plan_audit.py --json /tmp/query-audit.json
Route functions are called directly: this measures SQL, not HTTP/native acceptance.
"""
import argparse
import ast
from contextlib import contextmanager, ExitStack
import inspect
import json
import os
import sqlite3
import statistics
import sys
import tempfile
import time
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlencode

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
# Import the existing fixture without changing the caller's environment.
with patch.dict(os.environ):
    from tools import poll_benchmark as bench
from starlette.requests import Request
import mobile_catalog_replica as replica

REVISION = 'a' * 64


def populate(root):
    bench.SIZES['assets'] = 10_000
    bench.boot(root)
    tokens = bench.populate(root)
    with bench.api.get_db() as db:
        db.execute("UPDATE assets SET creator_handle='creator-' || (CAST(substr(id,7) AS INTEGER) % 40)")
        db.execute('INSERT INTO asset_classifications SELECT asset_id,classification_id,updated_at FROM classification_authority_assignments')
        db.execute('DELETE FROM library_asset_tags')
        db.execute('DELETE FROM library_tag_assets WHERE asset_id>=?', ['asset-09000'])
        db.executemany('INSERT INTO library_asset_tags VALUES(?,?)',
                       [(f'asset-{i:05d}', f'tag-{(i + j) % 100}')
                        for i in range(9000) for j in range(36 if i < 5000 else 35)])
        nodes = [{'id': f'character:target-{i:02d}', 'kind': 'character',
                  'sourceId': f'target-{i:02d}', 'seriesId': 'series-1', 'parentId': None,
                  'name': f'Character {i}'} for i in range(300)]
        scopes = [{'nodeId': n['id'], 'filter': 'all', 'totalCount': 100,
                   'sourceCount': 100} for n in nodes]
        db.execute('INSERT INTO mobile_character_state VALUES(1,?,?,?)',
                   [REVISION, bench.STAMP, json.dumps({'nodes': nodes, 'scopes': scopes})])
        db.executemany('INSERT INTO mobile_character_assets VALUES(?,?)',
                       [(f'asset-{i:05d}', json.dumps({'id': f'asset-{i:05d}'})) for i in range(10_000)])
        db.executemany('INSERT INTO mobile_character_members VALUES(?,?,?,?)',
                       [(n['id'], 'all', j, f'asset-{(i * 31 + j) % 10000:05d}')
                        for i, n in enumerate(nodes) for j in range(100)])
        db.executemany('INSERT INTO collection_authority_members VALUES(?,?,?,?,?,?,?)',
                       [(bench.LIBRARY, f'collection-{i:04d}', f'asset-{(i * 31 + j) % 10000:05d}',
                         1, 1, bench.STAMP, bench.STAMP) for i in range(549) for j in range(20)])
        # A matching history as well as the no-match fallback: epoch/sequence, not
        # timestamp text, defines the last accepted trash transition.
        db.executemany('INSERT INTO asset_authority_changes VALUES(?,?,?,?,?,?,?,?,?)',
                       [(bench.LIBRARY, 2, sequence, command, 'asset-00050', 2,
                         f'new-epoch-{sequence}', '{}', stamp)
                        for sequence, command, stamp in (
                            (1, 'trashAsset', '2026-09-22T00:00:00Z'),
                            (2, 'restoreAsset', '2026-09-23T00:00:00Z'),
                            (3, 'trashAsset', '2026-09-21T00:00:00Z'))])
        db.execute("UPDATE home_av_pick SET pick='{}'")
        db.executemany('INSERT INTO catalog_duplicate_candidates VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                       [(i+1, f'candidate-{i}', 'kHentai', str(100000+i), str(100001+i), 'pc', 'fixture',
                         'exactTitle', 0, 'fixture', '{}', 0, i+1, bench.STAMP, bench.STAMP) for i in range(500)])
        db.execute('INSERT INTO mobile_similarity_review_state VALUES(1,?,?,0,0,?,?)',
                   [bench.LIBRARY, REVISION, bench.STAMP, bench.STAMP])
        db.executemany('INSERT INTO mobile_similarity_review_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
                       [(i, f'review-{i}', 'historical', 3, None, None,
                         f'asset-{i+1:05d}', bench.sha(f'asset-{i+1:05d}'), '{}',
                         f'asset-{i+1001:05d}', bench.sha(f'asset-{i+1001:05d}'), '{}') for i in range(667)])
        db.execute("UPDATE mobile_collections SET payload=json_set(payload,'$.artworks',json('[]'))")
        db.commit()
    data, digest, users = bench.catalog_projection()
    source = root / 'projection.ndjson'
    source.write_bytes(data)
    catalog = root / 'mobile-catalog'
    replica.import_content(source, digest, catalog, bench.api.get_db)
    replica.publish({'version': 1, 'baseRevision': None, 'contentDigest': digest,
                     'userSnapshot': users}, catalog, bench.api.get_db)
    return tokens


def resolve_call(path, params, headers):
    route = next(r for r in bench.api.app.routes if getattr(r, 'path', None) == path and 'GET' in r.methods)
    values = {}
    request = Request({'type': 'http', 'method': 'GET', 'path': path,
                       'query_string': urlencode(params, doseq=True).encode(),
                       'headers': [(k.lower().encode(), v.encode()) for k, v in headers.items()]})
    for name, parameter in inspect.signature(route.endpoint).parameters.items():
        default = parameter.default
        alias = getattr(default, 'alias', None) or name
        if name == 'request':
            values[name] = request
        elif name == 'authorization':
            values[name] = headers.get('Authorization')
        elif alias in params:
            values[name] = str(params[alias]) if alias == 'utcOffsetMinutes' else params[alias]
        elif default is not inspect.Parameter.empty:
            values[name] = getattr(default, 'default', default)
        else:
            raise ValueError(f'Missing {path}: {name}')
    result = route.endpoint(**values)
    if inspect.iscoroutine(result):
        try:
            result.send(None)
        except StopIteration as done:
            return done.value
        finally:
            result.close()
        raise RuntimeError(f'{path}: unexpected asynchronous IO')
    return result


async def inline(fn, *args, **kwargs):
    return fn(*args, **kwargs)


def cases(tokens):
    client, publisher = tokens
    shared = {'Authorization': f'Bearer {bench.SHARED_TOKEN}'}
    device = {'Authorization': f'Bearer {client}'}
    result = [(name, path, params or {}, headers)
              for name, method, path, headers, params, _ in bench.endpoints(*tokens)
              if method == 'GET' and '304' not in name and '(shared token)' not in name]
    # Query parameters parsed by HTTP into lists are supplied as lists here too.
    result = [(n, p, {k: [v] if k in ('tag', 'classification_id') else v for k, v in q.items()}, h)
              for n, p, q, h in result]
    for path, variants in [
        ('/v1/library/classifications', [{}]),
        ('/v1/library/summary', [{}]),
        ('/v1/library/characters', [{}]),
        ('/v1/library/similarity/review', [{}]),
        ('/v1/library/characters/review', [{}, {'asset': 'asset-00001'}, {'source': 's36'}]),
        ('/v1/library/characters/assets', [dict(node='character:target-01', revision=REVISION, **q)
                                          for q in ({}, {'sort': 'newest'}, {'sort': 'newest', 'toc': 1})]),
        ('/v1/albums/assets', [dict(libraryId=bench.LIBRARY, epoch=1, albumId='album-001', **q)
                              for q in ({}, {'toc': 1})]),
        ('/v1/collections', [{}]), ('/v1/collections/status', [{}]),
        ('/v1/home/upcoming', [{}]), ('/v1/home/av-pick', [{}]),
        ('/v1/library/artists', [{}]),
        ('/v1/mobile-catalog/search', [{}, {'text': 'artist:artist-1'}, {'text': 'Work'}, {'scope': 'bookmarked'}]),
        ('/v1/library/revisit', [{}]), ('/v1/library/revisit/date', [{}]),
        ('/v1/library/trash', [{}]),
    ]:
        for q in variants:
            result.append((path + ' ' + str(q), path, q, shared if path in ('/v1/library/summary', '/v1/library/classifications', '/v1/collections', '/v1/collections/status', '/v1/library/revisit', '/v1/library/revisit/date') else device))
    return result


@contextmanager
def direct_calls():
    """Replace only the thread bridge; all route and query code remains real."""
    cells = []
    for route in bench.api.app.routes:
        for cell in getattr(getattr(route, 'endpoint', None), '__closure__', None) or ():
            if getattr(cell.cell_contents, '__name__', '') == 'run_in_threadpool':
                cells.append((cell, cell.cell_contents))
                cell.cell_contents = inline
    try:
        with ExitStack() as stack:
            for module in list(sys.modules.values()):
                if module and (getattr(module, '__file__', '') or '').startswith(str(ROOT)) and hasattr(module, 'run_in_threadpool'):
                    stack.enter_context(patch.object(module, 'run_in_threadpool', inline))
            yield
    finally:
        for cell, original in cells:
            cell.cell_contents = original


def audit(root, tokens, cutoff, analyzed=False):
    reports, failures = [], []
    original = sqlite3.connect
    current = None
    captured = {}

    def connect(*args, **kwargs):
        db = original(*args, **kwargs)
        deadline = time.monotonic() + cutoff
        db.set_progress_handler(lambda: int(time.monotonic() > deadline), 10000)
        def trace(sql):
            if current and sql.lstrip().upper().startswith(('SELECT', 'WITH')):
                # The replay below recreates the same visibility view and bookmark shadow.
                captured.setdefault((str(args[0]), sql), (current, args, kwargs))
        db.set_trace_callback(trace)
        return db

    with direct_calls():
        with patch.object(sqlite3, 'connect', connect):
            for name, path, params, headers in cases(tokens):
                current = name
                try:
                    resolve_call(path, params, headers)
                except Exception as exc:
                    failures.append({'case': name, 'error': str(exc)})
            current = 'collection_authority.finalize_item + baseline'
            import collection_authority
            with bench.api.get_db() as db:
                collection_authority.finalize_item(db, bench.LIBRARY, {'id': 'collection-0001'})
                for section in collection_authority.SECTION_QUERIES:
                    collection_authority.section_count(db, bench.LIBRARY, section)
                    collection_authority.section_page(db, bench.LIBRARY, section, None, 50)
            current = 'asset_authority startup lifecycle timestamp migration'
            tree = ast.parse((ROOT / 'asset_authority.py').read_text())
            statement = next(n.value for n in ast.walk(tree) if isinstance(n, ast.Constant) and
                             isinstance(n.value, str) and n.value.startswith('UPDATE asset_authority_state SET lifecycle_changed_at=COALESCE'))
            expression, where = statement.split('SET lifecycle_changed_at=', 1)[1].rsplit('WHERE lifecycle_changed_at=', 1)
            with bench.api.get_db() as db:
                db.execute('SELECT ' + expression + ' FROM asset_authority_state WHERE lifecycle_changed_at=' + where).fetchall()
            current = 'similarity_review feed'
            import similarity_review
            with bench.api.get_db() as db:
                db.execute('SELECT COUNT(*) ' + similarity_review.FEED_FROM, ['[]']*3).fetchall()
            current = 'catalog count/detail/editions + candidate review'
            import mobile_catalog, mobile_catalog_query, mobile_catalog_suggestions, catalog_duplicates, catalog_bookmarks
            with replica.open_publication(root / 'mobile-catalog', bench.api.get_db, bookmarks=catalog_bookmarks.load(bench.api.get_db)) as (db, _):
                mobile_catalog_suggestions.build_index(db)
                for params in ({}, {'text': 'Work'}, {'text': 'artist:artist-1'}, {'scope': 'bookmarked'}):
                    query = mobile_catalog_query.freeze_query(db, mobile_catalog.normalize(params))
                    mobile_catalog_query.count_groups(db, query)
                mobile_catalog_query.detail(db, 100001, query)
                mobile_catalog_query.editions(db, 'group-100001', query, 0, 40)
            with bench.api.get_db() as db:
                db.execute(catalog_duplicates.JOINED + ' WHERE c.removed=0 AND c.id<10000 ORDER BY c.id DESC LIMIT 30').fetchall()
        current = None
    # Replay control DB SQL only here; catalog needs its attached publication context.
    with bench.api.get_db() as db:
        for (_, sql), (name, args, kwargs) in captured.items():
            if str(args[0]) != str(bench.api.DB_PATH):
                continue
            reports.append(measure(db, name, sql, cutoff))
    # Capture actual catalog SQL in its own connection with attachments and TEMP views.
    import catalog_bookmarks
    with replica.open_publication(root / 'mobile-catalog', bench.api.get_db,
                                 bookmarks=catalog_bookmarks.load(bench.api.get_db)) as (db, _):
        for (_, sql), (name, args, kwargs) in captured.items():
            if str(args[0]) != str(bench.api.DB_PATH):
                try:
                    reports.append(measure(db, name, sql, cutoff))
                except sqlite3.Error as exc:
                    failures.append({'case': name, 'error': str(exc), 'sql': sql})
    # Exercise empty and singleton candidate/membership tables without changing the base fixture.
    edge_tables = ('mobile_similarity_review_items', 'catalog_duplicate_candidates', 'mobile_character_review_items', 'mobile_character_members', 'album_authority_members', 'collection_authority_members')
    with bench.api.get_db() as db:
        db.execute('BEGIN')
        for size in (1, 0):
            for table in edge_tables:
                db.execute(f'DELETE FROM {table} WHERE rowid NOT IN (SELECT rowid FROM {table} WHERE ' +
                           {'catalog_duplicate_candidates': 'id=1',
                            'mobile_similarity_review_items': 'position=0',
                            'mobile_character_review_items': "asset_id='asset-00013'",
                            'mobile_character_members': "node_id='character:target-01'",
                            'album_authority_members': "album_id='album-001'",
                            'collection_authority_members': "work_id='collection-0001'"}[table] + ' LIMIT ?)', [size])
            if analyzed:
                db.execute('ANALYZE')
            for (_, sql), (name, args, kwargs) in captured.items():
                if str(args[0]) == str(bench.api.DB_PATH) and any(table in sql for table in edge_tables):
                    reports.append(measure(db, f'edge={size} ' + name, sql, cutoff))
        db.rollback()
    return reports, failures


def measure(db, name, sql, cutoff, compare=True):
    plan = [r[3] for r in db.execute('EXPLAIN QUERY PLAN ' + sql)]
    samples, digest, error = [], None, None
    for _ in range(3):
        start = time.perf_counter()
        deadline = time.monotonic() + cutoff
        db.set_progress_handler(lambda: int(time.monotonic() > deadline), 10000)
        try:
            rows = db.execute(sql).fetchall()
        except sqlite3.OperationalError as exc:
            error = str(exc)
        finally:
            samples.append((time.perf_counter() - start) * 1000)
            db.set_progress_handler(None, 0)
        if error:
            break
        digest = bench.sha(json.dumps([list(r) for r in rows], default=str))
    result = {'case': name, 'sql': sql, 'plan': plan, 'ms': round(statistics.median(samples), 3),
              'error': error, 'result_digest': digest}
    if compare and ('FROM mobile_character_review_items i' in sql or
                    'FROM album_authority_members AS member' in sql):
        before = sql.replace('CROSS JOIN visible_assets', 'JOIN visible_assets')
        result['before'] = measure(db, name, before, cutoff, compare=False)
        result['identical'] = error is None and result['before']['error'] is None and digest == result['before']['result_digest']
    if compare and name == 'asset_authority startup lifecycle timestamp migration':
        # Reproduce the old migration plan without rewriting production code.
        db.execute('SAVEPOINT old_plan')
        try:
            db.execute('DROP INDEX asset_authority_last_trash')
            result['before'] = measure(db, name, sql, cutoff, compare=False)
            import asset_authority
            index_sql = asset_authority.DDL.split('CREATE INDEX IF NOT EXISTS asset_authority_last_trash', 1)[1].split(';', 1)[0]
            started = time.perf_counter()
            db.execute('CREATE INDEX asset_authority_last_trash' + index_sql)
            result['index_build_ms'] = round((time.perf_counter() - started) * 1000, 3)
            try:
                result['index_bytes'] = db.execute("SELECT SUM(pgsize) FROM dbstat WHERE name='asset_authority_last_trash'").fetchone()[0]
            except sqlite3.OperationalError:
                result['index_bytes'] = None  # DBSTAT is an optional SQLite build feature.
        finally:
            db.execute('ROLLBACK TO old_plan')
            db.execute('RELEASE old_plan')
        result['identical'] = error is None and result['before']['error'] is None and digest == result['before']['result_digest']
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--json', type=Path, required=True)
    parser.add_argument('--cutoff', type=float, default=1)
    args = parser.parse_args()
    if args.cutoff <= 0:
        parser.error('--cutoff must be positive')
    with tempfile.TemporaryDirectory(prefix='lakomics-query-audit-') as tmp:
        root = Path(tmp)
        tokens = populate(root)
        result = {}
        for stats in (False, True):
            if stats:
                with bench.api.get_db() as db:
                    db.execute('ANALYZE')
                # Only generated catalog files, opened writable solely to build test statistics.
                for path in (root / 'mobile-catalog').rglob('*.sqlite'):
                    db = sqlite3.connect(path)
                    try:
                        db.execute('ANALYZE')
                        db.commit()
                    finally:
                        db.close()
            reports, failures = audit(root, tokens, args.cutoff, stats)
            result[str(stats)] = {'queries': reports, 'failures': failures}
            print(stats, 'queries', len(reports), 'failures', failures, flush=True)
            for r in reports:
                if r['ms'] > 20 or r['error']:
                    print(r['ms'], r['case'], r['sql'][:140], r['error'], flush=True)
        args.json.write_text(json.dumps(result, indent=2))
        if any(data['failures'] or any(r['error'] or r.get('identical') is False for r in data['queries'])
               for data in result.values()):
            raise SystemExit('Audit failed; inspect the JSON for errors or changed results')


if __name__ == '__main__':
    main()
