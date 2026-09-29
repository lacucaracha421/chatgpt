import { describe, expect, it } from "vitest";
import { displayCount, displayDate, displayDateRange, displayDateTime, displayDDay, displayTime } from "./displayDate";

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
