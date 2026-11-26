import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ClassificationEntry } from "../library/types";
import { commandErrorMessage } from "../library/errorMessage";
import { Dialog } from "../shared/ui/Dialog";
import { Button } from "../shared/ui/Button";
import { BusyLabel } from "../shared/ui/BusyLabel";
import { characterApi, type CharacterTarget } from "./api";
import { SeriesPicker } from "./SeriesPicker";
import "./RegistrationScope.css";

/** Both folder menus share the same action; only occupied series need a dialog. */
export function useContainerFolder(entries: ClassificationEntry[], onChanged: () => void) {
  const [dialog, setDialog] = useState<{ folder: ClassificationEntry; targets: CharacterTarget[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  async function toggle(folder: ClassificationEntry) {
    if (pending.current) return;
    pending.current = true; setError(null);
    try {
      const targets = folder.isContainer ? [] : (await characterApi.targets()).filter(target => target.role !== "extras" && target.seriesClassificationId === folder.id);
      if (targets.length) setDialog({ folder, targets });
      else { await invoke("set_character_container", { folderId: folder.id, enabled: !folder.isContainer }); onChanged(); }
    } catch (reason) { setError(commandErrorMessage(reason, "분류함 설정을 바꾸지 못했습니다.")); }
    finally { pending.current = false; }
  }
  return { toggle, surface: <>
    {error && <p role="alert">{error}</p>}
    {dialog && <ContainerFolderDialog {...dialog} entries={entries} onClose={() => { setDialog(null); onChanged(); }} onSaved={() => { setDialog(null); onChanged(); }} />}
  </> };
}

type ReferenceLoss = { targetId: string; name: string; ineligibleCount: number; losesReady: boolean };
type Conversion = { movedCount: number; sharedCount: number; keptInFolderCount: number; referenceLosses?: ReferenceLoss[] };

export function ContainerFolderDialog({ folder, targets, entries, onClose, onSaved }: {
  folder: ClassificationEntry; targets: CharacterTarget[]; entries: ClassificationEntry[]; onClose(): void; onSaved(): void;
}) {
  const [destinations, setDestinations] = useState<Record<string, ClassificationEntry>>({});
  const [picking, setPicking] = useState<string | null>(null);
  const [summary, setSummary] = useState<Conversion | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  const ready = targets.every(target => destinations[target.id]);
  const moves = targets.map(target => ({ targetId: target.id, destinationId: destinations[target.id]?.id ?? "" }));
  const movesKey = ready ? JSON.stringify(moves) : "";
  const knownEntries = [...new Map([...entries, ...Object.values(destinations)].map(entry => [entry.id, entry])).values()];
  const last = folder.name.charCodeAt(folder.name.length - 1);
  const particle = last >= 0xac00 && last <= 0xd7a3 && (last - 0xac00) % 28 ? "을" : "를";
  // A dry run of the whole conversion: it explains what happens to shared images, or why it cannot be done.
  useEffect(() => {
    setSummary(null); setPreviewError(null);
    if (!movesKey) return;
    let current = true;
    invoke<Conversion | undefined>("container_conversion_preview", { folderId: folder.id, moves: JSON.parse(movesKey) })
      .then(result => { if (current) setSummary(result ?? null); })
      .catch(reason => { if (current) setPreviewError(commandErrorMessage(reason, "분류함으로 바꿀 수 있는지 확인하지 못했습니다.")); });
    return () => { current = false; };
  }, [folder.id, movesKey]);
  async function apply() {
    if (saving.current || !ready) return;
    saving.current = true; setBusy(true); setError(null);
    try {
      await invoke("convert_to_container", { folderId: folder.id, moves });
      onSaved();
    } catch (reason) { setError(commandErrorMessage(reason, "분류함으로 바꾸지 못했습니다. 아무것도 바뀌지 않았습니다.")); }
    finally { saving.current = false; setBusy(false); }
  }
  return <><Dialog open title={`${folder.name}${particle} 분류함으로`} onClose={() => { if (!busy) onClose(); }}>
    <div className="classification-sidebar__form">
      <p>분류함에는 캐릭터 보관 불가 · {folder.name}의 캐릭터별 이동 시리즈 선택</p>
      {targets.map(target => <div className="character-assign-picker__row" key={target.id}>
        <span className="character-assign-picker__thumbnail" aria-hidden="true" />
        <span className="character-assign-picker__name">{target.displayName}</span>
        <Button disabled={busy} onClick={() => setPicking(target.id)}>{destinations[target.id]?.name ?? "시리즈 고르기"}</Button>
      </div>)}
      <p>다시 확인 0장 · 시리즈 등록만 해제</p>
      <p>대표 이미지·지정 이력·원본 파일 유지</p>
      {summary && (summary.sharedCount > 0
        ? <p>공유 이미지 {summary.sharedCount.toLocaleString()}장 연결 유지{summary.keptInFolderCount > 0 ? ` · ${summary.keptInFolderCount.toLocaleString()}장은 ${folder.name}에 유지` : " · 현재 위치 유지"}</p>
        : <p>공유 이미지 없음</p>)}
      {summary && !summary.referenceLosses?.length && <p>레퍼런스 전부 유지</p>}
      {!!summary?.referenceLosses?.length && <div className="registration-scope__notice registration-scope__notice--warning" role="status">
        <b>일부 캐릭터의 레퍼런스가 시리즈 밖에 남음</b>
        {summary.referenceLosses.map(loss => <p key={loss.targetId}>{loss.name}: 시리즈 밖 레퍼런스 {loss.ineligibleCount.toLocaleString()}장 ({loss.losesReady ? "자동 인식 중단" : "미사용"}) · 같은 시리즈로 이동하거나 레퍼런스 재선택 필요</p>)}
        <p>레퍼런스 공유 캐릭터는 같은 하위 시리즈로 이동 권장</p>
      </div>}
      {previewError && <p role="alert">{previewError}</p>}
      {error && <p role="alert">{error}</p>}
      <div className="ui-dialog__actions"><Button variant="ghost" disabled={busy} onClick={onClose}>취소</Button><Button variant="primary" disabled={busy || !ready || !!previewError} onClick={() => void apply()}><BusyLabel busy={busy} idle="분류함으로 바꾸기">바꾸는 중…</BusyLabel></Button></div>
    </div>
  </Dialog>
    {picking && <SeriesPicker parent={folder} entries={knownEntries} onClose={() => setPicking(null)} onSelected={entry => { setDestinations(current => ({ ...current, [picking]: entry })); setPicking(null); }} />}
  </>;
}
