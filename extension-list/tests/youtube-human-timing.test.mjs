import { test } from "node:test";
import assert from "node:assert/strict";
import { applyResult, fallbackSegment, finalizeTimings, parseJson3, readingTime, splitDisplayCues } from "./helpers/youtube-classic.mjs";

// A human-made track: one unit per caption event, with the event's real end.
const humanEvents = (events) => parseJson3({ events: events.map(([start, duration, utf8]) =>
  ({ tStartMs: start, dDurationMs: duration, segs: [{ utf8 }] })) }).units;

test("human track keeps a long caption event's own end instead of cutting it short", () => {
  const units = humanEvents([[39540, 6000, "Commodore tried to hold on."], [45600, 2000, "Then it fell."]]);
  const lines = [{ from: 0, to: 0, text: "커모도어도 버텨 보려 했지만 결국 무너지고 말았어요." }, { from: 1, to: 1, text: "그리고 끝났어요." }];
  const human = applyResult(units, lines, { mode: "translate-ko", human: true });
  assert.equal(human[0].startMs, 39540);
  assert.equal(human[0].endMs, 45540);
  // The guard uses only the available silence; it cannot shorten the source event.
  assert.equal(finalizeTimings(human)[0].endMs, 45540);
  // Word tracks only know a start, so the same event is a single estimated word there.
  const asr = applyResult(units, lines, { mode: "translate-ko" });
  assert.equal(asr[0].endMs, 39540 + 1200);
  assert.equal(finalizeTimings(asr)[0].endMs, Math.round(39540 + readingTime(lines[0].text)));
  // Fallback segmentation and clean mode follow the same rule.
  assert.equal(fallbackSegment(units, { mode: "clean", human: true })[0].endMs, 45540);
  assert.equal(fallbackSegment(units, { mode: "clean" })[0].endMs, 39540 + 1200);
});

test("human track end never overlaps the next cue and the chunk's last line uses its own end", () => {
  const units = [{ text: "A", startMs: 0, endMs: 12000 }, { text: "B", startMs: 6000, endMs: 12500 }];
  const lines = [{ from: 0, to: 0, text: "가" }, { from: 1, to: 1, text: "나" }];
  const cues = applyResult(units, lines, { mode: "translate-ko", human: true });
  assert.equal(cues[0].endMs, 6000);
  assert.equal(cues[1].endMs, 12500);
  assert.ok(cues.every((cue, i) => i === 0 || cues[i - 1].endMs <= cue.startMs));
  const single = applyResult([{ text: "Hi", startMs: 1000, endMs: 7000 }], [{ from: 0, to: 0, text: "안녕" }], { mode: "translate-ko", human: true });
  assert.deepEqual([single[0].startMs, single[0].endMs], [1000, 7000]);
});

test("ASR word units are not held through a long silence", () => {
  const units = [{ text: "Hello", startMs: 0, endMs: 400 }, { text: "again", startMs: 6000, endMs: 6400 }];
  const cues = applyResult(units, [{ from: 0, to: 0, text: "안녕" }, { from: 1, to: 1, text: "또" }], { mode: "translate-ko" });
  assert.equal(cues[0].endMs, 400);
  const shown = finalizeTimings(cues);
  assert.equal(shown[0].endMs, 1200);
  assert.equal(shown[1].startMs, 6000);
});

const parts = (text) => splitDisplayCues([{ startMs: 0, endMs: 6000, text, orig: "source" }]).map((cue) => cue.text);

test("display never splits inside a number", () => {
  for (const [text, token] of [
    ["커모도어는 밀린 특허 사용료 1,000만 달러를 낸 뒤에야 겨우 숨통이 트였어요.", "1,000"],
    ["이번 영상의 평균 점수는 3.5점이었고 그 뒤로도 오랫동안 아무도 기억하지 못했어요.", "3.5"],
    ["그 방송은 밤 10:30 에 시작해서 새벽이 될 때까지 쉬지 않고 계속 이어졌어요.", "10:30"],
  ]) {
    assert.ok(Array.from(text).length > 44, text);
    const out = parts(text);
    assert.ok(out.length > 1 || out[0].includes(token));
    assert.ok(out.some((line) => line.includes(token)), `${token} split in ${JSON.stringify(out)}`);
    assert.equal(out.join(" ").replace(/\s/g, ""), text.replace(/\s/g, ""));
  }
});

test("display does not leave a predicate tail alone after a long-line split", () => {
  for (const text of [
    "그래서 이 회사는 시장에서 끝없이 이어진 가격 경쟁에서 결국 밀려나게 되고 말았어요.",
    "그래서 이 회사는 시장에서 끝없이 이어진 가격 경쟁에서 결국 다 무너져 버렸어요.",
    "그래서 이 회사는 시장에서 끝없이 이어진 가격 경쟁에서 결국 하고 싶었던 일을 못 했어요.",
  ]) {
    assert.ok(Array.from(text).length > 44, text);
    const out = parts(text);
    assert.equal(out.join(" ").replace(/\s/g, ""), text.replace(/\s/g, ""));
    for (const line of out) assert.doesNotMatch(line, /^(?:되고|되어|돼|하게|하고 말|말았|버렸|싶었)/u, JSON.stringify(out));
    assert.ok(out.every((line) => line.split(/\s+/u).length >= 2), JSON.stringify(out));
  }
});

test("when no safe boundary exists the Korean line stays whole", () => {
  const text = "하나의 아주 긴 문장이라서 나누면 안 되는 말이 계속 이어져서 끝내 밀려나게 되고 말았어요.";
  const out = parts(text);
  assert.ok(out.every((line) => !/^(?:되고|말았)/u.test(line)), JSON.stringify(out));
});
