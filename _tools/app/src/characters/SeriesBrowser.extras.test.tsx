import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { cloneElement } from "react";
import * as tauriCore from "@tauri-apps/api/core";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SeriesBrowser } from "./SeriesBrowser";
import type { CharacterTarget } from "./api";
import { createCharacterFixture, fixtureAssets, fixtureClassifications, fixtureTarget } from "./characterFixtures";
import { LibraryProvider } from "../library/LibraryContext";
import type { LibraryGateway } from "../library/types";
import type { CharacterGroup, CharacterHubApi } from "./hubApi";
import { emptyShadowSummary, type ShadowReviewApi } from "./shadowReviewApi";
import type { characterExtrasApi, ExtrasSuggestion } from "./extrasApi";
import type { ExtrasPromotionApi } from "./ExtrasPromotionDialog";

vi.mock("./suggestions/client", async importOriginal => {
  const actual = await importOriginal<typeof import("./suggestions/client")>();
  return { ...actual, suggestionApi: { ...actual.suggestionApi, list: async () => [], ignored: async () => [] } };
});
vi.mock("@tauri-apps/api/core", { spy: true });

beforeEach(() => { Object.defineProperties(HTMLElement.prototype, { clientWidth: { configurable: true, get: () => 850 }, clientHeight: { configurable: true, get: () => 650 } }); });
afterEach(() => { cleanup(); vi.mocked(tauriCore.invoke).mockReset(); vi.restoreAllMocks(); });

const extrasOf = (id: string, groupId: string | null): CharacterTarget => ({
  ...fixtureTarget(id, groupId ? "가방팟 기타" : "블루 아카이브 기타"),
  linkedClassificationId: null, enabled: false, manualOnly: true, references: [], ready: false, role: "extras", extrasGroupId: groupId,
});
const seriesExtras = extrasOf("extras-series", null);
const groupExtras = extrasOf("extras-group", "band");
const band: CharacterGroup = { id: "band", seriesId: "series", name: "가방팟", revision: 3, targetIds: ["hina"], extrasTargetId: "extras-group" };
// "abarai_renji" is in the tag-name table with a sure Korean name.
const suggestion = (assetIds: string[], tag = "abarai_renji"): ExtrasSuggestion => ({ tag, imageCount: assetIds.length, bothCount: assetIds.length, pixaiCount: assetIds.length, canaryCount: assetIds.length, assetIds });
const loaded = fixtureAssets.slice(5);

