"""Picker routes against temporary SQLite and fake storage, never a live library."""
import base64
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tests.test_capture_api_stub import fake_s3
import api_auth
import app as api
import authority
import classification_authority
import library_search
import folder_pins
import head_cache
import picker_thumbnail_cache
from tests.test_classification_authority import activate_asset_lifecycle
from fastapi.testclient import TestClient
from projection_cache import install_generation_triggers


class PickerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_db, self.old_token = api.DB_PATH, api.API_TOKEN
        api.DB_PATH = Path(self.temp.name) / 'picker.sqlite'
        api.API_TOKEN = 'legacy-picker-test'
        api.startup()
        api.startup_replication()
        api.startup_classifications()
        api.startup_extension_profile()
        api.startup_mobile_characters()
        api.startup_picker()
        authority.startup(api.get_db)
        api_auth.startup(api.get_db)
        classification_authority.startup(api.get_db)
        api.startup_asset_authority()
        with api.get_db() as db:
            library_search.startup_db(db)
        self.extension = 'extension-picker-test-token'
        with api.get_db() as db:
            _, self.publisher = api_auth.provision_token(db, 'publisher', 'fixture')
            _, self.reader = api_auth.provision_token(db, 'client', 'fixture')
            db.execute("INSERT INTO extension_clients(id,token_hash,created_at) VALUES('ext',?,'2026')",
                       [api._token_hash(self.extension)])
            tree = [{'id': 's', 'name': 'Series', 'parentId': None},
                    {'id': 'f', 'name': 'Child', 'parentId': 's'},
                    {'id': 'other', 'name': 'Other', 'parentId': None}]
            db.execute("INSERT INTO classification_snapshots(singleton,payload,published_at,updated_at,revision) "
                       "VALUES(1,?,'2026','2026',1)", [json.dumps({'entries': tree})])
            index = {'navigationOrder': ['group:g', 'character:c'], 'nodes': [
                {'id': 'character:c', 'kind': 'character', 'sourceId': 'c', 'name': 'Character',
                 'seriesId': 's', 'parentId': 'group:g'},
                {'id': 'group:g', 'kind': 'group', 'sourceId': 'g', 'name': 'Group',
                 'seriesId': 's', 'parentId': 'series:s'}]}
            db.execute("INSERT INTO mobile_character_state VALUES(1,'revision','2026',?)", [json.dumps(index)])
            install_generation_triggers(db)
            db.commit()
        self.client = TestClient(api.app)
        fill_queue = patch.object(picker_thumbnail_cache.background, 'enqueue')
        self.fill_queue = fill_queue.start()
        self.addCleanup(fill_queue.stop)
        self.asset('a', folder='s')
        self.asset('b', folder='f', mime='image/gif', kind='gif')
        self.asset('extra', folder='other')
        with api.get_db() as db:
            db.executemany("INSERT INTO mobile_character_members VALUES(?,'all',?,?)", [
                ('character:c', 0, 'a'), ('group:g', 0, 'a'), ('group:g', 1, 'extra')])
            db.commit()

    def tearDown(self):
        self.client.close()
        api.DB_PATH, api.API_TOKEN = self.old_db, self.old_token
        self.temp.cleanup()

    def headers(self, token=None):
        return {'Authorization': 'Bearer ' + (token or self.extension)}

    def asset(self, id, folder='s', mime='image/png', kind='image', committed=1, key=None, size=3):
        key = 'private/' + id if key is None else key
        with api.get_db() as db:
            db.execute('INSERT INTO assets(id,kind,object_key,thumbnail_key,content_type,size_bytes,sha256,'
                       'created_at,updated_at,committed,width,height) VALUES(?,?,?,?,?,?,?,\'2026\',\'2026\',?,10,20)',
                       [id, kind, key, 'thumb/' + id, mime, size, id, committed])
            db.execute("INSERT INTO asset_classifications VALUES(?,?,'2026')", [id, folder])
            db.commit()
        fake_s3.objects[key] = {'body': b'abc', 'content_type': mime}
        fake_s3.objects['thumb/' + id] = {'body': b'webp', 'content_type': 'image/webp'}

    def folders(self):
        response = self.client.get('/v1/picker/folders', headers=self.headers())
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def batch(self, **body):
        return self.client.post('/v1/picker/batch', headers=self.headers(), json=body)

    def test_newest_pages_by_collected_time_with_created_fallback_and_skips_missing(self):
        self.asset('c', folder='s')
        self.asset('missing', folder='s')
        with api.get_db() as db:
            db.execute("UPDATE assets SET created_at='2027' WHERE id IN ('b','c')")
            db.execute("UPDATE assets SET collected_at='2028' WHERE id='a'")
            db.execute("UPDATE assets SET collected_at='2029' WHERE id='missing'")
            db.commit()
        del fake_s3.objects['thumb/missing']
        first = self.batch(folderId='s', includeDescendants=True, order='newest', limit=2, exclude=['a'])
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual([row['assetId'] for row in first.json()['items']], ['a', 'c'])
        self.assertEqual(first.json()['nextOffset'], 3)
        self.assertEqual(first.json()['remaining'], 4)
        last = self.batch(folderId='s', includeDescendants=True, order='newest', offset=3, limit=2).json()
        self.assertEqual([row['assetId'] for row in last['items']], ['b'])
        self.assertEqual(last['remaining'], 1)
        self.assertIsNone(last['nextOffset'])
        end = self.batch(folderId='s', order='newest', offset=100).json()
        self.assertEqual(end['items'], [])
        self.assertEqual(end['remaining'], 0)
        self.assertIsNone(end['nextOffset'])
        for kind, id, expected in [('character', 'c', ['a']), ('group', 'g', ['a', 'extra'])]:
            result = self.batch(scope={'kind': kind, 'id': id}, order='newest').json()
            self.assertEqual([row['assetId'] for row in result['items']], expected)
            self.assertIsNone(result['nextOffset'])

    def test_invalid_order_and_offset_are_rejected(self):
        for bad in [{'order': 'oldest'}, {'order': None}, {'offset': -1},
                    {'offset': 1.5}, {'offset': '1'}, {'offset': True}, {'offset': None}]:
            result = self.batch(folderId='s', **bad)
            self.assertEqual(result.status_code, 400, result.text)
            self.assertEqual(result.json()['detail']['code'], 'pickerInvalidRequest')

    def test_picker_grant_does_not_widen_catalog_or_publisher_guards(self):
        for token in [self.extension, self.reader, self.publisher, api.API_TOKEN]:
            self.assertEqual(self.client.get('/v1/picker/folders', headers=self.headers(token)).status_code, 200)
        self.assertEqual(self.client.get('/v1/picker/folders').status_code, 401)
        self.assertEqual(self.client.get('/v1/library/classifications', headers=self.headers()).status_code, 401)
        self.assertEqual(self.client.put('/v1/picker/display', headers=self.headers(), json={}).status_code, 401)
        self.assertEqual(self.client.put('/v1/picker/display', headers=self.headers(self.reader), json={}).status_code, 401)
        with api.get_db() as db:
            db.execute("UPDATE extension_clients SET revoked_at='2026' WHERE id='ext'")
            db.commit()
        for path in ['/v1/picker/folders', '/v1/picker/thumbnail/a', '/v1/picker/original/a']:
            self.assertEqual(self.client.get(path, headers=self.headers()).status_code, 401)
        self.assertEqual(self.batch(folderId='s').status_code, 401)

    def test_counts_paths_pins_and_published_character_memberships(self):
        data = {'classificationOrderIds': ['other', 'f', 's'], 'pinnedClassificationIds': ['f', 'other']}
        response = self.client.put('/v1/picker/display', headers=self.headers(self.publisher), json=data)
        self.assertEqual(response.status_code, 200, response.text)
        result = self.folders()
        self.assertEqual([row['id'] for row in result['entries']], ['other', 'f', 's'])
        folder = next(row for row in result['entries'] if row['id'] == 's')
        self.assertEqual((folder['imageCount'], folder['imageCountWithDescendants']), (1, 2))
        child = result['entries'][1]
        self.assertEqual((child['path'], child['pinned'], child['pinOrder']), (['Series', 'Child'], True, 0))
        self.assertEqual([(row['kind'], row['id'], row['imageCount']) for row in result['characters']],
                         [('group', 'g', 2), ('character', 'c', 1)])
        self.assertEqual(result['characters'][1]['groupId'], 'g')
        self.assertEqual({row['assetId'] for row in self.batch(scope={'kind': 'group', 'id': 'g'}).json()['items']}, {'a', 'extra'})
        # Changing only pins invalidates the revision cache.
        data['pinnedClassificationIds'] = []
        self.client.put('/v1/picker/display', headers=self.headers(self.publisher), json=data)
        self.assertFalse(any(row['pinned'] for row in self.folders()['entries']))

    def test_pins_made_on_any_device_replace_the_published_pins(self):
        with api.get_db() as db:
            db.executescript(folder_pins.DDL)
            db.commit()
        self.client.put('/v1/picker/display', headers=self.headers(self.publisher), json={
            'classificationOrderIds': [], 'pinnedClassificationIds': ['other']})
        self.assertEqual([row['id'] for row in self.folders()['entries'] if row['pinned']], ['other'])
        reply = self.client.post('/v1/library/folder-pins', headers=self.headers(self.reader),
                                 json={'commands': [{'op': 'add', 'ids': ['f']}]})
        self.assertEqual(reply.status_code, 200, reply.text)
        self.assertEqual([row['id'] for row in self.folders()['entries'] if row['pinned']], ['f'])

    def test_eligibility_no_rating_filter_exclusion_remaining_and_random(self):
        self.asset('pending', committed=0)
        self.asset('video', kind='video', mime='video/mp4')
        self.asset('vault', kind='vault')
        self.asset('missing', key='')
        self.asset('html', mime='text/html')
        self.asset('adult')
        with api.get_db() as db:
            db.execute("INSERT INTO library_asset_ratings(asset_id,content_rating) VALUES('adult','e')")
            db.commit()
        with patch('picker.secrets.token_hex', return_value='fixedseed123'):
            first = self.batch(folderId='s', includeDescendants=True, limit=1).json()
            self.assertEqual(first['remaining'], 2)
            self.assertEqual(first, self.batch(folderId='s', includeDescendants=True, limit=1).json())
        seen = [row['assetId'] for row in first['items']]
        rest = self.batch(folderId='s', includeDescendants=True, exclude=seen).json()
        self.assertEqual(set(seen + [row['assetId'] for row in rest['items']]), {'a', 'b', 'adult'})
        self.assertEqual(rest['remaining'], 0)
        self.assertEqual(self.batch(folderId='s', exclude=['a', 'adult']).json(), {'items': [], 'remaining': 0})

    def test_authority_lifecycle_hides_trash_and_missing_canonical_rows_in_every_scope(self):
        self.asset('trash')
        self.asset('review')
        activate_asset_lifecycle(api.get_db, 'a' * 32, {
            'a': 'normal', 'b': 'normal', 'extra': 'normal', 'trash': 'trash'})
        # 'review' deliberately has no normal authority row: fails closed.
        with api.get_db() as db:
            db.execute("INSERT INTO mobile_character_members VALUES('group:g','all',2,'trash')")
            db.commit()
        folders = {row['id']: row for row in self.folders()['entries']}
        self.assertEqual(folders['s']['imageCountWithDescendants'], 2)
        self.assertEqual({row['assetId'] for row in self.batch(folderId='s', includeDescendants=True).json()['items']}, {'a', 'b'})
        self.assertEqual({row['assetId'] for row in self.batch(scope={'kind': 'group', 'id': 'g'}).json()['items']}, {'a', 'extra'})
        for id in ['trash', 'review']:
            for variant in ['original', 'thumbnail']:
                self.assertEqual(self.client.get(f'/v1/picker/{variant}/{id}', headers=self.headers()).status_code, 404)

    def test_authority_folder_structure_and_assignments_replace_frozen_snapshot(self):
        library = 'b' * 32
        with api.get_db() as db:
            db.execute("INSERT INTO authority_domains(library_id,domain,epoch,contract_version,change_cursor,"
                       "baseline_digest,baseline_revision,activated_at) VALUES(?,'classifications',1,1,0,?,NULL,'2026')",
                       [library, '0' * 64])
            db.execute("INSERT INTO classification_authority_state(library_id,classification_id,kind,name,parent_id,"
                       "entity_revision,deleted,created_at,updated_at) VALUES(?,'s','root','Renamed',NULL,1,0,'2026','2026')", [library])
            db.execute("INSERT INTO classification_authority_assignments(library_id,asset_id,classification_id,"
                       "entity_revision,created_at,updated_at) VALUES(?,'extra','s',1,'2026','2026')", [library])
            db.commit()
        folders = self.folders()['entries']
        self.assertEqual([(row['id'], row['name'], row['imageCount']) for row in folders], [('s', 'Renamed', 1)])
        self.assertEqual([row['assetId'] for row in self.batch(folderId='s').json()['items']], ['extra'])
        self.assertEqual(self.batch(folderId='f').status_code, 404)

    def test_validation_and_missing_scopes(self):
        for body in [{}, {'folderId': 's', 'scope': {'kind': 'group', 'id': 'g'}}, {'folderId': '../x'},
                     {'folderId': 's', 'limit': True}, {'folderId': 's', 'limit': 25},
                     {'folderId': 's', 'exclude': ['x'] * 2001}, {'folderId': 's', 'includeDescendants': 1},
                     {'scope': {'kind': 'series', 'id': 's'}}]:
            response = self.batch(**body)
            self.assertEqual(response.status_code, 400, response.text)
            self.assertEqual(response.json()['detail']['code'], 'pickerInvalidRequest')
        self.assertEqual(self.batch(folderId='gone').json()['detail']['code'], 'classification_not_found')
        self.assertEqual(self.batch(scope={'kind': 'character', 'id': 'gone'}).json()['detail']['code'], 'pickerScopeNotFound')

    def test_batch_checks_only_thumbnails_returns_tickets_and_replaces_missing_thumbnails(self):
        self.asset('lost-original')
        self.asset('lost-thumbnail')
        fake_s3.objects.pop('private/lost-original')
        fake_s3.objects.pop('thumb/lost-thumbnail')
        with patch.object(fake_s3, 'head_object', wraps=fake_s3.head_object) as head:
            response = self.batch(folderId='s', includeDescendants=True)
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        self.assertEqual({row['assetId'] for row in result['items']}, {'a', 'b', 'lost-original'})
        self.assertEqual({call.kwargs['Key'] for call in head.call_args_list},
                         {'thumb/a', 'thumb/b', 'thumb/lost-original', 'thumb/lost-thumbnail'})
        self.assertEqual(head.call_count, 4)
        self.assertEqual(result['remaining'], 0)
        for row in result['items']:
            self.assertEqual(row['thumbnailUrl'], '/v1/picker/thumbnail/' + row['assetId'])
            self.assertEqual(row['thumbnailTicket'], {
                'url': api.presign_get('thumb/' + row['assetId'], 300),
                'expiresIn': 300, 'contentType': 'image/webp', 'sizeBytes': 4})
        response = self.client.get('/v1/picker/original/lost-original', headers=self.headers())
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()['detail']['code'], 'pickerAssetNotFound')

    def test_batch_and_thumbnail_route_reuse_permitted_head_cache(self):
        key = 'derived/image-thumbnails/v2/' + 'a' * 64 + '.webp'
        fake_s3.objects[key] = {'body': b'webp', 'content_type': 'image/webp'}
        with api.get_db() as db:
            db.execute("UPDATE assets SET thumbnail_key=? WHERE id='a'", [key])
            db.commit()
        with patch.object(fake_s3, 'meta', SimpleNamespace(endpoint_url='https://r2.example.test'), create=True), \
                patch.object(head_cache, 'ticket_heads', head_cache.HeadMetadataCache()), \
                patch.object(fake_s3, 'head_object', wraps=fake_s3.head_object) as head:
            first = self.batch(folderId='s')
            self.assertEqual(first.status_code, 200, first.text)
            self.assertEqual(head.call_count, 1)
            second = self.batch(folderId='s')
            self.assertEqual(second.status_code, 200, second.text)
            response = self.client.get('/v1/picker/thumbnail/a', headers=self.headers())
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json(), second.json()['items'][0]['thumbnailTicket'])
            self.assertEqual(head.call_count, 1)

    def test_first_batch_of_18_needs_only_18_cold_thumbnail_heads(self):
        for index in range(17):
            self.asset('batch-' + str(index))
        with patch.object(fake_s3, 'head_object', wraps=fake_s3.head_object) as head:
            response = self.batch(folderId='s', limit=18)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(response.json()['items']), 18)
        self.assertEqual(head.call_count, 18)
        self.assertTrue(all(call.kwargs['Key'].startswith('thumb/') for call in head.call_args_list))
        self.assertTrue(all('thumbnailTicket' in row for row in response.json()['items']))

    def test_batch_uses_committed_thumbnail_metadata_without_head(self):
        key = 'derived/image-thumbnails/v2/' + 'b' * 64 + '.webp'
        with api.get_db() as db:
            db.execute("UPDATE assets SET thumbnail_key=?,thumbnail_metadata_key=?,"
                       "thumbnail_size_bytes=4,thumbnail_content_type='image/webp' WHERE id='a'", [key, key])
            db.commit()
        with patch.object(fake_s3, 'head_object', wraps=fake_s3.head_object) as head:
            response = self.batch(folderId='s')
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()['items'][0]['thumbnailTicket']['sizeBytes'], 4)
            self.assertEqual(self.client.get('/v1/picker/thumbnail/a', headers=self.headers()).status_code, 200)
            head.assert_not_called()

    def test_cached_thumbnail_is_inlined_and_ticket_is_preserved(self):
        key = 'derived/picker-cache-hit.webp'
        fake_s3.objects[key] = {'body': b'webp', 'content_type': 'image/webp'}
        with api.get_db() as db:
            db.execute("UPDATE assets SET thumbnail_key=?,thumbnail_metadata_key=?,"
                       "thumbnail_size_bytes=4,thumbnail_content_type='image/webp' WHERE id='a'", [key, key])
            db.commit()
        cache = picker_thumbnail_cache.ThumbnailCache(api.DB_PATH.parent / 'picker-thumbnails',
                                                      ('image/webp',))
        storage = SimpleNamespace(get_object=lambda **kwargs: {
            'Body': io.BytesIO(b'webp'), 'ContentType': 'image/webp', 'ContentLength': 4})
        self.assertEqual(cache.fill(storage, api.R2_BUCKET, key, 4), 'done')
        response = self.batch(folderId='s')
        self.assertEqual(response.status_code, 200, response.text)
        item = response.json()['items'][0]
        self.assertEqual(base64.b64decode(item['thumbnailBase64']), b'webp')
        self.assertEqual(item['thumbnailMime'], 'image/webp')
        self.assertEqual(item['thumbnailTicket']['sizeBytes'], 4)
        self.assertEqual(item['thumbnailUrl'], '/v1/picker/thumbnail/a')
        self.fill_queue.assert_not_called()

    def test_cache_miss_keeps_ticket_and_queues_immutable_key(self):
        key = 'derived/picker-cache-miss.webp'
        fake_s3.objects[key] = {'body': b'webp', 'content_type': 'image/webp'}
        with api.get_db() as db:
            db.execute("UPDATE assets SET thumbnail_key=?,thumbnail_metadata_key=?,"
                       "thumbnail_size_bytes=4,thumbnail_content_type='image/webp' WHERE id='a'", [key, key])
            db.commit()
        response = self.batch(folderId='s')
        self.assertEqual(response.status_code, 200, response.text)
        item = response.json()['items'][0]
        self.assertNotIn('thumbnailBase64', item)
        self.assertNotIn('thumbnailMime', item)
        self.assertEqual(item['thumbnailTicket']['sizeBytes'], 4)
        self.fill_queue.assert_called_once()
        self.assertEqual(self.fill_queue.call_args.args[1:], (api._s3, api.R2_BUCKET, key, 4))

    def test_media_ticket_shape_missing_objects_and_size_refusal(self):
        for variant, size, mime in [('original', 3, 'image/png'), ('thumbnail', 4, 'image/webp')]:
            response = self.client.get('/v1/picker/' + variant + '/a', headers=self.headers())
            self.assertEqual(response.status_code, 200, response.text)
            body = response.json()
            self.assertEqual(set(body), {'url', 'expiresIn', 'contentType', 'sizeBytes'})
            self.assertEqual((body['expiresIn'], body['contentType'], body['sizeBytes']), (300, mime, size))
        fake_s3.objects.pop('private/a')
        response = self.client.get('/v1/picker/original/a', headers=self.headers())
        self.assertEqual(response.json()['detail']['code'], 'pickerAssetNotFound')
        self.asset('big', size=20 * 1024 * 1024 + 1)
        response = self.client.get('/v1/picker/original/big', headers=self.headers())
        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.json()['detail']['code'], 'pickerOriginalTooLarge')
        with patch.object(api, '_ticket_head', return_value={'ContentLength': 20 * 1024 * 1024 + 1, 'ContentType': 'image/png'}):
            self.assertEqual(self.client.get('/v1/picker/original/b', headers=self.headers()).status_code, 413)


if __name__ == '__main__':
    unittest.main()
