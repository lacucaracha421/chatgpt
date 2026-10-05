import { afterEach, expect, it, vi } from "vitest";
import { readBookmarkSort, writeBookmarkSort } from "./bookmarkSort";

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

it("defaults to newest bookmarks first and persists either explicit choice", () => {
  localStorage.clear();
  expect(readBookmarkSort()).toBe("bookmarkAdded");
  writeBookmarkSort("latest");
  expect(readBookmarkSort()).toBe("latest");
  writeBookmarkSort("bookmarkAdded");
  expect(readBookmarkSort()).toBe("bookmarkAdded");
});

it("falls back to the default for corrupt or unavailable device storage", () => {
  localStorage.setItem("lakomics.catalogBookmarkSort.v1", "broken");
  expect(readBookmarkSort()).toBe("bookmarkAdded");
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  expect(readBookmarkSort()).toBe("bookmarkAdded");
  expect(() => writeBookmarkSort("latest")).not.toThrow();
});
