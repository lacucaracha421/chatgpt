import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CharacterLab } from "./CharacterLab";
import { createCharacterFixture, fixtureAssets, fixtureClassifications } from "./characterFixtures";
import { LibraryProvider } from "../library/LibraryContext";
import type { LibraryGateway } from "../library/types";

beforeEach(() => { localStorage.clear(); Object.defineProperties(HTMLElement.prototype, { clientWidth: { configurable: true, get: () => 850 }, clientHeight: { configurable: true, get: () => 650 } }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function mount(api = createCharacterFixture()) {
  const gateway = { listAssets: vi.fn().mockResolvedValue({ items: fixtureAssets, nextCursor: null }), openLibrary: vi.fn() } as unknown as LibraryGateway;
  render(<LibraryProvider gateway={gateway}><CharacterLab classifications={fixtureClassifications} initialSeriesId="series" targetId="hina" onClose={vi.fn()} api={api} /></LibraryProvider>);
  return { api, gateway };
}

function mountEmbedded(api = createCharacterFixture(), onClose = vi.fn()) {
  const gateway = { listAssets: vi.fn().mockResolvedValue({ items: fixtureAssets, nextCursor: null }), openLibrary: vi.fn() } as unknown as LibraryGateway;
  render(<LibraryProvider gateway={gateway}><CharacterLab embedded classifications={fixtureClassifications} initialSeriesId="series" targetId="hina" onClose={onClose} api={api} /></LibraryProvider>);
  return { api, gateway, onClose };
}

describe("Character review", () => {
  it("opens the first recommendation as a preview without selecting it", async () => {
    mountEmbedded();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const panel = await screen.findByRole("complementary", { name: "선택 이미지 판단" });
    expect(within(panel).getByRole("img", { name: "이미지 5.webp" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "이미지 5.webp" })).toHaveAttribute("aria-selected", "false");
    expect(screen.queryByText("1장 선택")).not.toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "히나로 확정" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "아님" })).toBeInTheDocument();
  });

  it("defers the current preview for this session without recording a decision", async () => {
    const api = createCharacterFixture(), decide = vi.spyOn(api, "decide");
    mountEmbedded(api); const user = userEvent.setup();
    const panel = await screen.findByRole("complementary", { name: "선택 이미지 판단" });
    expect(within(panel).getByRole("img", { name: "이미지 5.webp" })).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "이번엔 건너뛰기" }));
    expect(within(await screen.findByRole("complementary", { name: "선택 이미지 판단" })).getByRole("img", { name: "이미지 6.webp" })).toBeInTheDocument();
    expect(decide).not.toHaveBeenCalled();
  });

  it("shows batch decisions only for two or more explicit selections", async () => {
    mountEmbedded();
    const first = await screen.findByRole("option", { name: "이미지 5.webp" });
    const second = screen.getByRole("option", { name: "이미지 6.webp" });
    fireEvent.click(first, { ctrlKey: true });
    expect(screen.queryByText("1장 선택")).not.toBeInTheDocument();
    fireEvent.click(second, { ctrlKey: true });
    const batch = screen.getByRole("region", { name: "선택 이미지 일괄 판단" });
    expect(within(batch).getByText("2장 선택")).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "선택 이미지 판단" })).not.toBeInTheDocument();
  });

  it("explains an empty recommendation view and offers a return action", async () => {
    const api = createCharacterFixture();
    vi.spyOn(api, "review").mockResolvedValue({ rows: [], nextCursor: null });
    const onClose = vi.fn(); mountEmbedded(api, onClose); const user = userEvent.setup();
    expect(await screen.findByRole("heading", { name: "현재 확인할 추천이 없습니다" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "이미지로 돌아가기" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("binds approval to the shown scan and does not move a folder", async () => {
    const api = createCharacterFixture(), decide = vi.spyOn(api, "decide"), targets = vi.spyOn(api, "targets"); mount(api);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("option", { name: "이미지 5.webp" }));
    const panel = screen.getByRole("complementary", { name: "선택 이미지 판단" });
    await user.click(within(panel).getByRole("button", { name: "히나로 확정" }));
    await waitFor(() => expect(decide).toHaveBeenCalledWith(expect.objectContaining({ targetId: "hina", assetIds: ["image-5"], expectedFingerprint: "fingerprint-hina", baselineFingerprint: "runtime", scanId: "scan-hina", decision: "accepted" })));
    await waitFor(() => expect(screen.queryByRole("option", { name: "이미지 5.webp" })).not.toBeInTheDocument());
    expect(targets).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "확정" }));
    expect(await screen.findByRole("option", { name: "이미지 5.webp" })).toBeInTheDocument();
  });

  it("keeps approval separate from explicit learning", async () => {
    const api = createCharacterFixture(), learn = vi.spyOn(api, "learnReferences"); mount(api);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("option", { name: "이미지 5.webp" }));
    await user.click(within(screen.getByRole("complementary", { name: "선택 이미지 판단" })).getByRole("button", { name: "히나로 확정" }));
    await waitFor(() => expect(screen.getByText("1장 확정")).toBeInTheDocument());
    expect(learn).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "확정" }));
    await user.click(await screen.findByRole("option", { name: "이미지 5.webp" }));
    await user.click(within(screen.getByRole("complementary", { name: "선택 이미지 판단" })).getByRole("button", { name: "추가 참조로 사용" }));
    await waitFor(() => expect(learn).toHaveBeenCalledWith("hina", 1, ["image-5"]));
    expect(await screen.findByText(/1장을 추가 참조로 사용/)).toBeInTheDocument();
  });

  it("fixes the review and evidence to the current character", async () => {
    const { api } = mount(); const user = userEvent.setup();
    const decide = vi.spyOn(api, "decide");
    await user.click(await screen.findByRole("option", { name: "이미지 5.webp" }));
    const panel = screen.getByRole("complementary", { name: "선택 이미지 판단" });
    expect(within(panel).queryByText("키사키")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "캐릭터 설정" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "후보 모두 승인" })).not.toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "아님" }));
    await waitFor(() => expect(decide).toHaveBeenCalledWith(expect.objectContaining({ targetId: "hina", decision: "rejected" })));
  });

  it("surfaces stale approval failure without falling back to manual assignment", async () => {
    const api = createCharacterFixture(), decide = vi.spyOn(api, "decide").mockRejectedValue({ code: "character_stale", message: "기준 이미지가 바뀌었습니다." }); mount(api);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("option", { name: "이미지 5.webp" }));
    await user.click(within(screen.getByRole("complementary", { name: "선택 이미지 판단" })).getByRole("button", { name: "히나로 확정" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("기준 이미지가 바뀌었습니다.");
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0]![0].scanId).not.toBeNull();
  });

  it("gates analysis until runtime setup", async () => {
    const api = createCharacterFixture(); vi.spyOn(api, "runtime").mockResolvedValue(false);
    const setup = vi.spyOn(api, "setup"); mount(api); const user = userEvent.setup();
    await screen.findByRole("option", { name: "이미지 5.webp" });
    expect(screen.getByRole("button", { name: "분류 시작" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "분석 환경 설정" }));
    await waitFor(() => expect(setup).toHaveBeenCalledTimes(1));
  });

});

