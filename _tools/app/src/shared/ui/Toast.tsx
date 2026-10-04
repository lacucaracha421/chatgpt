import { XMarkIcon } from "@heroicons/react/24/outline";
import type { PropsWithChildren } from "react";
import { createPortal } from "react-dom";
import { Button } from "./Button";
import { TOAST_PAUSE_EVENT, TOAST_RESUME_EVENT } from "./useAutoDismiss";
import { useMotionSurface } from "./useMotionSurface";
import { motionSpring, prefersReducedMotion } from "./motionCurves";

type ToastProps = PropsWithChildren<{
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
  secondaryActionLabel?: string;
  onSecondaryAction?: () => void;
  onDismiss?: () => void;
  tone?: "status" | "error";
}>;

export function Toast({ children, actionLabel, onAction, actionDisabled = false, secondaryActionLabel, onSecondaryAction, onDismiss, tone = "status" }: ToastProps) {
  const surfaceRef = useMotionSurface("toast");
  const fullMessage = typeof children === "string" ? children : undefined;
  const pause = () => window.dispatchEvent(new Event(TOAST_PAUSE_EVENT));
  const resume = () => window.dispatchEvent(new Event(TOAST_RESUME_EVENT));
  return createPortal(
    <div
      ref={surfaceRef}
      data-state="open"
      className={`ui-toast ui-toast--${tone}`}
      role={tone === "error" ? "alert" : "status"}
      aria-atomic="true"
      onPointerEnter={pause}
      onPointerLeave={resume}
      onFocusCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) pause();
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) resume();
      }}
    >
      <span className="ui-toast__message" aria-description={fullMessage}>{children}</span>
      {actionLabel && onAction && <Button disabled={actionDisabled} onClick={onAction}>{actionLabel}</Button>}
      {secondaryActionLabel && onSecondaryAction && <Button variant="ghost" disabled={actionDisabled} onClick={onSecondaryAction}>{secondaryActionLabel}</Button>}
      {onDismiss && <Button size="icon" variant="ghost" aria-label="알림 닫기" onClick={onDismiss}><XMarkIcon aria-hidden="true" /></Button>}
    </div>,
    toastRegion(),
  );
}

function toastRegion() {
  const existing = document.querySelector<HTMLElement>(".ui-toast-region");
  if (existing) return existing;
  const region = document.createElement("div");
  region.className = "ui-toast-region";
  document.body.append(region);
  watchToastLayout(region);
  return region;
}

function watchToastLayout(region: HTMLElement) {
  const positions = new Map<HTMLElement, { top: number; animation?: Animation }>();
  const layout = () => {
    const nodes = [...region.children] as HTMLElement[];
    for (const [node, previous] of positions) if (!nodes.includes(node)) { previous.animation?.cancel(); positions.delete(node); }
    for (const node of nodes) {
      const previous = positions.get(node);
      // The region is bottom-anchored: its own top moves when a toast leaves.
      const top = region.getBoundingClientRect().top + node.offsetTop;
      let delta = previous ? previous.top - top : 0;
      if (previous?.animation) {
        const transform = getComputedStyle(node).transform;
        if (transform && transform !== "none" && typeof DOMMatrixReadOnly !== "undefined") delta += new DOMMatrixReadOnly(transform).m42;
        previous.animation.cancel();
      }
      const animation = delta && !prefersReducedMotion() && typeof node.animate === "function"
        ? node.animate([{ transform: `translateY(${delta}px)` }, { transform: "none" }], motionSpring("gentle", node)) : undefined;
      positions.set(node, { top, animation: animation || undefined });
    }
  };
  new MutationObserver(layout).observe(region, { childList: true });
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(layout).observe(region);
  window.matchMedia?.("(prefers-reduced-motion: reduce)").addEventListener?.("change", event => {
    if (event.matches) for (const value of positions.values()) { value.animation?.cancel(); value.animation = undefined; }
  });
}
