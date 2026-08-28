import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { LibraryGateway, MetadataBackup } from "../library/types";
import { SettingsView } from "./SettingsView";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
import { open } from "@tauri-apps/plugin-dialog";

afterEach(() => { vi.useRealTimers(); localStorage.clear(); cleanup(); });

it("keeps the current library when switching is cancelled", async () => {
  localStorage.setItem("lakomics.libraryPath", "C:\\Current");
  const gateway = createGateway();
  vi.mocked(gateway.openLibrary).mockResolvedValue({ root: "C:\\Current" });
  vi.mocked(open).mockResolvedValue(null);
  render(
    <LibraryProvider gateway={gateway}>
      <SettingsView restoring={false} onRestore={vi.fn()} onExit={vi.fn()} />
    </LibraryProvider>,
  );

  await screen.findByText("C:\\Current");
  await userEvent.click(screen.getByRole("button", { name: "다른 저장소 열기" }));

  expect(open).toHaveBeenCalledWith({ directory: true, multiple: false, defaultPath: "C:\\Current" });
  expect(gateway.openLibrary).toHaveBeenCalledTimes(1);
});

it("opens a selected library and disables duplicate switching while pending", async () => {
  localStorage.setItem("lakomics.libraryPath", "C:\\Current");
  const gateway = createGateway();
  let resolveSwitch!: (summary: { root: string }) => void;
  vi.mocked(gateway.openLibrary)
    .mockResolvedValueOnce({ root: "C:\\Current" })
    .mockReturnValueOnce(new Promise((resolve) => { resolveSwitch = resolve; }));
  vi.mocked(open).mockResolvedValue("D:\\Next");
  render(
    <LibraryProvider gateway={gateway}>
      <SettingsView restoring={false} onRestore={vi.fn()} onExit={vi.fn()} />
    </LibraryProvider>,
  );

  const button = await screen.findByRole("button", { name: "다른 저장소 열기" });
  await userEvent.click(button);
  expect(button).toBeDisabled();

  resolveSwitch({ root: "D:\\Next" });
  expect(await screen.findByText("D:\\Next")).toBeVisible();
  expect(localStorage.getItem("lakomics.libraryPath")).toBe("D:\\Next");
});

it("shows a switch error without replacing the current library", async () => {
  localStorage.setItem("lakomics.libraryPath", "C:\\Current");
  const gateway = createGateway();
  vi.mocked(gateway.openLibrary)
    .mockResolvedValueOnce({ root: "C:\\Current" })
    .mockRejectedValueOnce(new Error("switch failed"));
  vi.mocked(open).mockResolvedValue("D:\\Broken");
  render(
    <LibraryProvider gateway={gateway}>
      <SettingsView restoring={false} onRestore={vi.fn()} onExit={vi.fn()} />
    </LibraryProvider>,
  );

  await screen.findByText("C:\\Current");
  await userEvent.click(screen.getByRole("button", { name: "다른 저장소 열기" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("switch failed");
  expect(screen.getByText("C:\\Current")).toBeVisible();
  expect(localStorage.getItem("lakomics.libraryPath")).toBe("C:\\Current");
});

it("starts a repeatable metadata folder import and remembers the selected folder", async () => {
  localStorage.clear();
  vi.mocked(open).mockResolvedValue("C:\\exports\\lakomics" as never);
  const onImportFolder = vi.fn().mockResolvedValue(true);
  const gateway = createGateway();
  vi.mocked(gateway.getExtensionConnection).mockResolvedValue({ baseUrl: "http://127.0.0.1:32145", token: "token", status: "ready" });
  render(
    <LibraryProvider gateway={gateway}>
      <SettingsView restoring={false} onRestore={vi.fn()} onExit={vi.fn()} onImportFolder={onImportFolder} />
    </LibraryProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "데이터 관리" }));
  const metadataRow = (await screen.findByText("최근 가져오기 폴더")).parentElement;
  await userEvent.click(within(metadataRow!).getByRole("button", { name: "폴더 선택" }));
  await waitFor(() => expect(onImportFolder).toHaveBeenCalledWith("C:\\exports\\lakomics"));
  expect(localStorage.getItem("lakomics.metadataImportFolder")).toBe("C:\\exports\\lakomics");
});

it("acts as the window title bar", async () => {
  const gateway = createGateway();
  const { container } = render(
    <LibraryProvider gateway={gateway}>
      <SettingsView restoring={false} onRestore={vi.fn()} onExit={vi.fn()} />
    </LibraryProvider>,
  );
  await screen.findByRole("toolbar");
  expect(container.querySelector(".view-toolbar")).toHaveAttribute("data-tauri-drag-region");
  expect(container.querySelector(".view-toolbar h2")).toHaveAttribute("data-tauri-drag-region");
  expect(screen.getByRole("button", { name: "창 닫기" })).toBeInTheDocument();
});

it("uses the shared view toolbar with window controls", async () => {
  const gateway = createGateway();
  const { container } = render(
    <LibraryProvider gateway={gateway}>
      <SettingsView restoring={false} onRestore={vi.fn()} onExit={vi.fn()} />
    </LibraryProvider>,
  );
  expect(await screen.findByRole("toolbar")).toBeInTheDocument();
  expect(container.querySelector(".view-toolbar")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "창 닫기" })).toBeInTheDocument();
});

