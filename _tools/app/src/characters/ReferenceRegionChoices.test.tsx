import { act, cleanup, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { useCallback, useState, type ComponentProps } from "react";
import { ReferenceCheckSlot, ReferenceRegionChoices, AUTOMATIC_CHARACTER_REFERENCE_COUNT, usableReferenceCount, automaticReferenceCount, blockedSaveReferences, personChoiceCount, referenceNeedsPerson, useReferenceRegionInspection, withDraftChoices, type ReferenceRegionInspection, type ReferenceRequest, type ReferenceWorkflow } from "./ReferenceRegionChoices";
import type { CharacterApi, ReferenceInspection, ReferenceRegions } from "./api";
import { fixtureTarget } from "./characterFixtures";

afterEach(cleanup);

const multi = [[10, 20, 110, 220], [200, 40, 380, 520]] as [number, number, number, number][];

const inspection = (assetId: string, state: string, boxes: [number, number, number, number][] = [[10, 20, 110, 220]], automaticIndex: number | null = state === "automatic" ? 0 : null): ReferenceInspection =>
  ({ assetId, contentHash: `hash-${assetId}`, baselineFingerprint: "baseline", width: 400, height: 600, boxes,
    selectedIndex: null, suggestedIndex: null, automaticIndex, state });

const box = (assetId: string, bounds: [number, number, number, number]) => ({ contentHash: `hash-${assetId}`, baselineFingerprint: "baseline", bounds });

const needed = /^인물 선택 \d+$/;

/** The status slot and the chooser it opens, wired the way the character panel wires them. */
function Panel({ inspection, ...props }: Omit<ComponentProps<typeof ReferenceRegionChoices>, "request" | "inspection"> & { inspection: ReferenceRegionInspection }) {
  const [request, setRequest] = useState<ReferenceRequest | null>(null);
  const [workflow, setWorkflow] = useState<ReferenceWorkflow>(null);
  return <>
    <ReferenceCheckSlot inspection={inspection} active assetIds={props.assetIds} draftRegions={props.draftRegions} busy={false} expanded={workflow}
      onRequest={kind => setRequest(old => ({ kind, key: (old?.key ?? 0) + 1 }))} />
    <ReferenceRegionChoices {...props} inspection={inspection} request={request} onModeChange={setWorkflow} />
  </>;
}

/** Renders the slot and the section and exposes the draft they own. */
function Harness({ initial = {}, assetIds, respond, decisionApi }: {
  initial?: ReferenceRegions; assetIds: string[];
  respond: (ids: string[], regions: ReferenceRegions) => Promise<ReferenceInspection[]>;
  decisionApi?: Pick<CharacterApi, "targets" | "decide">;
  /** Both ways of owning the inspection reach the same section now; kept for the parametrised tests. */
  shared?: boolean;
}) {
  const [draft, setDraft] = useState<ReferenceRegions>(initial);
  const inspect = useCallback<NonNullable<CharacterApi["inspectReferenceRegions"]>>(
    (_series, _target, ids, regions) => respond(ids, regions ?? {}), [respond]);
  const inspection = useReferenceRegionInspection({ seriesId: "series", targetId: "hina", assetIds, draftRegions: draft, api: inspect });
  return <>
    <Panel assetIds={assetIds} draftRegions={draft} privacyMode={false} busy={false}
      inspection={inspection} decisionApi={decisionApi} onChange={setDraft} />
    <output aria-label="초안">{JSON.stringify(draft)}</output>
  </>;
}

/** Opens the crop list: from the slot when nothing is asked, otherwise through the opened shortfall workflow. */
async function openCorrection(user: ReturnType<typeof userEvent.setup>) {
  const entry = await screen.findByRole("button", { name: /^(인물 영역|인물 선택 \d+)$/ });
  const asked = needed.test(entry.textContent ?? "");
  await user.click(entry);
  if (asked) await user.click(await screen.findByRole("button", { name: "인물 영역 조정" }));
}

const draft = () => JSON.parse(screen.getByLabelText("초안").textContent ?? "{}") as ReferenceRegions;
const boxButtons = () => screen.queryAllByRole("button", { name: /인물 영역 \d+ 선택/ });
const six = ["a", "b", "c", "d", "e", "f"];

it("distinguishes saved choices, unsaved choices, automatic crops and unresolved or stale references", async () => {
  const manual = box("a", multi[1]);
  const unsaved = box("b", multi[0]);
  const stale = box("e", multi[0]);
  const rows = [
    { ...inspection("a", "selected", multi), selectedIndex: 1 },
    { ...inspection("b", "selected", multi), selectedIndex: 0 },
    inspection("c", "automatic", multi, 1),
    inspection("d", "needs_region", multi),
    inspection("e", "stale_region", multi),
  ];
  const onChange = vi.fn();
  render(<Panel assetIds={["a", "b", "c", "d", "e"]}
    draftRegions={{ a: manual, b: unsaved, e: stale }} savedRegions={{ a: manual, e: stale }}
    privacyMode={false} busy={false} inspection={{ inspections: rows, error: null }} onChange={onChange} />);
  const user = userEvent.setup();
  await openCorrection(user);
  expect(within(screen.getByRole("region", { name: "인물 영역 목록" })).getAllByRole("group")
    .map(card => card.getAttribute("aria-label")?.split(" · ")[0]))
    .toEqual(["레퍼런스 1", "레퍼런스 2", "레퍼런스 3", "레퍼런스 4", "레퍼런스 5"]);
  const savedCard = screen.getByRole("group", { name: "레퍼런스 1 · 직접 지정 · 저장됨" });
  expect(within(savedCard).getByText("직접 지정 · 저장됨")).toBeVisible();
  expect(savedCard.querySelector("rect")).toHaveAttribute("x", "200");
  expect(savedCard.querySelector("rect")).toHaveAttribute("width", "180");
  expect(screen.getByRole("group", { name: "레퍼런스 2 · 직접 지정 · 저장 전" })).toBeVisible();
  expect(screen.getByRole("group", { name: "레퍼런스 3 · 자동 확인" })).toBeVisible();
  const unresolved = screen.getByRole("group", { name: "레퍼런스 4 · 인물 확인 필요 · 미사용" });
  expect(unresolved.querySelector("rect")).toBeNull();
  expect(within(unresolved).getByText("인물 선택")).toBeVisible();
  const staleCard = screen.getByRole("group", { name: "레퍼런스 5 · 직접 지정 · 재확인 필요" });
  expect(staleCard.querySelector("rect")).toBeNull();
  expect(onChange).not.toHaveBeenCalled();

  await user.click(within(savedCard).getByRole("button"));
  expect(screen.getByRole("button", { name: "인물 영역 1 선택" })).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByRole("button", { name: "인물 영역 2 선택" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByText("직접 지정한 인물")).toBeVisible();
});

it("marks an automatic crop as automatic rather than a manual confirmation", async () => {
  const rows = [inspection("a", "automatic", multi, 1)];
  const onChange = vi.fn();
  render(<Panel assetIds={["a"]} draftRegions={{}}
    privacyMode={false} busy={false} inspection={{ inspections: rows, error: null }} onChange={onChange} />);
  const user = userEvent.setup();
  await openCorrection(user);
  await user.click(screen.getByRole("button", { name: "레퍼런스 1 인물 영역 변경" }));
  expect(screen.getByRole("button", { name: "인물 영역 2 선택" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByText("자동 선택된 인물")).toBeVisible();
  expect(screen.queryByText("직접 지정한 인물")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "인물 영역 2 선택" }));
  expect(onChange).toHaveBeenCalledWith({ a: box("a", multi[1]) });
});

it("stays completely quiet when six usable references leave nothing to ask", async () => {
  const api = vi.fn(async () => six.map(id => inspection(id, "single")));
  render(<Harness assetIds={six} respond={api} />);
  await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
  // Nothing required, nothing chosen, no inferred common person: no section at all.
  expect(screen.queryByRole("region", { name: "인물 영역 확인" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: needed })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /인물 영역 \d+ 선택/ })).not.toBeInTheDocument();
  expect(draft()).toEqual({});
});

