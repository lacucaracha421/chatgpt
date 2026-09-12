import { beforeEach, expect, it, vi } from "vitest";
import { startAssetDrag } from "./startAssetDrag";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

beforeEach(() => invoke.mockReset());

it("sends only selected asset IDs to the native command", async () => {
  invoke.mockResolvedValue(undefined);
  await startAssetDrag(["asset-a", "asset-b"]);
  expect(invoke).toHaveBeenCalledWith("start_asset_drag", { assetIds: ["asset-a", "asset-b"] });
});
