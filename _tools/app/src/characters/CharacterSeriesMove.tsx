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
      {loaded && !choices.length && <p>이동 가능한 다른 시리즈 없음</p>}
      {destination && !preview && !error && <p role="status">이동 대상 확인 중…</p>}
      {preview && <>
        <p>연결 파일 {preview.assetCount.toLocaleString()}개 중 {destinationCount.toLocaleString()}개 이동 · 이미 대상 시리즈에 있는 파일 위치 유지</p>
        {sharedLocations.length > 0 && <div><p>공유 파일은 공통 상위 폴더에 보관</p><ul>{sharedLocations.map(location => <li key={location.classificationId}>{path(location.classificationId)} · {location.assetCount.toLocaleString()}개{location.relocationCount === 0 ? " · 현재 위치 유지" : ` · ${location.relocationCount.toLocaleString()}개 이동`}</li>)}</ul></div>}
        <p>레퍼런스·대표 이미지·지정 이력·원본 파일 유지{preview.sharedCount > 0 && ` · 공유 연결 ${preview.sharedCount.toLocaleString()}개 유지`}</p>
        {preview.groupName && <p>기존 ‘{preview.groupName}’ 그룹에서 제외 · 빈 그룹은 자동 해제</p>}
      </>}
      <p>이동 시 미분류 분석 미실행 · 진행 중인 과거 갱신 종료 · 새 시리즈 자동 분류 설정 유지</p>
      {error && <p role="alert">{error}</p>}
      {error && <Button variant="ghost" disabled={busy} onClick={() => setRevision(value => value + 1)}>다시 시도</Button>}
      <div className="ui-dialog__actions"><Button variant="ghost" disabled={busy} onClick={onClose}>취소</Button><Button disabled={busy || !preview || preview.destinationId !== destination} onClick={() => void move()}>이동</Button></div>
    </div>
  </Dialog>;
}
