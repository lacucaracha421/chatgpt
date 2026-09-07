"""Throwaway local CCIP experiment. Input files are read only."""
import hashlib
import json
import random
import time
import urllib.request
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
MODEL = 'ccip-caformer_b36-24'
REPO = 'deepghs/ccip_onnx'
EXT = {'.jpg', '.jpeg', '.jfif', '.png', '.webp', '.bmp', '.gif'}


def sha(path):
    return hashlib.file_digest(path.open('rb'), 'sha256').hexdigest()


def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'MarcusLocalExperiment/1.0'}), timeout=120)


def models():
    folder = HERE / 'models'
    folder.mkdir(exist_ok=True)
    manifest_path = folder / 'manifest.json'
    if manifest_path.exists():
        info = json.loads(manifest_path.read_text())
        if all((folder / n).exists() and sha(folder / n) == h for n, h in info['sha256'].items()):
            return folder, info
    info = json.load(get(f'https://huggingface.co/api/models/{REPO}?blobs=true'))
    revision = info['sha']
    hashes = {}
    for name in ['model_feat.onnx', 'model_metrics.onnx', 'metrics.json']:
        dest = folder / name
        print(f'Downloading {name} ...', flush=True)
        tmp = dest.with_suffix(dest.suffix + '.part')
        with get(f'https://huggingface.co/{REPO}/resolve/{revision}/{MODEL}/{name}') as response, tmp.open('wb') as out:
            while chunk := response.read(1024 * 1024):
                out.write(chunk)
        digest = sha(tmp)
        entry = next(s for s in info['siblings'] if s['rfilename'] == f'{MODEL}/{name}')
        expected = entry.get('lfs', {}).get('sha256')
        if expected and digest != expected:
            raise RuntimeError(f'Hash mismatch: {name}')
        tmp.replace(dest)
        hashes[name] = digest
    manifest = {'repo': REPO, 'model': MODEL, 'revision': revision, 'sha256': hashes,
                'preprocessing': 'RGB-white-alpha-exif; bilinear stretch 384; CLIP mean/std; v1',
                'source': 'https://github.com/deepghs/imgutils/blob/main/imgutils/metrics/ccip.py',
                'license': 'OpenRAIL; https://huggingface.co/deepghs/ccip_onnx'}
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    return folder, manifest


def rgb(path):
    with Image.open(path) as im:
        im.seek(0)
        rgba = ImageOps.exif_transpose(im).convert('RGBA')
        bg = Image.new('RGBA', rgba.size, 'white')
        return Image.alpha_composite(bg, rgba).convert('RGB')


