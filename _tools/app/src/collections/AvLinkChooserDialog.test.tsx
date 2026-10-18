import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrivacyProvider } from "../privacy/PrivacyContext";
import { AvLinkChooserDialog } from "./AvLinkChooserDialog";
import type { AvLinkApi } from "./AvLinkInbox";
import type { AvLinkCandidate } from "./avLinkClient";
import type { AvGateway } from "./avTypes";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const baseCandidate = (existing = true): AvLinkCandidate => ({
  inbox: {
    id: "inbox-1", requestId: "request-1", productCode: "SSIS-001", normalizedCode: "SSIS-001", sourceUrl: "https://example.test/work",
    receivedAt: "2026-09-27T05:03:00Z", status: "found", attempts: 1, lastError: null, fetchedAt: "2026-09-27T05:04:00Z",
    collectionId: existing ? "av-1" : null, collectionName: existing ? "기존 작품" : null,
  },
  matches: existing ? [{ collectionId: "av-1", name: "기존 작품" }] : [],
  metadata: {
    normalized_id: "SSIS-001", title: "候補タイトル", date: "2021-02-19", makers: ["メーカーA"], labels: ["レーベルA"],
    series: [], actresses: [{ name: "女優A", image_url: null }], directors: ["監督A"], genres: ["ジャンル1", "ジャンル2"],
    cover_image_url: "https://example.test/jacket.jpg", thumbnail_image_url: null, volume: null,
  },
  fields: { title_ja: "候補タイトル", release_date: "2021-02-19", maker: "メーカーA", label: "レーベルA", series: null, genres: ["ジャンル1", "ジャンル2"] },
  jacketUrl: "lakomics://localhost/av-link-jacket/inbox-1", jacketWidth: 800, jacketHeight: 438,
  defaultSplit: { x1: 1, x2: 799, isWrap: true, useSpine: true },
  current: existing ? {
    collectionId: "av-1", name: "기존 작품", productCode: "SSIS-001",
    fields: { title_ja: null, release_date: "2021-02-18", maker: null, label: "レーベルA", series: null, genres: null },
    covers: { frontId: "front-current", spineId: null, backId: null, revision: "revision-7" },
    people: [{ id: "person-1", displayName: "배우 A", role: "performer", order: 0, creditName: "女優A" }],
  } : null,
  performers: existing
    ? [{ name_ja: "女優A", name_ko: "배우 A", wikidata_id: "Q1", fanza_actress_id: null, personId: "person-1", displayName: "배우 A", matchBy: "name", alreadyLinked: true }]
    : [{ name_ja: "女優A", name_ko: "배우 A", wikidata_id: "Q1", fanza_actress_id: null, personId: null, displayName: null, matchBy: null, alreadyLinked: false }],
});

function api(candidate: AvLinkCandidate) {
  return {
    listInbox: vi.fn(), pendingCount: vi.fn(), getCandidate: vi.fn().mockResolvedValue(candidate), retry: vi.fn(), fixCode: vi.fn(),
    dismiss: vi.fn().mockResolvedValue(undefined), apply: vi.fn().mockResolvedValue({ collectionId: candidate.current?.collectionId ?? "new-av", covers: { frontId: "f", spineId: "s", backId: "b", revision: "r" } }),
  } as AvLinkApi;
}

