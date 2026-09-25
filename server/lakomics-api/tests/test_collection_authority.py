"""Collections authority (slice 0): inactive substrate, staging, activation, commands, feeds.

Real API transactions against a disposable SQLite database; no storage or provider calls.
"""
import copy
import datetime
import unittest
import hashlib
import json
import uuid
from pathlib import Path

from tests import test_mobile_collections as fixtures
from tests.test_capture_api_stub import fake_s3
import api_auth
import authority
import collection_authority as ca

api_app, AUTH, work = fixtures.api_app, fixtures.AUTH, fixtures.work

LIBRARY = 'e' * 32
PREFIX = '/v1/collections/authority'
A1, A2, A3, MISSING = 'asset-1', 'asset-2', 'asset-3', 'asset-missing'
MERGE_FIXTURE = json.loads((Path(__file__).resolve().parents[3]
                            / 'tests/fixtures/collection-authority/provider-merge.json').read_text('utf-8'))


def blob(data):
    digest = hashlib.sha256(data).hexdigest()
    return {'sha256': digest, 'sizeBytes': len(data), 'contentType': 'image/webp'}


class CollectionAuthorityTests(unittest.TestCase):
    tearDown = fixtures.MobileCollectionsTests.tearDown

    def setUp(self):
        fixtures.MobileCollectionsTests.setUp(self)
        api_app.startup_replication()  # committed/collected_at asset columns
        api_auth.startup(api_app.get_db)
        authority.startup(api_app.get_db)
        with api_app.get_db() as db:
            _, publisher = api_auth.provision_token(db, 'publisher', 'fixture')
            _, client = api_auth.provision_token(db, 'client', 'fixture')
            self.publisher = {'Authorization': 'Bearer ' + publisher}
            self.auth = {'Authorization': 'Bearer ' + client}
            db.execute("INSERT INTO authority_domains VALUES(?,'classifications',1,1,0,?,NULL,'2026')",
                       (LIBRARY, 'a' * 64))
            for asset_id, at in ((A1, '2026-01-01'), (A2, '2026-01-02'), (A3, '2026-01-03')):
                db.execute(
                    "INSERT INTO assets(id,kind,object_key,thumbnail_key,content_type,size_bytes,"
                    "created_at,updated_at,collected_at,committed,committed_at)"
                    " VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                    (asset_id, 'image', 'objects/' + asset_id, None, 'image/png', 1, at, at, at, 1, at))
            db.commit()
        self.cover, self.thumb = blob(b'cover-original'), blob(b'cover-thumb')
        self.confirm(self.cover, self.thumb)
        art = {'id': 'cover', 'kind': 'cover', 'selected': True,
               'thumbnail': {**self.thumb, 'objectKey': 'work-artwork/mobile/' + self.thumb['sha256']},
               'original': {**self.cover, 'objectKey': 'work-artwork/mobile/' + self.cover['sha256']}}
        first = work('a', '가', 'manga')
        first.update(myScore=3.0, description='PC 메모', coverAssetId=A2, assetCount=2, author='작가',
                     selectedWorkArtworkId='cover', artworks=[art],
                     volumes=[{'id': 'vol-1', 'volumeNumber': 1, 'editionIndex': 0,
                               'displayLabel': '1', 'coverArtworkId': 'cover'}])
        shown = work('s', '나', 'manga')
        shown.update(showcase=True, showcaseOrder=0)
        movie = work('m', '가', 'movie')
        self.items = [first, shown, movie]

    # --- helpers ---------------------------------------------------------------
    def confirm(self, *blobs):
        with api_app.get_db() as db:
            for item in blobs:
                db.execute('INSERT OR REPLACE INTO mobile_collection_artwork VALUES(?,?,?)',
                           (item['sha256'], item['sizeBytes'], item['contentType']))
            db.commit()

    def status(self):
        return self.client.get('/v1/collections/status', headers=AUTH).json()

    def publish_legacy(self, items=None, headers=None):
        body = {'version': 1, 'baseRevision': self.status()['revision'],
                'collections': copy.deepcopy(items or self.items),
                'personalEditVersion': 1, 'libraryId': LIBRARY, 'personalEditCursor': 0}
        return self.client.put('/v1/collections/replica', headers=headers or self.publisher, json=body)

    def baseline(self):
        def fields(item):
            return {key: item.get(key) for key in ca.WORK_FIELDS}
        works = []
        for item in self.items:
            works.append({'workId': item['id'], 'type': item['type'], 'legacyKind': None,
                          'name': item['name'], 'fields': fields(item),
                          'showcase': item.get('showcase', False),
                          'showcaseOrder': item.get('showcaseOrder'),
                          'selection': {'work': item.get('selectedWorkArtworkId'),
                                        'hero': None, 'backdrop': None},
                          'details': {'series': None, 'film': None},
                          'derived': {'unreadReleaseCount': 0},
                          'createdAt': item['createdAt'], 'updatedAt': item['updatedAt']})
        return {'libraryId': LIBRARY, 'personalEditCursor': 0, 'works': works, 'bindings': [],
                'artworks': [{'artworkId': 'cover', 'workId': 'a', 'kind': 'cover', 'provider': None,
                              'providerImageId': None, 'width': 10, 'height': 20, 'language': None,
                              'original': self.cover, 'thumbnail': self.thumb,
                              'createdAt': '2026-09-07T00:00:00Z'}],
                'volumes': [{'volumeId': 'vol-1', 'workId': 'a', 'volumeNumber': 1, 'editionIndex': 0,
                             'sortOrder': 1, 'displayLabel': '1', 'coverArtworkId': 'cover',
                             'sourceProvider': None, 'sourceCoverId': None}],
                'volumeSources': [], 'ownership': [],
                'memberships': [{'workId': 'a', 'assetId': A1, 'addedAt': '2026-01-01'},
                                {'workId': 'a', 'assetId': A2, 'addedAt': '2026-01-02'}]}

    def stage(self, doc=None, headers=None):
        return self.client.put(PREFIX + '/staging', headers=self.publisher if headers is None else headers,
                               json=doc if doc is not None else self.baseline())

    def activate(self, digest=None):
        if digest is None:
            reply = self.stage()
            self.assertEqual(reply.status_code, 200, reply.text)
            digest = reply.json()['stagedDigest']
        return self.client.post(PREFIX + '/activate', headers=self.publisher,
                                json={'libraryId': LIBRARY, 'expectedStagedDigest': digest})

    def ready(self):
        self.assertEqual(self.publish_legacy().status_code, 200)
        reply = self.activate()
        self.assertEqual(reply.status_code, 200, reply.text)
        return reply.json()

    def command(self, command_type, headers=None, operation_id=None, **fields):
        body = {'libraryId': LIBRARY, 'epoch': 1, 'contractVersion': 1,
                'operationId': operation_id or str(uuid.uuid4()), 'commandType': command_type,
                **fields}
        return self.client.put(PREFIX + '/commands', headers=headers or self.auth, json=body)

    def ok(self, reply):
        self.assertEqual(reply.status_code, 200, reply.text)
        return reply.json()

    def code(self, reply):
        return reply.json()['detail']['code']

    def work(self, work_id):
        with api_app.get_db() as db:
            return ca.work_projection(db, LIBRARY, work_id)

    def create(self, work_id, name, type_='movie', binding=None, headers=None, **fields):
        return self.command('createWork', headers=headers, workId=work_id, type=type_, name=name,
                            legacyKind=None, fields=fields, binding=binding)

    def update(self, work_id, changes, expected=None, revision=None, **kwargs):
        return self.command('updateWork', workId=work_id, changes=changes, expected=expected or {},
                            expectedRevision=revision, **kwargs)

    def listing(self, **params):
        return self.client.get('/v1/collections', headers=AUTH, params=params).json()

    def detail(self, work_id):
        return self.client.get('/v1/collections/' + work_id, headers=AUTH)

    # --- inactive safety ---------------------------------------------------------
    def test_inactive_domain_changes_nothing(self):
        self.assertEqual(self.client.get(PREFIX + '/status', headers=self.auth).json(),
                         {'active': False, 'domain': 'collections'})
        for path, params in (('/baseline', {'libraryId': LIBRARY, 'epoch': 1}),
                             ('/changes', {'libraryId': LIBRARY, 'epoch': 1})):
            reply = self.client.get(PREFIX + path, headers=self.auth, params=params)
            self.assertEqual((reply.status_code, self.code(reply)), (409, 'authorityInactive'))
        reply = self.create('w1', 'Film')
        self.assertEqual((reply.status_code, self.code(reply)), (409, 'authorityInactive'))
        # Legacy publication, personal edits and reads behave as before.
        self.assertEqual(self.publish_legacy().status_code, 200)
        self.assertEqual(self.status()['capabilities'], {'collectionPersonalEdit': True, 'collectionTrackingEdit': False})
        edit = self.client.post('/v1/collections/personal-edits', headers=self.auth, json={
            'version': 1, 'libraryId': LIBRARY, 'operationId': str(uuid.uuid4()),
            'collectionId': 'a', 'field': 'myScore', 'value': 4.0, 'expected': 3.0})
        self.assertEqual(edit.status_code, 200, edit.text)
        self.assertEqual(edit.json()['sequence'], 1)
        # Staging alone never serves anything.
        doc = self.baseline()
        doc['personalEditCursor'] = 1
        self.assertEqual(self.stage(doc).status_code, 200)
        self.assertEqual(self.listing()['items'][0]['id'], 'a')
        with api_app.get_db() as db:
            self.assertIsNone(authority.active_domain(db, 'collections'))
        domains = self.client.get('/v1/sync/status', headers=self.auth).json()['domains']
        self.assertNotIn('collections', [entry['domain'] for entry in domains])

    def test_staging_and_activation_are_publisher_only(self):
        self.publish_legacy()
        for headers in ({}, self.auth, AUTH):
            self.assertEqual(self.stage(headers=headers).status_code, 401)
            self.assertEqual(self.client.post(PREFIX + '/activate', headers=headers, json={}).status_code, 401)
            self.assertEqual(self.client.get(PREFIX + '/staging', headers=headers).status_code, 401)
        staged = self.ok(self.stage())
        self.assertEqual(staged['counts']['works'], 3)
        summary = self.client.get(PREFIX + '/staging', headers=self.publisher).json()['staged']
        self.assertEqual(summary['stagedDigest'], staged['stagedDigest'])
        self.assertEqual(self.client.delete(PREFIX + '/staging', headers=self.publisher).json(),
                         {'discarded': True})
        reply = self.activate(staged['stagedDigest'])
        self.assertEqual((reply.status_code, self.code(reply)), (409, 'collectionBaselineMissing'))

    def test_staging_validations(self):
        self.publish_legacy()

        def rejected(mutate, code='collectionBaselineRejected', status=409):
            doc = self.baseline()
            mutate(doc)
            reply = self.stage(doc)
            self.assertEqual((reply.status_code, self.code(reply)), (status, code), reply.text)
            return reply.json()['detail']

        detail = rejected(lambda d: d['works'].pop())
        self.assertEqual((detail['reason'], detail['missing']), ('works', ['m']))
        rejected(lambda d: d['works'][2].update(type='av'), 'collectionTypeUnsupported', 422)
        rejected(lambda d: d.update(personalEditCursor=3))
        self.assertEqual(rejected(lambda d: d['artworks'][0].update(
            original=blob(b'never uploaded')))['reason'], 'artworkBlob')
        self.assertEqual(rejected(lambda d: d['works'][1]['selection'].update(work='cover'))['reason'],
                         'artworkOwnership')
        self.assertEqual(rejected(lambda d: d['memberships'].append(
            {'workId': 's', 'assetId': MISSING, 'addedAt': 't'}))['reason'], 'membershipAssets')
        self.assertEqual(rejected(lambda d: d['works'][1].update(name='가'))['reason'], 'nameConflict')
        binding = {'provider': 'mangadex', 'externalId': 'x', 'config': None, 'snapshot': None,
                   'values': None, 'lastSyncedAt': None}
        self.assertEqual(rejected(lambda d: d['bindings'].extend(
            [{**binding, 'workId': 'a'}, {**binding, 'workId': 's'}]))['reason'],
            'providerIdentityTaken')
        rejected(lambda d: d.update(extra=1), 'invalidCollectionBaseline', 422)
        # Same name in different types is fine (§6.4): 'a' manga and 'm' movie are both "가".
        self.assertEqual(self.stage().status_code, 200)

    # --- activation, fence and projection ------------------------------------------
    def test_activation_projects_the_legacy_shape_and_fences_the_pc(self):
        self.publish_legacy()
        before_list = self.listing(type='manga')
        before_detail = self.detail('a').json()['item']
        before_movie = self.listing(type='movie')
        state = self.activate().json()
        self.assertEqual((state['epoch'], state['cursor'], state['counts']['memberships']), (1, 0, 2))
        after_list = self.listing(type='manga')
        self.assertTrue(after_list['ready'])
        self.assertNotEqual(after_list['revision'], before_list['revision'])
        self.assertEqual(after_list['items'], before_list['items'])
        self.assertEqual(self.detail('a').json()['item'], before_detail)
        self.assertEqual(self.listing(type='movie')['items'], before_movie['items'])
        self.assertEqual(self.status()['revision'], after_list['revision'])
        # The legacy PC snapshot is fenced; nothing it sends is applied.
        reply = self.publish_legacy()
        self.assertEqual((reply.status_code, self.code(reply)), (409, 'legacyWriterFenced'))
        legacy = self.client.put('/v1/collections/replica', headers=AUTH, json={
            'version': 1, 'baseRevision': None, 'collections': []})
        self.assertEqual((legacy.status_code, self.code(legacy)), (409, 'legacyWriterFenced'))
        domains = self.client.get('/v1/sync/status', headers=self.auth).json()['domains']
        self.assertIn('collections', [entry['domain'] for entry in domains])
        # Identical retry is idempotent; any other activation is refused.
        retry = self.activate(state['baselineDigest'])
        self.assertEqual(retry.json()['baselineDigest'], state['baselineDigest'])
        self.assertEqual(self.code(self.activate('f' * 64)), 'collectionAuthorityActive')
        self.assertEqual(self.code(self.stage()), 'collectionAuthorityActive')

    def test_activation_rejects_state_that_moved_after_staging(self):
        self.publish_legacy()
        digest = self.ok(self.stage())['stagedDigest']
        edit = self.client.post('/v1/collections/personal-edits', headers=self.auth, json={
            'version': 1, 'libraryId': LIBRARY, 'operationId': str(uuid.uuid4()),
            'collectionId': 'a', 'field': 'myScore', 'value': 4.0, 'expected': 3.0})
        self.assertEqual(edit.status_code, 200)
        reply = self.activate(digest)
        self.assertEqual((reply.status_code, self.code(reply)), (409, 'collectionBaselineRejected'))
        self.assertIsNone(self.client.get(PREFIX + '/status', headers=self.auth).json().get('epoch'))

    def test_asset_count_is_membership_intersect_visible_assets(self):
        self.ready()
        item = self.listing(type='manga')['items'][0]
        self.assertEqual((item['assetCount'], item['coverAssetId']), (2, A2))
        with api_app.get_db() as db:
            db.execute('UPDATE assets SET committed=0 WHERE id=?', (A2,))
            db.commit()
        item = self.listing(type='manga')['items'][0]
        # The cover falls back to the first visible member, like the PC summary.
        self.assertEqual((item['assetCount'], item['coverAssetId']), (1, A1))
        added = self.ok(self.command('setMembership', workId='a', assetId=A3, desiredState=True,
                                     expectedRevision=0))
        self.assertEqual(added['entities']['memberships'][0]['entityRevision'], 1)
        self.assertEqual(self.listing(type='manga')['items'][0]['assetCount'], 2)
        stale = self.command('setMembership', workId='a', assetId=A3, desiredState=False,
                             expectedRevision=0)
        self.assertEqual((stale.status_code, self.code(stale)), (409, 'revisionConflict'))
        missing = self.command('setMembership', workId='a', assetId=MISSING, desiredState=True,
                               expectedRevision=0)
        self.assertEqual(self.code(missing), 'invalidCollectionMembership')

    # --- commands ----------------------------------------------------------------------
    def test_work_commands_revisions_and_receipts(self):
        self.ready()
        created = self.ok(self.create('w1', ' Film ', year=2001))
        self.assertEqual((created['changed'], created['changeSequence']), (True, 1))
        work_state = created['entities']['works'][0]
        self.assertEqual((work_state['name'], work_state['fields']['year']), ('Film', 2001))
        self.assertEqual(self.listing(type='movie')['totalCount'], 2)
        self.assertEqual(self.code(self.create('w2', 'film')), 'nameConflict')
        self.ok(self.create('g1', 'Film', type_='game'))
        self.assertEqual(self.code(self.create('av', 'x', type_='av')), 'collectionTypeUnsupported')
        # Revision CAS.
        self.ok(self.update('w1', {'overview': 'Mine'}, revision=1))
        stale = self.update('w1', {'myScore': 4.5}, revision=1)
        self.assertEqual((stale.status_code, self.code(stale)), (409, 'revisionConflict'))
        self.assertEqual(stale.json()['detail']['current']['work']['fields']['overview'], 'Mine')
        # Field-level CAS succeeds on a stale revision when the touched field is untouched.
        self.ok(self.update('w1', {'myScore': 4.5}, {'myScore': None}, revision=1))
        memo = self.update('w1', {'overview': 'Other'}, {'overview': 'Old'})
        self.assertEqual(self.code(memo), 'revisionConflict')
        self.assertEqual(self.code(self.update('w1', {'overview': 'x'}, {})), 'invalidCollectionCommand')
        # Desired state already current: accepted without a change row.
        same = self.ok(self.update('w1', {'overview': ' Mine '}, {'overview': 'nope'}))
        self.assertFalse(same['changed'])
        # Receipts: identical retry replays; reuse with another payload conflicts.
        operation = str(uuid.uuid4())
        first = self.ok(self.update('w1', {'name': 'Film 2'}, revision=3, operation_id=operation))
        again = self.ok(self.update('w1', {'name': 'Film 2'}, revision=3, operation_id=operation))
        self.assertEqual(first, again)
        other = self.update('w1', {'name': 'Film 3'}, revision=4, operation_id=operation)
        self.assertEqual(self.code(other), 'operationConflict')
        rename = self.update('w1', {'name': 'FILM'}, revision=4)
        self.assertEqual(rename.status_code, 200)
        conflict = self.update('g1', {'name': 'x'}, revision=1)
        self.assertEqual(conflict.status_code, 200)
        clash = self.update('w1', {'name': '가'}, revision=5)
        self.assertEqual((clash.status_code, self.code(clash)), (409, 'nameConflict'))

    def test_showcase_updates_and_reorder(self):
        self.ready()
        self.ok(self.update('a', {'showcase': True}, {'showcase': False}))
        self.assertEqual(self.work('a')['showcaseOrder'], 1)
        wrong = self.command('setShowcaseOrder', type='manga', workIds=['a'])
        self.assertEqual(self.code(wrong), 'revisionConflict')
        self.assertEqual(wrong.json()['detail']['current']['showcase']['workIds'], ['s', 'a'])
        self.ok(self.command('setShowcaseOrder', type='manga', workIds=['a', 's']))
        shown = self.listing(type='manga', showcase='true')['items']
        self.assertEqual([item['id'] for item in shown], ['a', 's'])
        self.assertFalse(self.ok(self.command('setShowcaseOrder', type='manga', workIds=['a', 's']))['changed'])
        self.ok(self.update('a', {'showcase': False}, {'showcase': True}))
        self.assertIsNone(self.work('a')['showcaseOrder'])

    def test_roles_and_body_limits(self):
        self.ready()
        self.assertEqual(self.command('createWork').status_code, 422)  # client may, but bad body
        self.assertEqual(self.command('bindProvider', workId='m', provider='tmdb', externalId='1',
                                      config=None, expectedRevision=0).status_code, 401)
        self.assertEqual(self.command('purgeWork', workId='m', expectedRevision=1).status_code, 401)
        self.assertEqual(self.command('noSuchCommand').status_code, 401)
        self.assertEqual(self.client.put(PREFIX + '/commands', json={}).status_code, 401)
        huge = b'{' + b' ' * (ca.MAX_COMMAND_BYTES_CLIENT + 10) + b'}'
        self.assertEqual(self.client.put(PREFIX + '/commands', headers=self.auth, content=huge).status_code, 413)
        self.assertEqual(self.client.put(PREFIX + '/commands', headers=self.publisher, content=huge).status_code, 422)
        self.ok(self.command('bindProvider', headers=self.publisher, workId='m', provider='tmdb',
                             externalId='1', config=None, expectedRevision=0))

    def test_trash_restore_and_purge(self):
        self.ready()
        self.ok(self.create('w1', 'Film'))
        self.ok(self.command('setMembership', workId='w1', assetId=A1, desiredState=True,
                             expectedRevision=0))
        stale = self.command('deleteWork', workId='w1', expectedRevision=9)
        self.assertEqual(self.code(stale), 'revisionConflict')
        trashed = self.ok(self.command('deleteWork', workId='w1', expectedRevision=1))
        self.assertEqual(trashed['entities']['works'][0]['lifecycle'], 'trashed')
        self.assertEqual(self.detail('w1').status_code, 404)
        self.assertEqual(self.code(self.create('w2', 'Film')), 'nameConflict')  # reserved in trash
        self.assertEqual(self.code(self.update('w1', {'overview': 'x'}, revision=2)), 'workTrashed')
        self.ok(self.command('restoreWork', workId='w1', expectedRevision=2))
        self.assertEqual(self.detail('w1').status_code, 200)
        self.ok(self.command('deleteWork', workId='w1', expectedRevision=3))
        self.assertEqual(self.command('purgeWork', workId='w1', expectedRevision=4).status_code, 401)
        purged = self.ok(self.command('purgeWork', headers=self.publisher, workId='w1',
                                      expectedRevision=4))
        self.assertEqual(purged['entities']['works'][0]['lifecycle'], 'tombstoned')
        gone = self.command('restoreWork', workId='w1', expectedRevision=5)
        self.assertEqual((gone.status_code, self.code(gone)), (409, 'workDeleted'))
        self.assertTrue(gone.json()['detail']['definitive'])
        self.ok(self.create('w2', 'Film'))  # name freed by the tombstone
        self.assertEqual(self.code(self.create('w1', 'Other')), 'workExists')
        with api_app.get_db() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM collection_authority_members"
                                        " WHERE work_id='w1'").fetchone()[0], 0)

    def test_trash_expires_after_thirty_days(self):
        self.ready()
        self.ok(self.create('w1', 'Film'))
        self.ok(self.command('deleteWork', workId='w1', expectedRevision=1))
        trashed_at = datetime.datetime.strptime(self.work('w1')['trashedAt'], '%Y-%m-%dT%H:%M:%SZ')
        early = ca.now_iso(trashed_at.replace(tzinfo=datetime.timezone.utc) + datetime.timedelta(days=29))
        self.assertFalse(ca.purge_expired(api_app.get_db, now=early)['changed'])
        self.assertEqual(self.work('w1')['lifecycle'], 'trashed')
        late = ca.now_iso(trashed_at.replace(tzinfo=datetime.timezone.utc) + datetime.timedelta(days=30))
        result = ca.purge_expired(api_app.get_db, now=late)
        self.assertEqual((result['changed'], result['hasMore']), (True, False))
        self.assertEqual(self.work('w1')['lifecycle'], 'tombstoned')

    def test_provider_snapshot_merge_identity_and_staleness(self):
        self.ready()
        values = {'originalTitle': 'Perfect Blue', 'director': '곤 사토시', 'productionCompany': None,
                  'releaseDate': '1998-02-28', 'runtimeMinutes': 81, 'genres': 'Thriller',
                  'overview': 'A singer.', 'externalScore': 87}
        snapshot = {'id': 10494, 'title': 'Perfect Blue'}

        def apply(work_id, external_id, base, vals, headers=None, **extra):
            return self.command('applyProviderSnapshot', headers=headers or self.publisher,
                                workId=work_id, provider='tmdb', externalId=external_id,
                                snapshot=extra.get('snapshot', snapshot), values=vals,
                                details=extra.get('details'), baseSnapshotDigest=base)

        self.ok(self.update('m', {'overview': 'Mine', 'year': 1990}, revision=1))
        first = self.ok(apply('m', '10494', None, values))
        self.assertEqual(first['mergeMode'], 'connect')
        fields = self.work('m')['fields']
        self.assertEqual((fields['overview'], fields['director'], fields['year']), ('Mine', '곤 사토시', 1990))
        digest = first['entities']['bindings'][0]['snapshotDigest']
        stale = apply('m', '10494', None, values)
        self.assertEqual((stale.status_code, self.code(stale)), (409, 'providerSnapshotStale'))
        self.ok(self.update('m', {'director': None}, {'director': '곤 사토시'}))
        refreshed = self.ok(apply('m', '10494', digest, {**values, 'director': 'New', 'genres': 'Drama'},
                                  snapshot={'id': 10494, 'v': 2}))
        self.assertEqual(refreshed['mergeMode'], 'refresh')
        fields = self.work('m')['fields']
        self.assertEqual((fields['director'], fields['genres']), (None, 'Drama'))
        self.ok(self.create('m2', 'Other'))
        taken = apply('m2', '10494', None, values)
        self.assertEqual((taken.status_code, self.code(taken)), (409, 'providerIdentityTaken'))
        self.assertEqual(self.code(apply('a', '5', None, values)), 'providerTypeMismatch')
        # TV binding feeds the projected season range, as the PC summary does.
        tv = {'id': 7, 'series': {'seasons': [{'seasonNumber': 0, 'airDate': '1990-01-01'},
                                              {'seasonNumber': 1, 'airDate': '2020-04-01'},
                                              {'seasonNumber': 2, 'airDate': '2021-06-30'}]}}
        self.ok(apply('m2', 'tv:7', None, values, snapshot=tv))
        item = next(i for i in self.listing(type='movie')['items'] if i['id'] == 'm2')
        self.assertEqual(item['seasonDateRange'], ['2020-04-01', '2021-06-30'])
        # Created from a provider in one command; details are validated by the replica model.
        details = {'series': None, 'film': {'cast': [{'name': 'A', 'character': 'B'}],
                                            'releases': [], 'related': None}}
        created = self.ok(self.create('m3', 'New', headers=self.publisher, binding={
            'provider': 'tmdb', 'externalId': '99', 'config': None, 'snapshot': {'id': 99},
            'values': values, 'details': details}))
        self.assertEqual(list(created['entities']), ['works', 'bindings'])
        self.assertEqual(self.detail('m3').json()['item']['film']['cast'][0]['name'], 'A')
        self.assertEqual(self.work('m3')['fields']['year'], 1998)

    def test_artwork_add_select_and_ticket(self):
        self.ready()
        poster, other = blob(b'poster'), blob(b'other')

        def add(work_id, artwork_id, original, thumbnail=None):
            return self.command('addArtwork', workId=work_id, artworkId=artwork_id, kind='cover',
                                provider='tmdb', providerImageId='/p.jpg', width=10, height=15,
                                language=None, original=original, thumbnail=thumbnail)

        self.assertEqual(self.code(add('m', 'p1', poster)), 'artworkBlobUnconfirmed')
        self.confirm(poster, other)
        self.ok(add('m', 'p1', poster))
        self.assertFalse(self.ok(add('m', 'p1', poster))['changed'])
        self.assertEqual(self.code(add('m', 'p1', other)), 'artworkExists')
        self.ok(add('s', 'o1', other))
        wrong = self.command('selectArtwork', workId='m', slot='work', artworkId='o1', expectedArtworkId=None)
        self.assertEqual(self.code(wrong), 'artworkNotInWork')
        self.ok(self.command('selectArtwork', workId='m', slot='work', artworkId='p1', expectedArtworkId=None))
        stale = self.command('selectArtwork', workId='m', slot='work', artworkId=None, expectedArtworkId='zz')
        self.assertEqual(self.code(stale), 'revisionConflict')
        detail = self.detail('m').json()['item']
        self.assertEqual(detail['selectedWorkArtworkId'], 'p1')
        self.assertEqual(detail['artworks'][0]['originalDigest'], poster['sha256'])
        key = 'work-artwork/mobile/' + poster['sha256']
        fake_s3.objects[key] = {'body': b'poster', 'content_type': 'image/webp'}
        ticket = self.client.post('/v1/collections/m/artworks/p1/media-ticket', headers=AUTH,
                                  json={'variant': 'original'})
        self.assertEqual(ticket.status_code, 200, ticket.text)
        self.assertEqual(ticket.json()['sha256'], poster['sha256'])

    def test_volumes_sources_and_ownership(self):
        self.ready()
        self.ok(self.command('upsertVolumeSource', headers=self.publisher, workId='a', volumeNumber=1,
                             provider='kakao', providerItemId='k1', title='T', author=None,
                             publisher=None, isbn13='978', publicationDate='2999-01-01',
                             itemUrl=None, data={}, deleted=False, expectedRevision=0))
        volume = self.detail('a').json()['item']['volumes'][0]
        self.assertEqual((volume['isbn13'], volume['releaseStatus']), ('978', 'upcoming'))
        added = self.ok(self.command('upsertVolume', headers=self.publisher, workId='a', volumeId='vol-2',
                                     volumeNumber=2, editionIndex=0, sortOrder=2, displayLabel=None,
                                     coverArtworkId=None, sourceProvider=None, sourceCoverId=None,
                                     deleted=False, expectedRevision=0))
        self.assertEqual(added['entities']['volumes'][0]['displayLabel'], '2')
        clash = self.command('upsertVolume', headers=self.publisher, workId='a', volumeId='vol-3',
                             volumeNumber=2, editionIndex=0, sortOrder=3, displayLabel=None,
                             coverArtworkId=None, sourceProvider=None, sourceCoverId=None,
                             deleted=False, expectedRevision=0)
        self.assertEqual(self.code(clash), 'volumeConflict')
        owned = self.ok(self.command('setVolumeOwnership', headers=self.publisher, workId='a',
                                     volumeNumber=2, editionIndex=0, physical=True, digital=False,
                                     expectedRevision=0))
        self.assertEqual(owned['entities']['ownership'][0]['entityRevision'], 1)
        self.assertEqual(self.code(self.command('setVolumeOwnership', headers=self.publisher, workId='a',
                                                volumeNumber=2, editionIndex=0, physical=False,
                                                digital=False, expectedRevision=0)), 'revisionConflict')

    # --- personal-edit compatibility shim --------------------------------------------
    def test_personal_edit_shim_after_activation(self):
        self.publish_legacy()
        before = str(uuid.uuid4())
        edit = lambda operation, **kw: self.client.post('/v1/collections/personal-edits', headers=self.auth, json={
            'version': 1, 'libraryId': LIBRARY, 'operationId': operation, 'collectionId': 'a',
            'field': 'myScore', 'value': 4.0, 'expected': 3.0, **kw})
        legacy = self.ok(edit(before))
        doc = self.baseline()
        doc['personalEditCursor'] = 1
        doc['works'][0]['fields']['myScore'] = 4.0
        digest = self.ok(self.stage(doc))['stagedDigest']
        self.ok(self.activate(digest))
        status = self.status()
        self.assertEqual((status['capabilities'], status['libraryId']),
                         ({'collectionPersonalEdit': True, 'collectionTrackingEdit': False}, LIBRARY))
        self.assertEqual(self.ok(edit(before)), legacy)  # pre-activation receipt replays
        operation = str(uuid.uuid4())
        accepted = self.ok(edit(operation, value=5.0, expected=4.0))
        self.assertEqual((accepted['changed'], accepted['sequence']), (True, 1))
        self.assertEqual(accepted['revision'], self.status()['revision'])
        self.assertEqual(self.ok(edit(operation, value=5.0, expected=4.0)), accepted)
        self.assertEqual(self.code(edit(operation, value=1.0, expected=4.0)), 'operationConflict')
        self.assertEqual(self.work('a')['fields']['myScore'], 5.0)
        conflict = edit(str(uuid.uuid4()), value=1.0, expected=2.0)
        self.assertEqual((conflict.status_code, self.code(conflict)), (409, 'collectionPersonalConflict'))
        self.assertEqual(conflict.json()['detail']['current'], 5.0)
        memo = self.ok(edit(str(uuid.uuid4()), field='memo', value=' 새 메모 ', expected='PC 메모'))
        self.assertEqual(self.detail('a').json()['item']['description'], '새 메모')
        self.assertTrue(memo['changed'])
        shown = self.ok(edit(str(uuid.uuid4()), field='showcase', value=True, expected=False))
        self.assertTrue(shown['changed'])
        self.assertEqual(self.work('a')['showcaseOrder'], 1)
        self.assertEqual(self.code(edit(str(uuid.uuid4()), collectionId='zz')), 'collectionNotFound')
        self.assertEqual(self.code(edit(str(uuid.uuid4()), libraryId='f' * 32)), 'libraryMismatch')

    # --- feeds ---------------------------------------------------------------------
    def test_changes_and_baseline_feeds(self):
        self.ready()
        self.ok(self.create('w1', 'Film'))
        self.ok(self.update('w1', {'overview': 'x'}, revision=1))
        params = {'libraryId': LIBRARY, 'epoch': 1}
        changes = self.client.get(PREFIX + '/changes', headers=self.auth, params=params).json()
        self.assertEqual((changes['cursor'], changes['hasMore']), (2, False))
        self.assertEqual(changes['items'][1]['entities']['works'][0]['fields']['overview'], 'x')
        page = self.client.get(PREFIX + '/changes', headers=self.auth, params={**params, 'limit': 1}).json()
        self.assertEqual((page['nextAfter'], page['hasMore']), (1, True))
        ahead = self.client.get(PREFIX + '/changes', headers=self.auth, params={**params, 'after': 9})
        self.assertEqual(self.code(ahead), 'cursorAhead')
        manifest = self.client.get(PREFIX + '/baseline', headers=self.auth, params=params).json()
        counts = {entry['section']: entry['count'] for entry in manifest['sections']}
        self.assertEqual((manifest['snapshotCursor'], counts['works'], counts['memberships']), (2, 4, 2))
        seen, section, after = [], 'works', None
        while section is not None:
            query = {**params, 'snapshot': 2, 'section': section, 'limit': 1}
            if after:
                query['after'] = after
            reply = self.client.get(PREFIX + '/baseline', headers=self.auth, params=query).json()
            seen.extend((section, item.get('workId')) for item in reply['items'])
            if reply['hasMore']:
                after = reply['nextAfter']
            else:
                section, after = reply['nextSection'], None
                complete = reply['complete']
        self.assertTrue(complete)
        self.assertEqual(sum(1 for s, _ in seen if s == 'works'), 4)
        self.ok(self.update('w1', {'overview': 'y'}, revision=2))
        moved = self.client.get(PREFIX + '/baseline', headers=self.auth,
                                params={**params, 'snapshot': 2, 'section': 'works'})
        self.assertEqual(self.code(moved), 'baselineChanged')
        future = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=ca.RETENTION_DAYS + 1)
        ca.prune(api_app.get_db, now=future)
        expired = self.client.get(PREFIX + '/changes', headers=self.auth, params=params)
        self.assertEqual((expired.status_code, self.code(expired)), (409, 'cursorExpired'))


class ProviderMergeFixtureTests(unittest.TestCase):
    def test_merge_cases(self):
        for case in MERGE_FIXTURE['cases']:
            with self.subTest(case['name']):
                updates = ca.merge_provider(case['provider'], case['mode'], case['current'],
                                            case['previous'], case['fetched'])
                self.assertEqual(updates, case['expectedUpdates'])

    def test_year_from_date(self):
        for case in MERGE_FIXTURE['yearFromDate']:
            with self.subTest(case['input']):
                self.assertEqual(ca.year_from_date(case['input']), case['expected'])

    def test_values_normalization(self):
        for case in MERGE_FIXTURE['valuesNormalization']:
            with self.subTest(case['provider']):
                self.assertEqual(ca.normalize_provider_values(case['provider'], case['input']),
                                 case['expected'])
