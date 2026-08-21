import { cleanup, render, screen } from "@testing-library/react";
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
