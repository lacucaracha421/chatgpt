import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ClassificationEntry } from "../library/types";
import { commandErrorMessage } from "../library/errorMessage";
import { Dialog } from "../shared/ui/Dialog";
import { Select } from "../shared/ui/Select";
import { Button } from "../shared/ui/Button";
import type { CharacterTarget } from "./api";
import { characterHubApi, type CharacterSeries } from "./hubApi";

type Preview = { targetId: string; destinationId: string; assetCount: number; relocationCount: number; sharedCount: number; sharedLocations?: { classificationId: string; assetCount: number; relocationCount: number }[]; groupName: string | null; token: string };

export function CharacterSeriesMove({ target, entries, onClose, onMoved }: {
  target: CharacterTarget; entries: ClassificationEntry[]; onClose: () => void; onMoved: (target: CharacterTarget) => void;
}) {
  const [series, setSeries] = useState<CharacterSeries[]>([]);
  const [loaded, setLoaded] = useState(false), [destination, setDestination] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const saving = useRef(false);
  useEffect(() => {
    let active = true;
    setLoaded(false); setError(null);
    void characterHubApi.series().then(items => {
      if (active) { setSeries(items); setLoaded(true); }
    }).catch(reason => { if (active) setError(commandErrorMessage(reason, "시리즈 목록을 불러오지 못했습니다.")); });
    return () => { active = false; };
  }, [revision]);
  useEffect(() => {
    let active = true;
    setPreview(null); setError(null);
    if (destination) void invoke<Preview>("character_series_move_preview", { targetId: target.id, destinationId: destination })
      .then(value => { if (active) setPreview(value); })
      .catch(reason => { if (active) setError(commandErrorMessage(reason, "이동 대상을 확인하지 못했습니다.")); });
    return () => { active = false; };
  }, [target.id, destination, revision]);
  function path(id: string) {
    const names: string[] = [], seen = new Set<string>();
    let entry = entries.find(item => item.id === id);
    while (entry && !seen.has(entry.id)) {
      seen.add(entry.id); names.unshift(entry.name);
      entry = entries.find(item => item.id === entry!.parentId);
    }
    return names.join(" / ");
  }
  const choices = series.filter(item => item.classificationId !== target.seriesClassificationId && entries.some(entry => entry.id === item.classificationId));
  const sharedLocations = preview?.sharedLocations ?? [];
  const destinationCount = preview ? preview.relocationCount - sharedLocations.reduce((total, item) => total + item.relocationCount, 0) : 0;
  async function move() {
    if (!preview || preview.destinationId !== destination || saving.current) return;
    saving.current = true; setBusy(true); setError(null);
    try {
      const moved = await invoke<CharacterTarget>("move_character_to_series", { targetId: target.id, destinationId: destination, token: preview.token });
      onMoved(moved);
    } catch (reason) {
      setPreview(null); setError(commandErrorMessage(reason, "이동하지 못했습니다. 이동 내용을 다시 확인해 주세요."));
    } finally { saving.current = false; setBusy(false); }
  }
  return <Dialog open title={`${target.displayName} · 다른 시리즈로 이동`} onClose={() => { if (!saving.current) onClose(); }}>
    <div className="classification-sidebar__form">
      <Select label="대상 시리즈" value={destination} disabled={!loaded || busy} onChange={event => { setPreview(null); setDestination(event.target.value); }}>
        <option value="">시리즈 선택</option>
        {choices.map(item => <option key={item.classificationId} value={item.classificationId}>{path(item.classificationId)}</option>)}
      </Select>
      {loaded && !choices.length && <p>다른 폴더를 시리즈로 등록한 뒤 이동할 수 있습니다.</p>}
      {destination && !preview && !error && <p role="status">이동할 자료를 확인하고 있습니다.</p>}
      {preview && <>
        <p>연결된 이미지·영상 {preview.assetCount.toLocaleString()}개 중 {destinationCount.toLocaleString()}개를 선택한 시리즈로 이동합니다. 이미 대상 시리즈 아래에 있는 자료의 폴더는 유지합니다.</p>
        {sharedLocations.length > 0 && <div><p>공유 자료는 각 캐릭터 화면에서 계속 볼 수 있도록 공통 상위 폴더에 보관합니다.</p><ul>{sharedLocations.map(location => <li key={location.classificationId}>{path(location.classificationId)} · {location.assetCount.toLocaleString()}개{location.relocationCount === 0 ? " · 현재 위치 유지" : ` · ${location.relocationCount.toLocaleString()}개 이동`}</li>)}</ul></div>}
        <p>레퍼런스, 대표 이미지, 수동 지정·제외 이력과 원본 파일을 유지합니다.{preview.sharedCount > 0 && ` 다른 캐릭터와 공유하는 ${preview.sharedCount.toLocaleString()}개의 연결도 유지합니다.`}</p>
        {preview.groupName && <p>기존 ‘{preview.groupName}’ 그룹에서는 빠집니다. 다른 캐릭터는 유지되며, 남은 캐릭터가 없으면 그룹도 자동으로 해제됩니다.</p>}
      </>}
      <p>이동으로 미분류 분석을 시작하지 않습니다. 이 캐릭터의 진행 중인 과거 갱신은 종료되며, 새 시리즈의 자동 분류 설정은 그대로 유지됩니다.</p>
      {error && <p role="alert">{error}</p>}
      {error && <Button variant="ghost" disabled={busy} onClick={() => setRevision(value => value + 1)}>다시 확인</Button>}
      <div className="ui-dialog__actions"><Button variant="ghost" disabled={busy} onClick={onClose}>취소</Button><Button disabled={busy || !preview || preview.destinationId !== destination} onClick={() => void move()}>이동</Button></div>
    </div>
  </Dialog>;
}
