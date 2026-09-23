import { describe, expect, it } from "vitest";
import { readinessLabel, type S36Readiness } from "./S36Publication";

const r = (status: S36Readiness["status"], reviewed: number, wrong: number, examples: number): S36Readiness => ({ targetId: "t", status, reviewed, wrong, examples });

describe("S36 readiness label", () => {
  it("says what is still missing, or that S36 can be switched on", () => {
    expect(readinessLabel(r("collecting", 12, 0, 40))).toBe("S36 준비 중 · 확인 12/30 · 예시 40/50");
    expect(readinessLabel(r("collecting", 45, 1, 20))).toBe("S36 준비 중 · 확인 30/30 · 예시 20/50");
    expect(readinessLabel(r("ready", 31, 1, 60))).toBe("S36 켜도 됨 · 확인 31 · 틀림 1");
    expect(readinessLabel(r("hold", 14, 2, 60))).toBe("S36 보류 · 확인 14 · 틀림 2");
    expect(readinessLabel(r("keep", 30, 5, 60))).toBe("S36 부적합 · 확인 30 · 틀림 5");
  });
});
