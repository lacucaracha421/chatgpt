"""Shared offline model settings; no dependency on the trial scripts."""
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import sqlite3
import sys

# Set before importing numpy/torch/transformers. Never write bytecode into HF snapshots.
sys.dont_write_bytecode = True
os.environ.setdefault('HF_HOME', str(Path.home() / '.cache' / 'huggingface'))
for key in ('HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'HF_HUB_DISABLE_TELEMETRY'):
    os.environ[key] = '1'
os.environ['TOKENIZERS_PARALLELISM'] = 'false'
os.environ['HF_HUB_DISABLE_PROGRESS_BARS'] = '1'
for key in ('OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'NUMEXPR_NUM_THREADS'):
    os.environ[key] = '1'

import numpy as np

PREPROCESS = 'pack1024-q90'
MODELS = {'siglip': 'google/siglip2-so400m-patch14-384',
          'qwen8b': 'Qwen/Qwen3-VL-Embedding-8B'}
OPUS = 'Helsinki-NLP/opus-mt-ko-en'
QUERY_INSTRUCTION = 'Retrieve relevant images for the query.'


# "No match" gate vocabulary. The Rust ranking (library/nl_search.rs) mirrors this tokeniser exactly.
TOKEN = re.compile('[0-9a-z가-힣ㄱ-ㅎㅏ-ㅣ]+')
HANGUL = re.compile('[가-힣ㄱ-ㅎㅏ-ㅣ]')
LATIN_WORD = re.compile('[a-z]{3,}')
TAG_SPLIT = re.compile(r'[_():\s]+')


def text_units(text):
    """Countable units of a text, in order and with repeats, as (kind, value) pairs.

    Tokens are maximal runs of [0-9a-z가-힣ㄱ-ㅎㅏ-ㅣ] in the lower-cased text. A token with any
    Hangul yields every 2-character substring (kind 'k'); a Latin-only token of 3+ letters yields
    itself (kind 'w'); anything else yields nothing.
    """
    units = []
    for token in TOKEN.findall(text.lower()):
        if HANGUL.search(token):
            units.extend(('k', token[i:i + 2]) for i in range(len(token) - 1))
        elif LATIN_WORD.fullmatch(token):
            units.append(('w', token))
    return units


def caption_vocabulary(path):
    """Distinct units of every caption text in a captions.jsonl file, or None when it is absent."""
    path = Path(path)
    if not path.is_file():
        return None
    vocab = set()
    with path.open(encoding='utf-8') as stream:
        for line in stream:
            if line.strip():
                vocab.update(text_units(json.loads(line).get('text') or ''))
    return vocab


def tag_words(tags):
    """Lower-case words of 3+ characters in auto-tag vocabulary tags, split on _ ( ) : and whitespace."""
    return {word for tag in tags for word in TAG_SPLIT.split(tag.lower()) if len(word) >= 3}


def read_only(path):
    c = sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True)
    c.row_factory = sqlite3.Row
    c.execute('PRAGMA query_only=ON')
    return c


def normalize(values):
    array = np.asarray(values, dtype=np.float32)
    if array.ndim not in (1, 2) or array.size == 0 or not np.isfinite(array).all():
        raise ValueError('Expected finite, nonempty vector(s)')
    norms = np.linalg.norm(array, axis=-1, keepdims=True)
    if (norms <= 0).any():
        raise ValueError('Zero vector')
    return array / norms


def require_snapshot(model_id):
    from huggingface_hub import snapshot_download
    folder = Path(os.environ['HF_HOME']) / 'hub' / ('models--' + model_id.replace('/', '--'))
    if list((folder / 'blobs').glob('*.incomplete')):
        raise RuntimeError(f'Model download still active: {model_id}')
    try:
        return Path(snapshot_download(model_id, local_files_only=True, allow_patterns=[
            '*.json', '*.safetensors', '*.bin', '*.txt', '*.model', '*.spm', '*.py', '*.jinja']))
    except Exception as exc:
        raise RuntimeError(f'Model unavailable offline: {model_id}: {exc}') from exc


def torch_setup(gpu=False, threads=4):
    import torch
    torch.set_num_threads(threads)
    if torch.get_num_interop_threads() != 1:
        torch.set_num_interop_threads(1)
    if gpu:
        if not torch.cuda.is_available():
            raise RuntimeError('CUDA unavailable')
        total = torch.cuda.get_device_properties(0).total_memory
        torch.cuda.set_per_process_memory_fraction(min(1., 12 * 2**30 / total), 0)
        torch.cuda.reset_peak_memory_stats()
    return torch


def packed_image(path):
    """Exactly pack.py then load_image: EXIF, first frame, RGB, thumbnail, JPEG."""
    from PIL import Image, ImageOps
    with Image.open(path) as source:
        source.seek(0)
        image = ImageOps.exif_transpose(source).convert('RGB')
    try:
        image.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
        with io.BytesIO() as buffer:
            image.save(buffer, format='JPEG', quality=90)
            buffer.seek(0)
            with Image.open(buffer) as jpeg:
                return ImageOps.exif_transpose(jpeg).convert('RGB')
    finally:
        image.close()


def source_path(library, relative):
    root = Path(library).resolve()
    path = (root / relative).resolve()
    if not path.is_relative_to(root):
        raise ValueError('Asset path escapes library root')
    return path


class SiglipImages:
    def __init__(self):
        self.torch = torch_setup(gpu=True)
        from transformers import AutoModel, AutoProcessor
        snapshot = require_snapshot(MODELS['siglip'])
        self.model = AutoModel.from_pretrained(snapshot, local_files_only=True,
                         dtype=self.torch.float16, attn_implementation='sdpa').to('cuda').eval()
        self.processor = AutoProcessor.from_pretrained(snapshot, local_files_only=True)

    def encode(self, images):
        inputs = self.processor(images=images, return_tensors='pt').to('cuda', dtype=self.torch.float16)
        with self.torch.inference_mode():
            output = self.model.get_image_features(**inputs)
        output = output if hasattr(output, 'detach') else output.pooler_output
        return normalize(output.float().cpu().numpy())


class QwenEncoder:
    def __init__(self):
        self.torch = torch_setup(gpu=True)
        import bitsandbytes  # Fail if missing; never install dependencies.
        from transformers import BitsAndBytesConfig
        snapshot = require_snapshot(MODELS['qwen8b'])
        matches = sorted(snapshot.rglob('qwen3_vl_embedding.py'))
        if not matches:
            raise RuntimeError('Official qwen3_vl_embedding.py missing from 8B snapshot')
        spec = importlib.util.spec_from_file_location('_nl_official_qwen_embedding', matches[-1])
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        config = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type='nf4',
                    bnb_4bit_compute_dtype=self.torch.bfloat16, bnb_4bit_use_double_quant=True)
        self.model = module.Qwen3VLEmbedder(model_name_or_path=str(snapshot),
                    max_length=8192, min_pixels=4*32*32, max_pixels=768*768,
                    dtype=self.torch.bfloat16, attn_implementation='sdpa',
                    local_files_only=True, device_map={'': 0}, quantization_config=config)

    def encode(self, items):
        with self.torch.inference_mode():
            output = self.model.process(items, normalize=True)
        self.torch.cuda.synchronize()
        return normalize(output.float().cpu().numpy())
