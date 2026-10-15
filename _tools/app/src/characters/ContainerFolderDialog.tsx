import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ClassificationEntry } from "../library/types";
import { commandErrorMessage } from "../library/errorMessage";
import { Dialog } from "../shared/ui/Dialog";
import { Button } from "../shared/ui/Button";
import { Badge } from "../shared/ui/Badge";
import { BusyLabel } from "../shared/ui/BusyLabel";
import { characterApi, type CharacterTarget } from "./api";
import { SeriesPicker } from "./SeriesPicker";

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

export function ContainerFolderDialog({ folder, targets, entries, onClose, onSaved }: {
  folder: ClassificationEntry; targets: CharacterTarget[]; entries: ClassificationEntry[]; onClose(): void; onSaved(): void;
}) {
  const [destinations, setDestinations] = useState<Record<string, ClassificationEntry>>({});
  const [moved, setMoved] = useState<string[]>([]);
  const [picking, setPicking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  const remaining = targets.filter(target => !moved.includes(target.id));
  const knownEntries = [...new Map([...entries, ...Object.values(destinations)].map(entry => [entry.id, entry])).values()];
  const last = folder.name.charCodeAt(folder.name.length - 1);
  const particle = last >= 0xac00 && last <= 0xd7a3 && (last - 0xac00) % 28 ? "을" : "를";
  async function apply() {
    if (saving.current || remaining.some(target => !destinations[target.id])) return;
    saving.current = true; setBusy(true); setError(null);
    try {
      for (const target of remaining) {
        const destinationId = destinations[target.id]!.id;
        const preview = await invoke<{ token: string }>("character_series_move_preview", { targetId: target.id, destinationId });
        await invoke("move_character_to_series", { targetId: target.id, destinationId, token: preview.token });
        setMoved(current => [...current, target.id]);
      }
      await invoke("set_character_container", { folderId: folder.id, enabled: true });
      onSaved();
    } catch (reason) { setError(commandErrorMessage(reason, "분류함으로 바꾸지 못했습니다. 옮긴 캐릭터는 그대로 유지됩니다.")); }
    finally { saving.current = false; setBusy(false); }
  }
  return <><Dialog open title={`${folder.name}${particle} 분류함으로`} onClose={() => { if (!busy) onClose(); }}>
    <div className="classification-sidebar__form">
      <p>분류함에는 캐릭터를 둘 수 없습니다. {folder.name}에 있는 캐릭터를 옮길 시리즈를 골라 주세요.</p>
      {targets.map(target => <div className="character-assign-picker__row" key={target.id}>
        <span className="character-assign-picker__thumbnail" aria-hidden="true" />
        <span className="character-assign-picker__name">{target.displayName}</span>
        {moved.includes(target.id) ? <Badge>이동됨</Badge> : <Button disabled={busy} onClick={() => setPicking(target.id)}>{destinations[target.id]?.name ?? "시리즈 고르기"}</Button>}
      </div>)}
      <p>다시 확인 0장 · 시리즈 등록만 해제</p>
      <p>레퍼런스, 대표 이미지, 수동 지정·제외 이력과 원본 파일을 유지합니다.</p>
      {error && <p role="alert">{error}</p>}
      <div className="ui-dialog__actions"><Button variant="ghost" disabled={busy} onClick={onClose}>취소</Button><Button variant="primary" disabled={busy || remaining.some(target => !destinations[target.id])} onClick={() => void apply()}><BusyLabel busy={busy} idle="분류함으로 바꾸기">바꾸는 중…</BusyLabel></Button></div>
    </div>
  </Dialog>
    {picking && <SeriesPicker parent={folder} entries={knownEntries} onClose={() => setPicking(null)} onSelected={entry => { setDestinations(current => ({ ...current, [picking]: entry })); setPicking(null); }} />}
  </>;
}
