import { invoke } from "@tauri-apps/api/core";
import { useEffect, useId, useState } from "react";
import { Select } from "../shared/ui/Select";
import { SettingsRow } from "../shared/ui/SettingsRow";

type Preference = "system" | "always";
type Status = { selected: Preference; active: Preference };

export function AnimationSettings() {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const helpId = useId();
  useEffect(() => {
    let live = true;
    void invoke<Status>("motion_preference").then(
      result => { if (live) setStatus(result); },
      () => { if (live) setError("애니메이션 설정을 불러오지 못했습니다."); },
    );
    return () => { live = false; };
  }, []);

  async function save(preference: Preference) {
    setBusy(true);
    setError(null);
    try { setStatus(await invoke<Status>("motion_preference", { preference })); }
    catch { setError("애니메이션 설정을 저장하지 못했습니다."); }
    finally { setBusy(false); }
  }

  return <>
    <SettingsRow name="애니메이션" control={<Select label="애니메이션" aria-describedby={helpId} value={status?.selected ?? "system"} disabled={!status || busy} onChange={event => void save(event.target.value as Preference)}>
      <option value="system">Windows 설정 따르기</option>
      <option value="always">항상 켜기</option>
    </Select>} />
    <p id={helpId} className="settings-view__status">Windows에서 애니메이션 효과를 꺼 두어도 Lakomics에서는 움직임을 보여 줍니다. 바꾸면 앱을 다시 시작해야 적용됩니다.</p>
    {status && status.selected !== status.active && <p className="settings-view__row-message" role="status">다시 시작하면 적용됩니다</p>}
    {error && <p className="settings-view__row-message" role="alert">{error}</p>}
  </>;
}