it("manual review reports native automatic continuation without applying unchecked predictions", async () => {
  const api=createCharacterFixture();
  const states: Awaited<ReturnType<typeof api.runs>> = [];
  const start=vi.spyOn(api,"start").mockImplementation(async(targetId,targetFingerprint)=>{
    const run={automaticQueued:1,id:`new-${targetId}`,targetId,targetFingerprint,runtimeFingerprint:"runtime",state:"completed",total:1,completed:1,errors:0,cacheHits:1,extractions:0,error:null};
    states.push(run);return run;
  });
  vi.spyOn(api,"runs").mockImplementation(async()=>states);
  mount(api);const user=userEvent.setup();
  await screen.findByRole("option", { name: "이미지 5.webp" });
  await user.click(screen.getByRole("button",{name:"분류 시작"}));
  await waitFor(()=>expect(start).toHaveBeenCalledTimes(1));
  await waitFor(()=>expect(screen.getByRole("button",{name:"분류 시작"})).toBeEnabled(),{timeout:4000});
  expect(start).toHaveBeenCalledWith("hina",expect.any(String));
  expect(await screen.findByText(/1장의 자동 분류를 이어갑니다/, {}, {timeout:3000})).toBeInTheDocument();
});

it("closing review does not cancel its running analysis", async () => {
  const api=createCharacterFixture();
  const cancel=vi.spyOn(api,"cancel");
  vi.spyOn(api,"runs").mockResolvedValue([]);
  vi.spyOn(api,"start").mockImplementation(async(targetId,targetFingerprint)=>({
    id:"ongoing",targetId,targetFingerprint,runtimeFingerprint:"runtime",state:"running",total:100,completed:0,errors:0,cacheHits:0,extractions:0,error:null,
  }));
  mount(api); const user=userEvent.setup();
  const start=await screen.findByRole("button",{name:"분류 시작"});
  await waitFor(()=>expect(start).toBeEnabled());
  await user.click(start);
  await screen.findByText("분류를 시작했습니다. 이 창을 닫아도 계속 진행합니다.");
  await user.click(screen.getByRole("button",{name:"검토 닫기"}));
  cleanup();
  expect(cancel).not.toHaveBeenCalled();
});

