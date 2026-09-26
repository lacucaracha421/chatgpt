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
  const [broad, setBroad] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    setError(null);
    void invoke<{ automationEnabled: boolean; broadFolderEnabled?: boolean }>("character_incremental_status")
      .then(status => {
        if (typeof status?.automationEnabled !== "boolean") throw new Error("자동 분류 설정을 확인하지 못했습니다.");
        if (active) {
          setEnabled(status.automationEnabled);
          setBroad(typeof status.broadFolderEnabled === "boolean" ? status.broadFolderEnabled : null);
        }
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

  return <><dl className="settings-view__property" aria-busy={busy}>
    <dt>캐릭터 자동 분류</dt>
    <dd className="settings-view__credential-status">이 라이브러리의 새 이미지와 대기 중인 이미지를 자동 분류합니다. 전체 과거 이미지 재분석을 새로 시작하지는 않습니다. 끄면 진행 중인 이미지를 마친 뒤 대기합니다.</dd>
    <dd className="settings-view__inline-controls"><Toggle aria-label="캐릭터 자동 분류" checked={enabled ?? false} disabled={disabled || busy || enabled === null} onChange={event => void change(event.target.checked)}>
      {busy ? "저장 중…" : enabled === null ? "확인 중…" : enabled ? "켜짐" : "꺼짐"}
    </Toggle></dd>
    {error && <dd className="settings-view__row-message" role="alert">{error}{enabled === null && <Button size="sm" disabled={disabled} onClick={() => setRetry(value => value + 1)}>다시 확인</Button>}</dd>}
  </dl>
  <dl className="settings-view__property" aria-busy={busy}>
    <dt>넓은 폴더 캐릭터 인식</dt>
    <dd className="settings-view__credential-status">시리즈가 아닌 상위 폴더(예: 게임)에 바로 저장한 이미지를 그 아래 등록된 모든 시리즈의 캐릭터와 비교합니다. 끄면 이런 이미지는 캐릭터 분류를 하지 않고, 이미 찾은 후보도 검토 목록에서 숨깁니다. 다시 켜면 숨긴 후보가 돌아옵니다.</dd>
    <dd className="settings-view__inline-controls"><Toggle aria-label="넓은 폴더 캐릭터 인식" checked={broad ?? false} disabled={disabled || busy || broad === null} onChange={event => void changeBroad(event.target.checked)}>
      {busy ? "저장 중…" : broad === null ? "확인 중…" : broad ? "켜짐" : "꺼짐"}
    </Toggle></dd>
  </dl></>;
}
