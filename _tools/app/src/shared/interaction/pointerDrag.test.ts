import { describe, expect, it } from "vitest";
import { pointerDragReducer, type InternalDragPayload } from "./pointerDrag";

const payload: InternalDragPayload = { kind: "assets", assetIds: ["asset-a", "asset-b"] };

describe("pointerDragReducer", () => {
  it("stays armed below six pixels and starts at the threshold", () => {
    const armed = pointerDragReducer({ phase: "idle" }, { type: "arm", payload, x: 10, y: 10 });
    expect(pointerDragReducer(armed, { type: "move", x: 15, y: 10 }).phase).toBe("armed");
    expect(pointerDragReducer(armed, { type: "move", x: 16, y: 10 })).toEqual({ phase: "dragging", payload, x: 16, y: 10 });
  });

  it("tracks a running drag and returns to idle on completion or cancellation", () => {
    const dragging = { phase: "dragging", payload, x: 20, y: 20 } as const;
    expect(pointerDragReducer(dragging, { type: "move", x: 30, y: 40 })).toEqual({ phase: "dragging", payload, x: 30, y: 40 });
    expect(pointerDragReducer(dragging, { type: "finish" })).toEqual({ phase: "idle" });
    expect(pointerDragReducer(dragging, { type: "cancel" })).toEqual({ phase: "idle" });
  });
});
