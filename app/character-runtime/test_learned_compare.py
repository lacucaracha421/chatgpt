import unittest
from types import SimpleNamespace
from learned_compare import compare_supported

class LearnedCompareTests(unittest.TestCase):
    def test_human_examples_help_without_padding_votes_or_cross_crop_consensus(self):
        refs=[SimpleNamespace(content_hash=str(i),boxes=[],fallback=False) for i in range(7)]
        class Engine:
            def compare(self, query, group):
                # Base anchors alone fail. Human refs 5/6 both support crop zero.
                rows=[[0.1 if int(r.content_hash)>=5 else 0.4 for r in group],
                      [0.1 if int(r.content_hash)==0 else 0.4 for r in group]]
                return dict(distance=.4,passed=False,bestQueryCrop=0,
                    evidence=[dict(referenceDistances=r) for r in rows])
        result=compare_supported(Engine(),None,refs)
        self.assertTrue(result['passed'])
        self.assertEqual(result['evidence'][0]['matchedReferences'],[5,6])
        self.assertEqual(len(result['evidence'][0]['referenceDistances']),7)
        self.assertEqual(result['learnedReferenceCount'],2)
        self.assertFalse(compare_supported(Engine(),None,refs[:6])['passed'])

    def test_five_anchor_result_is_preserved_and_limits_are_enforced(self):
        refs=[SimpleNamespace(content_hash=str(i)) for i in range(26)]
        class Engine:
            def compare(self, query, refs): return {'distance':.07,'passed':True}
        self.assertEqual(compare_supported(Engine(),None,refs[:5]),{'distance':.07,'passed':True,'learnedReferenceCount':0})
        for invalid in (refs[:4],refs,refs[:5]+refs[:1]):
            with self.assertRaises(ValueError): compare_supported(Engine(),None,invalid)
