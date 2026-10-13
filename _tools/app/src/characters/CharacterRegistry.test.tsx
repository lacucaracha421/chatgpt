import { useState } from "react";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { CharacterRegistry, characterDraft } from "./CharacterRegistry";
import type { CharacterApi, CharacterTarget, ReferenceInspection } from "./api";

afterEach(cleanup);

const needed = /^인물 선택 \d+$/;

it("puts reference registration and crop checks first, folds rare settings under 관리, and preserves edits", async () => {
  const target: CharacterTarget = {
    id: "character", displayName: "이로하", seriesClassificationId: "series", linkedClassificationId: null,
    enabled: true, manualOnly: false, revision: 1, ready: true, fingerprint: "fingerprint", thumbnailAssetId: "portrait",
    references: Array.from({ length: 5 }, (_, slot) => ({ slot, assetId: `ref-${slot}`, assetHash: `hash-${slot}`, status: "ready" })),
  };
  const inspect = vi.fn(async (): Promise<ReferenceInspection[]> => target.references.map((ref, index) => ({
    assetId: ref.assetId!, contentHash: ref.assetHash, baselineFingerprint: "baseline", width: 200, height: 300,
    boxes: index === 0 ? [[0, 0, 100, 300], [100, 0, 200, 300]] : [[0, 0, 200, 300]],
    state: index === 0 ? "needs_region" : "single", selectedIndex: index === 0 ? null : 0,
    automaticIndex: null, suggestedIndex: null,
  })));
  const saved = vi.fn(), pick = vi.fn(), recommend = vi.fn();
  function Editor() {
    const [draft, setDraft] = useState(() => characterDraft(target));
    return <><CharacterRegistry target={target} draft={draft} seriesId="series" api={{ inspectReferenceRegions: inspect }}
      privacyMode={false} busy={false} error={null} onChange={setDraft} onPick={pick}
      onRecommendReferences={recommend} management={<button type="button">과거 미분류 이미지 갱신</button>} />
      <button type="button" onClick={() => saved(draft)}>저장</button></>;
  }
  render(<Editor />);
  const user = userEvent.setup();
  const confirm = await screen.findByRole("button", { name: needed });
  const management = screen.getByText("관리", { selector: "summary span" }).closest("details")!;
  expect(management).not.toHaveAttribute("open");
  expect(screen.queryByText("분류 안내")).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: /레퍼런스/ })).toBeVisible();
  const add = screen.getByRole("button", { name: "레퍼런스 추가" });
  for (const button of [add, confirm, screen.getByRole("button", { name: "추천으로 보강" }), screen.getByRole("button", { name: "레퍼런스 1 크롭 확인" })]) {
    expect(button).toBeVisible();
    expect(button.closest("details")).toBeNull();
    expect(button.compareDocumentPosition(management) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
  // Five references are below the automatic threshold, so one actionable line says so.
  expect(screen.getByRole("status")).toHaveTextContent("사용 가능 4장 · 6장 이상 권장");
  expect(screen.getByText("자동 인식 켜짐")).toBeVisible();
  // Rename, description, portrait and host maintenance live in the closed 관리 section.
  for (const control of [screen.getByLabelText("캐릭터 이름"), screen.getByLabelText("설명"), screen.getByRole("button", { name: "과거 미분류 이미지 갱신" })]) {
    expect(control.closest("details")).toBe(management);
    expect(control).not.toBeVisible();
  }
  expect(screen.getByAltText("대표 이미지")).not.toBeVisible();
  await user.click(confirm);
  expect(screen.getByRole("button", { name: "인물 영역 1 선택" })).toBeVisible();
  await user.click(confirm);
  await user.click(screen.getByText("관리"));
  await user.type(screen.getByLabelText("설명"), "설명 유지");
  await user.click(screen.getByText("관리"));
  await user.click(screen.getByText("관리"));
  expect(screen.getByLabelText("설명")).toHaveValue("설명 유지");
  expect(inspect).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "저장" }));
  expect(saved).toHaveBeenCalledWith(expect.objectContaining({ description: "설명 유지", thumbnail: "portrait" }));
  await user.click(add);
  expect(pick).toHaveBeenCalledWith("references");
  await user.click(screen.getByRole("button", { name: "추천으로 보강" }));
  expect(recommend).toHaveBeenCalledTimes(1);
});

