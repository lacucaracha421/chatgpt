import userEvent from "@testing-library/user-event";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { openUrl } from "@tauri-apps/plugin-opener";
import { PrivacyProvider } from "../../privacy/PrivacyContext";
import type { AvGateway, AvPerformerProfile as Profile } from "../avTypes";
import { AvPerformerProfile, ProfileLinks, ProfileRows } from "./AvPerformerProfile";
import { AvPerformerPage } from "./AvPerformerPage";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function profile(overrides: Partial<Profile> = {}): Profile {
  return { personId: "p", source: "stashdb", status: "matched", stashdbId: "stash-1", name: "Name", aliases: ["Alias A", "Alias B", "Alias C", "Alias D"], birthDate: "2001-12-08", heightCm: 156, bandIn: 34, waistIn: 23, hipIn: 33, cup: "E", breastType: "NATURAL", careerStart: 2021, careerEnd: null, urls: [], images: [], candidates: [], fetchedAt: new Date().toISOString(), ...overrides };
}
function gateway(overrides: Partial<AvGateway> = {}): AvGateway {
  return { getStashdbCredentialStatus: vi.fn().mockResolvedValue({ configured: true }), getPerformerProfile: vi.fn().mockResolvedValue(profile()), refreshPerformerProfile: vi.fn().mockResolvedValue(profile()), searchPerformerProfile: vi.fn(), choosePerformerProfile: vi.fn(), dismissPerformerProfile: vi.fn(), getPerformer: vi.fn().mockImplementation(async (personId: string) => ({ person: { id: personId, displayName: personId, nameJa: "日本名", wikidataId: null, fanzaActressId: null, memo: null, portrait: null }, stats: { workCount: 0, firstRelease: null, lastRelease: null, averageScore: null }, works: [], coPerformers: [], labels: [] })), ...overrides } as unknown as AvGateway;
}
function panel(api: AvGateway, personId = "p", privacy = false) {
  return <PrivacyProvider privacyMode={privacy} setPrivacyMode={vi.fn()}><AvPerformerProfile personId={personId} api={api} /></PrivacyProvider>;
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

it("renders birthday age, centimetres, natural breasts and career; omits missing fields", () => {
  const { rerender } = render(<ProfileRows profile={profile()} today={new Date(2026, 8, 28)} />);
  expect(screen.getByText("만 24세")).toBeVisible();
  expect(screen.getByText("2001.12.8")).toBeVisible();
  expect(screen.getByText("156 cm")).toBeVisible();
  expect(screen.getByText("B86 (E) W58 H84")).toBeVisible();
  expect(screen.getByText("자연")).toBeVisible();
  expect(screen.getByText("5년차")).toBeVisible();
  rerender(<ProfileRows profile={profile({ birthDate: "2001", heightCm: null, bandIn: null, waistIn: null, hipIn: null, breastType: "FAKE", careerStart: 2010, careerEnd: 2023 })} />);
  expect(screen.getByText("2001")).toBeVisible(); expect(screen.queryByText(/만 \d+세/)).toBeNull();
  expect(screen.queryByText("사이즈")).toBeNull(); expect(screen.queryByText("키")).toBeNull();
  expect(screen.getByText("보형")).toBeVisible(); expect(screen.getByText("· 은퇴")).toBeVisible();
  rerender(<ProfileRows profile={profile({ birthDate: null, heightCm: null, bandIn: null, waistIn: null, hipIn: null, cup: null, breastType: "NA", careerStart: null })} />);
  expect(screen.queryByLabelText("프로필")).toBeNull();
});
it("uses the local birthday boundary and keeps partial month precision", () => {
  const { rerender } = render(<ProfileRows profile={profile()} today={new Date(2026, 11, 8)} />);
  expect(screen.getByText("만 25세")).toBeVisible();
  rerender(<ProfileRows profile={profile({ birthDate: "2001-12" })} />);
  expect(screen.getByText("2001.12")).toBeVisible(); expect(screen.queryByText(/만 \d+세/)).toBeNull();
});
it("sorts and deduplicates safe links, expands and collapses after five, and opens the chosen URL", async () => {
  const urls = [
    ["Other", "https://other.example"], ["Wikipedia", "https://en.wikipedia.org/wiki/Name"], ["Wikipedia", "https://ja.wikipedia.org/wiki/Name"], ["Studio Profile", "https://studio.example"], ["DMM / FANZA", "https://dmm.example"], ["Instagram", "https://instagram.com/name"], ["Twitter", "https://x.com/name"], ["Twitter", "https://x.com/name"], ["Unsafe", "javascript:alert(1)"],
  ].map(([name, url]) => ({ url, site: { name } }));
  render(<ProfileLinks profile={profile({ urls })} />);
  const links = screen.getByLabelText("배우 링크");
  expect(within(links).getAllByRole("button").map(b => b.textContent)).toEqual(["X", "Instagram", "FANZA", "공식", "위키", "+2"]);
  fireEvent.click(screen.getByRole("button", { name: "X" })); expect(openUrl).toHaveBeenCalledWith("https://x.com/name");
  fireEvent.click(screen.getByRole("button", { name: "링크 2개 더 보기" }));
  expect(within(links).getAllByRole("button")).toHaveLength(8); expect(screen.queryByText("Unsafe")).toBeNull();
  const collapse = within(links).getByRole("button", { name: "접기" });
  expect(collapse).toHaveAttribute("aria-expanded", "true");
  expect(within(links).getAllByRole("button")[7]).toBe(collapse);
  fireEvent.click(collapse);
  expect(within(links).getAllByRole("button").map(b => b.textContent)).toEqual(["X", "Instagram", "FANZA", "공식", "위키", "+2"]);
  expect(within(links).getByRole("button", { name: "링크 2개 더 보기" })).toHaveAttribute("aria-expanded", "false");
});
it("shows stored profile immediately then updates the page from background refresh", async () => {
  const pending = deferred<Profile>(); const api = gateway({ refreshPerformerProfile: vi.fn().mockReturnValue(pending.promise) });
  render(<PrivacyProvider privacyMode={false} setPrivacyMode={vi.fn()}><AvPerformerPage personId="p" api={api} onBack={vi.fn()} /></PrivacyProvider>);
  expect(await screen.findByText("156 cm")).toBeVisible();
  await waitFor(() => expect(api.refreshPerformerProfile).toHaveBeenCalledWith("p", false));
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "StashDB 프로필" }));
  expect(screen.getByRole("menuitem", { name: "StashDB 새로고침" })).toHaveAttribute("data-disabled");
  expect(screen.getByText("Name · Alias A · Alias B")).toBeVisible(); expect(screen.queryByText(/Alias D/)).toBeNull();
  await user.keyboard("{Escape}");
  await act(async () => pending.resolve(profile({ heightCm: 160 })));
  expect(screen.getByText("160 cm")).toBeVisible(); expect(screen.queryByText("156 cm")).toBeNull();
});
it("ignores background results after changing person and after unmount", async () => {
  const old = deferred<Profile>(); const api = gateway({ refreshPerformerProfile: vi.fn().mockImplementation(id => id === "p" ? old.promise : Promise.resolve(profile({ personId: "q", heightCm: 170 }))) });
  const { rerender, unmount } = render(panel(api));
  await waitFor(() => expect(api.refreshPerformerProfile).toHaveBeenCalledWith("p", false));
  rerender(panel(api, "q")); expect(await screen.findByText("170 cm")).toBeVisible();
  await act(async () => old.resolve(profile({ heightCm: 199 })));
  expect(screen.queryByText("199 cm")).toBeNull(); expect(screen.getByText("170 cm")).toBeVisible(); unmount();
});
it("with no key shows a settings link and never requests a refresh", async () => {
  const api = gateway({ getStashdbCredentialStatus: vi.fn().mockResolvedValue({ configured: false }) }); const settings = vi.fn();
  render(<PrivacyProvider privacyMode={false} setPrivacyMode={vi.fn()}><AvPerformerProfile personId="p" api={api} onOpenSettings={settings} /></PrivacyProvider>);
  expect(await screen.findByText(/StashDB 키가 없어요/)).toBeVisible(); expect(screen.queryByText("156 cm")).toBeNull();
  expect(api.refreshPerformerProfile).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "설정" })); expect(settings).toHaveBeenCalledOnce();
});
const candidates = [{ stashdbId: "a", name: "Candidate", aliases: ["Alias"], birthDate: "2000-01", imageUrl: "https://stashdb.org/images/a" }];
it("opens ambiguous candidates and stores the selected identity", async () => {
  const ambiguous = profile({ status: "ambiguous", candidates }); const api = gateway({ getPerformerProfile: vi.fn().mockResolvedValue(ambiguous), refreshPerformerProfile: vi.fn().mockResolvedValue(ambiguous), choosePerformerProfile: vi.fn().mockResolvedValue(profile({ heightCm: 165 })) });
  render(panel(api)); await waitFor(() => expect(screen.getByRole("button", { name: "고르기" })).toBeEnabled()); fireEvent.click(screen.getByRole("button", { name: "고르기" }));
  const dialog = screen.getByRole("dialog"); expect(within(dialog).getByText("Candidate")).toBeVisible(); expect(within(dialog).getByText("2000.1")).toBeVisible();
  expect(dialog.querySelector("img")).toHaveAttribute("src", "https://stashdb.org/images/a"); fireEvent.click(within(dialog).getByRole("button", { name: "이 사람" }));
  expect(await screen.findByText("165 cm")).toBeVisible(); expect(api.choosePerformerProfile).toHaveBeenCalledWith("p", "a");
});
it("hides candidate photos in privacy mode and stores none", async () => {
  const ambiguous = profile({ status: "ambiguous", candidates }); const api = gateway({ getPerformerProfile: vi.fn().mockResolvedValue(ambiguous), refreshPerformerProfile: vi.fn().mockResolvedValue(ambiguous), dismissPerformerProfile: vi.fn().mockResolvedValue(profile({ status: "none" })) });
  render(panel(api,"p",true)); await waitFor(() => expect(screen.getByRole("button", { name: "고르기" })).toBeEnabled()); fireEvent.click(screen.getByRole("button", { name: "고르기" }));
  expect(screen.getByRole("dialog").querySelector("img")).toBeNull(); fireEvent.click(screen.getByRole("button", { name: "아무도 아님" }));
  expect(await screen.findByText(/StashDB에서 못 찾았어요/)).toBeVisible(); expect(api.dismissPerformerProfile).toHaveBeenCalledWith("p");
});
it("searches fresh candidates to change a match, and forces manual refresh", async () => {
  const api = gateway({ searchPerformerProfile: vi.fn().mockResolvedValue(profile({ status: "ambiguous", candidates })) }); render(panel(api));
  await waitFor(() => expect(screen.getByRole("button", { name: "StashDB 새로고침" })).toBeEnabled()); fireEvent.click(screen.getByRole("button", { name: "StashDB 새로고침" }));
  await waitFor(() => expect(api.refreshPerformerProfile).toHaveBeenCalledWith("p",true));
  await waitFor(() => expect(screen.getByRole("button", { name: "다른 사람으로 바꾸기" })).toBeEnabled()); fireEvent.click(screen.getByRole("button", { name: "다른 사람으로 바꾸기" }));
  expect(await screen.findByRole("dialog")).toBeVisible(); expect(api.searchPerformerProfile).toHaveBeenCalledWith("p"); expect(screen.getByText("156 cm")).toBeVisible();
});
it("retains cached text when background refresh fails", async () => {
  render(panel(gateway({ refreshPerformerProfile: vi.fn().mockRejectedValue(new Error("offline")) })));
  expect(await screen.findByText(/StashDB 정보를 확인하지 못했습니다/)).toBeVisible(); expect(screen.getByText("156 cm")).toBeVisible();
});
it("shows the server-transfer fence message for an explicit refresh", async () => {
  const fenced = { code: "collection_authority_operation_unavailable", message: "서버 이전 후 다음 단계에서 다시 지원합니다." };
  const refresh = vi.fn().mockResolvedValueOnce(profile()).mockRejectedValueOnce(fenced);
  render(panel(gateway({ refreshPerformerProfile: refresh })));
  await waitFor(() => expect(screen.getByRole("button", { name: "StashDB 새로고침" })).toBeEnabled()); fireEvent.click(screen.getByRole("button", { name: "StashDB 새로고침" }));
  expect(await screen.findByText(/서버 이전 후 다음 단계에서 다시 지원합니다/)).toBeVisible(); expect(screen.getByText("156 cm")).toBeVisible();
});

