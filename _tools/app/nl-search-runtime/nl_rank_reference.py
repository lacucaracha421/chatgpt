"""Small numpy specification for the Rust port; no model imports or inference."""
import argparse
import json
import os
from pathlib import Path
import sqlite3

for key in ('OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'NUMEXPR_NUM_THREADS'):
    os.environ[key] = '1'
import numpy as np

from runtime_support import caption_vocabulary, tag_words, text_units

GATE = 0.6  # Minimum share of known query units for the cosine route ("no match" gate).


def connect_ro(path):
    c = sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True)
    c.execute('PRAGMA query_only=ON')
    return c


def coverage(query, vocab, words):
    """(known, total) query units. `vocab` holds (kind, value) units; `words` holds auto-tag words.

    A 'k' unit is known when it is in the vocabulary; a 'w' unit when it is in the vocabulary or the
    auto-tag words. Repeated units count each time.
    """
    units = text_units(query)
    known = sum(1 for kind, value in units if (kind, value) in vocab or (kind == 'w' and value in words))
    return known, len(units)


def gate_passes(query, vocab, words):
    """True when the cosine route may run: no vocabulary (gate off), or coverage >= GATE."""
    if not vocab:
        return True
    known, total = coverage(query, vocab, words)
    return total > 0 and known / total >= GATE


class Ranker:
    def __init__(self, inbox, library_db):
        self.names, self.tags, self.series = {}, {}, {}
        c = connect_ro(library_db)
        try:
            # One SQLite read transaction keeps corpus, aliases and tags consistent.
            c.execute('BEGIN')
            self.corpus = {r[0] for r in c.execute("SELECT id FROM assets WHERE "
                                  "status='normal' AND media_kind IN ('image','gif')")}
            # Series folder name per character (e.g. 레제 -> 체인소맨) so "체인소맨 레제" stays a name query.
            for target, series in c.execute('SELECT t.id, e.name FROM character_targets t '
                                            'JOIN classification_entries e ON e.id = t.series_classification_id'):
                self.series.setdefault(target, set()).add(series.strip())
            for target, name in c.execute('SELECT id,display_name FROM character_targets'):
                for alias in name.split('/'):
                    alias = alias.strip()
                    if alias:
                        self.names.setdefault(alias, set()).add(target)
            for target, tag in c.execute('SELECT target_id,tag FROM character_target_tagger_tags'):
                self.tags.setdefault(target, set()).add(tag)
            self.scores = {}
            needed = set().union(*self.tags.values()) if self.tags else set()
            for asset, tag, score in c.execute('SELECT asset_id,tag,score FROM asset_auto_tags'):
                if asset in self.corpus and tag in needed:
                    self.scores.setdefault(tag, {})[asset] = float(score)
            has_vocabulary = c.execute("SELECT 1 FROM sqlite_master WHERE type='table' "
                                       "AND name='auto_tag_vocabulary'").fetchone()
            self.tag_words = tag_words(r[0] for r in c.execute('SELECT tag FROM auto_tag_vocabulary')
                                       ) if has_vocabulary else set()
        finally:
            c.close()
        c = connect_ro(inbox)
        try:
            meta = dict(c.execute('SELECT key,value FROM meta'))
            if meta.get('format') != 'lakomics-nl-search' or meta.get('version') != '1':
                raise ValueError('Unsupported inbox format/version')
            rows = [(asset, np.frombuffer(blob, dtype='<f2').astype(np.float32))
                    for asset, blob in c.execute('SELECT asset_id,vector FROM siglip ORDER BY asset_id')
                    if asset in self.corpus]
            # Older exports have no vocab table: the gate is off.
            self.vocab = {(kind, value) for kind, value in c.execute('SELECT kind,value FROM vocab')} if c.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='vocab'").fetchone() else set()
        finally:
            c.close()
        self.ids = [asset for asset, _ in rows]
        if any(vector.shape != (1152,) for _, vector in rows):
            raise ValueError('Invalid SigLIP image vector dimension')
        self.matrix = np.stack([v for _, v in rows]) if rows else np.empty((0, 1152), dtype=np.float32)
        if not np.isfinite(self.matrix).all():
            raise ValueError('Invalid image vector')
        # Trial cosine definition: fp16 storage -> float32 -> normalize again.
        norms = np.linalg.norm(self.matrix, axis=1, keepdims=True)
        if (norms <= 0).any():
            raise ValueError('Zero image vector')
        self.matrix /= np.maximum(norms, 1e-12)

    def rank(self, query, response=None, top=200, force=False):
        if top < 0:
            raise ValueError('top must be nonnegative')
        tokens = query.split()  # Exact whitespace tokens; no particles/substrings/fuzzy matches.
        hit_at = [i for i, token in enumerate(tokens) if token in self.names]
        hits = [tokens[i] for i in hit_at]
        absorbed = set(hit_at)
        for i in hit_at:
            series = {name for target in self.names[tokens[i]] for name in self.series.get(target, ())}
            for j, token in enumerate(tokens):
                if token in series:
                    # The series token and every token between it and the character name are part of
                    # the series title ("젠레스 존 제로 엘렌" -> series 젠레스 + 존 제로 + name 엘렌).
                    absorbed.update(range(min(i, j), max(i, j) + 1))
        other = [token for j, token in enumerate(tokens) if j not in absorbed]
        tags = {tag for hit in hits for target in self.names[hit] for tag in self.tags.get(target, ())}
        scores = {}
        for tag in tags:
            for asset, score in self.scores.get(tag, {}).items():
                scores[asset] = max(scores.get(asset, 0.), score)
        tag_ids = sorted((asset for asset, score in scores.items() if score > 0),
                         key=lambda asset: (-scores[asset], asset))[:top]
        if hits and not other:
            return {'route':'tags', 'asset_ids':tag_ids}
        if not hits and not force and not gate_passes(query, self.vocab, self.tag_words):
            # RULE 0: a query whose words the library's captions do not know answers "no match"
            # without embedding; `force` ranks it anyway.
            return {'route':'no_match', 'asset_ids':[]}
        allowed = None
        if hits:
            # RULE 3: untested in the research trial. Keep this branch isolated:
            # gate at >=0.35, cosine of the FULL query, tag fallback if gate is empty.
            allowed = {asset for asset, score in scores.items() if score >= 0.35}
            if not allowed:
                return {'route':'mixed_fallback', 'asset_ids':tag_ids}
        if response is None or not response.get('ok', False):
            raise ValueError('Successful worker response required for cosine route')
        query_vector = np.asarray(response['siglip'], dtype=np.float32)
        norm = np.linalg.norm(query_vector)
        if (query_vector.shape != (self.matrix.shape[1],) or not np.isfinite(query_vector).all() or norm <= 0):
            raise ValueError('Invalid query vector')
        scores_array = self.matrix @ (query_vector/norm)
        indices = [i for i, asset in enumerate(self.ids) if allowed is None or asset in allowed]
        indices.sort(key=lambda i: (-float(scores_array[i]), self.ids[i]))
        return {'route':'mixed' if hits else 'siglip', 'asset_ids':[self.ids[i] for i in indices[:top]]}


