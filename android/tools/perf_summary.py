#!/usr/bin/env python3
"""Summarize `adb logcat -d -s LakomicsPerf` from a file or stdin (stdlib only).

Native format (one terminal line per media/thumbnail op):
  media req=S-1 status=ok cache=miss queueMs=2 lockMs=1 ticketMs=20 batch=1:2:8 permitMs=1 downloadMs=40 bytes=100 commitMs=3 obtainMs=43 totalMs=70 inflightThumb=2 inflightMedia=0 queuedThumb=1 queuedMedia=0 queued=1
JS format (optional phase fields accumulate after they become available):
  js event=commit req=S-1 kind=image prepared=0 source=native status=ok elapsedMs=90 nativeMs=72 decodeMs=85 commitMs=90

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
tapToDisplayedMs measures the original open action through the displayed DOM slot.
New records omit entity ids; request-only correlation and legacy id-bearing logs
are both supported. sessionHttp snapshots are cumulative; only the latest route
snapshot is used. Bytes/operation totals include failed and canceled subsets.
Prepared entries measure the next observed DOM commit after effect start; they
may already be visible. Commit is not paint. Memory/shared/pending/bypass and
unmatched traces are reported separately, never guessed to be disk cache hits.
Failures/cancellations/rejections are counted separately and excluded from timing
statistics. p90 uses nearest rank. Native per-op batch totals overlap. The ticketBatches group deduplicates batch IDs
within one process log; split logs at process restarts (the sequence restarts).
"""
import argparse
from collections import Counter, defaultdict
import math
import re
import statistics
import sys

NATIVE_PHASES = ('queueMs', 'lockMs', 'ticketMs', 'permitMs', 'downloadMs',
                 'commitMs', 'obtainMs', 'totalMs', 'bytes', 'inflightThumb',
                 'inflightMedia', 'queuedThumb', 'queuedMedia', 'queued',
                 'jsQueueMs', 'nativeQueueMs', 'storeMs', 'downloads', 'httpStatus', 'rateLimited')


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
        match = re.match(r'\s*(startupNative|startupRequest|startupHttp|sessionHttp|media|thumbnail|collectionArtwork|catalogCover|js)\s+(.*)', line.lstrip('\ufeff'))
        if match:
            yield match[1], dict(re.findall(r'(\w+)=([^\s]+)', match[2]))


