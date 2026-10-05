import { BusyLabel } from "../shared/ui/BusyLabel";
import { AssetImage } from "../privacy/AssetImage";
import { ArrowLeftIcon, ChevronRightIcon, UserIcon } from "@heroicons/react/24/outline";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { assetUrl, assetThumbnailUrl } from "../assets/mediaUrl";
import { ViewToolbar } from "../layout/ViewToolbar";
import { commandErrorMessage } from "../library/errorMessage";
import type { ClassificationEntry } from "../library/types";
import { useBackHandler } from "../shared/navigation/BackNavigation";
import { Button } from "../shared/ui/Button";
import type { CharacterTarget, DecisionKind, DecisionRequest } from "./api";
import {
  classificationIsInSeries,
  taggerCounts,
  taggerDecisionApi,
  taggerItemKey,
  type TaggerDecisionApi,
  type TaggerReviewItem,
} from "./taggerReviewClient";
import "../home/characterReview.css";
import "./TaggerReview.css";

type Props = {
  items: readonly TaggerReviewItem[];
  targets: readonly CharacterTarget[];
  classifications: readonly ClassificationEntry[];
  privacyMode: boolean;
  onBack: () => void;
  onItemsChange?: (items: TaggerReviewItem[]) => void;
  api?: TaggerDecisionApi;
};

type Membership = "loading" | "inside" | "outside" | "error";
type BulkDecision = Extract<DecisionKind, "accepted" | "rejected">;
type Group = {
  seriesId: string;
  seriesName: string;
  items: TaggerReviewItem[];
  characters: { targetId: string; targetName: string; items: TaggerReviewItem[]; thumbnailAssetId: string | null }[];
};

const TILE_SIZE_KEY = "lakomics.taggerReview.tileSize";
const ALL = "\u0000all";
const manualRequest = (item: TaggerReviewItem, assetIds: string[], decision: BulkDecision): DecisionRequest => ({
  targetId: item.targetId,
  expectedFingerprint: item.targetFingerprint,
  assetIds,
  decision,
  baselineFingerprint: null,
  scanId: null,
});

function groupItems(items: readonly TaggerReviewItem[], targets: readonly CharacterTarget[], classifications: readonly ClassificationEntry[]): Group[] {
  const names = new Map(classifications.map((entry) => [entry.id, entry.name]));
  const targetById = new Map(targets.map((target) => [target.id, target]));
  const grouped = new Map<string, TaggerReviewItem[]>();
  for (const item of items) grouped.set(item.seriesId, [...(grouped.get(item.seriesId) ?? []), item]);
  return [...grouped].map(([seriesId, seriesItems]) => {
    const characters = new Map<string, TaggerReviewItem[]>();
    for (const item of seriesItems) characters.set(item.targetId, [...(characters.get(item.targetId) ?? []), item]);
    return {
      seriesId,
      seriesName: names.get(seriesId) ?? "시리즈 없음",
      items: seriesItems,
      characters: [...characters].map(([targetId, characterItems]) => ({
        targetId,
        targetName: characterItems[0].targetName,
        items: characterItems,
        thumbnailAssetId: targetById.get(targetId)?.thumbnailAssetId ?? targetById.get(targetId)?.references.find((reference) => reference.status === "ready")?.assetId ?? null,
      })).sort((left, right) => left.targetName.localeCompare(right.targetName, "ko")),
    };
  }).sort((left, right) => left.seriesName.localeCompare(right.seriesName, "ko"));
}

function Split({ items }: { items: readonly TaggerReviewItem[] }) {
  const counts = taggerCounts(items);
  return <span className="crv-split">
    {counts.recommendation > 0 && <span>태거 추천 <span className="numeric">{counts.recommendation.toLocaleString()}</span></span>}
    {counts.recommendation > 0 && counts.veto > 0 && <span aria-hidden="true"> · </span>}
    {counts.veto > 0 && <span>검토로 돌림 <span className="numeric">{counts.veto.toLocaleString()}</span></span>}
  </span>;
}

