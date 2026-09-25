"""Mobile personal Collection edits against real API transactions and disposable data."""
import copy
import json
import threading
import unittest
import uuid
from unittest import mock

from tests import test_mobile_collections as fixtures
import api_auth
import authority
import mobile_collections

api_app, AUTH, work = fixtures.api_app, fixtures.AUTH, fixtures.work

LIBRARY = 'e' * 32
ROUTE = '/v1/collections/personal-edits'


class CollectionPersonalEditTests(unittest.TestCase):
    tearDown = fixtures.MobileCollectionsTests.tearDown

    def setUp(self):
        fixtures.MobileCollectionsTests.setUp(self)
        api_auth.startup(api_app.get_db)
        authority.startup(api_app.get_db)
        with api_app.get_db() as db:
            _, publisher = api_auth.provision_token(db, 'publisher', 'fixture')
            _, client = api_auth.provision_token(db, 'client', 'fixture')
            self.publisher = {'Authorization': 'Bearer ' + publisher}
            self.auth = {'Authorization': 'Bearer ' + client}
            db.execute("INSERT INTO authority_domains VALUES(?,'classifications',1,1,0,?,NULL,'2026')",
                       (LIBRARY, 'a' * 64))
            db.commit()
        first = work('a', '가', 'manga')
        first.update(myScore=3.0, description='PC 메모')
        shown = work('s', '나', 'manga')
        shown.update(showcase=True, showcaseOrder=4)
        self.items = [first, shown, work('m', '다', 'movie')]

    # --- helpers -----------------------------------------------------------------
    def body(self, items=None, cursor=0, base=None, upgraded=True, edit_version=1):
        body = {'version': 1, 'baseRevision': base, 'collections': copy.deepcopy(items or self.items)}
        if upgraded:
            body.update(personalEditVersion=edit_version, libraryId=LIBRARY, personalEditCursor=cursor)
        return body

    def publish(self, body, headers=None):
        return self.client.put('/v1/collections/replica', headers=headers or self.publisher, json=body)

    def status(self):
        return self.client.get('/v1/collections/status', headers=AUTH).json()

    def ready(self, cursor=0, items=None):
        reply = self.publish(self.body(items, cursor, self.status()['revision']))
        self.assertEqual(reply.status_code, 200, reply.text)
        return reply.json()['revision']

    def command(self, field='myScore', value=4.5, expected=3.0, collection='a', **changes):
        return {'version': 1, 'libraryId': LIBRARY, 'operationId': str(uuid.uuid4()),
                'collectionId': collection, 'field': field, 'value': value, 'expected': expected, **changes}

    def edit(self, body, headers=None):
        return self.client.post(ROUTE, headers=headers or self.auth, json=body)

    def detail(self, id='a'):
        return self.client.get('/v1/collections/' + id, headers=AUTH).json()['item']

    def feed(self, **params):
        return self.client.get(ROUTE, headers=self.publisher, params={'libraryId': LIBRARY, **params})

    def code(self, reply):
        return reply.json()['detail']['code']

    # --- tests -------------------------------------------------------------------
    def test_unsupported_until_an_upgraded_pc_publishes(self):
        legacy = self.publish(self.body(upgraded=False), headers=AUTH)
        self.assertEqual(legacy.status_code, 200, legacy.text)
        self.assertEqual(self.status()['capabilities'], {'collectionPersonalEdit': False, 'collectionTrackingEdit': False})
        self.assertNotIn('libraryId', self.status())
        reply = self.edit(self.command())
        self.assertEqual((reply.status_code, self.code(reply)), (409, 'collectionPersonalEditUnsupported'))
        # Bootstrap feed before the state row exists: empty, and nothing beyond 0.
        self.assertEqual(self.feed().json()['items'], [])
        self.assertEqual(self.feed(after=1).status_code, 409)
        self.ready()
        status = self.status()
        self.assertEqual(status['capabilities'], {'collectionPersonalEdit': True, 'collectionTrackingEdit': False})
        self.assertEqual((status['libraryId'], status['personalEditCursor'], status['appliedPersonalEditCursor']),
                         (LIBRARY, 0, 0))

    def test_no_server_library_is_unsupported(self):
        with api_app.get_db() as db:
            db.execute('DELETE FROM authority_domains')
            db.commit()
        reply = self.publish(self.body())
        self.assertEqual((reply.status_code, self.code(reply)), (409, 'collectionPersonalEditUnsupported'))

    def test_auth_roles(self):
        self.ready()
        self.assertEqual(self.client.post(ROUTE, json=self.command()).status_code, 401)
        # The shared token is an ordinary client credential here.
        self.assertEqual(self.edit(self.command(), headers=AUTH).status_code, 200)
        for headers in ({}, AUTH, self.auth):
            self.assertEqual(self.client.get(ROUTE, headers=headers, params={'libraryId': LIBRARY}).status_code, 401)
        # The handshake needs the publisher role; the legacy token cannot send it.
        for headers in (AUTH, self.auth):
            self.assertEqual(self.publish(self.body(cursor=1, base=self.status()['revision']), headers=headers).status_code, 401)

    def test_replica_role_is_decided_before_the_body_is_read(self):
        # A client-role token is refused before the server buffers an oversized body.
        huge = b'{' + b' ' * (13 * 1024 * 1024) + b'}'
        for headers in ({}, self.auth, {'Authorization': 'Bearer nope'}):
            reply = self.client.put('/v1/collections/replica', headers=headers, content=huge)
            self.assertEqual(reply.status_code, 401)
        # Allowed callers still reach the size limit and snapshot validation.
        for headers in (AUTH, self.publisher):
            self.assertEqual(self.client.put('/v1/collections/replica', headers=headers, content=huge).status_code, 413)
        # Parsing and validation run in the threadpool, not on the event loop.
        threads = []
        original = mobile_collections.Replica.model_validate_json
        def recording(*args, **kwargs):
            threads.append(threading.current_thread().name)
            return original(*args, **kwargs)
        with mock.patch.object(mobile_collections.Replica, 'model_validate_json', side_effect=recording):
            self.ready()
            legacy = self.publish(self.body(upgraded=False, base=self.status()['revision']), headers=AUTH)
            self.assertEqual(legacy.status_code, 409)
        self.assertEqual(len(threads), 2)
        self.assertTrue(all(name.startswith('AnyIO worker thread') for name in threads), threads)
        # The publisher token cannot send the legacy form (it is not the shared token).
        self.assertEqual(self.publish(self.body(upgraded=False, base=self.status()['revision'])).status_code, 401)

    def test_accept_patches_row_bumps_revision_and_replays(self):
        old = self.ready()
        request = self.command()
        reply = self.edit(request)
        self.assertEqual(reply.status_code, 200, reply.text)
        receipt = reply.json()
        self.assertEqual({k: receipt[k] for k in ('version', 'operationId', 'collectionId', 'field', 'value', 'sequence', 'changed')},
                         {'version': 1, 'operationId': request['operationId'], 'collectionId': 'a',
                          'field': 'myScore', 'value': 4.5, 'sequence': 1, 'changed': True})
        self.assertNotEqual(receipt['revision'], old)
        self.assertEqual(self.status()['revision'], receipt['revision'])
        self.assertEqual(self.status()['personalEditCursor'], 1)
        self.assertEqual(self.detail()['myScore'], 4.5)
        self.assertEqual([i['id'] for i in self.listing(rating='4.5').json()['items']], ['a'])
        self.assertEqual(self.listing(rating='3').json()['items'], [])
        # Response-lost retry: the same receipt, no second log row, no revision change.
        self.assertEqual(self.edit(request).json(), receipt)
        self.assertEqual(self.status()['revision'], receipt['revision'])
        with api_app.get_db() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM mobile_collection_edits').fetchone()[0], 1)
        reused = self.edit({**request, 'value': 5})
        self.assertEqual((reused.status_code, self.code(reused)), (409, 'operationConflict'))

    def listing(self, **params):
        return self.client.get('/v1/collections', headers=AUTH, params=params)

    def test_unchanged_value_is_a_receipt_without_log_or_revision(self):
        revision = self.ready()
        request = self.command(value=3, expected=1.0)
        receipt = self.edit(request).json()
        self.assertEqual((receipt['changed'], receipt['sequence'], receipt['revision']), (False, None, revision))
        self.assertEqual(self.edit(request).json(), receipt)
        self.assertEqual(self.code(self.edit({**request, 'value': 2})), 'operationConflict')
        self.assertEqual(self.feed().json()['items'], [])
        self.assertEqual(self.status()['revision'], revision)

    def test_conflict_reports_current_without_receipt(self):
        self.ready()
        request = self.command(expected=2.0)
        reply = self.edit(request)
        self.assertEqual(reply.status_code, 409)
        self.assertEqual(reply.json()['detail']['code'], 'collectionPersonalConflict')
        self.assertEqual(reply.json()['detail']['current'], 3.0)
        # No receipt: the same operation id rebased onto `current` is accepted.
        rebased = self.edit({**request, 'expected': 3.0})
        self.assertEqual(rebased.status_code, 200, rebased.text)
        memo = self.edit(self.command('memo', '새 메모', '예전 메모'))
        self.assertEqual(memo.json()['detail'], {'code': 'collectionPersonalConflict', 'message': memo.json()['detail']['message'],
                                                 'current': 'PC 메모'})

    def test_published_memo_with_surrounding_whitespace_does_not_conflict_forever(self):
        padded = copy.deepcopy(self.items)
        padded[0]['description'] = '  PC 메모  '
        self.ready(items=padded)
        reply = self.edit(self.command('memo', '새 메모', 'PC 메모'))
        self.assertEqual(reply.status_code, 200, reply.text)
        self.assertEqual(self.detail()['description'], '새 메모')
        stale = self.edit(self.command('memo', '다른 메모', '예전 메모'))
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.json()['detail']['current'], '새 메모')

    def test_validation_matches_pc(self):
        self.ready()
        for field, value, expected in [('myScore', 5.5, 3.0), ('myScore', -0.5, 3.0), ('myScore', 2.25, 3.0),
                                       ('myScore', True, 3.0), ('myScore', '4', 3.0), ('showcase', 1, False),
                                       ('showcase', None, False), ('memo', 3, 'PC 메모'), ('memo', 'x' * 2001, 'PC 메모'),
                                       ('rating', 4.0, 3.0), ('myScore', 10 ** 400, 3.0), ('myScore', 4.0, 10 ** 400),
                                       ('myScore', -(10 ** 400), 3.0)]:
            reply = self.edit(self.command(field, value, expected))
            self.assertEqual(reply.status_code, 422, (field, value))
            self.assertEqual(self.code(reply), 'invalidCollectionPersonalEdit')
        for broken in ({'operationId': 'not-a-uuid-but-36-characters-long!!!'}, {'extra': 1}, {'version': 2},
                       {'collectionId': '../a'}):
            self.assertEqual(self.edit({**self.command(), **broken}).status_code, 422)
        missing = self.command(); missing.pop('expected')
        self.assertEqual(self.edit(missing).status_code, 422)
        self.assertEqual(self.client.post(ROUTE, headers=self.auth, content=b'{' + b' ' * 40000 + b'}').status_code, 413)
        # 0 is a real rating, and a Hangul memo at the limit fits the body cap.
        self.assertEqual(self.edit(self.command(value=0)).json()['value'], 0.0)
        self.assertEqual(self.edit(self.command(value=None, expected=0)).json()['value'], None)
        long = '가' * 2000
        self.assertEqual(self.edit(self.command('memo', '  ' + long + '  ', 'PC 메모')).json()['value'], long)
        self.assertEqual(self.edit(self.command('memo', '   ', long)).json()['value'], None)
        self.assertIsNone(self.detail()['description'])
        with api_app.get_db() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM mobile_collection_edits').fetchone()[0], 4)

    def test_library_mismatch_and_missing_collection(self):
        self.ready()
        reply = self.edit(self.command(libraryId='f' * 32))
        self.assertEqual((reply.status_code, self.code(reply)), (409, 'libraryMismatch'))
        self.assertEqual(self.code(self.feed(libraryId='f' * 32)), 'libraryMismatch')
        wrong = self.publish(self.body(base=self.status()['revision']) | {'libraryId': 'f' * 32})
        self.assertEqual((wrong.status_code, self.code(wrong)), (409, 'libraryMismatch'))
        missing = self.edit(self.command(collection='gone'))
        self.assertEqual((missing.status_code, self.code(missing)), (404, 'collectionNotFound'))

    def test_showcase_membership_and_memo_reach_list_and_detail(self):
        self.ready()
        on = self.edit(self.command('showcase', True, False))
        self.assertEqual(on.status_code, 200, on.text)
        self.assertEqual([i['id'] for i in self.listing(type='manga', showcase='true').json()['items']], ['s', 'a'])
        self.assertEqual((self.detail()['showcase'], self.detail()['showcaseOrder']), (True, 5))
        off = self.edit(self.command('showcase', False, True, collection='s'))
        self.assertEqual(off.status_code, 200, off.text)
        self.assertEqual((self.detail('s')['showcase'], self.detail('s')['showcaseOrder']), (False, None))
        self.assertEqual([i['id'] for i in self.listing(type='manga', showcase='true').json()['items']], ['a'])
        # First Showcase member of a type starts at 0, as on the PC.
        self.assertEqual(self.edit(self.command('showcase', True, False, collection='m')).status_code, 200)
        self.assertEqual(self.detail('m')['showcaseOrder'], 0)
        memo = self.edit(self.command('memo', '모바일 메모', 'PC 메모', collection='a'))
        self.assertEqual(memo.status_code, 200, memo.text)
        self.assertEqual(self.detail()['description'], '모바일 메모')
        self.assertEqual(self.listing(type='manga').json()['items'][0]['description'], '모바일 메모')
        with api_app.get_db() as db:
            row = db.execute("SELECT showcase,showcase_order,payload FROM mobile_collections WHERE id='a'").fetchone()
        self.assertEqual((row[0], row[1], json.loads(row[2])['showcaseOrder']), (1, 5, 5))

    def test_change_feed_pages_in_order(self):
        self.ready()
        one = self.edit(self.command()).json()
        two = self.edit(self.command('memo', None, 'PC 메모')).json()
        page = self.feed(after=0, limit=1).json()
        self.assertEqual((page['nextCursor'], page['hasMore'], page['after']), (1, True, 0))
        self.assertEqual({k: page['items'][0][k] for k in ('sequence', 'operationId', 'collectionId', 'field', 'value', 'previous')},
                         {'sequence': 1, 'operationId': one['operationId'], 'collectionId': 'a', 'field': 'myScore',
                          'value': 4.5, 'previous': 3.0})
        rest = self.feed(after=1, limit=1).json()
        self.assertEqual((rest['items'][0]['operationId'], rest['items'][0]['value'], rest['items'][0]['previous']),
                         (two['operationId'], None, 'PC 메모'))
        self.assertFalse(rest['hasMore'])
        self.assertEqual(self.feed(after=2).json()['items'], [])
        for after in (-1, 3, 10 ** 30):
            self.assertGreaterEqual(self.feed(after=after).status_code, 400)
        self.assertEqual(self.feed(limit=101).status_code, 422)

    def test_overlay_survives_stale_publication_then_cursor_fences(self):
        self.ready()
        rating = self.edit(self.command()).json()
        showcase = self.edit(self.command('showcase', True, False)).json()
        # The PC has received nothing: its snapshot still carries the old values.
        stale = self.publish(self.body(cursor=0, base=self.status()['revision']))
        self.assertEqual(stale.status_code, 200, stale.text)
        item = self.detail()
        self.assertEqual((item['myScore'], item['showcase'], item['showcaseOrder']), (4.5, True, 5))
        self.assertEqual(self.status()['appliedPersonalEditCursor'], 0)
        # Received only the first edit: the second is still re-applied.
        partial = copy.deepcopy(self.items); partial[0]['myScore'] = 4.5
        self.assertEqual(self.publish(self.body(partial, 1, self.status()['revision'])).status_code, 200)
        self.assertEqual((self.detail()['myScore'], self.detail()['showcase']), (4.5, True))
        # Received everything, and the PC has since changed the rating itself.
        applied = copy.deepcopy(partial); applied[0].update(myScore=2.0, showcase=True, showcaseOrder=9)
        revision = self.publish(self.body(applied, 2, self.status()['revision'])).json()['revision']
        self.assertEqual((self.detail()['myScore'], self.detail()['showcaseOrder']), (2.0, 9))
        self.assertEqual(self.status()['appliedPersonalEditCursor'], 2)
        # A retry of an applied edit still returns its receipt and does not re-apply.
        self.assertEqual(self.edit({**self.command(), 'operationId': rating['operationId'], 'value': 4.5, 'expected': 3.0}).json(), rating)
        self.assertEqual(self.detail()['myScore'], 2.0)
        self.assertEqual(showcase['sequence'], 2)
        # Guard: below the applied floor and beyond the log ceiling are both refused.
        for cursor in (1, 3):
            reply = self.publish(self.body(applied, cursor, revision))
            self.assertEqual((reply.status_code, self.code(reply)), (409, 'collectionPersonalEditCursorRejected'))
        self.assertEqual(self.status()['revision'], revision)

    def test_legacy_writer_rejected_once_state_exists(self):
        self.ready()
        legacy = self.publish(self.body(upgraded=False, base=self.status()['revision']), headers=AUTH)
        self.assertEqual((legacy.status_code, self.code(legacy)), (409, 'collectionPersonalEditUnsupported'))
        partial = self.body(base=self.status()['revision']); partial.pop('personalEditCursor')
        self.assertEqual(self.publish(partial).status_code, 422)

    def test_same_snapshot_revision_moves_with_pending_edits(self):
        first = self.ready()
        self.edit(self.command())
        second = self.publish(self.body(cursor=0, base=self.status()['revision'])).json()['revision']
        self.assertNotEqual(first, second)

    def test_edit_revision_bump_keeps_artwork_tickets(self):
        item, media = fixtures.MobileCollectionsTests.with_art(self)
        item['id'] = 'a'
        fixtures.fake_s3.objects[media['objectKey']] = {'body': b'image', 'content_type': 'image/webp'}
        self.ready(items=[item])
        self.assertEqual(self.edit(self.command(expected=None)).status_code, 200)
        ticket = self.client.post('/v1/collections/a/artworks/cover/media-ticket', headers=AUTH, json={'variant': 'thumbnail'})
        self.assertEqual(ticket.status_code, 200, ticket.text)
        self.assertEqual(ticket.json()['sha256'], media['sha256'])
        self.assertEqual(self.detail()['artworks'][0]['thumbnailDigest'], media['sha256'])


