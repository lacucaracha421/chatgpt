"""Album additions/removals, readiness, scope and HTTP cache contract."""
import copy
import unittest
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from tests import test_mobile_library_api as fixtures
api_app = fixtures.api_app

class AlbumReplicaTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.MobileLibraryApiTests()
        self.fixture.setUp()
        api_app.startup_album_replica()
        self.client,self.auth=self.fixture.client,self.fixture.auth
        self.asset='20000000-0000-4000-8000-000000000001'
        self.payload={'published_at':'2026-09-07T00:00:00Z',
            'albums':[{'id':'upload','name':'업로드용'},{'id':'temp','name':'임시'},{'id':'private','name':'Other'}],
            'media':[{'id':self.asset,'date':12345,'width':100,'height':100,'duration':0,'albums':['upload','temp','private']}]}
    def tearDown(self): self.fixture.tearDown()
    def publish(self,payload=None):
        return self.client.put('/v1/library/album-snapshot',headers=self.auth,json=payload or self.payload)
    def get(self,etag=None):
        return self.client.get('/v1/library/album-media?album_id=upload&album_id=temp',headers={**self.auth,**({'If-None-Match':etag} if etag else {})})
    def test_auth_and_unpublished_do_not_look_like_an_empty_album(self):
        self.assertEqual(self.client.get('/v1/library/album-media?album_id=upload').status_code,401)
        self.assertEqual(self.client.put('/v1/library/album-snapshot',json=self.payload).status_code,401)
        self.assertEqual(self.get().status_code,503)
    def test_ready_media_arrives_without_republishing_membership_and_removal_clears_it(self):
        self.assertEqual(self.publish().status_code,200)
        before=self.get();self.assertEqual(before.json()['media'],[])
        self.fixture.commit_asset(self.asset)
        current=self.get(before.headers['etag']);self.assertEqual(current.status_code,200)
        self.assertEqual(current.json()['media'][0]['albums'],['temp','upload'])
        self.assertEqual({a['id'] for a in current.json()['albums']},{'temp','upload'})
        self.assertEqual(self.get(current.headers['etag']).status_code,304)
        changed=copy.deepcopy(self.payload);changed['media']=[];changed['published_at']='2026-09-07T00:01:00Z'
        self.assertEqual(self.publish(changed).status_code,200)
        self.assertEqual(self.get(current.headers['etag']).json()['media'],[])
        self.assertEqual(self.publish().status_code,409)
    def test_deleted_album_and_invalid_snapshot(self):
        self.publish()
        invalid=copy.deepcopy(self.payload);invalid['media'][0]['albums']=['missing']
        self.assertEqual(self.publish(invalid).status_code,400)
        duplicate=copy.deepcopy(self.payload);duplicate['albums'].append(duplicate['albums'][0])
        self.assertEqual(self.publish(duplicate).status_code,400)
        self.assertEqual(self.publish({'published_at':'2026-09-07T00:02:00Z','albums':[],'media':[]}).status_code,200)
        self.assertEqual(self.get().json()['albums'],[])
