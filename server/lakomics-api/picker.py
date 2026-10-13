"""Read-only collector picker grant, separate from catalog client authorization."""
import json
import re
import secrets
import threading
import time

from botocore.exceptions import ClientError
from fastapi import Header, HTTPException, Request
from starlette.concurrency import run_in_threadpool

import authority
import classification_authority
import classification_snapshot
import media_tickets
from asset_list_query import shuffle_rank
from projection_cache import ProjectionCache, heads

MAX_ORIGINAL = 20 * 1024 * 1024
MIMES = ('image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/bmp')
ELIGIBLE = ("asset.committed=1 AND asset.kind IN ('image','gif') "
            "AND asset.content_type IN (" + ','.join("'" + mime + "'" for mime in MIMES) + ") "
            "AND LENGTH(asset.object_key)>0")


def fail(status, code):
    raise HTTPException(status, {"code": code})


def valid_id(value):
    return isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,64}', value) is not None


def display_body(value):
    if (not isinstance(value, dict) or set(value) != {'classificationOrderIds', 'pinnedClassificationIds'}
            or any(not isinstance(ids, list) or len(ids) > 20000
                   or any(not valid_id(id) for id in ids) or len(set(ids)) != len(ids)
                   for ids in value.values())):
        fail(400, 'pickerInvalidRequest')
    return value


def folder_tree(db):
    current = db.execute('SELECT payload FROM classification_snapshots WHERE singleton=1').fetchone()
    payload = current['payload'] if current else '{}'
    active = authority.active_domain(db, classification_authority.DOMAIN)
    if active:
        return [{"id": row['id'], "name": row['name'], "parentId": row['parent_id']}
                for row in classification_authority.compatibility_tree(
                    db, active, classification_snapshot.display_order(
                        classification_snapshot.legacy_entries(payload)))]
    return classification_snapshot.legacy_entries(payload) if current else []


def folder_links(db):
    active = authority.active_domain(db, classification_authority.DOMAIN)
    if active:
        return ("classification_authority_assignments AS link", "link.library_id=?", [active['libraryId']])
    return ('asset_classifications AS link', '1', [])


def path_for(entries, id):
    result, seen = [], set()
    while id in entries and id not in seen:
        seen.add(id)
        row = entries[id]
        result.append(row['name'])
        id = row.get('parentId')
    return result[::-1]


