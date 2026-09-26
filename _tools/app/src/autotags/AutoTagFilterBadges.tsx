import { XMarkIcon } from "@heroicons/react/24/outline";
import { useOptionalLibrary } from "../library/LibraryContext";
import { clearAutoTagFilter, hasAutoTagFilter, removeAutoTagFilter, toggleAutoTagFilterMode, useAutoTagFilter } from "./autoTagFilter";
import { autoTagEnglish, autoTagLabel } from "./autoTagModel";
import { useAutoTagVocabulary } from "./autoTagVocabulary";
import "./autoTags.css";

/**
 * The applied 자동 태그 filter in the 에셋 header: one badge per tag (+ include, − exclude),
 * combined with AND, the result count and 검색 해제. Nothing while no tag is applied.
 */
export function AutoTagFilterBadges({ resultCount }: { resultCount: number | null }) {
  const filter = useAutoTagFilter();
  const gateway = useOptionalLibrary()?.gateway.autoTags;
  const active = hasAutoTagFilter(filter);
  const vocabulary = useAutoTagVocabulary(gateway, active);
  if (!active) return null;
  const label = (tag: string) => autoTagLabel(tag, vocabulary?.byTag.get(tag)?.category ?? "general");
  const badges = [...filter.include.map((tag) => ({ tag, excluded: false })), ...filter.exclude.map((tag) => ({ tag, excluded: true }))];
  return <span className="auto-tag-filters" role="group" aria-label="자동 태그 필터">
    {badges.map(({ tag, excluded }) => <span key={tag} className={`auto-tag-filter${excluded ? " auto-tag-filter--excluded" : ""}`}>
      <button type="button" className="auto-tag-filter__mode" aria-label={`${label(tag)} ${excluded ? "포함으로 바꾸기" : "제외로 바꾸기"}`}
        aria-description={excluded ? "지금은 이 태그가 없는 에셋만 봅니다" : "지금은 이 태그가 있는 에셋만 봅니다"} onClick={() => toggleAutoTagFilterMode(tag)}>{excluded ? "−" : "+"}</button>
      <span className="auto-tag-filter__label" aria-description={autoTagEnglish(tag)}>{label(tag)}</span>
      <button type="button" className="auto-tag-filter__remove" aria-label={`${label(tag)} 필터 빼기`} onClick={() => removeAutoTagFilter(tag)}><XMarkIcon aria-hidden="true" /></button>
    </span>)}
    {badges.length > 1 && <span className="auto-tag-filters__note">모두 포함</span>}
    {resultCount !== null && <span className="auto-tag-filters__note" role="status">{resultCount.toLocaleString("ko-KR")}개</span>}
    <button type="button" className="auto-tag-filters__clear" onClick={clearAutoTagFilter}>검색 해제</button>
  </span>;
}
