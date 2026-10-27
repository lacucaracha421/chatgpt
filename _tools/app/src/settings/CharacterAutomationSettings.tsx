import { BusyLabel } from "../shared/ui/BusyLabel";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { commandErrorMessage } from "../library/errorMessage";
import { Switch } from "../shared/ui/Switch";
import { Button } from "../shared/ui/Button";

/** Remounted by library identity; never changes the separate historical-refresh flag. */
export function CharacterAutomationSettings({ disabled, onBusyChange }: {
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const [broad, setBroad] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    setError(null);
    void invoke<{ automationEnabled: boolean; broadFolderEnabled?: boolean }>("character_incremental_status")
      .then(status => {
        if (typeof status?.broadFolderEnabled !== "boolean") throw new Error("넓은 폴더 인식 설정을 확인하지 못했습니다.");
        if (active) {
          setBroad(typeof status.broadFolderEnabled === "boolean" ? status.broadFolderEnabled : null);
        }
      })
      .catch(reason => { if (active) setError(commandErrorMessage(reason, "자동 분류 설정을 확인하지 못했습니다.")); });
    return () => { active = false; };
  }, [retry]);

  async function changeBroad(next: boolean) {
    if (disabled || busy || broad === null) return;
    setBusy(true);
    onBusyChange(true);
    setError(null);
    try {
      await invoke("set_character_broad_folder_scope", { enabled: next });
      setBroad(next);
    } catch (reason) {
      setError(commandErrorMessage(reason, "넓은 폴더 인식 설정을 저장하지 못했습니다."));
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }

  return <dl className="settings-view__property" aria-busy={busy}>
    <dt>넓은 폴더 인식</dt>
    <dd className="settings-view__status"><BusyLabel busy={busy || broad === null} idle={broad === null ? null : broad ? "켜짐" : "꺼짐"}>{busy ? "저장 중…" : "확인 중…"}</BusyLabel></dd>
    <dd className="settings-view__inline-controls"><Switch aria-label="넓은 폴더 인식" checked={broad ?? false} disabled={disabled || busy || broad === null} onChange={event => void changeBroad(event.target.checked)} /></dd>
    {error && <dd className="settings-view__row-message" role="alert">{error}{broad === null && <Button size="sm" disabled={disabled} onClick={() => setRetry(value => value + 1)}>다시 시도</Button>}</dd>}
  </dl>;
}
