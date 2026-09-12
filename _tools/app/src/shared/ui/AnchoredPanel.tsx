import * as RadixDialog from "@radix-ui/react-dialog";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { useCallback, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { useBackHandler } from "../navigation/BackNavigation";

const EDGE = 12;
const GAP = 8;
type AnchoredPanelProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactElement;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
};

/** A non-modal, viewport-bounded sheet that never reserves gallery space. */
export function AnchoredPanel({ open, onOpenChange, trigger, title, description, children, footer }: AnchoredPanelProps) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [contentNode, setContentNode] = useState<HTMLDivElement | null>(null);
  const attachContent = useCallback((node: HTMLDivElement | null) => { contentRef.current = node; setContentNode(node); }, []);
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });
  const closeRef = useRef(onOpenChange);
  closeRef.current = onOpenChange;
  useBackHandler(() => closeRef.current(false), 90, open);
  useLayoutEffect(() => {
    if (!open) return;
    const triggerNode = triggerRef.current;
    const content = contentNode;
    if (!triggerNode || !content) return;
    const navigation = triggerNode.closest<HTMLElement>(".workspace-navigation");
    const index = triggerNode.closest<HTMLElement>(".workspace-index")
      ?? navigation?.querySelector<HTMLElement>(".workspace-index")
      ?? triggerNode;
    const positionPanel = () => {
      const anchor = triggerNode.getBoundingClientRect();
      const side = index.getBoundingClientRect();
      const rect = content.getBoundingClientRect();
      const viewport = window.visualViewport;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const offsetX = viewport?.offsetLeft ?? 0;
      const offsetY = viewport?.offsetTop ?? 0;
      const left = Math.max(offsetX + EDGE, Math.min(side.right + GAP, offsetX + width - rect.width - EDGE));
      const top = Math.max(offsetY + EDGE, Math.min(anchor.bottom - rect.height, offsetY + height - rect.height - EDGE));
      setPosition({ left, top, visibility: "visible" });
    };
    positionPanel();
    const observer = new ResizeObserver(positionPanel);
    observer.observe(content);
    observer.observe(index);
    window.addEventListener("resize", positionPanel);
    window.visualViewport?.addEventListener("resize", positionPanel);
    return () => { observer.disconnect(); window.removeEventListener("resize", positionPanel); window.visualViewport?.removeEventListener("resize", positionPanel); };
  }, [open, contentNode]);
  return <RadixDialog.Root modal={false} open={open} onOpenChange={onOpenChange}>
    <RadixDialog.Trigger ref={triggerRef} asChild>{trigger}</RadixDialog.Trigger>
    <RadixDialog.Portal>
      <RadixDialog.Content ref={attachContent} className="ui-anchored-panel"
        style={position} data-workspace-popover={id} aria-modal={false} aria-describedby={undefined}
        onOpenAutoFocus={(event) => { event.preventDefault(); requestAnimationFrame(() => (contentRef.current?.querySelector<HTMLElement>("select:not(:disabled), input:not(:disabled)") ?? contentRef.current?.querySelector<HTMLElement>("button:not(:disabled)") ?? contentRef.current)?.focus({ preventScroll: true })); }}
        onEscapeKeyDown={(event) => { event.preventDefault(); event.stopPropagation(); onOpenChange(false); }}
        onInteractOutside={(event) => {
          const target = event.target;
          // A child menu may live in another DOM portal.
          if (target instanceof Node && contentRef.current?.contains(target)) event.preventDefault();
          if (target instanceof Element && target.closest("[data-panel-owner]")?.getAttribute("data-panel-owner") === id) event.preventDefault();
        }}
      >
        <div className="ui-anchored-panel__head">
          <RadixDialog.Title>{title}</RadixDialog.Title>
          <RadixDialog.Close className="ui-button ui-button--icon ui-button--ghost" aria-label={`${title} 닫기`}><XMarkIcon aria-hidden="true" /></RadixDialog.Close>
        </div>
        {description && <p className="ui-anchored-panel__context">{description}</p>}
        <div className="ui-anchored-panel__body">{children}</div>
        {footer && <div className="ui-anchored-panel__foot">{footer}</div>}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  </RadixDialog.Root>;
}
