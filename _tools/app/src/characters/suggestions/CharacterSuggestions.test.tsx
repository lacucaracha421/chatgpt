import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLayoutEffect } from "react";
import { CharacterSuggestionsOverview, CharacterSuggestionTile, useCharacterSuggestions, type SuggestionState } from "./CharacterSuggestions";
import { readFileSync } from "node:fs";
import { SuggestionDialog } from "./SuggestionDialog";
import { suggestionName, type Suggestion, type SuggestionApi, type SuggestionDetail } from "./client";
import type { CharacterTarget } from "../api";
import type { ClassificationEntry } from "../../library/types";

const suggestion: Suggestion = { tag: "isolde_(reverse:1999)", imageCount: 8, bothCount: 6, pixaiCount: 8, canaryCount: 6, sampleAssetIds: ["a0", "a1", "a2", "a3"], seriesId: "series", seriesName: "리버스", insideCount: 7 };

it("dims the suggestion collage on its first render and throughout late image fades", () => {
  const style = document.createElement("style"); style.textContent = readFileSync("src/characters/suggestions/CharacterSuggestions.css", "utf8"); document.head.append(style);
  try {
    const view = render(<CharacterSuggestionTile suggestion={suggestion} state={{ busy: false, api: api() } as SuggestionState} privacyMode={false} onChanged={() => undefined} />);
    const mosaic = view.container.querySelector<HTMLElement>(".character-suggestion-tile__mosaic")!;
    expect(mosaic).toHaveClass("character-suggestion-tile__mosaic--suggestion");
    expect(getComputedStyle(mosaic).opacity).toBe("0.55");
    expect(getComputedStyle(mosaic).filter).toBe("saturate(.55)");
    for (const image of mosaic.querySelectorAll("img")) {
      image.animate = vi.fn(); fireEvent.load(image);
      expect(getComputedStyle(mosaic).opacity).toBe("0.55");
    }
  } finally { style.remove(); }
});
const target: CharacterTarget = { id: "existing", displayName: "기존 캐릭터", seriesClassificationId: "series", linkedClassificationId: null, enabled: true, manualOnly: false, ready: false, references: [], revision: 2, fingerprint: "fingerprint" };
const detail: SuggestionDetail = { previewToken: "snapshot", referenceIds: ["a4", "a0", "a1", "a2", "a3"], images: Array.from({ length: 8 }, (_, i) => ({ assetId: `a${i}`, assetHash: `h${i}`, pixaiScore: .99 - i * .01, canaryScore: i < 6 ? .9 : .2, insideSeries: i < 7, solo: i === 4 || i === 6 })) };
const folders = [{ id: "series", parentId: null, name: "리버스", kind: "root", assetCount: 8, iconKey: null, colorKey: null }] as ClassificationEntry[];
const api = (): SuggestionApi => ({ list: vi.fn().mockResolvedValue([suggestion]), detail: vi.fn().mockResolvedValue(detail), ignored: vi.fn().mockResolvedValue([]), ignore: vi.fn().mockResolvedValue(undefined), register: vi.fn().mockResolvedValue({ target, queuedCount: 3 }), merge: vi.fn().mockResolvedValue({ target, queuedCount: 8 }), context: vi.fn().mockResolvedValue({ targets: [target], folders }), groups: vi.fn().mockResolvedValue([]) });
const dialog = (client: SuggestionApi, mode: "register" | "merge" = "register", row = suggestion, onSaved = vi.fn()) => render(<SuggestionDialog suggestion={row} mode={mode} privacyMode={false} api={client} onClose={vi.fn()} onSaved={onSaved} />);

afterEach(cleanup);

it("marks changed suggestion requests loading on the first committed render", async () => {
  const client = api(), reads: boolean[] = [];
  function Probe({ version }: { version: number }) {
    const state = useCharacterSuggestions(version, client);
    useLayoutEffect(() => { reads.push(state.loading); });
    return <span>{state.loading ? "loading" : "ready"}</span>;
  }
  const view = render(<Probe version={0} />);
  await screen.findByText("ready");
  vi.mocked(client.list).mockReturnValue(new Promise(() => undefined));
  reads.length = 0;
  view.rerender(<Probe version={1} />);
  expect(reads[0]).toBe(true);
  expect(screen.getByText("loading")).toBeInTheDocument();
});

