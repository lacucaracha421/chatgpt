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

type AppProps = {
  gateway?: LibraryGateway;
  selectFolder?: FolderPicker;
};

export function App({
  gateway = libraryGateway,
  selectFolder = selectLibraryFolder,
}: AppProps) {
  return (
    <LibraryProvider gateway={gateway}>
      <LibraryScreen selectFolder={selectFolder} />
    </LibraryProvider>
  );
}

function LibraryScreen({ selectFolder }: { selectFolder: FolderPicker }) {
  const { gateway, library } = useLibrary();
  const [entries, setEntries] = useState<ClassificationEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const refreshClassifications = useCallback(async () => {
    setEntries(await gateway.listClassifications());
  }, [gateway]);

  useEffect(() => {
    if (!library) {
      setEntries([]);
      setSelectedId(null);
      return;
    }
    void refreshClassifications();
  }, [library, refreshClassifications]);

  if (!library) {
    return <LibrarySetup selectFolder={selectFolder} />;
  }
  return (
    <main>
      <h1>Lakomics</h1>
      <p>{library.root}</p>
      <ClassificationSidebar
        entries={entries}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onChanged={() => void refreshClassifications()}
      />
    </main>
  );
}
