import { useEffect, useRef, useState } from "react";
import { Button } from "../shared/ui/Button";
import { SegmentedControl } from "../shared/ui/SegmentedControl";
import { Slider } from "../shared/ui/Slider";
import { ViewOptionsSection } from "../shared/ui/ViewOptionsSection";
import { AV_SPINE_SIZES, SPINE_SIZE_LABEL, SPINE_SIZES, type SpineSize } from "./case/caseDimensions";
import type { CollectionLibraryDirection, CollectionLibrarySort, CollectionRatingFilter } from "./collectionLibrary";
import type { CollectionViewSettings } from "./CollectionList";
import "./collectionViewSections.css";

/**
 * The 보기 sections Collections shares between the PC menu and the tablet sheet (DESIGN.md §12):
 * 내 별점 first, then 배치 (the shared `ViewOptionsMenu` / `ShelfViewSection`), then 정렬.
 */

export type CollectionGrouping = CollectionViewSettings["grouping"];

const sizeOptions = (sizes: readonly SpineSize[]) => sizes.map(value => ({ value, label: SPINE_SIZE_LABEL[value] }));
const SPINE_SIZE_OPTIONS = sizeOptions(SPINE_SIZES), AV_SPINE_SIZE_OPTIONS = sizeOptions(AV_SPINE_SIZES);
/** Bookcase spine size replaces the per-row control. AV and movies include the huge option. */
export function SpineSizeRow({ value, av = false, onChange }: { value: SpineSize; av?: boolean; onChange(value: SpineSize): void }) {
  return <div className="collection-view-sort__row"><span className="collection-view-sort__label">책등 크기</span>
    <SegmentedControl label="책등 크기" options={av ? AV_SPINE_SIZE_OPTIONS : SPINE_SIZE_OPTIONS} value={!av && value === "huge" ? "large" : value} fullWidth onChange={onChange} /></div>;
}

/** Slider stops: 전체, then 0.5 … 5.0 (exact match). 미평가 is a separate toggle, never a stop. */
export const RATING_STEPS: CollectionRatingFilter[] = ["all", 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];

export function ratingLabel(rating: CollectionRatingFilter): string {
  return rating === "all" ? "전체" : rating === "unrated" ? "미평가" : `★ ${rating.toFixed(1)}`;
}

/** The slider stop for a filter; a saved score between stops (for example 0.0) sits on the nearest. */
export function ratingStep(rating: CollectionRatingFilter): number {
  if (typeof rating !== "number") return 0;
  return Math.min(10, Math.max(1, Math.round(rating * 2)));
}

/**
 * The 내 별점 slider with its separate 미평가 toggle. `settleMs` holds a drag for that long before it
 * is reported (the tablet reloads a server list, so one gesture is one request); without it every
 * step is reported at once.
 */
export function RatingFilterControl({ rating, onChange, settleMs = 0 }: { rating: CollectionRatingFilter; onChange(rating: CollectionRatingFilter): void; settleMs?: number }) {
  const step = rating === "unrated" ? 0 : ratingStep(rating);
  const [draft, setDraft] = useState(step);
  const report = useRef(onChange);
  report.current = onChange;
  useEffect(() => { setDraft(step); }, [step, rating]);
  useEffect(() => {
    if (!settleMs || draft === step) return;
    const timer = window.setTimeout(() => report.current(RATING_STEPS[draft] ?? "all"), settleMs);
    return () => window.clearTimeout(timer);
  }, [draft, step, settleMs]);
  // The stop that matches the saved filter speaks the saved value (a score between stops stays exact).
  const text = (index: number) => ratingLabel(index === step && rating !== "unrated" ? rating : RATING_STEPS[index] ?? "all");
  return <div className="collection-rating-filter">
    <Slider label="내 별점" min={0} max={RATING_STEPS.length - 1} step={1} value={draft} aria-valuetext={rating === "unrated" ? "미평가" : text(draft)}
      className={rating === "unrated" ? "is-idle" : undefined}
      onChange={event => {
        const index = Number(event.target.value);
        setDraft(index);
        const next = RATING_STEPS[index] ?? "all";
        if (!settleMs && next !== rating) onChange(next);
      }} />
    <div className="collection-rating-filter__row">
      <output className="collection-rating-filter__value">{rating === "unrated" ? "미평가" : text(draft)}</output>
      <Button size="sm" variant="secondary" aria-pressed={rating === "unrated"} onClick={() => onChange(rating === "unrated" ? "all" : "unrated")}>미평가</Button>
    </div>
  </div>;
}