it("does not render the correction list by default even when unresolved references exist alongside six usable ones", async () => {
  const api = vi.fn(async () => [...six.map(id => inspection(id, "single")), inspection("g", "needs_region", multi)]);
  render(<Harness assetIds={[...six, "g"]} respond={api} />);
  await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
  // Enough usable references: neither the shortfall workflow nor the reference list shows.
  expect(screen.queryByRole("button", { name: needed })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /인물 영역 \d+ 선택/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "인물 영역 목록" })).not.toBeInTheDocument();
  expect(screen.queryByText(/골라 주세요/)).not.toBeInTheDocument();
  // Correction stays reachable, but only as an explicit action.
  expect(screen.getByRole("button", { name: "인물 영역" })).toBeInTheDocument();
});

it("offers the shortfall workflow quietly and opens the chooser only on click", async () => {
  const api = vi.fn(async () => [inspection("a", "single"), inspection("b", "needs_region", multi)]);
  const user = userEvent.setup();
  render(<Harness assetIds={["a", "b"]} respond={api} />);
  expect(await screen.findByRole("button", { name: needed })).toBeInTheDocument();
  expect(boxButtons()).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: needed }));
  expect(await screen.findByRole("button", { name: "인물 영역 1 선택" })).toBeInTheDocument();
  // The same slot button closes it again: there is no 닫기 button for the shortfall workflow.
  expect(screen.getByRole("button", { name: needed })).toHaveAttribute("aria-expanded", "true");
  expect(screen.queryByRole("button", { name: "닫기" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: needed }));
  expect(boxButtons()).toHaveLength(0);
  expect(screen.getByRole("button", { name: needed })).toHaveAttribute("aria-expanded", "false");
});

it("toggles the crop list from the 인물 영역 button and has no 닫기 button for it", async () => {
  const api = vi.fn(async () => [...six.map(id => inspection(id, "single")), inspection("g", "automatic", multi, 1)]);
  const user = userEvent.setup();
  render(<Harness assetIds={[...six, "g"]} respond={api} />);
  const toggle = await screen.findByRole("button", { name: "인물 영역" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  await user.click(toggle);
  expect(await screen.findByRole("region", { name: "인물 영역 목록" })).toBeVisible();
  expect(screen.getByRole("button", { name: "인물 영역" })).toHaveAttribute("aria-expanded", "true");
  expect(screen.queryByRole("button", { name: "닫기" })).not.toBeInTheDocument();
  // Choosing a reference keeps the list open; the chooser has no 닫기 either, only the toggle ends it.
  await user.click(screen.getByRole("button", { name: "레퍼런스 7 인물 영역 변경" }));
  expect(screen.queryByRole("button", { name: "닫기" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "인물 영역" }));
  expect(screen.queryByRole("region", { name: "인물 영역 목록" })).not.toBeInTheDocument();
  expect(boxButtons()).toHaveLength(0);
  expect(screen.getByRole("button", { name: "인물 영역" })).toHaveAttribute("aria-expanded", "false");
});

it("closes the required workflow by itself when reinspection reaches six usable references", async () => {
  // Start with five usable plus two unresolved. Resolving the sixth reference lifts the
  // usable count to the threshold, which ends the required workflow.
  const api = vi.fn(async (_ids: string[], regions: ReferenceRegions) => [
    ...["a", "b", "c", "d", "e"].map(id => inspection(id, "single")),
    regions.f ? inspection("f", "selected") : inspection("f", "needs_region", multi),
    inspection("h", "needs_region", multi),
  ]);
  const user = userEvent.setup();
  render(<Harness assetIds={[...six, "h"]} respond={api} />);
  const prompt = await screen.findByRole("button", { name: needed });
  await user.click(prompt);
  expect(screen.getByText("1/2")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "인물 영역 1 선택" }));
  // Six usable references are reached, so the required workflow ends and the chooser closes.
  await waitFor(() => expect(draft()).toEqual({ f: box("f", [10, 20, 110, 220]) }));
  await waitFor(() => expect(boxButtons()).toHaveLength(0));
  expect(screen.queryByRole("button", { name: needed })).not.toBeInTheDocument();
  // The remaining unresolved reference is still correctable, but only on request.
  await openCorrection(user);
  const summary = await screen.findByRole("region", { name: "인물 영역 목록" });
  await user.click(within(summary).getByRole("button", { name: "레퍼런스 7 인물 영역 변경" }));
  expect(await screen.findByRole("button", { name: "인물 영역 1 선택" })).toBeInTheDocument();
});

