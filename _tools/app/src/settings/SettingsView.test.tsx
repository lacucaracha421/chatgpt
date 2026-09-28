import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { open } from "@tauri-apps/plugin-dialog";
import { LibraryProvider } from "../library/LibraryContext";
import { libraryGateway } from "../library/client";
import type { LibraryGateway } from "../library/types";
import { SettingsView } from "./SettingsView";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async (command: string) => command === "character_incremental_status" ? { automationEnabled: false, broadFolderEnabled: false } : undefined) }));

afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks(); });
beforeEach(() => { vi.mocked(open).mockResolvedValue(null); });

function createGateway(overrides: Partial<LibraryGateway> = {}) {
  return {
    ...libraryGateway,
    getOnlineCatalogStatus: vi.fn().mockResolvedValue({ installed: true, workCount: 12, updateEnabled: true, updateIntervalSeconds: 21600, lastAttemptAt: "2026-09-29T06:00:00Z", lastSuccessAt: "2026-09-29T06:00:00Z", lastAdded: 2, lastError: null, streams: [] }),
    getCloudCaptureSettings: vi.fn().mockResolvedValue({ enabled: true, captureEnabled: true, apiBaseUrl: "https://cloud.test", tokenConfigured: true }),
    cloudBackfillProgress: vi.fn().mockResolvedValue({ controlState: "idle", totalAssets: 10, queued: 0, preparing: 0, uploading: 0, committing: 0, completed: 10, failed: 0, activeWorkers: 0, lastError: null, activity: [] }),
    getExtensionConnection: vi.fn().mockResolvedValue({ baseUrl: "http://127.0.0.1:47631", token: "extension-token", status: "ready" }),
    releaseCalendar: { calendar: vi.fn().mockResolvedValue({ rangeStart: "", rangeEnd: "", entries: [], sources: [{ provider: "igdb", fetchedAt: "2026-09-29T03:00:00Z", attemptedAt: null, errorCode: null, due: false }, { provider: "tmdb", fetchedAt: "2026-09-29T03:00:00Z", attemptedAt: null, errorCode: null, due: false }, { provider: "tmdb_tv", fetchedAt: "2026-09-29T03:00:00Z", attemptedAt: null, errorCode: null, due: false }] }), refreshNow: vi.fn() },
    listMetadataBackups: vi.fn().mockResolvedValue([{ id: "backup-1", kind: "daily", createdAt: "2026-09-28T00:00:00Z", byteSize: 128 }]),
    getEncryptedVaultStatus: vi.fn().mockResolvedValue({ state: "absent", vaultId: null, root: null, itemCount: null, remembered: false }),
    ...overrides,
  } as unknown as LibraryGateway;
}

function renderSettings(gateway: LibraryGateway, props: Partial<React.ComponentProps<typeof SettingsView>> = {}) {
  return render(<LibraryProvider gateway={gateway}><SettingsView restoring={false} onRestore={vi.fn()} onExit={vi.fn()} {...props} /></LibraryProvider>);
}

it("starts on frequent and uses the seven approved section ids without a search box", async () => {
  const gateway = createGateway();
  renderSettings(gateway);
  expect(await within(screen.getByRole("toolbar")).findByRole("heading", { name: "자주 쓰는 것" })).toBeInTheDocument();
  expect(screen.queryByPlaceholderText("설정 찾기")).not.toBeInTheDocument();
  expect(screen.getByRole("navigation", { name: "설정 구역" })).toHaveTextContent("자주 쓰는 것화면라이브러리연결카탈로그보관함고급");
  expect(screen.queryByText("일반")).not.toBeInTheDocument();
  expect(screen.queryByText("정보·도움말")).not.toBeInTheDocument();
});

it("re-applies a repeated section request and exits on Esc", async () => {
  const gateway = createGateway();
  const onExit = vi.fn();
  const view = renderSettings(gateway, { initialSection: "display", sectionRequest: 1, onExit });
  expect(await within(screen.getByRole("toolbar")).findByRole("heading", { name: "화면" })).toBeInTheDocument();
  view.rerender(<LibraryProvider gateway={gateway}><SettingsView restoring={false} onRestore={vi.fn()} onExit={onExit} initialSection="vault" sectionRequest={2} /></LibraryProvider>);
  expect(await within(screen.getByRole("toolbar")).findByRole("heading", { name: "보관함" })).toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  expect(onExit).toHaveBeenCalledTimes(1);
});

