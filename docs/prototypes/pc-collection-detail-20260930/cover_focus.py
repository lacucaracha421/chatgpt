"""Where to cut a cover strip: the horizontal centre of the main figure's head (0..1).

Uses only the app's person detector (character-detector.onnx), twice:
1. the most prominent person box on the whole cover;
2. if that figure does not fill the cover width (a close-up is already centred on the face),
   the detector again on the top quarter of the box, where it closes in on head and shoulders.
Falls back to the box centre, then to None (caller uses the middle).
"""
import numpy as np
import runtime

CLOSE_UP_WIDTH = 0.92   # box this wide relative to the cover = close-up; keep the box centre
TOP_PARTS = (0.25, 0.35)
MAX_SECOND_WIDTH = 0.8  # a second box as wide as the crop did not find a head
MIN_SECOND_SCORE = 0.6


def _detect(session, image):
    blob, ratio = runtime.letterbox(image)
    raw = session.run(None, {session.get_inputs()[0].name: blob[None]})[0]
    return runtime.decode(raw, image.size, ratio)


def _best(boxes, scores, size):
    areas = (boxes[:, 2] - boxes[:, 0]) * (boxes[:, 3] - boxes[:, 1]) / (size[0] * size[1])
    index = int(np.argmax(scores * np.sqrt(areas)))
    return boxes[index], float(scores[index])


def cover_focus(session, image):
    width, height = image.size
    boxes, scores = _detect(session, image)
    if not len(boxes):
        return None, "none"
    (x0, y0, x1, y1), _ = _best(boxes, scores, image.size)
    x0, x1 = max(0.0, float(x0)), min(float(width), float(x1))
    box_height = float(y1 - y0)
    centre = (x0 + x1) / 2 / width
    if (x1 - x0) / width >= CLOSE_UP_WIDTH:
        return centre, "close-up"
    for part in TOP_PARTS:
        crop = image.crop((int(x0), int(max(0, y0 - box_height * 0.03)), int(x1), int(min(height, y0 + box_height * part))))
        if min(crop.size) < 32:
            continue
        second, second_scores = _detect(session, crop)
        if not len(second):
            continue
        head, score = _best(second, second_scores, crop.size)
        if score >= MIN_SECOND_SCORE and (head[2] - head[0]) / crop.size[0] <= MAX_SECOND_WIDTH:
            return (x0 + float(head[0] + head[2]) / 2) / width, "head"
    return centre, "body"
