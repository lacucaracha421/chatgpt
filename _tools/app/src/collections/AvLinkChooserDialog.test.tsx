import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrivacyProvider } from "../privacy/PrivacyContext";
import { AvLinkChooserDialog } from "./AvLinkChooserDialog";
import type { AvLinkApi } from "./AvLinkInbox";
import type { AvLinkCandidate } from "./avLinkClient";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const baseCandidate = (existing = true): AvLinkCandidate => ({
  inbox: {
    id: "inbox-1", requestId: "request-1", productCode: "SSIS-001", normalizedCode: "SSIS-001", sourceUrl: "https://example.test/work",
    receivedAt: "2026-09-27T05:03:00Z", status: "found", attempts: 1, lastError: null, fetchedAt: "2026-09-27T05:04:00Z",
    collectionId: existing ? "av-1" : null, collectionName: existing ? "기존 작품" : null,
  },
  metadata: {
    normalized_id: "SSIS-001", title: "候補タイトル", date: "2021-02-19", makers: ["メーカーA"], labels: ["レーベルA"],
    series: [], actresses: [{ name: "女優A", image_url: null }], directors: [], genres: ["ジャンル1", "ジャンル2"],
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
  directors: [],
});

function api(candidate: AvLinkCandidate) {
  return {
    listInbox: vi.fn(), pendingCount: vi.fn(), getCandidate: vi.fn().mockResolvedValue(candidate), retry: vi.fn(), fixCode: vi.fn(),
    dismiss: vi.fn().mockResolvedValue(undefined), apply: vi.fn().mockResolvedValue({ collectionId: candidate.current?.collectionId ?? "new-av", covers: { frontId: "f", spineId: "s", backId: "b", revision: "r" } }),
  } as AvLinkApi;
}

function show(candidate: AvLinkCandidate) {
  const client = api(candidate);
  const callbacks = { onClose: vi.fn(), onApplied: vi.fn(), onDismissed: vi.fn() };
  render(<AvLinkChooserDialog inboxId="inbox-1" collections={[]} api={client} {...callbacks} />);
  return { client, ...callbacks };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("AvLinkChooserDialog", () => {
  it("moves split lines from the keyboard, updates crop sizes, and clamps every surface to at least one pixel", async () => {
    show(baseCandidate());
    const first = await screen.findByRole("slider", { name: "뒤와 옆 사이 선" });
    const second = screen.getByRole("slider", { name: "옆과 앞 사이 선" });
    expect(first).toHaveAttribute("aria-valuenow", "1");
    fireEvent.keyDown(first, { key: "ArrowLeft" });
    expect(first).toHaveAttribute("aria-valuenow", "1");
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(first).toHaveAttribute("aria-valuenow", "2");
    expect(within(screen.getByRole("region", { name: "뒤표지" })).getByText("2 × 438")).toBeInTheDocument();
    fireEvent.keyDown(second, { key: "ArrowRight", shiftKey: true });
    expect(second).toHaveAttribute("aria-valuenow", "799");
    expect(within(screen.getByRole("region", { name: "앞표지" })).getByText("1 × 438")).toBeInTheDocument();
  });

  it("checks only empty current metadata by default and labels same and different values", async () => {
    show(baseCandidate());
    await screen.findByRole("table", { name: "후보 정보 비교" });
    expect(screen.getByRole("checkbox", { name: "원제 적용" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "제작사 적용" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "발매일 적용" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "레이블 적용" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "레이블 적용" })).toBeDisabled();
    expect(screen.getByText("다름")).toBeInTheDocument();
    expect(screen.getByText("같음")).toBeInTheDocument();
  });

  it("builds an existing-collection apply request with its current cover revision", async () => {
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

  it("checks available fields for a new collection and sends newCollectionName instead of a collection revision", async () => {
    const { client } = show(baseCandidate(false));
    expect(await screen.findByRole("textbox", { name: "새 컬렉션 이름" })).toHaveValue("SSIS-001");
    expect(screen.getByRole("checkbox", { name: "발매일 적용" })).toBeChecked();
    await userEvent.setup().click(screen.getByRole("button", { name: "새 컬렉션 만들기" }));
    await waitFor(() => expect(client.apply).toHaveBeenCalledWith("inbox-1", {
      newCollectionName: "SSIS-001", split: { x1: 1, x2: 799 },
      surfaces: { front: "candidate", spine: "candidate", back: "candidate" },
      fields: { title_ja: "候補タイトル", release_date: "2021-02-19", maker: "メーカーA", label: "レーベルA", genres: ["ジャンル1", "ジャンル2"] },
      performers: [{ name_ja: "女優A", action: "new", displayName: "배우 A" }], directors: [],
    }));
  });

  it("dismisses a fetched candidate only after the undo-free confirmation", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { client, onDismissed } = show(baseCandidate());
    await userEvent.setup().click(await screen.findByRole("button", { name: "거절" }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(client.dismiss).toHaveBeenCalledWith("inbox-1");
    expect(onDismissed).toHaveBeenCalledOnce();
  });

  it("shows the existing revision-conflict message and reloads the candidate", async () => {
    const candidate = baseCandidate();
    const { client } = show(candidate);
    vi.mocked(client.apply).mockRejectedValue({ code: "av_stale", message: "정보가 변경되었습니다. 다시 불러온 뒤 저장해 주세요." });
    await userEvent.setup().click(await screen.findByRole("button", { name: "적용" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("정보가 변경되었습니다. 다시 불러온 뒤 저장해 주세요.");
    expect(client.getCandidate).toHaveBeenCalledTimes(2);
    expect(client.getCandidate).toHaveBeenLastCalledWith("inbox-1", "av-1");
  });
});

it("uses the shared 24-hour time for the source lookup", async () => {
  const candidate = baseCandidate();
  candidate.inbox.fetchedAt = "2026-10-01T00:07:40";
  show(candidate);
  expect(await screen.findByText("00:07")).toBeInTheDocument();
});

it("draws each split line on the exact cut position", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync("src/collections/avLink.css", "utf8");
  // Hit area is centred on the cut: the drawn line (and cap) must sit at its centre, not its left edge.
  expect(css).toMatch(/\.av-link-split \{[^}]*width: 12px; margin-left: -6px;[^}]*border: 0;/);
  expect(css).toMatch(/\.av-link-split::after \{[^}]*left: 5px; width: 2px;/);
  expect(css).toMatch(/\.av-link-split::before \{[^}]*left: 2px; width: 8px;[^}]*box-sizing: border-box;/);
  expect(css).not.toMatch(/\.av-link-zone \{[^}]*border-right/);
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
    expect(await screen.findByText(/후보를 넣을 곳을 고르세요/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "새 컬렉션 만들기" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "B 작품" }));
    await waitFor(() => expect(client.getCandidate).toHaveBeenLastCalledWith("inbox-1", "av-b"));
    const apply = await screen.findByRole("button", { name: "적용" });
    await user.click(apply);
    await waitFor(() => expect(client.apply).toHaveBeenCalledWith("inbox-1", expect.objectContaining({ collectionId: "av-b", expectedRevision: "revision-7" })));
  });

  it("lets the user choose a new collection on purpose when several exist", async () => {
    const { client } = show(several());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "새 AV 컬렉션으로 만들기" }));
    await user.click(screen.getByRole("button", { name: "새 컬렉션 만들기" }));
    await waitFor(() => expect(client.apply).toHaveBeenCalledWith("inbox-1", expect.objectContaining({ newCollectionName: "SSIS-001" })));
  });

  it("shows a refused apply without reloading and keeps the choices", async () => {
    const { client } = show(baseCandidate());
    vi.mocked(client.apply).mockRejectedValue({ code: "av_inbox_code_mismatch", message: "품번이 다른 컬렉션에는 연결할 수 없어요." });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "적용" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("품번이 다른 컬렉션에는 연결할 수 없어요.");
    expect(client.getCandidate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "적용" })).toBeEnabled();
  });

  it("hides the jacket and every crop in privacy mode", async () => {
    const client = api(baseCandidate());
    render(<PrivacyProvider privacyMode setPrivacyMode={vi.fn()}>
      <AvLinkChooserDialog inboxId="inbox-1" collections={[]} api={client} onClose={vi.fn()} onApplied={vi.fn()} onDismissed={vi.fn()} />
    </PrivacyProvider>);
    expect(await screen.findByText("비공개 모드")).toBeInTheDocument();
    expect(screen.queryByAltText("펼친 재킷 후보")).not.toBeInTheDocument();
    expect(screen.queryByAltText("후보 표지 자르기")).not.toBeInTheDocument();
  });
});