it("keeps the required workflow open while the count is still short", async () => {
  const api = vi.fn(async (_ids: string[], regions: ReferenceRegions) => [
    inspection("a", "single"),
    regions.b ? inspection("b", "selected") : inspection("b", "needs_region", multi),
    inspection("c", "needs_region", multi),
  ]);
  const user = userEvent.setup();
  render(<Harness assetIds={["a", "b", "c"]} respond={api} />);
  await user.click(await screen.findByRole("button", { name: needed }));
  await user.click(await screen.findByRole("button", { name: "인물 영역 1 선택" }));
  // Two usable references are still short, so the workflow continues on the next reference.
  await waitFor(() => expect(boxButtons()).toHaveLength(2));
  expect(screen.getByText("1/1")).toBeInTheDocument();
});

it("advances through every unresolved reference instead of alternating two", async () => {
  const ids = ["a", "b", "c", "d"];
  const api = vi.fn(async () => ids.map(id => inspection(id, "needs_region", multi)));
  const user = userEvent.setup();
  render(<Harness assetIds={ids} respond={api} />);
  await user.click(await screen.findByRole("button", { name: needed }));
  const current = () => screen.getByText(/^\d+\/\d+$/).textContent;
  const seen: (string | null)[] = [];
  for (let step = 0; step < 4; step += 1) {
    seen.push(current());
    await user.click(screen.getByRole("button", { name: "다음 이미지" }));
  }
  expect(new Set(seen).size).toBe(4);
  expect(current()).toBe(seen[0]);
});

it("reopens a stale saved binding for re-choice instead of replacing it silently", async () => {
  // The stored binding no longer matches the image and detector, so the native side reports
  // it stale. The user must re-choose; the region is never swapped behind their back.
  const api = vi.fn(async () => [inspection("a", "stale_region", multi), inspection("b", "single")]);
  const user = userEvent.setup();
  render(<Harness assetIds={["a", "b"]} initial={{ a: box("a", [10, 20, 110, 220]) }} respond={api} />);
  // A stale binding is unresolved even though the draft still holds an entry.
  const prompt = await screen.findByRole("button", { name: needed });
  expect(draft()).toEqual({ a: box("a", [10, 20, 110, 220]) });
  await user.click(prompt);
  await user.click(await screen.findByRole("button", { name: "인물 영역 2 선택" }));
  // Only the explicit choice replaces the stale binding.
  expect(draft()).toEqual({ a: box("a", [200, 40, 380, 520]) });
});

it("keeps a stale binding correctable when the image offers a single box", async () => {
  // The detector found one person, but the stored binding is still out of date, so the
  // user can re-confirm it through optional correction.
  const api = vi.fn(async () => [inspection("a", "stale_region", [[10, 20, 110, 220]]), inspection("b", "single")]);
  const user = userEvent.setup();
  render(<Harness assetIds={["a", "b"]} initial={{ a: box("a", [10, 20, 110, 220]) }} respond={api} />);
  await openCorrection(user);
  const summary = await screen.findByRole("region", { name: "인물 영역 목록" });
  await user.click(within(summary).getByRole("button", { name: "레퍼런스 1 인물 영역 변경" }));
  await user.click(await screen.findByRole("button", { name: "인물 영역 1 선택" }));
  expect(draft()).toEqual({ a: box("a", [10, 20, 110, 220]) });
});

it("keeps undetected images unchoosable even when an old manual binding remains", async () => {
  const api = vi.fn(async () => [inspection("a", "stale_region", []), inspection("b", "no_region", [])]);
  render(<Harness assetIds={["a", "b"]} initial={{ a: box("a", [10, 20, 110, 220]) }} respond={api} />);
  await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
  // No invented crop and nothing to ask: an undetected image is simply unused.
  expect(screen.queryByRole("button", { name: "인물 영역" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: needed })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /인물 영역 \d+ 선택/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "인물 영역 목록" })).not.toBeInTheDocument();
});

it("offers an optional adjustment inside the shortfall workflow that the slot opens", async () => {
  const api = vi.fn(async () => [
    ...["a", "b", "c", "d"].map(id => inspection(id, "single")),
    inspection("e", "needs_region", multi),
    inspection("f", "automatic", multi, 1),
  ]);
  const user = userEvent.setup();
  render(<Harness assetIds={["a", "b", "c", "d", "e", "f"]} respond={api} />);
  // The slot asks for the person first; the optional adjustment is reachable from the opened
  // workflow, because the inferred crop on reference six is not part of the required queue.
  await user.click(await screen.findByRole("button", { name: needed }));
  expect(screen.getByRole("button", { name: "인물 영역 조정" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "인물 영역" })).not.toBeInTheDocument();
});

it("returns to the optional list after a correction instead of advancing the required queue", async () => {
  // Five usable references with two unresolved and one adjustable inferred crop, so the
  // required queue is non-empty at the moment the user corrects the inferred reference.
  const api = vi.fn(async () => [
    ...["a", "b", "c", "d"].map(id => inspection(id, "single")),
    inspection("e", "needs_region", multi),
    inspection("f", "needs_region", multi),
    inspection("g", "automatic", multi, 1),
  ]);
  const user = userEvent.setup();
  render(<Harness assetIds={["a", "b", "c", "d", "e", "f", "g"]} respond={api} />);
  expect(await screen.findByRole("button", { name: needed })).toBeInTheDocument();
  await openCorrection(user);
  const summary = await screen.findByRole("region", { name: "인물 영역 목록" });
  await user.click(within(summary).getByRole("button", { name: "레퍼런스 7 인물 영역 변경" }));
  await user.click(await screen.findByRole("button", { name: "인물 영역 1 선택" }));
  expect(draft()).toEqual({ g: box("g", [10, 20, 110, 220]) });
  // The correction returns to the list even though the required queue still has entries.
  // Advancing the queue would instead have opened the chooser on the next unresolved image.
  expect(await screen.findByRole("region", { name: "인물 영역 목록" })).toBeInTheDocument();
  expect(boxButtons()).toHaveLength(0);
});

