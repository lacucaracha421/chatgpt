import { describe, expect, it } from "vitest";
import type { ExchangeOutgoing } from "../exchange/exchangeStore";
import { recentTransfers } from "./homeTransferModel";

const out = (id: string, fields: Partial<ExchangeOutgoing> = {}): ExchangeOutgoing => ({ transferId: id, fileName: `${id}.png`, sizeBytes: 100, toName: "Tab", state: "delivered", done: 0, message: null, note: null, retryable: false, cancellable: false, createdAt: "2026-10-15T10:00:00Z", ...fields });

describe("recent transfers", () => {
  it("keeps the newest three sends, a just-queued one first", () => {
    const rows = [out("a", { createdAt: "2026-10-15T09:00:00Z" }), out("b", { createdAt: "2026-10-15T11:00:00Z" }), out("c", { createdAt: "2026-10-15T10:00:00Z" }), out("d", { createdAt: "2026-10-15T08:00:00Z" }), out("new", { state: "queued", createdAt: null })];
    expect(recentTransfers(rows).map(line => line.key)).toEqual(["new", "b", "c"]);
  });
  it("folds a batch into one line named by what it holds", () => {
    const photos = ["p1", "p2", "p3", "p4"].map(id => out(id, { batchId: "photos" }));
    const mixed = [out("m1", { batchId: "mix", fileName: "a.png" }), out("m2", { batchId: "mix", fileName: "b.zip" })];
    const lines = recentTransfers([...photos, ...mixed, out("one", { fileName: "report.pdf", createdAt: "2026-10-14T10:00:00Z" })]);
    expect(lines.find(line => line.key === "photos")?.label).toBe("사진 4장");
    expect(lines.find(line => line.key === "mix")?.label).toBe("파일 2개");
    expect(lines.find(line => line.key === "one")?.label).toBe("report.pdf");
  });
  it("tells moving (with a percent), waiting, done and failed apart", () => {
    const lines = recentTransfers([
      out("m", { state: "uploading", sizeBytes: 200, done: 100, createdAt: "2026-10-15T12:00:00Z" }),
      out("w", { state: "waiting", createdAt: "2026-10-15T11:00:00Z" }),
      out("f", { state: "failed", createdAt: "2026-10-15T10:30:00Z" }),
    ]);
    expect(lines.map(line => [line.key, line.state, line.percent])).toEqual([["m", "moving", 50], ["w", "waiting", null], ["f", "failed", null]]);
    expect(recentTransfers([out("d")])[0]).toMatchObject({ state: "done", percent: null, at: "2026-10-15T10:00:00Z" });
    expect(recentTransfers([out("x", { state: "cancelled" })])[0]!.state).toBe("ended");
  });
  it("carries a route only when the whole line travelled the same direct way", () => {
    const lines = recentTransfers([
      out("a1", { batchId: "same", route: "lan", createdAt: "2026-10-15T12:00:00Z" }), out("a2", { batchId: "same", route: "lan", createdAt: "2026-10-15T12:00:00Z" }),
      out("m1", { batchId: "mix", route: "lan", createdAt: "2026-10-15T11:00:00Z" }), out("m2", { batchId: "mix", createdAt: "2026-10-15T11:00:00Z" }),
      out("s", { createdAt: "2026-10-15T10:00:00Z" }),
    ]);
    expect(lines.map(line => [line.key, line.route])).toEqual([["same", "lan"], ["mix", null], ["s", null]]);
  });
});
