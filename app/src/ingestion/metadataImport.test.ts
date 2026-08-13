import { describe, expect, it, vi } from "vitest";
import type { ClassificationEntry, LibraryGateway, MetadataImportPlan } from "../library/types";
import { executeMetadataImport } from "./metadataImport";

describe("executeMetadataImport", () => {
  it("reuses sibling paths case-insensitively, creates missing paths, and imports to the deepest folder", async () => {
    const existing: ClassificationEntry = { id: "games", kind: "root", name: "Games", parentId: null, iconKey: null, colorKey: null };
    const plan: MetadataImportPlan = {
      metadataFile: "lakomics-x-metadata.json",
      classificationPaths: [["games"], ["games", "Reverse"], ["Unused"]],
      items: [{ fileName: "one.jpg", sourcePath: "C:\\export\\one.jpg", classificationPath: ["GAMES", "reverse"], sourceUrl: "https://x.com/a/status/1", collectedAt: "2026-08-13T13:44:55Z" }],
      skipped: [{ fileName: "missing.jpg", reason: "missing_file" }],
    };
    let entries = [existing];
    const gateway = {
      inspectMetadataImport: vi.fn().mockResolvedValue(plan),
      listClassifications: vi.fn(() => Promise.resolve(entries)),
      createClassification: vi.fn(async (input) => {
        const entry: ClassificationEntry = { id: input.name, kind: input.kind, name: input.name, parentId: input.parentId, iconKey: null, colorKey: null };
        entries = [...entries, entry];
        return entry;
      }),
      ingestMedia: vi.fn().mockResolvedValue({ status: "added", asset: { id: "asset" } }),
    } as unknown as LibraryGateway;

    const result = await executeMetadataImport(gateway, "C:\\export");

    expect(gateway.createClassification).toHaveBeenCalledTimes(2);
    expect(gateway.createClassification).toHaveBeenNthCalledWith(1, { kind: "tag", name: "Reverse", parentId: "games" });
    expect(gateway.createClassification).toHaveBeenNthCalledWith(2, { kind: "root", name: "Unused", parentId: null });
    expect(gateway.ingestMedia).toHaveBeenCalledWith({ sourcePath: "C:\\export\\one.jpg", classificationId: "Reverse", sourceUrl: "https://x.com/a/status/1", collectedAt: "2026-08-13T13:44:55Z", replaceDuplicateMetadata: true });
    expect(result).toMatchObject({ added: 1, foldersCreated: 2, pathsReused: 2, completed: 1, total: 1, skipped: [{ fileName: "missing.jpg" }] });
  });
});