it("keeps a stored StashDB portrait visible on the performer page", async () => {
  const api = gateway();
  vi.mocked(api.getPerformer).mockResolvedValue({ person: { id: "p", displayName: "배우", nameJa: null, wikidataId: null, fanzaActressId: null, memo: null, portrait: { kind: "stashdb", dataUrl: "data:image/jpeg;base64,stored", width: 1200, height: 1600, sourceUrl: "https://stashdb.org/images/photo" } }, stats: { workCount: 0, firstRelease: null, lastRelease: null, averageScore: null }, works: [], coPerformers: [], labels: [] });
  render(<PrivacyProvider privacyMode={false} setPrivacyMode={vi.fn()}><AvPerformerPage personId="p" api={api} onBack={vi.fn()} /></PrivacyProvider>);
  expect(await screen.findByRole("img", { name: "배우 대표 이미지" })).toHaveAttribute("src", "data:image/jpeg;base64,stored");
  expect(screen.queryByRole("button", { name: "대표 이미지 출처 열기" })).toBeNull();
  const change = screen.getByRole("button", { name: "사진 바꾸기" });
  expect(change).toHaveAttribute("title", "사진 출처: StashDB");
  expect(screen.getByLabelText("내 서재 통계")).toHaveTextContent(/^내 작품 0편 · 단독 0$/);
  api.listPortraitSources = vi.fn().mockResolvedValue([]);
  fireEvent.click(change);
  const picker = await screen.findByRole("dialog", { name: "배우 대표 이미지" });
  expect(within(picker).getByLabelText("현재 사진 출처")).toHaveTextContent("StashDB");
  fireEvent.click(within(picker).getByRole("button", { name: "대표 이미지 출처 열기" }));
  expect(openUrl).toHaveBeenCalledWith("https://stashdb.org/images/photo");
});


