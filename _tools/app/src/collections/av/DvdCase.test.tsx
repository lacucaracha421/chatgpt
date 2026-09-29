import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PrivacyProvider } from "../../privacy/PrivacyContext";
import { DvdCase } from "./DvdCase";

beforeEach(() => { vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function show() {
  render(<PrivacyProvider privacyMode={false} setPrivacyMode={vi.fn()}><DvdCase frontArtworkId="front" spineArtworkId="spine" backArtworkId="back" revision="r1" interactive size={240} /></PrivacyProvider>);
  const stage = screen.getByRole("img", { name: "DVD 케이스" });
  return { stage, yaw: () => (stage.firstElementChild as HTMLElement).style.getPropertyValue("--dvd-yaw") };
}

it("turns freely with a horizontal drag and stays where it was released", () => {
  const { stage, yaw } = show();
  fireEvent.pointerDown(stage, { pointerId: 1, button: 0, clientX: 0, clientY: 0 });
  fireEvent.pointerMove(stage, { pointerId: 1, clientX: 100, clientY: 80 });
  fireEvent.pointerUp(stage, { pointerId: 1 });
  expect(yaw()).toBe("50deg");
  expect(screen.queryByRole("button", { name: "책등" })).toBeNull();
});

it("turns in small steps by keyboard and returns to the front with Home", () => {
  const { stage, yaw } = show();
  stage.focus();
  fireEvent.keyDown(stage, { key: "ArrowRight" });
  fireEvent.keyDown(stage, { key: "ArrowRight" });
  expect(yaw()).toBe("30deg");
  fireEvent.keyDown(stage, { key: "Home" });
  expect(yaw()).toBe("0deg");
});
