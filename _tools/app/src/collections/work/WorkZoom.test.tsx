import { fireEvent, render, screen } from "@testing-library/react";
import { memo } from "react";
import { expect, it, vi } from "vitest";
import { WorkZoomObject, WorkZoomProvider, WorkZoomStage, useWorkTurnBlocked } from "./WorkZoom";

function Turner({ onTurn }: { onTurn(): void }) {
  const blocked = useWorkTurnBlocked();
  return <div data-testid="object" onPointerMove={() => { if (!blocked?.current) onTurn(); }} />;
}

it("keeps zoom consumers stable on parent renders and updates them when zoom changes", () => {
  const observe = vi.fn();
  const Consumer = memo(function Consumer() {
    observe(useWorkTurnBlocked());
    return null;
  });
  const { rerender } = render(<WorkZoomProvider workId="w" reset={0}><WorkZoomStage data-testid="stage"><WorkZoomObject><Consumer /></WorkZoomObject></WorkZoomStage></WorkZoomProvider>);
  observe.mockClear();
  rerender(<WorkZoomProvider workId="w" reset={0}><WorkZoomStage data-testid="stage"><WorkZoomObject><Consumer /></WorkZoomObject></WorkZoomStage></WorkZoomProvider>);
  expect(observe).not.toHaveBeenCalled();
  fireEvent.wheel(screen.getByTestId("stage"), { deltaY: -100 });
  expect(Number(document.querySelector<HTMLElement>(".work-zoom-object")!.dataset.zoom)).toBeGreaterThan(1);
  expect(observe).toHaveBeenCalledTimes(1);
  rerender(<WorkZoomProvider workId="other" reset={0}><WorkZoomObject><Consumer /></WorkZoomObject></WorkZoomProvider>);
  expect(document.querySelector<HTMLElement>(".work-zoom-object")!.dataset.zoom).toBe("1");
});

it("lets a one-finger vertical drag on the stage scroll the page instead of turning the object", () => {
  const onTurn = vi.fn();
  render(<div data-testid="page" style={{ overflowY: "auto" }}>
    <WorkZoomProvider workId="w" reset={0}><WorkZoomStage data-testid="stage"><WorkZoomObject><Turner onTurn={onTurn} /></WorkZoomObject></WorkZoomStage></WorkZoomProvider>
  </div>);
  const page = screen.getByTestId("page");
  Object.defineProperty(page, "scrollHeight", { value: 2000 });
  Object.defineProperty(page, "clientHeight", { value: 800 });
  page.scrollTop = 300;
  const object = screen.getByTestId("object");
  fireEvent.pointerDown(object, { pointerId: 1, pointerType: "touch", clientX: 100, clientY: 400 });
  fireEvent.pointerMove(object, { pointerId: 1, pointerType: "touch", clientX: 101, clientY: 380 });
  fireEvent.pointerMove(object, { pointerId: 1, pointerType: "touch", clientX: 101, clientY: 340 });
  expect(page.scrollTop).toBe(360);
  expect(onTurn).not.toHaveBeenCalled();
  fireEvent.pointerUp(object, { pointerId: 1, pointerType: "touch" });
  fireEvent.pointerDown(object, { pointerId: 2, pointerType: "touch", clientX: 100, clientY: 400 });
  fireEvent.pointerMove(object, { pointerId: 2, pointerType: "touch", clientX: 140, clientY: 402 });
  expect(onTurn).toHaveBeenCalled();
});
