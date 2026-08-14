import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import type { ExtensionConnection, MetadataBackup } from "../library/types";
import { ViewToolbar } from "../layout/ViewToolbar";
import { Button } from "../shared/ui/Button";
import { Skeleton } from "../shared/ui/Skeleton";
import { Toast } from "../shared/ui/Toast";
import { useAutoDismiss } from "../shared/ui/useAutoDismiss";

type SettingsViewProps = {
  restoring: boolean;
  onRestore: (backupId: string) => Promise<void>;
  onExit: () => void;
  onImportFolder?: (folder: string) => Promise<boolean>;
  metadataImportRunning?: boolean;
};

const METADATA_IMPORT_FOLDER_KEY = "lakomics.metadataImportFolder";

export function SettingsView({ restoring, onRestore, onExit, onImportFolder, metadataImportRunning = false }: SettingsViewProps) {
  const { error: libraryError, gateway, library, openLibrary } = useLibrary();
  const [section, setSection] = useState<"general" | "browser_extension" | "metadata_import" | "safety" | "shortcuts">("general");
  const [lastImportFolder, setLastImportFolder] = useState(() => localStorage.getItem(METADATA_IMPORT_FOLDER_KEY));
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [backups, setBackups] = useState<MetadataBackup[] | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [backupRetryVersion, setBackupRetryVersion] = useState(0);
  useAutoDismiss(backups === null ? null : error, setError);
  const [submitting, setSubmitting] = useState(false);
  const [mangaRoot, setMangaRoot] = useState<string | null>(null);
  const [mangaRootError, setMangaRootError] = useState<string | null>(null);
  useAutoDismiss(mangaRootError, setMangaRootError);
  const [extensionConnection, setExtensionConnection] = useState<ExtensionConnection | null>(null);
  const [extensionError, setExtensionError] = useState<string | null>(null);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const [switchingLibrary, setSwitchingLibrary] = useState(false);
  useAutoDismiss(extensionError, setExtensionError);
  useAutoDismiss(copyMessage, setCopyMessage);
  const pending = restoring || submitting;

  useEffect(() => {
    let active = true;
    void gateway.getMangaRoot().then((root) => { if (active) setMangaRoot(root); });
    return () => { active = false; };
  }, [gateway]);

  useEffect(() => {
    if (section !== "browser_extension") return;
    let active = true;
    setExtensionConnection(null);
    setExtensionError(null);
    void gateway.getExtensionConnection().then((connection) => {
      if (active) setExtensionConnection(connection);
    }).catch((loadError: unknown) => {
      if (active) setExtensionError(commandErrorMessage(loadError, "확장 프로그램 연결 정보를 불러오지 못했습니다."));
    });
    return () => { active = false; };
  }, [gateway, section]);

  useEffect(() => {
    void getVersion().then(setAppVersion).catch(() => setAppVersion(null));
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void gateway.listMetadataBackups().then((nextBackups) => {
        if (!controller.signal.aborted) { setBackups(nextBackups); setError(null); }
      }).catch((loadError: unknown) => {
        if (!controller.signal.aborted) setError(commandErrorMessage(loadError, "백업 목록을 불러오지 못했습니다."));
      });
    }, section === "safety" ? 0 : 250);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [backupRetryVersion, gateway, section]);

  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) onExit();
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [onExit, pending]);

  async function restore() {
    if (!confirmingId || pending) return;
    setSubmitting(true);
    setError(null);
    try {
      await onRestore(confirmingId);
      setConfirmingId(null);
    } catch (restoreError) {
      setError(commandErrorMessage(restoreError, "백업을 복구하지 못했습니다."));
    } finally {
      setSubmitting(false);
    }
  }

  async function chooseLibraryFolder() {
    if (switchingLibrary || pending || metadataImportRunning) return;
    setSwitchingLibrary(true);
    try {
      const selected = await open({ directory: true, multiple: false, defaultPath: library?.root });
      if (typeof selected === "string") await openLibrary(selected);
    } finally {
      setSwitchingLibrary(false);
    }
  }

  async function chooseMangaFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected !== "string") return;
    try {
      await gateway.setMangaRoot(selected);
      setMangaRoot(selected);
    } catch (error) {
      setMangaRootError(commandErrorMessage(error, "망가 폴더를 설정하지 못했습니다."));
    }
  }

  async function copyExtensionToken() {
    if (!extensionConnection?.token) return;
    try {
      await navigator.clipboard.writeText(extensionConnection.token);
      setExtensionError(null);
      setCopyMessage("연결 키를 복사했습니다");
    } catch (copyError) {
      setCopyMessage(null);
      setExtensionError(commandErrorMessage(copyError, "연결 키를 복사하지 못했습니다."));
    }
  }

  async function chooseImportFolder() {
    const selected = await open({ directory: true, multiple: false, defaultPath: localStorage.getItem(METADATA_IMPORT_FOLDER_KEY) ?? undefined });
    if (typeof selected !== "string") return;
    if (await onImportFolder?.(selected)) {
      localStorage.setItem(METADATA_IMPORT_FOLDER_KEY, selected);
      setLastImportFolder(selected);
    }
  }

  return <section className="settings-view" aria-label="설정" onKeyDown={(event) => { if (event.key === "Escape" && !pending) onExit(); }}>
    <ViewToolbar title="설정" />
    <div className="settings-view__body">
    <nav className="settings-view__navigation" aria-label="설정 구역">
      <Button className="settings-view__section-button" variant="ghost" aria-current={section === "general" ? "page" : undefined} onClick={() => setSection("general")}>일반</Button>
      <Button className="settings-view__section-button" variant="ghost" aria-current={section === "browser_extension" ? "page" : undefined} onClick={() => setSection("browser_extension")}>브라우저 확장</Button>
      <Button className="settings-view__section-button" variant="ghost" aria-current={section === "metadata_import" ? "page" : undefined} onClick={() => setSection("metadata_import")}>메타데이터 가져오기</Button>
      <Button className="settings-view__section-button" variant="ghost" aria-current={section === "safety" ? "page" : undefined} onClick={() => setSection("safety")}>안전</Button>
      <Button className="settings-view__section-button" variant="ghost" aria-current={section === "shortcuts" ? "page" : undefined} onClick={() => setSection("shortcuts")}>단축키</Button>
    </nav>
    <div className="settings-view__content">
    {section === "general" && (
      <div className="settings-view__section">
        <header className="settings-view__header"><h2>일반</h2><p>라이브러리와 외부 콘텐츠 폴더를 관리합니다.</p></header>
        <dl className="settings-view__property">
          <dt>라이브러리 폴더</dt>
          <dd className="settings-view__path">{library?.root ?? "알 수 없음"}</dd>
          <Button size="sm" disabled={switchingLibrary || pending || metadataImportRunning} onClick={() => void chooseLibraryFolder()}>
            {switchingLibrary ? "여는 중…" : "다른 저장소 열기"}
          </Button>
          {libraryError && <dd className="settings-view__row-message" role="alert">{libraryError}</dd>}
        </dl>
        <dl className="settings-view__property">
          <dt>앱 버전</dt>
          <dd>{appVersion ?? "알 수 없음"}</dd>
        </dl>
        <dl className="settings-view__property">
          <dt>망가 폴더</dt>
          <dd className="settings-view__path">{mangaRoot ?? "설정되지 않음"}</dd>
          <Button size="sm" onClick={() => void chooseMangaFolder()}>변경</Button>
          {mangaRootError && <dd className="settings-view__row-message" role="alert">{mangaRootError}</dd>}
        </dl>
      </div>
    )}
    {section === "browser_extension" && (
      <div className="settings-view__section">
        <header className="settings-view__header"><h2>브라우저 확장</h2><p>Edge 확장 프로그램의 로컬 연결을 확인합니다.</p></header>
        {extensionError && <Toast onDismiss={() => setExtensionError(null)}>{extensionError}</Toast>}
        {!extensionConnection && !extensionError ? (
          <Skeleton className="settings-view__skeleton" label="확장 프로그램 연결 정보를 불러오는 중" />
        ) : extensionConnection ? (
          <>
            <dl className="settings-view__property">
              <dt>연결 상태</dt>
              <dd>{extensionConnection.status === "ready" ? "연결됨" : "사용 불가"}</dd>
            </dl>
            <dl className="settings-view__property">
              <dt>로컬 주소</dt>
              <dd className="settings-view__path">{extensionConnection.baseUrl}</dd>
            </dl>
            <label className="settings-view__property">
              <span className="settings-view__property-label">연결 키</span>
              <span className="settings-view__token-row">
                <input
                  className="settings-view__token"
                  aria-label="확장 프로그램 연결 키"
                  type="password"
                  readOnly
                  value={extensionConnection.token}
                />
                <Button
                  size="sm"
                  disabled={!extensionConnection.token}
                  onClick={() => void copyExtensionToken()}
                >연결 키 복사</Button>
              </span>
            </label>
            {copyMessage && <Toast onDismiss={() => setCopyMessage(null)}>{copyMessage}</Toast>}
          </>
        ) : null}
      </div>
    )}
    {section === "metadata_import" && (
      <div className="settings-view__section">
        <header className="settings-view__header"><h2>메타데이터 가져오기</h2><p>내보낸 JSON을 기준으로 분류와 이미지 사본을 가져옵니다. 원본은 변경하지 않습니다.</p></header>
        <dl className="settings-view__property">
          <dt>최근 가져오기 폴더</dt>
          <dd className="settings-view__path">{lastImportFolder ?? "아직 없음"}</dd>
        </dl>
        <div className="settings-view__actions">
          {lastImportFolder && <Button disabled={pending || metadataImportRunning || !onImportFolder} onClick={() => void onImportFolder?.(lastImportFolder)}>최근 폴더 다시 가져오기</Button>}
          <Button variant="primary" disabled={pending || metadataImportRunning || !onImportFolder} onClick={() => void chooseImportFolder()}>{lastImportFolder ? "다른 폴더 선택" : "폴더 선택"}</Button>
        </div>
      </div>
    )}
    {section === "safety" && (
      <div className="settings-view__section settings-view__safety">
        <header className="settings-view__header"><h2>안전</h2><p>자동 백업에서 라이브러리 관리 정보를 복구합니다.</p></header>
        {confirmingId ? (
          <div className="settings-view__safety-confirm">
            <p>현재 상태를 별도로 보존한 뒤 선택한 시점으로 관리 정보를 복구합니다.</p>
            {error && <Toast onDismiss={() => setError(null)}>{error}</Toast>}
            <div className="ui-dialog__actions">
              <Button disabled={pending} onClick={() => setConfirmingId(null)}>취소</Button>
              <Button variant="primary" disabled={pending} onClick={() => void restore()}>
                {pending ? "복구 중…" : "복구 시작"}
              </Button>
            </div>
          </div>
        ) : (
          <>
            {error && <div className="settings-view__safety-error"><Toast>{error}</Toast><Button onClick={() => { setError(null); setBackups(null); setBackupRetryVersion((version) => version + 1); }}>다시 시도</Button></div>}
            {!backups && !error ? (
              <Skeleton className="settings-view__skeleton" label="백업 목록을 불러오는 중" />
            ) : backups?.length === 0 ? (
              <p>사용할 수 있는 백업이 없습니다.</p>
            ) : backups ? (
              <ul className="settings-view__safety-list">
                {backups.map((backup) => (
                  <li key={backup.id} className="settings-view__safety-item">
                    <div>
                      <strong>{localDate(backup.createdAt)}</strong>
                      <span>{kindLabel(backup.kind)}</span>
                      <span>{backup.byteSize.toLocaleString("ko-KR")} B</span>
                    </div>
                    <Button disabled={pending} onClick={() => setConfirmingId(backup.id)}>이 시점으로 복구</Button>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </div>
    )}
    {section === "shortcuts" && (
      <div className="settings-view__section settings-view__shortcuts">
        <header className="settings-view__header"><h2>단축키</h2><p>키보드 조작과 주요 화면 버튼을 확인합니다.</p></header>
        <h3>단축키</h3>
        <table className="settings-view__table">
          <thead><tr><th scope="col">단축키</th><th scope="col">동작</th></tr></thead>
          <tbody>
            {SHORTCUTS.map((shortcut) => <tr key={shortcut.keys}><td><kbd>{shortcut.keys}</kbd></td><td>{shortcut.action}</td></tr>)}
          </tbody>
        </table>
        <h3>버튼 설명</h3>
        <table className="settings-view__table">
          <thead><tr><th scope="col">버튼</th><th scope="col">용도</th></tr></thead>
          <tbody>
            {BUTTONS.map((button) => <tr key={button.name}><td>{button.name}</td><td>{button.purpose}</td></tr>)}
          </tbody>
        </table>
      </div>
    )}
    </div>
    </div>
  </section>;
}

const SHORTCUTS = [
  { keys: "Ctrl+1", action: "저장소 빠른 보기" },
  { keys: "Ctrl+2", action: "미분류 빠른 보기" },
  { keys: "Ctrl+3", action: "최근 빠른 보기" },
  { keys: "Ctrl+4", action: "즐겨찾기 빠른 보기" },
  { keys: "Ctrl+N", action: "새 분류 항목 추가" },
  { keys: "Ctrl+A", action: "불러온 자산 모두 선택" },
  { keys: "Ctrl+클릭", action: "한 장씩 선택 추가/제거" },
  { keys: "Shift+클릭", action: "마지막 기준점부터 범위 선택" },
  { keys: "← →", action: "같은 행의 이전·다음 자산으로 이동" },
  { keys: "↑ ↓", action: "같은 열의 위·아래 행으로 이동" },
  { keys: "Enter", action: "감상 화면 열기" },
  { keys: "F", action: "감상 화면에서 즐겨찾기 토글" },
  { keys: "Delete", action: "선택/감상 자산을 휴지통으로 이동" },
  { keys: "Escape", action: "감상 화면·선택 닫기" },
];

const BUTTONS = [
  { name: "즐겨찾기", purpose: "해당 자산의 즐겨찾기를 켜거나 끕니다." },
  { name: "이전/다음 자산", purpose: "감상 화면에서 이전·다음 자산을 봅니다." },
  { name: "감상 화면 닫기", purpose: "감상 화면을 닫고 갤러리로 돌아갑니다." },
  { name: "휴지통으로 이동", purpose: "감상 중인 자산을 휴지통으로 보냅니다." },
  { name: "정보", purpose: "선택 자산의 원본 정보와 분류를 보여주는 정보창을 엽니다." },
  { name: "정렬", purpose: "불러온 자산의 정렬 기준을 바꿉니다." },
  { name: "미리보기 크기", purpose: "갤러리 행의 목표 높이를 조절합니다." },
  { name: "메타데이터 표시", purpose: "타일에 출처와 수집일을 표시합니다." },
  { name: "분류 추가", purpose: "새 분류 항목 추가 대화상자를 엽니다." },
  { name: "실행 취소", purpose: "마지막 휴지통 이동을 되돌립니다." },
];

function kindLabel(kind: MetadataBackup["kind"]): string {
  switch (kind) {
    case "daily": return "자동 백업";
    case "pre_migration": return "업데이트 전";
    case "pre_restore": return "복구 직전";
  }
}

function localDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("ko-KR");
}
