"""Durable AV candidates; applying choices remains an authority client operation."""
from __future__ import annotations

import io
import json
import logging
import math
import re
import threading
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode, urlsplit, urlunsplit

from fastapi import Header, HTTPException, Query, Request, Response
from starlette.concurrency import run_in_threadpool

from app_lifecycle import lifecycle, join_worker
import authority
import collection_authority as ca
import work_providers as wp
from mobile_collections import artwork_key

PREFIX = "/v1/av-inbox"
MAX_JSON = 1024 * 1024
MAX_JACKET = 8 * 1024 * 1024
MAX_PIXELS = 16_000_000
READY_SECONDS = 600
IDLE_SECONDS = 60
#: DMM's digital CDN serves the full wrap jacket (about 2184 px wide) for many titles; the
#: LibreDMM cover is the 800 px image. A candidate must be wider than this to beat the fallback.
HIRES_MIN_WIDTH = 800
HIRES_MAX_TRIES = 5
HIRES_SECONDS = 8
HIRES_URL = 'https://awsimgsrc.dmm.co.jp/pics_dig/digital/video/{cid}/{cid}pl.jpg'
#: The 800 px digital wrap on DMM's own host. With the mono/DVD ``pl`` it is where a wrap jacket
#: (instead of a front-only ``ps``) or a spine for a spine-less high-resolution jacket comes from.
WRAP_URL = 'https://pics.dmm.co.jp/digital/video/{cid}/{cid}pl.jpg'
WRAP_MIN_ASPECT = 1.2
#: A wrap this wide cannot have the usual DVD front width, so its spine is the centre strip.
CENTRE_SPINE_MIN_ASPECT = 1.6
CENTRE_SPINE_SHARE = .08
#: Below this share of the width a jacket has no spine of its own (the confirmation UI's lower bound).
SPINE_MIN_SHARE = .01
FRONT_ONLY_NAME = re.compile(r'p[st](\.jpe?g)$', re.I)
DIGITAL_CID = re.compile(r'/digital/video/([a-z0-9_]{3,40})/')
NAME_TTL = 30 * 86400
DDL = """
CREATE TABLE IF NOT EXISTS av_inbox (
 request_id TEXT PRIMARY KEY REFERENCES av_lookup_requests(request_id) ON DELETE CASCADE,
 normalized_code TEXT, status TEXT NOT NULL DEFAULT 'queued'
 CHECK(status IN ('queued','fetching','found','not_found','error','dismissed','applied')),
 attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, fetched_at TEXT,
 started_at REAL, next_attempt_at REAL NOT NULL DEFAULT 0,
 generation INTEGER NOT NULL DEFAULT 0, candidate TEXT, applied_work_id TEXT,
 applied_library_id TEXT
);
CREATE INDEX IF NOT EXISTS av_inbox_due ON av_inbox(status,next_attempt_at);
CREATE TABLE IF NOT EXISTS av_inbox_state (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL
);
INSERT OR IGNORE INTO av_inbox_state VALUES(1,0);
CREATE TRIGGER IF NOT EXISTS av_inbox_signal_insert AFTER INSERT ON av_inbox
BEGIN UPDATE av_inbox_state SET revision=revision+1 WHERE singleton=1; END;
CREATE TRIGGER IF NOT EXISTS av_inbox_signal_update AFTER UPDATE ON av_inbox
BEGIN UPDATE av_inbox_state SET revision=revision+1 WHERE singleton=1; END;
CREATE TRIGGER IF NOT EXISTS av_inbox_signal_delete AFTER DELETE ON av_inbox
BEGIN UPDATE av_inbox_state SET revision=revision+1 WHERE singleton=1; END;
CREATE TRIGGER IF NOT EXISTS av_lookup_inbox_delete AFTER DELETE ON av_lookup_requests
BEGIN DELETE FROM av_inbox WHERE request_id=OLD.request_id; END;
CREATE TABLE IF NOT EXISTS av_inbox_name_cache (
 name_ja TEXT PRIMARY KEY, mapping TEXT NOT NULL, fetched_at REAL NOT NULL
);
"""


def status_signal(db):
    return db.execute('SELECT revision FROM av_inbox_state WHERE singleton=1').fetchone()[0]


def normalize_code(value):
    if not isinstance(value, str):
        return None
    code = value.strip().translate(str.maketrans('abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'))
    if len(code.encode()) > 40:
        return None
    match = re.fullmatch(r'FC2[-_ ]?PPV[-_ ]?([0-9]+)', code)
    if match:
        label, digits = 'FC2-PPV', match[1]
    else:
        match = re.fullmatch(r'([0-9]+(?:LUXU|GANA|MAAN|ARA|MIUM|PRESTIGE))[-_ ]?([0-9]+)', code)
        if not match:
            match = re.fullmatch(r'(?:H_[0-9]+|[0-9]+|K9)?([A-Z]+)[-_ ]?([0-9]+)(?:R|BOD|TK)?', code)
        if not match:
            return None
        label, digits = match[1], match[2]
    if '-' not in code:
        digits = digits.lstrip('0') or '0'
    return label + '-' + digits.zfill(3)


def seed(db, request_id, code):
    normalized = normalize_code(code)
    db.execute('INSERT OR IGNORE INTO av_inbox(request_id,normalized_code,status,last_error) VALUES(?,?,?,?)',
               (request_id, normalized, 'queued' if normalized else 'error',
                None if normalized else 'invalidProductCode'))


