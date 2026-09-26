import { expect, it } from "vitest";
import { batchProgress, buildTimeline, dayLabel, extensionLabel, withParticle } from "./timeline";

it("groups a batch into one block and orders blocks oldest first", () => {
  const entry = (transferId: string, batchId: string, mine: boolean, at: string) => ({ row: transferId, transferId, batchId, mine, at });
  const blocks = buildTimeline([
    entry("b", "batch", true, "2026-09-26T05:32:00Z"),
    entry("a", "batch", true, "2026-09-26T05:31:00Z"),
    entry("c", "c", false, "2026-09-25T12:00:00Z"),
    entry("queued", "", true, ""),
  ]);
  expect(blocks.map((block) => block.entries.map((item) => item.row))).toEqual([["c"], ["a", "b"], ["queued"]]);
  expect(blocks[1].at).toBe("2026-09-26T05:31:00Z");
});

it("labels days, particles, extensions and combined progress", () => {
  const now = new Date(2026, 8, 26, 15);
  expect(dayLabel(new Date(2026, 8, 26, 9).toISOString(), now)).toEqual({ date: "9. 26", note: "오늘" });
  expect(dayLabel(new Date(2026, 8, 25, 9).toISOString(), now)).toEqual({ date: "9. 25", note: "어제" });
  expect(dayLabel(new Date(2026, 8, 22, 9).toISOString(), now).note).toBe("화");
  expect(withParticle("Galaxy Tab S11", "과", "와")).toBe("Galaxy Tab S11과");
  expect(withParticle("DESKTOP", "과", "와")).toBe("DESKTOP와");
  expect(withParticle("작업실 PC", "과", "와")).toBe("작업실 PC와");
  expect(withParticle("태블릿", "과", "와")).toBe("태블릿과");
  expect(extensionLabel("표지.psd")).toBe("PSD");
  expect(batchProgress([{ size: 100, done: 100, finished: true }, { size: 100, done: 50, finished: false }]))
    .toEqual({ size: 200, done: 150, finished: 1, total: 2, percent: 75 });
});
