import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { jableUrl, openInBrave } from "./jableLink";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
beforeEach(() => vi.mocked(invoke).mockClear());

it("builds the page from the lowercased product code and gives nothing for a missing or odd code", () => {
  expect(jableUrl("FSDSS-456")).toBe("https://jp.jable.tv/videos/fsdss-456/");
  expect(jableUrl("  Abc-123 ")).toBe("https://jp.jable.tv/videos/abc-123/");
  for (const code of [null, undefined, "", "  ", "ABC 123", "ABC-123/../x", "한글-1", "-ABC"]) expect(jableUrl(code)).toBeNull();
});

it("hands the page to the open_in_brave command", async () => {
  await openInBrave("https://jp.jable.tv/videos/fsdss-456/");
  expect(invoke).toHaveBeenCalledWith("open_in_brave", { url: "https://jp.jable.tv/videos/fsdss-456/" });
});