it("shares pending suggestions across mounts and never publishes an older revision over a newer one", async () => {
  const client = api();
  let finishOld!: (rows: Suggestion[]) => void;
  vi.mocked(client.list).mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
  const tree = (version: number) => <CharacterSuggestionsOverview version={version} privacyMode={false} api={client} />;
  const first = render(tree(0));
  first.unmount();
  const second = render(tree(0));
  expect(client.list).toHaveBeenCalledTimes(1);
  vi.mocked(client.list).mockResolvedValue([{ ...suggestion, tag: "current_suggestion" }]);
  second.rerender(tree(1));
  await screen.findByText("current suggestion");
  finishOld([suggestion]);
  await waitFor(() => expect(screen.queryByText("이졸데")).not.toBeInTheDocument());
  second.unmount();
  render(tree(1));
  expect(screen.getByText("current suggestion")).toBeInTheDocument();
  expect(client.list).toHaveBeenCalledTimes(2);
});

it("keeps a dismissed suggestion dismissed after a remount at the same data revision", async () => {
  const client = api();
  const tree = () => <CharacterSuggestionsOverview version={0} privacyMode={false} api={client} />;
  const first = render(tree());
  await screen.findByText("이졸데");
  vi.mocked(client.list).mockResolvedValue([]);
  vi.mocked(client.ignored).mockResolvedValue([{ tag: suggestion.tag, ignoredAt: "now" }]);
  fireEvent.click(screen.getByRole("button", { name: "무시" }));
  await screen.findByRole("button", { name: "무시 목록 1" });
  first.unmount();
  render(tree());
  expect(screen.queryByText("이졸데")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "무시 목록 1" })).toBeInTheDocument();
  expect(client.list).toHaveBeenCalledTimes(2);
});

it("keeps a registered suggestion retired after refreshing and remounting", async () => {
  const client = api();
  vi.mocked(client.register).mockImplementation(async () => {
    vi.mocked(client.list).mockResolvedValue([]);
    return { target, queuedCount: 3 };
  });
  const tree = () => <CharacterSuggestionsOverview version={0} privacyMode={false} api={client} />;
  const first = render(tree());
  await screen.findByText("이졸데");
  fireEvent.click(screen.getByRole("button", { name: "등록" }));
  const create = await screen.findByRole("button", { name: "캐릭터 만들기" });
  await waitFor(() => expect(create).toBeEnabled());
  fireEvent.click(create);
  await screen.findByText("조건에 맞는 새 캐릭터 제안이 없습니다.");
  expect(client.register).toHaveBeenCalledWith(expect.objectContaining({ tag: suggestion.tag, linkTag: true }));
  first.unmount();
  render(tree());
  expect(screen.queryByText("이졸데")).not.toBeInTheDocument();
  expect(client.list).toHaveBeenCalledTimes(2);
});

