import { describe, expect, it } from "vitest";
import { toUtcDateRange } from "./revisitDate";

describe("toUtcDateRange", () => {
  it("returns the UTC bounds of a local calendar day", () => {
    expect(toUtcDateRange("2026-08-06")).toEqual({
      localDate: "2026-08-06",
      startUtc: "2026-08-05T15:00:00.000Z",
      endUtc: "2026-08-06T15:00:00.000Z",
    });
  });

  it("rejects an impossible local date", () => {
    expect(() => toUtcDateRange("2026-02-30")).toThrow("유효하지 않은 날짜");
  });
});