it("lets a chosen region be replaced through correction without offering to remove it", async () => {
  const api = vi.fn(async () => [inspection("a", "needs_region", multi), inspection("b", "single")]);
  const user = userEvent.setup();
  render(<Harness assetIds={["a", "b"]} initial={{ a: box("a", [10, 20, 110, 220]) }} respond={api} />);
  // The correction list appears only inside the correction workflow.
  await openCorrection(user);
  const summary = await screen.findByRole("region", { name: "인물 영역 목록" });
  expect(within(summary).queryByRole("button", { name: /해제/ })).not.toBeInTheDocument();
  await user.click(within(summary).getByRole("button", { name: "레퍼런스 1 인물 영역 변경" }));
  await user.click(await screen.findByRole("button", { name: "인물 영역 2 선택" }));
  expect(draft()).toEqual({ a: box("a", [200, 40, 380, 520]) });
});

it("keeps an inferred common-person crop correctable without prompting", async () => {
  const api = vi.fn(async () => [...six.map(id => inspection(id, "single")), inspection("g", "automatic", multi, 1)]);
  const user = userEvent.setup();
  render(<Harness assetIds={[...six, "g"]} respond={api} />);
  expect(await screen.findByRole("button", { name: "인물 영역" })).toBeInTheDocument();
  expect(screen.queryByText(/공통 인물이 확인된/)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: needed })).not.toBeInTheDocument();
  await openCorrection(user);
  const summary = await screen.findByRole("region", { name: "인물 영역 목록" });
  await user.click(within(summary).getByRole("button", { name: "레퍼런스 7 인물 영역 변경" }));
  // The inferred crop is box 2, so correcting it to box 1 shows a real position, not 0/N.
  expect(screen.getByText("7/7")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "인물 영역 1 선택" }));
  expect(draft()).toEqual({ g: box("g", [10, 20, 110, 220]) });
});

it("offers a suggestion only when it differs from the crop already in effect", async () => {
  const suggested = { ...inspection("a", "needs_region", multi), suggestedIndex: 1 };
  const api = vi.fn(async () => [suggested, inspection("b", "needs_region", multi)]);
  const user = userEvent.setup();
  render(<Harness assetIds={["a", "b"]} respond={api} />);
  await user.click(await screen.findByRole("button", { name: needed }));
  expect(screen.getByRole("button", { name: "추천 영역 사용" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "다음 이미지" }));
  expect(screen.queryByRole("button", { name: "추천 영역 사용" })).not.toBeInTheDocument();
});

it("hides the suggestion when it repeats the crop already in effect", async () => {
  const same = { ...inspection("a", "automatic", multi, 1), suggestedIndex: 1 };
  const api = vi.fn(async () => [same]);
  const user = userEvent.setup();
  render(<Harness assetIds={["a"]} respond={api} />);
  await openCorrection(user);
  const summary = await screen.findByRole("region", { name: "인물 영역 목록" });
  await user.click(within(summary).getByRole("button", { name: "레퍼런스 1 인물 영역 변경" }));
  expect(screen.queryByRole("button", { name: "추천 영역 사용" })).not.toBeInTheDocument();
});

it("keeps the crop preview finite when the box fills the image", async () => {
  const api = vi.fn(async () => [inspection("a", "needs_region", [[0, 0, 400, 600], [10, 10, 40, 60]])]);
  const user = userEvent.setup();
  render(<Harness assetIds={["a"]} respond={api} />);
  await user.click(await screen.findByRole("button", { name: needed }));
  const frames = screen.getAllByRole("button", { name: /인물 영역 \d+ 선택/ });
  expect(frames).toHaveLength(2);
  for (const frame of frames) {
    const style = frame.getAttribute("style") ?? "";
    expect(style).not.toMatch(/NaN|Infinity/);
    expect(style).toContain("background-image");
    expect(frame).toHaveClass("character-region-frame");
  }
  // A crop filling its dimension has no overflow to offset, so the position is exactly 0%
  // and the whole thumbnail fits the frame without over-scaling.
  const style = frames[0]!.getAttribute("style") ?? "";
  expect(style).toContain("background-position: 0% 0%");
  expect(style).toContain("background-size: 100% 100%");
});

it("never calls the backend for an empty reference list", async () => {
  const api = vi.fn(async () => []);
  const { container } = render(<Harness assetIds={[]} respond={api} />);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(api).not.toHaveBeenCalled();
  expect(container.querySelector(".character-reference-regions")).toBeNull();
});

it("shows no stale correction list after a failed inspection", async () => {
  let fail = false;
  const api = vi.fn(async () => {
    if (fail) throw new Error("boom");
    return [inspection("a", "needs_region", multi), inspection("b", "single")];
  });
  const { rerender } = render(<Harness assetIds={["a", "b"]} respond={api} />);
  // First pass succeeds and offers the shortfall workflow.
  expect(await screen.findByRole("button", { name: needed })).toBeInTheDocument();
  fail = true;
  rerender(<Harness assetIds={["a", "b", "c"]} respond={api} />);
  // The failure surfaces in the slot and the previous list is not presented as current.
  expect(await screen.findByRole("button", { name: "확인 실패 · 다시 시도" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: needed })).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "인물 영역 목록" })).not.toBeInTheDocument();
  expect(boxButtons()).toHaveLength(0);
});

