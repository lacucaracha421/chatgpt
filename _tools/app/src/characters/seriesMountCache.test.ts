import { afterEach, expect, it, vi } from "vitest";
import type { CharacterSidebarCounts, LibraryGateway } from "../library/types";
import { readSeriesSidebarCounts, sidebarCountCache } from "./seriesMountCache";

afterEach(() => sidebarCountCache.clear());

const counts = (n: number): CharacterSidebarCounts => ({ targets: { t: n }, groups: {} });

it("re-reads counts only for a series analysed since, keeping the old counts until the new ones land", async () => {
  let finish!: (value: CharacterSidebarCounts) => void;
  const characterSidebarCounts = vi.fn<() => Promise<CharacterSidebarCounts>>().mockResolvedValueOnce(counts(1));
  const gateway = { characterSidebarCounts } as unknown as LibraryGateway;
  await readSeriesSidebarCounts(gateway, "scope", 0, { id: "a", revisions: { a: 1 } });
  // Another series' progress, or none: the cached counts answer.
  await readSeriesSidebarCounts(gateway, "scope", 0, { id: "b", revisions: { a: 2 } });
  await readSeriesSidebarCounts(gateway, "scope", 0, { id: "a", revisions: { a: 1 } });
  expect(characterSidebarCounts).toHaveBeenCalledTimes(1);

  characterSidebarCounts.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const fresh = readSeriesSidebarCounts(gateway, "scope", 0, { id: "a", revisions: { a: 2 } });
  expect(characterSidebarCounts).toHaveBeenCalledTimes(2);
  expect(sidebarCountCache.peek(gateway, "scope", 0)).toEqual(counts(1));
  finish(counts(2));
  await expect(fresh).resolves.toEqual(counts(2));
  expect(sidebarCountCache.peek(gateway, "scope", 0)).toEqual(counts(2));
  // The re-read recorded the revisions it saw.
  await readSeriesSidebarCounts(gateway, "scope", 0, { id: "a", revisions: { a: 2 } });
  expect(characterSidebarCounts).toHaveBeenCalledTimes(2);
});