it("uses desktop settings navigation and compact property rows", async () => {
  const gateway = createGateway();
  const { container } = render(
    <LibraryProvider gateway={gateway}>
      <SettingsView restoring={false} onRestore={vi.fn()} onExit={vi.fn()} />
    </LibraryProvider>,
  );

  const navigation = screen.getByRole("navigation", { name: "설정 구역" });
  expect(navigation).toHaveClass("settings-view__navigation");
  expect(screen.getByRole("button", { name: "일반" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("heading", { name: "일반" })).toBeInTheDocument();
  expect(container.querySelectorAll(".settings-view__property")).toHaveLength(5);

  await userEvent.click(screen.getByRole("button", { name: "데이터 관리" }));
  expect(screen.getByRole("heading", { name: "데이터 관리" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "데이터 관리" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("heading", { name: "메타데이터 가져오기", level: 3 })).toBeInTheDocument();
});

it("groups data import and backup restore under 데이터 관리", async () => {
  const gateway = createGateway();
  render(
    <LibraryProvider gateway={gateway}>
      <SettingsView restoring={false} onRestore={vi.fn()} onExit={vi.fn()} initialSection="data" />
    </LibraryProvider>,
  );

  expect(await screen.findByRole("heading", { name: "데이터 관리" })).toBeInTheDocument();
  for (const group of ["컬렉션 가져오기", "메타데이터 가져오기", "레거시 패키지 가져오기", "백업 복구"]) {
    expect(screen.getByRole("heading", { name: group, level: 3 })).toBeInTheDocument();
  }
});

it("groups extension diagnostics and shortcuts under 정보", async () => {
  const gateway = createGateway();
  vi.mocked(gateway.getExtensionConnection).mockResolvedValue({ baseUrl: "http://127.0.0.1:32145", token: "token", status: "ready" });
  render(
    <LibraryProvider gateway={gateway}>
      <SettingsView restoring={false} onRestore={vi.fn()} onExit={vi.fn()} initialSection="about" />
    </LibraryProvider>,
  );

  expect(await screen.findByRole("heading", { name: "정보" })).toBeInTheDocument();
  for (const group of ["브라우저 확장", "단축키", "버튼 설명"]) {
    expect(screen.getByRole("heading", { name: group, level: 3 })).toBeInTheDocument();
  }
});

it("toggles privacy mode from the general section", async () => {
  const user = userEvent.setup();
  const gateway = createGateway();
  const onPrivacyModeChange = vi.fn();
  render(
    <LibraryProvider gateway={gateway}>
      <SettingsView restoring={false} onRestore={vi.fn()} onExit={vi.fn()} privacyMode={false} onPrivacyModeChange={onPrivacyModeChange} />
    </LibraryProvider>,
  );

  const toggle = screen.getByRole("checkbox", { name: "비공개 모드" });
  expect(toggle).not.toBeChecked();
  await user.click(toggle);

  expect(onPrivacyModeChange).toHaveBeenCalledWith(true);
});

it("shows every external service status at once in the connection list", async () => {
  const gateway = createGateway();
  vi.mocked(gateway.getAladinCredentialStatus).mockResolvedValue({ configured: true });
  vi.mocked(gateway.getIgdbCredentialStatus).mockResolvedValue({ configured: false });
  vi.mocked(gateway.getTmdbCredentialStatus).mockResolvedValue({ configured: false });
  render(
    <LibraryProvider gateway={gateway}>
      <SettingsView restoring={false} onRestore={vi.fn()} onExit={vi.fn()} initialSection="external_services" />
    </LibraryProvider>,
  );

  const aladinRow = (await screen.findByText("알라딘 OpenAPI")).parentElement;
  const igdbRow = screen.getByText("IGDB").parentElement;
  const tmdbRow = screen.getByText("TMDB").parentElement;
  expect(within(aladinRow!).getByLabelText("알라딘 TTB 키")).toHaveAttribute("placeholder", "설정됨");
  expect(within(aladinRow!).getByRole("button", { name: "키 삭제" })).toBeVisible();
  expect(within(igdbRow!).getByLabelText("IGDB Client ID")).toHaveAttribute("placeholder", "설정되지 않음");
  expect(within(igdbRow!).queryByRole("button", { name: "IGDB 키 삭제" })).not.toBeInTheDocument();
  expect(within(tmdbRow!).getByLabelText("TMDB API Read Access Token")).toHaveAttribute("placeholder", "설정되지 않음");
  expect(within(tmdbRow!).queryByRole("button", { name: "TMDB 키 삭제" })).not.toBeInTheDocument();
});

it("loads the manga root and changes it through the folder picker", async () => {
  const user = userEvent.setup();
  const gateway = createGateway();
  vi.mocked(gateway.getMangaRoot).mockResolvedValue("C:\\Manga");
  vi.mocked(open).mockResolvedValue("D:\\NewManga");
  render(
    <LibraryProvider gateway={gateway}>
      <SettingsView restoring={false} onRestore={vi.fn()} onExit={vi.fn()} />
    </LibraryProvider>,
  );

  expect(await screen.findByText("C:\\Manga")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "변경" }));

  await waitFor(() => expect(gateway.setMangaRoot).toHaveBeenCalledWith("D:\\NewManga"));
  expect(await screen.findByText("D:\\NewManga")).toBeInTheDocument();
});

it("keeps the current manga root when the folder picker is cancelled", async () => {
  const user = userEvent.setup();
  const gateway = createGateway();
  vi.mocked(gateway.getMangaRoot).mockResolvedValue("C:\\Manga");
  vi.mocked(open).mockResolvedValue(null);
  render(
    <LibraryProvider gateway={gateway}>
      <SettingsView restoring={false} onRestore={vi.fn()} onExit={vi.fn()} />
    </LibraryProvider>,
  );

  await user.click(await screen.findByRole("button", { name: "변경" }));

  await waitFor(() => expect(open).toHaveBeenCalledWith({ directory: true, multiple: false }));
  expect(gateway.setMangaRoot).not.toHaveBeenCalled();
  expect(screen.getByText("C:\\Manga")).toBeInTheDocument();
});

it("loads the collection source root, backfills legacy kinds, and reports the count", async () => {
  const user = userEvent.setup();
  const onCollectionsChanged = vi.fn();
  const gateway = createGateway();
  vi.mocked(gateway.getCollectionSourceRoot).mockResolvedValue("C:\\book");
  vi.mocked(gateway.setCollectionSourceRoot).mockResolvedValue(207);
  vi.mocked(open).mockResolvedValue("C:\\lakomics\\book");
  render(
    <LibraryProvider gateway={gateway}>
      <SettingsView restoring={false} onRestore={vi.fn()} onExit={vi.fn()} onCollectionsChanged={onCollectionsChanged} />
    </LibraryProvider>,
  );

  expect(await screen.findByText("C:\\book")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "컬렉션 소스 폴더 변경" }));

  await waitFor(() => expect(gateway.setCollectionSourceRoot).toHaveBeenCalledWith("C:\\lakomics\\book"));
  expect(await screen.findByText("레거시 출처를 207개 컬렉션에 표시했습니다")).toBeVisible();
  expect(onCollectionsChanged).toHaveBeenCalled();
  expect(screen.getByText("C:\\lakomics\\book")).toBeInTheDocument();
});

