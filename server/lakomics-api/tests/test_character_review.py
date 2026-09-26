"""Mobile character review: PC feed, mobile decisions, adoption and the cross-channel guard."""
import copy
import json
import unittest
import uuid
from pathlib import Path
from unittest import mock

import character_review
from tests import test_character_exclusions as base
from tests import test_mobile_characters as fixtures

api_app, PREFIX, AUTH, LIBRARY = fixtures.api_app, fixtures.PREFIX, fixtures.AUTH, base.LIBRARY
REVIEW = PREFIX + '/review'
FIXTURE = Path(__file__).resolve().parents[3] / 'tests/fixtures/mobile-character-review-feed.json'


def feed_fixture():
    return json.loads(FIXTURE.read_text(encoding='utf-8'))


class CharacterReviewTests(unittest.TestCase):
    asset = fixtures.MobileCharactersTests.asset
    index = fixtures.MobileCharactersTests.index
    browse = fixtures.MobileCharactersTests.browse
    tearDown = fixtures.MobileCharactersTests.tearDown
    publish = base.CharacterExclusionTests.publish
    ready = base.CharacterExclusionTests.ready

    def setUp(self):
        base.CharacterExclusionTests.setUp(self)
        for id in ('cand-1', 'cand-2', 'cand-3', 'ref-1', 'other'):
            self.asset(id)
        with api_app.get_db() as db:
            db.execute("UPDATE assets SET sha256=?", ('a' * 64,))
            db.commit()

    def snapshot(self, review_cursor=None):
        body = base.CharacterExclusionTests.snapshot(self)
        body['nodes'][1]['protectedAssetIds'] = ['ref-1']
        body['nodes'].append({'id': 'character:d', 'kind': 'character', 'sourceId': 'd', 'seriesId': 's',
                              'parentId': 'series:s', 'name': '둘째', 'protectedAssetIds': []})
        body['scopes'][0]['assetIds'] = ['b', 'a', 'cand-1', 'cand-2', 'cand-3', 'ref-1']
        body['scopes'][-1]['assetIds'] = ['b', 'a', 'ref-1']
        body['scopes'].append({'nodeId': 'character:d', 'filter': 'all', 'assetIds': []})
        if review_cursor is not None:
            body['reviewDecisionCursor'] = review_cursor
        return body

    def republish(self, **changes):
        body = self.snapshot(changes.pop('review_cursor', None))
        body.update(baseRevision=self.index()['revision'], **changes)
        return self.publish(body)

    def put_feed(self, body, headers=None):
        return self.client.put(REVIEW + '/feed', headers=self.publisher if headers is None else headers, json=body)

    def adopt(self):
        self.ready(self.snapshot(0))
        reply = self.put_feed(feed_fixture())
        self.assertEqual(reply.status_code, 200, reply.text)
        return reply.json()['revision']

    def read(self, **params):
        reply = self.client.get(REVIEW, headers=self.auth, params=params)
        self.assertEqual(reply.status_code, 200, reply.text)
        return reply.json()

    def command(self, target='c', asset='cand-1', decision='accepted', origin='feed', basis='2026-09-24T08:59:00Z'):
        return {'version': 1, 'libraryId': LIBRARY, 'operationId': str(uuid.uuid4()), 'targetId': target,
                'assetId': asset, 'decision': decision, 'origin': origin, 'basis': basis}

    def decide(self, body):
        return self.client.post(REVIEW + '/decisions', headers=self.auth, json=body)

    def log(self, **params):
        return self.client.get(REVIEW + '/decisions', headers=self.publisher,
                               params={'libraryId': LIBRARY, **params})

    def code(self, reply):
        return reply.json()['detail']['code']

    def test_inactive_until_adoption_and_roles(self):
        self.ready(self.snapshot())
        before = self.index()
        self.assertFalse(before['capabilities']['characterReview'])
        self.assertNotIn('reviewDecisionCursor', before)
        self.assertFalse(self.read()['ready'])
        self.assertEqual(self.read(asset='a'), {'version': 1, 'ready': False, 'assetId': 'a', 'targets': []})
        self.assertEqual(self.code(self.decide(self.command())), 'characterReviewUnsupported')
        # The PC's probe: an upgraded server answers the log route before adoption.
        self.assertEqual(self.log().json()['items'], [])
        for headers in ({}, AUTH, self.auth):
            self.assertEqual(self.client.get(REVIEW + '/decisions', headers=headers,
                                             params={'libraryId': LIBRARY}).status_code, 401)
            self.assertEqual(self.put_feed(feed_fixture(), headers=headers).status_code, 401)
        self.assertEqual(self.client.get(REVIEW).status_code, 401)
        self.assertEqual(self.client.post(REVIEW + '/decisions', json=self.command()).status_code, 401)
        # Exclusions keep their deployed contract while review is inactive.
        self.assertEqual(base.CharacterExclusionTests.exclude(self, base.CharacterExclusionTests.command(self)).status_code, 200)

    def test_adoption_hydrates_committed_rows_references_and_counts(self):
        published = self.ready(self.snapshot(0))
        revision = self.adopt()
        index = self.index()
        self.assertTrue(index['capabilities']['characterReview'])
        self.assertEqual((index['reviewDecisionCursor'], index['appliedReviewDecisionCursor']), (0, 0))
        self.assertNotEqual(index['revision'], published)  # Mobile polling notices the capability.
        page = self.read()
        self.assertEqual(page['revision'], revision)
        self.assertEqual([(i['targetId'], i['assetId']) for i in page['items']],
                         [('c', 'a'), ('c', 'cand-1'), ('d', 'cand-2'), ('d', 'cand-3')])
        self.assertEqual(page['counts'], {'total': 4, 's36': 2, 'b36': 2, 'doubtful': 1, 'pendingPc': 0, 'skipped': 0})
        self.assertEqual(page['items'][1]['sources'], ['s36', 'b36'])
        self.assertEqual(page['items'][1]['asset']['id'], 'cand-1')
        self.assertNotIn('private/', json.dumps(page))
        self.assertEqual(page['targets']['c']['seriesName'], '시리즈')
        self.assertEqual([a['id'] for a in page['targets']['c']['references']], ['ref-1'])
        self.assertEqual(self.read(source='b36')['counts']['total'], 2)
        self.assertEqual([i['assetId'] for i in self.read(source='b36')['items']], ['cand-1', 'cand-2'])
        only_d = self.read(target='d')
        self.assertEqual([i['assetId'] for i in only_d['items']], ['cand-2', 'cand-3'])
        self.assertEqual(only_d['counts']['doubtful'], 0)
        first = self.read(limit=3)
        self.assertTrue(first['hasMore'])
        rest = self.read(limit=3, cursor=first['nextCursor'])
        self.assertEqual([i['assetId'] for i in rest['items']], ['cand-3'])
        self.assertFalse(rest['hasMore'])
        self.assertEqual(self.client.get(REVIEW, headers=self.auth, params={'cursor': 'bad!'}).status_code, 400)
        self.assertEqual(self.client.get(REVIEW, headers=self.auth, params={'limit': 51}).status_code, 422)
        self.assertEqual(self.client.get(REVIEW, headers=self.auth, params={'asset': 'a', 'limit': 1}).status_code, 422)
        self.assertEqual(self.client.get(REVIEW, headers=self.auth, params={'debug': 1}).status_code, 422)
        # A newer publication invalidates an old walk instead of splicing two feeds.
        body = feed_fixture(); body.update(baseRevision=revision, generatedAt='2026-09-24T10:00:00Z')
        self.assertEqual(self.put_feed(body).status_code, 200)
        stale = self.client.get(REVIEW, headers=self.auth, params={'cursor': first['nextCursor']})
        self.assertEqual(self.code(stale), 'characterReviewChanged')

    def test_atomic_replace_stale_base_and_limits(self):
        revision = self.adopt()
        self.assertEqual(self.put_feed(feed_fixture()).json()['revision'], revision)  # Idempotent retry.
        changed = feed_fixture(); changed['items'] = changed['items'][:1]
        self.assertEqual(self.code(self.put_feed(changed)), 'characterReviewFeedChanged')
        invalid = feed_fixture(); invalid['baseRevision'] = revision; invalid['items'][0]['targetId'] = 'zzz'
        self.assertEqual(self.put_feed(invalid).status_code, 422)
        duplicate = feed_fixture(); duplicate['baseRevision'] = revision; duplicate['items'].append(duplicate['items'][0])
        self.assertEqual(self.put_feed(duplicate).status_code, 422)
        too_many_refs = feed_fixture(); too_many_refs['baseRevision'] = revision
        too_many_refs['targets']['c']['referenceAssetIds'] = ['1', '2', '3', '4', '5']
        self.assertEqual(self.put_feed(too_many_refs).status_code, 422)
        body = feed_fixture(); body['baseRevision'] = revision; body['generatedAt'] = 'later'
        with mock.patch('character_review.MAX_FEED_BYTES', 10):
            self.assertEqual(self.put_feed(body).status_code, 413)
        with mock.patch('character_review.MAX_TARGETS', 1):
            self.assertEqual(self.put_feed(body).status_code, 413)
        many = copy.deepcopy(body)
        many['items'] = [{**body['items'][1], 'assetId': f'x{i}'} for i in range(5001)]
        self.assertEqual(self.put_feed(many).status_code, 422)
        wrong = feed_fixture(); wrong['baseRevision'] = revision; wrong['libraryId'] = 'f' * 32
        self.assertEqual(self.code(self.put_feed(wrong)), 'libraryMismatch')
        self.assertEqual(self.read()['revision'], revision)
        self.assertEqual(len(self.read()['items']), 4)
        replaced = feed_fixture(); replaced.update(baseRevision=revision, items=replaced['items'][1:2])
        self.assertEqual(self.put_feed(replaced).status_code, 200)
        self.assertEqual([i['assetId'] for i in self.read()['items']], ['cand-1'])

    def test_overlay_hides_pending_accept_and_clear_shows_again_without_membership(self):
        self.adopt()
        gallery = self.index()['revision']
        accepted = self.decide(self.command())
        self.assertEqual(accepted.status_code, 200, accepted.text)
        receipt = accepted.json()
        self.assertEqual((receipt['sequence'], receipt['decision'], receipt['pendingPc']), (1, 'accepted', True))
        # Decision 1: no membership overlay; the gallery revision and contents are untouched.
        self.assertEqual(receipt['revision'], gallery)
        self.assertEqual(self.index()['revision'], gallery)
        self.assertEqual([a['id'] for a in self.browse(gallery).json()['items']], ['b', 'a', 'ref-1'])
        page = self.read()
        self.assertNotIn('cand-1', [i['assetId'] for i in page['items']])
        self.assertEqual((page['counts']['total'], page['counts']['pendingPc']), (3, 1))
        self.assertEqual(self.read(asset='cand-1')['targets'], [{'targetId': 'd', 'name': '둘째', 'seriesId': 's', 'seriesName': '시리즈'}])
        self.assertEqual(self.decide(self.command(decision='cleared')).status_code, 200)
        self.assertIn('cand-1', [i['assetId'] for i in self.read()['items']])
        self.assertEqual(self.read()['counts']['pendingPc'], 2)

    def test_pending_reject_of_a_member_hides_it_until_navigation_acknowledges(self):
        self.adopt()
        before = self.index()['revision']
        receipt = self.decide(self.command(asset='a', decision='rejected')).json()
        self.assertNotEqual(receipt['revision'], before)
        self.assertEqual(self.index()['revision'], receipt['revision'])
        self.assertEqual([a['id'] for a in self.browse(receipt['revision']).json()['items']], ['b', 'ref-1'])
        self.assertNotIn('a', [i['assetId'] for i in self.read()['items']])
        undo = self.decide(self.command(asset='a', decision='cleared')).json()
        self.assertEqual([a['id'] for a in self.browse(undo['revision']).json()['items']], ['b', 'a', 'ref-1'])
        again = self.decide(self.command(asset='a', decision='rejected')).json()
        self.assertEqual(again['sequence'], 3)
        # Navigation snapshots: legacy/unaware PUTs are refused; the cursor stays within the log.
        self.assertEqual(self.code(self.republish()), 'characterReviewUnsupported')
        self.assertEqual(self.code(self.republish(review_cursor=4)), 'characterReviewCursorRejected')
        applied = self.snapshot(3); applied['baseRevision'] = self.index()['revision']
        applied['scopes'][-2]['assetIds'] = ['b', 'ref-1']  # The PC applied the rejection.
        self.assertEqual(self.publish(applied).status_code, 200)
        index = self.index()
        self.assertEqual((index['reviewDecisionCursor'], index['appliedReviewDecisionCursor']), (3, 3))
        self.assertEqual(self.code(self.republish(review_cursor=2)), 'characterReviewCursorRejected')
        # Feed cursor guard: within the log, never rewinding, skipped only inside the range.
        feed = feed_fixture(); feed.update(baseRevision=self.read()['revision'], decisionCursor=4)
        self.assertEqual(self.code(self.put_feed(feed)), 'characterReviewCursorRejected')
        feed.update(decisionCursor=3, skipped=[{'sequence': 4, 'reason': 'skipped:unknownAsset'}])
        self.assertEqual(self.code(self.put_feed(feed)), 'characterReviewCursorRejected')
        feed.update(skipped=[{'sequence': 2, 'reason': 'skipped:targetMissing'}])
        self.assertEqual(self.put_feed(feed).status_code, 200, self.put_feed(feed).text)
        page = self.read()
        self.assertEqual((page['counts']['pendingPc'], page['counts']['skipped'], page['appliedDecisionCursor']), (0, 1, 3))
        rewind = feed_fixture(); rewind.update(baseRevision=page['revision'], decisionCursor=1)
        self.assertEqual(self.code(self.put_feed(rewind)), 'characterReviewCursorRejected')

    def test_idempotency_protected_references_and_checks(self):
        self.adopt()
        request = self.command()
        first = self.decide(request).json()
        self.assertEqual(self.decide(request).json(), first)
        self.assertEqual(self.code(self.decide({**request, 'decision': 'rejected'})), 'operationConflict')
        self.assertEqual(self.code(self.decide(self.command(asset='ref-1'))), 'characterReferenceProtected')
        self.assertEqual(self.code(self.decide(self.command(asset='ref-1', decision='rejected'))), 'characterReferenceProtected')
        self.assertEqual(self.decide(self.command(asset='ref-1', decision='cleared', origin='viewer')).status_code, 200)
        self.assertEqual(self.code(self.decide(self.command(target='zzz'))), 'characterReviewTargetMissing')
        self.assertEqual(self.code(self.decide(self.command(target='s'))), 'characterReviewTargetMissing')
        self.assertEqual(self.code(self.decide(self.command(asset='not-uploaded'))), 'characterReviewAssetMissing')
        self.assertEqual(self.code(self.decide({**self.command(), 'libraryId': 'f' * 32})), 'libraryMismatch')
        for bad in ({'decision': 'maybe'}, {'origin': 'pc'}, {'operationId': 'x' * 36}, {'extra': 1}):
            self.assertEqual(self.decide({**self.command(), **bad}).status_code, 422)
        self.assertEqual(self.client.post(REVIEW + '/decisions', headers=self.auth,
                                          content=b'{' + b' ' * 9000 + b'}').status_code, 413)

    def test_viewer_add_is_limited_to_the_assets_series(self):
        self.adopt()
        self.assertEqual([t['targetId'] for t in self.read(asset='cand-2')['targets']], ['c', 'd'])
        # Existing members and protected references are not offered.
        self.assertEqual([t['targetId'] for t in self.read(asset='a')['targets']], ['d'])
        self.assertEqual([t['targetId'] for t in self.read(asset='ref-1')['targets']], ['d'])
        self.assertEqual(self.read(asset='other')['targets'], [])  # Not in any series.
        self.assertEqual(self.code(self.decide(self.command(asset='other', origin='viewer', basis=None))),
                         'characterReviewOutsideSeries')
        added = self.decide(self.command(target='d', asset='cand-2', origin='viewer', basis=None))
        self.assertEqual(added.status_code, 200, added.text)
        self.assertEqual([t['targetId'] for t in self.read(asset='cand-2')['targets']], ['c'])

    def test_cross_channel_pending_correction_refused_both_ways(self):
        self.adopt()
        excluded = base.CharacterExclusionTests.exclude(self, base.CharacterExclusionTests.command(self, asset='b'))
        self.assertEqual(excluded.status_code, 200, excluded.text)
        self.assertEqual(self.code(self.decide(self.command(asset='b', decision='rejected'))), 'pendingCharacterCorrection')
        self.assertEqual(self.decide(self.command(asset='a', decision='rejected')).status_code, 200)
        mirror = base.CharacterExclusionTests.exclude(self, base.CharacterExclusionTests.command(self, asset='a'))
        self.assertEqual(self.code(mirror), 'pendingCharacterCorrection')
        # Another character's pair is not blocked.
        self.assertEqual(self.decide(self.command(target='d', asset='b', origin='viewer', basis=None)).status_code, 200)

    def test_feed_decisions_require_the_published_pair(self):
        self.adopt()
        for asset in ('other', 'b', 'cand-2'):
            for decision in ('accepted', 'rejected', 'cleared'):
                with self.subTest(asset=asset, decision=decision):
                    reply = self.decide(self.command(asset=asset, decision=decision))
                    self.assertEqual(reply.status_code, 409)
                    self.assertEqual(self.code(reply), 'characterReviewChanged')
        self.assertEqual(self.log().json()['items'], [])
        command = self.command()
        accepted = self.decide(command)
        self.assertEqual(accepted.status_code, 200, accepted.text)
        feed = feed_fixture()
        feed.update(baseRevision=self.read()['revision'], items=[])
        self.assertEqual(self.put_feed(feed).status_code, 200)
        # Lost-response retries still resolve from the receipt after feed removal.
        self.assertEqual(self.decide(command).json(), accepted.json())
        reply = self.decide(self.command())
        self.assertEqual((reply.status_code, self.code(reply)), (409, 'characterReviewChanged'))
        self.assertEqual(len(self.log().json()['items']), 1)

    def test_publisher_only_ordered_log(self):
        self.adopt()
        one = self.decide(self.command()).json()
        two = self.decide(self.command(target='d', asset='cand-2', decision='rejected')).json()
        page = self.log(after=0, limit=1).json()
        self.assertEqual((page['nextCursor'], page['hasMore']), (1, True))
        item = page['items'][0]
        self.assertEqual({k: item[k] for k in ('sequence', 'operationId', 'targetId', 'assetId', 'decision', 'origin', 'basis', 'assetSha256')},
                         {'sequence': 1, 'operationId': one['operationId'], 'targetId': 'c', 'assetId': 'cand-1',
                          'decision': 'accepted', 'origin': 'feed', 'basis': '2026-09-24T08:59:00Z', 'assetSha256': 'a' * 64})
        rest = self.log(after=1).json()
        self.assertEqual([i['operationId'] for i in rest['items']], [two['operationId']])
        self.assertFalse(rest['hasMore'])
        for after in (-1, 3):
            self.assertGreaterEqual(self.log(after=after).status_code, 400)
        self.assertEqual(self.log(limit=101).status_code, 422)
        self.assertEqual(self.client.get(REVIEW + '/decisions', headers=self.publisher,
                                         params={'libraryId': 'f' * 32}).json()['detail']['code'], 'libraryMismatch')

    def test_status_head_moves_with_the_log(self):
        """`/v1/sync/status` publisherLogs.characterReviewDecisions is the log's last sequence."""
        def head():
            with api_app.get_db() as db:
                return character_review.status_head(db)
        self.assertEqual(head(), 0)
        self.adopt()
        self.assertEqual(head(), 0)
        self.assertEqual(self.decide(self.command()).status_code, 200)
        self.assertEqual(self.decide(self.command(target='d', asset='cand-2', decision='rejected')).status_code, 200)
        self.assertEqual(head(), 2)
        self.assertEqual(self.log(after=0).json()['nextCursor'], head())

    def test_navigation_cursor_before_adoption(self):
        self.assertEqual(self.publish(self.snapshot(0)).status_code, 200)
        self.assertEqual(self.code(self.republish(review_cursor=1)), 'characterReviewCursorRejected')
        legacy = fixtures.fixture(); legacy['reviewDecisionCursor'] = 0
        self.assertEqual(self.client.put(PREFIX + '/replica', headers=AUTH, json=legacy).status_code, 422)
        # A legacy snapshot after an upgraded one stays refused (unchanged exclusion guard).
        self.assertEqual(self.client.put(PREFIX + '/replica', headers=AUTH, json=fixtures.fixture()).status_code, 409)

    def test_adoption_requires_an_upgraded_publication(self):
        self.assertEqual(self.client.put(PREFIX + '/replica', headers=AUTH, json=fixtures.fixture()).status_code, 200)
        self.assertEqual(self.code(self.put_feed(feed_fixture())), 'characterReviewUnsupported')
        self.assertFalse(self.index()['capabilities']['characterReview'])


if __name__ == '__main__':
    unittest.main()
