import { describe, expect, it } from "vitest";
import { daysUntil, ddayLabel, displayCount, displayDate, displayDateRange, displayDateTime, displayDDay, displayDuration, displayTime } from "./displayDate";

const now = new Date(2026, 8, 23, 10, 30);
describe("displayDate", () => {
  it.each([
    ["2026-01-02", "1.2"],
    ["2025-09-19", "2025.9.19"],
    ["2027-01-02", "2027.1.2"],
    ["1997", "1997"],
    ["2026", "2026"],
    ["2026-09", "2026.9"],
    ["2025-09", "2025.9"],
    ["2024-02-29", "2024.2.29"],
    ["2026-09-01~2026-09-23", "9.1–9.23"],
    ["2025-09-01–2026-09-23", "2025.9.1–9.23"],
    ["invalid", "invalid"],
    ["2026-02-30", "2026-02-30"],
    ["2026-13", "2026-13"],
    ["2026-00-01", "2026-00-01"],
    ["2026-02-30T12:00:00Z", "2026-02-30T12:00:00Z"],
    ["unknown ~ pending", "unknown ~ pending"],
    ["2026-02-30 ~ 2026-03-01", "2026-02-30 ~ 2026-03-01"],
    ["2026-09-23~", "2026-09-23~"],
    ["", ""],
  ])("formats %s as %s", (value, expected) => {
    expect(displayDate(value, now)).toBe(expected);
  });
  it("uses the injected viewer year and local timestamp date", () => {
    const local = new Date(2027, 0, 1, 0, 15);
    expect(displayDate(local.toISOString(), local)).toBe("1.1");
    expect(displayDate(local.getTime(), now)).toBe("2027.1.1");
    expect(displayDate("2027-01-02", local)).toBe("1.2");
    expect(displayDate("2026-12-31", local)).toBe("2026.12.31");
  });
  it("formats both range ends and collapses identical dates", () => {
    expect(displayDateRange("1997", "2026", now)).toBe("1997–2026");
    expect(displayDateRange("2025-07-03", "2026-07-06", now)).toBe("2025.7.3–7.6");
    expect(displayDateRange("2026-07-03", "2026-07-03", now)).toBe("7.3");
    expect(displayDate(null, now)).toBe("");
  });
});

describe("displayTime", () => {
  it("uses a zero-padded local 24-hour clock", () => {
    expect(displayTime(new Date(2026, 8, 23, 9, 5), now)).toBe("09:05");
    expect(displayTime(new Date(2026, 8, 23, 21, 45), now)).toBe("21:45");
  });
});

describe("displayDateTime", () => {
  it("uses time for today, 어제 for yesterday, and dates otherwise", () => {
    expect(displayDateTime(new Date(2026, 8, 23, 21, 45), now)).toBe("21:45");
    expect(displayDateTime(new Date(2026, 8, 22, 21, 45), now)).toBe("어제 21:45");
    expect(displayDateTime(new Date(2025, 8, 28, 21, 45), now)).toBe("2025.9.28");
    expect(displayDateTime(new Date(2025, 8, 28, 21, 45), now, { withTime: true })).toBe("2025.9.28 21:45");
    expect(displayDateTime("2026-09-23", now)).toBe("9.23");
  });
});

describe("displayDDay", () => {
  it("uses local calendar days and leaves past dates to the date label", () => {
    expect(displayDDay("2026-09-29", now)).toBe("D-6");
    expect(displayDDay("2026-09-23T23:59", now)).toBe("오늘");
    expect(displayDDay("2026-09-22", now)).toBeNull();
  });
});

describe("displayCount", () => {
  it("groups counts with ko-KR separators and attaches units", () => {
    expect(displayCount(1284)).toBe("1,284");
    expect(displayCount(1284, "장")).toBe("1,284장");
  });
});

describe("daysUntil and ddayLabel", () => {
  it("counts local calendar days across month and year ends", () => {
    const eve = new Date(2026, 11, 31, 23, 59);
    expect(daysUntil("2027-01-01", eve)).toBe(1);
    expect(displayDDay("2027-01-01", eve)).toBe("D-1");
    expect(daysUntil("2026-12-31", eve)).toBe(0);
    expect(daysUntil("2026-12-30", eve)).toBe(-1);
    expect(daysUntil("2026-03-01", new Date(2026, 1, 28, 12))).toBe(1);
    expect(daysUntil("2028-02-29", new Date(2028, 1, 28))).toBe(1);
  });
  it("is null for unreadable values", () => {
    expect(daysUntil("2026-02-30", now)).toBeNull();
    expect(daysUntil("", now)).toBeNull();
    expect(daysUntil(null, now)).toBeNull();
  });
  it("reads 오늘, D-n, and nothing for the past or non-numbers", () => {
    expect(ddayLabel(0)).toBe("오늘");
    expect(ddayLabel(1)).toBe("D-1");
    expect(ddayLabel(365)).toBe("D-365");
    for (const value of [-1, null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) expect(ddayLabel(value)).toBeNull();
  });
});

describe("displayDuration", () => {
  it.each([
    [0, "0:00"],
    [17_400, "0:17"],
    [59_999, "0:59"],
    [725_000, "12:05"],
    [3_723_000, "1:02:03"],
    [36_000_000, "10:00:00"],
  ])("formats %d ms as %s", (value, expected) => {
    expect(displayDuration(value)).toBe(expected);
  });
  it("is empty when the length is unknown", () => {
    for (const value of [null, undefined, -1, Number.NaN]) expect(displayDuration(value)).toBe("");
  });
});
