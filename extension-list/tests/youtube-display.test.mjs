import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitDisplayCues, applyResult, finalizeTimings } from './helpers/youtube-classic.mjs';

// Translation text is laid out inside its source slot. Character counts cannot align languages.
test('translated source endpoints survive long text, predicate tails, numbers and repeated display passes', () => {
  for (const text of [
    '커모도어는 밀린 특허 사용료 1,000만 달러를 낸 뒤에야 겨우 숨통이 트였어요.',
    '우선 지금까지 살펴본 내용을 충분히 설명할게요. 저는 이 방법을 사용하면 문제가 다시 생길 거라고 생각하지 않아요.',
    '짧은 문장입니다.',
  ]) {
    const input = { startMs: 100, endMs: 9500, text, orig: 'source words' };
    assert.deepEqual(splitDisplayCues([input]), [input]);
    assert.deepEqual(splitDisplayCues(splitDisplayCues([input])), [input]);
  }
});

test('translation length cannot move the next source onset or create duplicate intervals', () => {
  const units = Array.from({ length: 20 }, (_, i) => ({ text: 'word', startMs: i * 300, endMs: (i + 1) * 300 }));
  for (const text of ['네', '긴 번역문도 원문이 말하는 시간 안에 맞추어서 보여주고 읽는 시간 때문에 다시 나누지는 않아요.']) {
    const cues = applyResult(units, [{ from: 0, to: 19, text }], { mode: 'translate-ko', human: true });
    assert.equal(cues.length, 1);
    assert.deepEqual([cues[0].startMs, cues[0].endMs], [0, 6000]);
    assert.equal(cues[0].orig, units.map(u => u.text).join(' '));
    assert.ok(!Object.hasOwn(cues[0], 'wordStarts') && !Object.hasOwn(cues[0], 'wordChars'));
    assert.equal(finalizeTimings(cues)[0].endMs, 6000);
  }
});

test('short text held for a long source interval is never copied into multiple cues', () => {
  for (const extra of [{}, { orig: 'source' }]) {
    const input = { startMs: 0, endMs: 30000, text: '네', ...extra };
    assert.deepEqual(splitDisplayCues([input]), [input]);
  }
});

test('clean captions still split long text without losing content or endpoints', () => {
  for (const text of ['이는 긴 자막입니다. '.repeat(20), 'これは長い字幕です。'.repeat(20), 'First sentence ends here. Second clause, with more words to read. '.repeat(4)]) {
    const cues = splitDisplayCues([{ startMs: 100, endMs: 25100, text }]);
    assert.ok(cues.length > 1);
    assert.equal(cues[0].startMs, 100);
    assert.equal(cues.at(-1).endMs, 25100);
    assert.equal(cues.map(c => c.text).join('').replace(/\s/gu, ''), text.replace(/\s/gu, ''));
    for (let i = 1; i < cues.length; i++) assert.equal(cues[i - 1].endMs, cues[i].startMs);
  }
});