it("keeps the current collection source root when the folder picker is cancelled", async () => {
  const user = userEvent.setup();
  const gateway = createGateway();
  vi.mocked(gateway.getCollectionSourceRoot).mockResolvedValue("C:\\book");
  vi.mocked(open).mockResolvedValue(null);
  render(
    <LibraryProvider gateway={gateway}>
      <SettingsView restoring={false} onRestore={vi.fn()} onExit={vi.fn()} />
    </LibraryProvider>,
  );

  await user.click(await screen.findByRole("button", { name: "컬렉션 소스 폴더 변경" }));

  await waitFor(() => expect(open).toHaveBeenCalledWith({ directory: true, multiple: false }));
  expect(gateway.setCollectionSourceRoot).not.toHaveBeenCalled();
  expect(screen.getByText("C:\\book")).toBeInTheDocument();
});

it("shows an error when the collection source root cannot be saved", async () => {
  const user = userEvent.setup();
  const gateway = createGateway();
  vi.mocked(gateway.getCollectionSourceRoot).mockResolvedValue(null);
  vi.mocked(gateway.setCollectionSourceRoot).mockRejectedValue(new Error("디스크 오류"));
  vi.mocked(open).mockResolvedValue("C:\\book");
  render(
    <LibraryProvider gateway={gateway}>
      <SettingsView restoring={false} onRestore={vi.fn()} onExit={vi.fn()} />
    </LibraryProvider>,
  );

  await user.click(await screen.findByRole("button", { name: "컬렉션 소스 폴더 변경" }));

  expect(await screen.findByText("디스크 오류")).toBeVisible();
});

