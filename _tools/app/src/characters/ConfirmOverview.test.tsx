import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { CharacterTarget } from "./api";
import { ConfirmOverview } from "./ConfirmOverview";
import { confirmSourceFor, shadowItem } from "./confirmTestKit";

// A stand-in for the suggestion cards: its button is the moment a registration or merge has been stored.
vi.mock("./suggestions/CharacterSuggestions", () => ({
  CharacterSuggestionsOverview: ({ onSaved }: { onSaved?: (result: unknown) => void }) => <button type="button" onClick={() => onSaved?.({})}>제안 저장됨</button>,
}));
afterEach(cleanup);

const targets = [
  { id: "hina", seriesClassificationId: "series", displayName: "히나", thumbnailAssetId: null, references: [] },
  { id: "kisaki", seriesClassificationId: "series", displayName: "키사키", thumbnailAssetId: null, references: [] },
] as unknown as CharacterTarget[];

function mount(over: { restricted?: boolean } = {}) {
  const sources = confirmSourceFor({
    tagger: async () => [{ asset: { id: "t1", originalName: "t1.png", width: 1, height: 1 }, seriesId: "series", targetId: "kisaki", targetName: "키사키", targetFingerprint: "fp",
      evidence: { source: "tagger", reason: "veto", pixaiScore: 0.1, canaryScore: 0.1 } }] as never,
    candidates: [shadowItem("c1", "hina", "히나"), shadowItem("c2", "hina", "히나"), shadowItem("c3", "kisaki", "키사키")],
    doubtful: [shadowItem("d1", "hina", "히나", { verdict: "none" })],
  });
  const onOpen = vi.fn(), onBack = vi.fn();
  render(<ConfirmOverview sources={sources} targets={targets} seriesName={id => id === "series" ? "백합" : undefined} version={0} restricted={over.restricted ?? false} privacyMode={false} onBack={onBack} onOpen={onOpen} />);
  return { sources, onOpen, onBack };
}

it("counts every kind per series and character and opens the list for each scope", async () => {
  const { onOpen } = mount();
  const user = userEvent.setup();
  const series = await screen.findByRole("region", { name: "백합" });
  expect(series).toHaveTextContent("5건");
  expect(series).toHaveTextContent("인식 추천 3 · 다시 확인 2");
  const hina = within(series).getByRole("button", { name: "백합 › 히나 확인 3건" });
  expect(hina).toHaveTextContent("인식 추천 2 · 다시 확인 1");
  expect(within(series).getByRole("button", { name: "백합 › 키사키 확인 2건" })).toHaveTextContent("인식 추천 1 · 다시 확인 1");
  await user.click(hina);
  expect(onOpen).toHaveBeenLastCalledWith({ series: { id: "series", name: "백합" }, target: { id: "hina", name: "히나" } });
  await user.click(within(series).getByRole("button", { name: "백합 전체 확인 5건" }));
  expect(onOpen).toHaveBeenLastCalledWith({ series: { id: "series", name: "백합" } });
  await user.click(screen.getByRole("button", { name: "전체 확인" }));
  expect(onOpen).toHaveBeenLastCalledWith({});
});

it("skips the full read in lightweight mode and still offers the whole list", async () => {
  const { sources, onOpen } = mount({ restricted: true });
  expect(await screen.findByText(/에서는 확인 목록 전체를 읽지 않아/)).toBeInTheDocument();
  expect(sources.tagger).not.toHaveBeenCalled();
  await userEvent.setup().click(screen.getByRole("button", { name: "전체 확인" }));
  expect(onOpen).toHaveBeenCalledWith({});
});

it("goes back from the toolbar", async () => {
  const { onBack } = mount();
  await userEvent.setup().click(await screen.findByRole("button", { name: "홈으로 돌아가기" }));
  expect(onBack).toHaveBeenCalled();
});

it("reads the list again when a suggestion is registered, so its tag-read images show without leaving", async () => {
  const added: unknown[] = [];
  const sources = confirmSourceFor({
    tagger: async () => [...added] as never,
    candidates: [shadowItem("c1", "hina", "히나")],
    doubtful: [],
  });
  render(<ConfirmOverview sources={sources} targets={targets} seriesName={id => id === "series" ? "백합" : undefined} version={0} restricted={false} privacyMode={false} onBack={vi.fn()} onOpen={vi.fn()} />);
  const series = await screen.findByRole("region", { name: "백합" });
  expect(series).toHaveTextContent("1건");
  expect(within(series).queryByRole("button", { name: /키사키/ })).toBeNull();
  // Registering 키사키 stores her tag-read images as 태그 추천; the overview has to ask for them.
  added.push({ asset: { id: "t1", originalName: "t1.png", width: 1, height: 1 }, seriesId: "series", targetId: "kisaki", targetName: "키사키", targetFingerprint: "fp",
    evidence: { source: "tagger", reason: "recommendation", pixaiScore: 0.99, canaryScore: 0.99 } });
  await userEvent.setup().click(screen.getByRole("button", { name: "제안 저장됨" }));
  expect(await within(await screen.findByRole("region", { name: "백합" })).findByRole("button", { name: "백합 › 키사키 확인 1건" })).toHaveTextContent("태그 추천 1");
});