it("saves and confirms deletion of connection credentials", async () => {
  const gateway = createGateway({
    getKakaoCredentialStatus: vi.fn().mockResolvedValue({ configured: false }),
    setKakaoApiKey: vi.fn().mockResolvedValue({ configured: true }),
    deleteKakaoApiKey: vi.fn().mockResolvedValue({ configured: false }),
    getIgdbCredentialStatus: vi.fn().mockResolvedValue({ configured: false }),
    getTmdbCredentialStatus: vi.fn().mockResolvedValue({ configured: false }),
    getStashdbCredentialStatus: vi.fn().mockResolvedValue({ configured: false }),
  });
  renderSettings(gateway, { initialSection: "connection" });
  await userEvent.click(await screen.findByRole("button", { name: "카카오 책 검색 입력" }));
  await userEvent.type(screen.getByLabelText("카카오 책 검색 입력"), "kakao-key");
  await userEvent.click(screen.getByRole("button", { name: "저장" }));
  await waitFor(() => expect(gateway.setKakaoApiKey).toHaveBeenCalledWith("kakao-key"));
  expect(screen.getAllByText("설정됨").length).toBeGreaterThan(0);
  await userEvent.click(screen.getByRole("button", { name: "카카오 책 검색 삭제" }));
  expect(screen.getByText("카카오 책 검색 설정을 삭제할까요?")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "삭제 확인" }));
  await waitFor(() => expect(gateway.deleteKakaoApiKey).toHaveBeenCalledTimes(1));
});

it("keeps the local backup restore confirmation flow", async () => {
  const onRestore = vi.fn().mockResolvedValue(undefined);
  const gateway = createGateway();
  renderSettings(gateway, { initialSection: "advanced", onRestore });
  const button = await screen.findByRole("button", { name: "이 시점으로 복구" });
  await userEvent.click(button);
  expect(screen.getByText("현재 상태를 보존한 뒤 선택한 시점으로 복구합니다.")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "복구 시작" }));
  await waitFor(() => expect(onRestore).toHaveBeenCalledWith("backup-1"));
});

it("keeps vault creation and recovery-key confirmation", async () => {
  const absent = { state: "absent" as const, vaultId: null, root: null, itemCount: null, remembered: false };
  const unlocked = { state: "unlocked" as const, vaultId: "vault-1", root: "/media/usb", itemCount: 0, remembered: true };
  const gateway = createGateway({
    getEncryptedVaultStatus: vi.fn().mockResolvedValue(absent),
    createEncryptedVault: vi.fn().mockResolvedValue({ status: unlocked, recoveryKey: "ab".repeat(32) }),
  });
  vi.mocked(open).mockResolvedValue("/media/usb" as never);
  renderSettings(gateway, { initialSection: "vault" });
  await userEvent.click(await screen.findByRole("button", { name: "새 보관함 만들기" }));
  await userEvent.click(screen.getByRole("button", { name: "보관할 폴더 선택" }));
  await userEvent.type(screen.getByLabelText("비밀번호"), "pw");
  await userEvent.type(screen.getByLabelText("비밀번호 확인"), "pw");
  await userEvent.click(screen.getByRole("button", { name: "만들기" }));
  expect(await screen.findByRole("group", { name: "비밀 보관함 복구키" })).toBeInTheDocument();
  const recovery = screen.getByRole("group", { name: "비밀 보관함 복구키" });
  await userEvent.click(within(recovery).getByRole("checkbox", { name: "복구키를 안전한 곳에 보관했습니다" }));
  await userEvent.click(within(recovery).getByRole("button", { name: "계속" }));
  expect(await screen.findByText("/media/usb")).toBeInTheDocument();
});

it("opens the existing pairing card in QR mode", async () => {
  const gateway = createGateway({ createExtensionPairing: vi.fn().mockResolvedValue({ pairingUrl: "https://cloud.test/pair#token", expiresAt: "2099-01-01T00:00:00Z" }) });
  renderSettings(gateway, { initialSection: "connection" });
  await userEvent.click(await screen.findByRole("button", { name: "QR 연결" }));
  expect(await screen.findByRole("region", { name: /QR|태블릿/ })).toBeInTheDocument();
  expect(gateway.createExtensionPairing).toHaveBeenCalledTimes(1);
});