it("keeps backup load errors visible for retry", async () => {
  vi.useFakeTimers();
  let rejectBackups!: (error: Error) => void;
  let resolveRetry!: (backups: MetadataBackup[]) => void;
  const failed = new Promise<MetadataBackup[]>((_resolve, reject) => { rejectBackups = reject; });
  const retried = new Promise<MetadataBackup[]>((resolve) => { resolveRetry = resolve; });
  const gateway = createGateway();
  vi.mocked(gateway.listMetadataBackups).mockReturnValueOnce(failed).mockReturnValueOnce(retried);
  render(
    <LibraryProvider gateway={gateway}>
      <SettingsView restoring={false} onRestore={vi.fn()} onExit={vi.fn()} />
    </LibraryProvider>,
  );

  fireEvent.click(screen.getByRole("button", { name: "데이터 관리" }));
  act(() => vi.advanceTimersByTime(0));
  await act(async () => { rejectBackups(new Error("backup failed")); await failed.catch(() => undefined); });
  act(() => vi.advanceTimersByTime(5_000));

  expect(screen.getByText("backup failed")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  act(() => vi.advanceTimersByTime(0));
  await act(async () => { resolveRetry([]); await retried; });

  expect(gateway.listMetadataBackups).toHaveBeenCalledTimes(2);
  expect(screen.getByText("사용할 수 있는 백업이 없습니다.")).toBeVisible();
  expect(screen.queryByText("backup failed")).not.toBeInTheDocument();
});

it("shows the Edge connection and copies its hidden key on request", async () => {
  const user = userEvent.setup();
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  const gateway = createGateway();
  vi.mocked(gateway.getExtensionConnection).mockResolvedValue({
    baseUrl: "http://127.0.0.1:32145",
    token: "0123456789abcdef0123456789abcdef",
    status: "ready",
  });
  render(
    <LibraryProvider gateway={gateway}>
      <SettingsView restoring={false} onRestore={vi.fn()} onExit={vi.fn()} />
    </LibraryProvider>,
  );

  await user.click(screen.getByRole("button", { name: "정보" }));

  expect(await screen.findByText("연결됨")).toBeVisible();
  expect(screen.getByText("http://127.0.0.1:32145")).toBeVisible();
  const token = screen.getByLabelText("확장 프로그램 연결 키");
  expect(token).toHaveAttribute("type", "password");
  expect(token).toHaveAttribute("readonly");
  expect(writeText).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: "연결 키 복사" }));

  expect(writeText).toHaveBeenCalledWith("0123456789abcdef0123456789abcdef");
  expect(await screen.findByText("연결 키를 복사했습니다")).toBeVisible();
});

