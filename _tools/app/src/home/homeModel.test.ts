import { describe, expect, it } from "vitest";
import type { CollectionSummary, ReleaseBoardEntry, ReleaseInboxItem } from "../library/types";
import { nextInSeriesRows } from "./homeModel";

const today = "2026-09-29";

function work(id: string, name: string, type: CollectionSummary["type"] = "manga"): CollectionSummary {
  return { id, name, type } as CollectionSummary;
}

function entry(
  collectionId: string,
  owned: number,
  volumes: { volumeNumber: number; date: string | null; status: "upcoming" | "released" | null }[],
  enabled = true,
): ReleaseBoardEntry {
  return {
    collectionId,
    releaseWatch: { enabled, available: true },
    ownedVolumes: [{ editionIndex: 0, count: owned }],
    releaseSchedule: { kakao: { editionIndex: 0, checkedAt: null, volumes }, mangadex: null },
  };
}

function event(collectionId: string, volumeNumber: number): ReleaseInboxItem {
  return {
    collectionId,
    collectionName: collectionId,
    provider: "kakao",
    event: { id: `${collectionId}-${volumeNumber}`, kind: "new_volume", volumeNumber, previousValue: null, currentValue: null, detectedAt: "2026-09-29T00:00:00Z" },
  };
}

describe("nextInSeriesRows", () => {
  it("keeps released unowned manga volumes and reports the first gap", () => {
    const collections = [work("series", "Series"), work("game", "Game", "game")];
    const board = new Map([
      ["series", entry("series", 2, [
        { volumeNumber: 2, date: "2026-01-01", status: null },
        { volumeNumber: 3, date: "2026-09-20", status: null },
        { volumeNumber: 4, date: null, status: "released" },
        { volumeNumber: 5, date: "2026-10-10", status: "released" },
      ])],
      ["game", entry("game", 0, [{ volumeNumber: 1, date: "2026-09-20", status: null }])],
    ]);

    expect(nextInSeriesRows(collections, board, new Map(), today)).toEqual([{
      work: collections[0],
      ownedCount: 2,
      nextVolume: { number: 3, date: "2026-09-20" },
      releasedUnownedCount: 3,
      fresh: false,
    }]);
  });

  it("orders fresh rows first, then the most recent first unowned release", () => {
    const collections = [work("older", "Older"), work("fresh", "Fresh"), work("newer", "Newer"), work("future", "Future")];
    const board = new Map([
      ["older", entry("older", 0, [
        { volumeNumber: 1, date: "2026-08-01", status: null },
        { volumeNumber: 2, date: "2026-09-28", status: null },
      ])],
      ["fresh", entry("fresh", 0, [{ volumeNumber: 1, date: "2026-07-01", status: null }])],
      ["newer", entry("newer", 0, [{ volumeNumber: 1, date: "2026-09-25", status: null }])],
      ["future", entry("future", 0, [{ volumeNumber: 1, date: "2026-10-01", status: null }])],
    ]);
    const inbox = new Map([["fresh", [event("fresh", 1)]]]);

    expect(nextInSeriesRows(collections, board, inbox, today).map((row) => row.work.id))
      .toEqual(["fresh", "older", "newer"]);
  });

  it("inherits koreanReleases watch and ownership rules", () => {
    const collections = [work("owned", "Owned"), work("off", "Off")];
    const board = new Map([
      ["owned", entry("owned", 1, [{ volumeNumber: 1, date: "2026-09-01", status: null }])],
      ["off", entry("off", 0, [{ volumeNumber: 1, date: "2026-09-01", status: null }], false)],
    ]);

    expect(nextInSeriesRows(collections, board, new Map(), today)).toEqual([]);
  });
});