def check_equivalence(inbox, library_db, trial, responses):
    trial = Path(trial)
    expected = json.loads((trial / 'results' / 'H-opus.json').read_text(encoding='utf-8'))
    old_translations = json.loads((trial / 'out' / 'opus_translations.json').read_text(encoding='utf-8'))[
        'Helsinki-NLP/opus-mt-ko-en']
    queries = json.loads((trial / 'queries.json').read_text(encoding='utf-8-sig'))
    ranker = Ranker(inbox, library_db)
    report = {'checked':0, 'mismatches':[], 'translation_changes':[], 'routes':{}}
    for query in queries:
        qid = query['id']
        result = ranker.rank(query['ko'], responses[qid], top=10)
        report['checked'] += 1
        report['routes'][qid] = result['route']
        if result['asset_ids'] != expected[qid][:10]:
            report['mismatches'].append({'id':qid, 'expected':expected[qid][:10], 'actual':result['asset_ids']})
        if responses[qid]['en'] != old_translations[qid]:
            report['translation_changes'].append({'id':qid, 'trial':old_translations[qid],
                'live':responses[qid]['en'], 'top10_equal':result['asset_ids'] == expected[qid][:10]})
    return report


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--inbox', type=Path, help='Exported SQLite file')
    p.add_argument('--db', type=Path, help='Read-only library DB')
    p.add_argument('--query')
    p.add_argument('--response', type=Path, help='Worker embed response JSON file')
    p.add_argument('--top', type=int, default=200)
    p.add_argument('--check-trial', type=Path, help='Trial root; requires --responses')
    p.add_argument('--responses', type=Path, help='Dictionary of live responses by query id')
    p.add_argument('--force', action='store_true', help='Bypass the "no match" gate')
    p.add_argument('--gate-queries', type=Path, help='queries.json: report gate coverage per query; '
                   'requires --captions')
    p.add_argument('--captions', type=Path, help='captions.jsonl that builds the gate vocabulary')
    args = p.parse_args()
    if args.gate_queries:
        if not args.captions:
            p.error('--gate-queries requires --captions')
        vocab = caption_vocabulary(args.captions) or set()
        result = {'vocab_count': len(vocab), 'queries': []}
        for query in json.loads(args.gate_queries.read_text(encoding='utf-8-sig')):
            known, total = coverage(query['ko'], vocab, set())
            result['queries'].append({'id': query['id'], 'ko': query['ko'], 'known': known, 'total': total,
                                      'pass': gate_passes(query['ko'], vocab, set())})
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    if not args.inbox or not args.db:
        p.error('--inbox and --db are required')
    if args.check_trial:
        if not args.responses:
            p.error('--check-trial requires --responses')
        result = check_equivalence(args.inbox, args.db, args.check_trial,
                    json.loads(args.responses.read_text(encoding='utf-8')))
    else:
        if args.query is None:
            p.error('--query is required')
        response = json.loads(args.response.read_text(encoding='utf-8')) if args.response else None
        result = Ranker(args.inbox, args.db).rank(args.query, response, args.top, args.force)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return int(bool(result.get('mismatches')))


if __name__ == '__main__':
    raise SystemExit(main())
