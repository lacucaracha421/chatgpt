import { expect, it } from "vitest";
import { recordRecentFolder } from "./recentFolders";

it("retains bar order on reuse and evicts the least recently used entry at eight", () => {
  let visits = Array.from({ length: 8 }, (_, index) => ({ id: String(index), lastUsed: index }));
  visits = recordRecentFolder(visits, "0", 10);
  expect(visits.map(visit => visit.id)).toEqual(["0", "1", "2", "3", "4", "5", "6", "7"]);
  visits = recordRecentFolder(visits, "new", 11);
  expect(visits.map(visit => visit.id)).toEqual(["new", "0", "2", "3", "4", "5", "6", "7"]);
});