function show(candidate: AvLinkCandidate, peopleApi?: Pick<AvGateway, "searchPeople" | "getPerformer" | "getDetails">) {
  const client = api(candidate);
  const callbacks = { onClose: vi.fn(), onApplied: vi.fn(), onDismissed: vi.fn() };
  render(<AvLinkChooserDialog inboxId="inbox-1" collections={[]} api={client} peopleApi={peopleApi} {...callbacks} />);
  return { client, ...callbacks };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("AvLinkChooserDialog", () => {
  it("moves split lines from the keyboard and keeps every surface at least one pixel wide", async () => {
    show(baseCandidate());
    const first = await screen.findByRole("slider", { name: "뒤표지와 책등 사이 선" });
    const second = screen.getByRole("slider", { name: "책등과 앞표지 사이 선" });
    expect(first).toHaveAttribute("aria-valuenow", "1");
    fireEvent.keyDown(first, { key: "ArrowLeft" });
    expect(first).toHaveAttribute("aria-valuenow", "1");
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(first).toHaveAttribute("aria-valuenow", "2");
    fireEvent.keyDown(second, { key: "ArrowRight", shiftKey: true });
    expect(second).toHaveAttribute("aria-valuenow", "799");
    fireEvent.keyDown(second, { key: "ArrowLeft", shiftKey: true });
    expect(second).toHaveAttribute("aria-valuenow", "789");
    expect(screen.getByRole("button", { name: "자동으로" })).toBeInTheDocument();
  });

  it("takes the spine of a spine-less wide jacket from the DVD cover, shown as one joined line", async () => {
    const { client } = show({ ...baseCandidate(false), jacketWidth: 2184, jacketHeight: 1638, defaultSplit: { x1: 1092, x2: 1092, isWrap: true, useSpine: true } });
    expect(await screen.findByRole("button", { name: "책등: 후보 사용" })).toHaveTextContent("DVD");
    expect(screen.getByRole("slider", { name: "뒤표지 쪽 선" })).toBeInTheDocument();
    expect(screen.queryByText(/책등이 좁아요/)).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "만들기" }));
    await waitFor(() => expect(client.apply).toHaveBeenCalled());
    expect(vi.mocked(client.apply).mock.calls[0][1]).toMatchObject({ split: { x1: 1092, x2: 1093 }, surfaces: { spine: "candidate" } });
  });

  it("pulling a joined line apart cuts a spine from the jacket itself", async () => {
    show({ ...baseCandidate(false), jacketWidth: 2184, jacketHeight: 1638, defaultSplit: { x1: 1092, x2: 1092, isWrap: true, useSpine: true } });
    await screen.findByRole("slider", { name: "앞표지 쪽 선" });
    for (let step = 0; step < 3; step += 1) fireEvent.keyDown(screen.getByRole("slider", { name: step === 0 ? "앞표지 쪽 선" : /앞표지/ }), { key: "ArrowRight", shiftKey: true });
    expect(screen.getByRole("slider", { name: "책등과 앞표지 사이 선" })).toHaveAttribute("aria-valuenow", "1123");
    expect(screen.getByRole("button", { name: "책등: 후보 사용" })).not.toHaveTextContent("DVD");
  });

  it("builds an existing-collection apply request: current cover kept, no directors, genres added", async () => {
    const { client, onApplied } = show(baseCandidate());
    await userEvent.setup().click(await screen.findByRole("button", { name: "적용" }));
    await waitFor(() => expect(client.apply).toHaveBeenCalledWith("inbox-1", {
      collectionId: "av-1", expectedRevision: "revision-7", split: { x1: 1, x2: 799 },
      surfaces: { front: "keep", spine: "candidate", back: "candidate" },
      fields: { title_ja: "候補タイトル", maker: "メーカーA", genres: ["ジャンル1", "ジャンル2"] },
      performers: [], directors: [],
    }));
    expect(onApplied).toHaveBeenCalledWith("av-1");
  });

  it("starts a new collection named after the product code and sends every available field", async () => {
    const { client } = show(baseCandidate(false));
    const user = userEvent.setup();
    expect(await screen.findByRole("textbox", { name: "이름" })).toHaveValue("SSIS-001");
    expect(screen.queryByRole("button", { name: "원제로 채우기" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "만들기" }));
    await waitFor(() => expect(client.apply).toHaveBeenCalledWith("inbox-1", {
      newCollectionName: "SSIS-001", split: { x1: 1, x2: 799 },
      surfaces: { front: "candidate", spine: "candidate", back: "candidate" },
      fields: { title_ja: "候補タイトル", release_date: "2021-02-19", maker: "メーカーA", label: "レーベルA", genres: ["ジャンル1", "ジャンル2"] },
      performers: [{ name_ja: "女優A", action: "new", displayName: "배우 A" }], directors: [],
    }));
  });

  it("shows genres by their Korean names, leaves sale and quality tags out, and sends only the shown ones", async () => {
    const candidate = baseCandidate(false);
    candidate.fields.genres = ["痴女", "騎乗位", "ギリモザ", "セール対象商品", "ハイビジョン", "サンプル動画"];
    const { client } = show(candidate);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "자세히" }));
    expect(screen.getByRole("button", { name: "치녀" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "기승위" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "아슬아슬 모자이크" })).toBeInTheDocument();
    expect(screen.queryByText("セール対象商品")).not.toBeInTheDocument();
    expect(screen.getByText("판매·샘플 태그 3개 숨김")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "기승위" }));
    await user.click(screen.getByRole("button", { name: "만들기" }));
    await waitFor(() => expect(client.apply).toHaveBeenCalled());
    expect(vi.mocked(client.apply).mock.calls[0][1].fields.genres).toEqual(["痴女", "ギリモザ"]);
  });

  it("leaves the stored genres, hidden tags included, in place when adding new ones to an existing collection", async () => {
    const candidate = baseCandidate();
    candidate.current!.fields.genres = ["セール対象商品", "痴女"];
    candidate.fields.genres = ["痴女", "騎乗位"];
    const { client } = show(candidate);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "자세히" }));
    expect(screen.getByRole("button", { name: "기승위" })).toHaveAttribute("aria-pressed", "false");
    await user.click(screen.getByRole("button", { name: "기승위" }));
    await user.click(screen.getByRole("button", { name: "적용" }));
    await waitFor(() => expect(client.apply).toHaveBeenCalled());
    expect(vi.mocked(client.apply).mock.calls[0][1].fields.genres).toEqual(["セール対象商品", "痴女", "騎乗位"]);
  });

  it("checks only empty current fields by default and labels same and different values in the details", async () => {
    show(baseCandidate());
    await userEvent.setup().click(await screen.findByRole("button", { name: "자세히" }));
    expect(screen.getByRole("checkbox", { name: "원제 적용" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "제작사 적용" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "발매일 적용" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "레이블 적용" })).toBeDisabled();
    expect(screen.getByText("다름")).toBeInTheDocument();
    expect(screen.getByText("같음")).toBeInTheDocument();
  });

  it("chooses a surface's image from its label menu", async () => {
    const { client } = show(baseCandidate());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "뒤표지: 후보 사용" }));
    await user.click(await screen.findByRole("menuitemradio", { name: /비우기/ }));
    expect(screen.getByRole("button", { name: "뒤표지: 비움" })).toHaveTextContent("없음");
    await user.click(screen.getByRole("button", { name: "적용" }));
    await waitFor(() => expect(client.apply).toHaveBeenCalled());
    expect(vi.mocked(client.apply).mock.calls[0][1].surfaces).toEqual({ front: "keep", spine: "candidate", back: "clear" });
  });

  it("asks in the app before rejecting a candidate, with no top close button", async () => {
    const confirm = vi.spyOn(window, "confirm");
    const { client, onDismissed } = show(baseCandidate());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "거절" }));
    expect(confirm).not.toHaveBeenCalled();
    expect(client.dismiss).not.toHaveBeenCalled();
    const asking = await screen.findByRole("dialog", { name: "후보를 거절할까요?" });
    await user.click(within(asking).getByRole("button", { name: "거절" }));
    await waitFor(() => expect(client.dismiss).toHaveBeenCalledWith("inbox-1"));
    expect(onDismissed).toHaveBeenCalledOnce();
  });

  it("closes only through 나중에", async () => {
    const { onClose } = show(baseCandidate());
    expect(await screen.findByRole("button", { name: "적용" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /닫기/ })).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "나중에" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("reloads the candidate for the same destination after a stale apply and says so", async () => {
    const { client } = show(baseCandidate());
    vi.mocked(client.apply).mockRejectedValue({ code: "av_stale", message: "정보가 변경되었습니다." });
    await userEvent.setup().click(await screen.findByRole("button", { name: "적용" }));
    expect(await screen.findByText("다른 곳에서 바뀌어 다시 읽었어요")).toBeInTheDocument();
    expect(client.getCandidate).toHaveBeenCalledTimes(2);
    expect(client.getCandidate).toHaveBeenLastCalledWith("inbox-1", "av-1");
  });

  it("keeps the dialog and offers 다시 시도 when an apply is refused", async () => {
    const { client } = show(baseCandidate());
    vi.mocked(client.apply).mockRejectedValueOnce({ code: "av_inbox_code_mismatch", message: "품번이 다른 컬렉션에는 연결할 수 없어요." });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "적용" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("품번이 다른 컬렉션에는 연결할 수 없어요.");
    expect(client.getCandidate).toHaveBeenCalledTimes(1);
    await user.click(within(screen.getByRole("alert")).getByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(client.apply).toHaveBeenCalledTimes(2));
  });

  it("hides the jacket and every crop in privacy mode", async () => {
    const client = api(baseCandidate());
    render(<PrivacyProvider privacyMode setPrivacyMode={vi.fn()}>
      <AvLinkChooserDialog inboxId="inbox-1" collections={[]} api={client} onClose={vi.fn()} onApplied={vi.fn()} onDismissed={vi.fn()} />
    </PrivacyProvider>);
    expect(await screen.findByRole("img", { name: "표지 숨김" })).toBeInTheDocument();
    expect(screen.queryByAltText("SSIS-001 펼친 재킷")).not.toBeInTheDocument();
  });
});

