"""Real HTTP projections. Run outside sandboxes whose TestClient loop hangs."""
import hashlib
from unittest import mock

from fastapi.testclient import TestClient

from tests.test_library_thumbnail_uploads import Fixture, ASSET, AUTH, RED, BLUE
import app as api
import head_cache
import library_thumbnails as thumbs
import migrate_library_thumbnails as migration


class ThumbnailHTTPTests(Fixture):
    def setUp(self):
        super().setUp()
        api.startup_classifications()
        api.startup_mobile_characters()
        self.client = TestClient(api.app)
        self.addCleanup(self.client.close)
        self.headers = {'Authorization': AUTH}

    def test_prepare_commit_wire_validation_auth_and_legacy_list_shape(self):
        self.seed()
        body = {'asset_id': ASSET, 'operation_id': 'wire', 'sha256': hashlib.sha256(RED).hexdigest(),
                'size_bytes': len(RED), 'content_type': 'image/webp'}
        path = '/v1/replication/thumbnails/'
        self.assertEqual(self.client.post(path+'prepare', json=body).status_code, 401)
        for change in ({'sha256':'bad'}, {'size_bytes':thumbs.MAX_BYTES+1}, {'size_bytes':True}, {'content_type':'image/png'}):
            self.assertEqual(self.client.post(path+'prepare', headers=self.headers, json={**body, **change}).status_code,422)
        with mock.patch('r2.presign_put', return_value='https://fixture.invalid'):
            prepared = self.client.post(path+'prepare', headers=self.headers, json=body)
        self.assertEqual(prepared.status_code, 200, prepared.text)
        session = prepared.json()
        self.assertEqual(session['required_headers']['Content-Length'],str(len(RED)))
        self.storage.seed(session['upload_object_key'])
        committed = self.client.post(path+'commit', headers=self.headers, json={'asset_id':ASSET,'upload_id':session['upload_id']})
        self.assertEqual(committed.status_code,200,committed.text)
        response = self.client.get('/v1/library/assets', headers=self.headers)
        self.assertEqual(response.status_code,200,response.text)
        self.assertNotIn('thumbnail_revision', response.json()['items'][0])
        self.assertNotIn('thumbnail_revision',self.client.get('/v1/assets',headers=self.headers).json()['items'][0])

    def test_single_21_50_ticket_routes_zero_heads_after_new_publish_and_migration(self):
        ids = [f'00000000-0000-4000-8000-{index:012d}' for index in range(1,51)]
        for asset in ids:
            self.seed(asset)
        self.commit(self.upload())
        with api.get_db() as db:
            migration.install(db)
            migration.manifest(db,'http')
            migration.Migrator(db,self.storage,api.R2_BUCKET,'http',emit=lambda event:None).apply()
        head_cache.ticket_heads = head_cache.HeadMetadataCache()
        single = self.client.post(f'/v1/library/assets/{ASSET}/media-ticket',headers=self.headers,json={'variant':'thumbnail'})
        self.assertEqual(single.status_code,200,single.text)
        for count in (21,50):
            head_cache.ticket_heads = head_cache.HeadMetadataCache()
            result = self.client.post('/v1/library/media-tickets',headers=self.headers,
                                      json={'items':[{'asset_id':asset,'variant':'thumbnail'} for asset in ids[:count]]})
            self.assertEqual(result.status_code,200,result.text)
            self.assertEqual(len(result.json()['items']),count)
            self.assertTrue(all(item['ok'] for item in result.json()['items']))
        self.assertEqual(self.storage.heads,[])

    def test_character_existing_revision_overlay_in_both_sorts_keeps_membership(self):
        self.seed()
        body = {'version':1,'baseRevision':None,
                'nodes':[{'id':'series:s','kind':'series','sourceId':'s','seriesId':'s','parentId':None,'name':'S'}],
                'scopes':[{'nodeId':'series:s','filter':value,'assetIds':[ASSET] if value=='all' else []}
                          for value in ('all','unclassified','needs_review')]}
        published = self.client.put('/v1/library/characters/replica',headers=self.headers,json=body)
        self.assertEqual(published.status_code,200,published.text)
        revision = published.json()['revision']
        for sort in ('published','newest'):
            params={'node':'series:s','revision':revision,'filter':'all','sort':sort}
            before = self.client.get('/v1/library/characters/assets',headers=self.headers,params=params)
            self.assertEqual(before.status_code,200,before.text)
            self.assertEqual(before.json()['items'][0]['thumbnail_revision'],thumbs.revision(self.row()))
        self.commit(self.upload(BLUE))
        for sort in ('published','newest'):
            result = self.client.get('/v1/library/characters/assets',headers=self.headers,
                                     params={'node':'series:s','revision':revision,'filter':'all','sort':sort})
            self.assertEqual(result.status_code,200,result.text)
            self.assertEqual([item['id'] for item in result.json()['items']],[ASSET])
            self.assertEqual(result.json()['items'][0]['thumbnail_revision'],thumbs.revision(self.row()))
            self.assertIn('listGeneration',result.json())
