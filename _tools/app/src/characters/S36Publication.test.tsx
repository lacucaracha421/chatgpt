import { describe, expect, it } from "vitest";
import { readinessLabel, type S36Readiness } from "./S36Publication";

const r = (status: S36Readiness["status"], reviewed: number, wrong: number, examples: number): S36Readiness => ({ targetId: "t", status, reviewed, wrong, examples });

describe("S36 readiness label", () => {
  it("says what is still missing, or that S36 can be switched on", () => {
    expect(readinessLabel(r("collecting", 12, 0, 40))).toBe("학습 인식 준비 · 확인 판단 12/30 · 맞음 예시 40/50");
    expect(readinessLabel(r("collecting", 45, 1, 20))).toBe("학습 인식 준비 · 확인 판단 30/30 · 맞음 예시 20/50");
    expect(readinessLabel(r("ready", 31, 1, 60))).toBe("학습 인식 · 확인 판단 31 · 틀림 1");
    expect(readinessLabel(r("hold", 14, 2, 60))).toBe("기본 인식 · 확인 판단 14 · 틀림 2");
    expect(readinessLabel(r("keep", 30, 5, 60))).toBe("기본 인식 · 확인 판단 30 · 틀림 5");
  });
});