def startup(get_db):
    with get_db() as db:
        db.executescript(DDL)
        # Existing feed records are candidates too; no library/catalog backfill.
        for row in db.execute('SELECT request_id,product_code FROM av_lookup_requests WHERE request_id NOT IN '
                              '(SELECT request_id FROM av_inbox)').fetchall():
            seed(db, row['request_id'], row['product_code'])
        db.commit()


def default_split(width, height, borrowed_spine=False):
    """Back | spine | front lines of a jacket.

    ``borrowed_spine`` marks a spine-less wrap whose spine comes from another image: x1 == x2
    then, and useSpine still says that a spine surface exists.
    """
    wrap = width / max(height, 1) >= 1.2
    side = min(math.floor(height * .703 + .5), width // 2) if wrap else 0
    x1, x2 = (side, width - side) if wrap else (0, 0)
    own = wrap and .01 <= (x2-x1)/max(width, 1) <= .12
    return dict(x1=x1, x2=x2, isWrap=wrap, useSpine=bool(own or (wrap and borrowed_spine and x2 - x1 < width * SPINE_MIN_SHARE)))


def is_spineless(width, height):
    """A wrap (the 4:3 digital jackets) whose default split leaves no room for a spine."""
    split = default_split(width, height)
    return split['isWrap'] and (split['x2'] - split['x1']) < width * SPINE_MIN_SHARE


def wrap_spine(width, height):
    """(x1, x2) of the spine in a DVD wrap image, or None when it cannot be located.

    The usual DVD wrap has a front 0.703 of the height wide, which the default split uses. A much
    wider wrap (the 800x438 jackets) has its spine in the centre, about 8% of the height wide.
    Anything in between, such as a 4:3 image, has no spine to take.
    """
    split = default_split(width, height)
    if split['useSpine']:
        return split['x1'], split['x2']
    if width / max(height, 1) >= CENTRE_SPINE_MIN_ASPECT:
        half = max(1, round(height * CENTRE_SPINE_SHARE / 2))
        return width // 2 - half, width // 2 + half
    return None


def parse_movie(data, code):
    if len(data) > MAX_JSON:
        raise ValueError('oversized movie')
    raw = json.loads(data)
    if not isinstance(raw, dict):
        raise ValueError('invalid movie')
    title = raw.get('title')
    if normalize_code(raw.get('normalized_id')) != code or not isinstance(title, str) or not 0 < len(title) <= 4000:
        raise ValueError('invalid identity/title')
    movie = {k: raw.get(k) for k in ('normalized_id', 'title', 'date', 'cover_image_url',
                                     'thumbnail_image_url', 'volume')}
    for key in ('date', 'cover_image_url', 'thumbnail_image_url'):
        if movie[key] is not None and not isinstance(movie[key], str):
            raise ValueError('invalid text field')
    for key in ('makers', 'labels', 'series', 'directors', 'genres'):
        value = raw.get(key, [])
        if key == 'series':
            value = [] if value is None else [value] if isinstance(value, str) else value
        if not isinstance(value, list) or len(value) > 100 or any(not isinstance(v, str) or len(v) > 4000 for v in value):
            raise ValueError('invalid fields')
        movie[key] = value
    actresses = raw.get('actresses', [])
    if not isinstance(actresses, list) or len(actresses) + len(movie['directors']) > 100:
        raise ValueError('invalid people')
    movie['actresses'] = []
    for person in actresses:
        if not isinstance(person, dict):
            raise ValueError('invalid person')
        if person.get('image_url') is not None and not isinstance(person['image_url'], str):
            raise ValueError('invalid performer image URL')
        movie['actresses'].append({'name': person.get('name'), 'image_url': person.get('image_url')})
    names = [p['name'] for p in movie['actresses']] + movie['directors']
    if any(not isinstance(n, str) or not n.strip() or len(n) > 120 for n in names):
        raise ValueError('invalid name')
    release = None
    if movie['date'] is not None:
        if not isinstance(movie['date'], str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})', movie['date']):
            raise ValueError('invalid date')
        parsed = datetime.fromisoformat(movie['date'].replace('Z', '+00:00'))
        release = parsed.astimezone(timezone(timedelta(hours=9))).date().isoformat()
    # PC does not infer runtime from volume (provider values are inconsistent).
    fields = dict(titleJa=title, releaseDate=release, maker=', '.join(movie['makers']) or None,
                  label=', '.join(movie['labels']) or None, series=', '.join(movie['series']) or None,
                  genres=movie['genres'])
    return movie, fields


def jacket_address(raw):
    if not isinstance(raw, str) or len(raw) > 2048 or any(ord(c) < 33 for c in raw):
        raise ValueError('invalid jacket address')
    u = urlsplit(raw)
    if (u.scheme not in ('http', 'https') or u.hostname not in
            ('pics.dmm.co.jp', 'awsimgsrc.dmm.co.jp', 'image.mgstage.com')
            or u.port is not None or u.username or u.password):
        raise ValueError('invalid jacket address')
    return urlunsplit(('https', u.netloc, u.path, u.query, ''))


def hires_addresses(code, raw):
    """Digital-CDN jacket URLs worth trying for a LibreDMM record, best first."""
    return [HIRES_URL.format(cid=cid) for cid in digital_cids(code, raw)]