describe("AvLinkChooserDialog on the server inbox", () => {
  const several = () => {
    const candidate = baseCandidate(false);
    candidate.matches = [{ collectionId: "av-a", name: "A 작품" }, { collectionId: "av-b", name: "B 작품" }];
    return candidate;
  };

  it("never picks one of several matching collections for the user", async () => {
    const candidate = several();
    const chosen = baseCandidate();
    chosen.current!.collectionId = "av-b";
    chosen.current!.name = "B 작품";
    chosen.matches = candidate.matches;
    const client = api(candidate);
    vi.mocked(client.getCandidate).mockReset().mockResolvedValueOnce(candidate).mockResolvedValueOnce(chosen);
    render(<AvLinkChooserDialog inboxId="inbox-1" collections={[]} api={client} onClose={vi.fn()} onApplied={vi.fn()} onDismissed={vi.fn()} />);
    const user = userEvent.setup();
    expect(await screen.findByText("넣을 곳을 고르세요")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "적용" })).toBeDisabled();
    await user.click(screen.getByRole("radio", { name: /B 작품/ }));
    await waitFor(() => expect(client.getCandidate).toHaveBeenLastCalledWith("inbox-1", "av-b"));
    await waitFor(() => expect(screen.getByRole("radio", { name: /B 작품/ })).toHaveAttribute("aria-checked", "true"));
    await user.click(await screen.findByRole("button", { name: "적용" }));
    await waitFor(() => expect(client.apply).toHaveBeenCalledWith("inbox-1", expect.objectContaining({ collectionId: "av-b", expectedRevision: "revision-7" })));
  });

  it("lets the user choose a new collection on purpose when collections already match", async () => {
    const { client } = show(several());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("radio", { name: /새 컬렉션/ }));
    await user.click(screen.getByRole("button", { name: "만들기" }));
    await waitFor(() => expect(client.apply).toHaveBeenCalledWith("inbox-1", expect.objectContaining({ newCollectionName: "SSIS-001" })));
  });

  it("applies as a new collection even when one collection matches, and then treats people as not yet credited", async () => {
    const { client } = show(baseCandidate());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("radio", { name: /새 컬렉션/ }));
    await user.click(screen.getByRole("button", { name: "만들기" }));
    await waitFor(() => expect(client.apply).toHaveBeenCalled());
    const request = vi.mocked(client.apply).mock.calls[0][1];
    expect(request).toMatchObject({ newCollectionName: "SSIS-001", surfaces: { front: "candidate" }, performers: [{ name_ja: "女優A", action: "link", personId: "person-1" }] });
    expect(client.getCandidate).toHaveBeenCalledTimes(1);
  });

  it("blocks applying to a collection with another product code", async () => {
    const candidate = baseCandidate();
    candidate.current!.productCode = "ABCD-999";
    show(candidate);
    expect(await screen.findByText("품번이 다른 컬렉션")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "적용" })).toBeDisabled();
  });
});

