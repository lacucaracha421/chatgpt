import { afterEach, expect, it, vi } from "vitest";
import { readBookmarkSort, writeBookmarkSort } from "./bookmarkSort";

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

it("keeps today's publication order by default and persists either choice", () => {
  localStorage.clear();
  expect(readBookmarkSort()).toBe("latest");
  writeBookmarkSort("bookmarkAdded");
  expect(readBookmarkSort()).toBe("bookmarkAdded");
  writeBookmarkSort("latest");
  expect(readBookmarkSort()).toBe("latest");
});

it("falls back for corrupt or unavailable device storage", () => {
  localStorage.setItem("lakomics.catalogBookmarkSort.v1", "broken");
  expect(readBookmarkSort()).toBe("latest");
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  expect(readBookmarkSort()).toBe("latest");
  expect(() => writeBookmarkSort("bookmarkAdded")).not.toThrow();
});
