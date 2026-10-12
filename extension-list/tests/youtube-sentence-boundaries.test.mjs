import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkUnits, applyResult, TRANSLATE_KO_SYSTEM_PROMPT, SYSTEM_PROMPT } from "./helpers/youtube-classic.mjs";

const units = (count) => Array.from({ length: count }, (_, i) => ({ text: `w${i}`, startMs: i * 300, endMs: (i + 1) * 300 }));

test("chunk cuts prefer sentence punctuation with closing quotes over a larger pause", () => {
  for (const end of ['.', '!', '?', '。', '！', '？', '…', '.")', '？」', '。】', '！］', '？｝']) {
    const source = units(400);
    source[119].text += end;
    source.forEach((unit, i) => { if (i >= 180) unit.startMs += 5000; });
    assert.equal(chunkUnits(source, 200)[0].length, 120, end);
  }
});

test("sentence-end ties use the larger pause, then the later cut", () => {
  const source = units(400);
  source[119].text += '.';
  source[149].text += '!';
  assert.equal(chunkUnits(source, 200)[0].length, 150);
  source.forEach((unit, i) => { if (i >= 120) unit.startMs += 1000; });
  assert.equal(chunkUnits(source, 200)[0].length, 120);
});

test("uniform 201 units rebalance into 171 and 30 without separating do from not", () => {
  const source = units(201);
  source[199].text = 'do';
  source[200].text = 'not';
  const chunks = chunkUnits(source, 200);
  assert.deepEqual(chunks.map(chunk => chunk.length), [171, 30]);
  assert.deepEqual(chunks.flat(), source);
  assert.deepEqual(chunks.at(-1).slice(-2).map(unit => unit.text), ['do', 'not']);
});

test("chunks preserve coverage, a minimum tail and a hard 240-unit bound", () => {
  for (const count of [200, 201, 229, 230, 239, 240, 241, 401, 1001, 10000]) {
    for (const limit of [200, 600]) {
      const source = units(count);
      const chunks = chunkUnits(source, limit);
      assert.ok(chunks.every(chunk => chunk.length <= Math.min(limit, 240)));
      assert.ok(chunks.every(chunk => chunk.length >= 30));
      assert.deepEqual(chunks.flat(), source);
    }
  }
});

test("translation prompt forbids isolated endings and bounds incomplete sentences to the chunk", () => {
  assert.match(TRANSLATE_KO_SYSTEM_PROMPT, /Never output a line containing only a sentence ending, auxiliary verb or particle/);
  assert.match(TRANSLATE_KO_SYSTEM_PROMPT, /않아요, 있어요, 거예요/);
  assert.match(TRANSLATE_KO_SYSTEM_PROMPT, /extending that line's index range/);
  assert.match(TRANSLATE_KO_SYSTEM_PROMPT, /chunk's last index.*without inventing words/);
  assert.doesNotMatch(SYSTEM_PROMPT, /auxiliary verb or particle/);
});

const translated = (source, first, second) => applyResult(source, [
  { from: 0, to: 0, text: first }, { from: 1, to: 1, text: second },
], { mode: 'translate-ko' });

test("a dangling ending joins its preceding translated line and extends time and source range", () => {
  const source = units(2);
  source[1].endMs = 2000;
  for (const ending of ['않아요', '않아요.', '않아요.”', '않아요,', '않습니다', '있어요', '없어요', '거예요', '같아요', '이에요', '예요']) {
    assert.deepEqual(translated(source, '생각하지', ending), [{
      startMs: 0, endMs: 300 + 250 + 60 * 2, text: `생각하지 ${ending}`, orig: 'w0 w1',
    }]);
  }
});

test("standalone answers, sentence ends and long pauses remain separate", () => {
  assert.equal(translated(units(2), '생각하지', '아니요, 안 해요.').length, 2);
  for (const end of ['.', '!', '?', '。', '！', '？', '…', '.”', '?)', '！］', '？｝']) {
    assert.equal(translated(units(2), `그렇게 생각해요${end}`, '않아요').length, 2);
  }
  const source = units(2);
  source[1].startMs = 1501;
  source[1].endMs = 2200;
  assert.equal(translated(source, '생각하지', '않아요').length, 2);
  source[1].startMs = 1500;
  assert.equal(translated(source, '생각하지', '않아요').length, 1);
});

test("dangling endings never merge across chunks or in clean mode", () => {
  const source = units(2);
  const lines = [{ from: 0, to: 0, text: '생각하지' }, { from: 1, to: 1, text: '않아요' }];
  assert.equal(applyResult(source, lines, { mode: 'clean' }).length, 2);
  const first = applyResult(source.slice(0, 1), lines.slice(0, 1), { mode: 'translate-ko' });
  const second = applyResult(source.slice(1), [{ from: 0, to: 0, text: '않아요' }], { mode: 'translate-ko' });
  assert.equal(first.length + second.length, 2);
  assert.equal(second[0].text, '않아요');
});
