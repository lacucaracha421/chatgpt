import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// Vitest runs without globals, so Testing Library never registers its own cleanup: a file that forgets
// afterEach(cleanup) leaves its DOM to whichever test runs next (HOME-OPT-001, order dependence).
afterEach(cleanup);

// Default 1000 ms is shorter than a rendered App screen on a host running the whole suite in
// parallel (HOME-OPT-001). Kept below testTimeout so a real failure still reports its own message.
configure({ asyncUtilTimeout: 5000 });

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() }),
}));

class TestResizeObserver implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver ??= TestResizeObserver;

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
