"""Mobile similarity review: PC pair feed, mobile decisions, overlay and adoption."""
import copy
import hashlib
import json
import unittest
import uuid
from pathlib import Path
from unittest import mock

from tests import test_character_exclusions as base
from tests import test_mobile_characters as fixtures

api_app, AUTH, LIBRARY = fixtures.api_app, fixtures.AUTH, base.LIBRARY
REVIEW = '/v1/library/similarity/review'
FIXTURE = Path(__file__).resolve().parents[3] / 'tests/fixtures/mobile-similarity-review-feed.json'
SHA = 'a' * 64


def feed_fixture():
    return json.loads(FIXTURE.read_text(encoding='utf-8'))


class SimilarityReviewTests(unittest.TestCase):
    asset = fixtures.MobileCharactersTests.asset
    tearDown = fixtures.MobileCharactersTests.tearDown

    def setUp(self):
        base.CharacterExclusionTests.setUp(self)
        for id in ('s1', 's2', 's3', 's4', 'other'):
            self.asset(id)
        with api_app.get_db() as db:
            db.execute("UPDATE assets SET sha256=?", (SHA,))
            db.commit()

    def put_feed(self, body, headers=None):
        return self.client.put(REVIEW + '/feed', headers=self.publisher if headers is None else headers, json=body)

    def adopt(self):
        reply = self.put_feed(feed_fixture())
        self.assertEqual(reply.status_code, 200, reply.text)
        return reply.json()['revision']

    def read(self, **params):
        reply = self.client.get(REVIEW, headers=self.auth, params=params)
        self.assertEqual(reply.status_code, 200, reply.text)
        return reply.json()

    def reviews(self):
        return [i['reviewId'] for i in self.read()['items']]

    def command(self, review='r1', decision='keep_existing', revision=None, a_sha=SHA, b_sha=SHA):
        return {'version': 1, 'libraryId': LIBRARY, 'operationId': str(uuid.uuid4()), 'reviewId': review,
                'decision': decision,
                'basis': {'feedRevision': revision or self.read()['revision'], 'aSha256': a_sha, 'bSha256': b_sha}}

    def decide(self, body):
        return self.client.post(REVIEW + '/decisions', headers=self.auth, json=body)

    def log(self, **params):
        return self.client.get(REVIEW + '/decisions', headers=self.publisher, params={'libraryId': LIBRARY, **params})

    def code(self, reply):
        return reply.json()['detail']['code']

    def republish(self, cursor, skipped=(), items=None):
        body = feed_fixture()
        body.update(baseRevision=self.read()['revision'], decisionCursor=cursor, skipped=list(skipped))
        if items is not None:
            body['items'] = items
        return self.put_feed(body)

    def test_inactive_until_adoption_and_roles(self):
        page = self.read()
        self.assertFalse(page['ready'])
        self.assertEqual(page['counts'], {'open': 0, 'pendingPc': 0, 'skipped': 0})
        body = {'version': 1, 'libraryId': LIBRARY, 'operationId': str(uuid.uuid4()), 'reviewId': 'r1',
                'decision': 'keep_both', 'basis': {'feedRevision': 'f' * 64, 'aSha256': SHA, 'bSha256': SHA}}
        self.assertEqual(self.code(self.decide(body)), 'similarityReviewUnsupported')
        # The PC's probe: an upgraded server answers the log route before adoption.
        self.assertEqual(self.log().json()['items'], [])
        for headers in ({}, AUTH, self.auth):
            self.assertEqual(self.client.get(REVIEW + '/decisions', headers=headers,
                                             params={'libraryId': LIBRARY}).status_code, 401)
            self.assertEqual(self.put_feed(feed_fixture(), headers=headers).status_code, 401)
        self.assertEqual(self.client.get(REVIEW).status_code, 401)
        self.assertEqual(self.client.post(REVIEW + '/decisions', json=body).status_code, 401)
        self.assertFalse(self.read()['ready'])

    def test_adoption_keeps_committed_matching_pairs_and_hydrates(self):
        revision = self.adopt()
        page = self.read()
        self.assertTrue(page['ready'])
        self.assertEqual((page['revision'], page['libraryId']), (revision, LIBRARY))
        # r4 names an Asset the server lacks and r5 a sha256 that does not match: both dropped.
        self.assertEqual([i['reviewId'] for i in page['items']], ['r1', 'r2', 'r3'])
        self.assertEqual(page['counts'], {'open': 3, 'pendingPc': 0, 'skipped': 0})
        first = page['items'][0]
        self.assertEqual((first['recommendedAssetId'], first['recommendation'], first['distance']), ('a', 'keep_existing', 3))
        self.assertEqual((first['a']['width'], first['a']['format'], first['a']['classifications']), (2400, 'PNG', ['원본', '캐릭터']))
        self.assertEqual((first['a']['asset']['id'], first['b']['asset']['id']), ('a', 's1'))
        self.assertEqual(first['b']['sha256'], SHA)
        self.assertNotIn('private/', json.dumps(page))
        head = self.read(limit=2)
        self.assertTrue(head['hasMore'])
        rest = self.read(limit=2, cursor=head['nextCursor'])
        self.assertEqual([i['reviewId'] for i in rest['items']], ['r3'])
        self.assertFalse(rest['hasMore'])
        self.assertEqual(self.client.get(REVIEW, headers=self.auth, params={'cursor': 'bad!'}).status_code, 400)
        self.assertEqual(self.client.get(REVIEW, headers=self.auth, params={'limit': 51}).status_code, 422)
        self.assertEqual(self.client.get(REVIEW, headers=self.auth, params={'debug': 1}).status_code, 422)
        # A newer publication invalidates an old walk instead of splicing two feeds.
        body = feed_fixture(); body.update(baseRevision=revision, generatedAt='2026-09-24T10:00:00Z')
        self.assertEqual(self.put_feed(body).status_code, 200)
        self.assertEqual(self.code(self.client.get(REVIEW, headers=self.auth, params={'cursor': head['nextCursor']})),
                         'similarityReviewChanged')

    def test_stale_feed_basis_rejects_decisions_even_when_pair_hashes_match(self):
        old = self.adopt()
        accepted_command = self.command(review='r3', decision='keep_both')
        accepted = self.decide(accepted_command)
        self.assertEqual(accepted.status_code, 200, accepted.text)
        feed = feed_fixture()
        feed.update(baseRevision=old, generatedAt='2026-09-25T00:00:00Z')
        published = self.put_feed(feed)
        self.assertEqual(published.status_code, 200, published.text)
        new = published.json()['revision']
        self.assertNotEqual(old, new)
        for decision in ('keep_existing', 'replace_existing', 'keep_both', 'withdrawn'):
            with self.subTest(decision=decision):
                reply = self.decide(self.command(review='r3' if decision == 'withdrawn' else 'r1',
                                                 decision=decision, revision=old))
                self.assertEqual(reply.status_code, 409, reply.text)
                self.assertEqual(self.code(reply), 'similarityReviewChanged')
        self.assertEqual(len(self.log().json()['items']), 1)
        # Idempotent receipts take precedence over basis freshness.
        self.assertEqual(self.decide(accepted_command).json(), accepted.json())
        self.assertEqual(self.decide(self.command(review='r1', decision='keep_both', revision=new)).status_code, 200)
        self.assertEqual(self.decide(self.command(review='r3', decision='withdrawn', revision=new)).status_code, 200)

    def test_atomic_replace_stale_base_validation_and_limits(self):
        revision = self.adopt()
        self.assertEqual(self.put_feed(feed_fixture()).json()['revision'], revision)  # Idempotent retry.
        changed = feed_fixture(); changed['items'] = changed['items'][:1]
        self.assertEqual(self.code(self.put_feed(changed)), 'similarityReviewFeedChanged')

        def variant(change):
            body = feed_fixture(); body['baseRevision'] = revision; change(body); return self.put_feed(body)
        for change in (lambda b: b['items'].append(copy.deepcopy(b['items'][0])),
                       lambda b: b['items'][0]['b'].update(assetId='a'),
                       lambda b: b['items'][0].update(recommendation='replace_existing'),
                       lambda b: b['items'][0].update(recommendedAssetId='other'),
                       lambda b: b['items'][0].update(recommendation=None),
                       lambda b: b['items'][0].update(kind='incoming'),
                       lambda b: b['items'][0]['a'].update(sha256='xyz'),
                       lambda b: b['items'][0].update(extra=1),
                       lambda b: b.update(skipped=[{'sequence': 1, 'reason': 'x'}] * 2)):
            self.assertEqual(variant(change).status_code, 422)
        with mock.patch('similarity_review.MAX_FEED_BYTES', 10):
            self.assertEqual(variant(lambda b: b.update(generatedAt='later')).status_code, 413)
        many = feed_fixture(); many['baseRevision'] = revision
        many['items'] = [{**many['items'][1], 'reviewId': f'x{i}'} for i in range(5001)]
        self.assertEqual(self.put_feed(many).status_code, 422)
        wrong = feed_fixture(); wrong.update(baseRevision=revision, libraryId='f' * 32)
        self.assertEqual(self.code(self.put_feed(wrong)), 'libraryMismatch')
        self.assertEqual(self.reviews(), ['r1', 'r2', 'r3'])
        replaced = feed_fixture(); replaced.update(baseRevision=revision, items=replaced['items'][2:3])
        self.assertEqual(self.put_feed(replaced).status_code, 200)
        self.assertEqual(self.reviews(), ['r3'])

    def test_overlay_hides_decided_pairs_and_pairs_with_pending_trash(self):
        self.adopt()
        receipt = self.decide(self.command('r1', 'keep_existing'))
        self.assertEqual(receipt.status_code, 200, receipt.text)
        body = receipt.json()
        self.assertEqual((body['sequence'], body['trashAssetId'], body['pendingPc'], body['withdraws']), (1, 's1', True, None))
        # r1 is decided; r2 holds s1, which r1 will trash. r3 is unaffected.
        page = self.read()
        self.assertEqual([i['reviewId'] for i in page['items']], ['r3'])
        self.assertEqual(page['counts'], {'open': 1, 'pendingPc': 1, 'skipped': 0})
        self.assertEqual(self.code(self.decide(self.command('r2', 'keep_both'))), 'similarityAssetPendingTrash')
        self.assertEqual(self.code(self.decide(self.command('r1', 'keep_both'))), 'pendingSimilarityDecision')
        # Decision 3: galleries are untouched until the PC applies it.
        with api_app.get_db() as db:
            self.assertIsNotNone(db.execute("SELECT 1 FROM visible_assets WHERE id='s1'").fetchone())
        # Withdrawn brings both pairs back; a second withdrawal has nothing left to undo.
        undo = self.decide(self.command('r1', 'withdrawn'))
        self.assertEqual(undo.status_code, 200, undo.text)
        self.assertEqual((undo.json()['withdraws'], undo.json()['trashAssetId']), (1, None))
        self.assertEqual(self.reviews(), ['r1', 'r2', 'r3'])
        self.assertEqual(self.read()['counts']['pendingPc'], 0)
        self.assertEqual(self.code(self.decide(self.command('r1', 'withdrawn'))), 'similarityDecisionWithdrawn')
        self.assertEqual(self.code(self.decide(self.command('r3', 'withdrawn'))), 'similarityDecisionApplied')
        # replace_existing trashes A; keep_both trashes nothing and hides only its own pair.
        self.assertEqual(self.decide(self.command('r3', 'replace_existing')).json()['trashAssetId'], 's2')
        self.assertEqual(self.reviews(), ['r1'])
        self.assertEqual(self.decide(self.command('r1', 'keep_both')).json()['trashAssetId'], None)
        self.assertEqual(self.reviews(), [])

    def test_applied_cursor_skips_and_withdraw_after_apply(self):
        self.adopt()
        self.decide(self.command('r1', 'keep_existing'))
        self.decide(self.command('r3', 'keep_both'))
        self.assertEqual(self.code(self.republish(3)), 'similarityReviewCursorRejected')
        self.assertEqual(self.code(self.republish(2, [{'sequence': 3, 'reason': 'stale'}])), 'similarityReviewCursorRejected')
        # The PC applied r1 (s1 is trashed, so its pairs leave the feed) and skipped r3.
        items = [i for i in feed_fixture()['items'] if i['reviewId'] not in ('r1', 'r2')]
        reply = self.republish(2, [{'sequence': 2, 'reason': 'resolvedOnPc'}], items)
        self.assertEqual(reply.status_code, 200, reply.text)
        page = self.read()
        self.assertEqual((page['counts'], page['appliedDecisionCursor'], page['decisionCursor']),
                         ({'open': 1, 'pendingPc': 0, 'skipped': 1}, 2, 2))
        self.assertEqual([i['reviewId'] for i in page['items']], ['r3'])
        # Undo after the PC applied points the phone to Trash restore.
        self.assertEqual(self.code(self.decide(self.command('r1', 'withdrawn'))), 'similarityDecisionApplied')
        self.assertEqual(self.code(self.decide(self.command('r1', 'keep_both'))), 'similarityReviewMissing')
        self.assertEqual(self.code(self.republish(1)), 'similarityReviewCursorRejected')  # Never rewinds.

    def test_asset_changes_and_lifecycle_drop_pairs(self):
        revision = self.adopt()
        self.assertEqual(self.code(self.decide(self.command('r1', b_sha='b' * 64))), 'similarityAssetChanged')
        with api_app.get_db() as db:
            db.execute("UPDATE assets SET sha256=? WHERE id='s3'", ('d' * 64,))
            db.commit()
        self.assertEqual(self.reviews(), ['r1', 'r2'])
        self.assertEqual(self.code(self.decide(self.command('r3', 'keep_both', revision))), 'similarityAssetChanged')

    def test_trashed_asset_leaves_the_queue(self):
        # Asset authority needs distinct content, so this feed carries per-Asset hashes.
        digest = lambda id: hashlib.sha256(id.encode()).hexdigest()
        with api_app.get_db() as db:
            for (id,) in db.execute("SELECT id FROM assets").fetchall():
                db.execute("UPDATE assets SET sha256=? WHERE id=?", (digest(id), id))
            db.commit()
        body = feed_fixture()
        for item in body['items']:
            for side in (item['a'], item['b']):
                if side['sha256'] == SHA:
                    side['sha256'] = digest(side['assetId'])
        self.assertEqual(self.put_feed(body).status_code, 200)
        self.assertEqual(self.reviews(), ['r1', 'r2', 'r3'])
        import authority, asset_authority
        authority.startup(api_app.get_db); asset_authority.startup(api_app.get_db)
        with api_app.get_db() as db:
            identity, inventory = asset_authority.current_inventory(db)
            staged = asset_authority.stage_baseline(
                db, library_id=LIBRARY, expected_inventory=inventory,
                rows=[{'assetId': asset_id, 'lifecycle': asset_authority.NORMAL, 'sha256': sha} for asset_id, sha in identity],
                now='2026')
            asset_authority.activate(db, library_id=LIBRARY, expected_snapshot=staged['snapshotDigest'], now='2026')
            db.execute("UPDATE asset_authority_state SET lifecycle='trash' WHERE asset_id='s2'")
            db.commit()
        # A trashed image leaves the queue, and a decision on its pair is refused.
        self.assertEqual(self.reviews(), ['r1'])
        refused = self.decide(self.command('r3', 'keep_both', a_sha=digest('s2'), b_sha=digest('s3')))
        self.assertEqual(self.code(refused), 'similarityAssetChanged')
        body.update(baseRevision=self.read()['revision'], generatedAt='later')
        self.assertEqual(self.put_feed(body).json()['items'], 1)

    def test_idempotency_and_validation(self):
        self.adopt()
        request = self.command('r1', 'keep_existing')
        first = self.decide(request).json()
        self.assertEqual(self.decide(request).json(), first)
        self.assertEqual(self.code(self.decide({**request, 'decision': 'keep_both'})), 'operationConflict')
        self.assertEqual(self.code(self.decide(self.command('zzz'))), 'similarityReviewMissing')
        self.assertEqual(self.code(self.decide({**self.command('r3'), 'libraryId': 'f' * 32})), 'libraryMismatch')
        for bad in ({'decision': 'delete'}, {'operationId': 'x' * 36}, {'extra': 1}, {'basis': None}):
            self.assertEqual(self.decide({**self.command('r3'), **bad}).status_code, 422)
        self.assertEqual(self.client.post(REVIEW + '/decisions', headers=self.auth,
                                          content=b'{' + b' ' * 9000 + b'}').status_code, 413)

    def test_publisher_only_ordered_log(self):
        self.adopt()
        one = self.decide(self.command('r1', 'keep_existing')).json()
        two = self.decide(self.command('r1', 'withdrawn')).json()
        page = self.log(after=0, limit=1).json()
        self.assertEqual((page['nextCursor'], page['hasMore']), (1, True))
        self.assertEqual(page['items'][0] | {'createdAt': None}, {
            'sequence': 1, 'operationId': one['operationId'], 'reviewId': 'r1', 'decision': 'keep_existing',
            'aAssetId': 'a', 'bAssetId': 's1', 'trashAssetId': 's1', 'withdraws': None,
            'basis': {'feedRevision': self.read()['revision'], 'aSha256': SHA, 'bSha256': SHA}, 'createdAt': None})
        rest = self.log(after=1).json()
        self.assertEqual([(i['operationId'], i['decision'], i['withdraws']) for i in rest['items']],
                         [(two['operationId'], 'withdrawn', 1)])
        self.assertFalse(rest['hasMore'])
        for after in (-1, 3):
            self.assertGreaterEqual(self.log(after=after).status_code, 400)
        self.assertEqual(self.log(limit=101).status_code, 422)
        self.assertEqual(self.code(self.client.get(REVIEW + '/decisions', headers=self.publisher,
                                                   params={'libraryId': 'f' * 32})), 'libraryMismatch')


if __name__ == '__main__':
    unittest.main()
