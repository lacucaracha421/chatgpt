import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useDesktopInteractions } from "./useDesktopInteractions";

afterEach(cleanup);

function Harness({ onBack = () => false }: { onBack?: () => boolean }) {
  useDesktopInteractions(onBack);
  return <button>대상</button>;
}

it("blocks the WebView context menu", () => {
  render(<Harness />);
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });

  document.dispatchEvent(event);

  expect(event.defaultPrevented).toBe(true);
});

it("routes mouse button four through the shared back request", () => {
  const onBack = vi.fn(() => true);
  render(<Harness onBack={onBack} />);

  fireEvent.mouseUp(window, { button: 3 });
  fireEvent.mouseUp(window, { button: 4 });

  expect(onBack).toHaveBeenCalledOnce();
});
