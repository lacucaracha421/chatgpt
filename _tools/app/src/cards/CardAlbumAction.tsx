import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import type { CardData, CardTier } from "./types";

/** Album-only action: the underlying Asset and draw history are never deleted. */
export function CardAlbumAction({ card, trashed, setTrashed, onChanged, backRef }: {
  card: CardData; trashed: boolean;
  setTrashed: (characterId: string, tier: CardTier, trashed: boolean) => Promise<unknown>;
  onChanged: (id: string) => void;
  backRef?: MutableRefObject<(() => boolean) | null>;
}) {
  const [confirm, setConfirm] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState(false);
  const mounted = useRef(true), running = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!backRef) return;
    backRef.current = () => { if (!confirm) return false; if (!running.current) setConfirm(false); return true; };
    return () => { backRef.current = null; };
  }, [backRef, confirm]);
  const apply = async () => {
    if (running.current || !card.characterId) return;
    running.current = true; setPending(true); setError(false);
    try {
      await setTrashed(card.characterId, card.tier, !trashed);
      if (mounted.current) { setConfirm(false); onChanged(card.id); }
    } catch { if (mounted.current) setError(true); }
    finally { running.current = false; if (mounted.current) setPending(false); }
  };
  return <>
    <Button variant="quiet" disabled={pending} onClick={() => { setError(false); if (trashed) void apply(); else setConfirm(true); }}>{trashed ? "복원" : "카드 삭제"}</Button>
    {trashed && error && <p role="alert">카드를 복원하지 못했습니다. 다시 시도해 주세요.</p>}
    <Dialog open={confirm} title="카드를 휴지통으로 옮길까요?" onClose={() => { if (!running.current) setConfirm(false); }}>
      <p>{card.characterName} · {card.tier.toUpperCase()} · {card.count}장 전체를 옮깁니다. 원본 이미지는 유지되며 앨범의 휴지통에서 복원할 수 있습니다.</p>
      {error && <p role="alert">카드를 옮기지 못했습니다. 다시 시도해 주세요.</p>}
      <Button disabled={pending} onClick={() => setConfirm(false)}>취소</Button>
      <Button variant="danger" disabled={pending} onClick={() => void apply()}>휴지통으로 이동</Button>
    </Dialog>
  </>;
}
