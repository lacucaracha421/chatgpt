import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseJson3, applyResult, finalizeTimings, splitDisplayCues, buildChunkPrompt } from './helpers/youtube-classic.mjs';
import { replay, targets } from './helpers/youtube-speech-replay.mjs';

// Unmodified events from the user's 4JBqJ-ax-lM English json3, trimmed to the four
// reported regions (87–156, 406–424, 470–494, 671–696 seconds). Empty rolling events are retained.
const track = JSON.parse(readFileSync(new URL('./fixtures/youtube/4JBqJ-ax-lM-timing-excerpts.json3.json', import.meta.url), 'utf8'));
const { subtitleSlots, subtitleSlotProblem } = globalThis.LakomicsYouTube.chunk;
const result = replay(track);

test('11:22 and 11:29 keep measurements and their clauses together at source word onsets', () => {
  for (const expanded of [false, true]) {
    const replayed = replay(track, expanded);
    for (const phrase of ['5 and 1/2 ft', "it's hanging 50 lbs that far away from the center."]) {
      assert.ok(replayed.cues.some(c => c.orig.includes(phrase)), `split source phrase: ${phrase}`);
    }
    for (const cue of replayed.cues.filter(c => c.startMs >= 675120 && c.startMs < 695280)) {
      const first = replayed.units.find(u => u.startMs === cue.startMs);
      assert.ok(first && cue.orig.startsWith(first.text));
      const event = track.events.find(e => e.segs?.some(s =>
        e.tStartMs + (s.tOffsetMs || 0) === first.startMs && s.utf8.trim() === first.text));
      const seg = event.segs.find(s => event.tStartMs + (s.tOffsetMs || 0) === first.startMs);
      assert.equal(cue.startMs, event.tStartMs + (seg.tOffsetMs || 0), 'no lead before the first source word');
      const previous = replayed.units[replayed.units.indexOf(first) - 1];
      assert.ok(!previous || previous.endMs <= cue.startMs, 'preceding source interval must stay intact');
    }
  }
});

for (const target of targets) {
  test(`real rolling captions at ${target / 1000}s: source onsets and ends survive translation and timing`, () => {
    const words = result.units.filter(u => u.startMs >= target - 1000 && u.startMs <= target + 2000);
    assert.ok(words.length);
    for (const word of words) {
      const cue = result.raw.find(c => c.startMs <= word.startMs && c.endMs >= word.endMs);
      assert.ok(cue, `source interval ${word.startMs}–${word.endMs} lost`);
      const shown = result.cues.find(c => c.startMs === cue.startMs);
      assert.ok(shown.endMs >= word.endMs, `early end ${shown.endMs} before ${word.endMs}`);
      assert.equal(cue.startMs, result.units.find(u => u.startMs === cue.startMs).startMs);
    }
    const expanded = replay(track, true);
    assert.deepEqual(expanded.raw.map(c => [c.startMs, c.endMs]), result.raw.map(c => [c.startMs, c.endMs]));
    assert.deepEqual(expanded.cues.map(c => c.startMs), result.cues.map(c => c.startMs));
    for (let i = 1; i < result.cues.length; i++) assert.ok(result.cues[i - 1].endMs <= result.cues[i].startMs);
  });
}

test('rolling events are ordered and each timestamped word is consumed once before chunking', () => {
  const speech = track.events.find(e => !e.aAppend && e.segs.some(s => s.tOffsetMs > 0));
  const overlapped = { events: [structuredClone(speech), ...track.events] };
  const before = parseJson3(track).units;
  const after = parseJson3(overlapped).units;
  assert.deepEqual(after.map(u => [u.startMs, u.endMs]), before.map(u => [u.startMs, u.endMs]));
  const appended = structuredClone(track);
  appended.events.find(e => e.tStartMs === speech.tStartMs && !e.aAppend).aAppend = 1;
  assert.deepEqual(parseJson3(appended).units.map(u => [u.startMs, u.endMs]), before.map(u => [u.startMs, u.endMs]));
  const repeated = structuredClone(speech);
  repeated.tStartMs += 1000000;
  assert.ok(parseJson3({ events: [...track.events, repeated] }).units.length > before.length,
    'the same words spoken later must remain');
});

test('source slots cover every word once and long speech prefers a clause boundary', () => {
  const units = result.units.filter(u => u.startMs >= 409720 && u.startMs < 419720);
  const slots = subtitleSlots(units);
  assert.ok(slots.length > 1);
  assert.equal(slots[0].from, 0);
  assert.equal(slots.at(-1).to, units.length - 1);
  for (let i = 0; i < slots.length; i++) {
    assert.ok(slots[i].endMs - slots[i].startMs <= 7000);
    if (i) assert.equal(slots[i].from, slots[i - 1].to + 1);
  }
  assert.ok(slots.at(-1).to - slots.at(-1).from >= 2, 'do not strand the final word after a long sentence');
  assert.equal(subtitleSlotProblem(units, slots), null);
  assert.ok(subtitleSlotProblem(units, [{ from: 0, to: units.length - 1 }]));
  const prompt = buildChunkPrompt({ chunk: units, mode: 'translate-ko' });
  const table = prompt.userText.split('\n').filter(line => line.startsWith('{') && line.includes('"targetChars"')).map(JSON.parse);
  assert.deepEqual(table.map(s => [s.from, s.to, s.startMs, s.endMs]), slots.map(s => [s.from, s.to, s.startMs, s.endMs]));
});

test('7:58 long translated source slot stays a single cue across display/cache passes', () => {
  const units = result.units.filter(u => u.startMs >= 473320 && u.startMs < 483160);
  const cues = applyResult(units, [{ from: 0, to: units.length - 1, text: '처음에는 울트라와이드가 좋겠다고 생각했어요.' }], { mode: 'translate-ko' });
  assert.equal(cues.length, 1);
  assert.deepEqual([cues[0].startMs, cues[0].endMs], [units[0].startMs, units.at(-1).endMs]);
  assert.deepEqual(splitDisplayCues(JSON.parse(JSON.stringify(cues))), cues);
  assert.ok(!Object.hasOwn(cues[0], 'sourceEndMs'));
});

test('reading time and the minimum gap use silence without cutting source speech or delaying the next onset', () => {
  const input = [
    { startMs: 0, endMs: 250, text: '네' },
    { startMs: 1800, endMs: 3100, text: '다음' },
    { startMs: 3140, endMs: 3500, text: '짧은 간격' },
  ];
  const shown = finalizeTimings(input);
  assert.ok(shown[0].endMs >= 1000 && shown[0].endMs < input[1].startMs);
  assert.equal(shown[1].endMs, input[1].endMs, '40 ms of silence must not become an 80 ms speech cut');
  assert.deepEqual(shown.map(c => c.startMs), input.map(c => c.startMs));
});
