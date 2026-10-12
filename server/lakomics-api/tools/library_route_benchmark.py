"""Dependency-free SQLite/Python attribution for the tablet's library routes.

Loads only the measured functions from source with AST (no app startup, network,
auth or background workers). The service seams below deliberately use a legacy
classification/collection projection and active Asset visibility. This is not an
HTTP or device benchmark. Run with the existing Python: python tools/library_route_benchmark.py.
"""
import ast
import argparse
import base64
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import statistics
import sys
import subprocess
import tempfile
import time
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import asset_visibility
from projection_cache import ProjectionCache, heads, install_generation_triggers

REFERENCE = None


class Reply:
    def __init__(self, content=b'', status_code=200, headers=None, **kwargs):
        self.body = content
        self.status_code = status_code
        self.headers = headers or {}


def encode(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode()


def load(file, names, namespace):
    """Compile actual function bodies, including nested route functions, unchanged."""
    source = (subprocess.check_output(['git', 'show', f'{REFERENCE}:server/lakomics-api/{file}'], cwd=ROOT).decode()
              if REFERENCE else (ROOT / file).read_text(encoding='utf-8'))
    tree = ast.parse(source)
    functions = {node.name: node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)}
    nodes = []
    for name in names:
        node = functions[name]
        node.decorator_list = []
        # Bind the service seam already supplied below instead of importing the
        # application's Pydantic-dependent rating publisher inside this helper.
        if name == 'attach_cover_ratings':
            node.body = [statement for statement in node.body if not (
                isinstance(statement, ast.Import) and statement.names[0].name == 'library_search')]
        nodes.append(node)
    exec(compile(ast.Module(body=nodes, type_ignores=[]), file, 'exec'), namespace)
    return namespace


