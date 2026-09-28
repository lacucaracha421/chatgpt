import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PrivacyProvider } from "../../privacy/PrivacyContext";
import type { AvGateway } from "../avTypes";
import { AvPortraitPicker } from "./AvPortraitPicker";

afterEach(cleanup);

const source = { collectionId: "av-1", name: "작품", productCode: "CODE-1", artworkId: "front-1", revision: "r1", solo: true, width: 703, height: 1000 };
function api() {
  return { getStashdbCredentialStatus: vi.fn().mockResolvedValue({ configured: true }), getPerformerProfile: vi.fn().mockResolvedValue(null), listPortraitSources: vi.fn().mockResolvedValue([source]), setPortraitCrop: vi.fn().mockResolvedValue({ kind: "crop", artworkId: source.artworkId, revision: source.revision, rect: { x: .2, y: .1, w: .5, h: .7 } }), previewCommonsPortrait: vi.fn().mockResolvedValue(null), useCommonsPortrait: vi.fn(), clearPortrait: vi.fn() } as unknown as AvGateway;
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


it("previews and saves a StashDB photo, with direct thumbnails and original dimensions", async () => {
  const client = api();
  vi.mocked(client.getPerformerProfile).mockResolvedValue({ status: "matched", images: [{ id: "photo", url: "https://stashdb.org/images/photo", width: 3000, height: 4500 }] } as never);
  client.previewStashdbPortrait = vi.fn().mockResolvedValue({ dataUrl: "data:image/jpeg;base64,preview", width: 1067, height: 1600, sourceUrl: "https://stashdb.org/images/photo" });
  client.useStashdbPortrait = vi.fn().mockResolvedValue({ kind: "stashdb", dataUrl: "data:image/jpeg;base64,preview", width: 1067, height: 1600, sourceUrl: "https://stashdb.org/images/photo" });
  const saved = vi.fn();
  render(<PrivacyProvider privacyMode={false} setPrivacyMode={vi.fn()}><AvPortraitPicker personId="person-1" personName="배우" api={client} onClose={vi.fn()} onSaved={saved} /></PrivacyProvider>);
  await screen.findByRole("button", { name: /StashDB 1장/ });
  fireEvent.click(screen.getByRole("button", { name: /StashDB 1장/ }));
  const thumbnail = screen.getByRole("button", { name: "StashDB 사진 3000×4500 photo" });
  expect(thumbnail.querySelector("img")).toHaveAttribute("src", "https://stashdb.org/images/photo");
  expect(screen.getByRole("button", { name: "이 사진으로" })).toBeDisabled();
  fireEvent.click(thumbnail);
  await waitFor(() => expect(screen.getByRole("button", { name: "이 사진으로" })).toBeEnabled());
  expect(client.previewStashdbPortrait).toHaveBeenCalledWith("person-1", "photo");
  expect(screen.getByText("1067×1600 · StashDB")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "이 사진으로" }));
  await waitFor(() => expect(saved).toHaveBeenCalledWith(expect.objectContaining({ kind: "stashdb" })));
});

it("shows the unlinked StashDB state", async () => {
  render(<PrivacyProvider privacyMode={false} setPrivacyMode={vi.fn()}><AvPortraitPicker personId="person-1" personName="배우" api={api()} onClose={vi.fn()} onSaved={vi.fn()} /></PrivacyProvider>);
  fireEvent.click(screen.getByRole("button", { name: /StashDB/ }));
  expect(await screen.findByText("StashDB 프로필이 연결되면 사진을 고를 수 있어요")).toBeVisible();
});

it("hides StashDB thumbnails and preview images in privacy mode", async () => {
  const client = api();
  vi.mocked(client.getPerformerProfile).mockResolvedValue({ status: "matched", images: [{ id: "photo", url: "https://stashdb.org/images/photo", width: 3000, height: 4500 }] } as never);
  client.previewStashdbPortrait = vi.fn().mockResolvedValue({ dataUrl: "data:image/jpeg;base64,preview", width: 1067, height: 1600, sourceUrl: "https://stashdb.org/images/photo" });
  const { container } = render(<PrivacyProvider privacyMode setPrivacyMode={vi.fn()}><AvPortraitPicker personId="person-1" personName="배우" api={client} onClose={vi.fn()} onSaved={vi.fn()} /></PrivacyProvider>);
  fireEvent.click(await screen.findByRole("button", { name: /StashDB 1장/ }));
  fireEvent.click(screen.getByRole("button", { name: "StashDB 사진 3000×4500 photo" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "이 사진으로" })).toBeEnabled());
  expect(container.ownerDocument.querySelectorAll(".av-portrait-picker img")).toHaveLength(0);
});

it("does not load stored StashDB photos when the API key is absent", async () => {
  const client = api();
  vi.mocked(client.getStashdbCredentialStatus).mockResolvedValue({ configured: false });
  vi.mocked(client.getPerformerProfile).mockResolvedValue({ status: "matched", images: [{ id: "photo", url: "https://stashdb.org/images/photo", width: 100, height: 150 }] } as never);
  client.previewStashdbPortrait = vi.fn();
  render(<PrivacyProvider privacyMode={false} setPrivacyMode={vi.fn()}><AvPortraitPicker personId="person-1" personName="배우" api={client} onClose={vi.fn()} onSaved={vi.fn()} /></PrivacyProvider>);
  fireEvent.click(screen.getByRole("button", { name: /StashDB/ }));
  expect(await screen.findByText("StashDB 키가 없어요. 설정에서 키를 등록해 주세요.")).toBeVisible();
  expect(screen.queryByRole("button", { name: /StashDB 사진/ })).toBeNull();
  expect(client.previewStashdbPortrait).not.toHaveBeenCalled();
});

it("ignores an older preview response and permits retrying the same image", async () => {
  const client = api();
  vi.mocked(client.getPerformerProfile).mockResolvedValue({ status: "matched", images: [
    { id: "first", url: "https://stashdb.org/images/first", width: 100, height: 150 },
    { id: "second", url: "https://stashdb.org/images/second", width: 200, height: 300 },
  ] } as never);
  let old!: (value: { dataUrl: string; width: number; height: number; sourceUrl: string }) => void;
  client.previewStashdbPortrait = vi.fn().mockImplementation((_person, id) => id === "first" ? new Promise(resolve => { old = resolve; }) : Promise.resolve({ dataUrl: "data:image/jpeg;base64,new", width: 200, height: 300, sourceUrl: "https://stashdb.org/images/second" }));
  render(<PrivacyProvider privacyMode={false} setPrivacyMode={vi.fn()}><AvPortraitPicker personId="person-1" personName="배우" api={client} onClose={vi.fn()} onSaved={vi.fn()} /></PrivacyProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "StashDB 2장" }));
  fireEvent.click(screen.getByRole("button", { name: "StashDB 사진 100×150 first" }));
  await waitFor(() => expect(client.previewStashdbPortrait).toHaveBeenCalledWith("person-1", "first"));
  fireEvent.click(screen.getByRole("button", { name: "StashDB 사진 200×300 second" }));
  await screen.findByText("200×300 · StashDB");
  old({ dataUrl: "data:image/jpeg;base64,old", width: 100, height: 150, sourceUrl: "https://stashdb.org/images/first" });
  await waitFor(() => expect(screen.getByText("200×300 · StashDB")).toBeVisible());
  expect(screen.queryByText("100×150 · StashDB")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "StashDB 사진 200×300 second" }));
  await waitFor(() => expect(client.previewStashdbPortrait).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(screen.getByRole("button", { name: "이 사진으로" })).toBeEnabled());
});
