import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Short, non-interactive hints for explicitly labelled icon controls. */
export function TooltipLayer() {
  const id = useId();
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const tip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hide = () => { clearTimeout(timer); setTarget(null); };
    const find = (value: EventTarget | null) => value instanceof Element ? value.closest<HTMLElement>("[data-tooltip]") : null;
    const enter = (event: Event) => {
      const next = find(event.target);
      if (!next || next.hasAttribute("disabled") || (typeof PointerEvent !== "undefined" && event instanceof PointerEvent && event.pointerType === "touch")) return;
      clearTimeout(timer);
      const show = () => { if (next.isConnected && !document.querySelector('[role="menu"]')) setTarget(next); };
      if (event.type === "focusin") show(); else timer = setTimeout(show, 380);
    };
    const leave = (event: Event) => { const related = (event as FocusEvent).relatedTarget; if (find(event.target) !== find(related)) hide(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") hide(); };
    document.addEventListener("pointerover", enter);
    document.addEventListener("pointerout", leave);
    document.addEventListener("focusin", enter);
    document.addEventListener("focusout", leave);
    document.addEventListener("scroll", hide, true);
    document.addEventListener("pointerdown", hide, true);
    window.addEventListener("keydown", escape);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerover", enter);
      document.removeEventListener("pointerout", leave);
      document.removeEventListener("focusin", enter);
      document.removeEventListener("focusout", leave);
      document.removeEventListener("scroll", hide, true);
      document.removeEventListener("pointerdown", hide, true);
      window.removeEventListener("keydown", escape);
    };
  }, []);
  useLayoutEffect(() => {
    if (!target || !tip.current) return;
    const anchor = target.getBoundingClientRect(), rect = tip.current.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(anchor.left, window.innerWidth - rect.width - 8)), top: anchor.bottom + rect.height + 12 < window.innerHeight ? anchor.bottom + 6 : Math.max(8, anchor.top - rect.height - 6) });
    const original = target.getAttribute("aria-describedby");
    target.setAttribute("aria-describedby", [original, id].filter(Boolean).join(" "));
    return () => { if (original) target.setAttribute("aria-describedby", original); else target.removeAttribute("aria-describedby"); };
  }, [target, id]);
  if (!target?.isConnected || !target.dataset.tooltip) return null;
  return createPortal(<div ref={tip} id={id} role="tooltip" className="ui-tooltip" style={position}>{target.dataset.tooltip}</div>, document.body);
}