type Options = {
  targetId?: string; groupId?: string; groups?: CharacterGroup[]; extras?: CharacterTarget[];
  suggestions?: Record<string, ExtrasSuggestion[]>;
  preview?: Awaited<ReturnType<typeof characterExtrasApi.unregisterPreview>>;
  /** What a 기타's gallery read returns (default: the loaded images). */
  extrasItems?: typeof loaded;
  privacyMode?: boolean;
};
async function mount(options: Options = {}) {
  const api = createCharacterFixture();
  const targets = (await api.targets()).map(target => target);
  const extras = options.extras ?? [seriesExtras, groupExtras];
  vi.spyOn(api, "targets").mockResolvedValue([...targets, ...extras]);
  const browse = vi.fn(async (query: { targetId: string | null }) => {
    const items = query.targetId?.startsWith("extras") ? options.extrasItems ?? loaded : loaded;
    return { items, nextCursor: null, totalCount: items.length };
  });
  const requestReferenceRefresh = vi.fn(async (targetId: string) => ({ targetId, requestRevision: 1, state: "pending" as const, eligibleCount: 7 }));
  const hubApi = { seriesFolders: vi.fn().mockResolvedValue([]), browse, saveSeries: vi.fn(), series: vi.fn(), createManualCharacter: vi.fn(),
    completeReview: vi.fn().mockResolvedValue(1), setSeriesAssetExcluded: vi.fn(), excludedAssets: vi.fn().mockResolvedValue({ items: [], nextCursor: null, totalCount: 0 }),
    referenceCandidates: vi.fn(), confirmReferenceBatch: vi.fn(), requestReferenceRefresh } as unknown as CharacterHubApi;
  const shadowApi = { page: vi.fn(async () => ({ items: [], nextOffset: null, policyVersion: null, summary: emptyShadowSummary() })), start: vi.fn(), cancel: vi.fn(),
    status: vi.fn().mockResolvedValue({ running: false, preparing: false, total: 0, scored: 0, skipped: 0, cancelled: false, error: null }) } as unknown as ShadowReviewApi;
  const extrasApi = {
    suggestions: vi.fn(async (targetId: string) => options.suggestions?.[targetId] ?? []),
    ensure: vi.fn(async () => ({ ...extrasOf("extras-ensured", null) })),
    createGroup: vi.fn(), list: vi.fn(), promote: vi.fn(),
    unregisterPreview: vi.fn(async () => options.preview ?? { seriesId: "series", seriesName: "블루 아카이브", destinationId: "parent", destinationName: "게임", characterCount: 2, groupCount: 1, extrasImageCount: 4, collisions: [], refusal: null }),
    unregisterSeries: vi.fn(async () => ({ seriesId: "series", destinationId: "parent", movedCharacterCount: 2, movedGroupCount: 1 })),
  } as unknown as typeof characterExtrasApi;
  const promotionApi: ExtrasPromotionApi = {
    promote: vi.fn(async request => ({ target: { ...fixtureTarget("renji", request.displayName), manualOnly: false }, movedCount: request.assetIds.length, referenceCount: request.referenceAssetIds?.length ?? 0, recognition: (request.referenceAssetIds?.length ?? 0) >= 5 })),
    groups: vi.fn(async () => [{ ...band, revision: 4, targetIds: ["hina", "renji"] }, { id: "other", seriesId: "series", name: "라플라스", revision: 2, targetIds: [] }]),
    saveGroup: vi.fn(async () => undefined),
  };
  const navigate = vi.fn(), changed = vi.fn();
  const gateway = { listAssets: vi.fn().mockResolvedValue({ items: fixtureAssets, nextCursor: null }), openLibrary: vi.fn() } as unknown as LibraryGateway;
  const browser = <SeriesBrowser series={{ classificationId: "series", heroAssetId: null, autoClassify: true }} targetId={options.targetId} groupId={options.groupId}
    targets={targets} extras={extras} groups={options.groups ?? [band]} classifications={fixtureClassifications} galleryLayout="masonry" onGalleryLayoutChange={vi.fn()}
    privacyMode={options.privacyMode ?? false} onPrivacyModeChange={vi.fn()} metadataVisible onMetadataVisibleChange={vi.fn()} thumbnailRowHeight={180} onThumbnailRowHeightChange={vi.fn()}
    refreshVersion={0} onNavigate={navigate} onChanged={changed} api={api} hubApi={hubApi} shadowApi={shadowApi} extrasApi={extrasApi} promotionApi={promotionApi} />;
  const rendered = render(<LibraryProvider gateway={gateway}>{browser}</LibraryProvider>);
  const open = (targetId?: string, groupId?: string) => rendered.rerender(<LibraryProvider gateway={gateway}>{cloneElement(browser, { targetId, groupId })}</LibraryProvider>);
  return { api, extrasApi, promotionApi, hubApi, navigate, changed, open };
}

it("shows the 기타 card last among the character cards with the strongest suggestion in Korean", async () => {
  const { navigate } = await mount({ suggestions: { "extras-series": [suggestion(loaded.slice(0, 6).map(a => a.id))] } });
  const shelf = await screen.findByLabelText("캐릭터와 일반 폴더", {}, { timeout: 3000 }).catch(() => screen.findByLabelText("등록 캐릭터"));
  const buttons = within(shelf).getAllByRole("button").map(button => button.getAttribute("aria-label")).filter(label => !label?.endsWith("편집"));
  // 그룹 → 그룹 밖 캐릭터 → 기타 (the suggestion line sits on the card, after it in the DOM).
  expect(buttons.slice(0, 3)).toEqual(["가방팟 그룹 열기", "키사키 열기", "기타 열기"]);
  expect(await screen.findByRole("button", { name: "아바라이 렌지 6장 캐릭터로" })).toHaveTextContent("아바라이 렌지 6장 · 캐릭터로");
  fireEvent.click(screen.getByRole("button", { name: "기타 열기" }));
  expect(navigate).toHaveBeenCalledWith({ kind: "classification", classificationId: "series", characterId: "extras-series" });
});

