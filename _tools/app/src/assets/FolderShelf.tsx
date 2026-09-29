import { InformationCircleIcon } from "@heroicons/react/24/outline";
import { useState, type ReactNode } from "react";
import { AnchoredPanel } from "../shared/ui/AnchoredPanel";
import { Button } from "../shared/ui/Button";
import { SegmentedControl, type SegmentedOption } from "../shared/ui/SegmentedControl";
import { ShelfScroller } from "../shared/ui/ShelfScroller";

type FolderShelfProps = {
  label: string;
  cards: ReactNode[];
  accessory?: ReactNode;
  ariaLabel?: string;
  className?: string;
  labelClassName?: string;
};

export function FolderShelf({ label, cards, accessory, ariaLabel, className, labelClassName }: FolderShelfProps) {
  const shelfClassName = ["folder-shelf", className].filter(Boolean).join(" ");
  const sectionLabelClassName = ["ui-section-label", "folder-shelf__label", labelClassName].filter(Boolean).join(" ");
  const labelRowClassName = ["folder-shelf__label-row", labelClassName].filter(Boolean).join(" ");
  return <section className={shelfClassName} aria-label={ariaLabel ?? label}>
    <div className={labelRowClassName}>
      <h3 className={sectionLabelClassName} aria-label={label}>
        <span className="ui-section-label__title">{label}</span>
        <span className="ui-section-label__rule" aria-hidden="true" />
        {accessory !== undefined && <span className="ui-section-label__actions">{accessory}</span>}
      </h3>
    </div>
    {cards.length > 0 && <ShelfScroller previousLabel="이전 항목" nextLabel="다음 항목">{cards}</ShelfScroller>}
  </section>;
}

export type FolderFilterOption<T extends string> = SegmentedOption<T>;

type FolderFilterControlProps<T extends string> = {
  label: string;
  options: readonly FolderFilterOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
};

export function FolderFilterControl<T extends string>({ label, options, value, onChange, className }: FolderFilterControlProps<T>) {
  const [open, setOpen] = useState(false);
  return <div className={["folder-filter", className].filter(Boolean).join(" ")}>
    <SegmentedControl label={label} options={options} value={value} onChange={onChange} />
    <AnchoredPanel
      open={open}
      onOpenChange={setOpen}
      title="미분류와 전체"
      trigger={<Button size="icon" variant="ghost" aria-label="미분류와 전체 설명"><InformationCircleIcon aria-hidden="true" /></Button>}
    >
      <div className="folder-filter__explanation">
        <p><strong>미분류</strong>: 이 폴더에 바로 들어 있고 아직 캐릭터나 하위 폴더에 없는 이미지</p>
        <p><strong>전체</strong>: 캐릭터와 하위 폴더까지 모두</p>
      </div>
    </AnchoredPanel>
  </div>;
}