it("distinguishes a saved manual region from an unsaved replacement", async () => {
  const bounds: [number, number, number, number] = [0, 0, 100, 300];
  const region = { contentHash: "hash", baselineFingerprint: "baseline", bounds };
  const target: CharacterTarget = {
    id: "character", displayName: "라라", seriesClassificationId: "series", linkedClassificationId: null,
    enabled: true, manualOnly: false, revision: 1, ready: false, fingerprint: "fingerprint",
    references: [{ slot: 0, assetId: "ref", assetHash: "hash", status: "ready", region }],
  };
  const inspect = vi.fn<NonNullable<CharacterApi["inspectReferenceRegions"]>>(async (_series, _target, _ids, regions = {}) => [{
    assetId: "ref", contentHash: "hash", baselineFingerprint: "baseline", width: 200, height: 300,
    boxes: [bounds, [100, 0, 200, 300]], state: "selected",
    selectedIndex: regions.ref.bounds[0] === 0 ? 0 : 1, automaticIndex: null, suggestedIndex: null,
  }]);
  const saved = vi.fn();
  function Editor() {
    const [draft, setDraft] = useState(() => characterDraft(target));
    return <><CharacterRegistry target={target} draft={draft} seriesId="series" api={{ inspectReferenceRegions: inspect }}
      privacyMode={false} busy={false} error={null} onChange={setDraft} onPick={() => {}} />
      <button type="button" onClick={() => saved(draft)}>저장</button></>;
  }
  const user = userEvent.setup();
  render(<Editor />);
  await user.click(await screen.findByRole("button", { name: "인물 영역" }));
  expect(screen.getByText("직접 지정 · 저장됨")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "레퍼런스 1 인물 영역 변경" }));
  await user.click(screen.getByRole("button", { name: "인물 영역 2 선택" }));
  expect(await screen.findByText("직접 지정 · 저장 전")).toBeVisible();
  expect(saved).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "저장" }));
  expect(saved).toHaveBeenCalledWith(expect.objectContaining({
    referenceRegions: { ref: { ...region, bounds: [100, 0, 200, 300] } },
  }));
});

it("edits both reference sources in one list without saving inactive images or losing active additions", async () => {
  const target: CharacterTarget = {
    id: "character", displayName: "Character", seriesClassificationId: "series", linkedClassificationId: null,
    enabled: true, manualOnly: false, revision: 1, ready: true, fingerprint: "fingerprint",
    references: [{ slot: 0, assetId: "base", assetHash: "a", status: "ready" }, { slot: 1, assetId: "trash", assetHash: "b", status: "ineligible" }],
    learnedReferences: [{ slot: 0, assetId: "added", assetHash: "c", status: "ready" }],
  };
  const saved = vi.fn();
  function Editor() {
    const [draft, setDraft] = useState(() => characterDraft(target));
    return <><CharacterRegistry target={target} draft={draft} onChange={setDraft} privacyMode={false} busy={false} error={null}
      onPick={() => {}} onOpenReference={() => {}} />
      <button type="button" onClick={() => saved(draft.references)}>저장</button></>;
  }
  render(<Editor />);
  const user = userEvent.setup();
  const list = screen.getByRole("region", { name: "레퍼런스 목록" });
  expect(within(list).getAllByRole("button", { name: /레퍼런스 \d 원본 보기/ })).toHaveLength(2);
  await user.click(screen.getByRole("button", { name: "저장" }));
  expect(saved).toHaveBeenLastCalledWith(["base", "added"]);
  await user.click(within(list).getByRole("button", { name: "레퍼런스 1 제거" }));
  await user.click(screen.getByRole("button", { name: "저장" }));
  expect(saved).toHaveBeenLastCalledWith(["added"]);
  await user.click(within(list).getByRole("button", { name: "레퍼런스 1 제거" }));
  await user.click(screen.getByRole("button", { name: "저장" }));
  expect(saved).toHaveBeenLastCalledWith([]);
});