def digital_cids(code, raw):
    """Digital cids worth trying for a LibreDMM record, best first.

    The digital cid comes from the record's own URLs (a mono/DVD cover such as ``k9ssis001``
    carries none, but its sample images do). The number is padded to five digits
    (``1stars100`` -> ``1stars00100``) and tried under the common prefixes, then under
    the prefix the record itself used (``h_1074`` ...). Nothing is guessed without a cid.
    """
    if not isinstance(raw, dict) or not isinstance(code, str) or '-' not in code:
        return []
    label = code.rsplit('-', 1)[0].lower()
    if not re.fullmatch(r'[a-z0-9]+', label):
        return []
    pattern = re.compile(r'(h_[0-9]+|[0-9]+)?' + re.escape(label) + r'([0-9]{1,8})')
    samples = raw.get('sample_image_urls')
    urls = [raw.get('cover_image_url')] + (samples[:60] if isinstance(samples, list) else [])
    prefixes, number = ['', '1', '118'], None
    for url in urls:
        found = DIGITAL_CID.search(url) if isinstance(url, str) and len(url) <= 2048 else None
        parts = pattern.fullmatch(found[1]) if found else None
        if parts is None:
            continue
        number = int(parts[2]) if number is None else number
        if parts[1] and parts[1] not in prefixes:
            prefixes.append(parts[1])
    if number is None:
        return []
    core = label + str(number).zfill(5)
    return [prefix + core for prefix in prefixes[:HIRES_MAX_TRIES]]


def wrap_addresses(code, raw, *, with_cover):
    """DVD/digital wrap images (``pl``, 800 px) of a record, best first.

    The record's own cover when it already is a ``pl`` (only ``with_cover``), the cover's ``pl``
    sibling when it is a front-only ``ps``/``pt`` (mono path first), then the digital ``pl`` on
    DMM's own host under the digital cids.
    """
    cover = raw.get('cover_image_url') if isinstance(raw, dict) else None
    found = []
    if isinstance(cover, str):
        try:
            cover = jacket_address(cover)
        except ValueError:
            cover = None
    if cover:
        parts = urlsplit(cover)
        if FRONT_ONLY_NAME.search(parts.path):
            found.append(urlunsplit(parts._replace(path=FRONT_ONLY_NAME.sub('pl.jpg', parts.path), query='')))
        elif with_cover and re.search(r'pl\.jpe?g$', parts.path, re.I):
            found.append(cover)
    found += [WRAP_URL.format(cid=cid) for cid in digital_cids(code, raw)]
    return list(dict.fromkeys(found))


def front_only_address(address):
    return bool(FRONT_ONLY_NAME.search(urlsplit(address).path))


def fetch_first(addresses, deadline, pace, accept):
    """First jacket image that decodes and passes ``accept(width, height)``; else None.

    Returns dict(data, mime, width, height, address). A 404 or an unusable image moves on to the
    next address; anything else (timeout, server error) gives up at once, so the fallback is never
    delayed by a sick CDN.
    """
    for address in addresses:
        try:
            pace()
            data, mime = wp.outbound(jacket_address(address), deadline=deadline, limit=MAX_JACKET, image=True,
                                     headers={'User-Agent': 'Lakomics/0.2'})
            frame = decode_jacket(data, mime)
            width, height = frame.size
            frame.close()
        except wp.UpstreamStatus as exc:
            if exc.status in (403, 404, 410):
                continue
            return None
        except HTTPException as exc:
            code = exc.detail.get('code') if isinstance(exc.detail, dict) else None
            if code == 'avInboxStopping':
                raise
            if code in ('providerImageInvalid', 'providerResponseTooLarge'):
                continue
            return None
        if accept(width, height):
            return dict(data=data, mime=mime, width=width, height=height, address=address)
    return None


def fetch_hires(addresses, deadline, pace=lambda: None):
    """First digital-CDN jacket wider than the fallback, as (data, mime, width, height); else None."""
    found = fetch_first(addresses, deadline, pace, lambda width, height: width > HIRES_MIN_WIDTH)
    return None if found is None else (found['data'], found['mime'], found['width'], found['height'])


def fetch_wrap(code, raw, deadline, pace=lambda: None, *, for_spine, with_cover=True):
    """A DVD/digital wrap image of the record: dict(data, mime, width, height, address[, x1, x2]).

    ``for_spine`` wants a wrap whose spine can be located (x1, x2 are then its pixel columns);
    otherwise any image clearly wider than a single front will do.
    """
    addresses = wrap_addresses(code, raw, with_cover=with_cover)
    found = fetch_first(addresses, deadline, pace, (lambda w, h: wrap_spine(w, h) is not None) if for_spine
                        else (lambda w, h: w / max(h, 1) > WRAP_MIN_ASPECT))
    if found is not None and for_spine:
        found['x1'], found['x2'] = wrap_spine(found['width'], found['height'])
    return found


def choose_jacket(code, raw, deadline, pace=lambda: None):
    """The jacket a lookup uses: dict(data, mime, width, height, address, spine).

    1. DMM's wide digital jacket when one exists. A 4:3 digital jacket has front and back but no
       spine, so a DVD wrap's spine is borrowed (``spine``: that wrap plus the spine's x1, x2).
    2. Otherwise the LibreDMM cover. A front-only ``ps``/``pt`` cover is replaced by the
       record's ``pl`` wrap when one exists and is clearly a wrap.
    """
    budget = lambda: min(deadline, time.monotonic() + HIRES_SECONDS)
    found = fetch_first(hires_addresses(code, raw), budget(), pace, lambda width, height: width > HIRES_MIN_WIDTH)
    if found is not None:
        spine = None
        if is_spineless(found['width'], found['height']):
            spine = fetch_wrap(code, raw, budget(), pace, for_spine=True)
        return dict(found, spine=spine)
    address = jacket_address(raw.get('cover_image_url'))
    data, mime = wp.outbound(address, deadline=deadline, limit=MAX_JACKET, image=True,
                             headers={'User-Agent': 'Lakomics/0.2'})
    width, height = wp.image_dimensions(data, mime, max_pixels=MAX_PIXELS)
    if front_only_address(address):
        wrap = fetch_wrap(code, raw, budget(), pace, for_spine=False, with_cover=False)
        if wrap is not None:
            return dict(wrap, spine=None)
    return dict(data=data, mime=mime, width=width, height=height, address=address, spine=None)


