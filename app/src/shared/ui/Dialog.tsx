import { useEffect, useId, useRef, type PropsWithChildren } from "react";

type DialogProps = PropsWithChildren<{
  open: boolean;
  title: string;
  onClose: () => void;
}>;

export function Dialog({ children, open, title, onClose }: DialogProps) {
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
  }, [open]);

  function closeAndRestoreFocus() {
    dialogRef.current?.close();
    openerRef.current?.focus();
    onClose();
  }

  return (
    <dialog
      ref={dialogRef}
      className="ui-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        closeAndRestoreFocus();
      }}
    >
      <h2 className="ui-dialog__title" id={titleId}>{title}</h2>
      {children}
    </dialog>
  );
}
