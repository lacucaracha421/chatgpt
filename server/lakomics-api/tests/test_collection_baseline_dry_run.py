"""Offline harness diagnostics use only in-memory databases."""
import copy
import json
from pathlib import Path
import unittest

from tools import collection_baseline_dry_run as harness

FIXTURES = Path(__file__).resolve().parents[3] / 'tests/fixtures/collection-authority'


class CollectionBaselineDryRunTests(unittest.TestCase):
    def setUp(self):
        self.doc = json.loads((FIXTURES / 'staging-v2-example.json').read_text('utf-8'))
        self.legacy = json.loads((FIXTURES / 'legacy-v2-example.json').read_text('utf-8'))

    def test_simulated_publication_uses_real_verify_projection(self):
        self.doc['bindings'].append(dict(workId='game-work', provider='steam', externalId='570',
                                        config=None, snapshot=None, values=None, lastSyncedAt=None))
        result = harness.run(self.doc, self.legacy)
        self.assertEqual(result['problemCount'], 0, result)
        self.assertEqual(result['verification']['verdict'], 'lossless', result)

    def test_empty_server_reports_its_limits_without_assuming_receipts(self):
        result = harness.run(self.doc)
        self.assertEqual(result['verification']['verdict'], 'blocked')
        self.assertFalse(result['verification']['bindings']['legacyRevision']['ok'])
        self.assertGreater(result['verification']['artworks']['unconfirmedBlobs'], 0)

    def test_all_bad_rows_and_independent_relationships_are_reported(self):
        self.doc['bindings'].extend([
            dict(workId='game-work', provider='unknown', externalId='1', config=None,
                 snapshot=None, values=None, lastSyncedAt=None),
            dict(workId='game-work', provider='steam', externalId='bad', config=None,
                 snapshot=None, values=None, lastSyncedAt=None)])
        for art in self.doc['artworks'][:2]:
            art['selected'] = not art['selected']
        self.doc['works'][0]['showcaseOrder'] = 9
        before = copy.deepcopy(self.doc)
        result = harness.run(self.doc)
        samples = [s for group in result['problemsByKind'].values() for s in group['samples']]
        self.assertTrue(any(s.get('provider') == 'unknown' for s in samples), result)
        self.assertTrue(any(s.get('provider') == 'steam' for s in samples), result)
        self.assertTrue(any(k.startswith('artworkSelection:') for k in result['problemsByKind']), result)
        self.assertGreaterEqual(result['problemCount'], 5, result)
        self.assertEqual(self.doc, before)
