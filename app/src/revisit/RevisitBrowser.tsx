import { useState, type ReactNode } from "react";
import { ViewToolbar } from "../layout/ViewToolbar";
import { CreatorBrowse } from "./CreatorBrowse";
import { DateBrowse } from "./DateBrowse";
import { TodayView } from "./TodayView";

type Section = "today" | "browse";
type BrowseMode = "date" | "creator";

export function RevisitBrowser({ renderDay, onOpenCreator, onOpenBundle, privacyMode, cellSize, onSelectedDateChange }: {
  renderDay?: (localDate: string) => ReactNode;
  onOpenCreator?: (creatorKey: string) => void;
  onOpenBundle?: (bundleId: string) => void;
  privacyMode?: boolean;
  cellSize?: number;
  onSelectedDateChange?: (localDate: string | null) => void;
}) {
  const [section, setSection] = useState<Section>("today");
  const [browseMode, setBrowseMode] = useState<BrowseMode>("date");
  const [dateSelected, setDateSelected] = useState(false);
  const primaryTabs = <div className="revisit-browser__tabs" role="tablist" aria-label="다시보기 메뉴">
    <button type="button" role="tab" aria-selected={section === "today"} onClick={() => setSection("today")}>오늘</button>
    <button type="button" role="tab" aria-selected={section === "browse"} onClick={() => setSection("browse")}>둘러보기</button>
  </div>;

  if (section === "today") {
    return <section className="revisit-browser" aria-label="다시보기">
      <TodayView toolbarContent={primaryTabs} onOpenBundle={onOpenBundle} />
    </section>;
  }

  return <section className="revisit-browser" aria-label="다시보기">
    <ViewToolbar title="다시보기" ariaLabel="다시보기 도구">
      {primaryTabs}
      {!dateSelected && <div className="revisit-browser__subtabs" role="tablist" aria-label="둘러보기 기준">
        <button type="button" role="tab" aria-selected={browseMode === "date"} onClick={() => setBrowseMode("date")}>날짜</button>
        <button type="button" role="tab" aria-selected={browseMode === "creator"} onClick={() => setBrowseMode("creator")}>작가</button>
      </div>}
    </ViewToolbar>
    {browseMode === "date" ? <DateBrowse renderDay={renderDay} onSelectedDateChange={(date) => { setDateSelected(date !== null); onSelectedDateChange?.(date); }} /> : onOpenCreator ? <CreatorBrowse onOpenCreator={onOpenCreator} privacyMode={privacyMode ?? false} cellSize={cellSize} /> : <div className="revisit-browser__placeholder">작가 탐색을 준비하고 있습니다.</div>}
  </section>;
}