def fixture(path=':memory:'):
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    db.executescript('''
      CREATE TABLE assets(id TEXT PRIMARY KEY,kind TEXT,object_key TEXT,thumbnail_key TEXT,
        thumbnail_revision TEXT,content_type TEXT,size_bytes INTEGER,created_at TEXT,updated_at TEXT,
        committed INTEGER,collected_at TEXT,width INTEGER,height INTEGER,duration_ms INTEGER,
        creator_handle TEXT,creator_name TEXT);
      CREATE INDEX idx_assets_committed ON assets(committed);
      CREATE INDEX idx_assets_mobile_order ON assets(committed,COALESCE(collected_at,created_at) DESC,id DESC);
      CREATE INDEX idx_assets_creator_handle ON assets(creator_handle,id);
      CREATE INDEX idx_assets_committed_id ON assets(committed,id);
      CREATE TABLE authority_domains(domain TEXT PRIMARY KEY,library_id TEXT,epoch INTEGER,change_cursor INTEGER);
      INSERT INTO authority_domains VALUES('assets','library',1,1);
      CREATE TABLE asset_authority_state(library_id TEXT,asset_id TEXT,lifecycle TEXT,PRIMARY KEY(library_id,asset_id));
      CREATE INDEX asset_authority_by_lifecycle ON asset_authority_state(library_id,lifecycle,asset_id);
      CREATE INDEX asset_authority_live_by_asset ON asset_authority_state(asset_id,lifecycle);
      CREATE TABLE library_asset_ratings(asset_id TEXT PRIMARY KEY,content_rating TEXT);
      CREATE TABLE asset_classifications(asset_id TEXT,classification_id TEXT,PRIMARY KEY(asset_id,classification_id));
      CREATE INDEX idx_asset_classifications_classification ON asset_classifications(classification_id,asset_id);
      CREATE TABLE classification_snapshots(singleton INTEGER PRIMARY KEY,revision TEXT,payload TEXT);
      CREATE TABLE mobile_collections(id TEXT PRIMARY KEY,type TEXT);
      CREATE TABLE mobile_collection_replica(singleton INTEGER PRIMARY KEY,revision TEXT);
      INSERT INTO mobile_collection_replica VALUES(1,'collections-1');
      CREATE TABLE mobile_character_state(singleton INTEGER PRIMARY KEY,revision TEXT,published_at TEXT,index_json TEXT);
      CREATE TABLE mobile_character_members(node_id TEXT,filter TEXT,position INTEGER,asset_id TEXT,
        PRIMARY KEY(node_id,filter,position),UNIQUE(node_id,filter,asset_id));
      CREATE TABLE mobile_character_assets(id TEXT PRIMARY KEY,payload TEXT);
      CREATE TABLE mobile_character_hidden_members(node_id TEXT,filter TEXT,asset_id TEXT,PRIMARY KEY(node_id,filter,asset_id));
      CREATE TABLE library_artist_state(singleton INTEGER PRIMARY KEY,revision INTEGER,document TEXT);
      CREATE TABLE library_artist_intent_state(singleton INTEGER PRIMARY KEY,intent_sequence INTEGER,acknowledged_through INTEGER,pruned_through INTEGER);
      INSERT INTO library_artist_intent_state VALUES(1,0,0,0);
      CREATE TABLE library_artist_intents(sequence INTEGER PRIMARY KEY,operation_id TEXT,artist_id TEXT,action TEXT,display_name TEXT,artist_payload TEXT);
    ''')
    db.executemany('INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [
        (f'a{i:05}', 'video' if i % 7 == 0 else 'image', f'o/{i}', f't/{i}', 'r1',
         'image/jpeg', 100000, f'2025-{i%12+1:02}-15T00:00:00Z', '2026-01-01', 1,
         f'2025-{i%12+1:02}-15T00:00:00Z', 1000, 1500, None, f'creator-{i%2000}', f'Creator {i%2000}')
        for i in range(10000)])
    db.executemany('INSERT INTO asset_authority_state VALUES(?,?,?)',
                   [('library', f'a{i:05}', 'trash' if i % 50 == 0 else 'normal') for i in range(10000)])
    db.executemany('INSERT INTO library_asset_ratings VALUES(?,?)', [(f'a{i:05}', 'g') for i in range(10000)])
    db.executemany('INSERT INTO asset_classifications VALUES(?,?)', [(f'a{i:05}', f'class-{i%40}') for i in range(9000)])
    entries = [{'id': f'class-{i}', 'name': f'Class {i}', 'kind': 'work'} for i in range(40)]
    db.execute('INSERT INTO classification_snapshots VALUES(1,?,?)', ('class-1', json.dumps({'entries': entries, 'published_at': '2026-01-01'})))
    db.executemany('INSERT INTO mobile_collections VALUES(?,?)', [(str(i), ('game','manga','movie','av')[i%4]) for i in range(550)])
    nodes = [{'id': f'series:s{i}', 'name': f'Series {i}', 'thumbnailAssetId': f'a{i:05}', 'heroAssetId': None} for i in range(300)]
    scopes = [{'nodeId': n['id'], 'filter': 'all', 'sourceCount': 1000, 'totalCount': 1000} for n in nodes]
    db.execute('INSERT INTO mobile_character_state VALUES(1,?,?,?)', ('a'*64, '2026-01-01', json.dumps({'nodes': nodes, 'scopes': scopes})))
    db.executemany('INSERT INTO mobile_character_members VALUES(?,?,?,?)',
                   [(n['id'], 'all', j, f'a{(i*31+j)%10000:05}') for i,n in enumerate(nodes) for j in range(1000)])
    db.executemany('INSERT INTO mobile_character_assets VALUES(?,?)', [(f'a{i:05}', json.dumps({'id': f'a{i:05}'})) for i in range(10000)])
    artists = [{'id': f'artist:{i}', 'label': f'Artist {i}', 'sourceName': f'Artist {i}', 'keys': [f'creator-{i}'],
                'coverAssetIds': [f'a{(i*5+j)%10000:05}' for j in range(5)], 'assetCount': 5,
                'pinned': False, 'hidden': False, 'main': True} for i in range(2000)]
    document = {'version': 1, 'artists': artists, 'assignments': [{'assetId': f'a{i:05}', 'artistId': f'artist:{i%2000}'} for i in range(10000)]}
    db.execute('INSERT INTO library_artist_state VALUES(1,1,?)', (json.dumps(document),))
    for column in ('committed_at', 'source_published_at', 'source_url', 'import_source'):
        db.execute(f'ALTER TABLE assets ADD COLUMN {column} TEXT')
    db.execute('CREATE TABLE asset_image_text(asset_id TEXT PRIMARY KEY,payload TEXT)')
    db.commit()
    asset_visibility.install(db)
    if not REFERENCE:
        db.execute('CREATE INDEX idx_assets_creator_mobile_order ON assets(committed,creator_handle,COALESCE(collected_at,created_at) DESC,id DESC)')
        db.execute('CREATE INDEX mobile_character_members_by_asset ON mobile_character_members(asset_id,node_id,filter,position)')
    db.executescript('CREATE TABLE asset_list_generation(singleton INTEGER PRIMARY KEY,generation INTEGER); INSERT INTO asset_list_generation VALUES(1,0);')
    for operation in ('INSERT','UPDATE','DELETE'):
        db.execute(f'CREATE TRIGGER asset_list_{operation.lower()} AFTER {operation} ON assets BEGIN UPDATE asset_list_generation SET generation=generation+1 WHERE singleton=1; END')
    install_generation_triggers(db)
    db.commit()
    return db