it("fills the 기타 card with the first four of its own images, like a group card", async () => {
  const { hubApi } = await mount();
  const card = (await screen.findByRole("button", { name: "기타 열기" })).querySelector(".character-group-card__mosaic") as HTMLElement;
  await waitFor(() => expect(card.querySelectorAll("img")).toHaveLength(4));
  expect(card).toHaveAttribute("data-count", "4");
  expect([...card.querySelectorAll("img")].map(img => img.getAttribute("src"))).toEqual(loaded.slice(0, 4).map(asset => expect.stringContaining(`/thumbnail/${asset.id}`)));
  expect(hubApi.browse).toHaveBeenCalledWith(expect.objectContaining({ seriesId: "series", targetId: "extras-series", limit: 4, after: null }));
  expect(card.querySelector(".character-group-card__slot")).toBeNull();
});

it("shows a single neutral slot on a 기타 without images, and masks the images in privacy mode", async () => {
  const empty = await mount({ extrasItems: [] });
  const emptyCard = (await screen.findByRole("button", { name: "기타 열기" })).querySelector(".character-group-card__mosaic") as HTMLElement;
  await waitFor(() => expect(emptyCard.querySelector(".character-group-card__slot svg")).not.toBeNull());
  expect(emptyCard).toHaveAttribute("data-count", "1");
  expect(emptyCard.querySelectorAll("img")).toHaveLength(0);
  expect(empty.hubApi.browse).toHaveBeenCalledWith(expect.objectContaining({ targetId: "extras-series", limit: 4 }));
  cleanup();
  await mount({ privacyMode: true });
  const masked = (await screen.findByRole("button", { name: "기타 열기" })).querySelector(".character-group-card__mosaic") as HTMLElement;
  await waitFor(() => expect(masked.querySelectorAll(".privacy-mask")).toHaveLength(4));
  expect(masked.querySelectorAll("img")).toHaveLength(0);
});

it("shows no 기타 card until a bucket exists", async () => {
  await mount({ extras: [] });
  await screen.findByRole("button", { name: "키사키 열기" });
  expect(screen.queryByRole("button", { name: "기타 열기" })).not.toBeInTheDocument();
});

it("puts the group's own 기타 after its members on the group screen", async () => {
  await mount({ groupId: "band" });
  const shelf = await screen.findByLabelText("가방팟 그룹 캐릭터");
  const names = within(shelf).getAllByRole("button").map(button => button.getAttribute("aria-label"));
  expect(names).toEqual(["히나 열기", "히나 편집", "기타 열기"]);
});

it("opens a 기타 as a gallery titled 기타 with 캐릭터로 and without character controls", async () => {
  await mount({ targetId: "extras-series" });
  expect(await screen.findByRole("option", { name: "이미지 5.webp" })).toBeVisible();
  const title = screen.getByLabelText("시리즈 도구");
  expect(within(title).getAllByText("기타").length).toBeGreaterThan(0);
  expect(screen.queryByRole("button", { name: "캐릭터 편집" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "캐릭터 만들기" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "캐릭터 더보기" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "캐릭터로" })).toBeDisabled();
});

it("opens a card's suggestion with its images selected, then makes the character with the chosen images, name and references", async () => {
  const ids = loaded.slice(0, 7).map(a => a.id);
  const user = userEvent.setup();
  const { navigate, promotionApi, hubApi, changed, open } = await mount({ suggestions: { "extras-series": [suggestion(ids)] } });
  await user.click(await screen.findByRole("button", { name: "아바라이 렌지 7장 캐릭터로" }));
  expect(navigate).toHaveBeenCalledWith({ kind: "classification", classificationId: "series", characterId: "extras-series" });
  open("extras-series");
  const tile = await screen.findByRole("option", { name: "이미지 5.webp" });
  await waitFor(() => expect(tile).toHaveAttribute("aria-selected", "true"));
  // The person removes one by selecting it in the grid (Ctrl+click toggles).
  fireEvent.click(screen.getByRole("option", { name: "이미지 11.webp" }), { ctrlKey: true });
  await waitFor(() => expect(screen.getByRole("option", { name: "이미지 11.webp" })).toHaveAttribute("aria-selected", "false"));
  await user.click(screen.getByRole("button", { name: "캐릭터로" }));

  const dialog = await screen.findByRole("dialog", { name: "캐릭터로" });
  expect(within(dialog).getByRole("textbox", { name: "이름" })).toHaveValue("아바라이 렌지");
  expect(within(dialog).getByRole("combobox", { name: "그룹" })).toHaveValue("");
  await user.click(within(dialog).getByRole("button", { name: "이미지 2 대표 이미지로" }));
  // Unchecking a reference leaves four of the six images checked.
  await user.click(within(dialog).getByRole("button", { name: "이미지 1 레퍼런스 해제" }));
  await user.click(within(dialog).getByRole("button", { name: "이미지 1 레퍼런스" }));
  await user.click(within(dialog).getByRole("button", { name: "만들기" }));

  const chosen = ids.slice(0, 6);
  await waitFor(() => expect(promotionApi.promote).toHaveBeenCalledOnce());
  expect(promotionApi.promote).toHaveBeenCalledWith({
    targetId: "extras-series", expectedFingerprint: "fingerprint-extras-series", displayName: "아바라이 렌지",
    assetIds: chosen, thumbnailAssetId: chosen[1], tag: "abarai_renji",
    // Five images spread over the six, in list order.
    referenceAssetIds: [chosen[0], chosen[1], chosen[3], chosen[4], chosen[5]],
  });
  // Completion: moved count, recognition state and the older-images refresh.
  const done = await screen.findByRole("dialog", { name: "캐릭터를 만들었어요" });
  expect(done).toHaveTextContent("아바라이 렌지");
  expect(done).toHaveTextContent("기타에서 6장을 옮겼어요.");
  expect(done).toHaveTextContent("자동 인식 켜짐");
  expect(changed).toHaveBeenCalled();
  await user.click(within(done).getByRole("button", { name: "과거 미분류 이미지 갱신" }));
  await waitFor(() => expect(hubApi.requestReferenceRefresh).toHaveBeenCalledWith("renji", 1));
  expect(await within(done).findByText(/미분류 이미지 7개 갱신을 예약했습니다/)).toBeVisible();
});

