import { XMarkIcon } from "@heroicons/react/24/outline";
import type { PropsWithChildren } from "react";
import { Button } from "./Button";

type ToastProps = PropsWithChildren<{
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
  onDismiss?: () => void;
}>;

export function Toast({ children, actionLabel, onAction, actionDisabled = false, onDismiss }: ToastProps) {
  const fullMessage = typeof children === "string" ? children : undefined;
  return (
    <div className="ui-toast" role="status">
      <span className="ui-toast__message" title={fullMessage}>{children}</span>
      {actionLabel && onAction && <Button disabled={actionDisabled} onClick={onAction}>{actionLabel}</Button>}
      {onDismiss && <Button size="icon" variant="ghost" aria-label="알림 닫기" onClick={onDismiss}><XMarkIcon aria-hidden="true" /></Button>}
    </div>
  );
}
