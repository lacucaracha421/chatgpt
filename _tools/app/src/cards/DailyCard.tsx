import { ChevronRightIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";
import { displayTime } from "../shared/displayDate";
import { Button } from "../shared/ui/Button";
import { BusyLabel } from "../shared/ui/BusyLabel";
import { Dialog } from "../shared/ui/Dialog";
import { SectionLabel } from "../shared/ui/SectionLabel";
import { Skeleton } from "../shared/ui/Skeleton";
import type { CardState, OpenResult, ServerCard } from "./api";
import { BoosterPack } from "./BoosterPack";
import { keepOrRead } from "./keep";
import { finishOperation, isUndecided, operationId, readResult, saveResult } from "./packStore";
import { PackOpening } from "./PackOpening";
import { TradingCard } from "./TradingCard";
import { tierRank, type CardData, type PackCover } from "./types";
import "./dailyCard.css";

/** The pack commands and card art of one client (the PC's Tauri bridge or the tablet's server calls). */
export interface DailyCardClient {
  open(packId: string, operationId: string): Promise<OpenResult>;
  keep(packId: string, operationId: string, slots: number[]): Promise<OpenResult>;
  pack(packId: string): Promise<OpenResult>;
  display(cards: readonly ServerCard[], packId?: string): Promise<CardData[]>;
}
/** Today's card state as each client's state hook reads it. */
export interface DailyCardState {
  snapshot: { state: CardState; cover: PackCover } | null;
  error: boolean; pending: boolean;
  refresh(): void; retry(): void;
}
interface Session { packId: string; cover: PackCover; cards?: CardData[]; undecided?: boolean }
const noBack = (_close: () => void, _open: boolean) => undefined;

/**
 * 오늘의 카드 on Home, PC and tablet alike: the sealed pack, what is still waiting, and the last result.
 * Tapping the pack (or 뜯기) opens the full-screen pack opening; the picked cards go to the album with the
 * keep step. `touch` gives the tablet its touch-size buttons; `useBack` lets the tablet's Back close the opening.
 */
export function DailyCard({ client, cards: { snapshot, error, pending, refresh, retry }, root, onAlbum, touch = false, useBack = noBack, openingClassName }: {
  client: DailyCardClient; cards: DailyCardState; root: string; onAlbum?: () => void;
  touch?: boolean; useBack?: (close: () => void, open: boolean) => void; openingClassName?: string;
}) {
  const [session, setSession] = useState<Session | null>(null), [resumeFailed, setResumeFailed] = useState(false);
  const [last, setLast] = useState<{ result: OpenResult; cards: CardData[] } | null>(null);
  const mounted = useRef(false);
  // Today's opened packs already fetched here: their snapshots do not change, so a later state change needs no request.
  const fetched = useRef("");
  useBack(() => setSession(null), session !== null);
  useEffect(() => {
    mounted.current = true; let live = true;
    const saved = readResult(root);
    if (saved) void client.display(saved.cards, saved.packId).then(cards => { if (live) setLast({ result: saved, cards }); });
    return () => { live = false; mounted.current = false; };
  }, [client, root]);
  useEffect(() => {
    const state = snapshot?.state;
    if (!state || state.unopened.length) return;
    let live = true;
    // /state accrues today's daily pack before answering. With no unopened packs,
    // today's granted IDs are necessarily closed: POST only retrieves their snapshots.
    const compact = state.day.replace(/-/g, ""), ids = [`d-${compact}`, ...(state.bonusGranted ? [`b-${compact}`] : [])];
    // A result this device already holds for the newest pack needs no request.
    const fetchKey = `${root}:${ids.join()}`;
    if (readResult(root)?.packId === ids[ids.length - 1] || fetched.current === fetchKey) return;
    void Promise.resolve().then(() => Promise.allSettled(ids.map(id => client.open(id, operationId(root, id))))).then(async replies => {
      const stored = readResult(root);
      const results = replies.flatMap(reply => reply.status === "fulfilled" ? [reply.value] : []);
      if (stored) results.push(stored);
      const latest = results.sort((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt))[0];
      if (!latest || !live) return;
      saveResult(root, latest); replies.forEach((reply, index) => { if (reply.status === "fulfilled") finishOperation(root, ids[index]); });
      const cards = await client.display(latest.cards, latest.packId);
      if (!live) return;
      setLast({ result: latest, cards });
      if (replies.every(reply => reply.status === "fulfilled")) fetched.current = fetchKey;
    }).catch(() => undefined);
    return () => { live = false; };
  }, [client, root, snapshot?.state.revision, snapshot?.state.day, snapshot?.state.unopened.length, snapshot?.state.bonusGranted]);
  const state = snapshot?.state, cover = snapshot?.cover ?? { imageUrls: [] };
  const open = async (packId: string) => {
    const result = await client.open(packId, operationId(root, packId));
    saveResult(root, result); finishOperation(root, packId);
    const cards = await client.display(result.cards, result.packId);
    if (mounted.current) { setLast({ result, cards }); refresh(); }
    return { cards, alreadyOpened: result.alreadyOpened, undecided: isUndecided(result) };
  };
  /** Puts the chosen slots into the album, then shows the pack as the album now holds it. */
  const keepPack = async (packId: string, slots: number[]) => {
    try {
      const { result, refused } = await keepOrRead(() => client.keep(packId, operationId(root, packId, "keep"), slots), () => client.pack(packId), slots);
      saveResult(root, result); finishOperation(root, packId, "keep");
      const cards = await client.display(result.cards, result.packId);
      if (mounted.current) setLast({ result, cards });
      refresh();
      return { cards, refused };
    } catch (failure) { refresh(); throw failure; }
  };
  const waiting = state?.pendingKeep ?? [];
  /** Reopens an opened pack that was left undecided, here or on another device. */
  const resume = async () => {
    const id = waiting[0]?.packId;
    if (!id) return;
    setResumeFailed(false);
    try {
      const result = await client.pack(id), cards = await client.display(result.cards, result.packId);
      if (mounted.current) setSession({ packId: id, cover, cards, undecided: isUndecided(result) });
      if (!isUndecided(result)) refresh();
    } catch { if (mounted.current) setResumeFailed(true); }
  };
  const best = (last?.cards.some(card => card.kept) ? last.cards.filter(card => card.kept) : last?.cards)?.reduce<CardData | null>((current, card) => !current || tierRank(card.tier) > tierRank(current.tier) ? card : current, null);
  const pack = state?.unopened[0];
  const albumLabel = state ? `앨범 ${state.albumSummary.cards}/${state.albumSummary.total}` : "앨범";
  const goAlbum = () => { setSession(null); onAlbum?.(); };
  const start = () => { if (pack) setSession({ packId: pack.id, cover }); };
  const nextPack = state && <small>{`${displayTime(state.nextResetAt)} 새 팩 증정`}</small>;
  // Compact (user 2026-10-18): the column is as wide as the card, beside 전송; the album link sits under the card.
  const album = onAlbum && <button type="button" className="home-link home-daily-card__album" onClick={goAlbum}>{albumLabel}<ChevronRightIcon aria-hidden="true" /></button>;
  // Without a sealed pack it is still offered for an undecided pack the result card does not already reopen, so an older one stays reachable until it expires.
  const resumeButton = waiting.length > 0 && <Button variant="quiet" size="sm" onClick={() => { void resume(); }}>{`정리 안 한 팩 ${waiting.length}`}</Button>;
  const opening = session && <PackOpening key={session.packId} cover={session.cover} cards={session.cards} initialResults={!!session.cards} undecided={session.undecided}
    loadDraw={session.cards ? undefined : () => open(session.packId)} keep={{ onKeep: slots => keepPack(session.packId, slots), onLater: () => setSession(null) }}
    onClose={() => setSession(null)} onAlbum={onAlbum ? goAlbum : undefined} />;
  return <section className={`home-attention-section home-daily-card${touch ? " home-daily-card--touch" : ""}`} aria-label="오늘의 카드">
    <SectionLabel title="오늘의 카드" />
    <div className="home-daily-card__body">
      {!snapshot ? <div className="home-daily-card__loading"><BusyLabel busy={pending} delay={400}>{"불러오는 중"}</BusyLabel>{pending && <Skeleton className="daily-card-skeleton" label="오늘의 카드" />}{album}</div> : !pack ? <div className="daily-card-result">
        <div className="daily-card-result__art">{best && last && <button type="button" className="daily-card-result__button" aria-label="오늘의 결과 보기" onClick={() => setSession({ packId: last.result.packId, cover, cards: last.cards, undecided: waiting.some(item => item.packId === last.result.packId) })}>
          <TradingCard card={best} />
        </button>}</div>
        <div className="home-daily-card__meta">{nextPack}{waiting.some(item => item.packId !== last?.result.packId) && resumeButton}{album}</div>
      </div> : <>
        <div className="daily-card-stage__art"><button type="button" className="card-demo-preview__button" aria-label="오늘의 카드 팩 열기" onClick={start}><span aria-hidden="true" inert><BoosterPack cover={cover} disabled /></span></button></div>
        <div className="daily-card-stage__copy">
          <Button size={touch ? "md" : "sm"} onClick={start}>뜯기</Button>
          <small>{`남은 팩 ${state!.unopened.length}`}</small>
          {resumeButton}
          {state?.bonusGranted && <small>오늘 50장 저장 · 보너스 팩</small>}
          {nextPack}
          {album}
        </div>
      </>}
    </div>
    {resumeFailed && <p role="alert" className="daily-card-error">정리 안 한 팩을 불러오지 못했습니다. <Button variant="quiet" onClick={() => { void resume(); }}>다시 시도</Button></p>}
    {error && <p role="alert" className="daily-card-error">카드를 불러오지 못했습니다. <Button variant="quiet" onClick={retry}>다시 시도</Button></p>}
    <Dialog open={session !== null} title="오늘의 카드" variant="fullscreen" onClose={() => setSession(null)}>
      {openingClassName ? opening && <div className={openingClassName}>{opening}</div> : opening}
    </Dialog>
  </section>;
}
