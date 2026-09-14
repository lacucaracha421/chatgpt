import { invoke } from "@tauri-apps/api/core";
import { beforeEach, expect, it, vi } from "vitest";
import { characterHubApi, type ReferenceRegionBindings } from "./hubApi";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

it("requests semantic reference candidates through the normal recommendation command", async () => {
  vi.mocked(invoke).mockResolvedValueOnce({ method: "ccip_core" });

  await characterHubApi.referenceCandidates("target-1", 12);

  expect(invoke).toHaveBeenCalledWith("reference_candidates", {
    targetId: "target-1",
    limit: 12,
  });
});

it("sends selected reference regions outside the confirmation request payload", async () => {
  const regions: ReferenceRegionBindings = {
    "asset-1": {
      contentHash: "hash-1",
      baselineFingerprint: "baseline-1",
      bounds: [1, 2, 30, 40],
    },
  };
  const request = {
    targetId: "target-1",
    expectedRevision: 3,
    expectedReferenceSetHash: "set-1",
    confirmationMode: "add_learned" as const,
    assetIds: ["asset-1"],
  };
  vi.mocked(invoke).mockResolvedValueOnce({ id: "target-1" });

  await characterHubApi.confirmReferenceBatch({ ...request, regions });

  expect(invoke).toHaveBeenCalledWith("confirm_reference_batch", { request, regions });
});
