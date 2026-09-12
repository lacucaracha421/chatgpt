import { useEffect, useState } from "react";
import { useLibrary } from "../library/LibraryContext";
import type { CollectionVolume } from "../library/types";
import { commandErrorMessage } from "../library/errorMessage";
import { Button } from "../shared/ui/Button";

type Props = {
  collectionId: string; volumes: CollectionVolume[]; editionIndex: number;
  releaseWatch?: { enabled: boolean; disabled: boolean; unavailableReason?: string; onChange: (enabled: boolean) => void };
};

export function CollectionOwnershipPanel({ collectionId, volumes, editionIndex, releaseWatch }: Props) {
  const { gateway } = useLibrary();
  const api = gateway.collectionTracking;
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
      setTracked(entered); setOwned(count); setInput(entered ? String(count) : "");
    }, err => { if (active) setError(commandErrorMessage(err, "보유 정보를 불러오지 못했습니다.")); });
    return () => { active = false; };
  }, [api, collectionId, editionIndex]);
  if (!api) return null;
  const known = volumes.filter(volume => volume.editionIndex === editionIndex);
  const released = known.filter(volume => volume.releaseStatus === "released");
  const latest = released.length ? Math.max(...released.map(volume => volume.volumeNumber)) : null;
  const count = Number(input);
  async function save() {
    if (!api || busy || input.trim() === "" || !Number.isInteger(count) || count < 0 || count > 2000) return;
    setBusy(true); setError(null);
    try { await api.setOwnedCount(collectionId, editionIndex, count); setOwned(count); setTracked(true); }
    catch (err) { setError(commandErrorMessage(err, "보유 권수를 저장하지 못했습니다.")); }
    finally { setBusy(false); }
  }
  return <section className="collection-ownership" aria-label="보유 권 관리">
    <form className="collection-ownership__bulk" onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="collection-ownership__entry">
        <label className="collection-ownership__count">현재 보유 <input aria-label="현재 보유 권수" type="number" min={0} max={2000} placeholder="미입력" value={input} disabled={busy || owned === null} onChange={event => setInput(event.target.value)} /> 권</label>
        {releaseWatch && <label className="collection-ownership__watch" title={releaseWatch.unavailableReason}>
          <input type="checkbox" checked={releaseWatch.enabled} disabled={releaseWatch.disabled} aria-description={releaseWatch.unavailableReason} onChange={event => releaseWatch.onChange(event.target.checked)} />신간 알림
        </label>}
      </div>
      <Button type="submit" size="sm" disabled={busy || owned === null || input.trim() === "" || !Number.isInteger(count) || count < 0 || count > 2000 || (tracked && count === owned)}>{busy ? "저장 중…" : "저장"}</Button>
    </form>
    {error && <p role="alert">{error}</p>}
    <p>최신 출간: {latest === null ? "정보 없음" : `${latest}권`}</p>
    <p>미보유: {latest === null || owned === null ? "확인 불가" : `${Math.max(0, latest - owned)}권`}</p>
  </section>;
}
