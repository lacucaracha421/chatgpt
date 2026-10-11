import type { AssetView, ClassificationEntry } from "../library/types";
import type { CharacterSeries } from "../characters/hubApi";

/** Match CharacterFolderContent's originals exclusion before using the nearest registered series. */
export function characterPickerSeriesId(view: AssetView, classifications: ClassificationEntry[], series: CharacterSeries[]): string | undefined {
  if (view.kind !== "classification" || !view.classificationId) return undefined;
  const registered = new Set(series.map(entry => entry.classificationId));
  const seen = new Set<string>();
  let current = classifications.find(entry => entry.id === view.classificationId);
  let nearest: string | undefined;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (!nearest && registered.has(current.id)) nearest = current.id;
    if (!current.parentId) {
      return current.id === "lakomics-originals" || current.name === "오리지널" ? undefined : nearest;
    }
    current = classifications.find(entry => entry.id === current?.parentId);
  }
  return nearest;
}