def functions(db):
    @contextmanager
    def get_db():
        try:
            yield db
        finally:
            db.rollback()

    noop = lambda *args, **kwargs: None
    generation = load('app.py', ['list_generation'], dict(json=json, hashlib=hashlib))['list_generation']
    services = SimpleNamespace(get_db=get_db, require_auth=noop, API_TOKEN='', client_guard=lambda *a: noop,
                               list_generation=generation, _summary_now=lambda: datetime(2026,10,12,tzinfo=timezone.utc))
    ns = dict(json=json, hashlib=hashlib, datetime=datetime, timedelta=timedelta, timezone=timezone,
              Header=lambda default=None, **kw: default, Query=lambda default=None, **kw: default,
              get_db=get_db, reader=noop, state=lambda db: db.execute('SELECT * FROM mobile_character_state').fetchone(),
              api=services, list_generation=generation, Literal=__import__('typing').Literal,
              library_search=SimpleNamespace(content_rating=lambda row: row['content_rating'] if row['kind'] != 'video' else None),
              character_exclusions=SimpleNamespace(VISIBLE_MEMBER='NOT EXISTS (SELECT 1 FROM mobile_character_hidden_members h WHERE h.node_id=m.node_id AND h.filter=m.filter AND h.asset_id=m.asset_id)'),
              authority=SimpleNamespace(active_domain=lambda *a: None), classification_authority=SimpleNamespace(DOMAIN='classifications'),
              collection_authority=SimpleNamespace(served_state=lambda db: None), mobile_collections=SimpleNamespace(read_table=lambda active: 'mobile_collections'),
              conditional=SimpleNamespace(Response=Reply), NodeID=str, Revision=str, Filter=str, Request=object,
              ProjectionCache=ProjectionCache, heads=heads, index_cache=ProjectionCache(), visibility_cache=ProjectionCache(),
              summary_cache=ProjectionCache(), classification_cache=ProjectionCache(), cache=ProjectionCache(),
              require_client=noop, base64=base64, Filters=object, home_cache=ProjectionCache(),
              HOME_REVISIT_SQL=(ROOT/'home_revisit.sql').read_text(encoding='utf-8'),
              KST=timezone(timedelta(hours=9)))
    ns['character_exclusions'].advertisement = lambda db: ({'manualExclusion': False}, {})
    ns['character_review'] = SimpleNamespace(advertisement=lambda db: ({'characterReview': False}, {}))
    load('conditional.py', ['encode', 'etag_for', 'matches', 'encoded_response', 'json_response'],
         ns['conditional'].__dict__)
    ns['conditional'].Response = Reply
    ns['conditional'].json = json
    ns['conditional'].hashlib = hashlib
    ns['conditional'].CACHE_CONTROL = 'private, no-cache'
    # Rating helpers may receive SELECT id,content_rating only.
    load('library_search.py', ['content_rating'], ns['library_search'].__dict__)
    filter_ns = dict(base64=base64, json=json, Filters=object)
    load('asset_filters.py', ['technical_fields', '_dimension', '_duration_ms', 'encode_cursor'], filter_ns)
    ns['asset_filters'] = SimpleNamespace(**filter_ns, FILTER_VERSION=1, BOUND_MAX=2**53-1, MediaKind=str, AspectRatio=str,
        parse=lambda *a: SimpleNamespace(tags=(), artist=None, identity=lambda: [None,None,None,None]),
        filter_clause=lambda f: ('', []))
    ns['library_thumbnails'] = SimpleNamespace(revision=lambda row: row['thumbnail_revision'])
    load('mobile_characters.py', ['visible_index', 'browse', 'index'], ns)
    if not REFERENCE:
        load('mobile_characters.py', ['has_retired_assets'], ns)
    character_state = ns['state']
    load('library_artists.py', ['_state', '_intent_state', '_intent', 'served_document', 'status_signal', 'attach_cover_ratings', 'get_artists'], ns)
    load('library_assets.py', ['_summary_bound', '_classified_asset_sql', 'mobile_library_summary', 'list_mobile_classifications',
                             '_optional_dimension', '_optional_duration_ms', 'image_text_flags', 'mobile_asset_item'], ns)
    services._summary_bound = ns['_summary_bound']
    services._classified_asset_sql = ns['_classified_asset_sql']
    services._optional_dimension = ns['_optional_dimension']
    services._optional_duration_ms = ns['_optional_duration_ms']
    services.thumbnail_revision = lambda row: row['thumbnail_revision']
    services.mobile_asset_item = ns['mobile_asset_item']
    def memberships(db, rows):
        ids = [row['id'] for row in rows]
        result = {}
        for row in db.execute('SELECT asset_id,classification_id FROM asset_classifications WHERE asset_id IN (SELECT value FROM json_each(?)) ORDER BY asset_id,classification_id', [json.dumps(ids)]):
            result.setdefault(row[0], []).append(row[1])
        return result
    services._mobile_memberships = memberships
    ns['library_assets'] = SimpleNamespace(image_text_flags=ns['image_text_flags'])
    ns['authority'].active_domain = lambda *args: None
    ns['classification_authority'].assignment_projection_many = lambda *args: {}
    load('library_revisit.py', ['_revisit_creator_exclusion_sql', '_revisit_calendar_distance_sql', '_revisit_date_bundle',
                             '_revisit_creator_groups', 'home_revisit_rows', 'list_home_revisit', 'list_mobile_revisit'], ns)
    services._revisit_creator_exclusion_sql = ns['_revisit_creator_exclusion_sql']
    services._revisit_calendar_distance_sql = ns['_revisit_calendar_distance_sql']
    services._revisit_date_bundle = ns['_revisit_date_bundle']
    services._revisit_creator_groups = lambda db, limit: ns['_revisit_creator_groups'](db, limit, day=739901)
    ns['state'] = character_state
    return ns


