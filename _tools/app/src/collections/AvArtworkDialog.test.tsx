import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { open } from "@tauri-apps/plugin-dialog";
import { AvArtworkDialog } from "./AvArtworkDialog";
import type { AvCoverSet, AvGateway } from "./avTypes";
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const covers: AvCoverSet = { frontId: "front", spineId: null, backId: "back", revision: "r1" };
it("previews an explicit surface and applies only the selected decisions", async () => {
  const user = userEvent.setup(), applyArtwork = vi.fn().mockResolvedValue(covers), previewArtwork = vi.fn().mockResolvedValue({ sha256: "hash", thumbnailDataUrl: "data:image/png;base64,AA==" });
  vi.mocked(open).mockResolvedValue("C:/selected.png");
  render(<AvArtworkDialog collectionId="av" covers={covers} api={{ applyArtwork, previewArtwork } as unknown as AvGateway} onClose={vi.fn()} onSaved={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "책등 파일 선택" }));
  expect(previewArtwork).toHaveBeenCalledWith("C:/selected.png", "spine");
  await user.click(within(screen.getByRole("region", { name: "뒷면" })).getByRole("button", { name: "선택 해제" }));
  await user.click(screen.getByRole("button", { name: "적용" }));
  expect(applyArtwork).toHaveBeenCalledWith("av", { expectedRevision: "r1", front: { kind: "keep" }, spine: { kind: "local", path: "C:/selected.png", sha256: "hash" }, back: { kind: "clear" } });
});
it("canceling a native picker does not apply or preview any image", async () => {
  const user = userEvent.setup(), applyArtwork = vi.fn(), previewArtwork = vi.fn(), close = vi.fn();
  vi.mocked(open).mockResolvedValue(null);
  render(<AvArtworkDialog collectionId="av" covers={covers} api={{ applyArtwork, previewArtwork } as unknown as AvGateway} onClose={close} onSaved={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "앞면 파일 선택" }));
  await user.click(screen.getByRole("button", { name: "취소" }));
  expect(applyArtwork).not.toHaveBeenCalled(); expect(previewArtwork).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
});