describe("existing performer search", () => {
  it("offers only people with a performer credit and links the chosen one", async () => {
    const candidate = baseCandidate(false);
    const person = { ...candidate.performers[0], personId: "wrong", displayName: "다른 역할", alreadyLinked: false };
    candidate.performers = [person];
    const peopleApi = {
      searchPeople: vi.fn().mockResolvedValue([{ id: "actor", displayName: "출연 전용" }, { id: "director", displayName: "감독 전용" }, { id: "none", displayName: "이력 없음" }]),
      getPerformer: vi.fn().mockImplementation(async (id: string) => ({ person: {}, works: id === "none" ? [] : [{ role: id === "actor" ? "performer" : id === "director" ? "director" : "director" }] })),
      getDetails: vi.fn(),
    } as unknown as Pick<AvGateway, "searchPeople" | "getPerformer" | "getDetails">;
    const { client } = show(candidate, peopleApi);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "자세히" }));
    await user.click(screen.getByRole("button", { name: "배우 A 연결" }));
    const results = await screen.findByRole("listbox", { name: "배우 A 기존 인물 결과" });
    await waitFor(() => expect(within(results).getAllByRole("option").map(option => option.textContent)).toEqual(["출연 전용"]));
    await user.click(within(results).getByRole("option", { name: "출연 전용" }));
    await user.click(screen.getByRole("button", { name: "만들기" }));
    await waitFor(() => expect(client.apply).toHaveBeenCalled());
    expect(vi.mocked(client.apply).mock.calls[0][1].performers).toEqual([{ name_ja: "女優A", action: "link", personId: "actor" }]);
  });
});
