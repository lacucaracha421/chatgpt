import { expect, it, vi } from "vitest";
import type { LibraryGateway } from "../library/types";
import { restoreCollectionByName } from "./restoreCollection";

it("restores the newest matching type and name through the trash authority command", async () => {
  const restored = {id: "latest", type: "av", name: "SSIS-001", description: "memo", myScore: 4.5};
  const gateway = {
    listCollectionTrash: vi.fn().mockResolvedValue({libraryId: "library", epoch: 2, items: [
      {workId: "other-type", type: "game", name: "SSIS-001", trashedAt: "2026-10-28", entityRevision: 7},
      {workId: "old", type: "av", name: "SSIS-001", trashedAt: "2026-10-20", entityRevision: 4},
      {workId: "latest", type: "av", name: "ssis-001", trashedAt: "2026-10-27", entityRevision: 6},
    ]}),
    restoreCollectionWork: vi.fn().mockResolvedValue(undefined),
    listCollections: vi.fn().mockResolvedValue([restored]),
  } as unknown as LibraryGateway;
  expect(await restoreCollectionByName(gateway, "av", " SSIS-001 ")).toBe(restored);
  expect(gateway.restoreCollectionWork).toHaveBeenCalledWith("latest", 6, "library", 2);
});
