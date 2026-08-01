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
  const [browserStatus, setBrowserStatus] = useState<AssetBrowserStatus>({
    loadedCount: 0,
    selectedAsset: null,
    loading: true,
  });
  const refreshClassifications = useCallback(async () => {
    setEntries(await gateway.listClassifications());
  }, [gateway]);
  const handleDropResult = useCallback((result: FileDropResult) => {
    setMessage(result.message);
    if (result.status === "added") setAssetRefresh((current) => current + 1);
  }, []);
  const dropEnabled = view.kind === "classification" && view.classificationId !== null;
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

  return (
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
        />
      }
      content={<>
        {view.kind === "trash" ? <TrashBrowser /> : <AssetBrowser
          view={view}
          classifications={entries}
          sort={preferences.assetSort}
          metadataVisible={preferences.metadataVisible}
          refreshVersion={assetRefresh}
          onSortChange={(assetSort: AssetSort) => updatePreferences({ assetSort })}
          onMetadataVisibleChange={(metadataVisible) => updatePreferences({ metadataVisible })}
          onStatusChange={setBrowserStatus}
        />}
        {message && <Toast>{message}</Toast>}
      </>}
      status={<StatusBar status={browserStatus} progress={progress} dropEnabled={dropEnabled} />}
    />
  );
}
