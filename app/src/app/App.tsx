import { libraryGateway } from "../library/client";
import { LibraryProvider, useLibrary } from "../library/LibraryContext";
import {
  LibrarySetup,
  selectLibraryFolder,
  type FolderPicker,
} from "../library/LibrarySetup";
import type { LibraryGateway } from "../library/types";

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
  const { library } = useLibrary();
  if (!library) {
    return <LibrarySetup selectFolder={selectFolder} />;
  }
  return (
    <main>
      <h1>Lakomics</h1>
      <p>{library.root}</p>
    </main>
  );
}
