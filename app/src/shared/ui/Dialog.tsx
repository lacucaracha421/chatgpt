import * as RadixDialog from "@radix-ui/react-dialog";
import { useEffect, useRef, type KeyboardEventHandler, type PropsWithChildren } from "react";

type DialogProps = PropsWithChildren<{
  open: boolean;
  title: string;
  closeDisabled?: boolean;
  variant?: "default" | "fullscreen";
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  onClose: () => void;
}>;

export function Dialog({ children, closeDisabled = false, open, title, variant = "default", onKeyDown, onClose }: DialogProps) {
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    wasOpenRef.current = open;
  }, [open]);

  return (
    <RadixDialog.Root open={open} onOpenChange={(nextOpen) => { if (!nextOpen && !closeDisabled) onClose(); }}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="ui-dialog__overlay" />
        <RadixDialog.Content
          className={`ui-dialog${variant === "fullscreen" ? " ui-dialog--fullscreen" : ""}`}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            openerRef.current?.focus();
          }}
          onEscapeKeyDown={(event) => { if (closeDisabled) event.preventDefault(); }}
          onPointerDownOutside={(event) => { if (closeDisabled) event.preventDefault(); }}
          onKeyDown={onKeyDown}
        >
          <RadixDialog.Title className="ui-dialog__title">{title}</RadixDialog.Title>
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