def summarize(lines):
    rows = list(records(lines))
    groups = defaultdict(lambda: defaultdict(list))
    excluded = Counter()
    batches_seen = set()
    session_latest = {}
    native = {(p.get('req'), p.get('id')): p for op, p in rows
              if op == 'media' and p.get('req') not in (None, '-')}

    def add(group, phase, value):
        value = number(value)
        if value is not None:
            groups[group][phase].append(value)

    for op, p in rows:
        status = p.get('status', 'unknown')
        if op == 'sessionHttp':
            # Snapshots are cumulative. Summing periodic lines would count the same bodies again.
            session_latest[p.get('route', 'other')] = p
            continue
        if op == 'startupNative':
            for phase in ('activityMs', 'processMs', 'durationMs', 'uiThread'):
                add(f'startup/native {p.get("phase", "unknown")}', phase, p.get(phase))
            continue
        if op in ('startupRequest', 'startupHttp'):
            group = f'startup/{"request" if op == "startupRequest" else "http"} {p.get("route", "other")} lane={p.get("lane", "unknown")} status={status}'
            for phase in ('submitMs', 'startMs', 'queueMs', 'runMs', 'poolSize', 'active', 'queued'):
                add(group, phase, p.get(phase))
            add(f'counts/startup {"operations" if op == "startupRequest" else "requests"} route={p.get("route", "other")} status={status}', 'count', 1)
            continue
        if op == 'js' and 'screen' in p:
            group = f'js/screen={p["screen"]} trigger={p.get("trigger", "unknown")} status={status}'
            add(group, 'interactions', 1)
            for phase in ('readyMs', 'imagesReadyMs'):
                add(group, phase, p.get(phase))
            continue
        if op == 'js' and 'startup' in p:
            for phase in ('firstReactRenderMs', 'homeReadyMs', 'viewportImagesReadyMs', 'splashLeavingMs', 'splashEndMs', 'issued', 'cancelled', 'reissued', 'pending'):
                add('startup/js', phase, p.get(phase))
            for row in p.get('requests', '-').split(','):
                parts = row.split(':')
                if len(parts) != 8:
                    continue
                for phase, value in zip(('firstStartMs', 'firstEndMs', 'lastEndMs', 'issued', 'cancelled', 'reissued', 'pending'), parts[1:]):
                    add(f'startup/js route={parts[0]}', phase, value)
            continue
        if op == 'js' and 'startupRequest' in p:
            group = f'startup/js request={p["startupRequest"]} status={status}'
            for phase in ('startMs', 'endMs'):
                add(group, phase, p.get(phase))
            start, end = number(p.get('startMs')), number(p.get('endMs'))
            if start is not None and end is not None:
                add(group, 'runMs', end-start)
            continue
        if op != 'js':
            totals = f'totals/operations {op} status={status}'
            add(totals, 'operations', 1)
            add(totals, 'bytes', p.get('bytes'))
            # A batch can serve successful and canceled operations; count it once.
            for batch in p.get('batch', '-').split(','):
                fields = batch.split(':')
                if len(fields) == 3 and fields[0] not in batches_seen:
                    batches_seen.add(fields[0])
                    add('native/ticketBatches unique', 'size', fields[1])
                    add('native/ticketBatches unique', 'httpMs', fields[2])
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
        if 'catalogScreen' in p:
            if status != 'ok':
                excluded[f'catalogScreen/{status}'] += 1
                continue
            for phase in ('firstCoverMs', 'visible90Ms', 'visible', 'loaded'):
                add('js/catalogScreen', phase, p.get(phase))
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
            add(group, 'tapToDisplayedMs', p.get('tapToDisplayedMs'))
            add(f'viewer/{p.get("kind", "other")} all', 'tapToDisplayedMs', p.get('tapToDisplayedMs'))
            add(group, 'nativeResolvedMs', p.get('nativeMs'))
            resolved, decoded, committed = (number(p.get(k)) for k in ('nativeMs', 'decodeMs', 'commitMs'))
            if decoded is not None and resolved is not None:
                add(group, 'decodePhaseMs', decoded-resolved)
            ready = decoded if decoded is not None else resolved
            if ready is not None and committed is not None:
                add(group, 'commitPhaseMs', committed-ready)
    for route, p in session_latest.items():
        for phase in ('sessionMs', 'requests', 'finished', 'failed', 'canceled', 'pending', 'bytesIn', 'bytesOut',
                      'failedBytesIn', 'failedBytesOut', 'canceledBytesIn', 'canceledBytesOut'):
            add(f'session/http route={route}', phase, p.get(phase))
    return groups, excluded


def report(lines, output=sys.stdout):
    groups, excluded = summarize(lines)
    print('group | phase | count | median | p90 | max', file=output)
    for group, phases in sorted(groups.items()):
        for phase, values in sorted(phases.items()):
            values.sort()
            p90 = values[math.ceil(len(values)*0.9)-1]
            print(f'{group} | {phase} | {len(values)} | {statistics.median(values):.3f} | {p90:.3f} | {values[-1]:.3f}', file=output)
            if group.startswith(('totals/', 'counts/')):
                print(f'total {group} {phase}={sum(values):.0f}', file=output)
    if not groups:
        print('No successful timing samples.', file=output)
    for key, count in sorted(excluded.items()):
        print(f'excluded {key}: {count}', file=output)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('file', nargs='?', default='-', help='logcat file, or - for stdin')
    args = parser.parse_args()
    if args.file == '-':
        data = sys.stdin.buffer.read()
    else:
        with open(args.file, 'rb') as source:
            data = source.read()
    report(decode_log(data).splitlines())


def decode_log(data):
    """PowerShell 5.1 redirection is UTF-16LE; UTF-8 BOM is also common on Windows."""
    if data.startswith((b'\xff\xfe', b'\xfe\xff')):
        return data.decode('utf-16', errors='replace')
    # Accommodate BOM-less UTF-16 pipes/files too, using the ASCII log prefix's null bytes.
    prefix = data[:256]
    if b'\x00' in prefix:
        encoding = 'utf-16-le' if prefix[1::2].count(0) > prefix[::2].count(0) else 'utf-16-be'
        return data.decode(encoding, errors='replace')
    return data.decode('utf-8-sig', errors='replace')


if __name__ == '__main__':
    main()