it("starts a character with fewer than five references manually and says how many it has", async () => {
  const user = userEvent.setup();
  const { promotionApi } = await mount({ targetId: "extras-series" });
  await screen.findByRole("option", { name: "이미지 5.webp" });
  fireEvent.click(screen.getByRole("option", { name: "이미지 5.webp" }), { ctrlKey: true });
  fireEvent.click(screen.getByRole("option", { name: "이미지 6.webp" }), { ctrlKey: true });
  fireEvent.click(screen.getByRole("option", { name: "이미지 7.webp" }), { ctrlKey: true });
  await user.click(screen.getByRole("button", { name: "캐릭터로" }));
  const dialog = await screen.findByRole("dialog", { name: "캐릭터로" });
  expect(within(dialog).getByRole("textbox", { name: "이름" })).toHaveValue("");
  expect(within(dialog).getByRole("button", { name: "만들기" })).toBeDisabled();
  await user.type(within(dialog).getByRole("textbox", { name: "이름" }), "렌");
  expect(dialog).toHaveTextContent("레퍼런스가 5장 미만이라 수동으로 시작합니다.");
  await user.click(within(dialog).getByRole("button", { name: "만들기" }));
  await waitFor(() => expect(promotionApi.promote).toHaveBeenCalledWith(expect.objectContaining({ displayName: "렌", tag: null, referenceAssetIds: loaded.slice(0, 3).map(a => a.id) })));
  const done = await screen.findByRole("dialog", { name: "캐릭터를 만들었어요" });
  expect(done).toHaveTextContent("수동으로 시작 (레퍼런스 3/5)");
  expect(within(done).queryByRole("button", { name: "과거 미분류 이미지 갱신" })).not.toBeInTheDocument();
});

it("selects the images of a name the automatic tags read and keeps an unsure Korean spelling selected for checking", async () => {
  const user = userEvent.setup();
  const ids = loaded.slice(0, 5).map(a => a.id);
  await mount({ targetId: "extras-series", suggestions: { "extras-series": [suggestion(ids, "abby_(wuthering_waves)")] } });
  await user.click(await screen.findByRole("button", { name: "애비 5장" }));
  await waitFor(() => expect(screen.getByRole("option", { name: "이미지 5.webp" })).toHaveAttribute("aria-selected", "true"));
  await user.click(screen.getByRole("button", { name: "캐릭터로" }));
  const dialog = await screen.findByRole("dialog", { name: "캐릭터로" });
  const name = within(dialog).getByRole("textbox", { name: "이름" }) as HTMLInputElement;
  expect(name).toHaveValue("애비");
  expect(dialog).toHaveTextContent("한국어 이름이 확실하지 않아요");
  await waitFor(() => expect(name.selectionStart === 0 && name.selectionEnd === 2).toBe(true));
});