class CollectionTrackingEditTests(unittest.TestCase):
    """Personal-edit version 2: release watch and owned-volume counts for manga."""
    base = CollectionPersonalEditTests
    tearDown = base.tearDown
    body, publish, status, ready = base.body, base.publish, base.status, base.ready
    command, edit, detail, feed, code = base.command, base.edit, base.detail, base.feed, base.code

    def setUp(self):
        self.base.setUp(self)
        tracked = self.items[0]
        tracked.update(releaseWatch={'enabled': False, 'available': True},
                       ownedVolumes=[{'editionIndex': 2, 'count': 1}, {'editionIndex': 0, 'count': 3}])
        self.items[1]['releaseWatch'] = {'enabled': False, 'available': False}

    def ready2(self, cursor=0):
        reply = self.publish(self.body(cursor=cursor, base=self.status()['revision'], edit_version=2))
        self.assertEqual(reply.status_code, 200, reply.text)
        return reply.json()['revision']

    def watch(self, value=True, expected=False, collection='a'):
        return self.command('releaseWatch', value, expected, collection)

    def owned(self, edition=0, count=5, expected=3, collection='a'):
        return self.command('ownedVolumes', {'editionIndex': edition, 'count': count},
                            {'editionIndex': edition, 'count': expected}, collection)

    def test_payload_keys_are_stored_sorted_and_absent_when_not_sent(self):
        self.ready2()
        self.assertEqual(self.detail()['ownedVolumes'], [{'editionIndex': 0, 'count': 3}, {'editionIndex': 2, 'count': 1}])
        movie = self.detail('m')
        self.assertNotIn('releaseWatch', movie)
        self.assertNotIn('ownedVolumes', movie)
        duplicate = copy.deepcopy(self.items)
        duplicate[0]['ownedVolumes'] = [{'editionIndex': 0, 'count': 1}, {'editionIndex': 0, 'count': 2}]
        self.assertEqual(self.publish(self.body(duplicate, base=self.status()['revision'], edit_version=2)).status_code, 422)
        bad = copy.deepcopy(self.items)
        bad[0]['ownedVolumes'] = [{'editionIndex': 4, 'count': 1}]
        self.assertEqual(self.publish(self.body(bad, base=self.status()['revision'], edit_version=2)).status_code, 422)

    def test_version_one_pc_cannot_receive_tracking_edits(self):
        self.ready()
        self.assertFalse(self.status()['capabilities']['collectionTrackingEdit'])
        reply = self.edit(self.watch())
        self.assertEqual((reply.status_code, self.code(reply)), (409, 'collectionPersonalEditUnsupported'))
        self.ready2()
        self.assertTrue(self.status()['capabilities']['collectionTrackingEdit'])
        self.assertEqual(self.edit(self.watch()).status_code, 200)
        # A version-1 PC reading the log fails closed instead of skipping the entry.
        reply = self.feed()
        self.assertEqual((reply.status_code, self.code(reply)), (409, 'collectionPersonalEditUpgradeRequired'))
        self.assertEqual(self.feed(editVersion=2).status_code, 200)
        # A version-1 publication turns the capability off again.
        self.publish(self.body(cursor=1, base=self.status()['revision']))
        self.assertFalse(self.status()['capabilities']['collectionTrackingEdit'])
        self.assertEqual(self.code(self.edit(self.watch(False, True))), 'collectionPersonalEditUnsupported')

    def test_release_watch_edit(self):
        old = self.ready2()
        reply = self.edit(self.watch())
        self.assertEqual(reply.status_code, 200, reply.text)
        self.assertEqual((reply.json()['value'], reply.json()['changed']), (True, True))
        self.assertEqual(self.detail()['releaseWatch'], {'enabled': True, 'available': True})
        self.assertNotEqual(self.status()['revision'], old)
        # Same value again is a no-op; a stale expectation conflicts with the current value.
        self.assertFalse(self.edit(self.watch()).json()['changed'])
        conflict = self.edit(self.watch(False, False))
        self.assertEqual((conflict.status_code, self.code(conflict), conflict.json()['detail']['current']),
                         (409, 'collectionPersonalConflict', True))
        items = self.feed(editVersion=2).json()['items']
        self.assertEqual([(i['field'], i['value'], i['previous']) for i in items], [('releaseWatch', True, False)])

    def test_release_watch_unavailable_and_non_manga(self):
        self.ready2()
        self.assertEqual(self.code(self.edit(self.watch(collection='s'))), 'releaseWatchUnavailable')
        self.assertEqual(self.edit(self.watch(False, False, collection='s')).json()['changed'], False)
        self.assertEqual(self.code(self.edit(self.watch(collection='m'))), 'collectionTrackingUnavailable')
        self.assertEqual(self.code(self.edit(self.owned(collection='s'))), 'collectionTrackingUnavailable')

    def test_owned_volume_count_edit(self):
        self.ready2()
        self.assertEqual(self.edit(self.owned()).status_code, 200)
        # An untracked edition is expected as null.
        self.assertEqual(self.edit(self.owned(edition=1, count=0, expected=None)).status_code, 200)
        self.assertEqual(self.detail()['ownedVolumes'], [
            {'editionIndex': 0, 'count': 5}, {'editionIndex': 1, 'count': 0}, {'editionIndex': 2, 'count': 1}])
        conflict = self.edit(self.owned(count=7, expected=3))
        self.assertEqual((self.code(conflict), conflict.json()['detail']['current']),
                         ('collectionPersonalConflict', {'editionIndex': 0, 'count': 5}))
        items = self.feed(editVersion=2).json()['items']
        self.assertEqual(items[0]['value'], {'editionIndex': 0, 'count': 5})
        self.assertEqual(items[1]['previous'], {'editionIndex': 1, 'count': None})
        for command in (self.owned(count=2001), self.owned(edition=4), self.owned(count=True),
                        self.command('ownedVolumes', {'editionIndex': 0, 'count': 1}, {'editionIndex': 1, 'count': 3}),
                        self.command('ownedVolumes', {'editionIndex': 0, 'count': None}, {'editionIndex': 0, 'count': 3}),
                        self.command('ownedVolumes', 3, 3), self.command('releaseWatch', 1, False)):
            self.assertEqual(self.code(self.edit(command)), 'invalidCollectionPersonalEdit', command)

    def test_stale_snapshot_reapplies_tracking_edits(self):
        self.ready2()
        self.edit(self.watch())
        self.edit(self.owned())
        self.ready2(cursor=0)
        self.assertEqual(self.detail()['releaseWatch']['enabled'], True)
        self.assertEqual(self.detail()['ownedVolumes'][0], {'editionIndex': 0, 'count': 5})
        # After the PC applied them, its publication is authoritative (e.g. it could not enable).
        self.ready2(cursor=2)
        self.assertEqual(self.detail()['releaseWatch']['enabled'], False)

    def test_replay_never_shows_watching_when_unavailable(self):
        self.ready2()
        self.assertEqual(self.edit(self.watch()).status_code, 200)
        # The PC lost the binding before applying the edit: a stale snapshot replays it.
        items = copy.deepcopy(self.items)
        items[0]['releaseWatch'] = {'enabled': False, 'available': False}
        self.assertEqual(self.publish(self.body(items, cursor=0, base=self.status()['revision'],
                                                edit_version=2)).status_code, 200)
        self.assertEqual(self.detail()['releaseWatch'], {'enabled': False, 'available': False})

    def test_state_table_migration(self):
        import collection_personal_edits as personal_edits
        with api_app.get_db() as db:
            db.execute('DROP TABLE mobile_collection_edit_state')
            db.execute("""CREATE TABLE mobile_collection_edit_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1),
                library_id TEXT NOT NULL, applied_cursor INTEGER NOT NULL DEFAULT 0,
                last_sequence INTEGER NOT NULL DEFAULT 0)""")
            db.execute("INSERT INTO mobile_collection_edit_state VALUES(1,?,0,0)", (LIBRARY,))
            personal_edits.migrate(db)
            personal_edits.migrate(db)
            db.commit()
        self.assertFalse(self.status()['capabilities']['collectionTrackingEdit'])
        self.ready2()
        self.assertTrue(self.status()['capabilities']['collectionTrackingEdit'])


if __name__ == '__main__':
    unittest.main()
