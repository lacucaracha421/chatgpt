import { afterEach, describe, expect, it, vi } from "vitest";
import { catalogRefreshAgeLabel } from "./catalogRefreshAge";

afterEach(() => vi.useRealTimers());

describe("catalogRefreshAgeLabel", () => {
  it("formats the age of the last catalog DB update as time passes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T12:00:00Z"));
    const updatedAt = "2026-09-25T12:00:00Z";
    expect(catalogRefreshAgeLabel(updatedAt, Date.now())).toBe("방금 갱신");
    vi.advanceTimersByTime(59_999);
    expect(catalogRefreshAgeLabel(updatedAt, Date.now())).toBe("방금 갱신");
    vi.advanceTimersByTime(1);
    expect(catalogRefreshAgeLabel(updatedAt, Date.now())).toBe("1분 전 갱신");
    vi.advanceTimersByTime(58 * 60_000);
    expect(catalogRefreshAgeLabel(updatedAt, Date.now())).toBe("59분 전 갱신");
    vi.advanceTimersByTime(60_000);
    expect(catalogRefreshAgeLabel(updatedAt, Date.now())).toBe("1시간 전 갱신");
    vi.advanceTimersByTime(46 * 3_600_000);
    expect(catalogRefreshAgeLabel(updatedAt, Date.now())).toBe("47시간 전 갱신");
    vi.advanceTimersByTime(3_600_000);
    expect(catalogRefreshAgeLabel(updatedAt, Date.now())).toBe("2일 전 갱신");
  });

  it("hides unknown timestamps and treats a future time as just refreshed", () => {
    const now = Date.parse("2026-09-25T12:00:00Z");
    expect(catalogRefreshAgeLabel(null, now)).toBeNull();
    expect(catalogRefreshAgeLabel("not a date", now)).toBeNull();
    expect(catalogRefreshAgeLabel("2026-09-25T12:05:00Z", now)).toBe("방금 갱신");
  });
});