it("opens one reference's crop from its strip tile, shows the crop in the tile, and closes after a choice", async () => {
  const target: CharacterTarget = {
    id: "character", displayName: "아루", seriesClassificationId: "series", linkedClassificationId: null,
    enabled: true, manualOnly: false, revision: 1, ready: true, fingerprint: "fingerprint",
    references: Array.from({ length: 6 }, (_, slot) => ({ slot, assetId: `ref-${slot}`, assetHash: `hash-${slot}`, status: "ready" })),
  };
  const inspect = vi.fn(async (_series: string, _target: string | null, ids: string[]): Promise<ReferenceInspection[]> => ids.map((id, index) => ({
    assetId: id, contentHash: `hash-${index}`, baselineFingerprint: "baseline", width: 200, height: 300,
    boxes: index === 1 ? [[0, 0, 100, 300], [100, 0, 200, 300]] : [[20, 30, 120, 230]],
    state: index === 1 ? "automatic" : "single", selectedIndex: index === 1 ? null : 0, automaticIndex: index === 1 ? 1 : null, suggestedIndex: null,
  })));
  const open = vi.fn();
  function Editor() {
    const [draft, setDraft] = useState(() => characterDraft(target));
    return <><CharacterRegistry target={target} draft={draft} seriesId="series" api={{ inspectReferenceRegions: inspect }}
      privacyMode={false} busy={false} error={null} onChange={setDraft} onPick={() => {}} onOpenReference={open} />
      <output aria-label="초안">{JSON.stringify(draft.referenceRegions)}</output></>;
  }
  render(<Editor />);
  const user = userEvent.setup();
  const tile = await screen.findByRole("button", { name: "레퍼런스 2 크롭 확인" });
  expect(tile).toHaveAttribute("aria-description", "자동 확인");
  // The tile draws only the crop in use (box 2 of reference 2), not the whole image.
  expect(tile.querySelector("svg")).toHaveAttribute("viewBox", "100 0 100 300");
  // Enough usable references: no shortfall line and no prompt.
  expect(screen.queryByText(/장 이상 권장/)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: needed })).not.toBeInTheDocument();
  await user.click(tile);
  expect(screen.getByText("2/6")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "원본 보기" }));
  expect(open).toHaveBeenCalledWith("ref-1");
  await user.click(screen.getByRole("button", { name: "인물 영역 1 선택" }));
  expect(screen.queryByRole("button", { name: /인물 영역 \d+ 선택/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "인물 영역 목록" })).not.toBeInTheDocument();
  expect(JSON.parse(screen.getByLabelText("초안").textContent ?? "{}")).toEqual({ "ref-1": { contentHash: "hash-1", baselineFingerprint: "baseline", bounds: [0, 0, 100, 300] } });
  // Keyboard reaches the same crop check.
  screen.getByRole("button", { name: "레퍼런스 1 크롭 확인" }).focus();
  await user.keyboard("{Enter}");
  expect(await screen.findByText("1/6")).toBeVisible();
});

