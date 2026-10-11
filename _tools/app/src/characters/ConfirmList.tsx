import { BusyLabel } from "../shared/ui/BusyLabel";
import { useAssetMask } from "../privacy/PrivacyContext";
import { AssetImage } from "../privacy/AssetImage";
import { workloadPollDelay, getWorkloadProfile } from "../app/workloadProfile";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { Button } from "../shared/ui/Button";
import { Badge } from "../shared/ui/Badge";
import { Dialog } from "../shared/ui/Dialog";
import { EmptyState } from "../shared/ui/EmptyState";
import { assetUrl, thumbnailUrl } from "../assets/mediaUrl";
import { commandErrorMessage } from "../library/errorMessage";
import type { ClassificationEntry } from "../library/types";
import type { CharacterTarget, DecisionRequest, DecisionRequestKind } from "./api";
import { confirmSources, readConfirmItems, type ConfirmScope, type ConfirmSources } from "./confirmClient";
import { CONFIRM_KINDS, confirmCounts, confirmKindLabel, type ConfirmItem, type ConfirmKind } from "./confirmModel";
import { classificationIsInSeries, taggerDecisionApi, type TaggerDecisionApi } from "./taggerReviewClient";
import "./ConfirmList.css";

const REFILL_STRIP = 12;

type Props = {
  scope?: ConfirmScope;
  targets: readonly CharacterTarget[];
  /** Folder tree, to tell whether a tag-listed image already sits in its character's series. */
  classifications: readonly ClassificationEntry[];
  privacyMode?: boolean;
  onClose: () => void;
  /** Called after a judgment is stored so galleries can refresh. */
  onChanged?: () => void;
  sources?: ConfirmSources;
  decisions?: TaggerDecisionApi;
};

type Decision = Extract<DecisionRequestKind, "accepted" | "rejected" | "accepted_wrong_region">;
/** `moved` judgments put the image into the character's series, which 되돌리기 cannot take back. */
type Judgment = { item: ConfirmItem; decision: Decision; moved: boolean };
type Folder = { key: string; state: "inside" | "outside" };

const decisionRequest = (item: ConfirmItem, decision: DecisionRequestKind): DecisionRequest => ({
  targetId: item.targetId, expectedFingerprint: item.targetFingerprint, assetIds: [item.assetId], decision, baselineFingerprint: null, scanId: null,
});
const decisionText = (decision: Decision) => decision === "rejected" ? "아님" : decision === "accepted" ? "맞음" : "맞음 · 위치 틀림";

/**
 * 확인: one image at a time, in a list that holds 태그 추천, 인식 추천 and 다시 확인. 맞음 / 아님 /
 * 맞음 · 위치 틀림 are ordinary manual decisions; only the reason badges differ by kind.
 */
