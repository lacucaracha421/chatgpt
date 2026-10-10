"""Resumable GPU image indexing, hash-keyed storage and atomic inbox publication."""
import argparse
from datetime import datetime, timezone
import gc
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import time
import unicodedata
import uuid

from runtime_support import (MODELS, PREPROCESS, QwenEncoder, SiglipImages, normalize, packed_image,
                             read_captions, read_only, source_path, text_units)
import numpy as np


def corpus(db):
    c = read_only(db)
    try:
        return [dict(r) for r in c.execute("SELECT id,content_hash,relative_path FROM assets "
                   "WHERE status='normal' AND media_kind IN ('image','gif') ORDER BY id")]
    finally:
        c.close()


class VectorStore:
    def __init__(self, state):
        Path(state).mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(Path(state) / 'vectors.sqlite')
        self.conn.execute('PRAGMA journal_mode=WAL')
        self.conn.execute('PRAGMA synchronous=FULL')
        self.conn.execute('''CREATE TABLE IF NOT EXISTS vectors(
            content_hash TEXT NOT NULL, model_id TEXT NOT NULL, preprocess TEXT NOT NULL,
            dim INTEGER NOT NULL, vector BLOB NOT NULL,
            PRIMARY KEY(content_hash,model_id,preprocess)) WITHOUT ROWID''')
        self.conn.commit()

    def close(self):
        self.conn.close()

    def get(self, content_hash, model, preprocess=PREPROCESS, model_id=None):
        row = self.conn.execute('SELECT vector FROM vectors WHERE content_hash=? AND model_id=? AND preprocess=?',
                               (content_hash, model_id or MODELS[model], preprocess)).fetchone()
        return row[0] if row else None

    def contains(self, content_hash, model, preprocess=PREPROCESS, model_id=None):
        return self.get(content_hash, model, preprocess, model_id) is not None

    def put_batch(self, model, pairs):
        # Validate the complete batch before the transaction; invalid input commits nothing.
        values = []
        for content_hash, vector in pairs:
            array = normalize(vector)
            expected = 1152 if model == 'siglip' else 4096
            if array.ndim != 1 or len(array) != expected:
                raise ValueError(f'Expected one {expected}-dimensional vector per hash')
            values.append((content_hash, MODELS[model], PREPROCESS, len(array),
                           array.astype('<f2').tobytes()))
        with self.conn:
            self.conn.executemany('INSERT OR REPLACE INTO vectors VALUES (?,?,?,?,?)', values)


def seed_from_trial(store, rows, trial_out, models):
    """Prefer per-ID checkpoints; aggregate is a fallback, never inferred by row order."""
    counts = {}
    for model in models:
        folder = Path(trial_out) / ('siglip' if model == 'siglip' else 'qwen-emb-8b')
        ids_path, emb_path = folder / 'ids.json', folder / 'emb.npy'
        ids = json.loads(ids_path.read_text(encoding='utf-8')) if ids_path.exists() else []
        matrix = np.load(emb_path, mmap_mode='r', allow_pickle=False) if emb_path.exists() else None
        if matrix is not None and (matrix.ndim != 2 or len(matrix) != len(ids)):
            raise ValueError(f'Incomplete aggregate: {folder}')
        lookup = {str(asset_id): i for i, asset_id in enumerate(ids)}
        count = cached = 0
        pending = []
        for row in rows:
            if store.contains(row['content_hash'], model):
                cached += 1
                continue
            checkpoint = folder / 'vectors' / (row['id'] + '.npy')
            if checkpoint.exists():
                vector = np.load(checkpoint, allow_pickle=False)
            elif matrix is not None and row['id'] in lookup:
                vector = matrix[lookup[row['id']]]
            else:
                continue
            expected = 1152 if model == 'siglip' else 4096
            if vector.shape != (expected,):
                raise ValueError(f'Unexpected {model} seed dimension for {row["id"]}: {vector.shape}')
            pending.append((row['content_hash'], vector))
            count += 1
            if len(pending) == 128:
                store.put_batch(model, pending)
                pending.clear()
        store.put_batch(model, pending)
        counts[model] = {'imported': count, 'cached': cached}
        print(f'SEED {model}: imported {count}, cached {cached}', flush=True)
    return counts


def export_captions(records, rows):
    """{asset id: NFC caption text} of the corpus images that have a caption (the table the PC publishes)."""
    result = {}
    for row in rows:
        record = (records or {}).get(row['id'])
        text = unicodedata.normalize('NFC', record['text']).strip() if record else ''
        if text:
            result[row['id']] = text
    return result