def japanese(name):
    return dict(nameJa=name, nameKo=None, wikidataId=None, fanzaActressId=None)


def wikidata_url(names):
    values = ' '.join(json.dumps(n, ensure_ascii=False) + '@ja' for n in names)
    query = (f'SELECT DISTINCT ?name ?person ?ko ?fanza WHERE {{ VALUES ?name {{ {values} }} '
             '?person (rdfs:label|skos:altLabel) ?name . ?person wdt:P31 wd:Q5 . '
             "OPTIONAL { ?person rdfs:label ?ko FILTER(LANG(?ko) = 'ko') } "
             'OPTIONAL { ?person wdt:P9781 ?fanza } } LIMIT 1000')
    return 'https://query.wikidata.org/sparql?' + urlencode({'format': 'json', 'query': query})


def parse_names(data, names):
    rows = json.loads(data)['results']['bindings']
    if not isinstance(rows, list) or len(rows) > 1000:
        raise ValueError('invalid names')
    result = []
    for name in names:
        matches = {}
        for row in rows:
            if row.get('name', {}).get('value') != name:
                continue
            person = row.get('person', {}).get('value', '')
            match = re.fullmatch(r'https?://www\.wikidata\.org/entity/(Q[0-9]+)', person)
            if not match:
                continue
            mapping = japanese(name)
            mapping['wikidataId'] = match[1]
            ko, fanza = row.get('ko', {}).get('value'), row.get('fanza', {}).get('value')
            mapping['nameKo'] = ko if isinstance(ko, str) and 0 < len(ko) <= 120 else None
            mapping['fanzaActressId'] = fanza if isinstance(fanza, str) and re.fullmatch(r'[0-9]{1,40}', fanza) else None
            matches[match[1]] = mapping
        result.append(next(iter(matches.values())) if len(matches) == 1 else japanese(name))
    return result


def decode_jacket(data, mime):
    if not 0 < len(data) <= MAX_JACKET or mime not in ('image/jpeg', 'image/png', 'image/webp'):
        wp.fail(422, 'providerImageInvalid', '재킷 이미지 형식이 올바르지 않습니다.')
    wp.image_dimensions(data, mime, max_pixels=MAX_PIXELS)
    from PIL import Image
    try:
        with Image.open(io.BytesIO(data)) as image:
            if getattr(image, 'n_frames', 1) != 1:
                raise ValueError('animated image')
            # Preserve PC jacket coordinates: no EXIF rotation or resizing.
            return image.convert('RGB')
    except Exception:
        wp.fail(422, 'providerImageInvalid', '재킷 이미지 형식이 올바르지 않습니다.')


def confirm_blobs(get_db, storage, bucket, blobs, deadline):
    try:
        client, storage_bucket = storage(), bucket()
        receipts = [wp._stored_blob(client, storage_bucket, data, mime, deadline=deadline) for data, mime in blobs]
        if time.monotonic() >= deadline:
            wp.fail(504, 'providerTimeout', '재킷 저장 시간이 초과되었습니다.')
        with get_db() as db:
            for r in receipts:
                db.execute('INSERT INTO mobile_collection_artwork VALUES (?,?,?) ON CONFLICT(sha256) '
                           'DO UPDATE SET size_bytes=excluded.size_bytes,content_type=excluded.content_type',
                           (r['sha256'], r['sizeBytes'], r['contentType']))
            db.commit()
        return receipts
    except HTTPException:
        raise
    except Exception:
        wp.fail(502, 'providerArtworkStorageUnavailable', '재킷을 저장할 수 없습니다.')


def stored_jacket(candidate, storage, bucket, deadline, key='jacket'):
    """The candidate's stored jacket (``key='spineSource'``: the image its spine is borrowed from)."""
    manifest = candidate[key]
    stream = None
    try:
        response = storage().get_object(Bucket=bucket(), Key=artwork_key(manifest['sha256']))
        stream = response['Body']
        if response.get('ContentLength') != manifest['sizeBytes'] or response.get('ContentType') != manifest['contentType']:
            raise ValueError('manifest mismatch')
        data = stream.read(MAX_JACKET + 1)
        import hashlib
        if (len(data) != manifest['sizeBytes'] or hashlib.sha256(data).hexdigest() != manifest['sha256']):
            raise ValueError('digest mismatch')
        if time.monotonic() >= deadline:
            wp.fail(504, 'providerTimeout', '재킷 조회 시간이 초과되었습니다.')
        return data, manifest['contentType']
    except HTTPException:
        raise
    except Exception:
        wp.fail(502, 'providerArtworkStorageUnavailable', '저장된 재킷을 조회할 수 없습니다.')
    finally:
        if stream is not None:
            stream.close()


class LookupStatus(wp.UpstreamStatus):
    """Only the metadata endpoint can report upstream readiness or a missing code."""


