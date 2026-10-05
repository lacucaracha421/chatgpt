import { useRef, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import type { MangaReadingDirection } from "../preferences/uiPreferences";
import { IconButton } from "../shared/ui/IconButton";
import "./ReaderControlBar.css";

type ReaderControlBarProps = {
  page: number;
  pageLabel: string | number;
  total: number;
  direction: MangaReadingDirection;
  sliderLabel?: string;
  nextDisabled: boolean;
  previousDisabled: boolean;
  onPageChange: (page: number) => void;
  onNext: () => void;
  onPrevious: () => void;
  onScrubbingChange: (active: boolean) => void;
};

/** Reader-specific chrome: preview a pointer scrub without requesting pages until release. */
export function ReaderControlBar({ page, pageLabel, total, direction, sliderLabel = "페이지 이동", nextDisabled, previousDisabled, onPageChange, onNext, onPrevious, onScrubbingChange }: ReaderControlBarProps) {
  const [preview, setPreview] = useState<number | null>(null);
  const scrubbing = useRef(false);
  const cancel = () => {
    if (!scrubbing.current) return;
    scrubbing.current = false;
    setPreview(null);
    onScrubbingChange(false);
  };
  const rtl = direction === "rtl";
  const turnButton = (next: boolean, left: boolean) => <IconButton
    label={next ? "다음 페이지" : "이전 페이지"} icon={left ? ChevronLeftIcon : ChevronRightIcon}
    disabled={next ? nextDisabled : previousDisabled} onClick={next ? onNext : onPrevious}
  />;

  return <div className="reader-control-bar" dir="ltr">
    {turnButton(rtl, true)}
    <label className="reader-control-bar__jump">
      <span className="numeric">{preview ?? pageLabel} / {total}</span>
      <input type="range" dir={direction} aria-label={sliderLabel}
        min={1} max={total} step={1} value={preview ?? page}
        aria-valuetext={`${preview ?? page} / ${total}페이지`} disabled={total <= 1}
        onPointerDown={event => {
          scrubbing.current = true;
          setPreview(page);
          onScrubbingChange(true);
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onChange={event => {
          const value = Number(event.currentTarget.value);
          if (scrubbing.current) setPreview(value);
          else onPageChange(value);
        }}
        onPointerUp={event => {
          if (scrubbing.current) onPageChange(Number(event.currentTarget.value));
          cancel();
        }}
        onPointerCancel={cancel} onLostPointerCapture={cancel}
      />
    </label>
    {turnButton(!rtl, false)}
  </div>;
}
