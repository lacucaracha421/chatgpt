import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { ClassificationEntry, LibraryGateway } from "../library/types";
import { ClassificationAppearanceDialog } from "./ClassificationAppearanceDialog";

const entry: ClassificationEntry = {
  id: "folder-1",
  kind: "tag",
  name: "캐릭터",
  parentId: null,
  iconKey: "star",
  colorKey: "blue",
};

afterEach(cleanup);

function setup(update = vi.fn().mockResolvedValue(undefined)) {
  const gateway = { updateClassificationAppearance: update } as unknown as LibraryGateway;
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(
    <LibraryProvider gateway={gateway}>
      <ClassificationAppearanceDialog entry={{ ...entry, scope: "classification" }} onClose={onClose} onSaved={onSaved} />
    </LibraryProvider>,
  );
  return { update, onClose, onSaved };
}

describe("ClassificationAppearanceDialog", () => {
  it("saves album appearance through the album command", async () => {
    const user = userEvent.setup();
    const updateAlbumAppearance = vi.fn().mockResolvedValue(undefined);
    const gateway = { updateAlbumAppearance } as unknown as LibraryGateway;
    render(
      <LibraryProvider gateway={gateway}>
        <ClassificationAppearanceDialog entry={{ ...entry, scope: "album" }} onClose={vi.fn()} onSaved={vi.fn()} />
      </LibraryProvider>,
    );

    await user.click(screen.getByRole("button", { name: "저장" }));
    expect(updateAlbumAppearance).toHaveBeenCalledWith("folder-1", "star", "blue");
  });

  it("shows the current selection and preview", () => {
    setup();

    expect(screen.getByRole("radio", { name: "별" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "파랑" })).toBeChecked();
    expect(screen.getByTestId("classification-appearance-preview")).toHaveTextContent("캐릭터");
    expect(screen.getByTestId("classification-icon")).toHaveAttribute("data-icon-key", "star");
  });

  it("saves the selected icon and color", async () => {
    const user = userEvent.setup();
    const { update, onSaved } = setup();

    await user.click(screen.getByRole("radio", { name: "사진" }));
    await user.click(screen.getByRole("radio", { name: "분홍" }));
    await user.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(update).toHaveBeenCalledWith("folder-1", "photo", "pink"));
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it("keeps reset as a draft until save", async () => {
    const user = userEvent.setup();
    const { update } = setup();

    await user.click(screen.getByRole("button", { name: "기본값으로 초기화" }));
    expect(update).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(update).toHaveBeenCalledWith("folder-1", null, null));
  });

  it("discards draft changes when cancelled", async () => {
    const user = userEvent.setup();
    const { update, onClose } = setup();

    await user.click(screen.getByRole("button", { name: "기본값으로 초기화" }));
    await user.click(screen.getByRole("button", { name: "취소" }));

    expect(update).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("stays open and reports a rejected save", async () => {
    const user = userEvent.setup();
    const { onSaved } = setup(vi.fn().mockRejectedValue(new Error("저장 거부")));

    await user.click(screen.getByRole("button", { name: "저장" }));

    expect(await screen.findByText("저장 거부")).toBeVisible();
    expect(screen.getByRole("dialog", { name: "아이콘 및 색상" })).toBeVisible();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
