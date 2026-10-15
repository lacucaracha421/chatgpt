import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { CharacterTarget } from "./api";
import { ConfirmOverview } from "./ConfirmOverview";
import { confirmSourceFor, shadowItem } from "./confirmTestKit";
import type { TaggerReviewItem } from "./taggerReviewClient";
import { ChromeTarget, WorkspaceChromeProvider } from "../layout/WorkspaceChrome";

// A stand-in for the suggestion cards: its button is the moment a registration or merge has been stored.
vi.mock("./suggestions/CharacterSuggestions", () => ({
  CharacterSuggestionsOverview: ({ onSaved }: { onSaved?: (result: unknown) => void }) => <button type="button" onClick={() => onSaved?.({})}>제안 저장됨</button>,
}));
afterEach(() => { cleanup(); vi.useRealTimers(); });

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

it("keeps old tallies on screen during a slow refresh and updates them silently", async () => {
  const sources = confirmSourceFor({ candidates: [shadowItem("c1", "hina", "히나")] });
  const tree = (version: number) => <ConfirmOverview sources={sources} targets={targets} seriesName={() => "백합"} version={version} restricted={false} privacyMode={false} onBack={vi.fn()} onOpen={vi.fn()} />;
  const view = render(tree(0));
  const row = await screen.findByRole("button", { name: "백합 › 히나 확인 1건" });
  vi.useFakeTimers();
  let finish!: (rows: TaggerReviewItem[]) => void;
  sources.tagger.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  view.rerender(tree(1));
  await act(async () => { vi.advanceTimersByTime(1200); });
  expect(row).toBeInTheDocument();
  expect(screen.queryByText(/다시 세는 중|확인 목록 읽는 중/)).toBeNull();
  await act(async () => finish([{ asset: { id: "t1", originalName: "t1.png", width: 1, height: 1 }, seriesId: "series", targetId: "hina", targetName: "히나", targetFingerprint: "fp", evidence: { source: "tagger", reason: "recommendation", pixaiScore: 0.99, canaryScore: 0.99 } }] as TaggerReviewItem[]));
  expect(screen.getByRole("button", { name: "백합 › 히나 확인 2건" })).toBe(row);
  expect(screen.queryByRole("status")).toBeNull();
});

