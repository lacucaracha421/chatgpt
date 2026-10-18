import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseJson3, chunkUnits, applyResult, finalizeTimings } from './youtube-classic.mjs';

export const targets = [93000, 107000, 122000, 135000, 148000, 416000, 478000, 486000, 682000, 689000];

// Deterministic translation stand-in: source clauses, with independently variable Korean length.
// This reproduces timing failures, not the user's unavailable model response or audio alignment.
export function replay(track, expanded = false) {
  const { units } = parseJson3(track);
  const chunks = chunkUnits(units, 200);
  const raw = chunks.flatMap(chunk => {
    const slots = globalThis.LakomicsYouTube.chunk.subtitleSlots?.(chunk);
    if (slots?.length) return applyResult(chunk, slots.map(({ from, to }) => ({ from, to,
      text: expanded ? '앞부분의 내용을 자세하게 설명하고 있어요. 뒷부분의 내용도 계속해서 설명하고 있어요.' : '설명이 이어져요.' })), { mode: 'translate-ko' });
    const lines = [];
    let from = 0;
    for (let i = 0; i < chunk.length; i++) {
      const next = chunk[i + 1];
      if (!next || /[.!?,]$/u.test(chunk[i].text) || next.startMs - chunk[from].startMs >= 6500) {
        lines.push({ from, to: i, text: expanded
          ? '앞부분의 내용을 자세하게 설명하고 있어요. 뒷부분의 내용도 계속해서 설명하고 있어요.'
          : '설명이 이어져요.' });
        from = i + 1;
      }
    }
    return applyResult(chunk, lines, { mode: 'translate-ko' });
  });
  return { units, raw, cues: finalizeTimings(raw) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const track = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  for (const expanded of [false, true]) {
    const { units, raw, cues } = replay(track, expanded);
    console.log(expanded ? 'EXPANDED' : 'COMPACT', 'units', units.length, 'cues', cues.length);
    for (const target of targets) {
      console.log(`\nTARGET ${target / 1000}s`);
      console.log('WORDS', units.filter(u => u.startMs >= target - 1800 && u.startMs < target + 2800)
        .map(u => `${u.text}[${u.startMs},${u.endMs}]`).join(' '));
      for (const cue of cues.filter(c => c.startMs < target + 2800 && c.endMs > target - 1800)) {
        const original = raw.find(c => c.startMs === cue.startMs);
        console.log('CUE', JSON.stringify({ ...cue, rawEndMs: original?.endMs }));
      }
    }
  }
}
