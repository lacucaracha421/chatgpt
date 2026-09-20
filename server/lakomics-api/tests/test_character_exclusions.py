"""Manual corrections with real API transactions and disposable library data."""
import copy
import json
import time
import unittest
import uuid

from tests import test_mobile_characters as fixtures
import api_auth
import authority
import classification_authority

api_app, fixture, PREFIX, AUTH = fixtures.api_app, fixtures.fixture, fixtures.PREFIX, fixtures.AUTH

LIBRARY = 'e' * 32
ROUTE = PREFIX + '/exclusions'


class CharacterExclusionTests(unittest.TestCase):
    asset = fixtures.MobileCharactersTests.asset
    index = fixtures.MobileCharactersTests.index
    browse = fixtures.MobileCharactersTests.browse
    tearDown = fixtures.MobileCharactersTests.tearDown

    def setUp(self):
        fixtures.MobileCharactersTests.setUp(self)
        api_auth.startup(api_app.get_db)
        authority.startup(api_app.get_db)
        classification_authority.startup(api_app.get_db)
        with api_app.get_db() as db:
            _, publisher = api_auth.provision_token(db, 'publisher', 'fixture')
            _, client = api_auth.provision_token(db, 'client', 'fixture')
            self.publisher = {'Authorization': 'Bearer ' + publisher}
            self.auth = {'Authorization': 'Bearer ' + client}
            db.execute("INSERT INTO authority_domains VALUES(?,'classifications',1,1,0,?,NULL,'2026')",
                       (LIBRARY, 'a' * 64))
            db.execute("UPDATE assets SET sha256=?", ('a' * 64,))
            db.execute("INSERT INTO asset_classifications VALUES('a','ordinary','2026')")
            db.commit()

    def snapshot(self):
        body = fixture()
        body.update(manualExclusionVersion=1, libraryId=LIBRARY, exclusionCursor=0)
        body['nodes'][1]['protectedAssetIds'] = []
        body['nodes'][1]['thumbnailAssetId'] = 'b'
        return body

    def publish(self, body):
        return self.client.put(PREFIX + '/replica', headers=self.publisher, json=body)

    def ready(self, body=None):
        body = body or self.snapshot()
        reply = self.publish(body)
        self.assertEqual(reply.status_code, 200, reply.text)
        return reply.json()['revision']

    def command(self, target='c', asset='b', revision=None):
        return {'version':1, 'libraryId':LIBRARY, 'operationId':str(uuid.uuid4()),
                'targetId':target, 'assetId':asset, 'revision':revision or self.index()['revision']}

    def exclude(self, body):
        return self.client.post(ROUTE, headers=self.auth, json=body)

    def test_bootstrap_roles_and_reference_capability_gate(self):
        before = self.index()
        self.assertFalse(before['capabilities']['manualExclusion'])
        reply = self.client.get(ROUTE, headers=self.publisher, params={'libraryId':LIBRARY})
        self.assertEqual(reply.status_code, 200, reply.text)
        self.assertEqual(reply.json(), {'version':1,'libraryId':LIBRARY,'after':0,'nextCursor':0,'hasMore':False,'items':[]})
        for headers in ({}, AUTH, self.auth):
            self.assertEqual(self.client.get(ROUTE, headers=headers, params={'libraryId':LIBRARY}).status_code, 401)
        for headers in (AUTH, self.auth):
            self.assertEqual(self.client.put(PREFIX+'/replica', headers=headers, json=self.snapshot()).status_code, 401)
        revision = self.ready()
        index = self.index()
        self.assertEqual(index['libraryId'], LIBRARY)
        self.assertTrue(index['capabilities']['manualExclusion'])
        self.assertFalse(index['capabilities']['write'])
        self.assertEqual(index['revision'], revision)
        self.assertEqual(index['exclusionCursor'], 0)
        self.assertEqual(index['appliedExclusionCursor'], 0)
        self.assertEqual(self.client.post(ROUTE,json=self.command()).status_code, 401)

    def test_receipt_retry_precedes_revision_check_and_mutates_no_classification(self):
        old = self.ready()
        with api_app.get_db() as db:
            before = list(db.execute('SELECT * FROM assets ORDER BY id'))
            memberships = list(db.execute('SELECT * FROM asset_classifications'))
        request = self.command()
        response = self.exclude(request)
        self.assertEqual(response.status_code, 200, response.text)
        receipt = response.json()
        self.assertEqual(receipt['sequence'], 1)
        self.assertTrue(receipt['pendingPc'])
        self.assertNotEqual(old, receipt['revision'])
        self.assertEqual(self.exclude(request).json(), receipt)
        self.assertEqual(self.browse(old).status_code, 409)
        page = self.browse(receipt['revision'], media_kind='images', limit=1).json()
        self.assertEqual([a['id'] for a in page['items']], ['a'])
        self.assertEqual((page['totalCount'],page['sourceCount']), (1,2))
        self.assertFalse(page['has_more'])
        self.assertIsNone(self.index()['nodes'][1]['thumbnailAssetId'])
        self.assertEqual(self.browse(receipt['revision'],node='series:s').json()['totalCount'], 2)
        with api_app.get_db() as db:
            self.assertEqual(list(db.execute('SELECT * FROM assets ORDER BY id')), before)
            self.assertEqual(list(db.execute('SELECT * FROM asset_classifications')), memberships)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM mobile_character_exclusions').fetchone()[0], 1)
        different = {**request, 'assetId':'a'}
        self.assertEqual(self.exclude(different).json()['detail']['code'], 'operationConflict')

    def test_pending_exclusion_survives_stale_pc_publication_then_ack_fences_older_pc(self):
        body = self.snapshot()
        self.ready(body)
        request = self.command()
        receipt = self.exclude(request).json()
        body['baseRevision'] = receipt['revision']
        revision = self.ready(body)  # PC has not received sequence 1: overlay survives.
        self.assertEqual([a['id'] for a in self.browse(revision).json()['items']], ['a'])
        self.assertEqual(self.exclude(request).json(), receipt)
        applied = copy.deepcopy(body)
        applied['baseRevision'] = revision
        applied['exclusionCursor'] = 1
        applied['scopes'][-1]['assetIds'] = ['a','pending']
        applied_revision = self.ready(applied)
        self.assertEqual(self.index()['appliedExclusionCursor'], 1)
        body['baseRevision'] = applied_revision
        self.assertEqual(self.publish(body).status_code, 409)
        legacy = fixture(); legacy['baseRevision'] = applied_revision
        self.assertEqual(self.client.put(PREFIX+'/replica',headers=AUTH,json=legacy).status_code, 409)
        # A later explicit PC accept is newer intent, not replay of an old exclusion.
        applied['baseRevision'] = applied_revision
        applied['scopes'][-1]['assetIds'] = ['b','a','pending']
        accepted = self.ready(applied)
        self.assertEqual([a['id'] for a in self.browse(accepted).json()['items']], ['b','a'])
        self.assertEqual(self.exclude(request).json(), receipt)
        self.assertEqual([a['id'] for a in self.browse(accepted).json()['items']], ['b','a'])

    def test_group_union_preserves_other_character_and_series(self):
        body = self.snapshot()
        body['nodes'][1]['parentId'] = 'group:g'
        body['nodes'] += [
            {'id':'group:g','kind':'group','sourceId':'g','seriesId':'s','parentId':'series:s','name':'Group','thumbnailAssetId':'b'},
            {'id':'character:d','kind':'character','sourceId':'d','seriesId':'s','parentId':'group:g','name':'D','protectedAssetIds':[]}]
        body['scopes'] += [
            {'nodeId':'group:g','filter':'all','assetIds':['b','a']},
            {'nodeId':'character:d','filter':'all','assetIds':['b']}]
        self.ready(body)
        self.assertEqual(self.exclude(self.command()).status_code, 200)
        revision = self.index()['revision']
        self.assertEqual(self.browse(revision,node='group:g').json()['totalCount'], 2)
        self.assertEqual(self.browse(revision,node='character:d').json()['totalCount'], 1)
        self.assertEqual(self.exclude(self.command(target='d')).status_code, 200)
        revision = self.index()['revision']
        self.assertEqual([a['id'] for a in self.browse(revision,node='group:g').json()['items']], ['a'])
        self.assertEqual(self.browse(revision,node='series:s').json()['totalCount'], 2)
        group = next(n for n in self.index()['nodes'] if n['id']=='group:g')
        self.assertIsNone(group['thumbnailAssetId'])

    def test_protected_refs_stale_revision_missing_members_and_wrong_library_refused(self):
        body = self.snapshot(); body['nodes'][1]['protectedAssetIds']=['a']
        self.ready(body)
        self.assertEqual(self.exclude(self.command(asset='a')).json()['detail']['code'], 'characterReferenceProtected')
        for changes, code in [({'revision':'0'*64},'characterSnapshotChanged'),
                              ({'assetId':'not-published'},'characterSnapshotChanged'),
                              ({'targetId':'series:s'},None),
                              ({'libraryId':'f'*32},'libraryMismatch')]:
            reply = self.exclude({**self.command(), **changes})
            self.assertGreaterEqual(reply.status_code, 400)
            if code:
                self.assertEqual(reply.json()['detail']['code'], code)
        missing = self.snapshot(); missing['nodes'][1].pop('protectedAssetIds')
        self.assertEqual(self.publish(missing).status_code, 422)
        with api_app.get_db() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM mobile_character_exclusions').fetchone()[0], 0)

    def test_ordered_bounded_log_and_ahead_cursor(self):
        self.ready()
        one = self.exclude(self.command()).json()
        two = self.exclude(self.command(asset='a')).json()
        page = self.client.get(ROUTE,headers=self.publisher,params={'libraryId':LIBRARY,'after':0,'limit':1}).json()
        self.assertEqual(page['nextCursor'],1)
        self.assertTrue(page['hasMore'])
        self.assertEqual(page['items'][0]['operationId'],one['operationId'])
        self.assertEqual(page['items'][0]['assetSha256'],'a'*64)
        rest = self.client.get(ROUTE,headers=self.publisher,params={'libraryId':LIBRARY,'after':1,'limit':1}).json()
        self.assertEqual(rest['items'][0]['operationId'],two['operationId'])
        self.assertFalse(rest['hasMore'])
        for after in (-1,3,10**30):
            self.assertGreaterEqual(self.client.get(ROUTE,headers=self.publisher,params={'libraryId':LIBRARY,'after':after}).status_code,400)
        body=self.snapshot();body.update(baseRevision=self.index()['revision'],exclusionCursor=3)
        self.assertEqual(self.publish(body).status_code,409)

    def test_exclusion_and_retirement_do_not_double_subtract(self):
        self.ready()
        revision = self.exclude(self.command()).json()['revision']
        # Simulate a visibility source removing the same member using the existing view.
        with api_app.get_db() as db:
            db.execute("DELETE FROM assets WHERE id='b'")
            db.commit()
        page = self.browse(revision).json()
        self.assertEqual((page['totalCount'],page['sourceCount']), (1,2))

    def test_9000_asset_fixture_keeps_read_cost_bounded_without_analysis(self):
        body = self.snapshot()
        ids = [f'asset-{i}' for i in range(9000)]
        with api_app.get_db() as db:
            db.executemany("INSERT INTO assets(id,kind,object_key,sha256,created_at,updated_at,collected_at,committed) VALUES(?,'image',?,?,'2026','2026','2026',1)",
                           ((id,'private/'+id,'b'*64) for id in ids))
            db.commit()
        body['scopes'][-1]['assetIds']=ids[:90]
        body['scopes'][0]['assetIds']=ids
        for i in range(1,100):
            body['nodes'].append({'id':f'character:c{i}','kind':'character','sourceId':f'c{i}','seriesId':'s','parentId':'series:s','name':f'C{i}','protectedAssetIds':[]})
            body['scopes'].append({'nodeId':f'character:c{i}','filter':'all','assetIds':ids[i*90:(i+1)*90]})
        self.ready(body)
        started=time.monotonic()
        self.assertEqual(self.exclude(self.command(asset=ids[0])).status_code,200)
        write_elapsed=time.monotonic()-started
        started=time.monotonic();index=self.index();index_elapsed=time.monotonic()-started
        started=time.monotonic();page=self.browse(index['revision'],limit=40).json();page_elapsed=time.monotonic()-started
        self.assertEqual(page['totalCount'],89)
        self.assertEqual(len(page['items']),40)
        print(f'\n9000-Asset/100-character fixture: exclude={write_elapsed:.3f}s index={index_elapsed:.3f}s page={page_elapsed:.3f}s')