it("keeps loaded pages and selection during a background refresh", async () => {
  const api = createCharacterFixture(), original = api.review;
  api.review = vi.fn(async query => {
    const all = await original({ ...query, after: null });
    return query.after ? { rows: all.rows.slice(4), nextCursor: null } : { rows: all.rows.slice(0, 4), nextCursor: "page-2" };
  });
  const gateway = { listAssets: vi.fn(), openLibrary: vi.fn() } as unknown as LibraryGateway;
  const view = (version: number) => <LibraryProvider gateway={gateway}><CharacterLab classifications={fixtureClassifications} initialSeriesId="series" targetId="hina" refreshVersion={version} onClose={vi.fn()} api={api} /></LibraryProvider>;
  const { rerender } = render(view(0)); const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "더 불러오기" }));
  fireEvent.click(await screen.findByRole("option", { name: "이미지 13.webp" }), { ctrlKey: true });
  const selected = screen.getByRole("option", { name: "이미지 13.webp" });
  const calls = vi.mocked(api.review).mock.calls.length;
  rerender(view(1));
  await screen.findByRole("button", { name: "새 결과 확인" });
  expect(selected).toBeInTheDocument();
  expect(selected).toHaveAttribute("aria-selected", "true");
  expect(api.review).toHaveBeenCalledTimes(calls);
  await user.click(screen.getByRole("button", { name: "새 결과 확인" }));
  await waitFor(() => expect(api.review).toHaveBeenCalledTimes(calls + 2));
  expect(screen.getByRole("option", { name: "이미지 13.webp" })).toHaveAttribute("aria-selected", "true");
});

it("keeps the review panel on the thumbnail without an original-view control", async () => {
  mount(); const user = userEvent.setup();
  await user.click(await screen.findByRole("option", { name: "이미지 5.webp" }));
  const panel = screen.getByRole("complementary", { name: "선택 이미지 판단" });
  expect(within(panel).getByRole("img", { name: "이미지 5.webp" })).toHaveAttribute("src", expect.stringContaining("/thumbnail/"));
  expect(within(panel).queryByRole("button", { name: "원본 보기" })).not.toBeInTheDocument();
  expect(within(panel).queryByRole("button", { name: "미리보기" })).not.toBeInTheDocument();
});


