"""Picker routes against temporary SQLite and fake storage, never a live library."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tests.test_capture_api_stub import fake_s3
import api_auth
import app as api
import authority
import classification_authority
import library_search
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

    def test_batch_skips_missing_originals_and_thumbnails_and_replaces_the_draw(self):
        self.asset('lost-original')
        self.asset('lost-thumbnail')
        fake_s3.objects.pop('private/lost-original')
        fake_s3.objects.pop('thumb/lost-thumbnail')
        result = self.batch(folderId='s', includeDescendants=True).json()
        self.assertEqual({row['assetId'] for row in result['items']}, {'a', 'b'})
        self.assertEqual(result['remaining'], 0)
        for row in result['items']:
            self.assertEqual(row['thumbnailUrl'], '/v1/picker/thumbnail/' + row['assetId'])

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
