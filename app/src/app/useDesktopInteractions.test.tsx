import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useDesktopInteractions } from "./useDesktopInteractions";

afterEach(cleanup);

function Harness() {
  useDesktopInteractions();
  return <button>대상</button>;
}

it("blocks the WebView context menu", () => {
  render(<Harness />);
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });

  document.dispatchEvent(event);

  expect(event.defaultPrevented).toBe(true);
});

it("routes mouse button four through the existing Escape path", () => {
  render(<Harness />);
  const escape = vi.fn();
  window.addEventListener("keydown", escape);

  fireEvent.mouseUp(window, { button: 3 });
  fireEvent.mouseUp(window, { button: 4 });

  expect(escape).toHaveBeenCalledOnce();
  expect(escape.mock.calls[0]?.[0]).toMatchObject({ key: "Escape", code: "Escape" });
  window.removeEventListener("keydown", escape);
});
