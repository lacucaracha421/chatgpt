"""PC-published captions and character names; CPU-only tablet description search.

Publication is incremental and idempotent. It never changes media or classification.
The plain-Python ranking/storage functions also run without FastAPI installed.
"""
from collections import Counter
import hashlib
import heapq
import json
import math
import re
import unicodedata

import asset_visibility

PREFIX = "/v1/library/captions"
SEARCH = "/v1/library/search/description"
MAX_BODY_BYTES = 8 * 1024 * 1024
MAX_CAPTIONS = 10_000
MAX_NAMES = 10_000
DDL = """
CREATE TABLE IF NOT EXISTS library_caption_state(
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL);
INSERT OR IGNORE INTO library_caption_state VALUES(1,0);
CREATE TABLE IF NOT EXISTS library_captions(
 asset_id TEXT PRIMARY KEY, text TEXT NOT NULL, digest TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS library_caption_names(
 target_id TEXT PRIMARY KEY, payload TEXT NOT NULL, digest TEXT NOT NULL);
"""
TOKEN = re.compile('[0-9a-z가-힣ㄱ-ㅎㅏ-ㅣ]+')
HANGUL = re.compile('[가-힣ㄱ-ㅎㅏ-ㅣ]')
UNIT_CACHE = {}
ID = re.compile(r'^[A-Za-z0-9_-]{1,128}$')


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=True)


def text_units(text):
    """Same repeated gate units as PC runtime_support.text_units (NFC syllables)."""
    units = []
    for token in TOKEN.findall(unicodedata.normalize('NFC', text).lower()):
        if HANGUL.search(token):
            units.extend(('k', token[i:i + 2]) for i in range(len(token) - 1))
        elif re.fullmatch('[a-z]{3,}', token):
            units.append(('w', token))
    return units


def validate_upload(body):
    def string(value, maximum, pattern=None):
        if not isinstance(value, str) or not value.strip() or len(value) > maximum:
            raise ValueError('Invalid publication text')
        if pattern and not pattern.fullmatch(value):
            raise ValueError('Invalid publication id')
        return value

    if not isinstance(body, dict) or body.keys() - {'version', 'captions', 'names'}:
        raise ValueError('Invalid caption publication')
    if type(body.get('version')) is not int or body['version'] != 1:
        raise ValueError('Invalid caption version')
    captions, names = body.get('captions', []), body.get('names', [])
    for rows, bound, key in ((captions, MAX_CAPTIONS, 'assetId'), (names, MAX_NAMES, 'targetId')):
        if not isinstance(rows, list) or len(rows) > bound:
            raise ValueError('Publication exceeds row limit')
        seen = set()
        for row in rows:
            if not isinstance(row, dict):
                raise ValueError('Invalid publication row')
            identity = string(row.get(key), 128, ID)
            if identity in seen:
                raise ValueError('Duplicate publication id')
            seen.add(identity)
            if key == 'assetId':
                if set(row) != {'assetId', 'text'}:
                    raise ValueError('Invalid caption fields')
                if row['text'] is not None:
                    string(row['text'], 4000)
            else:
                if set(row) == {'targetId', 'deleted'} and row['deleted'] is True:
                    continue
                if set(row) != {'targetId', 'displayName', 'seriesName', 'tags'}:
                    raise ValueError('Invalid name fields')
                string(row['displayName'], 500)
                if row['seriesName'] is not None:
                    string(row['seriesName'], 500)
                if not isinstance(row['tags'], list) or len(row['tags']) > 100:
                    raise ValueError('Invalid name tags')
                for tag in row['tags']:
                    string(tag, 200)
                if len(set(row['tags'])) != len(row['tags']):
                    raise ValueError('Duplicate name tag')
    return captions, names