it("keeps refresh, identity selection and settings reachable in the compact profile menu", async () => {
  const api = gateway({ searchPerformerProfile: vi.fn().mockResolvedValue(profile({ status: "ambiguous", candidates })) });
  const settings = vi.fn(), user = userEvent.setup();
  render(<PrivacyProvider privacyMode={false} setPrivacyMode={vi.fn()}><AvPerformerProfile compact personId="p" api={api} onOpenSettings={settings}/></PrivacyProvider>);
  await waitFor(() => expect(api.refreshPerformerProfile).toHaveBeenCalledWith("p", false));
  await user.click(screen.getByRole("button", { name: "StashDB 프로필" }));
  await user.click(screen.getByRole("menuitem", { name: "StashDB 새로고침" }));
  await waitFor(() => expect(api.refreshPerformerProfile).toHaveBeenCalledWith("p", true));
  await user.click(screen.getByRole("button", { name: "StashDB 프로필" }));
  await user.click(screen.getByRole("menuitem", { name: "설정" }));
  expect(settings).toHaveBeenCalledOnce();
  await user.click(screen.getByRole("button", { name: "StashDB 프로필" }));
  await user.click(screen.getByRole("menuitem", { name: "다른 사람으로 바꾸기" }));
  expect(await screen.findByRole("dialog", { name: "StashDB 배우 고르기" })).toBeVisible();
  expect(api.searchPerformerProfile).toHaveBeenCalledWith("p");
});