it("stores and removes an Aladin key without reading it back", async () => {
  const user = userEvent.setup();
  const gateway = createGateway();
  vi.mocked(gateway.getAladinCredentialStatus).mockResolvedValue({ configured: false });
  vi.mocked(gateway.setAladinTtbKey).mockResolvedValue({ configured: true });
  vi.mocked(gateway.deleteAladinTtbKey).mockResolvedValue({ configured: false });
  render(
    <LibraryProvider gateway={gateway}>
      <SettingsView restoring={false} onRestore={vi.fn()} onExit={vi.fn()} />
    </LibraryProvider>,
  );

  await user.click(screen.getByRole("button", { name: "외부 서비스" }));
  const aladinStatusRow = (await screen.findByText("알라딘 OpenAPI")).parentElement;
  expect(within(aladinStatusRow!).getByLabelText("알라딘 TTB 키")).toHaveAttribute("placeholder", "설정되지 않음");
  expect(await gateway.getAladinCredentialStatus()).toEqual({ configured: false });
  await user.type(screen.getByLabelText("알라딘 TTB 키"), "new-secret");
  await user.click(screen.getByRole("button", { name: "저장" }));

  expect(gateway.setAladinTtbKey).toHaveBeenCalledWith("new-secret");
  expect(screen.getByLabelText("알라딘 TTB 키")).toHaveValue("");
  expect(within(aladinStatusRow!).getByLabelText("알라딘 TTB 키")).toHaveAttribute("placeholder", "설정됨");
  expect(screen.queryByDisplayValue("new-secret")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "키 삭제" }));
  expect(screen.getByText("저장된 알라딘 TTB 키를 삭제할까요?")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "삭제 확인" }));
  expect(gateway.deleteAladinTtbKey).toHaveBeenCalledOnce();
  expect(within(aladinStatusRow!).getByLabelText("알라딘 TTB 키")).toHaveAttribute("placeholder", "설정되지 않음");
});

it("opens the requested settings section", async () => {
  const gateway = createGateway();
  vi.mocked(gateway.getAladinCredentialStatus).mockResolvedValue({ configured: false });
  vi.mocked(gateway.getIgdbCredentialStatus).mockResolvedValue({ configured: false });
  vi.mocked(gateway.getOnlineCatalogStatus).mockResolvedValue({ installed: false, workCount: 0, updateEnabled: false, updateIntervalSeconds: 0, lastAttemptAt: null, lastSuccessAt: null, lastAdded: 0, lastError: null });
  render(
    <LibraryProvider gateway={gateway}>
      <SettingsView restoring={false} onRestore={vi.fn()} onExit={vi.fn()} initialSection="external_services" />
    </LibraryProvider>,
  );

  expect(await screen.findByRole("heading", { name: "외부 서비스" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "외부 서비스" })).toHaveAttribute("aria-current", "page");
});

it("shows only IGDB credential status and keeps stored values out of the inputs", async () => {
  const user = userEvent.setup();
  const gateway = createGateway();
  vi.mocked(gateway.getAladinCredentialStatus).mockResolvedValue({ configured: false });
  vi.mocked(gateway.getIgdbCredentialStatus).mockResolvedValue({ configured: true });
  render(
    <LibraryProvider gateway={gateway}>
      <SettingsView restoring={false} onRestore={vi.fn()} onExit={vi.fn()} />
    </LibraryProvider>,
  );

  await user.click(screen.getByRole("button", { name: "외부 서비스" }));
  const statusRow = (await screen.findByText("IGDB")).parentElement;
  expect(statusRow).not.toBeNull();
  expect(within(statusRow!).getByLabelText("IGDB Client ID")).toHaveAttribute("placeholder", "설정됨");
  expect(screen.getByLabelText("IGDB Client ID")).toHaveAttribute("type", "password");
  expect(screen.getByLabelText("IGDB Client Secret")).toHaveAttribute("type", "password");
  expect(screen.getByLabelText("IGDB Client ID")).toHaveValue("");
  expect(screen.getByLabelText("IGDB Client Secret")).toHaveValue("");
  expect(screen.queryByDisplayValue("stored-client-id")).not.toBeInTheDocument();
  expect(screen.queryByDisplayValue("stored-client-secret")).not.toBeInTheDocument();
});

