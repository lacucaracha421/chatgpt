import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { commandErrorMessage } from "../library/errorMessage";
import { Button } from "../shared/ui/Button";
import { Toggle } from "../shared/ui/Toggle";

/** Remounted by library identity; never changes the separate historical-refresh flag. */
export function CharacterAutomationSettings({ disabled, onBusyChange }: {
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    setError(null);
    void invoke<{ automationEnabled: boolean }>("character_incremental_status")
      .then(status => {
        if (typeof status?.automationEnabled !== "boolean") throw new Error("자동 분류 설정을 확인하지 못했습니다.");
        if (active) setEnabled(status.automationEnabled);
      })
      .catch(reason => { if (active) setError(commandErrorMessage(reason, "자동 분류 설정을 확인하지 못했습니다.")); });
    return () => { active = false; };
  }, [retry]);

  async function change(next: boolean) {
    if (disabled || busy || enabled === null) return;
    setBusy(true);
    onBusyChange(true);
    setError(null);
    try {
      await invoke("pause_character_automation", { paused: !next });
      setEnabled(next);
    } catch (reason) {
      setError(commandErrorMessage(reason, "자동 분류 설정을 저장하지 못했습니다."));
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }

  return <dl className="settings-view__property" aria-busy={busy}>
    <dt>캐릭터 자동 분류</dt>
    <dd className="settings-view__credential-status">이 라이브러리의 새 이미지와 대기 중인 이미지를 자동 분류합니다. 전체 과거 이미지 재분석을 새로 시작하지는 않습니다. 끄면 진행 중인 이미지를 마친 뒤 대기합니다.</dd>
    <dd className="settings-view__inline-controls"><Toggle aria-label="캐릭터 자동 분류" checked={enabled ?? false} disabled={disabled || busy || enabled === null} onChange={event => void change(event.target.checked)}>
      {busy ? "저장 중…" : enabled === null ? "확인 중…" : enabled ? "켜짐" : "꺼짐"}
    </Toggle></dd>
    {error && <dd className="settings-view__row-message" role="alert">{error}{enabled === null && <Button size="sm" disabled={disabled} onClick={() => setRetry(value => value + 1)}>다시 확인</Button>}</dd>}
  </dl>;
}
