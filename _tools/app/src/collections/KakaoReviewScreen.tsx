import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeftIcon, CheckIcon, MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import type { CollectionSummary, KakaoReview } from "../library/types";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import { ViewToolbar } from "../layout/ViewToolbar";
import { Button } from "../shared/ui/Button";
import { TextInput } from "../shared/ui/TextInput";
import { SegmentedControl } from "../shared/ui/SegmentedControl";
import { StableImage } from "../shared/ui/StableImage";
import { Skeleton } from "../shared/ui/Skeleton";
import { Toast } from "../shared/ui/Toast";
import { useAutoDismiss } from "../shared/ui/useAutoDismiss";
import { prefersReducedMotion } from "../shared/ui/motionCurves";
import { usePrivacy } from "../privacy/PrivacyContext";
import { swapSegment, cancelSegmentSwap } from "../shared/motion/viewSwap";
import { KakaoConnectDialog } from "./KakaoConnectDialog";
import { KakaoReviewIdentity, KakaoReviewVolumes } from "./KakaoReviewIdentity";
import { QUERY_SOURCES, kakaoReviewSegment, type KakaoReviewSegment } from "./kakaoReviewModel";
import "./kakaoReview.css";
import "./book-connect.css";

export function useKakaoReviews(collections: CollectionSummary[], active = true) {
  const { gateway, library } = useLibrary();
  const [reviews, setReviews] = useState<KakaoReview[] | null>(null);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    if (!gateway.listKakaoReviews) return [];
    const version = ++generation.current;
    try { const next = await gateway.listKakaoReviews(); if (version === generation.current) { setReviews(next); setError(""); } return next; }
    catch (reason) { if (version === generation.current) setError(commandErrorMessage(reason, "연결 점검을 불러오지 못했습니다.")); return null; }
  }, [gateway, library?.root]);
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => void refresh(), 180);
    return () => { clearTimeout(timer); generation.current++; };
  }, [refresh, collections, active]);
  const update = (review: KakaoReview) => setReviews(current => current?.map(r => r.collectionId === review.collectionId ? review : r) ?? null);
  return { reviews, refresh, update, error };
}

