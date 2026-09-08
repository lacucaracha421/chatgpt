import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { characterHubApi } from "./hubApi";
import { CharacterLab } from "./CharacterLab";
import { createCharacterFixture, fixtureAssets, fixtureClassifications } from "./characterFixtures";
import { LibraryProvider } from "../library/LibraryContext";
import type { LibraryGateway } from "../library/types";

beforeEach(() => { localStorage.clear(); Object.defineProperties(HTMLElement.prototype, { clientWidth: { configurable: true, get: () => 850 }, clientHeight: { configurable: true, get: () => 650 } }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function mount(api = createCharacterFixture()) {
  const gateway = { listAssets: vi.fn().mockResolvedValue({ items: fixtureAssets, nextCursor: null }), openLibrary: vi.fn() } as unknown as LibraryGateway;
  render(<LibraryProvider gateway={gateway}><CharacterLab classifications={fixtureClassifications} initialSeriesId="series" onClose={vi.fn()} api={api} /></LibraryProvider>);
  return { api, gateway };
}

describe("Character review", () => {
  it("binds approval to the shown scan and does not move a folder", async () => {
    const api = createCharacterFixture(), decide = vi.spyOn(api, "decide"); mount(api);
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByRole("combobox", { name: "캐릭터 설정" }), "hina");
    await user.click(await screen.findByRole("option", { name: "이미지 5.webp" }));
    const panel = screen.getByRole("complementary", { name: "선택 이미지 판단" });
    await user.click(within(panel).getAllByRole("button", { name: "승인" })[0]!);
    await waitFor(() => expect(decide).toHaveBeenCalledWith(expect.objectContaining({ targetId: "hina", assetIds: ["image-5"], expectedFingerprint: "fingerprint-hina", baselineFingerprint: "runtime", scanId: "scan-hina", decision: "accepted" })));
    await user.click(screen.getByRole("button", { name: "확정" }));
    expect(await screen.findByRole("option", { name: "이미지 5.webp" })).toBeInTheDocument();
  });

  it("submits multiple candidates in one atomic request", async () => {
    const api = createCharacterFixture(), batch = vi.spyOn(api, "decideBatch"); mount(api);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("option", { name: "이미지 5.webp" }));
    await user.click(screen.getByRole("button", { name: "후보 모두 승인" }));
    await waitFor(() => expect(batch).toHaveBeenCalledTimes(1));
    expect(batch.mock.calls[0]![0]).toHaveLength(2);
    expect(batch.mock.calls[0]![0].every(r => r.scanId && r.decision === "accepted")).toBe(true);
  });

  it("surfaces stale approval failure without falling back to manual assignment", async () => {
    const api = createCharacterFixture(), decide = vi.spyOn(api, "decide").mockRejectedValue({ code: "character_stale", message: "기준 이미지가 바뀌었습니다." }); mount(api);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("option", { name: "이미지 5.webp" }));
    await user.click(within(screen.getByRole("complementary", { name: "선택 이미지 판단" })).getAllByRole("button", { name: "승인" })[0]!);
    expect(await screen.findByRole("alert")).toHaveTextContent("기준 이미지가 바뀌었습니다.");
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0]![0].scanId).not.toBeNull();
  });

  it("chooses references recursively and refuses a sixth image", async () => {
    vi.spyOn(characterHubApi,"browse").mockResolvedValue({items:fixtureAssets,nextCursor:null,totalCount:fixtureAssets.length});
    const api = createCharacterFixture(), refs = vi.spyOn(api, "refs"); mount(api); const user = userEvent.setup();
    await user.selectOptions(await screen.findByRole("combobox", { name: "캐릭터 설정" }), "hina");
    await user.click(screen.getByRole("button", { name: "기준 이미지 선택" }));
    const picker = await screen.findByRole("dialog", { name: "히나 · 기준 이미지" });
    await user.click(await within(picker).findByRole("option", { name: "이미지 5.webp" }));
    expect(within(picker).getByRole("alert")).toHaveTextContent("최대 5장");
    await user.click(within(picker).getByRole("button", { name: "기준 이미지 1 해제" }));
    await user.click(within(picker).getByRole("option", { name: "이미지 5.webp" }));
    await user.click(within(picker).getByRole("button", { name: "기준 이미지 저장" }));
    await waitFor(() => expect(refs).toHaveBeenCalledWith("hina", 1, ["image-1", "image-2", "image-3", "image-4", "image-5"]));
    expect(characterHubApi.browse).toHaveBeenCalledWith(expect.objectContaining({ seriesId: "series", referenceTargetId: "hina" }));
  });

  it("gates scan until runtime setup and creates a registry entry without moving folders", async () => {
    const api = createCharacterFixture(); vi.spyOn(api, "runtime").mockResolvedValue(false); const save = vi.spyOn(api, "save"), setup = vi.spyOn(api, "setup"); mount(api);
    const user = userEvent.setup();
    await screen.findByRole("option", { name: "이미지 5.webp" });
    expect(screen.getByRole("button", { name: "시리즈 분석" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "분석 환경 설정" }));
    await waitFor(() => expect(setup).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole("textbox", { name: "캐릭터 이름" }), { target: { value: "아루" } });
    await user.click(screen.getByRole("button", { name: "캐릭터 만들기" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ displayName: "아루", seriesClassificationId: "series", linkedClassificationId: null })));
  });
});

it("manual analysis with automatic classification compares the whole series before applying", async () => {
  const api=createCharacterFixture();
  vi.spyOn(api,"automaticSeries").mockResolvedValue(["series"]);
  const states: Awaited<ReturnType<typeof api.runs>> = [];
  const start=vi.spyOn(api,"start").mockImplementation(async(targetId,targetFingerprint)=>{
    const run={id:`new-${targetId}`,targetId,targetFingerprint,runtimeFingerprint:"runtime",state:"completed",total:1,completed:1,errors:0,cacheHits:1,extractions:0,error:null};
    states.push(run);return run;
  });
  vi.spyOn(api,"runs").mockImplementation(async()=>states);
  const apply=vi.spyOn(api,"applyAutomatic").mockResolvedValue(2);
  mount(api);const user=userEvent.setup();
  await user.selectOptions(await screen.findByRole("combobox",{name:"캐릭터 설정"}),"hina");
  await user.click(screen.getByRole("button",{name:"선택 캐릭터 분석"}));
  await waitFor(()=>expect(apply).toHaveBeenCalledTimes(1),{timeout:4000});
  expect(start).toHaveBeenCalledTimes((await api.targets()).filter(t=>t.ready&&t.seriesClassificationId==="series").length);
  expect(apply).toHaveBeenCalledWith(states.map(s=>s.id));
  expect(screen.getByText("분석 완료 · 2장 자동 확정")).toBeInTheDocument();
});