class Worker:
    """One daemon lane per application; pending jobs stay in SQLite, not memory."""
    def __init__(self, get_db, storage, bucket, relay, *, clock=time.time):
        self.get_db, self.storage, self.bucket, self.relay = get_db, storage, bucket, relay
        self.clock = clock
        self.stop_event = threading.Event()
        self.wake_event = threading.Event()
        self.thread = None
        self.lane = threading.Lock()
        self.next_libredmm = 0.0
        self.next_wikidata = 0.0
        self.next_dmm = 0.0

    def start(self):
        if self.thread is not None and self.thread.is_alive():
            return
        self.stop_event.clear()
        self.thread = threading.Thread(target=self.run, name='av-inbox', daemon=True)
        self.thread.start()

    def wake(self):
        self.wake_event.set()

    def drain(self):
        self.stop_event.set()
        self.wake()

    def stop(self):
        self.drain()
        if self.thread is not None:
            thread = self.thread
            join_worker(thread, 6, lambda: setattr(self, 'thread', None))

    def run(self):
        while not self.stop_event.is_set():
            # Clear before reading: a commit during the cycle must interrupt wait.
            self.wake_event.clear()
            try:
                if self.process_one():
                    continue
                wait = self.idle_wait()
            except Exception:
                logging.getLogger(__name__).error('AV inbox worker cycle failed')
                wait = IDLE_SECONDS
            if not self.stop_event.is_set():
                self.wake_event.wait(wait)

    def idle_wait(self):
        # Each lookup uses the (status,next_attempt_at) index, even with a backlog.
        with self.get_db() as db:
            due = [db.execute('SELECT next_attempt_at FROM av_inbox WHERE status=? '
                              'ORDER BY next_attempt_at LIMIT 1', (status,)).fetchone()
                   for status in ('queued', 'fetching')]
        earliest = min((row[0] for row in due if row is not None), default=None)
        return IDLE_SECONDS if earliest is None else min(IDLE_SECONDS, max(0, earliest - self.clock()))

    def pace(self, provider, deadline):
        attr, seconds = {'libredmm': ('next_libredmm', 2), 'dmm': ('next_dmm', .5)}.get(provider, ('next_wikidata', 1))
        wait = max(0, getattr(self, attr) - time.monotonic())
        if time.monotonic() + wait >= deadline:
            wp.fail(504, 'providerTimeout', '후보 조회 시간이 초과되었습니다.')
        if self.stop_event.wait(wait):
            wp.fail(503, 'avInboxStopping', '후보 조회가 중단되었습니다.')
        setattr(self, attr, time.monotonic() + seconds)

    def names(self, names, deadline):
        names = sorted(set(names))
        result, missing = {}, []
        with self.get_db() as db:
            for name in names:
                row = db.execute('SELECT mapping FROM av_inbox_name_cache WHERE name_ja=? AND fetched_at>?',
                                 (name, self.clock()-NAME_TTL)).fetchone()
                if row:
                    result[name] = json.loads(row[0])
                else:
                    missing.append(name)
        for start in range(0, len(missing), 20):
            batch = missing[start:start+20]
            try:
                self.pace('wikidata', deadline)
                data, _ = wp.outbound(wikidata_url(batch), deadline=deadline, limit=MAX_JSON,
                                      headers={'Accept': 'application/sparql-results+json', 'User-Agent': 'Lakomics/0.2'})
                mappings = parse_names(data, batch)
                with self.get_db() as db:
                    for m in mappings:
                        db.execute('INSERT INTO av_inbox_name_cache VALUES(?,?,?) ON CONFLICT(name_ja) '
                                   'DO UPDATE SET mapping=excluded.mapping,fetched_at=excluded.fetched_at',
                                   (m['nameJa'], ca.encode(m), self.clock()))
                    db.execute('DELETE FROM av_inbox_name_cache WHERE name_ja IN '
                               '(SELECT name_ja FROM av_inbox_name_cache ORDER BY fetched_at DESC,name_ja LIMIT -1 OFFSET 2000)')
                    db.commit()
            except (HTTPException, wp.UpstreamStatus, ValueError, KeyError, TypeError, AttributeError):
                # Name enrichment is optional; failures are not cached, as on PC.
                mappings = [japanese(n) for n in batch]
            result.update({m['nameJa']: m for m in mappings})
        return result

    def fetch(self, code, deadline):
        self.pace('libredmm', deadline)
        try:
            data, _ = wp.outbound('https://www.libredmm.com/movies/' + code + '.json', deadline=deadline,
                                  limit=MAX_JSON, headers={'User-Agent': 'Lakomics/0.2'})
        except wp.UpstreamStatus as exc:
            if exc.status in (202, 404):
                raise LookupStatus(exc.status) from None
            raise
        movie, fields = parse_movie(data, code)
        chosen = choose_jacket(code, json.loads(data), deadline, lambda: self.pace('dmm', deadline))
        # Decoding/storage shares the interactive provider artwork admission lane.
        def prepare(_):
            frame = decode_jacket(chosen['data'], chosen['mime'])
            width, height = frame.size
            frame.close()
            spine = chosen['spine']
            blobs = [(chosen['data'], chosen['mime'])] + ([(spine['data'], spine['mime'])] if spine else [])
            manifests = confirm_blobs(self.get_db, self.storage, self.bucket, blobs, deadline)
            source = None if spine is None else dict(
                manifests[1], address=spine['address'], x1=spine['x1'], x2=spine['x2'],
                width=spine['width'], height=spine['height'])
            return manifests[0], width, height, source
        manifest, width, height, spine_source = self.relay.paced('artwork', prepare)
        # Directors are no longer imported: they are not resolved, and the key stays (empty) for older clients.
        mappings = self.names([p['name'] for p in movie['actresses']], deadline)
        candidate = dict(metadata=movie, fields=fields, jacket=manifest, jacketWidth=width, jacketHeight=height,
                         defaultSplit=default_split(width, height, spine_source is not None),
                         **({} if spine_source is None else dict(spineSource=spine_source)),
                         performers=[mappings[p['name']] for p in movie['actresses']],
                         directors=[])
        if len(ca.encode(candidate).encode()) > MAX_JSON:
            raise ValueError('oversized candidate')
        return candidate

    def process_one(self):
        if not self.lane.acquire(blocking=False):
            return False
        try:
            now = self.clock()
            with self.get_db() as db:
                row = db.execute("SELECT * FROM av_inbox WHERE status IN ('queued','fetching') "
                                 'AND next_attempt_at<=? ORDER BY next_attempt_at,request_id LIMIT 1', (now,)).fetchone()
                if row is None:
                    db.rollback()
                    return False
                started = row['started_at'] if row['started_at'] is not None else now
                try:
                    db.execute('BEGIN IMMEDIATE')
                    claimed = db.execute("UPDATE av_inbox SET status='fetching',attempts=attempts+1,started_at=?,next_attempt_at=? "
                                         'WHERE request_id=? AND status=? AND next_attempt_at=? '
                                         'AND next_attempt_at<=? AND generation=?',
                                         (started, now+120, row['request_id'], row['status'],
                                          row['next_attempt_at'], now, row['generation']))
                    if claimed.rowcount != 1:
                        db.rollback()
                        return False
                    db.commit()
                except Exception:
                    db.rollback()
                    raise
            attempts = row['attempts'] + 1
            candidate, status, error, due = None, 'error', None, 0
            try:
                if row['attempts'] and now-started >= READY_SECONDS:
                    wp.fail(504, 'avLookupReadyTimeout', '외부 후보 준비 시간이 초과되었습니다.')
                candidate = self.fetch(row['normalized_code'], time.monotonic()+wp.REQUEST_SECONDS)
                status = 'found'
            except LookupStatus as exc:
                if exc.status == 202:
                    status, due = 'fetching', min(now + min(5 * 2**min(attempts, 4), 60), started+READY_SECONDS)
                elif exc.status == 404:
                    status = 'not_found'
            except wp.UpstreamStatus as exc:
                try:
                    wp.status_error(exc.status)
                except HTTPException as mapped:
                    error = mapped.detail['code']
            except HTTPException as exc:
                error = exc.detail.get('code', 'providerUnavailable') if isinstance(exc.detail, dict) else 'providerUnavailable'
            except (ValueError, KeyError, TypeError, AttributeError, OverflowError):
                error = 'providerInvalidResponse'
            except Exception:
                logging.getLogger(__name__).warning('AV inbox attempt failed for request %s', row['request_id'])
                error = 'providerUnavailable'
            with self.get_db() as db:
                db.execute('UPDATE av_inbox SET status=?,last_error=?,next_attempt_at=?,candidate=?,fetched_at=? '
                           "WHERE request_id=? AND generation=? AND status='fetching'",
                           (status, error, due, None if candidate is None else ca.encode(candidate),
                            datetime.now(timezone.utc).isoformat() if status == 'found' else None,
                            row['request_id'], row['generation']))
                db.commit()
            return True
        finally:
            self.lane.release()


