import { describe, expect, it, vi } from "vitest";
import { shadowPageSource } from "./characterReviewSource";

const item = (assetId: string, targetId: string, verdict: string) => ({ assetId, targetId, targetName: targetId, verdict });
const summary = { automatic: { pending: 3, accepted: 0, rejected: 0 }, recommended: { pending: 1, accepted: 0, rejected: 0 }, byOrigin: {} };

describe("shadowPageSource", () => {
  it("counts every page once per item and stops when a page brings nothing new", async () => {
    const pages = [
      { items: [item("a", "lala", "automatic"), item("b", "lala", "recommended")], nextOffset: 2 },
      { items: [item("b", "lala", "recommended"), item("c", "mari", "automatic")], nextOffset: 4 },
      { items: [item("c", "mari", "automatic")], nextOffset: 6 },
    ];
    const page = vi.fn(async ({ offset }: { offset: number }) => ({ ...pages[offset / 2], policyVersion: null, summary }) as never);
    const progress = vi.fn();
    const tallies = await shadowPageSource({ page })(progress, () => true);
    expect(page).toHaveBeenCalledTimes(3);
    expect(tallies).toEqual([
      { targetId: "lala", targetName: "lala", automatic: 1, recommended: 1, other: 0 },
      { targetId: "mari", targetName: "mari", automatic: 1, recommended: 0, other: 0 },
    ]);
    expect(progress).toHaveBeenLastCalledWith({ read: 3, total: 4 });
  });

  it("resolves null once the reader is no longer wanted", async () => {
    const page = vi.fn(async () => ({ items: [item("a", "lala", "automatic")], nextOffset: 1, policyVersion: null, summary }) as never);
    await expect(shadowPageSource({ page })(vi.fn(), () => false)).resolves.toBeNull();
    expect(page).toHaveBeenCalledOnce();
  });
});