describe("character suggestions", () => {
  it("ships reviewed Korean names and humanises unknown qualifiers", () => {
    expect(suggestionName(suggestion.tag)).toBe("이졸데");
    expect(suggestionName("unknown_person_(a_series)")).toBe("unknown person (a series)");
  });
  it("shows groups, one-tagger markers and filters with five images by default", async () => {
    const client = api();
    vi.mocked(client.list).mockResolvedValue([suggestion, { ...suggestion, tag: "canary_character", seriesId: null, seriesName: null, bothCount: 0, pixaiCount: 0, canaryCount: 8, insideCount: 0 }]);
    render(<CharacterSuggestionsOverview version={0} privacyMode={false} api={client} />);
    expect(await screen.findByText("이졸데")).toBeInTheDocument();
    expect(client.list).toHaveBeenCalledWith(5);
    expect(screen.getByText("○ canary만 8")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "시리즈 폴더 없음" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "시리즈 폴더 안에 있는 것만" }));
    expect(screen.queryByText("canary character")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "시리즈 폴더 안에 있는 것만" }));
    fireEvent.change(screen.getByRole("combobox", { name: "최소 이미지 수" }), { target: { value: "10" } });
    await waitFor(() => expect(client.list).toHaveBeenLastCalledWith(10));
    fireEvent.change(screen.getByRole("combobox", { name: "최소 이미지 수" }), { target: { value: "5" } });
  });
  it("ignores permanently through the API and restores from the undo list", async () => {
    const client = api();
    render(<CharacterSuggestionsOverview version={0} privacyMode={false} api={client} />);
    await screen.findByText("이졸데");
    vi.mocked(client.list).mockResolvedValue([]);
    vi.mocked(client.ignored).mockResolvedValue([{ tag: suggestion.tag, ignoredAt: "now" }]);
    fireEvent.click(screen.getByRole("button", { name: "무시" }));
    await waitFor(() => expect(client.ignore).toHaveBeenCalledWith(suggestion.tag, true));
    fireEvent.click(await screen.findByRole("button", { name: "무시 목록 1" }));
    vi.mocked(client.list).mockResolvedValue([suggestion]); vi.mocked(client.ignored).mockResolvedValue([]);
    fireEvent.click(screen.getByRole("button", { name: "되돌리기" }));
    await waitFor(() => expect(client.ignore).toHaveBeenCalledWith(suggestion.tag, false));
    expect(await screen.findByText("무시한 제안이 없습니다.")).toBeInTheDocument();
  });
  it("opens the shared registration dialog from the overview", async () => {
    render(<CharacterSuggestionsOverview version={0} privacyMode={false} api={api()} />);
    fireEvent.click(await screen.findByRole("button", { name: "등록" }));
    expect(await screen.findByRole("dialog", { name: "새 캐릭터 등록" })).toBeInTheDocument();
    expect(await screen.findByDisplayValue("이졸데")).toBeInTheDocument();
  });
  it("preselects five inside references and submits the edited selection with all others queued", async () => {
    const client = api(), onSaved = vi.fn(); dialog(client, "register", suggestion, onSaved);
    await screen.findByRole("button", { name: "a0 크게 보기" });
    const refs = screen.getByRole("group", { name: "참조 이미지" });
    expect(within(refs).getAllByRole("button")[0]).toHaveAccessibleName("a4 크게 보기");
    expect(within(refs).getAllByLabelText(/빈 참조 슬롯/)).toHaveLength(3);
    expect(within(refs).getByText("단독")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /a7/ })).not.toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "참조 바꾸기" })).getAllByRole("button")[0]).toHaveAccessibleName("a6 크게 보기");
    expect(screen.getByRole("checkbox", { name: "태그를 이 캐릭터에 연결" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "시리즈 폴더 밖 이미지도 후보로" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "a0 크게 보기" }));
    fireEvent.click(screen.getByRole("button", { name: "참조에서 제거" }));
    fireEvent.click(screen.getByRole("button", { name: "미리보기 닫기" }));
    expect(screen.getByText("참조 5장 미만: 수동 관리로 시작해요.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "a5 크게 보기" }));
    fireEvent.click(screen.getByRole("button", { name: "참조로" }));
    fireEvent.click(screen.getByRole("button", { name: "미리보기 닫기" }));
    fireEvent.change(screen.getByLabelText("이름"), { target: { value: "수정한 이름" } });
    fireEvent.click(screen.getByRole("button", { name: "캐릭터 만들기" }));
    await waitFor(() => expect(client.register).toHaveBeenCalledWith(expect.objectContaining({ displayName: "수정한 이름", referenceIds: ["a4", "a1", "a2", "a3", "a5"], excludedAssetIds: [], includeOutside: true, linkTag: true, previewToken: "snapshot" })));
    expect(onSaved).toHaveBeenCalledWith({ target, queuedCount: 3 });
  });
  it("requires a folder before preselecting references for a folderless suggestion", async () => {
    const client = api(); dialog(client, "register", { ...suggestion, seriesId: null });
    expect(screen.getByRole("button", { name: "캐릭터 만들기" })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole("combobox", { name: "시리즈 폴더" })).not.toBeDisabled());
    expect(client.detail).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("combobox", { name: "시리즈 폴더" }), { target: { value: "series" } });
    expect(await screen.findByRole("button", { name: "a4 크게 보기" })).toBeInTheDocument();
    expect(client.detail).toHaveBeenCalledWith(suggestion.tag, "series");
  });
  it("summarises candidates and can omit outside images without per-image exclusions", async () => {
    const client = api(); dialog(client);
    await screen.findByRole("button", { name: "a0 크게 보기" });
    expect(screen.getByText(/^검토 후보 3장 —/)).toBeInTheDocument();
    expect(screen.queryByLabelText("검토 후보 이미지")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "a6 빼기" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "시리즈 폴더 밖 이미지도 후보로" }));
    expect(screen.getByText(/^검토 후보 2장 —/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "캐릭터 만들기" }));
    await waitFor(() => expect(client.register).toHaveBeenCalledWith(expect.objectContaining({ includeOutside: false, excludedAssetIds: [] })));
  });
  it("previews references with arrows and Escape closes only the preview", async () => {
    const onClose = vi.fn();
    render(<SuggestionDialog suggestion={suggestion} mode="register" privacyMode={false} api={api()} onClose={onClose} onSaved={vi.fn()} />);
    const opener = await screen.findByRole("button", { name: "a4 크게 보기" });
    opener.focus(); fireEvent.click(opener);
    const preview = screen.getByRole("dialog", { name: "참조 이미지 크게 보기" });
    fireEvent.keyDown(preview, { key: "Tab", shiftKey: true });
    expect(within(preview).getByRole("button", { name: "미리보기 닫기" })).toHaveFocus();
    fireEvent.keyDown(preview, { key: "Tab" });
    expect(within(preview).getByRole("button", { name: "이전 이미지" })).toHaveFocus();
    expect(within(preview).getByRole("img")).toHaveAttribute("src", expect.stringContaining("/asset/a4"));
    // The previous reference stays painted until the next one has loaded (no blank frame).
    const loadReplacement = (id: string) => fireEvent.load(preview.querySelector(`img[src$="/asset/${id}"]`)!);
    fireEvent.keyDown(preview, { key: "ArrowRight" });
    expect(within(preview).getByRole("img")).toHaveAttribute("src", expect.stringContaining("/asset/a4"));
    loadReplacement("a6");
    await waitFor(() => expect(within(preview).getByRole("img")).toHaveAttribute("src", expect.stringContaining("/asset/a6")));
    fireEvent.click(within(preview).getByRole("button", { name: "이전 이미지" }));
    fireEvent.keyDown(preview, { key: "ArrowLeft" });
    loadReplacement("a5");
    await waitFor(() => expect(within(preview).getByRole("img")).toHaveAttribute("src", expect.stringContaining("/asset/a5")));
    fireEvent.click(within(preview).getByRole("button", { name: "다음 이미지" }));
    fireEvent.keyDown(preview, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "참조 이미지 크게 보기" })).not.toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "새 캐릭터 등록" })).toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
  it("keeps slots and previews private", async () => {
    render(<SuggestionDialog suggestion={suggestion} mode="register" privacyMode api={api()} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "a4 크게 보기" }));
    expect(screen.getByText("프라이버시 모드")).toBeInTheDocument();
    expect(document.querySelector(".character-suggestion-dialog img")).toBeNull();
  });
  it("merges with the chosen target fingerprint and tag linking enabled", async () => {
    const client = api(); dialog(client, "merge");
    fireEvent.click(await screen.findByRole("radio"));
    await waitFor(() => expect(screen.getByRole("button", { name: "선택한 캐릭터에 합치기" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "선택한 캐릭터에 합치기" }));
    await waitFor(() => expect(client.merge).toHaveBeenCalledWith({ tag: suggestion.tag, targetId: target.id, expectedFingerprint: "fingerprint", previewToken: "snapshot", linkTag: true }));
  });
  it("keeps a failed save open with a preview reload action", async () => {
    const client = api(); vi.mocked(client.register).mockRejectedValue(new Error("stale")); dialog(client);
    await screen.findByRole("button", { name: "a0 크게 보기" });
    fireEvent.click(screen.getByRole("button", { name: "캐릭터 만들기" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(client.detail).toHaveBeenCalledTimes(2));
  });
  it("does not render private thumbnails", async () => {
    render(<CharacterSuggestionsOverview version={0} privacyMode api={api()} />);
    await screen.findByText("이졸데");
    expect(document.querySelector(".character-suggestions img")).toBeNull();
  });
});
