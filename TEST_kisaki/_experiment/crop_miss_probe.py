"""Probe whether the two remaining misses are crop-geometry problems."""
import json
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

import analyze
import crop_ccip
import crop_consensus as cc

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
MISS_IDS = [209, 211]
MARGINS = [0.0, 0.08, 0.18, 0.28, 0.40, 0.55]


def square_box(box, size, margin):
    w, h = size; x0, y0, x1, y1 = map(float, box)
    cx = (x0 + x1) / 2; cy = (y0 + y1) / 2
    side = max(x1 - x0, y1 - y0) * (1 + 2 * margin)
    return (max(0, int(round(cx - side/2))), max(0, int(round(cy - side/2))),
            min(w, int(round(cx + side/2))), min(h, int(round(cy + side/2))))


def feature(session, image):
    mean = np.array([.48145466,.4578275,.40821073], dtype=np.float32)[:,None,None]
    std = np.array([.26862954,.26130258,.27577711], dtype=np.float32)[:,None,None]
    arr = np.asarray(image.resize((384,384), Image.Resampling.BILINEAR), dtype=np.float32).transpose(2,0,1)/255
    return session.run(['output'], {'input': ((arr-mean)/std)[None].astype(np.float32)})[0][0]


def main():
    options = ort.SessionOptions(); options.intra_op_num_threads = 4; options.inter_op_num_threads = 1
    feat_session = ort.InferenceSession(str(HERE/'models'/'model_feat.onnx'), sess_options=options,
                                        providers=['CPUExecutionProvider'])
    metric_session = ort.InferenceSession(str(HERE/'models'/'model_metrics.onnx'), sess_options=options,
                                          providers=['CPUExecutionProvider'])
    base_features, _, crop_groups = cc.load_features()
    refs = cc.DATA['referencePool'][:5]
    ref_indices = [idx for rid in refs for idx in crop_groups[rid]]
    ref_slices = []
    cursor = 0
    for rid in refs:
        n = len(crop_groups[rid]); ref_slices.append(list(range(cursor, cursor+n))); cursor += n
    ref_features = base_features[ref_indices]
    out = {'threshold': cc.DATA['threshold'], 'items': {}}
    for item_id in MISS_IDS:
        item = cc.DATA['items'][item_id]; det = cc.CROP['items'][item_id]['detections'][0]
        raw_box = det['box']; image = analyze.rgb(ROOT/item['path'])
        variants = []; labels = []
        for margin in MARGINS:
            for geometry in ('box','square'):
                box = crop_ccip.expanded_box(np.asarray(raw_box), image.size, margin) if geometry=='box' else square_box(raw_box,image.size,margin)
                crop = image.crop(box)
                variants.append(feature(feat_session,crop)); labels.append((geometry,margin,box))
        stack = np.vstack([ref_features, np.stack(variants)]).astype(np.float32)
        raw = metric_session.run(['output'], {'input': stack})[0]
        rows=[]; offset=len(ref_features)
        for j,(geometry,margin,box) in enumerate(labels):
            qi=offset+j; per=[]
            for group in ref_slices: per.append(float(raw[qi,group].min()))
            rows.append({'geometry':geometry,'margin':margin,'box':box,
                         'best':min(per),'consensus2':sorted(per)[1],'perRef':per})
        out['items'][str(item_id)]={'name':item['name'],'rows':rows}
    (HERE/'crop-miss-probe.json').write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(out,ensure_ascii=False,indent=2))


if __name__=='__main__': main()