it("keeps the person mark on a shared reference whose draft was the whole frame, and opens the chooser at the slot a refused save names", async () => {
  const frame: [number, number, number, number][] = [[1014, 55, 1470, 972], [0, 0, 1482, 2048]];
  const target: CharacterTarget = {
    id: "character", displayName: "다이아린", seriesClassificationId: "series", linkedClassificationId: null,
    enabled: true, manualOnly: false, revision: 1, ready: true, fingerprint: "fingerprint",
    references: Array.from({ length: 3 }, (_, slot) => ({ slot, assetId: `ref-${slot}`, assetHash: `hash-${slot}`, status: "ready" })),
  };
  // The third reference is shared with 자오; the whole frame is the draft the old suggestion produced.
  const wholeFrame = { contentHash: "hash-2", baselineFingerprint: "baseline", bounds: frame[1] };
  const inspect = vi.fn(async (): Promise<ReferenceInspection[]> => target.references.map((ref, index) => index < 2
    ? { assetId: ref.assetId!, contentHash: ref.assetHash, baselineFingerprint: "baseline", width: 200, height: 300, boxes: [[0, 0, 200, 300]], state: "single", selectedIndex: 0, automaticIndex: null, suggestedIndex: null }
    : { assetId: ref.assetId!, contentHash: ref.assetHash, baselineFingerprint: "baseline", width: 1482, height: 2048, boxes: frame, state: "needs_region", selectedIndex: null, automaticIndex: null, suggestedIndex: 1, otherCharacters: ["자오"] }));
  const message = "3번째 레퍼런스: 다른 캐릭터(자오)에 등록된 이미지입니다. 인물 영역을 지정하면 레퍼런스로 쓸 수 있습니다.";
  const draft = { ...characterDraft(target), referenceRegions: { "ref-2": wholeFrame } };
  render(<CharacterRegistry target={target} draft={draft} seriesId="series" api={{ inspectReferenceRegions: inspect }}
    privacyMode={false} busy={false} error={message} onChange={vi.fn()} onPick={vi.fn()} />);
  expect(await screen.findByRole("button", { name: "인물 영역 1 선택" })).toBeVisible();
  expect(screen.getByRole("alert")).toHaveTextContent(message);
  // Nothing was applied from the whole-frame draft: the mark stays and the count excludes it.
  const tile = screen.getByRole("button", { name: "레퍼런스 3 크롭 확인" }).parentElement!;
  expect(tile.querySelector(".character-reference-tile__mark")).not.toBeNull();
  expect(tile.querySelector(".character-reference-tile__mark")).toHaveClass("ui-badge--scrim");
  expect(screen.getByRole("button", { name: "인물 선택 1" })).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("사용 가능 2장");
});

const readyTarget = (count: number): CharacterTarget => ({
  id: "character", displayName: "아스나", seriesClassificationId: "series", linkedClassificationId: null,
  enabled: true, manualOnly: false, revision: 1, ready: true, fingerprint: "fingerprint",
  references: Array.from({ length: count }, (_, slot) => ({ slot, assetId: `ref-${slot}`, assetHash: `hash-${slot}`, status: "ready" })),
});
const row = (assetId: string, extra: Partial<ReferenceInspection> = {}): ReferenceInspection => ({
  assetId, contentHash: `hash-${assetId.slice(4)}`, baselineFingerprint: "baseline", width: 200, height: 300,
  boxes: [[0, 0, 200, 300]], state: "single", selectedIndex: 0, automaticIndex: null, suggestedIndex: null, ...extra });
const two: [number, number, number, number][] = [[0, 0, 100, 300], [100, 0, 200, 300]];

