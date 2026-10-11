import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { characterApi, type CharacterTarget } from "../characters/api";
import { s36PublicationApi } from "../characters/S36Publication";
import { emptyShadowSummary, shadowReviewApi } from "../characters/shadowReviewApi";
import { LibraryProvider } from "../library/LibraryContext";
import type { LibraryGateway } from "../library/types";
import { CharacterRecognitionStatus } from "./CharacterRecognitionStatus";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const target = (id: string, name: string) => ({ id, displayName: name, seriesClassificationId: "zzz", enabled: true, manualOnly: false, role: "character", references: [] }) as unknown as CharacterTarget;
const idle = { running: false, preparing: false, total: 0, scored: 0, skipped: 0, cancelled: false, error: null };
const counts = (accepted: number, rejected: number) => ({ pending: 0, accepted, rejected });

function mount(options: { scoring?: boolean; backfill?: Partial<typeof idle> } = {}) {
  vi.spyOn(characterApi, "targets").mockResolvedValue([target("sna", "수나"), target("sisia", "시시아")]);
  vi.spyOn(s36PublicationApi, "get").mockResolvedValue({ series: ["zzz"], excludedTargets: ["sisia"], scoringEnabled: options.scoring ?? true });
  vi.spyOn(s36PublicationApi, "readiness").mockResolvedValue([
    { targetId: "sna", reviewed: 74, wrong: 0, examples: 126, status: "ready" }, { targetId: "sisia", reviewed: 36, wrong: 3, examples: 42, status: "hold" },
  ]);
  const page = vi.spyOn(shadowReviewApi, "page").mockImplementation(async query => ({ items: [], nextOffset: null, policyVersion: "v1", summary: query.mode === "doubtful"
    ? { ...emptyShadowSummary(), doubtful: counts(69, 2) } : { ...emptyShadowSummary(), automatic: counts(290, 12), recommended: counts(59, 23) } }));
  const status = vi.spyOn(shadowReviewApi, "status").mockResolvedValue({ ...idle, ...options.backfill });
  const start = vi.spyOn(shadowReviewApi, "start").mockResolvedValue({ ...idle, running: true, total: 10, scored: 2 });
  const cancel = vi.spyOn(shadowReviewApi, "cancel").mockResolvedValue({ ...idle, cancelled: true });
  const gateway = { listClassifications: vi.fn(async () => [{ id: "zzz", name: "젠레스", parentId: null }]) } as unknown as LibraryGateway;
  render(<LibraryProvider gateway={gateway}><CharacterRecognitionStatus /></LibraryProvider>);
  return { page, status, start, cancel };
}

beforeEach(() => localStorage.clear());

it("shows the recognition in use, the judgment numbers and the overall accuracy, with raw model names only here", async () => {
  mount();
  const table = await screen.findByRole("table", { name: "젠레스 캐릭터 인식 상태" });
  const rows = within(table).getAllByRole("row").slice(1).map(row => [...row.querySelectorAll("th, td")].map(cell => cell.textContent));
  expect(rows).toEqual([
    ["수나", "학습 인식", "74 / 30", "126 / 50", "0 / 3"],
    ["시시아", "기본 인식", "36 / 30", "42 / 50", "3 / 1"],
  ]);
  const accuracy = screen.getByRole("table", { name: "확인 판단 정확도" });
  expect(within(accuracy).getByRole("row", { name: /자동 후보/ })).toHaveTextContent("30229096%");
  expect(within(accuracy).getByRole("row", { name: /추천 후보/ })).toHaveTextContent("825972%");
  expect(within(accuracy).getByRole("row", { name: /학습 인식이 넣은 것 다시 봄/ })).toHaveTextContent("716997%");
  expect(screen.getByText(/PixAI/)).toBeInTheDocument();
  expect(screen.getByText(/B36/)).toBeInTheDocument();
});

it("offers the preparation controls of 학습 인식 준비: start for existing images, and stop while it runs", async () => {
  const { start, cancel } = mount();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "기존 이미지도 준비" }));
  expect(start).toHaveBeenCalledTimes(1);
  expect(await screen.findByText(/기존 이미지도 준비 2 \/ 10/)).toBeInTheDocument();
  await user.click(await screen.findByRole("button", { name: "그만두기" }));
  expect(cancel).toHaveBeenCalledTimes(1);
});

it("says when the preparation is off and offers to turn it on", async () => {
  mount({ scoring: false });
  expect(await screen.findByText(/꺼져 있어/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "켜기" })).toBeInTheDocument();
});

it("reads again when a running preparation finishes", async () => {
  const { page, status } = mount({ backfill: { running: true, total: 4, scored: 1 } });
  await screen.findByRole("table", { name: "젠레스 캐릭터 인식 상태" });
  const before = page.mock.calls.length;
  status.mockResolvedValue({ ...idle });
  await waitFor(() => expect(page.mock.calls.length).toBeGreaterThan(before), { timeout: 4000 });
});