def main():
    start = time.perf_counter()
    public = HERE / 'public'
    (public / 'thumbs').mkdir(parents=True, exist_ok=True)
    (HERE / 'cache').mkdir(exist_ok=True)
    paths = sorted([p for d in [ROOT, ROOT / 'man'] for p in d.iterdir() if p.is_file()], key=lambda p: p.name.casefold())
    before = {str(p): sha(p) for p in paths}
    folder, manifest = models()
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(str(folder / 'model_feat.onnx'), sess_options=options, providers=['CPUExecutionProvider'])
    print('Inputs:', [(x.name, x.shape) for x in session.get_inputs()], flush=True)
    identity = hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()[:16]
    mean = np.array([.48145466, .4578275, .40821073], dtype=np.float32)[:, None, None]
    std = np.array([.26862954, .26130258, .27577711], dtype=np.float32)[:, None, None]
    items, features, skipped = [], [], []
    inference_seconds = 0
    for p in paths:
        if p.suffix.lower() not in EXT:
            skipped.append({'name': p.name, 'reason': 'unsupported type (video excluded)'})
            continue
        try:
            im = rgb(p)
        except Exception as exc:
            skipped.append({'name': p.name, 'reason': str(exc)})
            continue
        h = before[str(p)]
        cache = HERE / 'cache' / f'{identity}-{h}.npy'
        t = time.perf_counter()
        if cache.exists():
            feat = np.load(cache, allow_pickle=False)
        else:
            arr = np.asarray(im.resize((384, 384), Image.Resampling.BILINEAR), dtype=np.float32).transpose(2, 0, 1) / 255
            inp = ((arr - mean) / std)[None].astype(np.float32)
            feat = session.run(['output'], {'input': inp})[0][0]
            if not np.isfinite(feat).all():
                raise RuntimeError('Non-finite feature')
            np.save(cache, feat)
        inference_seconds += time.perf_counter() - t
        small = np.asarray(im.resize((9, 8)).convert('L'))
        dhash = sum(int(x) << i for i, x in enumerate((small[:, 1:] > small[:, :-1]).flatten()))
        item = {'id': len(items), 'name': p.name, 'path': str(p.relative_to(ROOT)), 'positive': p.parent.name == 'man',
                'sha256': h, 'dhash': str(dhash), 'width': im.width, 'height': im.height}
        im.thumbnail((420, 420))
        im.save(public / 'thumbs' / f'{item["id"]}.jpg', quality=87)
        items.append(item)
        features.append(feat)
        print(f'[{len(items)}] {"Marcus" if item["positive"] else "Other"} ({time.perf_counter()-t:.2f}s)', flush=True)
    metric = ort.InferenceSession(str(folder / 'model_metrics.onnx'), sess_options=options, providers=['CPUExecutionProvider'])
    distances = metric.run(['output'], {'input': np.stack(features).astype(np.float32)})[0]
    assert distances.shape == (len(items), len(items)) and np.isfinite(distances).all()
    assert np.allclose(distances, distances.T, atol=1e-5)
    # Conservative visual duplicate heuristic, not character identity.
    duplicate_pairs = [[i, j] for i in range(len(items)) for j in range(i) if
                       items[i]['sha256'] == items[j]['sha256'] or
                       ((int(items[i]['dhash']) ^ int(items[j]['dhash'])).bit_count() <= 4 and
                        abs(items[i]['width']/items[i]['height'] - items[j]['width']/items[j]['height']) < .05)]
    groups = list(range(len(items)))
    def root(i):
        while groups[i] != i:
            i = groups[i]
        return i
    for a, b in duplicate_pairs:
        groups[root(a)] = root(b)
    for i, item in enumerate(items):
        item['duplicateGroup'] = root(i)
    positives = [x['id'] for x in sorted(items, key=lambda x: x['sha256']) if x['positive']]
    random.Random(1999).shuffle(positives)
    pool, used = [], set()
    for i in positives:
        group = items[i]['duplicateGroup']
        if group not in used:
            pool.append(i)
            used.add(group)
        if len(pool) == 5:
            break
    held_out = [x['id'] for x in items if x['duplicateGroup'] not in used]
    threshold = json.loads((folder / 'metrics.json').read_text())['threshold']
    reports = []
    for count in [1, 3, 5]:
        refs = pool[:count]
        ranked = sorted(held_out, key=lambda i: float(distances[i, refs].min()))
        true_total = sum(items[i]['positive'] for i in held_out)
        retrieved = [i for i in ranked if distances[i, refs].min() <= threshold]
        tp = sum(items[i]['positive'] for i in retrieved)
        ap = sum(sum(items[j]['positive'] for j in ranked[:k])/k for k, i in enumerate(ranked, 1) if items[i]['positive']) / true_total if true_total else None
        reports.append({'references': len(refs), 'referenceIds': refs, 'heldOutPositives': true_total,
                        'heldOutNegatives': len(held_out)-true_total, 'top10Correct': sum(items[i]['positive'] for i in ranked[:10]),
                        'retrieved': len(retrieved), 'truePositive': tp, 'falsePositive': len(retrieved)-tp,
                        'missed': true_total-tp, 'averagePrecision': ap, 'rankedIds': ranked})
    assert all(sha(Path(p)) == h for p, h in before.items()), 'Source changed during analysis'
    result = {'items': items, 'distances': np.round(distances, 7).tolist(), 'referencePool': pool,
              'threshold': threshold, 'reports': reports, 'duplicatePairs': duplicate_pairs, 'skipped': skipped,
              'model': manifest, 'sourceRoot': str(ROOT), 'inferenceSeconds': round(inference_seconds, 2),
              'elapsedSeconds': round(time.perf_counter()-start, 2), 'sourcesUnchanged': True,
              'limitations': ['Small user-selected dataset, labels supplied by user.', 'dHash duplicates are heuristic; crop/edit leakage remains possible.',
                             'Mixed-person and real-world negatives are outside CCIP single anime character scope.',
                             'Published pair threshold is exploratory for nearest-of-multiple-reference retrieval; not calibrated.',
                             'Interactive reference changes are exploratory, not independent test results.']}
    (public / 'data.json').write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')
    (HERE / 'report.json').write_text(json.dumps({k:v for k,v in result.items() if k not in ['items','distances']}, ensure_ascii=False, indent=2), encoding='utf-8')
    (HERE / 'input-hashes.json').write_text(json.dumps(before, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(reports, ensure_ascii=False, indent=2), flush=True)


if __name__ == '__main__':
    main()
