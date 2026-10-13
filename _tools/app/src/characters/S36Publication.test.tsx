import { describe, expect, it } from "vitest";
import { readinessLabel, type S36Readiness } from "./S36Publication";

const r = (status: S36Readiness["status"], reviewed: number, wrong: number, allowed: number, examples: number): S36Readiness => ({ targetId: "t", status, reviewed, wrong, allowed, examples });

describe("S36 readiness label", () => {
  it("says what is still missing, or which recognition places the character", () => {
    expect(readinessLabel(r("collecting", 12, 0, 1, 40))).toBe("학습 인식 준비 · 확인 판단 12/30 · 맞음 예시 40/50");
    expect(readinessLabel(r("collecting", 45, 1, 2, 20))).toBe("학습 인식 준비 · 확인 판단 30/30 · 맞음 예시 20/50 · 틀림 1 / 허용 2");
    expect(readinessLabel(r("learning", 31, 1, 1, 60))).toBe("학습 인식 · 확인 판단 31 · 틀림 1 / 허용 1");
    expect(readinessLabel(r("hold", 36, 3, 1, 60))).toBe("기본 인식 · 확인 판단 36 · 틀림 3 / 허용 1");
  });
});
