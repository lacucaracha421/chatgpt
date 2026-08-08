import type { PropsWithChildren } from "react";
import { Button } from "./Button";

type ToastProps = PropsWithChildren<{
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
}>;

export function Toast({ children, actionLabel, onAction, actionDisabled = false }: ToastProps) {
  return (
    <div className="ui-toast" role="status">
      <span>{children}</span>
      {actionLabel && onAction && <Button disabled={actionDisabled} onClick={onAction}>{actionLabel}</Button>}
    </div>
  );
}
