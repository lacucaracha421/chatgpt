import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { BackNavigationProvider, useBackHandler, useBackRequest } from "../shared/navigation/BackNavigation";
import { useDesktopInteractions } from "../app/useDesktopInteractions";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollectionVolume } from "../library/types";
import { MangaCoverViewer, type ViewableCollectionVolume } from "./MangaCoverViewer";

afterEach(cleanup);

const volumes: ViewableCollectionVolume[] = [
  { id: "v1", volumeNumber: 1, editionIndex: 0, displayLabel: "1", coverArtworkId: "art-1", localReleaseDate: null, isbn13: null, releaseStatus: null },
  { id: "v2", volumeNumber: 2, editionIndex: 0, displayLabel: "2", coverArtworkId: "art-2", localReleaseDate: null, isbn13: null, releaseStatus: null },
  { id: "v3", volumeNumber: 3, editionIndex: 0, displayLabel: "3", coverArtworkId: "art-3", localReleaseDate: null, isbn13: null, releaseStatus: null },
] satisfies CollectionVolume[];

describe("MangaCoverViewer", () => {
  it.each(["mouse", "escape"])("closes only the viewer on %s back, then allows leaving the collection", async (input) => {
    const leaveCollection = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(true);
      useDesktopInteractions(useBackRequest());
      useBackHandler(leaveCollection);
      return open ? <MangaCoverViewer workTitle="던전밥" volumes={volumes} activeVolumeId="v1" onActiveVolumeChange={() => undefined} onClose={() => setOpen(false)} /> : <p>권별 표지</p>;
    }
    render(<BackNavigationProvider><Harness /></BackNavigationProvider>);
    if (input === "mouse") fireEvent.mouseUp(window, { button: 3 });
    else await userEvent.setup().keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("권별 표지")).toBeInTheDocument();
    expect(leaveCollection).not.toHaveBeenCalled();
    fireEvent.mouseUp(window, { button: 3 });
    expect(leaveCollection).toHaveBeenCalledOnce();
  });

  it("shows the original cover and supports keyboard navigation and close", async () => {
    const user = userEvent.setup();
    const onActiveVolumeChange = vi.fn();
    const onClose = vi.fn();
    render(
      <MangaCoverViewer
        workTitle="던전밥"
        volumes={volumes}
        activeVolumeId="v2"
        onActiveVolumeChange={onActiveVolumeChange}
        onClose={onClose}
      />,
    );

    expect(screen.getByRole("dialog", { name: "던전밥 2권 표지 감상" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "2권 표지" })).toHaveAttribute(
      "src",
      "http://lakomics.localhost/work-artwork/art-2",
    );
    expect(screen.getByText("2 / 3")).toBeInTheDocument();

    await user.keyboard("{ArrowRight}");
    expect(onActiveVolumeChange).toHaveBeenCalledWith("v3");
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("disables navigation at the first and last covers without wrapping", () => {
    const { rerender } = render(
      <MangaCoverViewer
        workTitle="던전밥"
        volumes={volumes}
        activeVolumeId="v1"
        onActiveVolumeChange={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(screen.getByRole("button", { name: "이전 권" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "다음 권" })).toBeEnabled();

    rerender(
      <MangaCoverViewer
        workTitle="던전밥"
        volumes={volumes}
        activeVolumeId="v3"
        onActiveVolumeChange={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByRole("button", { name: "이전 권" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "다음 권" })).toBeDisabled();
  });

  it("closes from the dimmed backdrop", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <MangaCoverViewer
        workTitle="던전밥"
        volumes={volumes}
        activeVolumeId="v1"
        onActiveVolumeChange={() => undefined}
        onClose={onClose}
      />,
    );

    expect(screen.getByRole("dialog")).toHaveStyle({ pointerEvents: "none" });
    await user.click(document.querySelector<HTMLElement>(".manga-cover-viewer__backdrop")!);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
