import { useState } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { CharacterRegistry, characterDraft } from "./CharacterRegistry";
import type { CharacterApi, CharacterTarget, ReferenceInspection } from "./api";

afterEach(cleanup);

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
  const confirm = await screen.findByRole("button", { name: "필요한 인물만 확인" });
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
  expect(screen.getByText("자동 분류 켜짐")).toBeVisible();
  // Rename, description, portrait and host maintenance live in the closed 관리 section.
  for (const control of [screen.getByLabelText("캐릭터 이름"), screen.getByLabelText("설명"), screen.getByRole("button", { name: "과거 미분류 이미지 갱신" })]) {
    expect(control.closest("details")).toBe(management);
    expect(control).not.toBeVisible();
  }
  expect(screen.getByAltText("대표 이미지")).not.toBeVisible();
  await user.click(confirm);
  expect(screen.getByRole("button", { name: "인물 영역 1 선택" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "닫기" }));
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
  await user.click(await screen.findByRole("button", { name: "인물 영역 조정" }));
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
  expect(screen.queryByRole("button", { name: "필요한 인물만 확인" })).not.toBeInTheDocument();
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
