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
    if (typeof path === "string") await openLibrary(path);
  }

  return <main className="setup-screen">
    <section className="setup-screen__panel" aria-labelledby="setup-title">
      <h1 id="setup-title">Lakomics</h1>
      <p>개인 미디어 라이브러리를 선택해 주세요.</p>
      {error && <p className="setup-screen__error" role="alert">{error}</p>}
      <Button type="button" onClick={() => void select()}>라이브러리 선택</Button>
    </section>
  </main>;
}