export function TaggerReview({ items, targets, classifications, privacyMode, onBack, onItemsChange, api = taggerDecisionApi }: Props) {
  const [remaining, setRemaining] = useState(() => [...items]);
  const [selectedSeries, setSelectedSeries] = useState(ALL);
  const [selectedTarget, setSelectedTarget] = useState<string | null>(null);
  const [membership, setMembership] = useState<Map<string, Membership>>(new Map());
  const [bulkDecision, setBulkDecision] = useState<BulkDecision | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [tileSize, setTileSize] = useState<"small" | "large">(() => {
    try { return localStorage.getItem(TILE_SIZE_KEY) === "small" ? "small" : "large"; } catch { return "large"; }
  });
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const previewRef = useRef<HTMLElement>(null);
  const restoreTileFocus = useRef<string | null>(null);
  const selectionAnchor = useRef<string | null>(null);
  const decisionPending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tileRefs = useRef(new Map<string, HTMLElement>());
  const remainingRef = useRef(remaining);
  remainingRef.current = remaining;

  useEffect(() => {
    const next = [...items];
    remainingRef.current = next;
    setRemaining(next);
  }, [items]);
  const groups = useMemo(() => groupItems(remaining, targets, classifications), [remaining, targets, classifications]);
  const currentGroup = groups.find((group) => group.seriesId === selectedSeries);
  const shownGroups = currentGroup ? [currentGroup] : groups;
  const character = groups.flatMap((group) => group.characters.map((entry) => ({ ...entry, group }))).find((entry) => entry.targetId === selectedTarget) ?? null;
  const total = remaining.length;
  const previewItem = character?.items.find((item) => taggerItemKey(item) === previewKey);

  useEffect(() => {
    try { localStorage.setItem(TILE_SIZE_KEY, tileSize); } catch { /* Storage can be disabled. */ }
  }, [tileSize]);
  useEffect(() => { if (previewItem) previewRef.current?.focus(); }, [previewItem?.asset.id]);
  useEffect(() => { setPreviewKey(null); selectionAnchor.current = null; }, [selectedTarget]);

  useEffect(() => {
    if (!previewKey && restoreTileFocus.current) {
      tileRefs.current.get(restoreTileFocus.current)?.focus();
      restoreTileFocus.current = null;
    }
  }, [previewKey]);

  function closePreview() {
    restoreTileFocus.current = previewKey;
    setPreviewKey(null);
  }
  function movePreview(direction: number) {
    if (!character || !previewItem || busy) return;
    const index = character.items.indexOf(previewItem);
    const next = character.items[Math.max(0, Math.min(character.items.length - 1, index + direction))];
    setPreviewKey(taggerItemKey(next));
  }

  const goBack = () => {
    if (previewItem) { closePreview(); return; }
    if (selectedTarget) {
      setSelectedTarget(null); setBulkDecision(null); setChecked(new Set()); setError(null);
    } else onBack();
  };
  useBackHandler(goBack, 50);

  useEffect(() => {
    if (!character) { setMembership(new Map()); return; }
    let live = true;
    const initial = new Map(character.items.map((item) => [item.asset.id, "loading" as Membership]));
    setMembership(initial);
    for (const item of character.items) {
      void api.classifications(item.asset.id).then((ids) => {
        if (!live) return;
        setMembership((current) => new Map(current).set(item.asset.id, classificationIsInSeries(ids, item.seriesId, classifications) ? "inside" : "outside"));
      }, () => {
        if (!live) return;
        setMembership((current) => new Map(current).set(item.asset.id, "error"));
      });
    }
    return () => { live = false; };
  }, [api, character?.targetId, classifications]);

  function remove(keys: Set<string>) {
    const next = remainingRef.current.filter((item) => !keys.has(taggerItemKey(item)));
    remainingRef.current = next;
    setRemaining(next); onItemsChange?.(next);
    setChecked((current) => new Set([...current].filter((key) => !keys.has(key))));
    if (selectedTarget && !next.some((item) => item.targetId === selectedTarget)) {
      setSelectedTarget(null); setBulkDecision(null); setChecked(new Set());
    }
  }

  async function decideOne(item: TaggerReviewItem, decision: BulkDecision) {
    if (decisionPending.current) return;
    const state = membership.get(item.asset.id);
    if (decision === "accepted" && state !== "inside" && state !== "outside") return;
    decisionPending.current = true;
    setBusy(true); setError(null);
    try {
      if (decision === "accepted" && state === "outside") await api.move(item.targetId, item.targetFingerprint, [item.asset.id]);
      else await api.decide(manualRequest(item, [item.asset.id], decision));
      if (previewKey === taggerItemKey(item) && character) {
        const index = character.items.indexOf(item);
        const next = character.items[index + 1] ?? character.items[index - 1];
        setPreviewKey((current) => current === taggerItemKey(item) ? (next ? taggerItemKey(next) : null) : current);
      }
      remove(new Set([taggerItemKey(item)]));
    } catch (reason) {
      setError(commandErrorMessage(reason, "판단을 저장하지 못했습니다."));
    } finally {
      decisionPending.current = false;
      setBusy(false);
    }
  }

  function startBulk(decision: BulkDecision) {
    if (!character || busy) return;
    selectionAnchor.current = null;
    setBulkDecision(decision);
    setChecked(new Set(character.items.map(taggerItemKey)));
    setError(null);
  }

  function toggle(item: TaggerReviewItem, range = false) {
    if (!character || !bulkDecision || busy) return;
    const key = taggerItemKey(item);
    const keys = character.items.map(taggerItemKey);
    const anchor = selectionAnchor.current ? keys.indexOf(selectionAnchor.current) : -1;
    const end = keys.indexOf(key);
    const affected = range && anchor >= 0 ? keys.slice(Math.min(anchor, end), Math.max(anchor, end) + 1) : [key];
    setChecked((current) => {
      const next = new Set(current);
      const select = !current.has(key);
      for (const entry of affected) { if (select) next.add(entry); else next.delete(entry); }
      return next;
    });
    selectionAnchor.current = key;
  }

  async function confirmBulk() {
    if (!character || !bulkDecision || busy || checked.size === 0) return;
    const chosen = character.items.filter((item) => checked.has(taggerItemKey(item)));
    const unresolved = bulkDecision === "accepted" && chosen.some((item) => !["inside", "outside"].includes(membership.get(item.asset.id) ?? ""));
    if (unresolved) return;
    setBusy(true); setError(null);
    try {
      const inside = chosen.filter((item) => bulkDecision === "rejected" || membership.get(item.asset.id) === "inside");
      if (inside.length > 0) {
        await api.decideBatch([manualRequest(inside[0], inside.map((item) => item.asset.id), bulkDecision)]);
        remove(new Set(inside.map(taggerItemKey)));
      }
      const outside = chosen.filter((item) => bulkDecision === "accepted" && membership.get(item.asset.id) === "outside");
      if (outside.length > 0) {
        await api.move(outside[0].targetId, outside[0].targetFingerprint, outside.map((item) => item.asset.id));
        remove(new Set(outside.map(taggerItemKey)));
      }
      setBulkDecision(null); setChecked(new Set());
    } catch (reason) {
      setError(commandErrorMessage(reason, "선택한 판단을 저장하지 못했습니다."));
    } finally {
      setBusy(false);
    }
  }

  function moveFocus(event: KeyboardEvent<HTMLElement>, item: TaggerReviewItem) {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    const tiles = character?.items.map((entry) => tileRefs.current.get(taggerItemKey(entry))).filter((tile): tile is HTMLElement => Boolean(tile)) ?? [];
    const current = tileRefs.current.get(taggerItemKey(item));
    if (!current || tiles.length < 2) return;
    event.preventDefault();
    const index = tiles.indexOf(current);
    let next = event.key === "ArrowLeft" || event.key === "ArrowUp" ? index - 1 : index + 1;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const origin = current.getBoundingClientRect();
      const direction = event.key === "ArrowUp" ? -1 : 1;
      const candidates = tiles.map((tile, candidateIndex) => ({ tile, candidateIndex, rect: tile.getBoundingClientRect() }))
        .filter(({ rect }) => direction < 0 ? rect.top < origin.top : rect.top > origin.top)
        .sort((left, right) => Math.abs(left.rect.top - origin.top) - Math.abs(right.rect.top - origin.top)
          || Math.abs(left.rect.left - origin.left) - Math.abs(right.rect.left - origin.left));
      if (candidates[0]) next = candidates[0].candidateIndex;
    }
    tiles[Math.max(0, Math.min(tiles.length - 1, next))]?.focus();
  }

  const index = <nav className="crv-index" aria-label="태거 검토 시리즈">
    {groups.length > 0 && <>
      <h2 className="workspace-section-label">시리즈</h2>
      <IndexRow label="전체" count={total} current={!currentGroup} onClick={() => { setSelectedSeries(ALL); setSelectedTarget(null); }} />
      {groups.map((group) => <IndexRow key={group.seriesId} label={group.seriesName} count={group.items.length} current={currentGroup === group}
        onClick={() => { setSelectedSeries(group.seriesId); setSelectedTarget(null); }} />)}
    </>}
  </nav>;

  if (character) {
    const selectedItems = character.items.filter((item) => checked.has(taggerItemKey(item)));
    const acceptingUnresolved = bulkDecision === "accepted" && selectedItems.some((item) => !["inside", "outside"].includes(membership.get(item.asset.id) ?? ""));
    return <div className="crv-view tagger-review" onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); goBack(); }
    }}>
      <ViewToolbar title={`${character.group.seriesName} › ${character.targetName}`}
        leadingAction={<Button size="icon" variant="ghost" aria-label="태거 검토 목록으로 돌아가기" onClick={goBack}><ArrowLeftIcon aria-hidden="true" /></Button>}
        titleAccessory={<span className="tagger-review__title-count numeric">{character.items.length.toLocaleString()}건</span>}
        chrome={{ navigation: index }} />
      <div className="tagger-review__detail">
        {previewItem ? <section className="tagger-review__preview" role="region" aria-label="이미지 미리보기" tabIndex={-1} ref={previewRef}
          onKeyDown={(event) => {
            if (event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
            const key = event.key.toLowerCase();
            if (!["arrowleft", "arrowright", "a", "x", "escape"].includes(key)) return;
            event.preventDefault(); event.stopPropagation();
            if (key === "escape") closePreview();
            else if (key === "arrowleft") movePreview(-1);
            else if (key === "arrowright") movePreview(1);
            else void decideOne(previewItem, key === "a" ? "accepted" : "rejected");
          }}>
          <div className="tagger-review__preview-toolbar">
            <Button size="sm" disabled={busy || character.items[0] === previewItem} aria-label="이전 이미지" onClick={() => movePreview(-1)}>←</Button>
            <span>{previewItem.asset.originalName} · {character.items.indexOf(previewItem) + 1}/{character.items.length}</span>
            <Button size="sm" disabled={busy || character.items[character.items.length - 1] === previewItem} aria-label="다음 이미지" onClick={() => movePreview(1)}>→</Button>
            <Button size="sm" onClick={closePreview}>닫기 (Esc)</Button>
          </div>
          <ReviewImage key={previewItem.asset.id} item={previewItem} privacyMode={privacyMode} large />
          <Scores item={previewItem} />
          {membership.get(previewItem.asset.id) === "outside" && <p className="tagger-review__notice">폴더 밖 · 확정하면 캐릭터 폴더로 이동합니다.</p>}
          {["loading", "error"].includes(membership.get(previewItem.asset.id) ?? "loading") && <p role="status" className="tagger-review__notice">폴더 위치를 확인할 수 있을 때 확정할 수 있습니다.</p>}
          <div className="tagger-review__preview-toolbar">
            <Button disabled={busy || !["inside", "outside"].includes(membership.get(previewItem.asset.id) ?? "")} onClick={() => void decideOne(previewItem, "accepted")}>확정 (A)</Button>
            <Button disabled={busy} onClick={() => void decideOne(previewItem, "rejected")}>거부 (X)</Button>
          </div>
          {error && <p className="tagger-review__notice is-error" role="alert">{error}</p>}
        </section> : <>

        <div className="tagger-review__bulk">
          <div role="group" aria-label="이미지 크기">
            <Button size="sm" aria-pressed={tileSize === "small"} onClick={() => setTileSize("small")}>작게</Button>
            <Button size="sm" aria-pressed={tileSize === "large"} onClick={() => setTileSize("large")}>크게</Button>
          </div>
          <Button size="sm" variant={bulkDecision === "accepted" ? "primary" : "secondary"} disabled={busy} onClick={() => startBulk("accepted")}>모두 맞음</Button>
          <Button size="sm" variant={bulkDecision === "rejected" ? "primary" : "secondary"} disabled={busy} onClick={() => startBulk("rejected")}>모두 아님</Button>
          {bulkDecision && <>
            <Button size="sm" disabled={busy} onClick={() => { setChecked(new Set(character.items.map(taggerItemKey))); selectionAnchor.current = null; }}>전부 선택</Button>
            <Button size="sm" disabled={busy} onClick={() => { setChecked(new Set()); selectionAnchor.current = null; }}>선택 해제</Button>
            <span><b className="numeric">{checked.size.toLocaleString()}</b>건 선택 · 이미지에서 제외할 항목을 체크 해제하세요.</span>
            <Button size="sm" variant="primary" disabled={busy || checked.size === 0 || acceptingUnresolved} onClick={() => void confirmBulk()}>
              <BusyLabel busy={!!(busy)} idle={`${checked.size.toLocaleString()}건 ${bulkDecision === "accepted" ? "맞음" : "아님"} 저장`}>저장 중…</BusyLabel>
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setBulkDecision(null); setChecked(new Set()); }}>취소</Button>
          </>}
        </div>
        {acceptingUnresolved && <p className="tagger-review__notice" role="status">폴더 위치를 확인하는 동안 맞음 저장을 기다려 주세요.</p>}
        {error && <p className="tagger-review__notice is-error" role="alert">{error}</p>}
        <div className={`tagger-review__grid tagger-review__grid--${tileSize}`} role="grid" aria-label={`${character.targetName} 태거 후보`}>
          {character.items.map((item) => {
            const key = taggerItemKey(item);
            const state = membership.get(item.asset.id) ?? "loading";
            const isChecked = checked.has(key);
            const acceptDisabled = busy || state === "loading" || state === "error";
            return <article key={key} role="gridcell" tabIndex={0} aria-selected={bulkDecision ? isChecked : undefined}
              ref={(node) => { if (node) tileRefs.current.set(key, node); else tileRefs.current.delete(key); }}
              className={`tagger-review__tile${bulkDecision && isChecked ? " is-selected" : ""}`}
              onClick={(event) => {
                if ((event.target as HTMLElement).closest("button, input, label")) return;
                if (bulkDecision) toggle(item, event.shiftKey); else setPreviewKey(key);
              }}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                moveFocus(event, item);
                if ((event.key === "Enter" || event.key === " ") && event.target === event.currentTarget) { event.preventDefault(); if (bulkDecision) toggle(item, event.shiftKey); else setPreviewKey(key); }
              }}>
              <div className="tagger-review__image">
                <ReviewImage item={item} privacyMode={privacyMode} />
                <span className={`tagger-review__badge tagger-review__badge--${item.evidence.reason}`}>{item.evidence.reason === "recommendation" ? "태거 추천" : "검토로 돌림"}</span>
                {state === "outside" && <span className="tagger-review__outside">폴더 밖</span>}
                {bulkDecision && <label className="tagger-review__check"><input type="checkbox" checked={isChecked} disabled={busy}
                  aria-label={`${item.asset.originalName} 선택`} onClick={(event) => { event.stopPropagation(); toggle(item, event.shiftKey); }} onChange={() => {}} /><span aria-hidden="true" /></label>}
              </div>
              <Scores item={item} />
              {state === "error" && <small className="tagger-review__folder-error">폴더 위치를 확인하지 못해 맞음을 사용할 수 없습니다.</small>}
              <div className="tagger-review__actions">
                <Button size="sm" variant="primary" disabled={acceptDisabled} aria-label={`${item.asset.originalName} 맞음`} onClick={() => void decideOne(item, "accepted")}>맞음</Button>
                <Button size="sm" disabled={busy} aria-label={`${item.asset.originalName} 아님`} onClick={() => void decideOne(item, "rejected")}>아님</Button>
              </div>
            </article>;
          })}
        </div>
        </>}
      </div>
    </div>;
  }

  return <div className="crv-view tagger-review" onKeyDown={(event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onBack(); }
  }}>
    <ViewToolbar title="태거 검토" leadingAction={<Button size="icon" variant="ghost" aria-label="홈으로 돌아가기" onClick={onBack}><ArrowLeftIcon aria-hidden="true" /></Button>} chrome={{ navigation: index }} />
    <div className="crv-scroll"><div className="crv-page">
      {groups.length === 0 ? <div className="crv-notice" role="status"><p>확인할 태거 후보가 없습니다.</p></div> : <>
        <div className="crv-summary">
          <span className="crv-count crv-count--lg numeric">{total.toLocaleString()}<small>건</small></span>
          <span className="crv-summary__t">{groups.length.toLocaleString()}개 시리즈 · {groups.reduce((sum, group) => sum + group.characters.length, 0).toLocaleString()}명 <Split items={remaining} /></span>
        </div>
        <div className="crv-groups">
          {shownGroups.map((group) => <section key={group.seriesId} className="crv-group" aria-label={group.seriesName}>
            <header className="crv-group__head"><h3>{group.seriesName}</h3><span className="crv-count numeric">{group.items.length.toLocaleString()}<small>건</small></span><Split items={group.items} /></header>
            <div className="crv-characters">
              {group.characters.map((entry) => <button key={entry.targetId} type="button" className="crv-character"
                aria-label={`${group.seriesName} › ${entry.targetName} 태거 검토 ${entry.items.length}건`}
                onClick={() => { setSelectedSeries(group.seriesId); setSelectedTarget(entry.targetId); setBulkDecision(null); setChecked(new Set()); }}>
                <span className="crv-portrait" aria-hidden="true">{entry.thumbnailAssetId && !privacyMode
                  ? <AssetImage src={assetThumbnailUrl({ id: entry.thumbnailAssetId })} alt="" loading="lazy" decoding="async" /> : <UserIcon />}</span>
                <span className="crv-character__t"><b>{entry.targetName}</b><Split items={entry.items} /></span>
                <span className="crv-count numeric">{entry.items.length.toLocaleString()}<small>건</small></span>
                <ChevronRightIcon className="crv-chevron" aria-hidden="true" />
              </button>)}
            </div>
          </section>)}
        </div>
      </>}
    </div></div>
  </div>;
}