it("saves both IGDB credentials exactly and clears them after success", async () => {
  const user = userEvent.setup();
  const gateway = createGateway();
  vi.mocked(gateway.getAladinCredentialStatus).mockResolvedValue({ configured: false });
  vi.mocked(gateway.getIgdbCredentialStatus).mockResolvedValue({ configured: false });
  vi.mocked(gateway.setIgdbCredentials).mockResolvedValue({ configured: true });
  render(
    <LibraryProvider gateway={gateway}>
      <SettingsView restoring={false} onRestore={vi.fn()} onExit={vi.fn()} />
    </LibraryProvider>,
  );

  await user.click(screen.getByRole("button", { name: "외부 서비스" }));
  const clientId = await screen.findByLabelText("IGDB Client ID");
  const clientSecret = screen.getByLabelText("IGDB Client Secret");
  expect(screen.getByRole("button", { name: "IGDB 저장" })).toBeDisabled();
  await user.type(clientId, " client-id ");
  await user.type(clientSecret, " client-secret ");
  await user.click(screen.getByRole("button", { name: "IGDB 저장" }));

  expect(gateway.setIgdbCredentials).toHaveBeenCalledWith({ clientId: " client-id ", clientSecret: " client-secret " });
  expect(clientId).toHaveValue("");
  expect(clientSecret).toHaveValue("");
  const statusRow = screen.getByText("IGDB").parentElement;
  expect(within(statusRow!).getByLabelText("IGDB Client ID")).toHaveAttribute("placeholder", "설정됨");
});

it("requires confirmation before deleting IGDB credentials", async () => {
  const user = userEvent.setup();
  const gateway = createGateway();
  vi.mocked(gateway.getAladinCredentialStatus).mockResolvedValue({ configured: false });
  vi.mocked(gateway.getIgdbCredentialStatus).mockResolvedValue({ configured: true });
  vi.mocked(gateway.deleteIgdbCredentials).mockResolvedValue({ configured: false });
  render(
    <LibraryProvider gateway={gateway}>
      <SettingsView restoring={false} onRestore={vi.fn()} onExit={vi.fn()} />
    </LibraryProvider>,
  );

  await user.click(screen.getByRole("button", { name: "외부 서비스" }));
  const statusRow = (await screen.findByText("IGDB")).parentElement;
  await user.click(within(statusRow!).getByRole("button", { name: "IGDB 키 삭제" }));
  expect(gateway.deleteIgdbCredentials).not.toHaveBeenCalled();
  expect(screen.getByText("저장된 IGDB 자격 증명을 삭제할까요?")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "IGDB 삭제 확인" }));

  expect(gateway.deleteIgdbCredentials).toHaveBeenCalledOnce();
  expect(within(statusRow!).getByLabelText("IGDB Client ID")).toHaveAttribute("placeholder", "설정되지 않음");
});

it("stores and removes a TMDB token without reading it back", async () => {
  const user = userEvent.setup();
  const gateway = createGateway();
  vi.mocked(gateway.getTmdbCredentialStatus).mockResolvedValue({ configured: false });
  vi.mocked(gateway.setTmdbToken).mockResolvedValue({ configured: true });
  vi.mocked(gateway.deleteTmdbToken).mockResolvedValue({ configured: false });
  render(
    <LibraryProvider gateway={gateway}>
      <SettingsView restoring={false} onRestore={vi.fn()} onExit={vi.fn()} initialSection="external_services" />
    </LibraryProvider>,
  );

  const statusRow = (await screen.findByText("TMDB")).parentElement;
  expect(statusRow).not.toBeNull();
  const token = screen.getByLabelText("TMDB API Read Access Token");
  expect(within(statusRow!).getByLabelText("TMDB API Read Access Token")).toHaveAttribute("placeholder", "설정되지 않음");
  expect(token).toHaveAttribute("type", "password");
  expect(token).toHaveValue("");
  await user.type(token, "  tmdb-secret  ");
  await user.click(screen.getByRole("button", { name: "TMDB 저장" }));

  expect(gateway.setTmdbToken).toHaveBeenCalledWith("tmdb-secret");
  expect(token).toHaveValue("");
  expect(within(statusRow!).getByLabelText("TMDB API Read Access Token")).toHaveAttribute("placeholder", "설정됨");
  expect(screen.queryByDisplayValue("tmdb-secret")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "TMDB 키 삭제" }));
  expect(gateway.deleteTmdbToken).not.toHaveBeenCalled();
  expect(screen.getByText("저장된 TMDB API Read Access Token을 삭제할까요?")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "TMDB 삭제 확인" }));

  expect(gateway.deleteTmdbToken).toHaveBeenCalledOnce();
  expect(within(statusRow!).getByLabelText("TMDB API Read Access Token")).toHaveAttribute("placeholder", "설정되지 않음");
});

