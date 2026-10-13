"""Prepare private sample copies with the official isnet-anime ONNX model.

Inference conventions follow rembg's MIT-licensed DisSession:
https://github.com/danielgatis/rembg/blob/main/rembg/sessions/dis_anime.py
Only scratch copies are read/written; originals and the library are untouched.
"""
import hashlib
import json
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[3]
SCRATCH = ROOT / '.tmp' / 'card-background-study'
SAMPLES = SCRATCH / 'samples'
MODEL = SCRATCH / 'models' / 'isnet-anime.onnx'


def main():
    digest = hashlib.md5(MODEL.read_bytes()).hexdigest()
    if digest != '6f184e756bb3bd901c8849220a83e38e':
        raise RuntimeError(f'Unexpected model checksum: {digest}')
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    session = ort.InferenceSession(str(MODEL), sess_options=options,
                                   providers=['CPUExecutionProvider'])
    input_name = session.get_inputs()[0].name
    report = {'model': 'isnet-anime', 'md5': digest,
              'provider': session.get_providers(), 'images': []}
    for number, filename, full_art in [
        (1, 'art1.webp', False), (2, 'art2.webp', False),
        (3, 'art3.jpg', True), (4, 'art4.jpg', True),
    ]:
        image = ImageOps.exif_transpose(Image.open(SAMPLES / filename)).convert('RGB')
        size = image.size
        small = np.asarray(image.resize((48, 48)), dtype=np.float32) / 255
        entry = {'file': filename, 'width': size[0], 'height': size[1],
                 'fullArt': full_art, 'meanLight': float(small.mean())}
        if not full_art:
            started = time.perf_counter()
            pixels = np.asarray(image.resize((1024, 1024), Image.Resampling.LANCZOS),
                                dtype=np.float32)
            pixels /= max(float(pixels.max()), 1)
            pixels -= np.array([0.485, 0.456, 0.406], dtype=np.float32)
            tensor = np.transpose(pixels, (2, 0, 1))[None].copy()
            predicted = session.run(None, {input_name: tensor})[0][0, 0]
            minimum, maximum = float(predicted.min()), float(predicted.max())
            if maximum - minimum < 1e-6:
                raise RuntimeError(f'Empty model mask for {filename}')
            mask = Image.fromarray(np.clip((predicted - minimum) / (maximum - minimum)
                                         * 255, 0, 255).astype('uint8'))
            mask = mask.resize(size, Image.Resampling.LANCZOS)
            rgba = image.convert('RGBA')
            rgba.putalpha(mask)
            rgba.save(SAMPLES / f'cut{number}.webp', lossless=True)
            alpha = np.asarray(mask)
            entry.update(cut=f'cut{number}.webp',
                         seconds=round(time.perf_counter() - started, 2),
                         transparentFraction=float((alpha < 16).mean()),
                         opaqueFraction=float((alpha > 240).mean()))
            print(json.dumps(entry), flush=True)
        else:
            print(json.dumps(entry), flush=True)
        report['images'].append(entry)
    (SAMPLES / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
