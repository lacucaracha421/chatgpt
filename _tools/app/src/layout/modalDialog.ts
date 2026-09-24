/**
 * True while a modal dialog (Radix Dialog, the asset/manga/cover viewers, FAULT) is open.
 * Non-modal anchored panels (더보기, 상태) mark themselves aria-modal="false" and do not count.
 */
export function modalDialogOpen() {
  return document.querySelector('[role="dialog"]:not([aria-modal="false"]), [role="alertdialog"]') !== null;
}