def get_row(db, id_):
    row = db.execute('SELECT r.*,i.* FROM av_lookup_requests r JOIN av_inbox i USING(request_id) '
                     'WHERE r.request_id=?', (id_,)).fetchone()
    if row is None:
        wp.fail(404, 'avInboxNotFound', '받은 품번을 찾을 수 없습니다.')
    return row


def summary(row):
    candidate = json.loads(row['candidate']) if row['candidate'] else None
    return dict(id=row['request_id'], requestId=row['request_id'], sequence=row['sequence'],
                productCode=row['product_code'], normalizedCode=row['normalized_code'], sourceUrl=row['source_url'],
                receivedAt=row['received_at'], status=row['status'], attempts=row['attempts'], lastError=row['last_error'],
                fetchedAt=row['fetched_at'], appliedWorkId=row['applied_work_id'],
                titleJa=candidate['fields']['titleJa'] if candidate else None)


def matches(db, code):
    if code is None:
        return []
    if not db.execute("SELECT 1 FROM sqlite_master WHERE name='authority_domains'").fetchone():
        return []
    state = authority.active_domain(db, ca.DOMAIN)
    if state is None:
        return []
    rows = db.execute("SELECT * FROM collection_authority_works WHERE library_id=? AND type='av' "
                      "AND lifecycle='live' ORDER BY work_id", (state['libraryId'],)).fetchall()
    return [dict(libraryId=state['libraryId'], workId=r['work_id'], name=r['name'], entityRevision=r['entity_revision'])
            for r in rows if normalize_code((json.loads(r['details']).get('av') or {}).get('productCode')) == code]


def detail(get_db, id_):
    with get_db() as db:
        row = get_row(db, id_)
        current = matches(db, row['normalized_code'])
    candidate = json.loads(row['candidate']) if row['candidate'] else None
    if candidate:
        candidate = {k: v for k, v in candidate.items() if k != 'jacket'}
        candidate['jacketUrl'] = PREFIX + '/' + id_ + '/jacket'
    return dict(inbox=summary(row), candidate=candidate, matches=current)


