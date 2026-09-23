import { describe, expect, it } from "vitest";
import { displayDate, displayDateRange } from "./displayDate";

const now = new Date(2026, 8, 23);
describe("displayDate", () => {
  it.each([
    ["2026-01-02", "01.02"],
    ["2025-09-19", "2025.09.19"],
    ["2027-01-02", "2027.01.02"],
    ["1997", "1997"],
    ["2026", "2026"],
    ["2026-09", "2026.09"],
    ["2025-09", "2025.09"],
    ["2024-02-29", "2024.02.29"],
    ["2026-09-01~2026-09-23", "09.01–09.23"],
    ["2025-09-01–2026-09-23", "2025.09.01–09.23"],
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
    expect(displayDate(local.toISOString(), local)).toBe("01.01");
    expect(displayDate(local.getTime(), now)).toBe("2027.01.01");
    expect(displayDate("2027-01-02", local)).toBe("01.02");
    expect(displayDate("2026-12-31", local)).toBe("2026.12.31");
  });
  it("formats both range ends and collapses identical dates", () => {
    expect(displayDateRange("1997", "2026", now)).toBe("1997–2026");
    expect(displayDateRange("2025-07-03", "2026-07-06", now)).toBe("2025.07.03–07.06");
    expect(displayDateRange("2026-07-03", "2026-07-03", now)).toBe("07.03");
    expect(displayDate(null, now)).toBe("");
  });
});
