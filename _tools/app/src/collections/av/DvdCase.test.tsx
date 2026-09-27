import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PrivacyProvider } from "../../privacy/PrivacyContext";
import { DvdCase } from "./DvdCase";

afterEach(cleanup);

function show(onPoseChange = vi.fn()) {
  render(<PrivacyProvider privacyMode={false} setPrivacyMode={vi.fn()}><DvdCase frontArtworkId="front" spineArtworkId="spine" backArtworkId="back" revision="r1" interactive size={240} onPoseChange={onPoseChange} /></PrivacyProvider>);
  return { stage: screen.getByRole("img", { name: "DVD 케이스" }), onPoseChange };
}

it("snaps a dragged case to the nearest face", () => {
  const { stage, onPoseChange } = show();
  fireEvent.pointerDown(stage, { pointerId: 1, clientX: 0, clientY: 0 });
  fireEvent.pointerMove(stage, { pointerId: 1, clientX: 180, clientY: 0 });
  fireEvent.pointerUp(stage, { pointerId: 1 });
  expect(onPoseChange).toHaveBeenLastCalledWith("spine");
  expect(stage).toHaveAttribute("data-pose", "spine");
});

it("moves by keyboard and returns to the front with Home", () => {
  const { stage, onPoseChange } = show();
  stage.focus();
  fireEvent.keyDown(stage, { key: "ArrowRight" });
  expect(onPoseChange).toHaveBeenLastCalledWith("spine");
  fireEvent.keyDown(stage, { key: "ArrowRight" });
  expect(onPoseChange).toHaveBeenLastCalledWith("back");
  fireEvent.keyDown(stage, { key: "Home" });
  expect(onPoseChange).toHaveBeenLastCalledWith("front");
});

