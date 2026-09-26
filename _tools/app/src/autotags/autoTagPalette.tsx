import { useOptionalLibrary } from "../library/LibraryContext";
import type { AssetView } from "../library/types";
import type { NavigationEntry } from "../layout/navigationEntries";
import { applyAutoTagFilter } from "./autoTagFilter";
import { autoTagEnglish, searchAutoTags } from "./autoTagModel";
import { useAutoTagVocabulary } from "./autoTagVocabulary";
import "./autoTags.css";

const PALETTE_TAG_LIMIT = 6;

/** Views whose content is the 에셋 browser, where a tag filter applies in place. */
export function isAssetBrowserView(view: AssetView) {
  if (view.kind === "classification") return !view.characterId && !view.characterGroupId;
  return view.kind === "unsorted" || view.kind === "album" || view.kind === "creator";
}

/**
 * 자동 태그 rows for the 찾기 palette while the user types (Korean or English). Enter adds the
 * tag to the 에셋 filter, Shift+Enter excludes it; outside the 에셋 browser it opens 전체.
 */
export function useAutoTagPaletteSearch(open: boolean, view: AssetView, onNavigate: (view: AssetView) => void) {
  const gateway = useOptionalLibrary()?.gateway.autoTags;
  const vocabulary = useAutoTagVocabulary(gateway, open);
  return (query: string): NavigationEntry[] => {
    if (!vocabulary || !query.trim()) return [];
    const apply = (tag: string, mode: "include" | "exclude") => () => {
      if (!applyAutoTagFilter(tag, mode)) return;
      if (!isAssetBrowserView(view)) onNavigate({ kind: "classification", classificationId: null });
    };
    return searchAutoTags(vocabulary.entries, query, { limit: PALETTE_TAG_LIMIT, minCount: 1 }).map((entry) => ({
      id: `auto-tag:${entry.tag}`,
      group: "tag",
      label: entry.label,
      context: entry.label === autoTagEnglish(entry.tag) ? undefined : autoTagEnglish(entry.tag),
      count: entry.count,
      icon: <span className="auto-tag-palette-mark" />,
      run: apply(entry.tag, "include"),
      runAlternate: apply(entry.tag, "exclude"),
    }));
  };
}