export function KakaoReviewScreen({ collections, data, coverUrl, onBack, onChanged }: {
  collections: CollectionSummary[]; data: ReturnType<typeof useKakaoReviews>;
  coverUrl(work: CollectionSummary): string | null; onBack(): void; onChanged(): Promise<void>;
}) {
  const { gateway } = useLibrary();
  const { privacyMode } = usePrivacy();
  const [segment, setSegment] = useState<KakaoReviewSegment>("unlinked");
  const currentSegment = useRef(segment); currentSegment.current = segment;
  const [queries, setQueries] = useState<Record<string, string>>({});
  const [dialog, setDialog] = useState<{ work: CollectionSummary; review: KakaoReview; query: string } | null>(null);
  const [exits, setExits] = useState<Record<string, "success" | "folding">>({});
  const [removed, setRemoved] = useState<Record<string, KakaoReviewSegment>>({});
  const [held, setHeld] = useState<Record<string, KakaoReview>>({});
  const [entering, setEntering] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; undo?: () => Promise<void> } | null>(null);
  const dismissNotice = useCallback(() => setNotice(null), []);
  useAutoDismiss(notice?.text ?? null, dismissNotice);
  const list = useRef<HTMLDivElement>(null), swap = useRef({}).current;
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const motionGeneration = useRef<Record<string, number>>({});
  useEffect(() => () => { timers.current.forEach(clearTimeout); cancelSegmentSwap(swap); }, [swap]);
  const byId = new Map((data.reviews ?? []).map(r => [r.collectionId, r]));
  const pairs = collections.filter(w => w.type === "manga").flatMap(work => { const review = byId.get(work.id); return review ? [{ work, review }] : []; });
  const counted = pairs.filter(({ work, review }) => removed[work.id] !== kakaoReviewSegment(review) && exits[work.id] !== "folding");
  const rows = pairs.flatMap(({ work, review }) => {
    const shown = held[work.id] ?? review;
    return removed[work.id] !== segment && kakaoReviewSegment(shown) === segment ? [{work, review: shown}] : [];
  });
  const rowIds = useRef<string[]>([]); rowIds.current = rows.map(({work}) => work.id);
  const counts = (value: KakaoReviewSegment) => counted.filter(({ review }) => kakaoReviewSegment(review) === value).length;
  const focus = (id?: string) => { const next = id && list.current?.querySelector<HTMLButtonElement>(`[data-review-id="${CSS.escape(id)}"] [data-review-find]`); if (next) next.focus(); else list.current?.focus(); };
  const queryFor = (review: KakaoReview) => queries[review.collectionId] ?? review.query;
  const open = (work: CollectionSummary, review: KakaoReview) => setDialog({ work, review, query: queryFor(review) });
  async function persist(review: KakaoReview, excluded: boolean) {
    if (review.bound) {
      if (!gateway.setKakaoPartialDismissed || !review.dismissalSupported) throw new Error("연결 점검 설정을 저장하려면 서버 업데이트가 필요합니다.");
      await gateway.setKakaoPartialDismissed(review.collectionId, excluded);
    } else {
      if (!gateway.setCollectionVolumeRange) throw new Error("PC 앱을 업데이트해 주세요.");
      await gateway.setCollectionVolumeRange(review.collectionId, { minVolume: review.minVolume, maxVolume: review.maxVolume, hideConnectionPrompt: excluded });
    }
    data.update({ ...review, ...(review.bound ? { partialDismissed: excluded } : { hideConnectionPrompt: excluded }) });
    await onChanged();
    await data.refresh();
  }
  async function exclude(review: KakaoReview, excluded: boolean) {
    setSaving(review.collectionId);
    setHeld(current => ({...current, [review.collectionId]: review}));
    try {
      await persist(review, excluded);
      fold(review.collectionId, false);
      setNotice({ text: excluded ? (review.bound ? "이대로 두기로 옮겼습니다." : "연결 안 함으로 옮겼습니다.") : "다시 점검합니다.", undo: async () => {
        motionGeneration.current[review.collectionId] = (motionGeneration.current[review.collectionId] ?? 0) + 1;
        const current = {...review, ...(review.bound ? {partialDismissed: excluded} : {hideConnectionPrompt: excluded})};
        const leaving = kakaoReviewSegment(current) === currentSegment.current;
        setHeld(values => { const next = {...values}; if (leaving) next[review.collectionId] = current; else delete next[review.collectionId]; return next; });
        setRemoved(values => { const next = {...values}; delete next[review.collectionId]; return next; });
        setExits(values => { const next = {...values}; delete next[review.collectionId]; return next; });
        if (!leaving) setEntering(values => ({...values, [review.collectionId]: true}));
        await persist(current, !excluded);
        if (leaving) fold(review.collectionId, false);
        else timers.current.push(setTimeout(() => { setEntering(values => { const next = {...values}; delete next[review.collectionId]; return next; }); focus(review.collectionId); }, prefersReducedMotion() ? 0 : 220));
        setNotice(null);
      } });
    } catch (reason) { setHeld(current => { const next = {...current}; delete next[review.collectionId]; return next; }); setNotice({ text: commandErrorMessage(reason, "점검 표시를 저장하지 못했습니다.") }); throw reason; }
    finally { setSaving(null); }
  }
  function fold(id: string, success: boolean) {
    const generation = motionGeneration.current[id] = (motionGeneration.current[id] ?? 0) + 1;
    const index = rowIds.current.indexOf(id), source = currentSegment.current;
    const nextId = rowIds.current[index + 1] ?? rowIds.current[index - 1];
    const finish = () => {
      if (motionGeneration.current[id] !== generation) return;
      setRemoved(current => ({ ...current, [id]: source }));
      setExits(current => { const next = { ...current }; delete next[id]; return next; });
      setHeld(current => { const next = {...current}; delete next[id]; return next; });
      timers.current.push(setTimeout(() => { if (source === currentSegment.current) focus(nextId); }, 0));
    };
    if (prefersReducedMotion()) { finish(); return; }
    setExits(current => ({ ...current, [id]: success ? "success" : "folding" }));
    timers.current.push(setTimeout(() => {
      if (motionGeneration.current[id] !== generation) return;
      setExits(current => ({ ...current, [id]: "folding" }));
      timers.current.push(setTimeout(finish, 220));
    }, success ? 600 : 0));
  }
  async function linked(id: string) {
    const previous = byId.get(id);
    if (!previous) return;
    setHeld(current => ({...current, [id]: previous}));
    try {
      await onChanged();
      const refreshed = await data.refresh();
      const next = refreshed?.find(review => review.collectionId === id);
      if (next && kakaoReviewSegment(next) !== segment) fold(id, true);
      else setHeld(current => { const values = {...current}; delete values[id]; return values; });
    } catch (reason) {
      setHeld(current => { const values = {...current}; delete values[id]; return values; });
      setNotice({text: commandErrorMessage(reason, "연결 목록을 갱신하지 못했습니다.")});
    }
  }
  const changeSegment = (next: KakaoReviewSegment) => swapSegment(swap, { target: list.current, forward: ["unlinked", "partial", "excluded"].indexOf(next) > ["unlinked", "partial", "excluded"].indexOf(segment), commit: () => { setRemoved({}); setSegment(next); } });
  return <section className="kakao-review" aria-label="Kakao 연결 점검">
    <ViewToolbar title="Kakao 연결 점검" chrome={{}} ariaLabel="Kakao 연결 점검 도구" leadingAction={<Button size="icon" variant="ghost" aria-label="만화 목록으로" onClick={onBack}><ArrowLeftIcon /></Button>} />
    <div className="kakao-review__bar"><SegmentedControl label="연결 상태" value={segment} onChange={changeSegment} options={[
      { value: "unlinked", label: "미연결", count: counts("unlinked") }, { value: "partial", label: "일부 권", count: counts("partial") }, { value: "excluded", label: "제외", count: counts("excluded") },
    ]} /></div>
    <div ref={list} tabIndex={-1} className="kakao-review__list">
      {data.error && <p role="alert">{data.error}<Button onClick={() => void data.refresh()}>다시 시도</Button></p>}
      {data.reviews === null && !data.error && <Skeleton label="연결 점검" />}
      {data.reviews !== null && rows.length === 0 && <p className="kakao-review__empty">{segment === "excluded" ? "제외한 작품이 없습니다." : "점검할 작품이 없습니다."}</p>}
      {rows.map(({ work, review }, index) => {
        const url = privacyMode ? null : coverUrl(work), leaving = exits[work.id];
        return <div key={work.id} data-review-id={work.id} className={`kakao-review__row${review.bound ? " is-partial" : ""}${leaving ? ` is-${leaving}` : ""}${entering[work.id] ? " is-entering" : ""}`} onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); focus(rows[Math.min(rows.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)))]?.work.id); }
          if (event.key === "Enter" && !(event.target instanceof HTMLButtonElement)) { event.preventDefault(); open(work, review); }
        }}>
          <KakaoReviewIdentity name={work.name} subtitle={[work.author, `보유 ${review.ownedCount}권`].filter(Boolean).join(" · ")} cover={<span className="kakao-review__cover">{url && <StableImage src={url} alt="" />}</span>} />
          {review.bound ? <KakaoReviewVolumes review={review} /> : <><TextInput aria-label={`${work.name} 검색어`} value={queryFor(review)} onChange={event => setQueries(current => ({ ...current, [work.id]: event.target.value }))} /><small className="kakao-review__source">{QUERY_SOURCES[review.querySource]}</small></>}
          <span className="kakao-review__actions">
            {leaving === "success" ? <span className="kakao-review__done"><CheckIcon />연결됨</span> : segment === "excluded" ? <Button data-review-find size="sm" disabled={saving !== null || (review.bound && !review.dismissalSupported)} onClick={() => void exclude(review, false).catch(() => undefined)}>다시 점검</Button> : <>
              {(!review.bound || review.dismissalSupported) && <Button size="sm" variant="ghost" className={review.bound ? "" : "kakao-review__skip"} disabled={saving !== null} onClick={() => void exclude(review, true).catch(() => undefined)}>{review.bound ? "이대로 두기" : "연결 안 함"}</Button>}
              <Button data-review-find size="sm" disabled={saving !== null} onClick={() => open(work, review)}><MagnifyingGlassIcon />{review.bound ? "다시 연결" : "찾기"}</Button>
            </>}
          </span>
        </div>;
      })}
    </div>
    {dialog && <KakaoConnectDialog key={dialog.work.id} open collectionId={dialog.work.id} initialQuery={dialog.query} autoSearch
      initialGroupFingerprints={dialog.review.groupFingerprints} work={{ name: dialog.work.name, coverUrl: privacyMode ? null : coverUrl(dialog.work), ownedCount: dialog.review.ownedCount }}
      onSkip={!dialog.review.bound ? () => exclude(dialog.review, true) : undefined} onClose={() => setDialog(null)} onApplied={() => void linked(dialog.work.id)} />}
    {notice && <Toast onDismiss={() => setNotice(null)} actionLabel={notice.undo ? "되돌리기" : undefined} onAction={() => { void notice.undo?.().catch(reason => setNotice({ text: commandErrorMessage(reason, "되돌리지 못했습니다.") })); }}>{notice.text}</Toast>}
  </section>;
}
