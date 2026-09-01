import * as RadixDialog from "@radix-ui/react-dialog";
import { useEffect, useRef, type KeyboardEventHandler, type PropsWithChildren } from "react";
import { useBackHandler, useBackNavigationContext } from "../navigation/BackNavigation";

type DialogProps = PropsWithChildren<{
  open: boolean;
  title: string;
  variant?: "default" | "medium" | "wide" | "fullscreen";
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  onClose: () => void;
}>;

export function Dialog({ children, open, title, variant = "default", onKeyDown, onClose }: DialogProps) {
  const backNavigation = useBackNavigationContext();
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    wasOpenRef.current = open;
  }, [open]);
  useBackHandler(() => { onClose(); }, 100, open);

  return (
    <RadixDialog.Root open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="ui-dialog__overlay" />
        <RadixDialog.Content
          className={`ui-dialog${variant === "default" ? "" : ` ui-dialog--${variant}`}`}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            openerRef.current?.focus();
          }}
          onKeyDown={onKeyDown}
          onEscapeKeyDown={backNavigation ? (event) => {
            event.preventDefault();
            backNavigation.requestBack();
          } : undefined}
        >
          <RadixDialog.Title className="ui-dialog__title">{title}</RadixDialog.Title>
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