def publish(db, body):
    captions, names = validate_upload(body)
    changed = False
    # The caller owns BEGIN IMMEDIATE/commit; validate every row before writing any.
    for rows, table, key in ((captions, 'library_captions', 'assetId'),
                             (names, 'library_caption_names', 'targetId')):
        column = 'asset_id' if key == 'assetId' else 'target_id'
        for row in rows:
            old = db.execute(f'SELECT digest FROM {table} WHERE {column}=?', [row[key]]).fetchone()
            deleted = row.get('deleted') is True or (key == 'assetId' and row['text'] is None)
            if deleted:
                if old:
                    db.execute(f'DELETE FROM {table} WHERE {column}=?', [row[key]])
                    changed = True
                continue
            payload = row['text'] if key == 'assetId' else encode({**row, 'tags': sorted(row['tags'])})
            digest = hashlib.sha256(payload.encode('utf-8')).hexdigest()
            if old and old[0] == digest:
                continue
            field = 'text' if key == 'assetId' else 'payload'
            db.execute(f'INSERT INTO {table} VALUES(?,?,?) ON CONFLICT({column}) '
                       f'DO UPDATE SET {field}=excluded.{field},digest=excluded.digest',
                       [row[key], payload, digest])
            changed = True
    if changed:
        db.execute('UPDATE library_caption_state SET revision=revision+1 WHERE singleton=1')
    revision = db.execute('SELECT revision FROM library_caption_state WHERE singleton=1').fetchone()[0]
    return {'version': 1, 'revision': revision, 'changed': changed,
            'captions': len(captions), 'names': len(names)}


def route_names(query, names):
    """Match complete whitespace tokens/phrases; consume only the matched series words."""
    tokens = query.split()
    lower = [token.lower() for token in tokens]
    absorbed, tags = set(), set()
    for name in names:
        hits = []
        for alias in name['displayName'].split('/'):
            parts = alias.strip().lower().split()
            if not parts:
                continue
            hits.extend(range(i, i + len(parts)) for i in range(len(tokens) - len(parts) + 1)
                        if lower[i:i + len(parts)] == parts)
        if not hits:
            continue
        for hit in hits:
            absorbed.update(hit)
        tags.update(name['tags'])
        parts = (name['seriesName'] or '').lower().split()
        if parts:
            for i in range(len(tokens) - len(parts) + 1):
                if lower[i:i + len(parts)] == parts:
                    absorbed.update(range(i, i + len(parts)))
    return tags, ' '.join(token for i, token in enumerate(tokens) if i not in absorbed), bool(absorbed)


def cached_units(digest, text):
    units = UNIT_CACHE.get(digest)
    if units is None:
        if len(UNIT_CACHE) >= 20_000:
            UNIT_CACHE.clear()
        units = UNIT_CACHE[digest] = Counter(text_units(text))
    return units


def rank(captions, query, force=False, vocabulary=()):
    """BM25 k1=1.5, b=.75; gate shares known repeated units, accepting exactly 60%.

    ``captions`` are (asset id, text, digest) rows; the digest keys a bounded in-process unit cache.
    """
    documents = [(identity, cached_units(digest, text)) for identity, text, digest in captions]
    units = text_units(query)
    counts = Counter(unit for _, document in documents for unit in document)
    known = set(counts) | set(vocabulary)
    coverage = sum(unit in known for unit in units) / len(units) if units else 0.0
    if not force and coverage < .6:
        return [], True, coverage
    if not documents or not units:
        return [], False, coverage
    average = sum(sum(document.values()) for _, document in documents) / len(documents) or 1
    scores = []
    for identity, document in documents:
        length = sum(document.values())
        score = 0.0
        for unit, repeated in Counter(units).items():
            frequency = document.get(unit, 0)
            if frequency:
                idf = math.log(1 + (len(documents) - counts[unit] + .5) / (counts[unit] + .5))
                score += repeated * idf * frequency * 2.5 / (frequency + 1.5 * (.25 + .75 * length / average))
        if score > 0:
            scores.append((identity, score))
    return scores, False, coverage


def visible_ids(db, ids):
    """Subset of ``ids`` that are committed, visible image/GIF Assets (applied before ranking)."""
    ids, found = list(ids), set()
    for start in range(0, len(ids), 500):
        part = ids[start:start + 500]
        found.update(row[0] for row in db.execute(
            "SELECT id FROM visible_assets WHERE committed=1 AND kind IN ('image','gif','animated_gif') "
            'AND id IN (' + ','.join('?' for _ in part) + ')', part))
    return found


