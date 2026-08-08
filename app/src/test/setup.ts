import "@testing-library/jest-dom/vitest";

if (typeof HTMLDialogElement !== "undefined" && !HTMLDialogElement.prototype.showModal) {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value(this: HTMLDialogElement) { this.setAttribute("open", ""); },
    },
    close: {
      configurable: true,
      value(this: HTMLDialogElement) { this.removeAttribute("open"); },
    },
  });
}