function IndexRow({ label, count, current, onClick }: { label: string; count: number; current: boolean; onClick: () => void }) {
  return <button type="button" className="workspace-index-link crv-index__row" aria-current={current ? "page" : undefined} onClick={onClick}>
    <span className="crv-index__label">{label}</span><span className="crv-index__count numeric">{count.toLocaleString()}</span>
  </button>;
}

function Scores({ item }: { item: TaggerReviewItem }) {
  return <div className="tagger-review__meta">
    <span>PixAI <b className="numeric">{item.evidence.pixaiScore.toFixed(2)}</b></span>
    <span>Canary <b className="numeric">{item.evidence.canaryScore.toFixed(2)}</b></span>
    {item.crop && <span>B36 <b className="numeric">{item.crop.distance.toFixed(3)}</b></span>}
  </div>;
}

function ReviewImage({ item, privacyMode, large = false }: { item: TaggerReviewItem; privacyMode: boolean; large?: boolean }) {
  const ratio = item.asset.width > 0 && item.asset.height > 0 ? item.asset.width / item.asset.height : 1;
  const box = item.crop?.box;
  return <div className={`tagger-review__media${large ? " tagger-review__media--large" : ""}`}>
    {!privacyMode && <div className="tagger-review__frame" style={large
      ? { aspectRatio: ratio, width: `min(100%, ${65 * ratio}vh)` }
      : { width: `${Math.min(1, ratio) * 100}%`, height: `${Math.min(1, 1 / ratio) * 100}%` }}>
      <AssetImage asset={item.asset} src={large ? assetUrl(item.asset.id) : assetThumbnailUrl(item.asset)} alt={`${item.asset.originalName} — ${item.targetName} 후보`} loading={large ? "eager" : "lazy"} decoding="async" />
      {box && <span className="tagger-review__crop" aria-label={`${item.targetName} 감지 영역`} role="img" style={{
        left: `${box[0] * 100}%`, top: `${box[1] * 100}%`, width: `${(box[2] - box[0]) * 100}%`, height: `${(box[3] - box[1]) * 100}%`,
      }} />}
    </div>}
  </div>;
}
