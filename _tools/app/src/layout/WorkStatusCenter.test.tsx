import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { dismissPublication, startPublication } from "../library/publicationJobs";
import { WorkStatusCenter } from "./WorkStatusCenter";
import { WorkspaceNavigation } from "./WorkspaceNavigation";
import { resetVaultImportJob, startVaultImport } from "../external-vault/vaultImportJob";
import { resetVaultExportJob, startVaultExport } from "../external-vault/vaultExportJob";

afterEach(() => {
  cleanup();
  dismissPublication("catalog");
  dismissPublication("collections");
  resetVaultImportJob();
  resetVaultExportJob();
});

const idleCharacterAutomation = {
  revision: 0,
  persistentError: null,
  historyRefreshActive: false,
  paused: false,
  dismissError: vi.fn(),
  pauseHistoryRefresh: vi.fn(),
  resumeHistoryRefresh: vi.fn(),
  setupRuntime: vi.fn(),
} as any;

it("consolidates work, unsorted and trash under management without losing navigation or focus", async () => {
  const user = userEvent.setup();
  const onNavigate = vi.fn();
  render(<WorkspaceNavigation view={{ kind: "classification", classificationId: null }}
    collectionType="game" width={208} onWidthChange={vi.fn()} onNavigate={onNavigate}
    assetNavigation={null} reviewCount={2} trashCount={3}
    renderManagement={(items) => <WorkStatusCenter characterAutomation={idleCharacterAutomation}
      progress={null} managementItems={items} reviewCount={2} />} />);

  const rail = screen.getByRole("navigation", { name: "주요 영역" });
  expect(within(rail).queryAllByRole("button", { name: /미분류|휴지통|작업 센터/ })).toHaveLength(0);
  const trigger = within(rail).getByRole("button", { name: "라이브러리 관리" });
  expect(trigger).toHaveAccessibleDescription("유사 검토 2개 대기");
  trigger.focus();
  await user.keyboard("{Enter}");
  const panel = screen.getByRole("dialog", { name: "라이브러리 관리" });
  expect(within(panel).getByRole("heading", { name: "작업" })).toBeVisible();
  expect(panel).toHaveTextContent("진행 중인 작업이 없습니다.");
  await user.click(within(panel).getByRole("button", { name: "미분류" }));
  expect(onNavigate).toHaveBeenLastCalledWith({ kind: "unsorted" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  await user.keyboard("{Enter}");
  await user.click(screen.getByRole("button", { name: "휴지통 (3)" }));
  expect(onNavigate).toHaveBeenLastCalledWith({ kind: "trash" });
  await user.click(trigger);
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it("keeps an always available work entry and reveals an idle detail panel", async () => {
  render(<WorkStatusCenter characterAutomation={idleCharacterAutomation} progress={null}
    similarityIndex={{ running: false, remaining: 0, failed: 0 }} />);

  const trigger = screen.getByRole("button", { name: "작업 센터" });
  expect(trigger).toHaveAttribute("data-state", "idle");
  await userEvent.click(trigger);
  expect(screen.getByRole("dialog", { name: "작업 센터" })).toHaveTextContent("진행 중인 작업이 없습니다.");
});

it("summarizes an explicit character history refresh alongside other active work", async () => {
  let finish!: () => void;
  act(() => {
    void startPublication("catalog", () => new Promise<number>((resolve) => { finish = () => resolve(1); }), String);
  });
  render(<WorkStatusCenter characterAutomation={{ ...idleCharacterAutomation, historyRefreshActive: true, paused: true }}
    progress={{ current: 1, total: 4 }} similarityIndex={{ running: true, remaining: 9, failed: 0 }} />);

  const trigger = screen.getByRole("button", { name: /작업 센터 · 4개 진행 중/ });
  expect(trigger).toHaveAttribute("data-state", "active");
  expect(screen.queryByText("파일 가져오기 1 / 4")).not.toBeInTheDocument();

  await userEvent.click(trigger);
  const panel = screen.getByRole("dialog", { name: "작업 센터" });
  expect(panel).toHaveTextContent("파일 가져오기 1 / 4");
  expect(panel).toHaveTextContent("유사 이미지 준비 중 · 9개 남음");
  expect(panel).toHaveTextContent("과거 미분류 이미지 갱신 일시 정지");

  await act(async () => { finish(); });
});

it("shows fresh character work and its target in the existing work center", async () => {
  render(<WorkStatusCenter characterAutomation={{ ...idleCharacterAutomation,
    activeWork: { active: true, seriesName: "젠레스", targetName: "레미엘", cause: "ingestion", freshRemaining: 12 },
  }} progress={null} />);
  await userEvent.click(screen.getByRole("button", { name: "작업 센터 · 1개 진행 중" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("현재 작업 · 젠레스 / 레미엘 비교 중");
  expect(screen.getByRole("dialog")).toHaveTextContent("새 이미지 분석 · 12개 남음");
});

it("counts a persistent character failure as a problem with a recovery action", async () => {
  render(<WorkStatusCenter characterAutomation={{
    ...idleCharacterAutomation,
    persistentError: "런타임을 시작하지 못했습니다.",
  }} progress={null} similarityIndex={{ running: false, remaining: 0, failed: 0 }} />);

  const trigger = screen.getByRole("button", { name: "작업 센터 · 문제 1개" });
  expect(trigger).toHaveAttribute("data-state", "attention");
  await userEvent.click(trigger);
  expect(screen.getByRole("alert")).toHaveTextContent("캐릭터 분석 오류");
  expect(screen.getByRole("button", { name: "분석 환경 설정" })).toBeVisible();
});

it("shows a running Private Vault import on the 비밀 rail item and in the work center from any view", async () => {
  const user = userEvent.setup();
  let progress!: (value: { processed: number; total: number; imported: number; skipped: number; failed: number }) => void;
  let finish!: (value: unknown) => void;
  const importIntoEncryptedVault = vi.fn((_folder: string, onProgress?: typeof progress) => {
    progress = onProgress!;
    return new Promise((resolve) => { finish = resolve; });
  });
  void startVaultImport({ importIntoEncryptedVault } as any, "/home/me/photos");
  render(<WorkspaceNavigation view={{ kind: "notes" }}
    collectionType="game" width={208} onWidthChange={vi.fn()} onNavigate={vi.fn()}
    assetNavigation={null} reviewCount={0} trashCount={0} privateVaultAvailable
    renderManagement={(items) => <WorkStatusCenter characterAutomation={idleCharacterAutomation}
      progress={null} managementItems={items} />} />);
  act(() => progress({ processed: 7, total: 20, imported: 7, skipped: 0, failed: 0 }));

  const rail = screen.getByRole("navigation", { name: "주요 영역" });
  expect(within(rail).getByRole("button", { name: "비밀" })).toHaveAccessibleDescription("가져오는 중 7 / 20");
  const trigger = within(rail).getByRole("button", { name: "라이브러리 관리" });
  expect(trigger).toHaveAccessibleDescription("작업 센터 · 1개 진행 중");
  await user.click(trigger);
  expect(screen.getByRole("status", { name: "비밀 보관함 가져오기" })).toHaveTextContent("비밀 보관함 가져오기 · 가져오는 중 7 / 20");

  await act(async () => finish({ total: 20, imported: 19, skipped: 0, failed: 1, withoutThumbnail: 0, legacyTitles: 0, legacyThumbnails: 0 }));
  expect(within(rail).getByRole("button", { name: "비밀" })).not.toHaveAccessibleDescription();
  expect(screen.getByRole("status", { name: "비밀 보관함 가져오기" })).toHaveTextContent("완료 · 가져옴 19개 · 실패 1개");
  await user.click(screen.getByRole("button", { name: "닫기" }));
  expect(screen.queryByRole("status", { name: "비밀 보관함 가져오기" })).not.toBeInTheDocument();
});

it("shows a running Private Vault export on the 비밀 rail item and in the work center", async () => {
  const user = userEvent.setup();
  let progress!: (value: { processed: number; total: number; exported: number; failed: number }) => void;
  let finish!: (value: unknown) => void;
  const exportEncryptedVaultItems = vi.fn((_ids: string[], _folder: string, onProgress?: typeof progress) => {
    progress = onProgress!;
    return new Promise((resolve) => { finish = resolve; });
  });
  void startVaultExport({ exportEncryptedVaultItems } as any, ["a", "b"], "/home/me/out");
  render(<WorkspaceNavigation view={{ kind: "notes" }}
    collectionType="game" width={208} onWidthChange={vi.fn()} onNavigate={vi.fn()}
    assetNavigation={null} reviewCount={0} trashCount={0} privateVaultAvailable
    renderManagement={(items) => <WorkStatusCenter characterAutomation={idleCharacterAutomation}
      progress={null} managementItems={items} />} />);
  act(() => progress({ processed: 1, total: 2, exported: 1, failed: 0 }));

  const rail = screen.getByRole("navigation", { name: "주요 영역" });
  expect(within(rail).getByRole("button", { name: "비밀" })).toHaveAccessibleDescription("내보내는 중 1 / 2");
  await user.click(within(rail).getByRole("button", { name: "라이브러리 관리" }));
  expect(screen.getByRole("status", { name: "비밀 보관함 내보내기" })).toHaveTextContent("내보내는 중 1 / 2");
  await act(async () => finish({ processed: 2, total: 2, exported: 1, failed: 1 }));
  expect(screen.getByRole("status", { name: "비밀 보관함 내보내기" })).toHaveTextContent("완료 · 내보냄 1개 · 실패 1개");
});
