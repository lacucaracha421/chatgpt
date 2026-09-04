import { XMarkIcon } from "@heroicons/react/24/outline";
import type { PropsWithChildren } from "react";
import { createPortal } from "react-dom";
import { Button } from "./Button";
import { TOAST_PAUSE_EVENT, TOAST_RESUME_EVENT } from "./useAutoDismiss";

type ToastProps = PropsWithChildren<{
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
  onDismiss?: () => void;
  tone?: "status" | "error";
}>;

export function Toast({ children, actionLabel, onAction, actionDisabled = false, onDismiss, tone = "status" }: ToastProps) {
  const fullMessage = typeof children === "string" ? children : undefined;
  const pause = () => window.dispatchEvent(new Event(TOAST_PAUSE_EVENT));
  const resume = () => window.dispatchEvent(new Event(TOAST_RESUME_EVENT));
  return createPortal(
    <div
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
      <span className="ui-toast__message" title={fullMessage}>{children}</span>
      {actionLabel && onAction && <Button disabled={actionDisabled} onClick={onAction}>{actionLabel}</Button>}
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
  return region;
}