it("moves the new character to another group after it is made, leaving the 기타's group", async () => {
  const user = userEvent.setup();
  const other: CharacterGroup = { id: "other", seriesId: "series", name: "라플라스", revision: 2, targetIds: [] };
  const { promotionApi } = await mount({ targetId: "extras-group", groups: [band, other] });
  await screen.findByRole("option", { name: "이미지 5.webp" });
  fireEvent.click(screen.getByRole("option", { name: "이미지 5.webp" }), { ctrlKey: true });
  await user.click(screen.getByRole("button", { name: "캐릭터로" }));
  const dialog = await screen.findByRole("dialog", { name: "캐릭터로" });
  const group = within(dialog).getByRole("combobox", { name: "그룹" });
  expect(group).toHaveValue("band");
  await user.selectOptions(group, "other");
  await user.type(within(dialog).getByRole("textbox", { name: "이름" }), "렌");
  await user.click(within(dialog).getByRole("button", { name: "만들기" }));
  await screen.findByRole("dialog", { name: "캐릭터를 만들었어요" });
  expect(promotionApi.saveGroup).toHaveBeenCalledWith(expect.objectContaining({ id: "band", expectedRevision: 4, targetIds: ["hina"] }));
  expect(promotionApi.saveGroup).toHaveBeenCalledWith(expect.objectContaining({ id: "other", expectedRevision: 2, targetIds: ["renji"] }));
});

it("takes images out of a 기타 as a plain removal", async () => {
  const user = userEvent.setup();
  const { api } = await mount({ targetId: "extras-series" });
  const decide = vi.spyOn(api, "decide");
  await screen.findByRole("option", { name: "이미지 5.webp" });
  fireEvent.click(screen.getByRole("option", { name: "이미지 5.webp" }), { ctrlKey: true });
  await user.click(await screen.findByRole("button", { name: "기타에서 빼기" }));
  await waitFor(() => expect(decide).toHaveBeenCalledWith(expect.objectContaining({ targetId: "extras-series", decision: "cleared", assetIds: [loaded[0].id] })));
});

it("adds selected images to a 기타 through the picker, creating the bucket on first use", async () => {
  const user = userEvent.setup();
  const { api, extrasApi, changed } = await mount({ extras: [] });
  const decideBatch = vi.spyOn(api, "decideBatch");
  vi.spyOn(api, "targets").mockResolvedValue([...(await api.targets()), extrasOf("extras-ensured", null)]);
  fireEvent.click(await screen.findByRole("option", { name: "이미지 5.webp" }), { ctrlKey: true });
  await user.click(within(await screen.findByRole("toolbar", { name: "선택 작업" })).getByRole("button", { name: "캐릭터 지정" }));
  // One 기타 row for the group, one (the last) for the series.
  const picker = await screen.findByRole("listbox", { name: "캐릭터에 넣기" });
  const rows = await within(picker).findAllByRole("option", { name: /^기타/ });
  expect(rows).toHaveLength(2);
  await user.click(rows[1]!);
  await waitFor(() => expect(extrasApi.ensure).toHaveBeenCalledWith("series", null));
  await waitFor(() => expect(decideBatch).toHaveBeenCalledWith([expect.objectContaining({ targetId: "extras-ensured", decision: "accepted", assetIds: [loaded[0].id] })]));
  await waitFor(() => expect(changed).toHaveBeenCalled());
});

it("explains where a series' characters go and unregisters it on confirm", async () => {
  const user = userEvent.setup();
  const { extrasApi, changed, navigate } = await mount();
  await user.click(await screen.findByRole("button", { name: "시리즈 더보기" }));
  await user.click(await screen.findByRole("menuitem", { name: "시리즈 등록 해제" }));
  const dialog = await screen.findByRole("dialog", { name: "시리즈 등록 해제" });
  expect(await within(dialog).findByText(/캐릭터 2명 · 그룹 1개 · 기타 이미지 4장이 ‘게임’ 시리즈로 옮겨집니다/)).toBeVisible();
  await user.click(within(dialog).getByRole("button", { name: "등록 해제" }));
  await waitFor(() => expect(extrasApi.unregisterSeries).toHaveBeenCalledWith("series"));
  expect(await within(dialog).findByText(/캐릭터 2명 · 그룹 1개을 ‘게임’로 옮겼어요/)).toBeVisible();
  expect(changed).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole("button", { name: "확인" }));
  expect(changed).toHaveBeenCalled();
  expect(navigate).toHaveBeenCalledWith({ kind: "classification", classificationId: "parent" });
});