it("shows the first-read label only after 400 ms and silently refreshes a known empty tally", async () => {
  vi.useFakeTimers();
  const sources = confirmSourceFor();
  let finish!: (rows: TaggerReviewItem[]) => void;
  sources.tagger.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const tree = (version: number) => <ConfirmOverview sources={sources} targets={targets} seriesName={() => "백합"} version={version} restricted={false} privacyMode={false} onBack={vi.fn()} onOpen={vi.fn()} />;
  const view = render(tree(0));
  await act(async () => { vi.advanceTimersByTime(399); });
  expect(screen.queryByText("확인 목록 읽는 중")).toBeNull();
  await act(async () => { vi.advanceTimersByTime(1); });
  expect(screen.getByText("확인 목록 읽는 중")).toBeInTheDocument();
  await act(async () => finish([]));
  await act(async () => { vi.advanceTimersByTime(500); });
  view.rerender(tree(1));
  await act(async () => { vi.advanceTimersByTime(1200); });
  expect(screen.getByText("확인할 항목이 없습니다.")).toBeInTheDocument();
  expect(screen.queryByText(/다시 세는 중|확인 목록 읽는 중/)).toBeNull();
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

it("moves folded characters to one bottom section, keeps counted totals, and toggles and opens their rows", async () => {
  const sources = confirmSourceFor({
    candidates: [shadowItem("c1", "hina", "히나"), shadowItem("f1", "kisaki", "키사키", { folded: true }), shadowItem("f2", "kisaki", "키사키", { folded: true })],
    doubtful: [],
  });
  const onOpen = vi.fn();
  render(<ConfirmOverview sources={sources} targets={targets} seriesName={id => id === "series" ? "백합" : undefined} version={0} restricted={false} privacyMode={false} onBack={vi.fn()} onOpen={onOpen} />);
  const user = userEvent.setup();
  const series = await screen.findByRole("region", { name: "백합" });
  expect(series).toHaveTextContent("1건");
  expect(within(series).queryByRole("button", { name: /키사키/ })).toBeNull();
  expect(within(series).queryByRole("button", { name: /더 보기/ })).toBeNull();
  expect(screen.queryByText("확인할 항목이 없습니다.")).toBeNull();
  const learning = screen.getByRole("region", { name: "배우는 중인 캐릭터" });
  expect(learning).toBe(learning.parentElement?.lastElementChild);
  const toggle = within(learning).getByRole("button", { name: "배우는 중인 캐릭터 1명" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(within(learning).queryByRole("button", { name: /키사키/ })).toBeNull();
  await user.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  const folded = within(learning).getByRole("button", { name: "백합 › 키사키 확인 2건" });
  await user.click(folded);
  expect(onOpen).toHaveBeenLastCalledWith({ series: { id: "series", name: "백합" }, target: { id: "kisaki", name: "키사키" } });
  // The series total and the whole list leave the folded ones out.
  expect(screen.getByRole("button", { name: "백합 전체 확인 1건" })).toBeInTheDocument();
  await user.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(within(learning).queryByRole("button", { name: /키사키/ })).toBeNull();
  expect(learning.querySelector(".ui-fold")).toHaveAttribute("inert");
});

it("omits zero-count series from the main list and shows the empty notice above the folded section", async () => {
  const sources = confirmSourceFor({ candidates: [shadowItem("f1", "kisaki", "키사키", { folded: true })], doubtful: [] });
  render(<ConfirmOverview sources={sources} targets={targets} seriesName={id => id === "series" ? "백합" : undefined} version={0} restricted={false} privacyMode={false} onBack={vi.fn()} onOpen={vi.fn()} />);
  const learning = await screen.findByRole("region", { name: "배우는 중인 캐릭터" });
  expect(screen.getByText("확인할 항목이 없습니다.")).toBeInTheDocument();
  expect(document.querySelector(".crv-groups .crv-group")).toBeNull();
  expect(screen.queryByRole("region", { name: "백합" })).toBeNull();
  expect(screen.queryByRole("button", { name: "전체 확인" })).toBeNull();
  await userEvent.setup().click(within(learning).getByRole("button", { name: "배우는 중인 캐릭터 1명" }));
  expect(within(learning).getByRole("button", { name: "백합 › 키사키 확인 1건" })).toBeInTheDocument();
});

it("groups folded characters from every series at the bottom and preserves expansion across filtering and refresh", async () => {
  const allTargets = [...targets, { ...targets[1], id: "aru", seriesClassificationId: "other", displayName: "아루" }];
  const sources = confirmSourceFor({ candidates: [
    shadowItem("c1", "hina", "히나"),
    shadowItem("f1", "kisaki", "키사키", { folded: true }),
    shadowItem("f2", "aru", "아루", { folded: true }),
  ] });
  const tree = (version: number) => <WorkspaceChromeProvider scope="confirm"><ChromeTarget name="navigation" />
    <ConfirmOverview sources={sources} targets={allTargets} seriesName={id => id === "series" ? "백합" : "다른 시리즈"}
      version={version} restricted={false} privacyMode={false} onBack={vi.fn()} onOpen={vi.fn()} />
  </WorkspaceChromeProvider>;
  const view = render(tree(0));
  const learning = await screen.findByRole("region", { name: "배우는 중인 캐릭터" });
  const user = userEvent.setup();
  const toggle = within(learning).getByRole("button", { name: "배우는 중인 캐릭터 2명" });
  expect(document.querySelectorAll(".crv-groups .crv-group")).toHaveLength(1);
  expect(within(screen.getByRole("navigation", { name: "확인 시리즈" })).queryByRole("button", { name: /다른 시리즈/ })).toBeNull();
  await user.click(toggle);
  const first = within(learning).getByRole("region", { name: "백합" });
  const second = within(learning).getByRole("region", { name: "다른 시리즈" });
  expect(within(first).getByRole("heading", { name: "백합" })).toBeInTheDocument();
  expect(within(first).getByRole("button", { name: "백합 › 키사키 확인 1건" })).toBeInTheDocument();
  expect(within(second).getByRole("heading", { name: "다른 시리즈" })).toBeInTheDocument();
  expect(within(second).getByRole("button", { name: "다른 시리즈 › 아루 확인 1건" })).toBeInTheDocument();
  await user.click(within(screen.getByRole("navigation", { name: "확인 시리즈" })).getByRole("button", { name: /^백합\s*1$/ }));
  view.rerender(tree(1));
  await act(async () => {});
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(within(second).getByRole("button", { name: "다른 시리즈 › 아루 확인 1건" })).toBeInTheDocument();
});
