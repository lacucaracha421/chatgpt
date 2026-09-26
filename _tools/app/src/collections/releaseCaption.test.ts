import { expect, it } from "vitest";
import type { CollectionSummary, ReleaseBoardEntry, ReleaseInboxItem } from "../library/types";
import { groupInbox, japanReleases, koreanReleases, koreanVolumeLine, releaseCaption, shortReleaseDate } from "./releaseCaption";

const today = "2026-09-26";
const work = (id: string, unreadReleaseCount = 0, type: CollectionSummary["type"] = "manga") => ({ id, name: id, type, unreadReleaseCount }) as CollectionSummary;
const item = (collectionId: string, volumeNumber: number, currentValue: string | null, provider: ReleaseInboxItem["provider"] = "kakao", kind: ReleaseInboxItem["event"]["kind"] = "new_volume"): ReleaseInboxItem =>
  ({ collectionId, collectionName: collectionId, provider, event: { id: `${collectionId}-${volumeNumber}-${kind}-${provider}`, kind, volumeNumber, previousValue: null, currentValue, detectedAt: "2026-09-20T00:00:00Z" } });
const entry = (collectionId: string, options: { watch?: boolean; owned?: number | null; kakao?: [number, string | null][] | null; mangadex?: number | null }): ReleaseBoardEntry => ({
  collectionId,
  releaseWatch: { enabled: options.watch ?? true, available: true },
  ownedVolumes: options.owned == null ? [] : [{ editionIndex: 0, count: options.owned }],
  releaseSchedule: {
    kakao: options.kakao === null ? null : { editionIndex: 0, checkedAt: null, volumes: (options.kakao ?? []).map(([volumeNumber, date]) => ({ volumeNumber, date, status: null })) },
    mangadex: options.mangadex == null ? null : { checkedAt: null, latestVolume: options.mangadex, volumes: [{ volumeNumber: options.mangadex, editionIndex: 0 }] },
  },
});
const kakao: [number, string | null][] = [[11, "2026-01-01"], [12, "2026-08-01"], [13, "2026-09-24"], [14, "2026-11-20"], [15, null]];

it("(a) an unread release names the unowned Korean volumes already out, with the latest date", () => {
  expect(releaseCaption(work("w", 1), entry("w", { owned: 11, kakao }), [item("w", 13, "2026-09-24")], today)).toEqual({ kind: "new", text: "신간 12–13권", date: "9.24" });
  // Owned volumes are never announced.
  expect(releaseCaption(work("w", 1), entry("w", { owned: 12, kakao }), [item("w", 13, "2026-09-24")], today)).toEqual({ kind: "new", text: "신간 13권", date: "9.24" });
  // Without a recorded count only the newest volume is named.
  expect(releaseCaption(work("w", 1), entry("w", { owned: null, kakao }), [item("w", 13, "2026-09-24")], today)?.text).toBe("신간 13권");
  // Unread notices the schedule cannot name, and games or movies, read as a count.
  expect(releaseCaption(work("w", 1), entry("w", { owned: 13, kakao }), [item("w", 30, null, "mangadex")], today)).toEqual({ kind: "new", text: "신간 알림 1", date: null });
  expect(releaseCaption(work("g", 2, "game"), undefined, [], today)).toEqual({ kind: "new", text: "신간 알림 2", date: null });
  expect(releaseCaption(work("g", 0, "movie"), undefined, [], today)).toBeNull();
});

it("(b) a watched work with released but unowned volumes is muted; (c) otherwise the soonest pre-registered volume", () => {
  expect(releaseCaption(work("w"), entry("w", { owned: 11, kakao }), [], today)).toEqual({ kind: "out", text: "신간 12–13권", date: "9.24" });
  expect(releaseCaption(work("w"), entry("w", { owned: 13, kakao }), [], today)).toEqual({ kind: "ahead", text: "14권 예약", date: "11.20" });
  // Undated pre-registrations are not announced; nothing is left once everything is owned.
  expect(releaseCaption(work("w"), entry("w", { owned: 14, kakao }), [], today)).toBeNull();
  // Not watched: nothing without unread notices.
  expect(releaseCaption(work("w"), entry("w", { watch: false, owned: 11, kakao }), [], today)).toBeNull();
  expect(shortReleaseDate("2027-01-05", today)).toBe("2027.1.5");
});

