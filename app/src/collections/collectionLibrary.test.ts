import { describe, expect, it } from "vitest";
import type { CollectionSummary } from "../library/types";
import {
  createDefaultCollectionLibraryState,
  deriveCollectionLibrary,
} from "./collectionLibrary";

const base = (overrides: Partial<CollectionSummary> = {}): CollectionSummary => ({
  id: "id",
  name: "Collection",
  description: null,
  type: "game",
  coverAssetId: null,
  selectedWorkArtworkId: null,
  assetCount: 0,
  unreadReleaseCount: 0,
  year: null,
  author: null,
  developer: null,
  productionCompany: null,
  releaseDate: null,
  director: null,
  externalScore: null,
  myScore: null,
  genres: null,
  overview: null,
  showcase: false,
  showcaseOrder: null,
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
  ...overrides,
});

const game = (name: string, myScore: number | null, overrides: Partial<CollectionSummary> = {}) =>
  base({ name, myScore, ...overrides });
const manga = (name: string, myScore: number | null) => base({ name, type: "manga", myScore });
const names = (state: Parameters<typeof deriveCollectionLibrary>[2]) =>
  deriveCollectionLibrary(
    [game("Unrated", null), game("Zero", 0), game("Half", 0.5), manga("Other", 0)],
    "game",
    state,
  ).map((item) => item.name);

describe("collection library derivation", () => {
  it("composes media, title, and exact half-star filtering", () => {
    const result = deriveCollectionLibrary(
      [game("NieR:Automata", 4.5), game("NieR Replicant", 5), manga("NieR anthology", 4.5)],
      "game",
      { query: "automata", sort: "recent", direction: "desc", rating: 4.5 },
    );
    expect(result.map((item) => item.name)).toEqual(["NieR:Automata"]);
  });

  it("filters unrated separately from zero stars", () => {
    expect(names({ query: "", sort: "recent", direction: "desc", rating: "unrated" })).toEqual(["Unrated"]);
    expect(names({ query: "", sort: "recent", direction: "desc", rating: 0 })).toEqual(["Zero"]);
  });

  it.each(["asc", "desc"] as const)("keeps missing media dates last for %s", (direction) => {
    const result = deriveCollectionLibrary(
      [
        game("Exact", null, { releaseDate: "2020-02-03", year: null }),
        game("Year", null, { releaseDate: null, year: 2019 }),
        game("Missing", null, { releaseDate: null, year: null }),
      ],
      "game",
      { query: "", sort: "media_date", direction, rating: "all" },
    );
    expect(result[result.length - 1]?.name).toBe("Missing");
  });

  it("sorts names in both directions", () => {
    const collections = [game("Bravo", null), game("Alpha", null)];
    expect(deriveCollectionLibrary(collections, "game", { query: "", sort: "name", direction: "asc", rating: "all" }).map((item) => item.name)).toEqual(["Alpha", "Bravo"]);
    expect(deriveCollectionLibrary(collections, "game", { query: "", sort: "name", direction: "desc", rating: "all" }).map((item) => item.name)).toEqual(["Bravo", "Alpha"]);
  });

  it("sorts recently added by createdAt", () => {
    const collections = [
      game("Old", null, { createdAt: "2024-01-01T00:00:00Z" }),
      game("New", null, { createdAt: "2024-02-01T00:00:00Z" }),
    ];
    expect(deriveCollectionLibrary(collections, "game", { query: "", sort: "recent", direction: "desc", rating: "all" }).map((item) => item.name)).toEqual(["New", "Old"]);
  });

  it("uses the shared media-date key and breaks ties by name then id", () => {
    const collections = [
      game("Zulu", null, { id: "2", releaseDate: null, year: 2020 }),
      game("Alpha", null, { id: "1", releaseDate: "2020-01-01", year: 1999 }),
      game("Alpha", null, { id: "0", releaseDate: "2020-01-01", year: 1999 }),
    ];
    expect(deriveCollectionLibrary(collections, "game", { query: "", sort: "media_date", direction: "asc", rating: "all" }).map((item) => `${item.name}:${item.id}`)).toEqual(["Zulu:2", "Alpha:0", "Alpha:1"]);
  });

  it.each(["asc", "desc"] as const)("uses one numeric key for exact dates and years (%s)", (direction) => {
    const collections = [
      game("Exact 2030", null, { releaseDate: "2030-01-01", year: null }),
      game("Year 2020", null, { releaseDate: null, year: 2020 }),
    ];
    expect(
      deriveCollectionLibrary(collections, "game", {
        query: "",
        sort: "media_date",
        direction,
        rating: "all",
      }).map((item) => item.name),
    ).toEqual(direction === "asc" ? ["Year 2020", "Exact 2030"] : ["Exact 2030", "Year 2020"]);
  });

  it("does not mutate input and creates independent default states", () => {
    const collections = [game("Bravo", null), game("Alpha", null)];
    const original = [...collections];
    const result = deriveCollectionLibrary(collections, "game", { query: "", sort: "name", direction: "asc", rating: "all" });
    expect(collections).toEqual(original);
    expect(result).not.toBe(collections);
    const defaults = createDefaultCollectionLibraryState();
    defaults.game.query = "changed";
    expect(defaults.manga.query).toBe("");
    expect(defaults.movie).toEqual({ query: "", sort: "recent", direction: "desc", rating: "all" });
  });
});