it("counts usability from the inspection states, not from stored regions", () => {
  const rows = [inspection("a", "single"), inspection("b", "selected"), inspection("c", "automatic"),
    inspection("d", "needs_region"), inspection("e", "no_region"), inspection("f", "stale_region")];
  expect(usableReferenceCount(rows)).toBe(3);
  expect(automaticReferenceCount(rows)).toBe(1);
  expect(usableReferenceCount(rows)).toBeLessThan(AUTOMATIC_CHARACTER_REFERENCE_COUNT);
});

it("does not repaint from an inspection that arrives after the reference list changed", async () => {
  const resolvers: ((rows: ReferenceInspection[]) => void)[] = [];
  const respond = (_ids: string[], _regions: ReferenceRegions) => new Promise<ReferenceInspection[]>(resolve => { resolvers.push(resolve); });
  const view = (assetIds: string[]) => <Harness assetIds={assetIds} respond={respond} />;
  const { rerender } = render(view(["a", "b"]));
  rerender(view(["c"]));
  await waitFor(() => expect(resolvers).toHaveLength(2));
  resolvers[0]!([inspection("a", "needs_region", multi), inspection("b", "needs_region", multi)]);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(screen.queryByRole("button", { name: needed })).not.toBeInTheDocument();
  resolvers[1]!([inspection("c", "needs_region", [[1, 1, 9, 9]])]);
  expect(await screen.findByRole("button", { name: needed })).toBeInTheDocument();
});

it("does not reuse another character's inspection when references have the same IDs", async () => {
  const resolvers: ((rows: ReferenceInspection[]) => void)[] = [];
  const api = vi.fn(() => new Promise<ReferenceInspection[]>(resolve => { resolvers.push(resolve); }));
  const { result, rerender } = renderHook(({ targetId, revision }) => useReferenceRegionInspection({
    seriesId: "series", targetId, revision, assetIds: ["shared"], draftRegions: {}, api,
  }), { initialProps: { targetId: "first", revision: "1" } });
  rerender({ targetId: "second", revision: "1" });
  expect(result.current.inspections).toBeNull();
  await act(async () => { resolvers[1]!([inspection("shared", "single")]); });
  await act(async () => { resolvers[0]!([inspection("shared", "needs_region", multi)]); });
  expect(result.current.inspections?.[0]?.state).toBe("single");
  rerender({ targetId: "second", revision: "1" });
  expect(api).toHaveBeenCalledTimes(2);
  rerender({ targetId: "second", revision: "2" });
  expect(result.current.inspections).toBeNull();
  expect(api).toHaveBeenCalledTimes(3);
});

it("does not settle state from a response that arrives after unmount", async () => {
  let resolve: (rows: ReferenceInspection[]) => void = () => {};
  const api = vi.fn(() => new Promise<ReferenceInspection[]>(next => { resolve = next; }));
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const { unmount } = render(<Harness assetIds={["a", "b"]} respond={(_ids, _regions) => api()} />);
  unmount();
  resolve([inspection("a", "needs_region")]);
  await new Promise(next => setTimeout(next, 20));
  expect(errors).not.toHaveBeenCalled();
});

it("asks for a person on an image shared with another character even with six usable references", async () => {
  // The native inspection reports a detected person in a shared image as needs_region with a suggestion.
  const shared = (regions: ReferenceRegions) => regions.g ? { ...inspection("g", "selected", multi), selectedIndex: 1, otherCharacters: ["모모카"] }
    : { ...inspection("g", "needs_region", multi), suggestedIndex: 1, otherCharacters: ["모모카"] };
  const api = vi.fn(async (_ids: string[], regions: ReferenceRegions) => [...six.map(id => inspection(id, "single")), shared(regions)]);
  const user = userEvent.setup();
  render(<Harness assetIds={[...six, "g"]} respond={api} />);
  await user.click(await screen.findByRole("button", { name: needed }));
  expect(screen.getByText("다른 캐릭터(모모카) 이미지 · 인물 지정 필요")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "추천 영역 사용" }));
  await waitFor(() => expect(draft()).toEqual({ g: box("g", [200, 40, 380, 520]) }));
  // Once the chosen person is honoured nothing is required any more.
  await waitFor(() => expect(boxButtons()).toHaveLength(0));
  expect(screen.queryByRole("button", { name: needed })).not.toBeInTheDocument();
});

it("counts a chosen person at once while the reinspection is still pending, without dropping the result", async () => {
  // 다이아린 · 자오: two images another character owns arrive as needs_region ("!" marks).
  const shared = (assetId: string) => ({ ...inspection(assetId, "needs_region", multi), suggestedIndex: 0, otherCharacters: ["자오"] });
  const resolvers: ((rows: ReferenceInspection[]) => void)[] = [];
  const api = vi.fn(() => new Promise<ReferenceInspection[]>(resolve => { resolvers.push(resolve); }));
  const rows = [inspection("a", "single"), inspection("b", "single"), inspection("c", "single"), shared("d"), shared("e")];
  const { result, rerender } = renderHook(({ draftRegions }: { draftRegions: ReferenceRegions }) => useReferenceRegionInspection({
    seriesId: "series", targetId: "dialyn", assetIds: ["a", "b", "c", "d", "e"], draftRegions, api,
  }), { initialProps: { draftRegions: {} as ReferenceRegions } });
  expect(result.current.inspections).toBeNull();
  await act(async () => { resolvers[0]!(rows); });
  expect(usableReferenceCount(result.current.inspections!)).toBe(3);
  // Choosing the right person (the second box, not 자오's) in the draft: the answer is pending.
  rerender({ draftRegions: { d: box("d", multi[1]) } });
  expect(api).toHaveBeenCalledTimes(2);
  const pending = result.current.inspections!;
  expect(pending).not.toBeNull();
  expect(pending.find(row => row.assetId === "d")).toMatchObject({ state: "selected", selectedIndex: 1, automaticIndex: null });
  expect(pending.find(row => row.assetId === "e")?.state).toBe("needs_region");
  expect(usableReferenceCount(pending)).toBe(4);
  // The native answer replaces the optimistic row without ever passing through nothing.
  await act(async () => { resolvers[1]!([...rows.slice(0, 3), { ...inspection("d", "selected", multi), selectedIndex: 1, otherCharacters: ["자오"] }, shared("e")]); });
  expect(usableReferenceCount(result.current.inspections!)).toBe(4);
});

