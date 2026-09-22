import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { commandErrorMessage } from "../library/errorMessage";
import { Button } from "../shared/ui/Button";
import { Toggle } from "../shared/ui/Toggle";

export type AugmentationSettings = {
  enabled: boolean;
  modelName: string | null;
  modelReady: boolean;
  runtimeConfigured: boolean;
  managedByEnvironment: boolean;
};

function checked(value: AugmentationSettings): AugmentationSettings {
  if (!value || [value.enabled, value.modelReady, value.runtimeConfigured, value.managedByEnvironment].some(flag => typeof flag !== "boolean")
    || (value.modelName !== null && typeof value.modelName !== "string")) {
    throw new Error("캐릭터 누락 보완 설정을 확인하지 못했습니다.");
  }
  return value;
}

export function CharacterAugmentationSettings({ disabled, onBusyChange }: {
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const [settings, setSettings] = useState<AugmentationSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const saving = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void invoke<AugmentationSettings>("character_augmentation_settings").then(checked)
      .then(value => { if (active) setSettings(value); })
      .catch(reason => { if (active) setError(commandErrorMessage(reason, "누락 보완 설정을 확인하지 못했습니다.")); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [retry]);

  async function change(action: "toggle" | "runtime", enabled?: boolean) {
    if (disabled || saving.current || loading || !settings) return;
    saving.current = true;
    setBusy(true);
    onBusyChange(true);
    setError(null);
    try {
      let next: AugmentationSettings;
      if (action === "runtime") {
        const configured = await invoke<boolean>("setup_character_runtime");
        if (!configured) return;
        next = await invoke<AugmentationSettings>("character_augmentation_settings");

      } else {
        next = await invoke<AugmentationSettings>("set_character_augmentation_enabled", { enabled });
      }
      if (mounted.current) setSettings(checked(next));
    } catch (reason) {
      if (mounted.current) setError(commandErrorMessage(reason, "누락 보완 설정을 저장하지 못했습니다."));
    } finally {
      saving.current = false;
      if (mounted.current) setBusy(false);
      onBusyChange(false);
    }
  }

  const locked = disabled || busy || loading || !settings;
  const environment = settings?.managedByEnvironment ?? false;
  return <dl className="settings-view__property" aria-busy={busy || loading}>
    <dt>캐릭터 누락 보완</dt>
    <dd className="settings-view__credential-status">기존 자동 분류와 수동 판정은 유지하고, 경량 모델로 더 많은 누락을 보완합니다. 일부 오탐이 생길 수 있습니다. 이 PC의 설정이며, 캐릭터 자동 분류가 켜져 있을 때 동작합니다. 과거 이미지 재분석은 시작하지 않습니다.</dd>
    <dd className="settings-view__inline-controls">
      <Toggle aria-label="캐릭터 누락 보완" checked={settings?.enabled ?? false}
        disabled={locked || environment || (!settings?.enabled && (!settings?.modelReady || !settings?.runtimeConfigured))}
        onChange={event => void change("toggle", event.target.checked)}>
        {busy ? "적용 중…" : loading ? "확인 중…" : settings?.enabled ? "켜짐" : "꺼짐"}
      </Toggle>

      {settings && !settings.runtimeConfigured && <Button size="sm" disabled={locked} onClick={() => void change("runtime")}>분석 환경 설정</Button>}
    </dd>
    {settings && <dd className="settings-view__credential-status" role="status">
      {!settings.runtimeConfigured ? "분석 환경 설정이 먼저 필요합니다."
        : settings.modelReady ? (settings.enabled ? "기존 분석을 먼저 처리하고, 대기 작업이 없을 때 보완 모델을 준비합니다. 준비 전에는 기존 방식만 사용합니다." : "보완 모델이 준비되어 있습니다.")
          : "보완 모델 설치를 확인해 주세요. 사용할 수 없으면 기존 방식만 사용합니다."}
      {environment && " 환경 변수로 지정되어 있습니다. 앱에서 변경하려면 LAKOMICS_CHARACTER_AUGMENTATION_MODEL을 해제하고 다시 시작해 주세요."}
    </dd>}
    {error && <dd className="settings-view__row-message" role="alert">{error}<Button size="sm" disabled={disabled || busy || loading} onClick={() => setRetry(value => value + 1)}>보완 설정 다시 확인</Button></dd>}
  </dl>;
}
