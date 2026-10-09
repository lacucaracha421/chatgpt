"""Mobile similarity review: PC pair feed, mobile decisions, overlay and adoption."""
import copy
import hashlib
import json
import os
import unittest
import uuid
from pathlib import Path
from unittest import mock

import similarity_review
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

    def test_feed_query_loops_over_review_items_not_assets(self):
        # Production once ran this as assets x assets (hours per request) while the
        # review table was empty; the review items must stay the outer loop.
        with api_app.get_db() as db:
            plan = [row[3] for row in db.execute(
                f"EXPLAIN QUERY PLAN SELECT COUNT(*) {similarity_review.FEED_FROM}", ['[]'] * 3)]
        tables = [step for step in plan if step.startswith(('SCAN', 'SEARCH')) and 'json_each' not in step]
        self.assertEqual(tables[0], 'SCAN i', plan)
        self.assertTrue(all('asset' not in step or 'id=?' in step for step in tables[1:]), plan)

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

    def with_asset_authority(self):
        """Per-Asset hashes (authority needs distinct content), the feed, and an active Asset authority."""
        import authority, asset_authority
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
        authority.startup(api_app.get_db); asset_authority.startup(api_app.get_db)
        with api_app.get_db() as db:
            identity, inventory = asset_authority.current_inventory(db)
            staged = asset_authority.stage_baseline(
                db, library_id=LIBRARY, expected_inventory=inventory,
                rows=[{'assetId': asset_id, 'lifecycle': asset_authority.NORMAL, 'sha256': sha} for asset_id, sha in identity],
                now='2026')
            asset_authority.activate(db, library_id=LIBRARY, expected_snapshot=staged['snapshotDigest'], now='2026')
            db.commit()
        return body, digest

    def lifecycle(self, command_type, asset_id, headers=None, operation_id=None):
        with api_app.get_db() as db:
            revision = db.execute("SELECT entity_revision FROM asset_authority_state WHERE asset_id=?",
                                  (asset_id,)).fetchone()[0]
        return self.client.put('/v1/assets/authority/commands', headers=headers or self.auth, json={
            'libraryId': LIBRARY, 'epoch': 1, 'contractVersion': 1,
            'operationId': operation_id or str(uuid.uuid4()), 'commandType': command_type,
            'assetId': asset_id, 'expectedEntityRevision': revision})

    def state_of(self, asset_id):
        with api_app.get_db() as db:
            return db.execute("SELECT lifecycle FROM asset_authority_state WHERE asset_id=?", (asset_id,)).fetchone()[0]

    def test_client_trash_of_an_asset_a_pending_decision_keeps_is_refused(self):
        body, digest = self.with_asset_authority()
        # r1 keep_existing keeps `a` and will trash s1 once the PC applies it.
        decided = self.decide(self.command('r1', 'keep_existing', a_sha=digest('a'), b_sha=digest('s1')))
        self.assertEqual(decided.json()['trashAssetId'], 's1', decided.text)
        operation = str(uuid.uuid4())
        refused = self.lifecycle('trashAsset', 'a', operation_id=operation)
        self.assertEqual(refused.status_code, 409, refused.text)
        self.assertEqual(refused.json()['detail'] | {'message': None}, {
            'code': 'similarityDecisionKeepsAsset', 'message': None, 'assetId': 'a',
            'reviewId': 'r1', 'lifecycle': 'normal'})
        self.assertEqual(self.state_of('a'), 'normal')
        # The decision is untouched, and the refusal left no receipt: the same operation is
        # accepted once the PC applied the decision (its cursor passed it).
        self.assertEqual(self.read()['counts']['pendingPc'], 1)
        body.update(baseRevision=self.read()['revision'], decisionCursor=1, generatedAt='later')
        body['items'] = [i for i in body['items'] if i['reviewId'] not in ('r1', 'r2')]
        self.assertEqual(self.put_feed(body).status_code, 200)
        accepted = self.lifecycle('trashAsset', 'a', operation_id=operation)
        self.assertEqual(accepted.status_code, 200, accepted.text)
        self.assertEqual(self.state_of('a'), 'trash')

    def test_trash_outside_a_kept_asset_and_restore_are_unchanged(self):
        _, digest = self.with_asset_authority()
        self.decide(self.command('r1', 'keep_existing', a_sha=digest('a'), b_sha=digest('s1')))
        self.decide(self.command('r3', 'keep_both', a_sha=digest('s2'), b_sha=digest('s3')))
        # The image the decision trashes, an image a keep_both decision holds, and an
        # unrelated image all go to the trash as before.
        for asset_id in ('s1', 's3', 'other'):
            reply = self.lifecycle('trashAsset', asset_id)
            self.assertEqual(reply.status_code, 200, reply.text)
        # The PC (publisher) may trash the kept image; it then skips the decision as stale.
        self.assertEqual(self.lifecycle('trashAsset', 'a', headers=self.publisher).status_code, 200)
        # Restore is never refused, even while the decision still names the image.
        self.assertEqual(self.read()['counts']['pendingPc'], 2)
        restored = self.lifecycle('restoreAsset', 'a')
        self.assertEqual(restored.status_code, 200, restored.text)
        self.assertEqual(self.state_of('a'), 'normal')

    def test_withdrawing_the_decision_releases_the_kept_asset(self):
        _, digest = self.with_asset_authority()
        self.decide(self.command('r3', 'replace_existing', a_sha=digest('s2'), b_sha=digest('s3')))
        self.assertEqual(self.code(self.lifecycle('trashAsset', 's3')), 'similarityDecisionKeepsAsset')
        undo = self.decide(self.command('r3', 'withdrawn', a_sha=digest('s2'), b_sha=digest('s3')))
        self.assertEqual(undo.status_code, 200, undo.text)
        self.assertEqual(self.lifecycle('trashAsset', 's3').status_code, 200)

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

    # --- Server apply (LAKOMICS_SIMILARITY_SERVER_APPLY) -------------------------------------

    def server_apply(self, on=True):
        patcher = mock.patch.dict(os.environ)
        patcher.start()
        self.addCleanup(patcher.stop)
        if on:
            os.environ[similarity_review.SERVER_APPLY_ENV] = '1'
        else:
            os.environ.pop(similarity_review.SERVER_APPLY_ENV, None)

    def trash_changes(self):
        with api_app.get_db() as db:
            return db.execute("SELECT COUNT(*) FROM asset_authority_changes WHERE command_type='trashAsset'").fetchone()[0]

    def test_switch_off_keeps_the_pc_path_even_with_an_active_asset_authority(self):
        self.server_apply(False)
        _, digest = self.with_asset_authority()
        self.assertEqual(self.read()['features'], [])
        sent = self.decide(self.command('r1', 'keep_existing', a_sha=digest('a'), b_sha=digest('s1')))
        self.assertEqual(sent.status_code, 200, sent.text)
        self.assertTrue(sent.json()['pendingPc'])
        self.assertNotIn('serverApplied', sent.json())
        self.assertEqual(self.state_of('s1'), 'normal')
        self.assertEqual(self.read()['counts']['pendingPc'], 1)
        entry = self.log().json()
        self.assertEqual((entry['features'], entry['items'][0]['serverApplied']), ([], False))
        # Undo after sending still works.
        self.assertEqual(self.decide(self.command('r1', 'withdrawn', a_sha=digest('a'), b_sha=digest('s1'))).status_code, 200)

    def test_switch_on_without_an_active_asset_authority_changes_nothing(self):
        self.server_apply()
        self.adopt()
        self.assertEqual(self.read()['features'], [])
        sent = self.decide(self.command('r1', 'keep_existing'))
        self.assertEqual(sent.status_code, 200, sent.text)
        self.assertTrue(sent.json()['pendingPc'])
        self.assertFalse(self.log().json()['items'][0]['serverApplied'])
        self.assertEqual(self.decide(self.command('r1', 'withdrawn')).status_code, 200)

    def test_switch_on_trashes_the_discarded_image_at_once_and_idempotently(self):
        self.server_apply()
        _, digest = self.with_asset_authority()
        self.assertEqual(self.read()['features'], ['similarityServerApply'])
        request = self.command('r1', 'keep_existing', a_sha=digest('a'), b_sha=digest('s1'))
        sent = self.decide(request)
        self.assertEqual(sent.status_code, 200, sent.text)
        body = sent.json()
        self.assertEqual((body['pendingPc'], body['serverApplied'], body['trashAssetId']), (False, True, 's1'))
        # The lifecycle is carried out: s1 is in Library Trash, the kept image is untouched.
        self.assertEqual((self.state_of('s1'), self.state_of('a')), ('trash', 'normal'))
        self.assertEqual(self.trash_changes(), 1)
        # Nothing is left for the PC, and r1 / r2 (which holds s1) leave the queue.
        page = self.read()
        self.assertEqual(page['counts']['pendingPc'], 0)
        self.assertEqual([i['reviewId'] for i in page['items']], ['r3'])
        # A response-lost retry returns the receipt and does not trash a second time.
        self.assertEqual(self.decide(request).json(), body)
        self.assertEqual(self.trash_changes(), 1)
        self.assertEqual(self.code(self.decide({**request, 'decision': 'keep_both'})), 'operationConflict')
        # The log tells the PC the server already applied the entry.
        log = self.log().json()
        self.assertEqual(log['features'], ['similarityServerApply'])
        self.assertEqual([(i['sequence'], i['serverApplied'], i['trashAssetId']) for i in log['items']], [(1, True, 's1')])
        self.assertEqual(self.read()['decisionCursor'], 1)

    def test_switch_on_replace_existing_and_keep_both(self):
        self.server_apply()
        _, digest = self.with_asset_authority()
        replace = self.decide(self.command('r3', 'replace_existing', a_sha=digest('s2'), b_sha=digest('s3')))
        self.assertEqual(replace.status_code, 200, replace.text)
        self.assertEqual((self.state_of('s2'), self.state_of('s3')), ('trash', 'normal'))
        both = self.decide(self.command('r1', 'keep_both', a_sha=digest('a'), b_sha=digest('s1')))
        self.assertEqual(both.status_code, 200, both.text)
        self.assertEqual((both.json()['serverApplied'], both.json()['trashAssetId']), (True, None))
        self.assertEqual((self.state_of('a'), self.state_of('s1')), ('normal', 'normal'))
        self.assertEqual(self.trash_changes(), 1)
        self.assertEqual([i['serverApplied'] for i in self.log().json()['items']], [True, True])

    def test_switch_on_refuses_a_late_withdraw_and_leaves_the_trash_restorable(self):
        self.server_apply()
        _, digest = self.with_asset_authority()
        self.decide(self.command('r1', 'keep_existing', a_sha=digest('a'), b_sha=digest('s1')))
        late = self.decide(self.command('r1', 'withdrawn', a_sha=digest('a'), b_sha=digest('s1')))
        self.assertEqual((late.status_code, self.code(late)), (409, 'similarityDecisionApplied'))
        self.assertEqual(self.state_of('s1'), 'trash')
        self.assertEqual(len(self.log().json()['items']), 1)
        # Restore from Library Trash works, and the kept image is no longer fenced.
        self.assertEqual(self.lifecycle('restoreAsset', 's1').status_code, 200)
        self.assertEqual(self.state_of('s1'), 'normal')
        self.assertEqual(self.lifecycle('trashAsset', 'a').status_code, 200)

    def test_switch_on_failed_lifecycle_leaves_no_log_entry_and_no_trash(self):
        self.server_apply()
        _, digest = self.with_asset_authority()
        with mock.patch('asset_authority._save_receipt', side_effect=RuntimeError('boom')):
            with self.assertRaises(RuntimeError):
                self.decide(self.command('r1', 'keep_existing', a_sha=digest('a'), b_sha=digest('s1')))
        self.assertEqual(self.state_of('s1'), 'normal')
        self.assertEqual((self.trash_changes(), self.log().json()['items']), (0, []))
        self.assertEqual(self.read()['decisionCursor'], 0)
        # An image already in the trash refuses the decision cleanly instead of half-applying.
        self.assertEqual(self.lifecycle('trashAsset', 's1').status_code, 200)
        stale = self.decide(self.command('r1', 'keep_existing', a_sha=digest('a'), b_sha=digest('s1')))
        self.assertEqual(self.code(stale), 'similarityAssetChanged')
        self.assertEqual(self.log().json()['items'], [])

    def test_a_decision_made_before_the_switch_is_still_left_to_the_pc(self):
        _, digest = self.with_asset_authority()
        before = self.decide(self.command('r3', 'replace_existing', a_sha=digest('s2'), b_sha=digest('s3')))
        self.assertTrue(before.json()['pendingPc'])
        self.server_apply()
        after = self.decide(self.command('r1', 'keep_existing', a_sha=digest('a'), b_sha=digest('s1')))
        self.assertTrue(after.json()['serverApplied'])
        self.assertEqual((self.state_of('s2'), self.state_of('s1')), ('normal', 'trash'))
        self.assertEqual([i['serverApplied'] for i in self.log().json()['items']], [False, True])
        self.assertEqual(self.read()['counts']['pendingPc'], 1)

    def test_switch_on_discarding_an_image_an_owed_decision_keeps_is_refused_cleanly(self):
        _, digest = self.with_asset_authority()
        # r3 keep_existing keeps s2 (the PC still owes the trash of s3).
        self.assertTrue(self.decide(self.command('r3', 'keep_existing', a_sha=digest('s2'), b_sha=digest('s3'))).json()['pendingPc'])
        self.server_apply()
        # r2 keep_existing would trash s2 on the server: refused, nothing logged, nothing trashed.
        refused = self.decide(self.command('r2', 'keep_existing', a_sha=digest('s1'), b_sha=digest('s2')))
        self.assertEqual((refused.status_code, self.code(refused)), (409, 'similarityDecisionKeepsAsset'))
        self.assertEqual((self.state_of('s2'), self.state_of('s1')), ('normal', 'normal'))
        self.assertEqual((self.trash_changes(), len(self.log().json()['items'])), (0, 1))
        self.assertEqual(self.read()['decisionCursor'], 1)
        # Keeping s2 and trashing s1 is not in conflict and is applied at once.
        fine = self.decide(self.command('r2', 'replace_existing', a_sha=digest('s1'), b_sha=digest('s2')))
        self.assertEqual(fine.status_code, 200, fine.text)
        self.assertEqual(self.state_of('s1'), 'trash')

    def test_a_pc_trash_of_an_image_a_server_applied_decision_keeps_is_refused_until_the_pc_consumed_it(self):
        self.server_apply()
        body, digest = self.with_asset_authority()
        # The tablet keeps `a` and trashes s1; the PC decided the other way and now trashes `a`.
        self.decide(self.command('r1', 'keep_existing', a_sha=digest('a'), b_sha=digest('s1')))
        refused = self.lifecycle('trashAsset', 'a', headers=self.publisher)
        self.assertEqual((refused.status_code, refused.json()['detail']['code']), (409, 'similarityKeptByTabletDecision'))
        self.assertEqual(refused.json()['detail']['reviewId'], 'r1')
        self.assertEqual(self.state_of('a'), 'normal')
        # The discarded image is already trashed (idempotent for the PC), restores are never refused,
        # and a signed-in client keeps its own right to trash.
        self.assertEqual(self.lifecycle('trashAsset', 's1', headers=self.publisher).status_code, 200)
        self.assertEqual(self.lifecycle('restoreAsset', 's1', headers=self.publisher).status_code, 200)
        # keep_both holds no claim.
        self.decide(self.command('r3', 'keep_both', a_sha=digest('s2'), b_sha=digest('s3')))
        self.assertEqual(self.lifecycle('trashAsset', 's3', headers=self.publisher).status_code, 200)
        # Once the PC consumed the entry (its feed cursor passed it) the fence is gone.
        body.update(baseRevision=self.read()['revision'], decisionCursor=2, generatedAt='later')
        body['items'] = [i for i in body['items'] if i['reviewId'] not in ('r1', 'r2', 'r3')]
        self.assertEqual(self.put_feed(body).status_code, 200)
        self.assertEqual(self.lifecycle('trashAsset', 'a', headers=self.publisher).status_code, 200)
        self.assertEqual(self.state_of('a'), 'trash')

    def test_a_tablet_decision_after_the_pc_trashed_the_kept_image_is_refused(self):
        self.server_apply()
        _, digest = self.with_asset_authority()
        # The PC discarded s1 first; the tablet then tries to keep s1 and trash `a`.
        self.assertEqual(self.lifecycle('trashAsset', 's1', headers=self.publisher).status_code, 200)
        late = self.decide(self.command('r1', 'replace_existing', a_sha=digest('a'), b_sha=digest('s1')))
        self.assertEqual(self.code(late), 'similarityAssetChanged')
        self.assertEqual(self.state_of('a'), 'normal')
        self.assertEqual(self.log().json()['items'], [])

    def test_withdraw_is_decided_by_the_decision_not_by_the_current_switch(self):
        _, digest = self.with_asset_authority()
        owed = self.decide(self.command('r3', 'replace_existing', a_sha=digest('s2'), b_sha=digest('s3')))
        self.assertTrue(owed.json()['pendingPc'])
        self.server_apply()
        # A decision the PC still owes can be withdrawn even while the switch is on.
        undo = self.decide(self.command('r3', 'withdrawn', a_sha=digest('s2'), b_sha=digest('s3')))
        self.assertEqual(undo.status_code, 200, undo.text)
        self.assertEqual((undo.json()['withdraws'], undo.json()['pendingPc']), (1, True))
        self.assertNotIn('serverApplied', undo.json())
        self.assertEqual([i['serverApplied'] for i in self.log().json()['items']], [False, False])
        # A server-applied decision cannot, also after the switch was turned off again.
        self.assertEqual(self.decide(self.command('r1', 'keep_existing', a_sha=digest('a'), b_sha=digest('s1'))).status_code, 200)
        self.server_apply(False)
        late = self.decide(self.command('r1', 'withdrawn', a_sha=digest('a'), b_sha=digest('s1')))
        self.assertEqual((late.status_code, self.code(late)), (409, 'similarityDecisionApplied'))
        self.assertEqual(self.state_of('s1'), 'trash')

    def test_publisher_only_ordered_log(self):
        self.adopt()
        one = self.decide(self.command('r1', 'keep_existing')).json()
        two = self.decide(self.command('r1', 'withdrawn')).json()
        page = self.log(after=0, limit=1).json()
        self.assertEqual((page['nextCursor'], page['hasMore']), (1, True))
        self.assertEqual(page['items'][0] | {'createdAt': None}, {
            'sequence': 1, 'operationId': one['operationId'], 'reviewId': 'r1', 'decision': 'keep_existing',
            'aAssetId': 'a', 'bAssetId': 's1', 'trashAssetId': 's1', 'withdraws': None,
            'serverApplied': False,
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


    def test_status_head_moves_with_the_log(self):
        """`/v1/sync/status` publisherLogs.similarityDecisions is the log's last sequence."""
        def head():
            with api_app.get_db() as db:
                return similarity_review.status_head(db)
        self.assertEqual(head(), 0)
        self.adopt()
        self.assertEqual(head(), 0)
        self.assertEqual(self.decide(self.command('r1', 'keep_existing')).status_code, 200)
        self.assertEqual(head(), 1)
        self.assertEqual(self.log(after=0).json()['nextCursor'], head())

if __name__ == '__main__':
    unittest.main()
