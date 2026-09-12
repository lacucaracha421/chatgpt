import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackNavigationProvider, useBackHandler, useBackRequest } from "../shared/navigation/BackNavigation";
import { useDesktopInteractions } from "../app/useDesktopInteractions";
import { WorkArtworkGallery } from "./WorkArtworkGallery";

afterEach(cleanup);

describe("WorkArtworkGallery", () => {
  it.each(["mouse", "escape"])("returns to the artwork strip on %s back without leaving the collection", async (input) => {
    const leaveCollection = vi.fn();
    function Harness() {
      useDesktopInteractions(useBackRequest());
      useBackHandler(leaveCollection);
      return <WorkArtworkGallery workTitle="Astral Chain" artworks={[{ id: "shot-1", kind: "screenshot", selected: false }]} />;
    }
    render(<BackNavigationProvider><Harness /></BackNavigationProvider>);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "스크린샷 크게 보기" }));
    if (input === "mouse") fireEvent.mouseUp(window, { button: 3 });
    else await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(leaveCollection).not.toHaveBeenCalled();
    fireEvent.mouseUp(window, { button: 3 });
    expect(leaveCollection).toHaveBeenCalledOnce();
  });

  it("closes only when the empty backdrop is clicked", async () => {
    const user = userEvent.setup();
    render(<WorkArtworkGallery workTitle="Astral Chain" artworks={[{ id: "shot-1", kind: "screenshot", selected: false }]} />);

    await user.click(screen.getByRole("button", { name: "스크린샷 크게 보기" }));
    const dialog = screen.getByRole("dialog", { name: "Astral Chain 스크린샷 감상" });
    fireEvent.click(screen.getByRole("img", { name: "Astral Chain 스크린샷" }));
    expect(dialog).toBeInTheDocument();

    fireEvent.click(document.querySelector(".manga-cover-viewer__backdrop")!);
    expect(screen.queryByRole("dialog", { name: "Astral Chain 스크린샷 감상" })).not.toBeInTheDocument();
  });
});
