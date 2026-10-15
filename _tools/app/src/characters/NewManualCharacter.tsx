import { useEffect, useRef, useState } from "react";
import type { ClassificationEntry } from "../library/types";
import { commandErrorMessage } from "../library/errorMessage";
import { Dialog } from "../shared/ui/Dialog";
import { Button } from "../shared/ui/Button";
import { BusyLabel } from "../shared/ui/BusyLabel";
import { SeriesPicker } from "./SeriesPicker";
import { registrationPreview } from "./RegistrationScope";
import { characterHubApi } from "./hubApi";
import type { CharacterTarget } from "./api";

export function NewManualCharacter({ name, series, entries, assetIds, onClose, onSaved }: {
  name: string; series: ClassificationEntry; entries: ClassificationEntry[]; assetIds: string[];
  onClose(): void; onSaved(target: CharacterTarget): void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const started = useRef(false), saving = useRef(false);
  async function register(chosen: ClassificationEntry) {
    await registrationPreview({ seriesId: chosen.id, mode: "manual" });
    if (!(await characterHubApi.series()).some(series => series.classificationId === chosen.id)) await characterHubApi.saveSeries({ classificationId: chosen.id, heroAssetId: null, autoClassify: true });
    onSaved(await characterHubApi.createManualCharacter({ seriesId: chosen.id, displayName: name, assetIds }));
  }
  async function save() {
    if (saving.current) return;
    // Keep a failed attempt's dialog painted while its retry is pending.
    saving.current = true; setBusy(true);
    try { await register(series); }
    catch (reason) { setError(commandErrorMessage(reason, "캐릭터를 만들지 못했습니다.")); }
    finally { saving.current = false; setBusy(false); }
  }
  useEffect(() => {
    if (!series.isContainer && !started.current) { started.current = true; void save(); }
  }, [series.id]);
  // Manual creation has no historical recheck. The series choice continues
  // directly, just like 새 캐릭터 inside an existing series.
  if (series.isContainer) return <SeriesPicker parent={series} entries={entries} onClose={onClose} onSelected={register} />;
  if (!error) return <BusyLabel busy={busy}>캐릭터 만드는 중…</BusyLabel>;
  return <Dialog open title={`${name} · 캐릭터 등록`} onClose={() => { if (!busy) onClose(); }}>
    <p role="alert">{error}</p>
    <div className="ui-dialog__actions"><Button variant="ghost" disabled={busy} onClick={onClose}>취소</Button><Button variant="primary" disabled={busy} onClick={() => void save()}>다시 시도</Button></div>
  </Dialog>;
}