def search(db, query, force=False, limit=200):
    query = unicodedata.normalize('NFC', query).strip()
    asset_visibility.install(db)
    empty = {'version': 1, 'ready': False, 'query': query, 'force': force, 'gated': False,
             'coverage': 1.0, 'route': 'captions', 'items': []}
    if not db.execute("SELECT 1 FROM sqlite_temp_master WHERE type='view' AND name='visible_assets'").fetchone():
        return empty
    names = [json.loads(row[0]) for row in db.execute('SELECT payload FROM library_caption_names')]
    tags, description, name_hit = route_names(query, names)
    allowed = set()
    if tags:
        ordered = sorted(tags)
        allowed = visible_ids(db, [row[0] for row in db.execute(
            'SELECT DISTINCT asset_id FROM library_asset_tags WHERE tag_id IN (' + ','.join('?' for _ in ordered) + ')',
            ordered)])
    captions = [(row[0], row[1], row[2]) for row in db.execute(
        'SELECT c.asset_id,c.text,c.digest FROM library_captions c JOIN visible_assets v ON v.id=c.asset_id '
        "WHERE v.committed=1 AND v.kind IN ('image','gif','animated_gif')")]
    if not query:
        return empty
    ready = bool(captions) or (name_hit and not description)
    gated, coverage = False, 1.0
    if name_hit and not description:
        scores, route = [(identity, 1.0) for identity in allowed], 'tags'
    elif not captions:
        scores, route = [], 'mixed' if name_hit else 'captions'
    else:
        vocabulary = {('w', word) for row in db.execute('SELECT tag_id FROM library_tag_vocabulary')
                      for word in re.split(r'[_():\s]+', row[0].lower()) if len(word) >= 3}
        # The 60% gate applies only to pure descriptions; a character name already anchors a mixed query.
        scores, gated, coverage = rank(captions, description, force or name_hit, vocabulary)
        route = 'captions'
        if name_hit:
            route = 'mixed'
            scores = [(identity, score) for identity, score in scores if identity in allowed]
            if not scores:
                # Like the PC route, a name whose description finds nothing falls back to its tags.
                scores, route = [(identity, 1.0) for identity in allowed], 'mixed_fallback'
    top = heapq.nsmallest(limit, scores, key=lambda pair: (-pair[1], pair[0]))
    items = []
    for start in range(0, len(top), 500):
        part = [identity for identity, _ in top[start:start + 500]]
        rows = {row['id']: row for row in db.execute(
            'SELECT * FROM visible_assets WHERE id IN (' + ','.join('?' for _ in part) + ')', part)}
        items.extend(rows[identity] for identity in part if identity in rows)
    return {'version': 1, 'ready': ready, 'query': query, 'force': force, 'gated': gated,
            'coverage': coverage, 'route': route, 'items': items}


def register(app, get_db, require_client, require_publisher):
    from fastapi import Header, Query, Request
    from starlette.concurrency import run_in_threadpool
    import home_publications as common

    def upload(body):
        with get_db() as db:
            db.execute('BEGIN IMMEDIATE')
            try:
                result = publish(db, body)
            except ValueError:
                common.fail(422, 'invalidCaptionUpload', 'Invalid caption publication')
            db.commit()
            return result

    @app.put(PREFIX)
    async def put_captions(request: Request, authorization: str | None = Header(default=None)):
        require_publisher(authorization)
        raw = await common.bounded_body(request, MAX_BODY_BYTES, 'captionUploadTooLarge', 'Caption batch is too large')
        try:
            body = json.loads(raw)
        except (ValueError, UnicodeError):
            common.fail(422, 'invalidCaptionUpload', 'Invalid caption publication')
        return await run_in_threadpool(upload, body)

    @app.get(SEARCH)
    def get_description(q: str = Query(default='', max_length=200),
                        force: bool = False, limit: int = Query(default=200, ge=1, le=200),
                        authorization: str | None = Header(default=None)):
        require_client(authorization)
        import library_assets
        with get_db() as db:
            db.execute('BEGIN')
            # Bound to the Asset list generation so the tablet's page loader treats it like any other page.
            generation = library_assets.api.list_generation(db)
            result = search(db, q, force, limit)
            result['listGeneration'] = generation
            memberships = library_assets._mobile_memberships(db, result['items'])
            result['items'] = [library_assets.mobile_asset_item(row, memberships[row['id']]) for row in result['items']]
        return result
