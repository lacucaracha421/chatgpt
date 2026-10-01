import { XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Button } from "./Button";

const EXIT_MS = 220;

type OverlayPanelProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  ariaLabel?: string;
  closeLabel?: string;
  actions?: ReactNode;
  children: ReactNode;
  width?: number | string;
  /** A surface that swaps items in place can return focus to the latest opener. */
  returnFocusRef?: RefObject<HTMLElement | null>;
};

/** A non-modal side panel that overlays a reflowing surface without changing its width. */
export function OverlayPanel({ open, onOpenChange, title, ariaLabel, closeLabel, actions, children, width = 320, returnFocusRef }: OverlayPanelProps) {
  const [mounted, setMounted] = useState(open);
  const [entered, setEntered] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMounted(true);
  }, [open]);

  useEffect(() => {
    if (!open || !mounted) { setEntered(false); return; }
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (reduced) { setEntered(true); return; }
    const frame = window.requestAnimationFrame(() => setEntered(true));
    return () => window.cancelAnimationFrame(frame);
  }, [mounted, open]);

  useEffect(() => {
    if (open || !mounted) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const finish = () => {
      setMounted(false);
      (returnFocusRef?.current ?? restoreFocusRef.current)?.focus({ preventScroll: true });
      restoreFocusRef.current = null;
    };
    if (reduced) { finish(); return; }
    const timer = window.setTimeout(finish, EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [mounted, open, returnFocusRef]);

  useLayoutEffect(() => {
    if (!open || !mounted) return;
    const first = panelRef.current?.querySelector<HTMLElement>("button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])");
    (first ?? panelRef.current)?.focus({ preventScroll: true });
  }, [mounted, open]);

  if (!mounted) return null;
  const style = { "--overlay-panel-width": typeof width === "number" ? `${width}px` : width } as CSSProperties;
  const close = () => onOpenChange(false);
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };

  return (
    <aside
      ref={panelRef}
      className="ui-overlay-panel"
      data-state={open && entered ? "open" : "closed"}
      style={style}
      role="complementary"
      aria-label={ariaLabel ?? (typeof title === "string" ? title : undefined)}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      <header className="ui-overlay-panel__header">
        <strong>{title}</strong>
        <span className="ui-overlay-panel__actions">{actions}</span>
        <Button size="icon" variant="ghost" aria-label={closeLabel ?? "패널 닫기"} onClick={close}><XMarkIcon aria-hidden="true" /></Button>
      </header>
      <div className="ui-overlay-panel__body">{children}</div>
    </aside>
  );
}