it("reserves the status slot and the shortfall line from the first render, and only their content changes", async () => {
  const target = readyTarget(4);
  let finish!: (rows: ReferenceInspection[]) => void;
  const inspect = vi.fn(() => new Promise<ReferenceInspection[]>(resolve => { finish = resolve; }));
  const view = render(<CharacterRegistry target={target} draft={characterDraft(target)} seriesId="series" api={{ inspectReferenceRegions: inspect }}
    privacyMode={false} busy={false} error={null} onChange={vi.fn()} onPick={vi.fn()} />);
  // First paint: the slot exists (empty), the hint carries the raw count, no mark, no button row.
  expect(view.container.querySelector(".character-registry__head .character-reference-slot")).not.toBeNull();
  expect(screen.getByRole("status")).toHaveTextContent("사용 가능 4장 · 6장 이상 권장");
  expect(view.container.querySelector(".character-reference-tile__mark")).toBeNull();
  expect(screen.queryByRole("button", { name: /인물 (선택|영역)/ })).not.toBeInTheDocument();
  const hint = screen.getByRole("status");
  await act(async () => finish([row("ref-0", { boxes: two, state: "needs_region", selectedIndex: null }), row("ref-1"), row("ref-2"), row("ref-3")]));
  // The same line element changed only its number; the slot now asks for one person.
  expect(screen.getByRole("status")).toBe(hint);
  expect(hint).toHaveTextContent("사용 가능 3장 · 6장 이상 권장");
  expect(screen.getByRole("button", { name: "인물 선택 1" })).toBeVisible();
});

it("marks a reference that needs a person with a person badge and an unusable one with a dimmed eye-slash badge", async () => {
  const target = readyTarget(5);
  const other = { otherCharacters: ["유이"], state: "needs_region", selectedIndex: null };
  const inspect = vi.fn(async (): Promise<ReferenceInspection[]> => [
    row("ref-0"),
    row("ref-1", { ...other, boxes: two }),
    row("ref-2", { ...other, boxes: [], state: "no_region" }),
    row("ref-3", { ...other, boxes: two, takenBoxes: two.map((_, index) => ({ index, character: "유이", targetId: "yui", source: "reference" as const })) }),
    row("ref-4"),
  ]);
  const view = render(<CharacterRegistry target={target} draft={characterDraft(target)} seriesId="series" api={{ inspectReferenceRegions: inspect }}
    privacyMode={false} busy={false} error={null} onChange={vi.fn()} onPick={vi.fn()} />);
  const tileOf = async (number: number) => (await screen.findByRole("button", { name: new RegExp(`레퍼런스 ${number} (크롭 확인|원본 보기)`) })).parentElement!;
  await screen.findByRole("button", { name: /^인물 선택 \d+$/ });
  const mark = (tile: HTMLElement) => tile.querySelector(".character-reference-tile__mark");
  expect(mark(await tileOf(1))).toBeNull();
  expect(mark(await tileOf(5))).toBeNull();
  // A person to choose: person icon; the full status stays in the tile's description.
  const person = await tileOf(2);
  expect(mark(person)).toHaveClass("ui-badge", "ui-badge--icon", "ui-badge--scrim");
  expect(person).not.toHaveClass("character-reference-tile--unusable");
  expect(within(person).getByRole("button", { name: "레퍼런스 2 크롭 확인" })).toHaveAttribute("aria-description", "다른 캐릭터(유이) 이미지 · 인물 지정 필요");
  // Nobody to choose (no person found, or every person belongs to another character): dimmed with an eye-slash badge.
  for (const number of [3, 4]) {
    const tile = await tileOf(number);
    expect(mark(tile)).toHaveClass("ui-badge--scrim");
    expect(tile).toHaveClass("character-reference-tile--unusable");
  }
  expect(view.container.querySelectorAll(".character-reference-tile__mark")).toHaveLength(3);
  expect(view.container.querySelector(".character-reference-tile__mark")?.textContent).toBe("");
});

it("opens the chooser from the slot at the first reference that needs a person, and from that tile", async () => {
  const target = readyTarget(3);
  const inspect = vi.fn(async (): Promise<ReferenceInspection[]> => [
    row("ref-0"), row("ref-1", { boxes: two, state: "needs_region", selectedIndex: null }), row("ref-2", { boxes: two, state: "needs_region", selectedIndex: null })]);
  render(<CharacterRegistry target={target} draft={characterDraft(target)} seriesId="series" api={{ inspectReferenceRegions: inspect }}
    privacyMode={false} busy={false} error={null} onChange={vi.fn()} onPick={vi.fn()} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "인물 선택 2" }));
  expect(screen.getByText("1/2")).toBeVisible();
  expect(screen.getByRole("region", { name: "인물 영역 확인" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "인물 선택 2" }));
  expect(screen.queryByRole("region", { name: "인물 영역 확인" })).not.toBeInTheDocument();
  // A tapped tile has no slot button to end it, so its chooser keeps 닫기.
  await user.click(screen.getByRole("button", { name: "레퍼런스 3 크롭 확인" }));
  expect(screen.getByText("2/2")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "닫기" }));
  expect(screen.queryByRole("region", { name: "인물 영역 확인" })).not.toBeInTheDocument();
});

