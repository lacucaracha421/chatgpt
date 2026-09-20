"""HTTP/cursor coverage for device-local Catalog settings; all data is synthetic."""
import base64
import hashlib
import hmac
import json
import unittest
from urllib.parse import urlencode

from tests import test_mobile_catalog as base
import mobile_catalog_replica as replica
from mobile_catalog import MAX_FILTER_BYTES, MAX_QUERY_BYTES, normalize, parse_categories, parse_excluded_tags
from fastapi import HTTPException

AUTH = base.AUTH


class MobileCatalogDeviceFilterApiTests(unittest.TestCase):
    setUp = base.MobileCatalogApiTests.setUp
    tearDown = base.MobileCatalogApiTests.tearDown
    search = base.MobileCatalogApiTests.search

    def publish(self):
        result = base.MobileCatalogApiTests.publish(self)
        self.assertEqual(result.status_code, 200, result.text)
        return result.json()

    def page(self, **params):
        response = self.search(**params)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def count(self, page):
        response = self.client.get('/v1/mobile-catalog/count', headers=AUTH, params={'token': page['countToken']})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()['totalCount']

    def test_capability_and_all_none_multi_category(self):
        self.publish()
        status = self.client.get('/v1/mobile-catalog/status', headers=AUTH).json()
        self.assertEqual(status['capabilities']['displayPreferencesVersion'], 1)
        self.assertEqual(self.page(limit=100)['totalCount'], 3)
        for categories, expected in (([], []), ([2, 3], ['g1']), ([1], ['g3', 'g1', 'g6'])):
            page = self.page(categories=json.dumps(categories), limit=100)
            self.assertEqual([item['groupId'] for item in page['items']], expected)
            self.assertEqual(page['countStatus'], 'pending')
            self.assertEqual(self.count(page), len(expected))

    def test_filters_bind_count_cursor_detail_reader_and_editions(self):
        self.publish()
        page = self.page(categories='[1]', limit=1)
        self.assertEqual([item['groupId'] for item in page['items']], ['g3'])
        self.assertEqual(self.count(page), 3)
        next_page = self.client.get('/v1/mobile-catalog/search', headers=AUTH, params={'cursor': page['nextCursor']})
        self.assertEqual(next_page.status_code, 200, next_page.text)
        self.assertEqual([item['groupId'] for item in next_page.json()['items']], ['g1'])
        context = {'context': page['context']}
        for suffix in ('', '/reader'):
            response = self.client.get('/v1/mobile-catalog/works/kHentai/2' + suffix, headers=AUTH, params=context)
            self.assertEqual(response.status_code, 404, response.text)
        editions = self.client.get('/v1/mobile-catalog/groups/kHentai/g1/editions', headers=AUTH, params=context)
        self.assertEqual(editions.status_code, 200, editions.text)
        self.assertEqual([item['providerWorkId'] for item in editions.json()['items']], ['1'])
        self.assertEqual(editions.json()['totalCount'], 1)
        excluded = self.page(excludedTags='[{"namespace":"artist","value":"foo"}]')
        self.assertEqual([item['groupId'] for item in excluded['items']], ['g1', 'g6'])
        self.assertEqual(self.count(excluded), 2)
        response = self.client.get('/v1/mobile-catalog/works/kHentai/1', headers=AUTH, params={'context': excluded['context']})
        self.assertEqual(response.status_code, 404)

    def test_device_exclusion_is_not_bypassed_by_reveal_and_does_not_write_policy(self):
        self.publish()
        before = self.client.get('/v1/mobile-catalog/status', headers=AUTH).json()['publicationRevision']
        page = self.page(revealBlocked='true', excludedTags='[{"namespace":"artist","value":"blocked"}]')
        self.assertEqual([item['groupId'] for item in page['items']], ['g4', 'g1', 'g3', 'g6'])
        with self.get_db() as db:
            current = replica.current(db)
            users = json.loads(db.execute('SELECT payload FROM mobile_catalog_users WHERE revision=?', [current['user_revision']]).fetchone()[0])
        self.assertEqual(current['revision'], before)
        self.assertEqual(users['hiddenCategories'], self.users['hiddenCategories'])
        self.assertEqual(users['blockedTags'], self.users['blockedTags'])

    def test_filtered_requests_bypass_prepared_pages_and_counts(self):
        self.publish()
        with replica.open_publication(self.root / 'artifacts', self.get_db) as (db, _):
            for extra in ({'categories': []}, {'categories': [2]}, {'excludedTags': [('artist', 'foo')]}):
                query = {'language': 'all', 'revealBlocked': False, 'text': '', 'scope': 'all', 'sort': 'latest', **extra}
                self.assertIsNone(replica.prepared_count(db, query))
                self.assertIsNone(replica.prepared_items(db, query, 0, 40, 1))
        page = self.page(categories='[2]')
        self.assertEqual([item['groupId'] for item in page['items']], ['g1'])
        self.assertEqual(self.count(page), 1)

    def test_space_and_underscore_search_through_real_routes(self):
        records = [json.loads(line) for line in self.data.splitlines()]
        for work_id, value in ((2, 'john doe'), (3, 'john_doe')):
            records.append({'kind': 'tag', 'value': {'WorkId': work_id, 'Namespace': 'artist', 'Value': value}})
            records[0]['value']['counts']['tag'] += 1
        self.data = b''.join((replica.encode(record) + '\n').encode() for record in records)
        self.digest = hashlib.sha256(self.data).hexdigest()
        self.publish()
        for text in ('john doe', 'john_doe', 'artist:john doe', 'artist:john_doe', 'artist:"john doe"'):
            page = self.page(text=text, searchMode='mobile', limit=1)
            self.assertEqual([item['providerWorkId'] for item in page['items']], ['2'], text)
            self.assertEqual(self.count(page), 2)
            next_page = self.client.get('/v1/mobile-catalog/search', headers=AUTH, params={'cursor': page['nextCursor']})
            self.assertEqual(next_page.status_code, 200, next_page.text)
            self.assertEqual([item['providerWorkId'] for item in next_page.json()['items']], ['3'])
        self.assertEqual(self.page(text='artist:john doe')['items'], [])
        self.assertEqual([item['providerWorkId'] for item in self.page(text='artist:john_doe')['items']], ['3'])

    def test_old_signed_count_tokens_still_apply_text(self):
        self.publish()
        page = self.page(text='alpha')
        encoded = page['countToken'].split('.')[0]
        payload = json.loads(base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4)))
        for key in ('categories', 'excludedTags', 'searchMode'):
            payload['query'].pop(key, None)
        encoded = base64.urlsafe_b64encode(replica.encode(payload).encode()).decode().rstrip('=')
        signature = hmac.new(b'catalog-test', encoded.encode(), hashlib.sha256).hexdigest()
        self.assertEqual(self.count({'countToken': encoded + '.' + signature}), 2)

    def test_large_accepted_query_tokens_fit_native_paths_and_round_trip(self):
        self.publish()
        tags = [{'namespace': 'a', 'value': str(n)} for n in range(64)]
        # A long valid branch keeps matches, while exercising a near-budget payload.
        text = 'alpha OR "' + 'z' * 3100 + '"'
        page = self.page(text=text, excludedTags=replica.encode(tags), searchMode='mobile', limit=1)
        self.assertEqual(self.count(page), 2)
        for token in (page['context'], page['countToken'], page['nextCursor']):
            self.assertLess(len(token), 12000)
        path = '/v1/mobile-catalog/groups/kHentai/g1/editions?' + urlencode({'context': page['context'], 'cursor': page['nextCursor']})
        self.assertLess(len(path), 16384)
        response = self.client.get('/v1/mobile-catalog/works/kHentai/1', headers=AUTH, params={'context': page['context']})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.search(text='a' * 4096, excludedTags=replica.encode(tags), searchMode='mobile').status_code, 422)

    def test_rejected_parameters_return_clear_status(self):
        self.publish()
        for params in ({'categories': 'null'}, {'categories': '[true]'}, {'categories': '[12]'},
                       {'excludedTags': '[{"namespace":"Artist","value":"x"}]'},
                       {'excludedTags': '[' + ' ' * MAX_FILTER_BYTES + ']'}, {'searchMode': 'exact'}, {'unknown': '1'}):
            self.assertEqual(self.search(**params).status_code, 400, params)
        for text in ('a' * 4097, 'a ' * 257, 'alpha OR'):
            self.assertEqual(self.search(text=text, searchMode='mobile').status_code, 422)


