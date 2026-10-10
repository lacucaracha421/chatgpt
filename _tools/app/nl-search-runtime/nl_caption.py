"""Incremental Korean captions (Qwen3-VL-8B NF4) for the library images that have none yet.

Merges into `<state>/captions.jsonl`, the file `nl_index.py` turns into the gate vocabulary and the
`captions` table of the inbox export. A run only captions images missing from that file, appends and
syncs every batch before starting the next (so an interrupted run loses at most one batch), and stops
at `--limit` new captions or `--max-seconds`, whichever comes first. Run it before `nl_index.py`.
"""
import argparse
import json
import os
from pathlib import Path
import time
import unicodedata
import uuid

from nl_index import corpus
from runtime_support import read_captions

MAX_CAPTION_CHARS = 4000  # The server rejects longer texts.
MODEL_TAG = '8B'


def normalize_caption(text):
    """NFC and trimmed, cut to the server's length limit; '' when nothing usable remains."""
    return unicodedata.normalize('NFC', text or '').strip()[:MAX_CAPTION_CHARS].strip()


def dump(record):
    return json.dumps(record, ensure_ascii=False) + '\n'


def write_atomic(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with temp.open('w', encoding='utf-8', newline='\n') as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        if temp.exists():
            temp.unlink()


def load_records(path):
    """{id: record} of the captions file, first repairing an interrupted final line.

    A crash during an append can leave a partial last line or a missing newline; appending after it
    would corrupt the next record, so the file is rewritten from the valid records first.
    """
    path = Path(path)
    records = read_captions(path)
    if records is None:
        return {}
    data = path.read_bytes()
    if data and not data.endswith(b'\n'):
        write_atomic(path, ''.join(dump(record) for record in records.values()))
    return records


def append_records(path, records):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a', encoding='utf-8', newline='\n') as stream:
        for record in records:
            stream.write(dump(record))
        stream.flush()
        os.fsync(stream.fileno())


def plan(rows, records):
    """Split the corpus into (copies, todo): images that share a content hash with an already
    captioned image reuse its caption; the rest still need the model."""
    by_hash = {}
    for row in rows:
        record = records.get(row['id'])
        if record and normalize_caption(record['text']) and row.get('content_hash'):
            by_hash.setdefault(row['content_hash'], record)
    copies, todo = [], []
    for row in rows:
        record = records.get(row['id'])
        if record and normalize_caption(record['text']):
            continue
        source = by_hash.get(row.get('content_hash'))
        if source:
            copies.append({'id': row['id'], 'text': source['text'], 'secs': 0.,
                           'model': source.get('model', MODEL_TAG), 'copied_from': source['id']})
        else:
            todo.append(row)
    return copies, todo


def caption_rows(captioner, todo, open_image, path, limit, max_seconds, batch_size=16, clock=time.monotonic):
    """Caption `todo` rows in batches; return the report. `captioner.caption(images)` returns one text
    per image. Stops before a batch once `limit` captions exist or the time budget is spent."""
    started = clock()
    oom = getattr(captioner, 'oom_errors', ())
    report = {'captioned': 0, 'errors': [], 'stopped': None}
    index = 0
    while index < len(todo):
        if report['captioned'] >= limit:
            report['stopped'] = 'limit'
            break
        if clock() - started >= max_seconds:
            report['stopped'] = 'time'
            break
        chunk = todo[index:index + min(batch_size, limit - report['captioned'])]
        images, rows = [], []
        for row in chunk:
            try:
                images.append(open_image(row))
                rows.append(row)
            except Exception as exc:
                report['errors'].append({'id': row['id'], 'error': str(exc)})
                print('SKIP ' + json.dumps(report['errors'][-1], ensure_ascii=False), flush=True)
        try:
            if rows:
                tick = clock()
                try:
                    texts = captioner.caption(images)
                except oom:
                    if batch_size == 1:
                        raise RuntimeError('caption batch 1 exceeds the GPU memory budget')
                    batch_size = max(1, batch_size // 2)
                    print(f'caption: out of memory, batch size now {batch_size}', flush=True)
                    continue
                if len(texts) != len(rows):
                    raise RuntimeError('Captioner returned a different number of texts than images')
                per_image = (clock() - tick) / len(rows)
                records = []
                for row, text in zip(rows, texts):
                    text = normalize_caption(text)
                    if not text:
                        report['errors'].append({'id': row['id'], 'error': 'empty caption'})
                        print('SKIP ' + json.dumps(report['errors'][-1], ensure_ascii=False), flush=True)
                        continue
                    records.append({'id': row['id'], 'text': text, 'secs': per_image, 'model': MODEL_TAG})
                append_records(path, records)
                report['captioned'] += len(records)
                print(f'caption: {report["captioned"]} new, {per_image:.2f} sec/image', flush=True)
        finally:
            for image in images:
                close = getattr(image, 'close', None)
                if close:
                    close()
        index += len(chunk)
    return report


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--library', type=Path, required=True)
    p.add_argument('--state', type=Path, required=True)
    p.add_argument('--db', type=Path, help='Read-only snapshot override; default LIBRARY/library.sqlite')
    p.add_argument('--limit', type=int, default=2000, help='Most new captions per run')
    p.add_argument('--max-seconds', type=float, default=3600., help='Start no new batch after this time')
    p.add_argument('--batch-size', type=int, default=16)
    p.add_argument('--dry-run', action='store_true', help='Only count what is missing; load no model')
    args = p.parse_args(argv)
    if args.limit < 0 or args.batch_size < 1 or args.max_seconds < 0:
        p.error('--limit and --max-seconds must be nonnegative and --batch-size positive')
    rows = corpus(args.db or args.library / 'library.sqlite')
    path = args.state / 'captions.jsonl'
    args.state.mkdir(parents=True, exist_ok=True)
    records = load_records(path)
    copies, todo = plan(rows, records)
    report = {'corpus_count': len(rows), 'existing': len(records), 'copied': len(copies),
              'missing': len(todo), 'captioned': 0, 'errors': [], 'stopped': None}
    if args.dry_run:
        print(json.dumps(report, ensure_ascii=False), flush=True)
        return report
    if copies:
        append_records(path, copies)
    if todo and args.limit:
        from runtime_support import QwenCaptioner, packed_image, source_path
        captioner = QwenCaptioner()
        captioner.oom_errors = (captioner.torch.cuda.OutOfMemoryError,)
        start = time.monotonic()
        report.update(caption_rows(
            captioner, todo, lambda row: packed_image(source_path(args.library, row['relative_path'])),
            path, args.limit, args.max_seconds, args.batch_size))
        report['seconds'] = time.monotonic() - start
        report['peak_gpu_allocated_gib'] = captioner.torch.cuda.max_memory_allocated() / 2**30
    report['remaining'] = len(todo) - report['captioned']
    (args.state / 'last-caption-run.json').write_text(json.dumps(report, ensure_ascii=False, indent=2),
                                                      encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False), flush=True)
    return report


if __name__ == '__main__':
    main()