it("opens the chooser on a reference the host names, but not for a request left over from an earlier visit", async () => {
  const target = readyTarget(3);
  const inspect = vi.fn(async (): Promise<ReferenceInspection[]> => [
    row("ref-0"), row("ref-1", { boxes: two, state: "needs_region", selectedIndex: null, otherCharacters: ["유이"] }), row("ref-2")]);
  const props = { target, draft: characterDraft(target), seriesId: "series", api: { inspectReferenceRegions: inspect }, privacyMode: false, busy: false, error: null, onChange: vi.fn(), onPick: vi.fn() };
  const view = render(<CharacterRegistry {...props} jumpRequest={{ assetId: "ref-1", key: 3 }} />);
  await screen.findByRole("button", { name: "인물 선택 1" });
  expect(screen.queryByRole("region", { name: "인물 영역 확인" })).not.toBeInTheDocument();
  view.rerender(<CharacterRegistry {...props} jumpRequest={{ assetId: "ref-1", key: 4 }} />);
  expect(await screen.findByRole("region", { name: "인물 영역 확인" })).toBeVisible();
  expect(screen.getByText("1/1")).toBeVisible();
});

it("paints the known marks and slot at once when the panel is reopened", async () => {
  const target = readyTarget(3);
  const inspect = vi.fn(async (): Promise<ReferenceInspection[]> => [
    row("ref-0"), row("ref-1", { boxes: two, state: "needs_region", selectedIndex: null }), row("ref-2")]);
  const api = { inspectReferenceRegions: inspect };
  const open = () => render(<CharacterRegistry target={target} draft={characterDraft(target)} seriesId="series" libraryKey="lib" api={api}
    privacyMode={false} busy={false} error={null} onChange={vi.fn()} onPick={vi.fn()} />);
  const first = open();
  await screen.findByRole("button", { name: "인물 선택 1" });
  first.unmount();
  const second = open();
  // No waiting: the slot, the mark and the usable count are there on the first render.
  expect(screen.getByRole("button", { name: "인물 선택 1" })).toBeVisible();
  expect(second.container.querySelectorAll(".character-reference-tile__mark")).toHaveLength(1);
  expect(screen.getByRole("status")).toHaveTextContent("사용 가능 2장");
  await waitFor(() => expect(inspect).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("button", { name: "인물 선택 1" })).toBeVisible();
});

it("orders the 관리 fields portrait, name, description, then the host's maintenance", () => {
  const target = readyTarget(1);
  render(<CharacterRegistry target={target} draft={characterDraft(target)} privacyMode={false} busy={false} error={null}
    onChange={vi.fn()} onPick={vi.fn()} management={<button type="button">과거 미분류 이미지 갱신</button>} />);
  const body = screen.getByText("관리", { selector: "summary span" }).closest("details")!;
  const portrait = body.querySelector(".character-portrait-editor")!;
  const name = within(body as HTMLElement).getByLabelText("캐릭터 이름");
  const description = within(body as HTMLElement).getByLabelText("설명");
  const maintenance = within(body as HTMLElement).getByRole("button", { name: "과거 미분류 이미지 갱신" });
  const before = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  expect(before(portrait, name)).toBe(true);
  expect(before(name, description)).toBe(true);
  expect(before(description, maintenance)).toBe(true);
});