def measure(db, name, call, runs=5):
    samples, traces, steps, json_counts = [], [], [], []
    original_loads, original_dumps = json.loads, json.dumps
    for _ in range(runs):
        trace, counter = [], [0]
        counts = {'decode_calls': 0, 'decode_bytes': 0, 'encode_calls': 0}
        def loads(value, *args, **kwargs):
            counts['decode_calls'] += 1
            counts['decode_bytes'] += len(value.encode() if isinstance(value, str) else value)
            return original_loads(value, *args, **kwargs)
        def dumps(value, *args, **kwargs):
            counts['encode_calls'] += 1
            return original_dumps(value, *args, **kwargs)
        db.set_trace_callback(trace.append)
        def progress():
            counter[0] += 1000
            return 0
        db.set_progress_handler(progress, 1000)
        started = time.perf_counter()
        json.loads, json.dumps = loads, dumps
        try:
            result = call()
            body = result.body if hasattr(result, 'body') else encode(result)
        finally:
            json.loads, json.dumps = original_loads, original_dumps
        samples.append((time.perf_counter()-started)*1000)
        db.set_progress_handler(None, 0)
        db.set_trace_callback(None)
        traces.append(trace)
        steps.append(counter[0])
        json_counts.append(counts)
    plans = []
    for sql in dict.fromkeys(traces[0]+traces[-1]):
        if sql.lstrip().upper().startswith(('SELECT', 'WITH')):
            plans.append({'sql': sql if len(sql)<1000 else sql[:900]+' [expanded parameters truncated]',
                          'plan': [r[3] for r in db.execute('EXPLAIN QUERY PLAN '+sql)]})
    return {'route': name, 'cold_ms': round(samples[0],3), 'median_ms': round(statistics.median(samples[1:]),3), 'statements': len(traces[-1]),
            'cold_statements': len(traces[0]), 'cold_vm_steps_approx': steps[0],
            'vm_steps_approx': statistics.median(steps[1:]), 'cold_json': json_counts[0], 'warm_json': json_counts[-1],
            'read_writes': sum(sql.lstrip().upper().startswith(('INSERT','UPDATE','DELETE','CREATE','DROP')) for sql in traces[-1]),
            'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest(), 'plans': plans}


def run(path):
    db = fixture(path)
    try:
        ns = functions(db)
        calls = [
        ('characters', lambda: ns['index']()),
        ('characters assets', lambda: ns['browse'](SimpleNamespace(query_params={}), 'series:s1', 'a'*64)),
        ('summary', lambda: ns['mobile_library_summary']()),
        ('classifications', lambda: ns['list_mobile_classifications']()),
        ('artists', lambda: ns['get_artists']()),
        ('revisit', lambda: ns['list_mobile_revisit']()),
        ('revisit home', lambda: ns['list_mobile_revisit'](home=True, day='2026-10-12')),
        ]
        return [measure(db,name,call) for name,call in calls]
    finally:
        db.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', help='Read-only git source revision for the before measurement')
    parser.add_argument('--json', type=Path, help='Write UTF-8 LF attribution and query plans')
    parser.add_argument('--temp-dir', type=Path, help='Existing writable directory for the disposable fixture')
    args = parser.parse_args()
    REFERENCE = args.reference
    handle, name = tempfile.mkstemp(prefix='lakomics-library-perf-', suffix='.sqlite', dir=args.temp_dir)
    os.close(handle)
    try:
        reports = run(name)
    finally:
        Path(name).unlink()
    if args.json:
        args.json.write_text(json.dumps(reports,ensure_ascii=False,indent=2)+'\n',encoding='utf-8',newline='\n')
    print(json.dumps([{k:v for k,v in report.items() if k!='plans'} for report in reports],indent=2))