def vocabulary(records):
    """Gate vocabulary of every caption in the state file (also of images no longer in the corpus)."""
    if records is None:
        return None
    vocab = set()
    for record in records.values():
        vocab.update(text_units(record['text']))
    return vocab


def export_inbox(store, rows, inbox, models, vocab=None, captions=None):
    """Digest includes actual published bytes, settings, vocabulary and captions, excludes the timestamp.

    `vocab` is the caption vocabulary of (kind, value) units; None or empty exports no vocab table.
    `captions` maps asset id to caption text; None or empty exports no captions table.
    """
    models = sorted(set(models))
    inbox = Path(inbox)
    inbox.mkdir(parents=True, exist_ok=True)
    tables, dims, published = {}, {}, set()
    for model in models:
        values = []
        for row in rows:
            blob = store.get(row['content_hash'], model)
            if blob is not None:
                dim = len(blob) // 2
                expected = 1152 if model == 'siglip' else 4096
                if dim != expected or (model in dims and dims[model] != dim):
                    raise ValueError(f'Inconsistent {model} dimensions')
                dims[model] = dim
                values.append((row['id'], blob))
                published.add(row['id'])
        tables[model] = sorted(values)
    tables.setdefault('siglip', [])
    meta = {'format': 'lakomics-nl-search', 'version': '1', 'preprocess': PREPROCESS,
            'siglip_model': MODELS['siglip'] if 'siglip' in models else '', 'siglip_dim': '1152',
            'qwen_model': MODELS['qwen8b'] if 'qwen8b' in models else '',
            'qwen_dim': str(dims.get('qwen8b', 0)), 'asset_count': str(len(published))}
    vocab = sorted(vocab) if vocab else []
    if vocab:
        meta['vocab_count'] = str(len(vocab))
    captions = sorted(captions.items()) if captions else []
    if captions:
        meta['caption_count'] = str(len(captions))
    digest = hashlib.sha256(json.dumps(meta, sort_keys=True).encode())
    for model in models:
        digest.update(model.encode())
        for asset_id, blob in tables[model]:
            digest.update(json.dumps(asset_id).encode())
            digest.update(len(blob).to_bytes(4, 'little'))
            digest.update(blob)
    if vocab:
        digest.update(b'vocab')
        for kind, value in vocab:
            digest.update(json.dumps([kind, value]).encode())
    if captions:
        digest.update(b'captions')
        for asset_id, text in captions:
            digest.update(json.dumps([asset_id, text], ensure_ascii=False).encode())
    signature = digest.hexdigest()
    target = inbox / 'nl-search-latest.sqlite'
    if target.exists():
        c = read_only(target)
        try:
            old = c.execute("SELECT value FROM meta WHERE key='content_digest'").fetchone()
            if old and old[0] == signature:
                return {'changed': False, 'asset_count': len(published), 'vocab_count': len(vocab),
                        'caption_count': len(captions), 'bytes': target.stat().st_size, 'digest': signature}
        finally:
            c.close()
    temp = inbox / (target.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        c = sqlite3.connect(temp)
        try:
            with c:
                c.execute('CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT)')
                meta.update(created_at=datetime.now(timezone.utc).isoformat(), content_digest=signature)
                c.executemany('INSERT INTO meta VALUES (?,?)', sorted(meta.items()))
                for model, values in tables.items():
                    c.execute(f'CREATE TABLE {model}(asset_id TEXT PRIMARY KEY, vector BLOB NOT NULL)')
                    c.executemany(f'INSERT INTO {model} VALUES (?,?)', values)
                if vocab:
                    c.execute('CREATE TABLE vocab(kind TEXT NOT NULL, value TEXT NOT NULL, '
                              'PRIMARY KEY(kind,value)) WITHOUT ROWID')
                    c.executemany('INSERT INTO vocab VALUES (?,?)', vocab)
                if captions:
                    c.execute('CREATE TABLE captions(asset_id TEXT PRIMARY KEY, text TEXT NOT NULL)')
                    c.executemany('INSERT INTO captions VALUES (?,?)', captions)
        finally:
            c.close()
        with temp.open('r+b') as stream:
            os.fsync(stream.fileno())
        os.replace(temp, target)
    finally:
        if temp.exists():
            temp.unlink()
    return {'changed': True, 'asset_count': len(published), 'vocab_count': len(vocab),
            'caption_count': len(captions), 'bytes': target.stat().st_size, 'digest': signature}


def run_model(store, model, selected, library, verify_seed=False):
    unique = {row['content_hash']: row for row in reversed(selected)}
    pending = [r for r in unique.values() if not store.contains(r['content_hash'], model)]
    checks = [r for r in selected if store.contains(r['content_hash'], model)][:3] if verify_seed else []
    if not pending and not checks:
        return {'computed':0, 'errors':[], 'seed_cosines':[]}
    encoder = SiglipImages() if model == 'siglip' else QwenEncoder()
    torch = encoder.torch
    result = {'computed': 0, 'errors': [], 'seed_cosines': []}
    start = time.perf_counter()
    batch, index = (8 if model == 'siglip' else 1), 0
    work = [(row, True) for row in checks] + [(row, False) for row in pending]
    while index < len(work):
        chunk = work[index:index+batch]
        images, good = [], []
        for row, check in chunk:
            try:
                images.append(packed_image(source_path(library, row['relative_path'])))
                good.append((row, check))
            except Exception as exc:
                error = {'id':row['id'], 'model':model, 'error':str(exc)}
                result['errors'].append(error)
                print('SKIP ' + json.dumps(error, ensure_ascii=False), flush=True)
        try:
            if good:
                try:
                    vectors = encoder.encode(images if model == 'siglip' else [{'image':i} for i in images])
                except torch.cuda.OutOfMemoryError:
                    torch.cuda.empty_cache()
                    if batch == 1:
                        raise RuntimeError(f'{model} batch 1 exceeds the 12 GiB allocator budget')
                    work[index:index+len(chunk)] = good
                    batch = max(1, batch//2)
                    continue
                pairs = []
                for (row, check), vector in zip(good, vectors):
                    if check:
                        seed = normalize(np.frombuffer(store.get(row['content_hash'], model), dtype='<f2'))
                        cosine = float(seed @ normalize(vector))
                        result['seed_cosines'].append({'id':row['id'], 'cosine':cosine})
                        print(f'VERIFY {model} {row["id"]}: cosine {cosine:.9f}', flush=True)
                        if cosine < 0.999:
                            raise RuntimeError(f'{model} seed mismatch: {cosine:.9f} < 0.999')
                    else:
                        pairs.append((row['content_hash'], vector))
                store.put_batch(model, pairs)
                result['computed'] += len(pairs)
        finally:
            for image in images:
                image.close()
        index += len(chunk)
        elapsed = time.perf_counter() - start
        rate = index / max(elapsed, 1e-9)
        print(f'{model}: {index}/{len(work)} {rate:.2f} items/s ETA {(len(work)-index)/rate:.1f}s', flush=True)
    result['seconds'] = time.perf_counter() - start
    result['peak_gpu_allocated_gib'] = torch.cuda.max_memory_allocated()/2**30
    result['peak_gpu_reserved_gib'] = torch.cuda.max_memory_reserved()/2**30
    del encoder
    gc.collect()
    torch.cuda.empty_cache()
    return result


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--library', type=Path, required=True)
    p.add_argument('--state', type=Path, required=True)
    p.add_argument('--inbox', type=Path, required=True)
    p.add_argument('--models', default='siglip,qwen8b')
    p.add_argument('--limit', type=int)
    p.add_argument('--seed-from-trial', type=Path)
    p.add_argument('--db', type=Path, help='Read-only snapshot override; default LIBRARY/library.sqlite')
    args = p.parse_args(argv)
    models = list(dict.fromkeys(args.models.split(',')))
    if not models or any(m not in MODELS for m in models):
        p.error('--models must be siglip, qwen8b or siglip,qwen8b')
    if args.limit is not None and args.limit < 0:
        p.error('--limit must be nonnegative')
    rows = corpus(args.db or args.library / 'library.sqlite')
    store = VectorStore(args.state)
    report = {'corpus_count':len(rows), 'models':{}}
    try:
        if args.seed_from_trial:
            report['seed'] = seed_from_trial(store, rows, args.seed_from_trial, models)
        selected = rows if args.limit is None else rows[:args.limit]
        for model in models:
            report['models'][model] = run_model(store, model, selected, args.library,
                                                 verify_seed=bool(args.seed_from_trial))
        # Optional captions (<state>/captions.jsonl, written by nl_caption.py) feed the "no match" gate
        # vocabulary and the `captions` table the desktop publishes to the tablet.
        records = read_captions(args.state / 'captions.jsonl')
        vocab = vocabulary(records)
        captions = export_captions(records, rows)
        report['export'] = export_inbox(store, rows, args.inbox, models, vocab, captions)
        print(f'VOCAB {len(vocab) if vocab else 0} units'
              + ('' if vocab is not None else ' (no captions.jsonl; gate off)'), flush=True)
        print(f'CAPTIONS {len(captions)} of {len(rows)} images', flush=True)
        (args.state / 'last-run.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
        print(json.dumps(report, ensure_ascii=False), flush=True)
    finally:
        store.close()


if __name__ == '__main__':
    main()
