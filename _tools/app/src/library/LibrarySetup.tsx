import { useDelayedBusy } from "../shared/useDelayedBusy";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "../shared/ui/Button";
import { useLibrary } from "./LibraryContext";
import { useLaunchReady } from "../shared/launch/LaunchSplash";

export type FolderPicker = () => Promise<string | string[] | null>;

export const selectLibraryFolder: FolderPicker = () =>
  open({ directory: true, multiple: false });

export function LibrarySetup({ selectFolder = selectLibraryFolder }: { selectFolder?: FolderPicker }) {
  const { error, initializing, openLibrary } = useLibrary();

  const showOpening = useDelayedBusy(initializing);
  // Without a library to open, this is the first screen: end the launch splash.
  useLaunchReady(!initializing);

  async function select() {
    const path = await selectFolder();
    if (typeof path === "string") await openLibrary(path);
  }

  return <main className="setup-screen">
    <section className="setup-screen__panel" aria-labelledby="setup-title">
      <h1 id="setup-title">Lakomics</h1>
      {initializing || showOpening ? showOpening && <p role="status">저장소 여는 중…</p> : <>
        <p>개인 미디어 라이브러리를 선택해 주세요.</p>
        {error && <p className="setup-screen__error" role="alert">{error}</p>}
        <Button type="button" onClick={() => void select()}>라이브러리 선택</Button>
      </>}
    </section>
  </main>;
}
