import { useCallback, useEffect, useState } from "react";
import { AssetBrowser, type AssetBrowserStatus } from "../assets/AssetBrowser";
import { ClassificationSidebar } from "../classification/ClassificationSidebar";
import {
  type DropSubscriber,
  type FileDropResult,
  subscribeToTauriDrops,
  useFileDrop,
} from "../ingestion/useFileDrop";
import { AppShell } from "../layout/AppShell";
import { StatusBar } from "../layout/StatusBar";
import { libraryGateway } from "../library/client";
import { commandErrorMessage } from "../library/errorMessage";
import { LibraryProvider, useLibrary } from "../library/LibraryContext";
import {
  LibrarySetup,
  selectLibraryFolder,
  type FolderPicker,
} from "../library/LibrarySetup";
import type { AssetSort, AssetView, ClassificationEntry, LibraryGateway } from "../library/types";
import {
  loadUiPreferences,
  saveUiPreferences,
  type UiPreferences,
} from "../preferences/uiPreferences";
import { Toast } from "../shared/ui/Toast";
import { SafetyDialog } from "../safety/SafetyDialog";
import { TrashBrowser } from "../safety/TrashBrowser";

type AppProps = {
  gateway?: LibraryGateway;
  selectFolder?: FolderPicker;
  subscribeDrops?: DropSubscriber;
};

export function App({
  gateway = libraryGateway,
  selectFolder = selectLibraryFolder,
  subscribeDrops = subscribeToTauriDrops,
}: AppProps) {
  return (
    <LibraryProvider gateway={gateway}>
      <LibraryScreen selectFolder={selectFolder} subscribeDrops={subscribeDrops} />
    </LibraryProvider>
  );
}

function LibraryScreen({
  selectFolder,
  subscribeDrops,
}: {
  selectFolder: FolderPicker;
  subscribeDrops: DropSubscriber;
}) {
  const { library } = useLibrary();

  return library
    ? <LibraryWorkspace subscribeDrops={subscribeDrops} />
    : <LibrarySetup selectFolder={selectFolder} />;
}

function LibraryWorkspace({ subscribeDrops }: { subscribeDrops: DropSubscriber }) {
  const { gateway } = useLibrary();
  const [entries, setEntries] = useState<ClassificationEntry[]>([]);
  const [view, setView] = useState<AssetView>({
    kind: "classification",
    classificationId: null,
  });
  const [preferences, setPreferences] = useState<UiPreferences>(loadUiPreferences);
  const [message, setMessage] = useState<string | null>(null);
  const [assetRefresh, setAssetRefresh] = useState(0);
  const [safetyOpen, setSafetyOpen] = useState(false);
  const [maintenance, setMaintenance] = useState<"restore" | null>(null);
  const [browserStatus, setBrowserStatus] = useState<AssetBrowserStatus>({
    loadedCount: 0,
    selectedAsset: null,
    loading: true,
  });
  const appendMessage = useCallback((next: string) => {
    setMessage((current) => current ? `${current} ${next}` : next);
  }, []);
  const refreshClassifications = useCallback(async () => {
    setEntries(await gateway.listClassifications());
  }, [gateway]);
  const handleDropResult = useCallback((result: FileDropResult) => {
    setMessage(result.message);
    if (result.status === "added") setAssetRefresh((current) => current + 1);
  }, []);
  const dropEnabled = maintenance === null && view.kind === "classification" && view.classificationId !== null;
  const progress = useFileDrop({
    subscribe: subscribeDrops,
    enabled: dropEnabled,
    classificationId: view.kind === "classification" ? view.classificationId : null,
    ingestImage: gateway.ingestImage,
    onResult: handleDropResult,
  });

  useEffect(() => {
    void refreshClassifications();
  }, [refreshClassifications]);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        await gateway.ensureDailyBackup();
      } catch (error) {
        if (active) appendMessage(commandErrorMessage(error, "관리 정보 자동 백업에 실패했습니다."));
      }
      try {
        const result = await gateway.purgeExpiredTrash();
        if (active && result.failedAssetIds.length > 0) {
          appendMessage(`자동 삭제하지 못한 자산이 ${result.failedAssetIds.length}개 있습니다.`);
        }
      } catch (error) {
        if (active) appendMessage(commandErrorMessage(error, "휴지통 자동 정리를 실행하지 못했습니다."));
      }
    })();
    return () => { active = false; };
  }, [appendMessage, gateway]);
  useEffect(() => {
    saveUiPreferences(preferences);
  }, [preferences]);
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(null), 5_000);
    return () => window.clearTimeout(timer);
  }, [message]);

  function updatePreferences(update: Partial<UiPreferences>) {
    setPreferences((current) => ({ ...current, ...update }));
  }

  async function restoreBackup(backupId: string) {
    if (maintenance) return;
    setMaintenance("restore");
    try {
      await gateway.restoreMetadataBackup(backupId);
      await refreshClassifications();
      setAssetRefresh((current) => current + 1);
      setSafetyOpen(false);
      setMessage("복구가 완료되었습니다. 다음 단계에서 파일 검사를 실행할 수 있습니다.");
    } finally {
      setMaintenance(null);
    }
  }

  return (
    <>
      <div className="library-workspace" inert={maintenance !== null ? true : undefined}>
        <AppShell
          sidebar={
            <ClassificationSidebar
              entries={entries}
              view={view}
              expandedIds={preferences.expandedClassificationIds}
              sidebarWidth={preferences.sidebarWidth}
              onViewChange={setView}
              onExpandedIdsChange={(expandedClassificationIds) =>
                updatePreferences({ expandedClassificationIds })
              }
              onSidebarWidthChange={(sidebarWidth) => updatePreferences({ sidebarWidth })}
              onChanged={() => void refreshClassifications()}
              onOpenSafety={() => setSafetyOpen(true)}
            />
          }
          content={
            <div className="library-content">
              <section className="library-content__browser" aria-label="자산 내용">
                {view.kind === "trash" ? <TrashBrowser /> : (
                  <AssetBrowser
                    view={view}
                    classifications={entries}
                    sort={preferences.assetSort}
                    metadataVisible={preferences.metadataVisible}
                    refreshVersion={assetRefresh}
                    onSortChange={(assetSort: AssetSort) => updatePreferences({ assetSort })}
                    onMetadataVisibleChange={(metadataVisible) => updatePreferences({ metadataVisible })}
                    onStatusChange={setBrowserStatus}
                  />
                )}
                {message && <Toast>{message}</Toast>}
              </section>
            </div>
          }
          status={<StatusBar status={browserStatus} progress={progress} dropEnabled={dropEnabled} />}
        />
      </div>
      <SafetyDialog
        open={safetyOpen}
        restoring={maintenance === "restore"}
        onClose={() => setSafetyOpen(false)}
        onRestore={restoreBackup}
      />
    </>
  );
}