it("names unread new volumes from the inbox when the board is unavailable", () => {
  expect(releaseCaption(work("w", 3), undefined, [item("w", 5, "2026-09-10"), item("w", 7, "2026-09-12"), item("w", 6, null, "aladin")], today)).toEqual({ kind: "new", text: "신간 5–7권", date: "9.12" });
  expect(releaseCaption(work("w", 1), undefined, [item("w", 9, "2026-11-20")], today)).toEqual({ kind: "new", text: "신간 알림 1", date: null });
  expect(releaseCaption(work("w", 0), undefined, [], today)).toBeNull();
});

it("한국 정발 lists each watched work's unowned Kakao volumes, soonest upcoming first", () => {
  const works = [work("soon"), work("recent"), work("owned"), work("off"), work("nodate")];
  const board = new Map([
    ["soon", entry("soon", { owned: 13, kakao })],
    ["recent", entry("recent", { owned: 12, kakao: kakao.slice(0, 3) })],
    ["owned", entry("owned", { owned: 20, kakao })],
    ["off", entry("off", { watch: false, owned: 0, kakao })],
    ["nodate", entry("nodate", { owned: 0, kakao: [[1, null]] })],
  ]);
  const rows = koreanReleases(works, board, groupInbox([item("recent", 13, "2026-09-24")]), today);
  expect(rows.map(row => row.work.id)).toEqual(["soon", "recent", "nodate"]);
  expect(rows[0]!.volumes.map(volume => [volume.volumeNumber, volume.upcoming, volume.released])).toEqual([[14, true, false], [15, false, false]]);
  expect(rows[1]).toMatchObject({ owned: 12, fresh: 1, volumes: [{ volumeNumber: 13, fresh: true, released: true }] });
  expect(koreanVolumeLine(rows[0]!.volumes[0]!, today)).toBe("14권 · 11월 20일 발매 예정");
  expect(koreanVolumeLine(rows[0]!.volumes[1]!, today)).toBe("15권 · 발매일 미정");
  expect(koreanVolumeLine({ volumeNumber: 3, date: "2025-12-02", upcoming: false, released: true, fresh: false }, today)).toBe("3권 · 2025년 12월 2일 발매됨");
});

it("일본 shows the latest MangaDex volume and how far it is ahead, newly detected first", () => {
  const works = [work("far"), work("fresh"), work("even"), work("nokakao")];
  const board = new Map([
    ["far", entry("far", { owned: 1, kakao: [[1, null], [2, null]], mangadex: 9 })],
    ["fresh", entry("fresh", { owned: 1, kakao: [[1, null], [2, null], [3, null]], mangadex: 5 })],
    ["even", entry("even", { owned: 1, kakao: [[1, null], [2, null]], mangadex: 2 })],
    ["nokakao", entry("nokakao", { kakao: null, mangadex: 4 })],
  ]);
  const rows = japanReleases(works, board, groupInbox([item("fresh", 5, null, "mangadex")]));
  expect(rows.map(row => row.work.id)).toEqual(["fresh", "far", "even", "nokakao"]);
  expect(rows[0]).toMatchObject({ latest: 5, ahead: 2, aheadVolumes: [{ volumeNumber: 4, fresh: false }, { volumeNumber: 5, fresh: true }] });
  expect(rows[1]).toMatchObject({ latest: 9, ahead: 7 });
  expect(rows[2]).toMatchObject({ ahead: null, aheadVolumes: [] });
  expect(rows[3]).toMatchObject({ latest: 4, ahead: null });
});