it("shows a refusal or name collision as the reason and keeps the unregister button off", async () => {
  const user = userEvent.setup();
  const { extrasApi } = await mount({ preview: { seriesId: "series", seriesName: "블루 아카이브", destinationId: "parent", destinationName: "게임", characterCount: 2, groupCount: 0, extrasImageCount: 0, collisions: ["히나"], refusal: "「게임」에 같은 이름이 이미 있어 등록을 해제할 수 없습니다: 히나." } });
  await user.click(await screen.findByRole("button", { name: "시리즈 더보기" }));
  await user.click(await screen.findByRole("menuitem", { name: "시리즈 등록 해제" }));
  const dialog = await screen.findByRole("dialog", { name: "시리즈 등록 해제" });
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("같은 이름이 이미 있어 등록을 해제할 수 없습니다: 히나.");
  expect(within(dialog).getByRole("button", { name: "등록 해제" })).toBeDisabled();
  expect(extrasApi.unregisterSeries).not.toHaveBeenCalled();
});

const soloExtras = extrasOf("extras-solo", "solo");
const solo: CharacterGroup = { id: "solo", seriesId: "series", name: "신입 조사원", revision: 1, targetIds: [], extrasTargetId: "extras-solo" };

it("opens a group that has only a 기타 straight to the 기타 gallery under the group's own title", async () => {
  const user = userEvent.setup();
  const ids = loaded.slice(0, 6).map(a => a.id);
  const { api, hubApi } = await mount({ groupId: "solo", groups: [band, solo], extras: [seriesExtras, groupExtras, soloExtras], suggestions: { "extras-solo": [suggestion(ids)] } });
  expect(await screen.findByRole("option", { name: "이미지 5.webp" })).toBeVisible();
  const title = screen.getByLabelText("시리즈 도구");
  expect(within(title).getByText("신입 조사원")).toBeVisible();
  expect(within(title).queryByText("기타")).not.toBeInTheDocument();
  // No shelf and no 기타 card: the gallery is the 기타's own, read once.
  expect(screen.queryByRole("button", { name: "기타 열기" })).not.toBeInTheDocument();
  expect(screen.queryByLabelText("신입 조사원 그룹 캐릭터")).not.toBeVisible(); // kept mounted for the group editor, but hidden
  expect(hubApi.browse).toHaveBeenCalledWith(expect.objectContaining({ targetId: "extras-solo", groupId: null }));
  expect(hubApi.browse).not.toHaveBeenCalledWith(expect.objectContaining({ groupId: "solo" }));
  // The 기타 gallery's own actions: 캐릭터로, the name chips and 기타에서 빼기.
  expect(screen.getByRole("button", { name: "캐릭터로" })).toBeDisabled();
  // The group menu stays: 그룹 편집 opens the group's editor even though the shelf is not shown.
  await user.click(screen.getByRole("button", { name: "그룹 더보기" }));
  await user.click(await screen.findByRole("menuitem", { name: "그룹 편집" }));
  const editor = await screen.findByRole("dialog", { name: "캐릭터 그룹 편집" });
  expect(within(editor).getByRole("textbox", { name: "그룹 이름" })).toHaveValue("신입 조사원");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "캐릭터 그룹 편집" })).not.toBeInTheDocument());
  await user.click(await screen.findByRole("button", { name: "아바라이 렌지 6장" }));
  await waitFor(() => expect(screen.getByRole("option", { name: "이미지 5.webp" })).toHaveAttribute("aria-selected", "true"));
  expect(screen.getByRole("button", { name: "캐릭터로" })).toBeEnabled();
  const decide = vi.spyOn(api, "decide");
  await user.click(await screen.findByRole("button", { name: "기타에서 빼기" }));
  await waitFor(() => expect(decide).toHaveBeenCalledWith(expect.objectContaining({ targetId: "extras-solo", decision: "cleared" })));
});

it("keeps the group screen with its shelf once the group has a member", async () => {
  await mount({ groupId: "solo", groups: [band, { ...solo, targetIds: ["hina"] }], extras: [seriesExtras, groupExtras, soloExtras] });
  const shelf = await screen.findByLabelText("신입 조사원 그룹 캐릭터");
  expect(within(shelf).getByRole("button", { name: "기타 열기" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "캐릭터로" })).not.toBeInTheDocument();
});
