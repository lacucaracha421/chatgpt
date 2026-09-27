import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PrivacyProvider } from "../../privacy/PrivacyContext";
import type { AvGateway } from "../avTypes";
import { AvPortraitPicker } from "./AvPortraitPicker";

afterEach(cleanup);

const source = { collectionId: "av-1", name: "작품", productCode: "CODE-1", artworkId: "front-1", revision: "r1", solo: true, width: 703, height: 1000 };
function api() {
  return { listPortraitSources: vi.fn().mockResolvedValue([source]), setPortraitCrop: vi.fn().mockResolvedValue({ kind: "crop", artworkId: source.artworkId, revision: source.revision, rect: { x: .2, y: .1, w: .5, h: .7 } }), previewCommonsPortrait: vi.fn().mockResolvedValue(null), useCommonsPortrait: vi.fn(), clearPortrait: vi.fn() } as unknown as AvGateway;
}

it("saves the selected cover crop rectangle", async () => {
  const client = api();
  render(<PrivacyProvider privacyMode={false} setPrivacyMode={vi.fn()}><AvPortraitPicker personId="person-1" personName="배우" api={client} onClose={vi.fn()} onSaved={vi.fn()} /></PrivacyProvider>);
  await screen.findByRole("button", { name: /CODE-1 표지/ });
  await fireEvent.click(screen.getByRole("slider", { name: "초상화 자르기 영역" }));
  await fireEvent.click(screen.getByRole("button", { name: "대표 이미지로 쓰기" }));
  await waitFor(() => expect(client.setPortraitCrop).toHaveBeenCalledWith("person-1", "front-1", expect.objectContaining({ x: expect.any(Number), y: expect.any(Number), w: expect.any(Number), h: expect.any(Number) })));
});

it("shows the empty Commons state", async () => {
  const client = api();
  render(<PrivacyProvider privacyMode={false} setPrivacyMode={vi.fn()}><AvPortraitPicker personId="person-1" personName="배우" api={client} onClose={vi.fn()} onSaved={vi.fn()} /></PrivacyProvider>);
  await screen.findByRole("button", { name: /CODE-1 표지/ });
  fireEvent.click(screen.getByRole("button", { name: /위키미디어 공용/ }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("위키미디어 공용 사진이 없습니다"));
  expect(client.previewCommonsPortrait).toHaveBeenCalledWith("person-1");
});
