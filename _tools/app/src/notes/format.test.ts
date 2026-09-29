import { describe, expect, it } from "vitest";
import { noteDateLabel } from "./format";

describe("noteDateLabel", () => {
  it("uses time today, 어제 with time yesterday, and dot dates otherwise", () => {
    const now = new Date(2026, 8, 29, 22, 0);
    expect(noteDateLabel(new Date(2026, 8, 29, 21, 45).toISOString(), now)).toBe("21:45");
    expect(noteDateLabel(new Date(2026, 8, 28, 21, 45).toISOString(), now)).toBe("어제 21:45");
    expect(noteDateLabel(new Date(2026, 8, 27, 21, 45).toISOString(), now)).toBe("9.27");
    expect(noteDateLabel(new Date(2025, 8, 28, 21, 45).toISOString(), now)).toBe("2025.9.28");
  });
});
