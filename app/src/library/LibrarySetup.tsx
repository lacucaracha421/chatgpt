import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "../shared/ui/Button";
import { useLibrary } from "./LibraryContext";

export type FolderPicker = () => Promise<string | string[] | null>;

export const selectLibraryFolder: FolderPicker = () =>
  open({ directory: true, multiple: false });

export function LibrarySetup({ selectFolder = selectLibraryFolder }: { selectFolder?: FolderPicker }) {
  const { error, openLibrary } = useLibrary();

  async function select() {
    const path = await selectFolder();
    if (typeof path === "string") {
      await openLibrary(path);
    }
  }

  return (
    <main className="setup-screen">
      <h1>Lakomics</h1>
      <p>개인 미디어 라이브러리를 선택해주세요.</p>
      {error && <p role="alert">{error}</p>}
      <Button type="button" onClick={() => void select()}>
        라이브러리 선택
      </Button>
    </main>
  );
}
