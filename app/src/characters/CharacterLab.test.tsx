import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
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

describe("Character review", () => {
  it("binds approval to the shown scan and does not move a folder", async () => {
    const api = createCharacterFixture(), decide = vi.spyOn(api, "decide"); mount(api);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("option", { name: "이미지 5.webp" }));
    const panel = screen.getByRole("complementary", { name: "선택 이미지 판단" });
    await user.click(within(panel).getAllByRole("button", { name: "승인" })[0]!);
    await waitFor(() => expect(decide).toHaveBeenCalledWith(expect.objectContaining({ targetId: "hina", assetIds: ["image-5"], expectedFingerprint: "fingerprint-hina", baselineFingerprint: "runtime", scanId: "scan-hina", decision: "accepted" })));
    await user.click(screen.getByRole("button", { name: "확정" }));
    expect(await screen.findByRole("option", { name: "이미지 5.webp" })).toBeInTheDocument();
  });

  it("fixes the review and evidence to the current character", async () => {
    const { api } = mount(); const user = userEvent.setup();
    const decide = vi.spyOn(api, "decide");
    await user.click(await screen.findByRole("option", { name: "이미지 5.webp" }));
    const panel = screen.getByRole("complementary", { name: "선택 이미지 판단" });
    expect(within(panel).queryByText("키사키")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "캐릭터 설정" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "후보 모두 승인" })).not.toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "거절" }));
    await waitFor(() => expect(decide).toHaveBeenCalledWith(expect.objectContaining({ targetId: "hina", decision: "rejected" })));
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