class FilterParameterTests(unittest.TestCase):
    def test_category_validation(self):
        self.assertEqual(parse_categories('[1,2,2]'), [1, 2])
        self.assertEqual(parse_categories('[]'), [])
        for raw in ('1', '[1', 'null', '{}', '[0]', '[12]', '["1"]', '[true]', '[1.0]'):
            self.assertIsNone(parse_categories(raw), raw)

    def test_exact_tag_validation_and_bounds(self):
        self.assertEqual(parse_excluded_tags('[{"namespace":"female","value":"scat"}]'), [('female', 'scat')])
        self.assertEqual(parse_excluded_tags('[{"namespace":"a","value":"b"},{"namespace":"a","value":"b"}]'), [('a', 'b')])
        for item in ({'namespace': 'Artist', 'value': 'x'}, {'namespace': 'a' * 33, 'value': 'x'},
                     {'namespace': 'a', 'value': ''}, {'namespace': 'a', 'value': '가' * 67},
                     {'namespace': 'a', 'value': 'line\nbreak'}, {'namespace': 'a', 'value': 'x', 'extra': 1}):
            self.assertIsNone(parse_excluded_tags(replica.encode([item])))
        for count, accepted in ((64, True), (65, False)):
            raw = replica.encode([{'namespace': 'a', 'value': str(n)} for n in range(count)])
            self.assertLessEqual(len(raw.encode()), MAX_FILTER_BYTES)
            self.assertEqual(parse_excluded_tags(raw) is not None, accepted)
        self.assertIsNotNone(parse_excluded_tags(replica.encode([{'namespace': 'a' * 32, 'value': '가' * 66}])))

    def test_normalized_query_budget_is_enforced(self):
        self.assertEqual(MAX_QUERY_BYTES, 4500)
        self.assertEqual(len(normalize({'text': 'x' * 4096})['text']), 4096)
        with self.assertRaises(HTTPException) as error:
            normalize({'text': 'x' * 4096, 'excludedTags': replica.encode([{'namespace': 'a', 'value': str(n) + 'y' * 199} for n in range(3)])})

        self.assertEqual(error.exception.status_code, 422)


if __name__ == '__main__':
    unittest.main()