/** 내 별점: the filter; 초기화 shows in the section label only while a filter is on. */
export function CollectionRatingSection({ rating, onChange, settleMs }: { rating: CollectionRatingFilter; onChange(rating: CollectionRatingFilter): void; settleMs?: number }) {
  return <ViewOptionsSection title="내 별점" actions={rating !== "all" ? <Button size="sm" variant="ghost" onClick={() => onChange("all")}>초기화</Button> : undefined}>
    <RatingFilterControl rating={rating} onChange={onChange} settleMs={settleMs} />
  </ViewOptionsSection>;
}

const CRITERIA: { value: CollectionLibrarySort; label: string }[] = [
  { value: "media_date", label: "발매일" }, { value: "recent", label: "추가일" }, { value: "name", label: "제목" },
];
const GROUPINGS: { value: CollectionGrouping; label: string }[] = [
  { value: "sort", label: "안 묶음" }, { value: "device", label: "기기" }, { value: "year", label: "발매 연도" },
];

/** 순서 words follow the 기준: dates read newest/oldest, titles read alphabetical/reverse. */
export function directionOptions(sort: CollectionLibrarySort): { value: CollectionLibraryDirection; label: string }[] {
  return sort === "name" ? [{ value: "asc", label: "가나다순" }, { value: "desc", label: "역순" }] : [{ value: "desc", label: "최신순" }, { value: "asc", label: "오래된순" }];
}

/** A new 기준 keeps the 순서 between the two date criteria; crossing to or from 제목 restarts at that criterion's first word. */
export function sortAfterCriterion(current: { sort: CollectionLibrarySort; direction: CollectionLibraryDirection }, sort: CollectionLibrarySort): { sort: CollectionLibrarySort; direction: CollectionLibraryDirection } {
  if ((current.sort === "name") === (sort === "name")) return { sort, direction: current.direction };
  return { sort, direction: sort === "name" ? "asc" : "desc" };
}

/**
 * Grouping sits above the sort controls. Only the game's release-year grouping requires release-date
 * sorting; movie decade/director groups partition whichever order the user chose.
 */
export function CollectionSortSection({ sort, direction, onSortChange, grouping, onGroupingChange, movie = false }: {
  sort: CollectionLibrarySort; direction: CollectionLibraryDirection;
  onSortChange(next: { sort: CollectionLibrarySort; direction: CollectionLibraryDirection }): void;
  /** Games and movies only: omit for types without grouping. */
  grouping?: CollectionGrouping; onGroupingChange?: (grouping: CollectionGrouping) => void; movie?: boolean;
}) {
  const changeSort = (next: { sort: CollectionLibrarySort; direction: CollectionLibraryDirection }) => {
    onSortChange(next);
    if (grouping === "year" && next.sort !== "media_date") onGroupingChange?.("sort");
  };
  return <ViewOptionsSection title="정렬">
    {onGroupingChange && <div className="collection-view-sort__row"><span className="collection-view-sort__label">묶기</span>
      <SegmentedControl label="묶기" options={movie ? [{ value: "sort", label: "안 묶음" }, { value: "decade", label: "연대" }, { value: "director", label: "감독" }] : GROUPINGS} value={grouping ?? "sort"} fullWidth
        onChange={next => { onGroupingChange(next); if (next === "year") onSortChange({ sort: "media_date", direction: "desc" }); }} /></div>}
    <div className="collection-view-sort__row"><span className="collection-view-sort__label">기준</span>
      <SegmentedControl label="정렬 기준" options={movie ? CRITERIA.map(option => option.value === "media_date" ? { ...option, label: "개봉일" } : option) : CRITERIA} value={sort} fullWidth onChange={next => changeSort(sortAfterCriterion({ sort, direction }, next))} /></div>
    <div className="collection-view-sort__row"><span className="collection-view-sort__label">순서</span>
      <SegmentedControl label="정렬 순서" options={directionOptions(sort)} value={direction} fullWidth onChange={next => changeSort({ sort, direction: next })} /></div>
  </ViewOptionsSection>;
}