it("applies only a draft choice that still names one of the image's boxes", () => {
  const rows = [inspection("d", "needs_region", multi), inspection("e", "needs_region", multi), inspection("f", "needs_region", multi)];
  const applied = withDraftChoices(rows, {
    d: box("d", multi[1]),
    e: box("e", [1, 1, 2, 2]),
    f: { ...box("f", multi[0]), contentHash: "changed" },
  });
  expect(applied.map(row => row.state)).toEqual(["selected", "needs_region", "needs_region"]);
  expect(applied[0]).toMatchObject({ selectedIndex: 1 });
});

it("keeps the chooser and its next image on screen while a chosen person is being rechecked", async () => {
  const shared = (assetId: string, regions: ReferenceRegions) => regions[assetId]
    ? { ...inspection(assetId, "selected", multi), selectedIndex: 1, otherCharacters: ["자오"] }
    : { ...inspection(assetId, "needs_region", multi), suggestedIndex: 0, otherCharacters: ["자오"] };
  let release: (() => void) | null = null;
  const respond = vi.fn(async (_ids: string[], regions: ReferenceRegions) => {
    const rows = [inspection("a", "single"), inspection("b", "single"), inspection("c", "single"), shared("d", regions), shared("e", regions)];
    if (Object.keys(regions).length) await new Promise<void>(resolve => { release = resolve; });
    return rows;
  });
  const user = userEvent.setup();
  render(<Harness assetIds={["a", "b", "c", "d", "e"]} respond={respond} />);
  await user.click(await screen.findByRole("button", { name: needed }));
  expect(screen.getByText("1/2")).toBeInTheDocument();
  await user.click(screen.getAllByRole("button", { name: "인물 영역 2 선택" })[0]!);
  await waitFor(() => expect(draft()).toEqual({ d: box("d", multi[1]) }));
  // The recheck has not answered yet, yet the section did not blink away: the next image is up.
  expect(respond).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("region", { name: "인물 영역 확인" })).toBeInTheDocument();
  expect(boxButtons()).toHaveLength(2);
  expect(screen.getByText("1/1")).toBeInTheDocument();
  await act(async () => { release?.(); });
  expect(boxButtons()).toHaveLength(2);
});

/** 다이아린 · 자오 (asset 6729c4fa): a 1482x2048 frame whose detection list ends with the whole frame. */
const frame = [[1014, 55, 1470, 972], [0, 0, 1482, 2048]] as [number, number, number, number][];
const sharedFrame = (state: string, extra: Partial<ReferenceInspection> = {}): ReferenceInspection =>
  ({ ...inspection("g", state, frame), width: 1482, height: 2048, suggestedIndex: 1, otherCharacters: ["자오"], ...extra });

it("never counts a whole-frame choice on another character's image as a usable person", () => {
  const row = sharedFrame("needs_region");
  const whole = box("g", frame[1]);
  // The draft the "추천 영역 사용" button would have made is refused by the save, so it is no choice.
  expect(withDraftChoices([row], { g: whole })[0]).toBe(row);
  expect(usableReferenceCount(withDraftChoices([row], { g: whole }))).toBe(0);
  // A real person box on the same image is a choice.
  expect(withDraftChoices([row], { g: box("g", frame[0]) })[0]).toMatchObject({ state: "selected", selectedIndex: 0 });
  // A native answer that still carries the whole frame as the chosen crop is not usable either.
  expect(usableReferenceCount([sharedFrame("selected", { selectedIndex: 1 })])).toBe(0);
  // An image nobody else owns may still use the whole frame.
  const own = { ...sharedFrame("selected", { selectedIndex: 1 }), otherCharacters: undefined };
  expect(usableReferenceCount([own])).toBe(1);
  expect(withDraftChoices([{ ...row, otherCharacters: undefined }], { g: whole })[0]).toMatchObject({ state: "selected", selectedIndex: 1 });
});

it("keeps asking for a person on a shared image when its only offered choice was the whole frame", async () => {
  const rows = [sharedFrame("selected", { selectedIndex: 1 })];
  render(<Panel assetIds={["g"]} draftRegions={{ g: box("g", frame[1]) }}
    privacyMode={false} busy={false} inspection={{ inspections: rows, error: null }} onChange={vi.fn()} />);
  expect(screen.getByRole("button", { name: needed })).toBeInTheDocument();
});

/** 다이아린 · 자오: 자오 is already registered on the first person of this image. */
const taken = (state: string, extra: Partial<ReferenceInspection> = {}): ReferenceInspection =>
  ({ ...inspection("g", state, multi), otherCharacters: ["자오"], takenBoxes: [{ index: 0, character: "자오", targetId: "zhao", source: "reference" }], ...extra });

it("shows a person another character is registered on dimmed with that name, and cannot select it", async () => {
  const api = vi.fn(async () => [...six.map(id => inspection(id, "single")), taken("needs_region")]);
  const user = userEvent.setup();
  render(<Harness assetIds={[...six, "g"]} respond={api} />);
  await user.click(await screen.findByRole("button", { name: needed }));
  const owned = screen.getByRole("button", { name: "인물 영역 1 · 자오 인물" });
  expect(owned).toBeDisabled();
  expect(within(owned).getByText("자오 인물")).toBeVisible();
  expect(owned).not.toHaveAttribute("aria-pressed");
  expect(screen.queryByRole("button", { name: "자오 아님" })).not.toBeInTheDocument();
  await user.click(owned);
  expect(draft()).toEqual({});
  // The free person is still chosen as before.
  await user.click(screen.getByRole("button", { name: "인물 영역 2 선택" }));
  await waitFor(() => expect(draft()).toEqual({ g: box("g", multi[1]) }));
});

