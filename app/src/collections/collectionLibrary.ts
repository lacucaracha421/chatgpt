import type { CollectionSummary, CollectionType } from "../library/types";

export type CollectionLibrarySort = "recent" | "name" | "media_date";
export type CollectionLibraryDirection = "asc" | "desc";
export type CollectionRatingFilter = "all" | "unrated" | number;

export type CollectionLibraryState = {
  query: string;
  sort: CollectionLibrarySort;
  direction: CollectionLibraryDirection;
  rating: CollectionRatingFilter;
};

export type CollectionLibraryStateByType = Record<CollectionType, CollectionLibraryState>;

export function createDefaultCollectionLibraryState(): CollectionLibraryStateByType {
  const initial = (): CollectionLibraryState => ({
    query: "",
    sort: "media_date",
    direction: "desc",
    rating: "all",
  });
  return { game: initial(), manga: initial(), movie: initial() };
}

export function deriveCollectionLibrary(
  collections: CollectionSummary[],
  type: CollectionType,
  state: CollectionLibraryState,
): CollectionSummary[] {
  const query = state.query.trim().toLocaleLowerCase();
  return collections
    .filter((item) => item.type === type)
    .filter((item) => !query || item.name.toLocaleLowerCase().includes(query))
    .filter((item) => matchesRating(item.myScore, state.rating))
    .slice()
    .sort((left, right) => compareCollections(left, right, state));
}

function matchesRating(score: number | null, rating: CollectionRatingFilter): boolean {
  if (rating === "all") return true;
  if (rating === "unrated") return score === null;
  return score === rating;
}

function compareCollections(
  left: CollectionSummary,
  right: CollectionSummary,
  state: CollectionLibraryState,
): number {
  let result: number;
  if (state.sort === "name") {
    result = left.name.localeCompare(right.name);
  } else if (state.sort === "media_date") {
    result = compareMediaDate(left, right, state.direction);
  } else {
    result = left.createdAt.localeCompare(right.createdAt);
  }
  if (result !== 0) {
    return state.direction === "desc" && state.sort !== "media_date" ? -result : result;
  }
  return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

function compareMediaDate(
  left: CollectionSummary,
  right: CollectionSummary,
  direction: CollectionLibraryDirection,
): number {
  const leftDate = mediaDateKey(left);
  const rightDate = mediaDateKey(right);
  if (leftDate === null || rightDate === null) {
    if (leftDate === null && rightDate === null) return 0;
    return leftDate === null ? 1 : -1;
  }
  const result = leftDate - rightDate;
  return direction === "desc" ? -result : result;
}

function mediaDateKey(collection: CollectionSummary): number | null {
  if (collection.releaseDate) {
    return Number(collection.releaseDate.replace(/-/g, ""));
  }
  if (collection.year !== null) return collection.year * 10_000;
  return null;
}