def change(get_db, id_, action, body, wake=None):
    with get_db() as db:
        db.execute('BEGIN IMMEDIATE')
        row = get_row(db, id_)
        if action == 'applied':
            ca.require_id(body['workId'])
            if row['status'] == 'applied':
                if row['applied_work_id'] != body['workId']:
                    wp.fail(409, 'avInboxStateConflict', '이미 다른 컬렉션에 적용되었습니다.')
            elif row['status'] != 'found':
                wp.fail(409, 'avInboxCandidateUnavailable', '적용할 후보가 없습니다.')
            else:
                match = next((m for m in matches(db, row['normalized_code']) if m['workId'] == body['workId']), None)
                if match is None:
                    wp.fail(409, 'avInboxWorkMismatch', '서버에 같은 품번의 AV 컬렉션이 없습니다.')
                db.execute("UPDATE av_inbox SET status='applied',applied_work_id=?,applied_library_id=?,generation=generation+1 "
                           'WHERE request_id=?', (body['workId'], match['libraryId'], id_))
        else:
            if row['status'] == 'applied':
                wp.fail(409, 'avInboxStateConflict', '적용된 후보는 변경할 수 없습니다.')
            code = normalize_code(body['productCode']) if action == 'fix-code' else row['normalized_code']
            if action != 'dismiss' and code is None:
                wp.fail(422, 'invalidProductCode', '품번을 확인해 주세요.')
            db.execute('UPDATE av_inbox SET normalized_code=?,status=?,attempts=0,last_error=NULL,fetched_at=NULL,'
                       'started_at=NULL,next_attempt_at=0,generation=generation+1,candidate=NULL WHERE request_id=?',
                       (code, 'dismissed' if action == 'dismiss' else 'queued', id_))
        db.commit()
    if wake is not None and action in ('retry', 'fix-code'):
        wake()
    return detail(get_db, id_)


def render_surface(frame, box, height=None):
    """One surface of a jacket as the stored JPEG (q88) plus its thumbnail bytes.

    ``height`` scales the crop to that height first (a spine borrowed from a smaller image).
    """
    from PIL import Image
    with frame.crop(box) as cropped:
        crop = cropped
        if height is not None and cropped.height != height:
            crop = cropped.resize((max(1, round(cropped.width * height / cropped.height)), height), Image.LANCZOS)
        output = io.BytesIO()
        crop.save(output, 'JPEG', quality=88)
        encoded = output.getvalue()
        if not 0 < len(encoded) <= wp.MAX_ARTWORK_BYTES:
            wp.fail(413, 'providerResponseTooLarge', '분할 이미지가 너무 큽니다.')
        return dict(encoded=encoded, thumbnail=wp.artwork_thumbnail(encoded), width=crop.width, height=crop.height)


def store_surface(get_db, storage, bucket, rendered, deadline):
    blobs = [(rendered['encoded'], 'image/jpeg')]
    if rendered['thumbnail']:
        blobs.append((rendered['thumbnail'], wp.ARTWORK_THUMBNAIL_MIME))
    return confirm_blobs(get_db, storage, bucket, blobs, deadline)


def borrows_spine(candidate, x1, x2):
    """A spine-less jacket whose spine comes from ``spineSource``, unless the split draws a spine of its own."""
    return bool(candidate.get('spineSource')) and x2 - x1 < candidate['jacketWidth'] * SPINE_MIN_SHARE


def render_borrowed_spine(candidate, height, storage, bucket, deadline):
    """The spine strip of ``spineSource`` scaled to the jacket's height."""
    source = candidate['spineSource']
    data, mime = stored_jacket(candidate, storage, bucket, deadline, 'spineSource')
    frame = decode_jacket(data, mime)
    try:
        return render_surface(frame, (source['x1'], 0, source['x2'], frame.height), height)
    finally:
        frame.close()


def prepare_artwork(get_db, id_, body, deadline, storage, bucket):
    with get_db() as db:
        row = get_row(db, id_)
    if row['status'] != 'found' or not row['candidate']:
        wp.fail(409, 'avInboxCandidateUnavailable', '사용할 후보가 없습니다.')
    candidate = json.loads(row['candidate'])
    width, height = candidate['jacketWidth'], candidate['jacketHeight']
    x1, x2, surfaces = body['x1'], body['x2'], body['surfaces']
    wrap = candidate['defaultSplit']['isWrap']
    if (type(x1) is not int or type(x2) is not int or not 0 <= x1 <= x2 <= width
            or not isinstance(surfaces, list) or not 1 <= len(surfaces) <= 3
            or any(not isinstance(s, str) or s not in ('front','spine','back') for s in surfaces)
            or len(set(surfaces)) != len(surfaces)
            or (not wrap and (x1 != 0 or x2 != 0 or surfaces != ['front']))):
        wp.fail(422, 'invalidAvSplit', '재킷 분할선을 확인해 주세요.')
    boxes = dict(front=(x2,0,width,height) if wrap else (0,0,width,height),
                 spine=(x1,0,x2,height), back=(0,0,x1,height))
    borrow = 'spine' in surfaces and borrows_spine(candidate, x1, x2)
    if any(boxes[s][2] <= boxes[s][0] for s in surfaces if not (borrow and s == 'spine')):
        wp.fail(422, 'invalidAvSplit', '너비가 없는 표면은 만들 수 없습니다.')
    data, mime = stored_jacket(candidate, storage, bucket, deadline)
    frame = decode_jacket(data, mime)
    prepared = []
    try:
        for surface in surfaces:
            if borrow and surface == 'spine':
                rendered = render_borrowed_spine(candidate, height, storage, bucket, deadline)
            else:
                rendered = render_surface(frame, boxes[surface])
            receipts = store_surface(get_db, storage, bucket, rendered, deadline)
            prepared.append(dict(surface=surface, kind='cover' if surface=='front' else surface,
                provider='libredmm', providerImageId=f"{row['normalized_code']}:{candidate['jacket']['sha256']}:{x1}:{x2}:{surface}",
                original=receipts[0], thumbnail=receipts[1] if len(receipts)>1 else None,
                width=rendered['width'], height=rendered['height'], language='ja'))
    finally:
        frame.close()
    # Don't return preparation for a candidate replaced/dismissed during storage.
    with get_db() as db:
        latest = get_row(db, id_)
        if latest['generation'] != row['generation'] or latest['status'] != 'found':
            wp.fail(409, 'avInboxStateConflict', '후보가 변경되었습니다. 다시 확인해 주세요.')
    return dict(items=prepared)


