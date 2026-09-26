import { expect, it } from "vitest";
import type { CollectionSummary, ReleaseInboxItem } from "../library/types";
import { releaseCaption, shortReleaseDate } from "./releaseCaption";

const work = (unreadReleaseCount: number) => ({ id: "w", type: "manga", unreadReleaseCount }) as CollectionSummary;
const item = (volumeNumber: number, currentValue: string | null, provider: ReleaseInboxItem["provider"] = "kakao", kind: ReleaseInboxItem["event"]["kind"] = "new_volume"): ReleaseInboxItem =>
  ({ collectionId: "w", collectionName: "w", provider, event: { id: `${volumeNumber}-${kind}`, kind, volumeNumber, previousValue: null, currentValue, detectedAt: "2026-09-20T00:00:00Z" } });
const today = "2026-09-26";

it("names the newest released unread volume with its date, or the range", () => {
  expect(releaseCaption(work(1), [item(13, "2026-09-24")], today)).toEqual({ kind: "new", text: "신간 13권", date: "9.24" });
  expect(releaseCaption(work(3), [item(5, "2026-09-10"), item(7, "2026-09-12"), item(6, null, "aladin")], today)).toEqual({ kind: "new", text: "신간 5–7권", date: "9.12" });
  // Released volumes win over an upcoming one in the same batch.
  expect(releaseCaption(work(2), [item(8, "2026-09-01"), item(9, "2026-11-20")], today)?.text).toBe("신간 8권");
});

it("shows the soonest upcoming volume when every unread new volume is still ahead", () => {
  expect(releaseCaption(work(2), [item(10, "2027-01-05"), item(9, "2026-11-20")], today)).toEqual({ kind: "ahead", text: "9권 예약", date: "11.20" });
  expect(shortReleaseDate("2027-01-05", today)).toBe("2027.1.5");
});

it("falls back to a count for notices it cannot name, and to nothing without unread notices", () => {
  expect(releaseCaption(work(1), [item(30, null, "mangadex")], today)).toEqual({ kind: "new", text: "신간 알림 1", date: null });
  expect(releaseCaption(work(2), [item(4, "2026-10-01", "kakao", "release_date_changed")], today)?.text).toBe("신간 알림 2");
  expect(releaseCaption(work(3), [], today)).toEqual({ kind: "new", text: "신간 알림 3", date: null });
  expect(releaseCaption(work(0), [], today)).toBeNull();
});