it("never offers a taken box as the suggestion and never counts it as a chosen person", () => {
  const row = taken("needs_region", { suggestedIndex: 0 });
  expect(withDraftChoices([row], { g: box("g", multi[0]) })[0]).toBe(row);
  expect(withDraftChoices([row], { g: box("g", multi[1]) })[0]).toMatchObject({ state: "selected", selectedIndex: 1 });
  // A native answer whose chosen crop is the taken one is not usable either.
  expect(usableReferenceCount([taken("selected", { selectedIndex: 0 })])).toBe(0);
  expect(usableReferenceCount([taken("selected", { selectedIndex: 1 })])).toBe(1);
});

it("says so when every person of a shared image is already registered", async () => {
  const all = taken("needs_region", { takenBoxes: [0, 1].map(index => ({ index, character: "자오", targetId: "zhao", source: "reference" })) });
  const api = vi.fn(async () => [...six.map(id => inspection(id, "single")), all]);
  const user = userEvent.setup();
  render(<Harness assetIds={[...six, "g"]} respond={api} />);
  await user.click(await screen.findByRole("button", { name: needed }));
  expect(screen.getByText("이미지의 인물이 모두 다른 캐릭터(자오)로 등록돼 있어 사용할 수 없음")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "추천 영역 사용" })).not.toBeInTheDocument();
});

const acceptedHolder = () => taken("needs_region", {
  takenBoxes: [
    { index: 0, character: "자오", targetId: "zhao", source: "accepted" },
    { index: 1, character: "모모카", targetId: "momoka", source: "reference" },
  ],
});

it.each([false, true])("rejects an accepted holder and keeps the chooser while refreshing (shared inspection: %s)", async shared => {
  let finishDecision!: (count: number) => void;
  let finishInspection!: (rows: ReferenceInspection[]) => void;
  const api = vi.fn().mockResolvedValueOnce([acceptedHolder()])
    .mockImplementationOnce(() => new Promise<ReferenceInspection[]>(resolve => { finishInspection = resolve; }))
    .mockResolvedValue([taken("needs_region", { takenBoxes: [] })]);
  const decisionApi = {
    targets: vi.fn(async () => [fixtureTarget("zhao", "자오")]),
    decide: vi.fn(() => new Promise<number>(resolve => { finishDecision = resolve; })),
  };
  const user = userEvent.setup();
  render(<Harness assetIds={["g"]} respond={api} decisionApi={decisionApi} shared={shared} />);
  await user.click(await screen.findByRole("button", { name: needed }));
  expect(screen.queryByRole("button", { name: "모모카 아님" })).not.toBeInTheDocument();
  expect(screen.getByText("이미지의 인물이 모두 다른 캐릭터(자오, 모모카)로 등록돼 있어 사용할 수 없음")).toBeVisible();
  const reject = screen.getByRole("button", { name: "자오 아님" });
  const crop = screen.getByRole("button", { name: "인물 영역 1 · 자오 인물" });
  await user.click(reject);
  expect(reject).toBeDisabled();
  expect(reject).toHaveTextContent("자오 아님");
  await waitFor(() => expect(decisionApi.decide).toHaveBeenCalledWith({
    targetId: "zhao", expectedFingerprint: "fingerprint-zhao", assetIds: ["g"],
    decision: "rejected", baselineFingerprint: null, scanId: null,
  }));
  expect(api).toHaveBeenCalledTimes(1);
  await act(async () => finishDecision(1));
  await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("button", { name: "인물 영역 1 · 자오 인물" })).toBe(crop);
  expect(screen.getByText("사용할 인물을 한 명 선택하세요")).toBeVisible();
  expect(reject).toBeDisabled();
  await act(async () => finishInspection([taken("needs_region", { takenBoxes: [
    { index: 1, character: "모모카", targetId: "momoka", source: "reference" },
  ] })]));
  await user.click(await screen.findByRole("button", { name: "인물 영역 1 선택" }));
  expect(draft()).toEqual({ g: box("g", multi[0]) });
  expect(decisionApi.decide).toHaveBeenCalledTimes(1);
});

it.each(["targets", "decision", "inspection"])("keeps the taken person and shows an inline error on %s failure", async failure => {
  const api = vi.fn().mockResolvedValueOnce([acceptedHolder()]).mockRejectedValue(new Error("재검사 실패"));
  const decisionApi = {
    targets: failure === "targets" ? vi.fn().mockRejectedValue(new Error("정보 조회 실패")) : vi.fn(async () => [fixtureTarget("zhao", "자오")]),
    decide: failure === "decision" ? vi.fn().mockRejectedValue(new Error("거절 실패")) : vi.fn().mockResolvedValue(1),
  };
  const user = userEvent.setup();
  render(<Harness assetIds={["g"]} respond={api} decisionApi={decisionApi} />);
  await user.click(await screen.findByRole("button", { name: needed }));
  await user.click(screen.getByRole("button", { name: "자오 아님" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(failure === "targets" ? "정보 조회 실패" : failure === "decision" ? "거절 실패" : "재검사 실패");
  expect(screen.getByRole("button", { name: "인물 영역 1 · 자오 인물" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "자오 아님" })).toBeEnabled();
  expect(screen.getByText("사용할 인물을 한 명 선택하세요")).toBeVisible();
  expect(draft()).toEqual({});
  expect(api).toHaveBeenCalledTimes(failure === "inspection" ? 2 : 1);
  if (failure === "targets") expect(decisionApi.decide).not.toHaveBeenCalled();
});

const slotProps = { active: true, assetIds: ["a"], draftRegions: {}, busy: false, onRequest: () => {} };

it("keeps the status slot from the first render and names the check only after a delay", () => {
  vi.useFakeTimers();
  try {
    const { container, rerender } = render(<ReferenceCheckSlot {...slotProps} inspection={{ inspections: null, error: null }} />);
    // Reserved at once, so nothing below it ever moves, but empty while a quick check may still finish.
    expect(container.querySelector(".character-reference-slot")).not.toBeNull();
    expect(container.querySelector(".character-reference-slot")).toBeEmptyDOMElement();
    act(() => { vi.advanceTimersByTime(399); });
    expect(screen.queryByText("인물 확인 중")).not.toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(2); });
    expect(screen.getByText("인물 확인 중")).toBeVisible();
    // A result replaces the label in the same place.
    rerender(<ReferenceCheckSlot {...slotProps} inspection={{ inspections: [inspection("a", "single")], error: null }} />);
    expect(screen.queryByText("인물 확인 중")).not.toBeInTheDocument();
    expect(container.querySelector(".character-reference-slot")).toHaveTextContent("사용 1");
  } finally { vi.useRealTimers(); }
});

it("shows nothing at all for a check that finishes before the delay", () => {
  vi.useFakeTimers();
  try {
    const { container, rerender } = render(<ReferenceCheckSlot {...slotProps} inspection={{ inspections: null, error: null }} />);
    act(() => { vi.advanceTimersByTime(200); });
    rerender(<ReferenceCheckSlot {...slotProps} inspection={{ inspections: [inspection("a", "single")], error: null }} />);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.queryByText("인물 확인 중")).not.toBeInTheDocument();
    expect(container.querySelector(".character-reference-slot")).toHaveTextContent("사용 1");
  } finally { vi.useRealTimers(); }
});