it("changes online catalog automatic update settings", async () => {
  const user = userEvent.setup();
  const gateway = createGateway();
  vi.mocked(gateway.getAladinCredentialStatus).mockResolvedValue({ configured: false });
  vi.mocked(gateway.getOnlineCatalogStatus).mockResolvedValue({
    installed: true,
    workCount: 100,
    updateEnabled: true,
    updateIntervalSeconds: 3_600,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastAdded: 0,
    lastError: null,
  });
  vi.mocked(gateway.setOnlineCatalogUpdateSettings).mockImplementation(async (enabled, intervalSeconds) => ({
    installed: true,
    workCount: 100,
    updateEnabled: enabled,
    updateIntervalSeconds: intervalSeconds,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastAdded: 0,
    lastError: null,
  }));
  render(
    <LibraryProvider gateway={gateway}>
      <SettingsView restoring={false} onRestore={vi.fn()} onExit={vi.fn()} />
    </LibraryProvider>,
  );

  await user.click(screen.getByRole("button", { name: "외부 서비스" }));
  const toggle = await screen.findByRole("checkbox", { name: "자동 갱신" });
  expect(toggle).toBeChecked();
  await user.selectOptions(screen.getByRole("combobox", { name: "갱신 간격" }), "21600");
  expect(gateway.setOnlineCatalogUpdateSettings).toHaveBeenCalledWith(true, 21_600);
  await user.click(toggle);
  expect(gateway.setOnlineCatalogUpdateSettings).toHaveBeenCalledWith(false, 21_600);
});

it("confirms before clearing the remote manga cache", async () => {
  const user = userEvent.setup();
  const gateway = createGateway();
  vi.mocked(gateway.getAladinCredentialStatus).mockResolvedValue({ configured: false });
  vi.mocked(gateway.clearRemoteMangaCache).mockResolvedValue(undefined);
  render(
    <LibraryProvider gateway={gateway}>
      <SettingsView restoring={false} onRestore={vi.fn()} onExit={vi.fn()} />
    </LibraryProvider>,
  );

  await user.click(screen.getByRole("button", { name: "외부 서비스" }));
  await user.click(await screen.findByRole("button", { name: "이미지 캐시 지우기" }));
  expect(gateway.clearRemoteMangaCache).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "캐시 삭제 확인" }));
  expect(gateway.clearRemoteMangaCache).toHaveBeenCalledOnce();
  expect(await screen.findByText("온라인 이미지 캐시를 지웠습니다")).toBeVisible();
});

