import { libraryGateway } from "../library/client";
import { LibraryProvider, useLibrary } from "../library/LibraryContext";
import {
  LibrarySetup,
  selectLibraryFolder,
  type FolderPicker,
} from "../library/LibrarySetup";
import { useCallback, useEffect, useState } from "react";
import { ClassificationSidebar } from "../classification/ClassificationSidebar";
import type { ClassificationEntry, LibraryGateway } from "../library/types";
import { AssetBrowser } from "../assets/AssetGallery";
import {
  type DropSubscriber,
  type FileDropResult,
  subscribeToTauriDrops,
  useFileDrop,
} from "../ingestion/useFileDrop";
import { Toast } from "../shared/ui/Toast";

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
      <LibraryScreen
        selectFolder={selectFolder}
        subscribeDrops={subscribeDrops}
      />
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

  if (!library) {
    return <LibrarySetup selectFolder={selectFolder} />;
  }
  return <LibraryWorkspace subscribeDrops={subscribeDrops} />;
}

function LibraryWorkspace({
  subscribeDrops,
}: {
  subscribeDrops: DropSubscriber;
}) {
  const { gateway, library } = useLibrary();
  const [entries, setEntries] = useState<ClassificationEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [assetRefresh, setAssetRefresh] = useState(0);
  const refreshClassifications = useCallback(async () => {
    setEntries(await gateway.listClassifications());
  }, [gateway]);
  const handleDropResult = useCallback((result: FileDropResult) => {
    setMessage(result.message);
    if (result.status === "added") {
      setAssetRefresh((current) => current + 1);
    }
  }, []);
  const progress = useFileDrop({
    subscribe: subscribeDrops,
    classificationId: selectedId,
    ingestImage: gateway.ingestImage,
    onResult: handleDropResult,
  });

  useEffect(() => {
    void refreshClassifications();
  }, [refreshClassifications]);

  return (
    <main>
      <h1>Lakomics</h1>
      <p>{library?.root}</p>
      <section aria-label="파일 끌어놓기">
        <p>
          {progress
            ? `${progress.total}개 중 ${progress.current}번째 파일을 처리하고 있습니다.`
            : "이미지 파일을 창으로 끌어놓으세요."}
        </p>
        {message && <Toast>{message}</Toast>}
      </section>
      <div className="app-shell">
        <ClassificationSidebar
          entries={entries}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onChanged={() => void refreshClassifications()}
        />
        <AssetBrowser
          classificationId={selectedId}
          classifications={entries}
          refreshVersion={assetRefresh}
        />
      </div>
    </main>
  );
}
