"""Verification-only v2 baseline: disposable API database, no storage/network calls."""
import copy
import hashlib
import json
import sqlite3
import unittest
from pathlib import Path
from unittest import mock

from tests import test_collection_authority as fixtures
import collection_authority as ca
from tests.test_capture_api_stub import fake_s3


FIXTURES = Path(__file__).resolve().parents[3] / 'tests/fixtures/collection-authority'
api_app, AUTH, LIBRARY, PREFIX = fixtures.api_app, fixtures.AUTH, fixtures.LIBRARY, fixtures.PREFIX


class CollectionAuthorityVerifyTests(unittest.TestCase):
    tearDown = fixtures.CollectionAuthorityTests.tearDown
    confirm = fixtures.CollectionAuthorityTests.confirm
    status = fixtures.CollectionAuthorityTests.status
    ok = fixtures.CollectionAuthorityTests.ok

    def setUp(self):
        fixtures.CollectionAuthorityTests.setUp(self)
        self.doc = json.loads((FIXTURES / 'staging-v2-example.json').read_text('utf-8'))
        self.legacy = json.loads((FIXTURES / 'legacy-v2-example.json').read_text('utf-8'))
        for art in self.doc['artworks']:
            self.confirm(art['original'], art['thumbnail'])
        for person in self.doc['people']:
            if person['portraitImage']:
                self.confirm(person['portraitImage'])
        result = self.client.put('/v1/collections/replica', headers=self.publisher, json=self.legacy)
        self.doc['legacyRevision'] = self.ok(result)['revision']

    def verify(self, doc=None):
        return self.client.post(PREFIX + '/staging/verify', headers=self.publisher,
                                json=self.doc if doc is None else doc)

    def report(self, doc=None):
        result = self.verify(doc)
        self.assertEqual(result.status_code, 200, result.text)
        return result.json()

    def test_example_is_lossless_in_both_public_views_and_people(self):
        parsed = ca.parse_staging(self.doc, verify=True)
        self.assertEqual(parsed['stagingVersion'], 2)
        self.assertEqual({w['type'] for w in parsed['works']}, {'av', 'manga', 'game'})
        with mock.patch.object(fake_s3, 'head_object', side_effect=AssertionError('No storage calls')):
            report = self.report()
        self.assertEqual(report['verdict'], 'lossless', report)
        self.assertIsNone(report['validation'])
        self.assertTrue(all(binding['ok'] for binding in report['bindings'].values()))
        self.assertEqual(report['works'], dict(live=3, staged=3, matched=3, missing=[], unknown=[], typeMismatch=[]))
        self.assertEqual(report['diffs'], dict(total=0, byPath={}, samples=[]))
        self.assertEqual(report['people'], dict(live=2, staged=2, diffs=0, samples=[]))
        self.assertEqual(report['artworks'], dict(originalMissing=0, unconfirmedBlobs=0, samples=[]))
        self.assertEqual(report['counts']['people'], {'staged': 2})
        self.assertEqual(report['counts']['artworks'], {'staged': 6})
        self.assertFalse(self.client.get(PREFIX + '/status', headers=self.auth).json()['active'])
        self.assertIsNone(self.client.get(PREFIX + '/staging', headers=self.publisher).json()['staged'])

    def test_v2_activation_reuses_insertion_and_preserves_served_payloads(self):
        before = self.client.get('/v1/collections', headers=AUTH).json()['items']
        details = {w['workId']: self.client.get('/v1/collections/' + w['workId'], headers=AUTH).json()['item']
                   for w in self.doc['works']}
        people = {p['personId']: self.client.get('/v1/collections/people/' + p['personId'], headers=AUTH).json()
                  for p in self.doc['people']}
        staged = self.ok(self.client.put(PREFIX + '/staging', headers=self.publisher, json=self.doc))
        self.ok(self.client.post(PREFIX + '/activate', headers=self.publisher,
                                 json={'libraryId': LIBRARY, 'expectedStagedDigest': staged['stagedDigest']}))
        self.assertEqual(self.client.get('/v1/collections', headers=AUTH).json()['items'], before)
        for work_id, expected in details.items():
            self.assertEqual(self.client.get('/v1/collections/' + work_id, headers=AUTH).json()['item'], expected)
        for person_id, expected in people.items():
            self.assertEqual(self.client.get('/v1/collections/people/' + person_id, headers=AUTH).json(), expected)
        with api_app.get_db() as db:
            stored = dict(db.execute('SELECT artwork_id,selected FROM collection_authority_artworks'))
        self.assertEqual(stored, {art['artworkId']: int(art['selected']) for art in self.doc['artworks']})

    def test_selected_back_cover_and_explicit_false_survive_verify_and_activation(self):
        front = self.doc['artworks'][0]
        self.assertEqual(front['artworkId'], 'av-cover')
        front['selected'] = False  # Explicit false wins even when the work slot points here.
        back = {**copy.deepcopy(front), 'artworkId': 'av-back', 'kind': 'back',
                'providerImageId': 'av-back', 'selected': True, 'order': 1}
        self.doc['artworks'].append(back)
        legacy = copy.deepcopy(self.legacy)
        legacy['baseRevision'] = self.doc['legacyRevision']
        av = next(work for work in legacy['collections'] if work['id'] == 'av-work')
        av['artworks'][0]['selected'] = False
        av['artworks'].append({**copy.deepcopy(av['artworks'][0]), 'id': 'av-back',
                               'kind': 'back', 'selected': True})
        self.doc['legacyRevision'] = self.ok(self.client.put(
            '/v1/collections/replica', headers=self.publisher, json=legacy))['revision']
        self.assertEqual(self.report()['verdict'], 'lossless')
        staged = self.ok(self.client.put(PREFIX + '/staging', headers=self.publisher, json=self.doc))
        self.ok(self.client.post(PREFIX + '/activate', headers=self.publisher,
                                json={'libraryId': LIBRARY, 'expectedStagedDigest': staged['stagedDigest']}))
        item = self.client.get('/v1/collections/av-work', headers=AUTH).json()['item']
        self.assertEqual(item['selectedWorkArtworkId'], 'av-cover')
        self.assertEqual({art['id']: art['selected'] for art in item['artworks']},
                         {'av-cover': False, 'av-back': True})
        with api_app.get_db() as db:
            stored = dict(db.execute('SELECT artwork_id,selected FROM collection_authority_artworks'
                                     " WHERE work_id='av-work'"))
        self.assertEqual(stored, {'av-cover': 0, 'av-back': 1})

    def test_selected_is_required_boolean_in_v2_and_forbidden_in_v1(self):
        for verify in (False, True):
            for invalid in (None, 0, 1, 'true', [], {}):
                with self.subTest(verify=verify, invalid=invalid):
                    doc = copy.deepcopy(self.doc)
                    doc['artworks'][0]['selected'] = invalid
                    with self.assertRaises(ca.HTTPException) as caught:
                        ca.parse_staging(doc, verify=verify)
                    self.assertEqual(caught.exception.status_code, 422)
            for mutation in ('missing', 'extra'):
                with self.subTest(verify=verify, mutation=mutation):
                    doc = copy.deepcopy(self.doc)
                    if mutation == 'missing':
                        del doc['artworks'][0]['selected']
                    else:
                        doc['artworks'][0]['unexpected'] = True
                    with self.assertRaises(ca.HTTPException) as caught:
                        ca.parse_staging(doc, verify=verify)
                    self.assertEqual(caught.exception.status_code, 422)
        v1 = fixtures.CollectionAuthorityTests.baseline(self)
        ca.parse_staging(v1)
        v1['artworks'][0]['selected'] = True
        with self.assertRaises(ca.HTTPException) as caught:
            ca.parse_staging(v1)
        self.assertEqual(caught.exception.status_code, 422)

    def test_v1_artwork_stays_nullable_and_uses_slot_selection(self):
        doc = ca.parse_staging(fixtures.CollectionAuthorityTests.baseline(self))
        with api_app.get_db() as db:
            ca.insert_staging(db, doc, ca.now_iso())
            self.assertIsNone(db.execute('SELECT selected FROM collection_authority_artworks').fetchone()[0])
            row = db.execute("SELECT * FROM collection_authority_works WHERE work_id='a'").fetchone()
            self.assertTrue(ca.build_payload(db, LIBRARY, row)['artworks'][0]['selected'])
            db.execute("UPDATE collection_authority_works SET selection=? WHERE work_id='a'",
                       [json.dumps(dict.fromkeys(ca.SLOTS))])
            row = db.execute("SELECT * FROM collection_authority_works WHERE work_id='a'").fetchone()
            self.assertFalse(ca.build_payload(db, LIBRARY, row)['artworks'][0]['selected'])

    def test_stale_legacy_revision_is_blocked(self):
        self.doc['legacyRevision'] = 'f' * 64
        report = self.report()
        self.assertEqual(report['verdict'], 'blocked')
        self.assertFalse(report['bindings']['legacyRevision']['ok'])

    def test_personal_edit_cursor_requires_both_last_and_applied(self):
        for staged, last, applied in ((1, 0, 0), (0, 1, 0), (1, 1, 0)):
            with self.subTest(staged=staged, last=last, applied=applied):
                self.doc['personalEditCursor'] = staged
                with api_app.get_db() as db:
                    db.execute('UPDATE mobile_collection_edit_state SET last_sequence=?,applied_cursor=?', (last, applied))
                    db.commit()
                report = self.report()
                self.assertEqual(report['verdict'], 'blocked')
                self.assertEqual(report['bindings']['personalEdits'],
                                 dict(staged=staged, last=last, applied=applied, ok=False))

    def test_pending_bind_request_blocks_even_at_matching_sequence(self):
        with api_app.get_db() as db:
            db.execute('UPDATE collection_binding_state SET sequence=1')
            db.execute("INSERT INTO collection_binding_requests(sequence,operation_id,payload_digest,"
                       "collection_id,provider,choice_json,state,created_at,updated_at)"
                       " VALUES(1,'request','digest','manga-work','kakao','{}','pending','t','t')")
            db.commit()
        self.doc['bindingRequestSequence'] = 1
        report = self.report()
        self.assertEqual(report['verdict'], 'blocked')
        self.assertEqual(report['bindings']['bindRequests'], dict(staged=1, server=1, pending=1, ok=False))

    def test_binding_sequence_mismatch_blocks_without_pending_requests(self):
        self.doc['bindingRequestSequence'] = 1
        report = self.report()
        self.assertEqual(report['verdict'], 'blocked')
        self.assertFalse(report['bindings']['bindRequests']['ok'])

    def test_release_read_cursor_and_generation_are_independent_barriers(self):
        for key, binding in (('releaseReadCursor', 'releaseReads'), ('releaseGeneration', 'releaseGeneration')):
            with self.subTest(key=key):
                doc = copy.deepcopy(self.doc)
                doc[key] = 1
                report = self.report(doc)
                self.assertEqual(report['verdict'], 'blocked')
                self.assertEqual(report['bindings'][binding], dict(staged=1, server=0, ok=False))

    def test_focus_difference_and_missing_original_are_differences_not_validation(self):
        self.doc['volumes'][0]['coverFocusX'] = .12
        self.doc['artworks'][0]['original'] = None
        report = self.report()
        self.assertEqual(report['verdict'], 'differences', report)
        self.assertIsNone(report['validation'])
        self.assertEqual(report['diffs']['byPath']['volumes[].coverFocusX'], 1)
        self.assertEqual(report['artworks']['originalMissing'], 1)
        self.assertEqual(report['artworks']['samples'], ['av-cover'])
        self.assertEqual({sample['view'] for sample in report['diffs']['samples']}, {'list', 'detail'})
        for sample in report['diffs']['samples']:
            self.assertEqual(set(sample), {'workId', 'view', 'path', 'liveDigest', 'projectedDigest'})
            self.assertRegex(sample['liveDigest'], r'^[0-9a-f]{16}$')
            self.assertRegex(sample['projectedDigest'], r'^[0-9a-f]{16}$')
        text = json.dumps(report)
        self.assertNotIn('Personal screening note', text)
        self.assertNotIn('Follow future performances', text)
        self.assertEqual(self.client.put(PREFIX + '/staging', headers=self.publisher, json=self.doc).status_code, 422)

    def test_missing_receipts_include_portraits_without_storage_checks(self):
        sha = self.doc['people'][0]['portraitImage']['sha256']
        with api_app.get_db() as db:
            db.execute('DELETE FROM mobile_collection_artwork WHERE sha256=?', [sha])
            db.commit()
        with mock.patch.object(fake_s3, 'head_object', side_effect=AssertionError('No storage calls')):
            report = self.report()
        self.assertEqual(report['verdict'], 'differences')
        self.assertIsNone(report['validation'])
        self.assertEqual(report['artworks']['unconfirmedBlobs'], 1)
        self.assertEqual(report['diffs']['total'], 0)
        reply = self.client.put(PREFIX + '/staging', headers=self.publisher, json=self.doc)
        self.assertEqual(reply.status_code, 409)

    def test_people_differences_only_return_ids_paths_and_digests(self):
        self.doc['people'][0]['memo'] = 'Private replacement memo'
        report = self.report()
        self.assertEqual(report['verdict'], 'differences')
        self.assertEqual(report['people']['diffs'], 1)
        sample = report['people']['samples'][0]
        self.assertEqual(sample['path'], 'person.memo')
        self.assertEqual(set(sample), {'personId', 'path', 'liveDigest', 'projectedDigest'})
        self.assertNotIn('Private replacement memo', json.dumps(report))

    def test_diff_samples_are_bounded_but_totals_include_every_difference(self):
        for work in self.doc['works']:
            for field in ('description', 'originalTitle', 'author', 'director', 'developer', 'publisher',
                          'platforms', 'productionCompany', 'releaseDate', 'genres', 'overview'):
                work['fields'][field] = 'Private changed value'
        report = self.report()
        self.assertEqual(report['verdict'], 'differences')
        self.assertGreater(report['diffs']['total'], 20)
        self.assertEqual(len(report['diffs']['samples']), 20)
        self.assertEqual(sum(report['diffs']['byPath'].values()), report['diffs']['total'])
        self.assertNotIn('Private changed value', json.dumps(report))

    def test_published_volume_values_override_fallback_even_when_explicitly_null(self):
        # A publication can deliberately carry no status. Do not recompute it from
        # a past release date, or substitute source metadata for explicit nulls.
        doc = copy.deepcopy(self.doc)
        volume = doc['volumes'][0]
        volume['published'].update(releaseStatus=None, localReleaseDate='2020-01-01', isbn13=None)
        legacy = copy.deepcopy(self.legacy)
        legacy['baseRevision'] = self.doc['legacyRevision']
        manga = next(w for w in legacy['collections'] if w['id'] == 'manga-work')
        manga['volumes'][0].update(volume['published'])
        doc['legacyRevision'] = self.ok(self.client.put('/v1/collections/replica', headers=self.publisher,
                                                        json=legacy))['revision']
        self.assertEqual(self.report(doc)['verdict'], 'lossless')
        doc['volumes'][0]['published'] = None
        report = self.report(doc)
        self.assertEqual(report['verdict'], 'differences')
        self.assertIn('volumes[].localReleaseDate', report['diffs']['byPath'])

    def test_staged_scores_preserve_the_replica_finite_number_domain(self):
        for value in (None, -1, 4.25, 12, 1e30):
            with self.subTest(score=value):
                doc = copy.deepcopy(self.doc)
                doc['works'][0]['fields']['myScore'] = value
                parsed = ca.parse_staging(doc, verify=True)
                self.assertEqual(next(w for w in parsed['works'] if w['workId'] == 'av-work')['fields']['myScore'], value)

    def test_server_derived_asset_counts_are_compared_without_masking(self):
        self.doc['memberships'] = []
        report = self.report()
        self.assertEqual(report['verdict'], 'differences')
        self.assertEqual(report['diffs']['byPath']['assetCount'], 4)
        self.assertEqual(report['diffs']['byPath']['coverAssetId'], 4)

    def test_missing_unknown_and_type_mismatch_are_reported_as_differences(self):
        for mode in ('missing', 'unknown', 'typeMismatch'):
            with self.subTest(mode=mode):
                doc = copy.deepcopy(self.doc)
                if mode == 'missing':
                    doc['works'] = [w for w in doc['works'] if w['workId'] != 'game-work']
                    doc['artworks'] = [a for a in doc['artworks'] if a['workId'] != 'game-work']
                    doc['memberships'] = [m for m in doc['memberships'] if m['workId'] != 'game-work']
                else:
                    game = next(w for w in doc['works'] if w['workId'] == 'game-work')
                    if mode == 'unknown':
                        extra = copy.deepcopy(game)
                        extra.update(workId='unknown', name='Other game')
                        extra['selection'] = dict.fromkeys(extra['selection'])
                        extra['fields']['coverAssetId'] = None
                        doc['works'].append(extra)
                    else:
                        game['type'] = 'movie'
                        game['fields'].update(status=None, ownedPlatform=None)
                report = self.report(doc)
                self.assertEqual(report['verdict'], 'differences', report)
                self.assertEqual(report['works'][mode], ['unknown' if mode == 'unknown' else 'game-work'])

    def test_invalid_documents_are_blocked_and_do_not_echo_input(self):
        mutations = [lambda d: d.update(extra='secret'),
                     lambda d: d['works'][0]['fields'].update(status='secret'),
                     lambda d: d['works'][0]['fields'].update(ownedPlatform='secret'),
                     lambda d: d['works'][0]['avCredits'][0]['portraitCrop'].update(artworkId='game-cover'),
                     lambda d: d['people'].append(copy.deepcopy(d['people'][0])),
                     lambda d: d['people'][0]['portraitImage'].update(sizeBytes=True),
                     lambda d: d['volumes'][0].update(coverFocusX=1.1),
                     lambda d: d['artworks'][1].update(order=True),
                     lambda d: d['works'][0]['fields'].update(myScore=True)]
        for index, mutate in enumerate(mutations):
            with self.subTest(index=index):
                doc = copy.deepcopy(self.doc)
                mutate(doc)
                report = self.report(doc)
                self.assertEqual(report['verdict'], 'blocked', report)
                self.assertIsNotNone(report['validation'])
                self.assertNotIn('secret', json.dumps(report))

    def test_auth_json_shape_and_size_status_codes(self):
        for headers in ({}, AUTH, self.auth):
            self.assertEqual(self.client.post(PREFIX + '/staging/verify', headers=headers, json={}).status_code, 401)
        for body in ('not json', '[]', 'null', '2', '"text"'):
            reply = self.client.post(PREFIX + '/staging/verify', headers=self.publisher, content=body)
            self.assertEqual(reply.status_code, 422, reply.text)
        self.assertEqual(self.report({})['verdict'], 'blocked')
        with mock.patch.object(ca, 'MAX_STAGING_BYTES', 32):
            self.assertEqual(self.verify().status_code, 413)

    def test_verify_uses_only_typed_temp_tables_and_cleans_up_between_requests(self):
        original_insert = ca.insert_staging
        original_verify = ca.verify_staging
        calls = []

        def inspect_insert(db, doc, now):
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_temp_master WHERE type='table'")}
            self.assertEqual(tables, set(ca.TYPED_TABLES))
            original_insert(db, doc, now)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM temp.collection_authority_works').fetchone()[0],
                             len(doc['works']))
            self.assertEqual(db.execute('SELECT COUNT(*) FROM main.collection_authority_works').fetchone()[0], 0)
            calls.append(now)

        def inspect_verify(db, body, now):
            # A whole-database backup must never return, even if its result matches.
            guarded = mock.Mock(wraps=db)
            guarded.backup.side_effect = AssertionError('Verification must not back up the database')
            result = original_verify(guarded, body, now)
            self.assertFalse(db.in_transaction)
            self.assertEqual(db.execute("SELECT name FROM sqlite_temp_master WHERE type='table'").fetchall(), [])
            return result

        with mock.patch.object(ca, 'insert_staging', side_effect=inspect_insert), \
                mock.patch.object(ca, 'verify_staging', side_effect=inspect_verify):
            for _ in range(2):
                self.assertEqual(self.report()['verdict'], 'lossless')
        self.assertEqual(len(calls), 2)
        with api_app.get_db() as db:
            self.assertEqual(db.execute("SELECT name FROM sqlite_temp_master WHERE type='table'").fetchall(), [])
        self.assertFalse(self.client.get(PREFIX + '/status', headers=self.auth).json()['active'])

    def test_verify_rejects_main_writes_including_explicit_authority_writes(self):
        original_insert = ca.insert_staging
        checked = []

        def try_main_writes(db, doc, now):
            for statement in (
                    'UPDATE main.mobile_collection_edit_state SET last_sequence=last_sequence+1',
                    'DELETE FROM main.collection_authority_works',
                    'CREATE TABLE main.verify_must_not_exist(value)'):
                with self.assertRaisesRegex(sqlite3.DatabaseError, 'not authorized'):
                    db.execute(statement)
                checked.append(statement)
            original_insert(db, doc, now)

        with mock.patch.object(ca, 'insert_staging', side_effect=try_main_writes):
            self.assertEqual(self.report()['verdict'], 'lossless')
        self.assertEqual(len(checked), 3)

    def test_projection_exception_rolls_back_temp_schema_and_rows(self):
        with api_app.get_db() as db:
            db.execute('BEGIN')
            with mock.patch.object(ca, 'build_payload', side_effect=RuntimeError('projection failed')):
                with self.assertRaisesRegex(RuntimeError, 'projection failed'):
                    ca.verify_staging(db, self.doc, ca.now_iso())
            self.assertFalse(db.in_transaction)
            self.assertEqual(db.execute("SELECT name FROM sqlite_temp_master WHERE type='table'").fetchall(), [])
            self.assertEqual(db.execute('SELECT COUNT(*) FROM main.collection_authority_works').fetchone()[0], 0)
        self.assertEqual(self.report()['verdict'], 'lossless')

    def test_bindings_and_comparison_keep_one_snapshot_during_concurrent_publish(self):
        with api_app.get_db() as db:
            self.assertEqual(db.execute('PRAGMA journal_mode=WAL').fetchone()[0], 'wal')
        original_bindings = ca.verification_bindings
        observed = []

        def publish_after_bindings(db, body):
            bindings = original_bindings(db, body)
            with api_app.get_db() as writer:
                row = writer.execute('SELECT id,payload FROM mobile_collections ORDER BY id LIMIT 1').fetchone()
                payload = json.loads(row['payload'])
                payload['description'] = 'Concurrent publication'
                writer.execute('UPDATE mobile_collections SET payload=? WHERE id=?',
                               (json.dumps(payload), row['id']))
                writer.execute('UPDATE collection_release_state SET generation=COALESCE(generation,0)+1')
                writer.commit()
            observed.append(bindings)
            return bindings

        with mock.patch.object(ca, 'verification_bindings', side_effect=publish_after_bindings):
            report = self.report()
        self.assertEqual(len(observed), 1)
        self.assertEqual(report['verdict'], 'lossless', report)
        self.assertEqual(report['bindings']['releaseGeneration']['server'], 0)
        next_report = self.report()
        self.assertEqual(next_report['verdict'], 'blocked')
        self.assertEqual(next_report['bindings']['releaseGeneration']['server'], 1)
        self.assertGreater(next_report['diffs']['total'], 0)

    def test_verify_cannot_modify_any_persistent_table_or_database_file(self):
        # Include an already stored baseline: verify must not replace or clear it.
        self.ok(self.client.put(PREFIX + '/staging', headers=self.publisher, json=self.doc))
        with api_app.get_db() as observer:
            def snapshot():
                tables = [r[0] for r in observer.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
                rows = {}
                for table in tables:
                    quoted = '"' + table.replace('"', '""') + '"'
                    values = [tuple(row) for row in observer.execute('SELECT * FROM ' + quoted)]
                    rows[table] = (len(values), sorted(map(repr, values)))
                return observer.execute('PRAGMA data_version').fetchone()[0], rows

            before = snapshot()
            file_digest = hashlib.sha256(api_app.DB_PATH.read_bytes()).hexdigest()
            file_mtime = api_app.DB_PATH.stat().st_mtime_ns
            for mode in ('lossless', 'differences', 'blocked', 'invalid'):
                doc = copy.deepcopy(self.doc)
                if mode == 'differences':
                    doc['volumes'][0]['coverFocusX'] = .1
                elif mode == 'blocked':
                    doc['legacyRevision'] = 'f' * 64
                elif mode == 'invalid':
                    doc['works'][0]['avCredits'] = 'invalid'
                self.assertEqual(self.report(doc)['verdict'], 'blocked' if mode == 'invalid' else mode)
                self.assertEqual(snapshot(), before)
                self.assertEqual(hashlib.sha256(api_app.DB_PATH.read_bytes()).hexdigest(), file_digest)
                self.assertEqual(api_app.DB_PATH.stat().st_mtime_ns, file_mtime)


class CollectionAuthorityInteropTests(unittest.TestCase):
    def test_pc_generated_v2_parses_in_both_modes_with_exact_section_keys(self):
        doc = json.loads((FIXTURES / 'pc-staging-v2-generated.json').read_text('utf-8'))
        sections = {
            'works': {'workId', 'type', 'legacyKind', 'name', 'fields', 'showcase',
                      'showcaseOrder', 'selection', 'details', 'derived', 'avCredits',
                      'createdAt', 'updatedAt'},
            'bindings': {'workId', 'provider', 'externalId', 'config', 'snapshot', 'values', 'lastSyncedAt'},
            'artworks': {'artworkId', 'workId', 'kind', 'selected', 'provider', 'providerImageId',
                         'width', 'height', 'language', 'original', 'thumbnail', 'createdAt', 'order'},
            'volumes': {'volumeId', 'workId', 'volumeNumber', 'editionIndex', 'sortOrder', 'order',
                        'displayLabel', 'coverArtworkId', 'sourceProvider', 'sourceCoverId',
                        'coverFocusX', 'published'},
            'volumeSources': {'workId', 'volumeNumber', 'provider', 'providerItemId', 'title',
                              'author', 'publisher', 'isbn13', 'publicationDate', 'itemUrl', 'data'},
            'ownership': {'workId', 'volumeNumber', 'editionIndex', 'physical', 'digital'},
            'memberships': {'workId', 'assetId', 'addedAt'},
            'people': {'personId', 'memo', 'favorite', 'profile', 'portrait', 'portraitImage'},
        }
        fields = {'description', 'coverAssetId', 'year', 'originalTitle', 'runtimeMinutes', 'author',
                  'director', 'developer', 'publisher', 'platforms', 'productionCompany', 'releaseDate',
                  'externalScore', 'myScore', 'genres', 'overview', 'status', 'ownedPlatform'}
        for verify in (False, True):
            with self.subTest(verify=verify):
                parsed = ca.parse_staging(doc, verify=verify)
                for value in (doc, parsed):
                    self.assertEqual(set(value), set(sections) | {
                        'stagingVersion', 'libraryId', 'personalEditCursor', 'legacyRevision',
                        'bindingRequestSequence', 'releaseReadCursor', 'releaseGeneration'})
                    for section, expected in sections.items():
                        self.assertTrue(value[section], section)
                        for row in value[section]:
                            self.assertEqual(set(row), expected, section)
                    for work in value['works']:
                        self.assertEqual(set(work['fields']), fields)
                        self.assertEqual(set(work['selection']), {'work', 'hero', 'backdrop', 'spine'})
                        self.assertEqual(set(work['details']), {'series', 'film', 'av'})
                        self.assertEqual(set(work['derived']), {
                            'unreadReleaseCount', 'releaseWatch', 'ownedVolumes', 'releaseSchedule'})
                        if work['details']['av'] is not None:
                            self.assertEqual(set(work['details']['av']), {
                                'productCode', 'titleJa', 'maker', 'label', 'series', 'genres', 'releaseDate'})
                        for credit in work['avCredits']:
                            self.assertEqual(set(credit), {
                                'personId', 'name', 'nameJa', 'role', 'order', 'portraitCrop'})
                            if credit['portraitCrop'] is not None:
                                self.assertEqual(set(credit['portraitCrop']), {'artworkId', 'x', 'y', 'w', 'h'})
                    for volume in value['volumes']:
                        self.assertEqual(set(volume['published']), {'releaseStatus', 'localReleaseDate', 'isbn13'})
                    for art in value['artworks']:
                        self.assertIs(type(art['selected']), bool)
                        for manifest in (art['original'], art['thumbnail']):
                            if manifest is not None:
                                self.assertEqual(set(manifest), {'sha256', 'sizeBytes', 'contentType'} |
                                                 ({'objectKey'} if value is doc else set()))
                    for person in value['people']:
                        if person['portraitImage'] is not None:
                            self.assertEqual(set(person['portraitImage']), {
                                'sha256', 'sizeBytes', 'contentType', 'width', 'height'})
                works = {work['workId']: work for work in parsed['works']}
                self.assertEqual({work['type'] for work in works.values()}, {'game', 'manga', 'movie', 'av'})
                self.assertEqual(works['g']['selection']['spine'], 'spine')
                self.assertIsNotNone(works['film']['details']['film'])
                self.assertIsNotNone(works['tv']['details']['series'])
                self.assertTrue(works['m']['derived']['releaseWatch']['enabled'])
                self.assertEqual(works['m']['derived']['ownedVolumes'][0]['count'], 1)
                self.assertTrue(works['m']['derived']['releaseSchedule']['kakao']['volumes'])
                self.assertEqual(next(v for v in parsed['volumes'] if v['volumeId'] == 'v')['coverFocusX'], .25)
                self.assertEqual(works['av']['avCredits'][0]['portraitCrop']['artworkId'], 'front')
                self.assertIsNotNone(next(p for p in parsed['people'] if p['personId'] == 'portrait')['portraitImage'])
                back = next(art for art in parsed['artworks'] if art['artworkId'] == 'back')
                self.assertEqual((back['kind'], back['selected']), ('back', True))
                self.assertNotIn('back', works['av']['selection'].values())
                self.assertEqual({a['artworkId']: a['selected'] for a in parsed['artworks']},
                                 {a['artworkId']: a['selected'] for a in doc['artworks']})


class CollectionAuthoritySchemaTests(unittest.TestCase):
    def test_verification_temp_schema_preserves_columns_constraints_and_indexes(self):
        with sqlite3.connect(':memory:') as db:
            self.addCleanup(db.close)
            db.executescript(ca.DDL)
            db.execute('BEGIN')
            db.set_authorizer(ca._verification_authorizer)
            ca._create_verification_tables(db)
            self.assertTrue(db.in_transaction)
            for table in ca.TYPED_TABLES:
                with self.subTest(table=table):
                    for pragma in ('table_info', 'index_list'):
                        self.assertEqual(db.execute(f'PRAGMA temp.{pragma}({table})').fetchall(),
                                         db.execute(f'PRAGMA main.{pragma}({table})').fetchall())
                    # SQLite normalizes CREATE TEMP TABLE to CREATE TABLE in its
                    # schema; compare the entire definition, including CHECKs.
                    query = 'SELECT type,name,sql FROM {} WHERE tbl_name=? ORDER BY type,name'
                    self.assertEqual(db.execute(query.format('sqlite_temp_master'), [table]).fetchall(),
                                     db.execute(query.format('sqlite_master'), [table]).fetchall())
            db.rollback()
            self.assertEqual(db.execute("SELECT name FROM sqlite_temp_master WHERE type='table'").fetchall(), [])

    def old_database(self):
        db = sqlite3.connect(':memory:')
        db.row_factory = sqlite3.Row
        self.addCleanup(db.close)
        ddl = ca.DDL.replace("'game','manga','movie','av'", "'game','manga','movie'")
        for column in (" av_credits TEXT NOT NULL DEFAULT '[]',\n", ' published_order INTEGER,\n',
                       ' cover_focus_x REAL,\n', ' published TEXT,\n',
                       ' selected INTEGER CHECK(selected IN (0,1)),\n'):
            ddl = ddl.replace(column, '')
        db.executescript(ddl)
        return db

    def test_empty_legacy_table_is_upgraded_once(self):
        db = self.old_database()
        ca.startup_db(db)
        ca.startup_db(db)
        sql = db.execute("SELECT sql FROM sqlite_master WHERE name='collection_authority_works'").fetchone()[0]
        self.assertIn("'av'", sql)
        for table, required in (('works', {'av_credits'}), ('artworks', {'published_order', 'selected'}),
                                ('volumes', {'cover_focus_x', 'published', 'published_order'})):
            self.assertTrue(required <= {r[1] for r in db.execute('PRAGMA table_info(collection_authority_' + table + ')')})
        self.assertEqual(db.execute('SELECT COUNT(*) FROM collection_authority_works').fetchone()[0], 0)

    def test_selected_upgrade_preserves_existing_rows_as_null(self):
        db = sqlite3.connect(':memory:')
        self.addCleanup(db.close)
        db.executescript(ca.DDL.replace(' selected INTEGER CHECK(selected IN (0,1)),\n', ''))
        db.execute("INSERT INTO collection_authority_artworks"
                   "(library_id,artwork_id,work_id,kind,original,created_at)"
                   " VALUES(?,'kept','work','back','null','t')", [LIBRARY])
        before = db.execute('SELECT * FROM collection_authority_artworks').fetchone()
        ca.startup_db(db)
        ca.startup_db(db)
        after = db.execute('SELECT * FROM collection_authority_artworks').fetchone()
        self.assertEqual(after, (*before, None))

    def test_nonempty_legacy_table_fails_closed_without_schema_or_row_changes(self):
        db = self.old_database()
        db.execute("INSERT INTO collection_authority_works(library_id,work_id,type,name,fields,showcase,selection,"
                   "details,derived,lifecycle,entity_revision,created_at,updated_at)"
                   " VALUES(?,'kept','game','Kept','{}',0,'{}','{}','{}','live',1,'t','t')", [LIBRARY])
        db.commit()
        before = list(db.iterdump())
        with self.assertRaisesRegex(RuntimeError, 'empty works table'):
            ca.startup_db(db)
        self.assertEqual(list(db.iterdump()), before)


if __name__ == '__main__':
    unittest.main()
