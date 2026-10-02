import { expect, it } from "vitest";
import type { LibraryGateway } from "../library/types";
import { folderPreviewCache, rememberFolderPreview } from "./folderPreviewCache";

it("isolates identical classification ids by library and provider", () => {
  const gateway = {} as LibraryGateway;
  const first = folderPreviewCache(gateway, "library-a");
  rememberFolderPreview(first.thumbnails, "child", "cover-a");
  expect(folderPreviewCache(gateway, "library-a").thumbnails.get("child")).toBe("cover-a");
  expect(folderPreviewCache(gateway, "library-b").thumbnails.has("child")).toBe(false);
  expect(folderPreviewCache({} as LibraryGateway, "library-a").thumbnails.has("child")).toBe(false);
});

it("bounds resolved covers and keeps recently revisited covers", () => {
  const cache = folderPreviewCache({} as LibraryGateway).thumbnails;
  for (let index = 0; index < 256; index++) rememberFolderPreview(cache, String(index), `cover-${index}`);
  rememberFolderPreview(cache, "0", cache.get("0")!);
  rememberFolderPreview(cache, "new", null);
  expect(cache.size).toBe(256);
  expect(cache.get("0")).toBe("cover-0");
  expect(cache.has("1")).toBe(false);
  expect(cache.get("new")).toBeNull();
  expect(cache.get("pending")).toBeUndefined();
});