it.each(["performer", "director"] as const)("filters existing person search and suggested matches by %s credits", async role => {
  const candidate=baseCandidate();
  const person={...candidate.performers[0],personId:"wrong",displayName:"다른 역할",alreadyLinked:false};
  candidate.performers=role==="performer"?[person]:[];
  candidate.directors=role==="director"?[person]:[];
  const peopleApi={searchPeople:vi.fn().mockResolvedValue([{id:"actor",displayName:"출연 전용"},{id:"director",displayName:"감독 전용"},{id:"both",displayName:"겸업"},{id:"none",displayName:"이력 없음"}]),getPerformer:vi.fn().mockImplementation(async (id:string)=>({works:id==="both"?[{collectionId:"dual-work",role:"performer"}]:id==="none"?[]:[{role:id==="actor"?"performer":id==="director"?"director":role==="performer"?"director":"performer"}]})),getDetails:vi.fn().mockImplementation(async (id:string)=>({people:id==="dual-work"?[{id:"both",role:"director"}]:[]}))} as unknown as Pick<import("./avTypes").AvGateway,"searchPeople"|"getPerformer"|"getDetails">;
  render(<AvLinkChooserDialog inboxId="inbox-1" collections={[]} api={api(candidate)} peopleApi={peopleApi} onClose={vi.fn()} onApplied={vi.fn()} onDismissed={vi.fn()}/>);
  const control=await screen.findByRole("combobox",{name:"배우 A (女優A) 연결 방식"});
  expect(control).toHaveValue("new");
  expect(within(control).queryByRole("option",{name:"다른 역할"})).toBeNull();
  fireEvent.change(control,{target:{value:"search"}});
  const results=await screen.findByRole("listbox",{name:"배우 A (女優A) 기존 인물 검색 결과"});
  expect(within(results).getAllByRole("option").map(o=>o.textContent)).toEqual([role==="performer"?"출연 전용":"감독 전용","겸업"]);
  fireEvent.click(within(results).getByRole("option",{name:"겸업"}));
  expect(control).toHaveValue("link:both");
});