def register(app, api):
    cache = ProjectionCache()

    def startup():
        with api.get_db() as db:
            db.execute('CREATE TABLE IF NOT EXISTS picker_display(singleton INTEGER PRIMARY KEY '
                       'CHECK(singleton=1),payload TEXT NOT NULL)')
            db.commit()

    def grant(authorization):
        # This grant is used ONLY below. Existing client/publisher guards stay unchanged.
        try:
            return api.client_guard(api.get_db, api.API_TOKEN)(authorization)
        except HTTPException as error:
            if error.status_code not in (401, 403):
                raise
        return api.require_extension_client(authorization)

    @app.put('/v1/picker/display')
    async def publish(request: Request, authorization: str | None = Header(default=None)):
        api.require_publisher(authorization)
        value = await read_body(request, 3 * 1024 * 1024)
        payload = json.dumps(display_body(value), separators=(',', ':'))

        def store():
            with api.get_db() as db:
                db.execute('INSERT INTO picker_display VALUES(1,?) ON CONFLICT(singleton) '
                           'DO UPDATE SET payload=excluded.payload WHERE payload<>excluded.payload', [payload])
                db.commit()
        await run_in_threadpool(store)
        return {'ok': True}

    def projection(db):
        key = cache.key(db, api.list_generation(db), heads(db, (
            'mobile_character_state', 'classification_snapshots', 'picker_display')))
        cached = cache.get(key)
        if cached is not None:
            return cached
        tree = folder_tree(db)
        entries = {row['id']: row for row in tree}
        positions = {row['id']: i for i, row in enumerate(tree)}
        display = db.execute('SELECT payload FROM picker_display WHERE singleton=1').fetchone()
        settings = json.loads(display[0]) if display else {}
        order = {id: i for i, id in enumerate(settings.get('classificationOrderIds', []))}
        pins = {id: i for i, id in enumerate(settings.get('pinnedClassificationIds', []))}
        links, where, params = folder_links(db)
        direct = {id: set() for id in entries}
        for row in db.execute(f'SELECT link.classification_id,asset.id FROM {links} '
                              f'JOIN visible_assets AS asset ON asset.id=link.asset_id '
                              f'WHERE {where} AND {ELIGIBLE}', params):
            if row[0] in direct:
                direct[row[0]].add(row[1])
        totals = {id: set(ids) for id, ids in direct.items()}
        for id, ids in direct.items():
            seen = {id}
            parent = entries[id].get('parentId')
            while parent in entries and parent not in seen:
                seen.add(parent)
                totals[parent].update(ids)
                parent = entries[parent].get('parentId')
        folders = [dict(id=id, parentId=row.get('parentId'), name=row['name'],
                        path=path_for(entries, id), imageCount=len(direct[id]),
                        imageCountWithDescendants=len(totals[id]), order=i,
                        pinned=id in pins, pinOrder=pins.get(id))
                   for i, (id, row) in enumerate(sorted(entries.items(),
                       key=lambda pair: (order.get(pair[0], 20000), positions[pair[0]])))]
        state = db.execute('SELECT index_json FROM mobile_character_state WHERE singleton=1').fetchone()
        index = json.loads(state[0]) if state else {'nodes': []}
        navigation = {id: i for i, id in enumerate(index.get('navigationOrder', []))}
        counts = {row[0]: row[1] for row in db.execute(
            'SELECT member.node_id,COUNT(DISTINCT asset.id) FROM mobile_character_members AS member '
            f'JOIN visible_assets AS asset ON asset.id=member.asset_id WHERE member.filter=\'all\' AND {ELIGIBLE} '
            'GROUP BY member.node_id')}
        nodes = sorted(enumerate(index['nodes']), key=lambda pair: (
            navigation.get(pair[1]['id'], navigation.get(pair[1]['sourceId'], 20000)), pair[0]))
        characters = [dict(kind=node['kind'], id=node['sourceId'], name=node['name'],
                           seriesId=node['seriesId'], seriesPath=path_for(entries, node['seriesId']),
                           groupId=(node['parentId'][6:] if (node.get('parentId') or '').startswith('group:') else None),
                           imageCount=counts.get(node['id'], 0), order=i)
                      for i, (_, node) in enumerate(nodes) if node['kind'] in ('group', 'character')
                      and node.get('role') != 'extras' and not node.get('excluded', False)]
        return cache.put(key, {'entries': folders, 'characters': characters})

    @app.get('/v1/picker/folders')
    def folders(authorization: str | None = Header(default=None)):
        grant(authorization)
        with api.get_db() as db:
            db.execute('BEGIN')
            return projection(db)

    async def read_body(request, cap=256 * 1024):
        data = bytearray()
        async for chunk in request.stream():
            if len(data) + len(chunk) > cap:
                fail(400, 'pickerInvalidRequest')
            data.extend(chunk)
        try:
            return json.loads(data)
        except (ValueError, UnicodeError):
            fail(400, 'pickerInvalidRequest')

    @app.post('/v1/picker/batch')
    async def batch(request: Request, authorization: str | None = Header(default=None)):
        grant(authorization)
        body = await read_body(request)
        if not isinstance(body, dict):
            fail(400, 'pickerInvalidRequest')
        by_folder, by_scope = 'folderId' in body, 'scope' in body
        limit, exclude = body.get('limit', 18), body.get('exclude', [])
        if (by_folder == by_scope or set(body) - {'folderId', 'includeDescendants', 'scope', 'limit', 'exclude'}
                or type(limit) is not int or not 1 <= limit <= 24
                or not isinstance(exclude, list) or len(exclude) > 2000 or not all(map(valid_id, exclude))
                or ('includeDescendants' in body and (by_scope or type(body['includeDescendants']) is not bool))):
            fail(400, 'pickerInvalidRequest')
        if by_folder and not valid_id(body['folderId']):
            fail(400, 'pickerInvalidRequest')
        scope = body.get('scope')
        if by_scope and (not isinstance(scope, dict) or set(scope) != {'kind', 'id'}
                         or scope['kind'] not in ('character', 'group') or not valid_id(scope['id'])):
            fail(400, 'pickerInvalidRequest')

        def select():
            with api.get_db() as db:
                db.execute('BEGIN')
                if by_folder:
                    tree = {row['id']: row for row in folder_tree(db)}
                    id = body['folderId']
                    if id not in tree:
                        fail(404, 'classification_not_found')
                    ids = {id}
                    if body.get('includeDescendants', False):
                        while True:
                            children = {id for id, row in tree.items() if row.get('parentId') in ids}
                            if children <= ids:
                                break
                            ids.update(children)
                    links, where, params = folder_links(db)
                    marks = ','.join('?' for _ in ids)
                    predicate = (f'EXISTS(SELECT 1 FROM {links} WHERE link.asset_id=asset.id AND {where} '
                                 f'AND link.classification_id IN ({marks}))')
                    params += sorted(ids)
                else:
                    node_id = scope['kind'] + ':' + scope['id']
                    current = db.execute('SELECT index_json FROM mobile_character_state WHERE singleton=1').fetchone()
                    nodes = json.loads(current[0])['nodes'] if current else []
                    if not any(node['id'] == node_id and not node.get('excluded', False)
                               and node.get('role') != 'extras' for node in nodes):
                        fail(404, 'pickerScopeNotFound')
                    predicate = ("EXISTS(SELECT 1 FROM mobile_character_members AS member "
                                 "WHERE member.asset_id=asset.id AND member.node_id=? AND member.filter='all')")
                    params = [node_id]
                if exclude:
                    predicate += ' AND asset.id NOT IN (' + ','.join('?' for _ in exclude) + ')'
                    params += exclude
                where = ELIGIBLE + ' AND LENGTH(asset.thumbnail_key)>0 AND ' + predicate
                count = db.execute('SELECT COUNT(*) FROM visible_assets AS asset WHERE ' + where, params).fetchone()[0]
                seed = secrets.token_hex(16)
                db.create_function('picker_rank', 1, lambda id: shuffle_rank(seed, id), deterministic=True)
                items, scanned = [], 0
                deadline = time.monotonic() + media_tickets.MEDIA_TICKET_DEADLINE_SECONDS

                def available(row):
                    try:
                        for variant, key in [('original', row['object_key']), ('thumbnail', row['thumbnail_key'])]:
                            metadata = api._ticket_head(row, variant, key, fresh_head=True)
                            if (metadata.get('ContentType') or row['content_type']) not in MIMES:
                                return False
                        return True
                    except ClientError as error:
                        if str(error.response.get('Error', {}).get('Code')) in ('404', 'NoSuchKey', 'NotFound'):
                            return False
                        fail(502, 'pickerStorageUnavailable')
                    except media_tickets._TRANSPORT_ERRORS:
                        fail(502, 'pickerStorageUnavailable')

                # Verify only the drawn candidates, in the existing bounded HEAD pool.
                # Missing objects are skipped and replaced, without scanning the library's storage.
                while len(items) < limit and scanned < count:
                    rows = db.execute('SELECT asset.* FROM visible_assets AS asset WHERE ' + where +
                                      ' ORDER BY picker_rank(asset.id),asset.id LIMIT ? OFFSET ?',
                                      params + [limit - len(items), scanned]).fetchall()
                    if not rows:
                        break
                    checked = media_tickets._bounded_ticket_work(rows, available, deadline=deadline,
                                                                 cancelled=threading.Event())
                    if any(value is None for value in checked):
                        fail(502, 'pickerStorageUnavailable')
                    scanned += len(rows)
                    for row, exists in zip(rows, checked):
                        if exists:
                            items.append(dict(assetId=row['id'], width=row['width'] or 0, height=row['height'] or 0,
                                              byteSize=row['size_bytes'] or 0, mime=row['content_type'],
                                              thumbnailUrl='/v1/picker/thumbnail/' + row['id']))
                missing = scanned - len(items)
                return {'items': items, 'remaining': max(0, count - missing - len(items))}
        return await run_in_threadpool(select)

    def ticket(asset_id, variant, authorization):
        grant(authorization)
        if not valid_id(asset_id):
            fail(400, 'pickerInvalidRequest')
        with api.get_db() as db:
            asset = db.execute(f'SELECT asset.* FROM visible_assets AS asset WHERE {ELIGIBLE} AND asset.id=?',
                               [asset_id]).fetchone()
        if asset is None:
            fail(404, 'pickerAssetNotFound')
        key = asset['object_key'] if variant == 'original' else asset['thumbnail_key']
        if not key:
            fail(404, 'pickerAssetNotFound')
        if variant == 'original' and (asset['size_bytes'] or 0) > MAX_ORIGINAL:
            fail(413, 'pickerOriginalTooLarge')
        try:
            result = media_tickets._bounded_ticket_work(
                [None], lambda _: api._ticket_head(asset, variant, key, fresh_head=True),
                deadline=time.monotonic() + media_tickets.MEDIA_TICKET_DEADLINE_SECONDS,
                cancelled=threading.Event())[0]
        except ClientError as error:
            if str(error.response.get('Error', {}).get('Code')) in ('404', 'NoSuchKey', 'NotFound'):
                fail(404, 'pickerAssetNotFound')
            fail(502, 'pickerStorageUnavailable')
        except media_tickets._TRANSPORT_ERRORS:
            fail(502, 'pickerStorageUnavailable')
        if result is None or type(result.get('ContentLength')) is not int or result['ContentLength'] < 0:
            fail(502, 'pickerStorageUnavailable')
        content_type = result.get('ContentType') or asset['content_type']
        if content_type not in MIMES:
            fail(404, 'pickerAssetNotFound')
        if variant == 'original' and result['ContentLength'] > MAX_ORIGINAL:
            fail(413, 'pickerOriginalTooLarge')
        return dict(url=api.presign_get(key, 300), expiresIn=300,
                    contentType=content_type, sizeBytes=result['ContentLength'])

    @app.get('/v1/picker/thumbnail/{asset_id}')
    def thumbnail(asset_id: str, authorization: str | None = Header(default=None)):
        return ticket(asset_id, 'thumbnail', authorization)

    @app.get('/v1/picker/original/{asset_id}')
    def original(asset_id: str, authorization: str | None = Header(default=None)):
        return ticket(asset_id, 'original', authorization)

    return startup
