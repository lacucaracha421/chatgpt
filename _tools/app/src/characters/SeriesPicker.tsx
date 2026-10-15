import { useEffect, useState } from "react";
import { FolderIcon, PlusIcon } from "@heroicons/react/24/outline";
import { useLibrary } from "../library/LibraryContext";
import type { ClassificationEntry } from "../library/types";
import { commandErrorMessage } from "../library/errorMessage";
import { Dialog } from "../shared/ui/Dialog";
import { Button } from "../shared/ui/Button";
import { BusyLabel } from "../shared/ui/BusyLabel";
import { TextField } from "../shared/ui/TextField";
import { useMotionSurface } from "../shared/ui/useMotionSurface";
import { characterHubApi } from "./hubApi";
import "./CharacterAssignPicker.css";

/** The common child-series choice for registration and container conversion. */
export function SeriesPicker({ parent, entries, onClose, onSelected }: {
  parent: ClassificationEntry; entries: ClassificationEntry[]; onClose(): void;
  onSelected(entry: ClassificationEntry): void | Promise<void>;
}) {
  const { gateway } = useLibrary();
  const [creating, setCreating] = useState(false), [name, setName] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<ClassificationEntry | null>(null);
  const listMotion = useMotionSurface("layer"), createMotion = useMotionSurface("layer");
  const [seriesIds, setSeriesIds] = useState<string[] | null>(null);
  useEffect(() => {
    let live = true;
    void characterHubApi.series().then(series => { if (live) setSeriesIds(series.map(item => item.classificationId)); }, reason => { if (live) setError(commandErrorMessage(reason, "시리즈를 불러오지 못했습니다.")); });
    return () => { live = false; };
  }, []);
  const choices = entries.filter(entry => entry.parentId === parent.id && !entry.isContainer && seriesIds?.includes(entry.id))
    .sort((a, b) => (b.totalAssetCount ?? b.assetCount ?? 0) - (a.totalAssetCount ?? a.assetCount ?? 0) || a.name.localeCompare(b.name, "ko"));
  async function choose(entry: ClassificationEntry) {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const existing = (await characterHubApi.series()).find(series => series.classificationId === entry.id);
      if (!existing) await characterHubApi.saveSeries({ classificationId: entry.id, heroAssetId: null, autoClassify: true });
      await onSelected(entry);
    } catch (reason) { setError(commandErrorMessage(reason, "시리즈를 등록하지 못했습니다.")); }
    finally { setBusy(false); }
  }
  async function create() {
    if (busy || !name.trim()) return;
    setBusy(true); setError(null);
    try {
      const entry = created ?? await gateway.createClassification({ kind: "tag", name: name.trim(), parentId: parent.id });
      setCreated(entry);
      await characterHubApi.saveSeries({ classificationId: entry.id, heroAssetId: null, autoClassify: true });
      await onSelected(entry);
    } catch (reason) { setError(commandErrorMessage(reason, "새 시리즈를 만들지 못했습니다.")); }
    finally { setBusy(false); }
  }
  return <Dialog open title="시리즈 고르기" onClose={() => { if (!busy) onClose(); }}>
    <p>{parent.name} 안에서 캐릭터를 둘 시리즈를 골라 주세요.</p>
    <BusyLabel busy={seriesIds === null && !error}>시리즈 불러오는 중…</BusyLabel>
    {seriesIds !== null && <div ref={listMotion} data-state="open" className="character-assign-picker__scroll" role="group" aria-label="하위 시리즈" onKeyDown={event => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      event.preventDefault(); buttons[Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
    }}>
      {choices.map(entry => <button type="button" className="character-assign-picker__row" aria-label={`${entry.name} · ${(entry.totalAssetCount ?? entry.assetCount ?? 0).toLocaleString("ko-KR")}장`} key={entry.id} disabled={busy} onClick={() => void choose(entry)}>
        <span className="character-assign-picker__create-icon"><FolderIcon aria-hidden="true" /></span>
        <span className="character-assign-picker__name">{entry.name}</span>
        <span className="character-assign-picker__count">{(entry.totalAssetCount ?? entry.assetCount ?? 0).toLocaleString("ko-KR")}장</span>
      </button>)}
    </div>}
    {creating ? <form ref={createMotion} data-state="open" className="classification-sidebar__form" onSubmit={event => { event.preventDefault(); void create(); }}>
      <TextField autoFocus label="새 시리즈 이름" value={name} disabled={busy || !!created} onChange={event => setName(event.target.value)} />
      <Button variant="primary" type="submit" disabled={busy || !name.trim()}><BusyLabel busy={busy} idle="만들기">만드는 중…</BusyLabel></Button>
    </form> : <button type="button" className="character-assign-picker__create" disabled={busy} onClick={() => setCreating(true)}><span className="character-assign-picker__create-icon"><PlusIcon aria-hidden="true" /></span>새 시리즈</button>}
    {error && <p role="alert">{error}</p>}
    <div className="ui-dialog__actions"><Button variant="ghost" disabled={busy} onClick={onClose}>취소</Button></div>
  </Dialog>;
}
