import { useRef, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { PortraitRect } from "../avTypes";
import { movePortraitRect } from "./portraitCrop";
import "./portraitCropSurface.css";

/**
 * The cover with the 3:4 crop frame over it (PC portrait picker and tablet 사진 바꾸기): the frame is dragged with a
 * mouse, pen or finger and stays inside the cover. `children` is the cover image, or the privacy placeholder.
 */
export function PortraitCropSurface({ rect, aspectRatio, onRect, children }: {
  rect: PortraitRect; aspectRatio: string | undefined; onRect(update: (current: PortraitRect) => PortraitRect): void; children: ReactNode;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; rect: PortraitRect } | null>(null);
  const down = (event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = { x: event.clientX, y: event.clientY, rect };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    const bounds = surface.current?.getBoundingClientRect();
    if (!active || !bounds || bounds.width <= 0 || bounds.height <= 0) return;
    onRect(current => movePortraitRect({ ...active.rect, w: current.w, h: current.h }, (event.clientX - active.x) / bounds.width, (event.clientY - active.y) / bounds.height));
  };
  const end = () => { drag.current = null; };
  const frame: CSSProperties = { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` };
  return <div className="av-portrait-picker__crop-image" ref={surface} style={{ aspectRatio }}>
    {children}
    <div className="av-portrait-picker__crop-frame" style={frame} onPointerDown={down} onPointerMove={move} onPointerUp={end} onPointerCancel={end} role="slider" aria-label="초상화 자르기 영역" aria-valuetext="3 대 4 자르기 영역"><i /><i /><i /><i /></div>
  </div>;
}