it("fills the slot with the person count, the usable count, or a retry", async () => {
  const user = userEvent.setup();
  const onRequest = vi.fn(), retry = vi.fn();
  const rows = [inspection("a", "single"), inspection("b", "needs_region", multi), inspection("c", "needs_region", multi), inspection("d", "stale_region", multi)];
  const { rerender } = render(<ReferenceCheckSlot {...slotProps} assetIds={["a", "b", "c", "d"]} onRequest={onRequest} inspection={{ inspections: rows, error: null }} />);
  await user.click(screen.getByRole("button", { name: "인물 선택 3" }));
  expect(onRequest).toHaveBeenCalledWith("required");
  expect(screen.queryByRole("button", { name: "인물 영역" })).not.toBeInTheDocument();
  // Nothing to choose: the usable count and the optional crop adjustment.
  const done = [...six.map(id => inspection(id, "single")), inspection("g", "automatic", multi, 1)];
  rerender(<ReferenceCheckSlot {...slotProps} assetIds={[...six, "g"]} onRequest={onRequest} inspection={{ inspections: done, error: null }} />);
  expect(screen.getByText("사용").parentElement).toHaveTextContent("사용 7");
  await user.click(screen.getByRole("button", { name: "인물 영역" }));
  expect(onRequest).toHaveBeenLastCalledWith("correction");
  // A failure keeps the slot and offers one retry.
  rerender(<ReferenceCheckSlot {...slotProps} onRequest={onRequest} inspection={{ inspections: null, error: "boom", retry }} />);
  await user.click(screen.getByRole("button", { name: "확인 실패 · 다시 시도" }));
  expect(retry).toHaveBeenCalledTimes(1);
});

it("tells a person choice from an unusable reference and counts what is asked", () => {
  const all = { ...inspection("t", "needs_region", multi), takenBoxes: multi.map((_, index) => ({ index, character: "자오", targetId: "zhao", source: "reference" as const })) };
  expect(referenceNeedsPerson(inspection("p", "needs_region", multi))).toBe(true);
  expect(referenceNeedsPerson(inspection("s", "stale_region", multi))).toBe(true);
  expect(referenceNeedsPerson(all)).toBe(false);
  expect(referenceNeedsPerson(inspection("n", "no_region", []))).toBe(false);
  expect(referenceNeedsPerson(inspection("u", "single"))).toBe(false);
  // Short of six: every unresolved image is asked; with six usable only a shared image is.
  expect(personChoiceCount([inspection("a", "single"), inspection("b", "needs_region", multi)])).toBe(1);
  expect(personChoiceCount([...six.map(id => inspection(id, "single")), inspection("b", "needs_region", multi)])).toBe(0);
  expect(personChoiceCount([...six.map(id => inspection(id, "single")), { ...inspection("g", "needs_region", multi), otherCharacters: ["모모카"] }])).toBe(1);
});

it("names the shared references a save would refuse, in draft order", () => {
  const shared = (id: string) => ({ ...inspection(id, "needs_region", multi), otherCharacters: ["모모카"] });
  const rows = [inspection("a", "single"), shared("b"), inspection("c", "needs_region", multi), shared("d")];
  expect(blockedSaveReferences(rows, ["a", "b", "c", "d"])).toEqual([{ assetId: "b", number: 2 }, { assetId: "d", number: 4 }]);
  expect(blockedSaveReferences(null, ["a"])).toEqual([]);
  expect(blockedSaveReferences([{ ...shared("b"), state: "selected", selectedIndex: 1 }], ["b"])).toEqual([]);
});

it("paints a result this session already knows at once on reopen, then refreshes it silently", async () => {
  const first = [inspection("a", "single"), inspection("b", "needs_region", multi)];
  const api = vi.fn(async () => first);
  const props = { seriesId: "series", targetId: "hina", revision: "1", assetIds: ["a", "b"], draftRegions: {} as ReferenceRegions, api, libraryKey: "lib" };
  const opened = renderHook(() => useReferenceRegionInspection(props));
  expect(opened.result.current.inspections).toBeNull();
  await waitFor(() => expect(opened.result.current.inspections).toEqual(first));
  opened.unmount();
  // Reopened: known at the first render, and the native answer still comes (silently).
  const reopened = renderHook(() => useReferenceRegionInspection(props));
  expect(reopened.result.current.inspections).toEqual(first);
  await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
  expect(reopened.result.current.inspections).toEqual(first);
  reopened.unmount();
  // Another library, revision, reference set or choice never borrows it.
  for (const other of [{ libraryKey: "other" }, { revision: "2" }, { assetIds: ["a", "b", "c"] }, { draftRegions: { a: box("a", multi[0]) } }]) {
    const changed = renderHook(() => useReferenceRegionInspection({ ...props, ...other }));
    expect(changed.result.current.inspections).toBeNull();
    changed.unmount();
  }
  // Another inspection API (another test, another connection) keeps its own memory.
  const elsewhere = renderHook(() => useReferenceRegionInspection({ ...props, api: vi.fn(async () => first) }));
  expect(elsewhere.result.current.inspections).toBeNull();
});
