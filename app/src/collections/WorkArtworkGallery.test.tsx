import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { WorkArtworkGallery } from "./WorkArtworkGallery";

afterEach(cleanup);

describe("WorkArtworkGallery", () => {
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