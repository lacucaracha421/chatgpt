import { BusyLabel } from "../shared/ui/BusyLabel";
import { useEffect, useRef, useState } from "react";
import { useLibrary } from "../library/LibraryContext";
import type { CollectionVolume, VolumeOwnership } from "../library/types";
import { commandErrorMessage } from "../library/errorMessage";
import { Button } from "../shared/ui/Button";
import { Switch } from "../shared/ui/Switch";
import { invalidateReleaseData } from "./releaseData";

type Props = {
  compact?: boolean; onOwnershipChanged?(entries: VolumeOwnership[]): void;
  collectionId: string; volumes: CollectionVolume[]; editionIndex: number;
  releaseWatch?: { enabled: boolean; disabled: boolean; unavailableReason?: string; onChange: (enabled: boolean) => void };
};

export function CollectionOwnershipPanel({ collectionId, volumes, editionIndex, releaseWatch, compact = false, onOwnershipChanged }: Props) {
  const { gateway } = useLibrary();
  const api = gateway.collectionTracking;
  const changedRef = useRef(onOwnershipChanged); changedRef.current = onOwnershipChanged;
  const [owned, setOwned] = useState<number | null>(null);
  const [input, setInput] = useState("");
  const [tracked, setTracked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setOwned(null); setInput(""); setError(null);
    setTracked(false);
    if (api) void Promise.all([api.listOwnership(collectionId), api.ownershipTracking?.(collectionId)]).then(([data, editions]) => {
      if (!active) return;
      const count = data.filter(entry => entry.editionIndex === editionIndex && (entry.physical || entry.digital)).length;
      const entered = editions ? editions.includes(editionIndex) : count > 0;
      changedRef.current?.(data);
      setTracked(entered); setOwned(count); setInput(entered ? String(count) : "");
    }, err => { if (active) setError(commandErrorMessage(err, "보유 정보를 불러오지 못했습니다.")); });
    return () => { active = false; };
  }, [api, collectionId, editionIndex]);
  if (!api) return null;
  const known = volumes.filter(volume => volume.editionIndex === editionIndex);
  const released = known.filter(volume => volume.releaseStatus === "released");
  const latest = released.length ? Math.max(...released.map(volume => volume.volumeNumber)) : null;
  const count = Number(input);
  async function save(nextCount = count) {
    if (!api || busy || (!compact && input.trim() === "") || !Number.isInteger(nextCount) || nextCount < 0 || nextCount > 2000) return;
    setBusy(true); setError(null);
    try { const entries = await api.setOwnedCount(collectionId, editionIndex, nextCount); setOwned(nextCount); setInput(String(nextCount)); changedRef.current?.(entries); setTracked(true); invalidateReleaseData(); }
    catch (err) { setError(commandErrorMessage(err, "보유 권수를 저장하지 못했습니다.")); }
    finally { setBusy(false); }
  }
  if (compact) return <section className="collection-ownership collection-ownership--work" aria-label="보유 권 관리">
    <div className="work-own-row"><span>보유</span><span className="work-owned-stepper"><Button size="icon" variant="quiet" aria-label="한 권 줄이기" disabled={busy || owned === null || (tracked && owned === 0)} onClick={() => void save(Math.max(0, (owned ?? 0) - 1))}>−</Button><b aria-label="현재 보유 권수">{tracked ? owned : "미입력"}</b><Button size="icon" variant="quiet" aria-label="한 권 늘리기" disabled={busy || owned === null || owned >= 2000} onClick={() => void save((owned ?? 0) + 1)}>+</Button></span><span>/ {known.length}권</span></div>
    {releaseWatch && <div className="work-own-row"><Switch label="신간 알림" checked={releaseWatch.enabled} disabled={releaseWatch.disabled} onChange={event => releaseWatch.onChange(event.target.checked)} />{releaseWatch.unavailableReason && <small>{releaseWatch.unavailableReason}</small>}</div>}
    {error && <p role="alert">{error}</p>}
    <p>최신 출간: {latest === null ? "정보 없음" : `${latest}권`} · 미보유: {latest === null || owned === null ? "확인 불가" : `${Math.max(0, latest - owned)}권`}</p>
  </section>;
  return <section className="collection-ownership" aria-label="보유 권 관리">
    <form className="collection-ownership__bulk" onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="collection-ownership__entry">
        <label className="collection-ownership__count">현재 보유 <input aria-label="현재 보유 권수" type="number" min={0} max={2000} placeholder="미입력" value={input} disabled={busy || owned === null} onChange={event => setInput(event.target.value)} /> 권</label>
        {releaseWatch && <label className="collection-ownership__watch" title={releaseWatch.unavailableReason}>
          <input type="checkbox" checked={releaseWatch.enabled} disabled={releaseWatch.disabled} aria-description={releaseWatch.unavailableReason} onChange={event => releaseWatch.onChange(event.target.checked)} />신간 알림
        </label>}
      </div>
      <Button type="submit" size="sm" disabled={busy || owned === null || input.trim() === "" || !Number.isInteger(count) || count < 0 || count > 2000 || (tracked && count === owned)}><BusyLabel busy={!!(busy)} idle={"저장"}>저장 중…</BusyLabel></Button>
    </form>
    {error && <p role="alert">{error}</p>}
    <p>최신 출간: {latest === null ? "정보 없음" : `${latest}권`}</p>
    <p>미보유: {latest === null || owned === null ? "확인 불가" : `${Math.max(0, latest - owned)}권`}</p>
  </section>;
}