def register(app, get_db, require_client, storage, bucket, *, relay=None):
    relay = relay or wp.Relay()
    worker = Worker(get_db, storage, bucket, relay)
    app.state.av_inbox_worker = worker
    lifecycle(app).on_startup(worker.start)
    lifecycle(app).on_drain(worker.drain)
    lifecycle(app).on_shutdown(worker.stop)

    @app.get(PREFIX)
    def listing(before: int | None = Query(default=None, ge=1), limit: int = Query(default=100, ge=1, le=100),
                includeClosed: bool = False, authorization: str | None = Header(default=None)):
        require_client(authorization)
        where, params = [], []
        if not includeClosed:
            where.append("i.status NOT IN ('dismissed','applied')")
        if before is not None:
            where.append('r.sequence<?')
            params.append(before)
        with get_db() as db:
            rows = db.execute('SELECT r.*,i.* FROM av_lookup_requests r JOIN av_inbox i USING(request_id) '
                              + ('WHERE ' + ' AND '.join(where) if where else '')
                              + ' ORDER BY r.sequence DESC LIMIT ?', (*params, limit+1)).fetchall()
        items = [summary(r) for r in rows[:limit]]
        return dict(items=items, nextBefore=items[-1]['sequence'] if len(rows)>limit else None, hasMore=len(rows)>limit)

    @app.get(PREFIX + '/{id_}')
    def candidate(id_: str, authorization: str | None = Header(default=None)):
        require_client(authorization)
        return detail(get_db, id_)

    @app.get(PREFIX + '/{id_}/jacket')
    def jacket(id_: str, authorization: str | None = Header(default=None)):
        require_client(authorization)
        def preview(deadline):
            with get_db() as db:
                row = get_row(db, id_)
            if not row['candidate']:
                wp.fail(409, 'avInboxCandidateUnavailable', '재킷 후보가 없습니다.')
            data, mime = stored_jacket(json.loads(row['candidate']), storage, bucket, deadline)
            return Response(data, media_type=mime, headers={'Cache-Control': 'private, no-store'})
        return relay.paced('artwork', preview)

    @app.get(PREFIX + '/{id_}/spine-source')
    def spine_source(id_: str, authorization: str | None = Header(default=None)):
        """The image a spine-less jacket borrows its spine from (the PC shows the real strip in its spine menu)."""
        require_client(authorization)
        def preview(deadline):
            with get_db() as db:
                row = get_row(db, id_)
            candidate = json.loads(row['candidate']) if row['candidate'] else None
            if not candidate or not candidate.get('spineSource'):
                wp.fail(409, 'avInboxCandidateUnavailable', '책등 후보가 없습니다.')
            data, mime = stored_jacket(candidate, storage, bucket, deadline, 'spineSource')
            return Response(data, media_type=mime, headers={'Cache-Control': 'private, no-store'})
        return relay.paced('artwork', preview)

    @app.post(PREFIX + '/{id_}/artwork')
    async def artwork(id_: str, request: Request, authorization: str | None = Header(default=None)):
        require_client(authorization)
        body = await ca._read_body(request, 2048, 'avLookupRequestTooLarge')
        if not isinstance(body, dict) or set(body) != {'x1','x2','surfaces'}:
            wp.fail(422, 'invalidAvSplit', '재킷 분할 요청이 올바르지 않습니다.')
        return await run_in_threadpool(relay.paced, 'artwork', lambda d:
                                      prepare_artwork(get_db, id_, body, d, storage, bucket))

    @app.post(PREFIX + '/{id_}/{action}')
    async def action(id_: str, action: str, request: Request, authorization: str | None = Header(default=None)):
        require_client(authorization)
        keys = {'retry':set(), 'fix-code':{'productCode'}, 'dismiss':set(), 'applied':{'workId'}}
        if action not in keys:
            wp.fail(404, 'avInboxActionNotFound', '지원하지 않는 후보 동작입니다.')
        body = await ca._read_body(request, 2048, 'avLookupRequestTooLarge')
        if not isinstance(body, dict) or set(body) != keys[action]:
            wp.fail(422, 'invalidAvInboxAction', '후보 동작 요청이 올바르지 않습니다.')
        return await run_in_threadpool(change, get_db, id_, action, body, worker.wake)
    return worker