export function ConfirmList({ scope, targets, classifications, privacyMode = false, onClose, onChanged, sources = confirmSources, decisions = taggerDecisionApi }: Props) {
  const [items, setItems] = useState<ConfirmItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState<ConfirmKind[]>([]);
  const [busy, setBusy] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [last, setLast] = useState<Judgment | null>(null);
  const [kind, setKind] = useState<ConfirmKind | "all">("all");
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(() => new Set());
  const [reload, setReload] = useState(0);
  const [folder, setFolder] = useState<Folder | null>(null);
  const judged = useRef(new Map<string, Judgment>());
  const pending = useRef(false);
  const currentKey = useRef<string | null>(null);
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const classificationsRef = useRef(classifications);
  classificationsRef.current = classifications;
  const seriesId = scope?.series?.id;
  const targetId = scope?.target?.id;

  const readScope = useMemo<ConfirmScope>(() => ({
    ...(seriesId ? { series: { id: seriesId, name: scope?.series?.name ?? "" } } : {}),
    ...(targetId ? { target: { id: targetId, name: scope?.target?.name ?? "" } } : {}),
  }), [seriesId, targetId, scope?.series?.name, scope?.target?.name]);

  // Old content stays until the new read lands; the image on screen keeps its place across a reload.
  useEffect(() => {
    let live = true;
    setLoading(true);
    void readConfirmItems(sources, readScope, targetsRef.current, () => live).then(read => {
      if (!live || !read) return;
      const next = read.items.filter(item => !judged.current.has(item.key));
      const keep = currentKey.current ? next.findIndex(item => item.key === currentKey.current) : -1;
      if (keep > 0) next.unshift(...next.splice(keep, 1));
      setItems(next);
      setFailed(read.failed);
      setLoaded(true);
    }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [sources, readScope, reload]);

  const counts = useMemo(() => confirmCounts(items), [items]);
  const activeKind = kind !== "all" && counts[kind] > 0 ? kind : "all";
  const shown = useMemo(() => items.filter(item => (activeKind === "all" || item.kind === activeKind) && !skipped.has(item.key)), [items, activeKind, skipped]);
  const current = shown[0];
  currentKey.current = current?.key ?? null;
  const next = shown[1];
  const nextMasked = useAssetMask(next?.assetId, privacyMode);
  useEffect(() => {
    if (!next || nextMasked) return;
    const image = new Image();
    image.src = assetUrl(next.assetId);
    return () => { image.src = ""; };
  }, [next?.assetId, nextMasked]);

  // Mobile judgments applied in the background move the list; read again when the counter moves.
  useEffect(() => {
    const inboundStatus = sources.shadow.inboundStatus;
    if (!inboundStatus) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let inbound: number | null = null;
    async function poll() {
      try {
        if (getWorkloadProfile().hidden) return;
        const { applied } = await inboundStatus!();
        if (!disposed && inbound !== null && applied !== inbound) setReload(value => value + 1);
        inbound = applied;
      } catch { /* The list itself reports read failures. */ }
      finally { if (!disposed) timer = setTimeout(() => void poll(), workloadPollDelay(1000)); }
    }
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [sources]);
  // Returning to the window may follow judgments made elsewhere (another window, mobile).
  useEffect(() => {
    const onFocus = () => setReload(value => value + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // Where the image sits now: a tag-listed image outside its series is moved in when judged 맞음.
  useEffect(() => {
    if (!current?.fromTags) { setFolder(null); return; }
    let live = true;
    const { key, assetId, fromTags } = current;
    void decisions.classifications(assetId).then(ids => {
      if (live) setFolder({ key, state: classificationIsInSeries(ids, fromTags.seriesId, classificationsRef.current) ? "inside" : "outside" });
    }, () => { if (live) setFolder(null); });
    return () => { live = false; };
  }, [current?.key, decisions]);

  async function judge(decision: Decision) {
    if (!current || pending.current) return;
    if (decision === "accepted_wrong_region" && !current.crop) return;
    const item = current;
    pending.current = true;
    setBusy(true); setDecisionError(null);
    try {
      let moved = false;
      if (decision !== "rejected" && item.fromTags) {
        const ids = await decisions.classifications(item.assetId);
        if (!classificationIsInSeries(ids, item.fromTags.seriesId, classificationsRef.current)) {
          await decisions.move(item.targetId, item.targetFingerprint, [item.assetId], decision === "accepted");
          moved = true;
        }
      }
      if (!moved) await decisions.decide(decisionRequest(item, decision));
      const judgment = { item, decision, moved };
      judged.current.set(item.key, judgment);
      setItems(previous => previous.filter(row => row.key !== item.key));
      setLast(moved ? null : judgment);
      onChanged?.();
    } catch (e) {
      setDecisionError(commandErrorMessage(e, "판단을 저장하지 못했습니다."));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function undo() {
    if (!last || pending.current) return;
    pending.current = true;
    setBusy(true); setDecisionError(null);
    try {
      await decisions.decide(decisionRequest(last.item, "cleared"));
      judged.current.delete(last.item.key);
      setItems(previous => [last.item, ...previous.filter(row => row.key !== last.item.key)]);
      setSkipped(previous => { const rest = new Set(previous); rest.delete(last.item.key); return rest; });
      setLast(null);
      onChanged?.();
    } catch (e) {
      setDecisionError(commandErrorMessage(e, "판단을 되돌리지 못했습니다."));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  function skip() {
    if (!current || busy) return;
    setDecisionError(null);
    setSkipped(previous => new Set(previous).add(current.key));
  }
  function jumpTo(item: ConfirmItem) {
    if (busy || item.key === current?.key) return;
    setItems(previous => [item, ...previous.filter(row => row.key !== item.key)]);
  }
  const retry = () => setReload(value => value + 1);

  // Another character already judged on this same image in this window.
  const sameImage = current ? [...judged.current.values()].filter(j => j.item.assetId === current.assetId && j.item.targetId !== current.targetId) : [];
  const scopeName = [scope?.series?.name, scope?.target?.name].filter(Boolean).join(" › ");
  const tabs: (ConfirmKind | "all")[] = ["all", ...CONFIRM_KINDS.filter(candidate => counts[candidate] > 0)];
  const allFailed = failed.length === CONFIRM_KINDS.length;

  return <Dialog open variant="fullscreen" title="확인" onClose={onClose}
    onKeyDown={event => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const key = event.key.toLowerCase();
      if (key === "arrowright" || key === "d") { event.preventDefault(); void judge("accepted"); }
      else if (key === "arrowleft" || key === "a") { event.preventDefault(); void judge("rejected"); }
      else if (key === "w") { event.preventDefault(); void judge("accepted_wrong_region"); }
      else if (key === "arrowdown" || key === "s") { event.preventDefault(); skip(); }
      else if (key === "z") { event.preventDefault(); void undo(); }
    }}>
    <section className="confirm-list" aria-label="확인">
      <header className="confirm-list__header">
        <h2>확인</h2>
        {scopeName && <small className="confirm-list__scope">{scopeName}</small>}
        <div className="confirm-list__tabs" role="tablist" aria-label="확인 종류">
          {tabs.map(tab => <button key={tab} type="button" role="tab" aria-selected={activeKind === tab} disabled={busy} onClick={() => setKind(tab)}>
            {tab === "all" ? "전체" : confirmKindLabel[tab]} <span className="numeric">{counts[tab === "all" ? "total" : tab].toLocaleString()}</span>
          </button>)}
        </div>
        <span className="confirm-list__remaining" aria-live="polite">남은 항목 <b className="numeric">{(activeKind === "all" ? counts.total : counts[activeKind]).toLocaleString()}</b></span>
        <Button size="icon" variant="ghost" aria-label="확인 닫기" onClick={onClose}><XMarkIcon aria-hidden="true" /></Button>
      </header>
      <BusyLabel busy={loading && !loaded}><p className="character-message confirm-list__notice" role="status">불러오는 중…</p></BusyLabel>
      {loaded && failed.length > 0 && !allFailed && <p className="character-message confirm-list__notice" role="status">
        {failed.map(item => confirmKindLabel[item]).join(" · ")} 목록을 읽지 못했습니다. <Button size="sm" onClick={retry}>다시 시도</Button>
      </p>}
      {allFailed
        ? <p className="character-message confirm-list__notice" role="alert">확인 목록을 불러오지 못했습니다. <Button size="sm" onClick={retry}>다시 시도</Button></p>
        : current
          ? <>
            <div className="confirm-list__body">
              <ConfirmImage key={current.key} item={current} privacyMode={privacyMode} />
              <aside className="confirm-list__panel" aria-label="확인 정보">
                <div className="confirm-list__badges">{reasonBadges(current).map(text => <Badge key={text}>{text}</Badge>)}</div>
                <h3 className="confirm-list__character">{current.targetName}?</h3>
                {current.referenceAssetIds.length > 0 && <ul className="confirm-list__references" aria-label={`${current.targetName} 레퍼런스`}>
                  {current.referenceAssetIds.map(id => <li key={id}><AssetImage src={thumbnailUrl(id)} alt="" className={privacyMode ? "character-private" : undefined} loading="lazy" /></li>)}
                </ul>}
                {reasonNote(current) && <p className="confirm-list__note" role="note">{reasonNote(current)}</p>}
                {folder?.key === current.key && folder.state === "outside" && <p className="confirm-list__note" role="note">폴더 밖 · 맞음을 누르면 {current.targetName}의 시리즈로 옮깁니다.</p>}
                {sameImage.length > 0 && <p className="confirm-list__note" role="note">같은 이미지의 다른 캐릭터 후보입니다. 앞에서 {sameImage.map(j => `${j.item.targetName} ${decisionText(j.decision)}`).join(", ")}(으)로 판단했습니다. 이 캐릭터도 그림에 있으면 맞음을 누르세요.</p>}
                <p className="confirm-list__meta">{current.originalName}</p>
                <div className="confirm-list__actions">
                  <Button variant="primary" disabled={busy} onClick={() => void judge("accepted")}>맞음 <kbd>→</kbd><kbd>D</kbd></Button>
                  <Button disabled={busy} onClick={() => void judge("rejected")}>아님 <kbd>←</kbd><kbd>A</kbd></Button>
                  {current.crop && <Button disabled={busy} onClick={() => void judge("accepted_wrong_region")}>맞음 · 위치 틀림 <kbd>W</kbd></Button>}
                  <Button variant="ghost" disabled={busy} onClick={skip}>건너뛰기 <kbd>↓</kbd><kbd>S</kbd></Button>
                </div>
                <p className="confirm-list__meta">아님 = {current.targetName}에서 빼고 다시 넣지 않음</p>
                {last && <Button className="confirm-list__undo" size="sm" variant="ghost" disabled={busy} onClick={() => void undo()}>되돌리기: {last.item.targetName} {decisionText(last.decision)} <kbd>Z</kbd></Button>}
                {decisionError && <p className="character-message" role="alert">{decisionError}</p>}
              </aside>
            </div>
            <ul className="confirm-list__strip" aria-label="다음 이미지">
              {shown.slice(0, REFILL_STRIP).map((item, index) => <li key={item.key}>
                <button type="button" aria-label={`${item.targetName} · ${item.originalName}`} aria-current={index === 0 ? "true" : undefined} disabled={busy} onClick={() => jumpTo(item)}>
                  <AssetImage src={thumbnailUrl(item.assetId)} alt="" className={privacyMode ? "character-private" : undefined} loading="lazy" draggable={false} />
                </button>
              </li>)}
            </ul>
          </>
          : loading && !loaded
            ? null
            : skipped.size > 0 && items.length > 0
              ? <EmptyState title="건너뛴 항목만 남았습니다">
                <Button size="sm" onClick={() => setSkipped(new Set())}>건너뛴 항목 다시 보기</Button>
                {last && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void undo()}>되돌리기: {last.item.targetName} {decisionText(last.decision)} <kbd>Z</kbd></Button>}
              </EmptyState>
              : <EmptyState title="확인할 항목이 없습니다">
                <p className="confirm-list__empty-copy">새 이미지를 분석하면 여기에 나타납니다.</p>
                {last && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void undo()}>되돌리기: {last.item.targetName} {decisionText(last.decision)} <kbd>Z</kbd></Button>}
                {decisionError && <p className="character-message" role="alert">{decisionError}</p>}
                <Button size="sm" onClick={retry}>새로고침</Button>
              </EmptyState>}
    </section>
  </Dialog>;
}

/** Why the image is listed, in plain words: its kind, any other source that brought it up, and 확실/불확실. */
export function reasonBadges(item: ConfirmItem): string[] {
  const badges = [confirmKindLabel[item.kind]];
  if (item.kind === "recheck" && item.recognition && !item.recognition.doubtful) badges.push(confirmKindLabel.recognition);
  if (item.kind !== "tag" && item.tags && item.tags.reason !== "veto") badges.push(confirmKindLabel.tag);
  // 확실/불확실 is how firmly the tags read the name; a doubted placement says why in its note instead.
  if (item.tags && item.tags.reason === "recommendation") badges.push(`자동 태그 ${item.tags.sure ? "확실" : "불확실"}`);
  return badges;
}

function reasonNote(item: ConfirmItem): string | null {
  if (item.kind === "recheck") {
    return item.recognition?.doubtful
      ? `이미 ${item.targetName}(으)로 자동으로 넣은 이미지인데, 학습 인식이 지지하지 않습니다. 틀렸으면 아님을 눌러 주세요.`
      : `이미 ${item.targetName}(으)로 자동으로 넣은 이미지인데, 자동 태그가 이 이름을 읽지 않았습니다. 틀렸으면 아님을 눌러 주세요.`;
  }
  if (item.recognition?.placed) return `기본 인식이 이미 ${item.targetName}(으)로 넣은 이미지입니다. 다른 추천을 다 본 뒤에 나오며, 틀렸으면 아님을 눌러 주세요.`;
  return null;
}

/** Thumbnail first, original once it has loaded; a failed original keeps the thumbnail. The person box rides on the image. */
function ConfirmImage({ item, privacyMode }: { item: ConfirmItem; privacyMode: boolean }) {
  const [original, setOriginal] = useState<"loading" | "ready" | "failed">("loading");
  const alt = `${item.originalName} — ${item.targetName} 후보`;
  const ratio = item.width > 0 && item.height > 0 ? item.width / item.height : 1;
  const box = item.crop?.box;
  const privateClass = privacyMode ? " character-private" : "";
  return <figure className="confirm-list__figure">
    <div className="confirm-list__frame" style={{ aspectRatio: ratio, "--confirm-ratio": ratio } as CSSProperties}>
      {original !== "ready" && <AssetImage className={`confirm-list__image${privateClass}`} src={thumbnailUrl(item.assetId)} alt={alt} draggable={false} />}
      {original !== "failed" && <AssetImage className={`confirm-list__image${original === "ready" ? "" : " confirm-list__image--pending"}${privateClass}`}
        src={assetUrl(item.assetId)} alt={original === "ready" ? alt : ""} draggable={false}
        onLoad={() => setOriginal("ready")} onError={() => setOriginal("failed")} />}
      {box && !privacyMode && <span className="confirm-list__crop" role="img" aria-label={`${item.targetName} 감지 영역`} style={{
        left: `${box[0] * 100}%`, top: `${box[1] * 100}%`, width: `${(box[2] - box[0]) * 100}%`, height: `${(box[3] - box[1]) * 100}%`,
      }} />}
    </div>
    {original === "failed" && <figcaption className="confirm-list__image-note" role="status">원본을 불러오지 못해 축소 이미지를 표시합니다.</figcaption>}
  </figure>;
}
