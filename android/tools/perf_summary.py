#!/usr/bin/env python3
"""Summarize `adb logcat -d -s LakomicsPerf` from a file or stdin (stdlib only).

Native format (one terminal line per media/thumbnail op):
  media id=A req=S-1 status=ok cache=miss queueMs=2 lockMs=1 ticketMs=20 batch=1:2:8 permitMs=1 downloadMs=40 bytes=100 commitMs=3 obtainMs=43 totalMs=70 inflightThumb=2 inflightMedia=0 queuedThumb=1 queuedMedia=0 queued=1
JS format (optional phase fields accumulate after they become available):
  js event=commit id=A req=S-1 kind=image prepared=0 source=native status=ok elapsedMs=90 nativeMs=72 decodeMs=85 commitMs=90

Synthetic sample: prefix the two lines above with `I/LakomicsPerf(123): `.
Expected: native/media cache=miss totalMs median=70, viewer/image cache=miss
openToCommitMs median=90, decodePhaseMs median=13, commitPhaseMs median=5.

Native times use nanoTime, JS times use performance.now; only durations are joined.
batch is a comma-separated list of batchId:size:httpMs (shared by its waiters),
or '-'. HTTP covers CloudClient.apiFor including response JSON parsing. Retries
accumulate ticket/permit/download/bytes; bytes are body bytes written, including
partial attempts. commitMs is obtain time excluding its download/verification/
retry callback; obtainMs includes that callback. These fields overlap, not sum.
Pool counts describe submit-time running/queued ops before this op; queued also
includes collection/catalog work and is an approximate executor snapshot.
JS nativeMs/decodeMs/commitMs are offsets from effect start, not phase lengths.
Prepared entries measure the next observed DOM commit after effect start; they
may already be visible. Commit is not paint. Memory/shared/pending/bypass and
unmatched traces are reported separately, never guessed to be disk cache hits.
Failures/cancellations/rejections are counted separately and excluded from timing
statistics. p90 uses nearest rank. Native batch totals are per op, not unique HTTPs.
"""
import argparse
from collections import Counter, defaultdict
import math
import re
import statistics
import sys

NATIVE_PHASES = ('queueMs', 'lockMs', 'ticketMs', 'permitMs', 'downloadMs',
                 'commitMs', 'obtainMs', 'totalMs', 'bytes', 'inflightThumb',
                 'inflightMedia', 'queuedThumb', 'queuedMedia', 'queued')


def number(value):
    try:
        result = float(value)
        return result if math.isfinite(result) and result >= 0 else None
    except (TypeError, ValueError):
        return None


def records(lines):
    for line in lines:
        if 'LakomicsPerf' in line:
            line = re.sub(r'^.*?\bLakomicsPerf\b[^:]*:\s*', '', line)
        match = re.match(r'\s*(media|thumbnail|js)\s+(.*)', line)
        if match:
            yield match[1], dict(re.findall(r'(\w+)=([^\s]+)', match[2]))


def summarize(lines):
    rows = list(records(lines))
    groups = defaultdict(lambda: defaultdict(list))
    excluded = Counter()
    native = {(p.get('req'), p.get('id')): p for op, p in rows
              if op == 'media' and p.get('req') not in (None, '-')}

    def add(group, phase, value):
        value = number(value)
        if value is not None:
            groups[group][phase].append(value)

    for op, p in rows:
        status = p.get('status', 'unknown')
        if op != 'js':
            if status != 'ok':
                excluded[f'{op}/{status}'] += 1
                continue
            group = f'native/{op} cache={p.get("cache", "unknown")}'
            for phase in NATIVE_PHASES:
                add(group, phase, p.get(phase))
            batches = [b.split(':') for b in p.get('batch', '-').split(',')]
            batches = [b for b in batches if len(b) == 3]
            if batches:
                for name, index in (('batchHttpMs', 2), ('batchSize', 1)):
                    values = [number(b[index]) for b in batches]
                    if all(v is not None for v in values):
                        add(group, name, sum(values))
            continue
        event = p.get('event')
        if event not in ('commit', 'end', 'prefetch_finish'):
            continue
        label = 'prefetch' if event == 'prefetch_finish' else 'viewer'
        if status != 'ok':
            excluded[f'{label}/{status}'] += 1
            continue
        source = p.get('source', 'unknown')
        cache = source
        if source == 'native':
            match = native.get((p.get('req'), p.get('id')), {})
            cache = match.get('cache', 'unmatched') if match.get('status') == 'ok' else 'unmatched'
        group = f'{label}/{p.get("kind", "other")} cache={cache}'
        if event == 'prefetch_finish':
            add(group, 'totalMs', p.get('elapsedMs'))
        elif event == 'commit':
            add(group, 'openToCommitMs', p.get('commitMs'))
            add(f'viewer/{p.get("kind", "other")} all', 'openToCommitMs', p.get('commitMs'))
            add(group, 'nativeResolvedMs', p.get('nativeMs'))
            resolved, decoded, committed = (number(p.get(k)) for k in ('nativeMs', 'decodeMs', 'commitMs'))
            if decoded is not None and resolved is not None:
                add(group, 'decodePhaseMs', decoded-resolved)
            ready = decoded if decoded is not None else resolved
            if ready is not None and committed is not None:
                add(group, 'commitPhaseMs', committed-ready)
    return groups, excluded


def report(lines, output=sys.stdout):
    groups, excluded = summarize(lines)
    print('group | phase | count | median | p90 | max', file=output)
    for group, phases in sorted(groups.items()):
        for phase, values in sorted(phases.items()):
            values.sort()
            p90 = values[math.ceil(len(values)*0.9)-1]
            print(f'{group} | {phase} | {len(values)} | {statistics.median(values):.3f} | {p90:.3f} | {values[-1]:.3f}', file=output)
    if not groups:
        print('No successful timing samples.', file=output)
    for key, count in sorted(excluded.items()):
        print(f'excluded {key}: {count}', file=output)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('file', nargs='?', default='-', help='logcat file, or - for stdin')
    args = parser.parse_args()
    if args.file == '-':
        report(sys.stdin)
    else:
        with open(args.file, encoding='utf-8', errors='replace') as source:
            report(source)


if __name__ == '__main__':
    main()