function createGateway(): LibraryGateway {
  return {
    getIgdbCredentialStatus: vi.fn().mockResolvedValue({ configured: false }),
    setIgdbCredentials: vi.fn(),
    deleteIgdbCredentials: vi.fn(),
    searchIgdbGames: vi.fn(),
    previewIgdbGame: vi.fn(),
    applyIgdbGame: vi.fn(),
    refreshIgdbGame: vi.fn(),
    getIgdbConnection: vi.fn(),
    replaceIgdbGameArtwork: vi.fn(),
    getTmdbCredentialStatus: vi.fn().mockResolvedValue({ configured: false }),
    setTmdbToken: vi.fn(),
    deleteTmdbToken: vi.fn(),
    searchTmdbMovies: vi.fn(),
    previewTmdbMovie: vi.fn(),
    applyTmdbMovie: vi.fn(),
    refreshTmdbMovie: vi.fn(),
    getTmdbConnection: vi.fn(),
    replaceTmdbMovieArtwork: vi.fn(),
    openLibrary: vi.fn(), importVckCatalog: vi.fn(), getOnlineCatalogStatus: vi.fn().mockResolvedValue({ installed: false, workCount: 0, updateEnabled: true, updateIntervalSeconds: 3600, lastAttemptAt: null, lastSuccessAt: null, lastAdded: 0, lastError: null }), searchOnlineCatalog: vi.fn(), suggestOnlineCatalog: vi.fn(), updateOnlineCatalog: vi.fn(), setOnlineCatalogUpdateSettings: vi.fn(), runDueOnlineCatalogUpdate: vi.fn(), getOnlineCatalogWorkDetail: vi.fn(), setOnlineCatalogBookmark: vi.fn(), resolveOnlineCatalogWork: vi.fn(), getRemoteReadingProgress: vi.fn(), saveRemoteReadingProgress: vi.fn(), clearRemoteMangaCache: vi.fn(), getExtensionConnection: vi.fn(), listClassifications: vi.fn(),
    listAlbums: vi.fn().mockResolvedValue([]), createAlbum: vi.fn(), renameAlbum: vi.fn(), moveAlbum: vi.fn(), updateAlbumAppearance: vi.fn(), deleteAlbum: vi.fn(),
    createClassification: vi.fn(), renameClassification: vi.fn(), moveClassification: vi.fn(), updateClassificationAppearance: vi.fn(),
    deleteClassification: vi.fn(), listAssets: vi.fn(), listAssetDateBuckets: vi.fn().mockResolvedValue([]), indexMissingSimilarityHashes: vi.fn(),
    listSimilarityReviews: vi.fn(), decideSimilarityReview: vi.fn(), getAsset: vi.fn(), updateAssetMetadata: vi.fn(), setAssetFavorite: vi.fn(), setAssetsFavorite: vi.fn(),
    getAssetClassifications: vi.fn(), setAssetClassification: vi.fn(), patchAssetAlbums: vi.fn(), getAssetAlbums: vi.fn().mockResolvedValue([]), ingestMedia: vi.fn(),
    listCollections: vi.fn().mockResolvedValue([]), searchMangaDex: vi.fn(), previewMangaDex: vi.fn(), applyMangaDex: vi.fn(), refreshMangaDex: vi.fn(), getMangaDexConnection: vi.fn().mockResolvedValue(null), createCollection: vi.fn(), updateCollection: vi.fn(), deleteCollection: vi.fn(), setCollectionCover: vi.fn(), setCollectionShowcase: vi.fn(), getAssetCollections: vi.fn().mockResolvedValue([]), patchAssetCollections: vi.fn(),
    preparePendingVideos: vi.fn(), retryVideoPreparation: vi.fn(), inspectBookImport: vi.fn(), importBookCollections: vi.fn(), getCollectionSourceRoot: vi.fn().mockResolvedValue(null), setCollectionSourceRoot: vi.fn().mockResolvedValue(0), listCollectionCovers: vi.fn(), listCollectionVolumes: vi.fn(), syncMangaDexVolumeCovers: vi.fn(), inspectLegacyPackageMigration: vi.fn(), executeLegacyPackageMigration: vi.fn(), getAladinCredentialStatus: vi.fn().mockResolvedValue({ configured: false }), setAladinTtbKey: vi.fn(), deleteAladinTtbKey: vi.fn(), searchAladin: vi.fn(), applyAladin: vi.fn(), refreshAladin: vi.fn(), getAladinConnection: vi.fn(), getReleaseWatchStatus: vi.fn().mockResolvedValue({ enabled: false, lastCheckedAt: null }), setReleaseWatchEnabled: vi.fn().mockResolvedValue({ enabled: false, lastCheckedAt: null }), takeUnreadReleaseChanges: vi.fn().mockResolvedValue([]), runDueReleaseWatch: vi.fn().mockResolvedValue({ checked: 0, changedCollections: 0, skipped: 0, stopReason: null }),
    getMangaRoot: vi.fn().mockResolvedValue(null), setMangaRoot: vi.fn().mockResolvedValue(undefined), scanManga: vi.fn().mockResolvedValue(0), listMangaSeries: vi.fn().mockResolvedValue([]),
    trashAssets: vi.fn(), restoreAsset: vi.fn(), restoreAssets: vi.fn(),
    listTrash: vi.fn(), emptyTrash: vi.fn(), getTrashPolicy: vi.fn(), setTrashPolicy: vi.fn(),
    ensureDailyBackup: vi.fn(), listMetadataBackups: vi.fn().mockResolvedValue([]),
    restoreMetadataBackup: vi.fn(), purgeExpiredTrash: vi.fn(),
  };
}
