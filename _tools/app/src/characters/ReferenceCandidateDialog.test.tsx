import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReferenceCandidateDialog } from "./ReferenceCandidateDialog";
import { fixtureAssets, fixtureTarget } from "./characterFixtures";
import type { ReferenceCandidateApi } from "./hubApi";

beforeEach(() => {
  Object.defineProperties(HTMLElement.prototype, {
    clientWidth: { configurable: true, get: () => 850 },
    clientHeight: { configurable: true, get: () => 650 },
  });
});
afterEach(cleanup);

function candidateApi(): ReferenceCandidateApi {
  const items = fixtureAssets.slice(0, 6);
  return {
    referenceCandidates: vi.fn().mockResolvedValue({
      targetId: "manual", targetRevision: 1, referenceSetHash: "set-1",
      confirmationMode: "initialize", minimumSelection: 5,
      items, suggestedAssetIds: items.map(item => item.id),
    }),
    confirmReferenceBatch: vi.fn().mockResolvedValue({
      ...fixtureTarget("manual", "마커스"), manualOnly: false,
    }),
  };
}

it("preselects suggestions, lets the user remove a bad image, and confirms once", async () => {
  const api = candidateApi();
  const saved = vi.fn();
  render(<ReferenceCandidateDialog target={{ ...fixtureTarget("manual", "마커스"), manualOnly: true, ready: false, references: [] }} privacyMode={false} onClose={vi.fn()} onSaved={saved} api={api} />);
  const user = userEvent.setup();
  expect(await screen.findByRole("dialog", { name: "레퍼런스 선택" })).toBeVisible();
  expect(screen.getByText(/과거 이미지는 자동으로 다시 분석하지 않습니다/)).toBeVisible();
  expect(screen.getByText(/6장 이상/)).toBeVisible();
  expect(screen.getByRole("button", { name: "6장 적용" })).toBeEnabled();
  await user.click(screen.getByRole("option", { name: "이미지 5.webp" }));
  await user.click(screen.getByRole("button", { name: "5장 적용" }));
  await waitFor(() => expect(api.confirmReferenceBatch).toHaveBeenCalledWith({
    targetId: "manual", expectedRevision: 1, expectedReferenceSetHash: "set-1",
    confirmationMode: "initialize", assetIds: fixtureAssets.slice(0, 5).map(item => item.id),
  }));
  expect(saved).toHaveBeenCalledTimes(1);
});

it("closing suggestions does not write references", async () => {
  const api = candidateApi();
  const close = vi.fn();
  render(<ReferenceCandidateDialog target={{ ...fixtureTarget("manual", "마커스"), manualOnly: true, ready: false, references: [] }} privacyMode={false} onClose={close} onSaved={vi.fn()} api={api} />);
  await screen.findByRole("dialog", { name: "레퍼런스 선택" });
  await userEvent.setup().click(screen.getByRole("button", { name: "나중에" }));
  expect(api.confirmReferenceBatch).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(1);
});
