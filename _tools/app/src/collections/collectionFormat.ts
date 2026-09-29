export const KIND_LABEL = {
  game: "게임",
  movie: "영화",
  anime: "애니",
  manga: "만화",
  av: "AV",
} as const;

type CollectionCardValue = {
  type: "game" | "manga" | "movie" | "av";
  author?: string | null;
  developer?: string | null;
  productionCompany?: string | null;
  year?: number | null;
  releaseDate?: string | null;
  seasonDateRange?: readonly string[] | null;
  av?: { maker?: string | null; releaseDate?: string | null } | null;
};

/** Creator/studio credit used by collection cards on both clients. */
export function collectionCredit(collection: CollectionCardValue): string {
  const avMaker = collection.av?.maker?.trim();
  const credit = collection.type === "manga"
    ? collection.author
    : collection.type === "game"
      ? collection.developer
      : collection.type === "av"
        ? avMaker || collection.productionCompany
        : collection.productionCompany;
  return credit?.trim() ?? "";
}

/** Movie season range, AV release date, or the collection year. */
export function collectionCardDate(collection: CollectionCardValue): string {
  const short = (date: string) => {
    const [year, month, day] = date.split("-");
    return `${year!.slice(-2)}.${Number(month)}.${Number(day)}`;
  };
  const range = collection.type === "movie" && collection.seasonDateRange?.length === 2 ? collection.seasonDateRange : null;
  if (range) return range[0] === range[1] ? short(range[0]!) : `${short(range[0]!)}~${short(range[1]!)}`;
  if (collection.type === "av" && collection.av?.releaseDate) return short(collection.av.releaseDate);
  return collection.year ? String(collection.year) : collection.releaseDate?.slice(0, 4) ?? "";
}

type VolumeValue = { volumeNumber: number; displayLabel?: string | null };

/** Adds 권 only to empty or numeric volume labels. */
export function volumeLabel(volume: VolumeValue): string {
  const label = volume.displayLabel?.trim();
  return !label ? `${volume.volumeNumber}권` : /^\d+(?:\.\d+)?$/.test(label) ? `${label}권` : label;
}
