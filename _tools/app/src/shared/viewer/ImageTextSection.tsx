import { useEffect, useId, useRef } from "react";
import type { ImageTextLine } from "../../library/types";
import { BusyLabel } from "../ui/BusyLabel";
import { SectionLabel } from "../ui/SectionLabel";
import "./image-text.css";

export type ImageTextSectionProps = {
  lines: ImageTextLine[];
  selected: number | null;
  open: boolean;
  onSelect: (index: number) => void;
  onToggle: () => void;
  /** Already gated at 400ms by the host's useDelayedBusy; keep this label mounted across edges. */
  busy?: boolean;
};

export function ImageTextSection({ lines, selected, open, onSelect, onToggle, busy = false }: ImageTextSectionProps) {
  const id = useId();
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open || selected === null) return;
    const row = root.current?.querySelector<HTMLElement>(`[data-line="${selected}"]`);
    // Scroll only the reading surface, never the dialog, image or document.
    const scroller = root.current?.closest<HTMLElement>("[data-image-text-scroll]");
    if (!row || !scroller) return;
    const bounds = row.getBoundingClientRect();
    const viewport = scroller.getBoundingClientRect();
    if (bounds.top < viewport.top) scroller.scrollTop += bounds.top - viewport.top;
    else if (bounds.bottom > viewport.bottom) scroller.scrollTop += bounds.bottom - viewport.bottom;
  }, [selected, open]);

  return <section ref={root} className="image-text-section" data-info-section="image-text">
    <SectionLabel title="번역" count={lines.length} unit="줄" collapsible={{ open, onToggle, controls: id }} />
    <BusyLabel busy={busy} delay={0}><p className="image-text-section__busy" role="status">불러오는 중</p></BusyLabel>
    <div id={id} className="ui-fold" data-open={open} inert={!open} aria-hidden={!open}>
      <div className="ui-fold__inner">
        <ol className="image-text-section__lines">
          {lines.map((line, index) => <li key={index}>
            <button type="button" className="image-text-section__row" data-line={index} aria-pressed={selected === index} onClick={() => onSelect(index)}>
              <span className="image-text-section__number" data-positioned={Boolean(line.box)}>{index + 1}</span>
              <span><span className="image-text-section__korean">{line.korean}</span><span className="image-text-section__original">{line.original}</span></span>
            </button>
          </li>)}
        </ol>
      </div>
    </div>
  </section>;
}
