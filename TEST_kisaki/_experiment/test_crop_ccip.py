import unittest
import numpy as np
from PIL import Image
import crop_ccip


class CropCcipHelpersTest(unittest.TestCase):
    def test_expanded_box_clamps_to_image(self):
        box = np.array([10, 20, 90, 80], dtype=np.float32)
        self.assertEqual(crop_ccip.expanded_box(box, (100, 100), 0.25), (0, 5, 100, 95))

    def test_nms_keeps_best_overlapping_box(self):
        boxes = np.array([[0, 0, 50, 50], [2, 2, 48, 48], [70, 70, 90, 90]], dtype=np.float32)
        scores = np.array([0.9, 0.8, 0.7], dtype=np.float32)
        self.assertEqual(crop_ccip.nms(boxes, scores, 0.45), [0, 2])

    def test_aggregate_takes_minimum_variant_distance(self):
        raw = np.array([
            [0, .2, .7, .8],
            [.2, 0, .1, .6],
            [.7, .1, 0, .3],
            [.8, .6, .3, 0],
        ], dtype=np.float32)
        result = crop_ccip.aggregate(raw, [[0, 1], [2, 3]])
        self.assertAlmostEqual(float(result[0, 1]), .1, places=6)

    def test_letterbox_shape(self):
        image = Image.new('RGB', (320, 160), 'white')
        blob, ratio = crop_ccip.letterbox_bgr(image)
        self.assertEqual(blob.shape, (3, 640, 640))
        self.assertEqual(ratio, 2.0)

    def test_exploratory_calibration_marks_same_data_only(self):
        matrix = np.ones((7, 7), dtype=np.float32)
        np.fill_diagonal(matrix, 0)
        matrix[5, :5] = matrix[:5, 5] = .1
        matrix[6, :5] = matrix[:5, 6] = .2
        data = {
            'referencePool': [0, 1, 2, 3, 4],
            'items': [
                {'id': i, 'positive': i != 6, 'duplicateGroup': i}
                for i in range(7)
            ],
        }
        result = crop_ccip.exploratory_calibration(matrix, data)
        self.assertTrue(result['sameDataExploratoryOnly'])
        self.assertEqual(result['zeroFalsePositive']['truePositive'], 1)
        self.assertEqual(result['zeroFalsePositive']['falsePositive'], 0)


if __name__ == '__main__':
    unittest.main()
