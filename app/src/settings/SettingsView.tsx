import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import type { MetadataBackup } from "../library/types";
import { WindowControls } from "../layout/WindowControls";
import { Button } from "../shared/ui/Button";
import { Skeleton } from "../shared/ui/Skeleton";
import { Toast } from "../shared/ui/Toast";

type SettingsViewProps = {
  restoring: boolean;
  onRestore: (backupId: string) => Promise<void>;
  onExit: () => void;
};

export function SettingsView({ restoring, onRestore, onExit }: SettingsViewProps) {
  const { gateway, library } = useLibrary();
  const [section, setSection] = useState<"general" | "safety" | "shortcuts">("general");
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [backups, setBackups] = useState<MetadataBackup[] | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [mangaRoot, setMangaRoot] = useState<string | null>(null);
  const [mangaRootError, setMangaRootError] = useState<string | null>(null);
  const pending = restoring || submitting;

  useEffect(() => {
    let active = true;
    void gateway.getMangaRoot().then((root) => { if (active) setMangaRoot(root); });
    return () => { active = false; };
  }, [gateway]);

  useEffect(() => {
    void getVersion().then(setAppVersion).catch(() => setAppVersion(null));
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void gateway.listMetadataBackups().then((nextBackups) => {
        if (!controller.signal.aborted) setBackups(nextBackups);
      }).catch((loadError: unknown) => {
        if (!controller.signal.aborted) setError(commandErrorMessage(loadError, "백업 목록을 불러오지 못했습니다."));
      });
    }, section === "safety" ? 0 : 250);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [gateway, section]);

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

  return <section className="settings-view" aria-label="설정" onKeyDown={(event) => { if (event.key === "Escape" && !pending) onExit(); }}>
    <header className="settings-view__toolbar" data-tauri-drag-region>
      <div data-tauri-drag-region><h2>설정</h2><p>라이브러리 폴더, 안전 설정과 단축키를 확인합니다.</p></div>
      <WindowControls />
    </header>
    <nav className="settings-view__sections" aria-label="설정 구역">
      <Button variant={section === "general" ? "primary" : "ghost"} onClick={() => setSection("general")}>일반 설정</Button>
      <Button variant={section === "safety" ? "primary" : "ghost"} onClick={() => setSection("safety")}>안전</Button>
      <Button variant={section === "shortcuts" ? "primary" : "ghost"} onClick={() => setSection("shortcuts")}>단축키·버튼 설명</Button>
    </nav>
    {section === "general" && (
      <div className="settings-view__general">
        <dl className="settings-view__field">
          <dt>라이브러리 폴더</dt>
          <dd>{library?.root ?? "알 수 없음"}</dd>
        </dl>
        <dl className="settings-view__field">
          <dt>앱 버전</dt>
          <dd>{appVersion ?? "알 수 없음"}</dd>
        </dl>
        <dl className="settings-view__field">
          <dt>망가 폴더</dt>
          <dd>
            <span>{mangaRoot ?? "설정되지 않음"}</span>
            <Button size="sm" onClick={() => void chooseMangaFolder()}>변경</Button>
            {mangaRootError && <span role="alert">{mangaRootError}</span>}
          </dd>
        </dl>
      </div>
    )}
    {section === "safety" && (
      <div className="settings-view__safety">
        {confirmingId ? (
          <div className="settings-view__safety-confirm">
            <p>현재 상태를 별도로 보존한 뒤 선택한 시점으로 관리 정보를 복구합니다.</p>
            {error && <Toast>{error}</Toast>}
            <div className="ui-dialog__actions">
              <Button disabled={pending} onClick={() => setConfirmingId(null)}>취소</Button>
              <Button variant="primary" disabled={pending} onClick={() => void restore()}>
                {pending ? "복구 중…" : "복구 시작"}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <p>라이브러리 관리 정보의 자동 백업을 선택해 복구할 수 있습니다.</p>
            {error && <div className="settings-view__safety-error"><Toast>{error}</Toast><Button onClick={() => setBackups(null)}>다시 시도</Button></div>}
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
      <div className="settings-view__shortcuts">
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
