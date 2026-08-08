import { useEffect, useId, useRef, type KeyboardEventHandler, type PropsWithChildren } from "react";

type DialogProps = PropsWithChildren<{
  open: boolean;
  title: string;
  closeDisabled?: boolean;
  variant?: "default" | "fullscreen";
  onKeyDown?: KeyboardEventHandler<HTMLDialogElement>;
  onClose: () => void;
}>;

export function Dialog({ children, closeDisabled = false, open, title, variant = "default", onKeyDown, onClose }: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
    }
    if (!open && dialog.open) {
      dialog.close();
      openerRef.current?.focus();
    }
    return () => {
      if (dialog.open) dialog.close();
      openerRef.current?.focus();
    };
  }, [open]);

  function closeAndRestoreFocus() {
    dialogRef.current?.close();
    openerRef.current?.focus();
    onClose();
  }

  return (
    <dialog
      ref={dialogRef}
      className={`ui-dialog${variant === "fullscreen" ? " ui-dialog--fullscreen" : ""}`}
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
      onCancel={(event) => {
        event.preventDefault();
        if (closeDisabled) return;
        closeAndRestoreFocus();
      }}
    >
      <h2 className="ui-dialog__title" id={titleId}>{title}</h2>
      {children}
    </dialog>
  );
}
