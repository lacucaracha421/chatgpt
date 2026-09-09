import { ArrowPathIcon, PhotoIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClassificationEntry } from "../library/types";
import { AssetGallery } from "../assets/AssetGallery";
import { assetUrl } from "../assets/mediaUrl";
import { applySelectionGesture, emptySelection, moveSelectionFocus, reconcileSelection, selectAllLoaded } from "../assets/selection";
import { Dialog } from "../shared/ui/Dialog";
import { Select } from "../shared/ui/Select";
import { Button } from "../shared/ui/Button";
import { commandErrorMessage } from "../library/errorMessage";
import { thumbnailUrl } from "../assets/mediaUrl";
import { characterApi, isRunning, predictionRequest, type CharacterApi, type CharacterTarget, type Decision, type DecisionKind, type Prediction, type ReviewFilter, type ReviewPage, type ReviewRow, type ScanStatus } from "./api";
import "./CharacterLab.css";

const filters: [ReviewFilter, string][] = [["all", "전체"], ["unmatched", "일치 없음"], ["pending", "분석 필요"], ["rejected", "거절"], ["error", "오류"]];
const stateLabels: Record<string, string> = { pending: "분석 전", recommended: "추천", unmatched: "일치 없음", error: "분석 실패", stale: "다시 분석 필요", accepted: "확정", rejected: "거절", cleared: "판단 해제", running: "분석 중", cancelling: "취소 중", cancelled: "취소됨", completed: "완료", failed: "실패" };

export function CharacterLab({ classifications, initialSeriesId, targetId, refreshVersion = 0, privacyMode = false, onClose, onEdit, api = characterApi }: { classifications: ClassificationEntry[]; initialSeriesId: string | null; targetId: string; refreshVersion?: number; privacyMode?: boolean; onClose: () => void; onEdit?: () => void; api?: CharacterApi }) {
  const seriesId = initialSeriesId ?? "";
  const [targets, setTargets] = useState<CharacterTarget[]>([]);
  const filterTarget = targetId;
  const [filter, setFilter] = useState<ReviewFilter>("recommended");
  const [page, setPage] = useState<ReviewPage>({ rows: [], nextCursor: null });
  const [runs, setRuns] = useState<ScanStatus[]>([]);
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [selection, setSelection] = useState(emptySelection);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [history, setHistory] = useState<Decision[] | null>(null);
  const active = useRef(true);
  const generation = useRef(0);
  const paging = useRef(false);
  const pending = useRef(false);
  const terminal = useRef<string | null>(null);
  const [updatesAvailable, setUpdatesAvailable] = useState(false);
  const pageRef = useRef(page); pageRef.current = page;
  const selectionRef = useRef(selection); selectionRef.current = selection;
  const loadedScope = useRef("");
  const backgroundVersion = useRef(refreshVersion);
  const seriesTargets = targets.filter(t => t.seriesClassificationId === seriesId);
  const target = targets.find(t => t.id === targetId) ?? null;
  const scanning = runs.find(isRunning);
  const selectedRows = page.rows.filter(row => selection.ids.has(row.asset.id));
  const focused = page.rows.find(row => row.asset.id === selection.focusId) ?? selectedRows[0];
  const itemIds = useMemo(() => page.rows.map(row => row.asset.id), [page.rows]);
  const scopeKey = `${seriesId}:${filterTarget}:${filter}`;

  const reloadTargets = useCallback(async () => {
    const next = await api.targets();
    if (active.current) setTargets(next);
    return next;
  }, [api]);
  useEffect(() => {
    active.current = true;
    void Promise.all([reloadTargets(), api.runtime()]).then(([, ready]) => { if (active.current) setRuntimeReady(ready); }).catch(e => { if (active.current) setError(commandErrorMessage(e, "캐릭터 설정을 불러오지 못했습니다.")); });
    let timer: ReturnType<typeof setTimeout>;
    let interval = 5000;
    let polling = false;
    async function poll() {
      if (!active.current || polling) return;
      polling = true;
      clearTimeout(timer);
      try {
        const next = await api.runs();
        if (!active.current) return;
        setRuns(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
        interval = next.some(isRunning) ? 1000 : 5000;
        const stamp = next.filter(s => s.targetId === targetId && !isRunning(s)).map(s => `${s.id}:${s.state}`).join("|");
        if (terminal.current !== null && stamp !== terminal.current) {
          if (selectionRef.current.ids.size) setUpdatesAvailable(true);
          else setRefresh(v => v + 1);
          const finished = next.find(s => s.targetId === targetId && !isRunning(s));
          if (finished) setNotice(finished.state === "completed"
            ? finished.automaticQueued ? `이미지 분석 완료 · ${finished.automaticQueued}장의 자동 분류를 이어갑니다.` : "이미지 분석 완료 · 결과를 확인하세요."
            : finished.state === "cancelled" ? "분석을 취소했습니다." : finished.error ?? "분석을 완료하지 못했습니다.");
        }
        terminal.current = stamp;
      } catch (e) { if (active.current) setError(commandErrorMessage(e, "분석 상태를 불러오지 못했습니다.")); }
      finally { polling = false; }
      if (active.current) timer = setTimeout(() => void poll(), document.visibilityState === "hidden" ? 15000 : interval);
    }
    const onVisible = () => { if (document.visibilityState === "visible") void poll(); };
    document.addEventListener("visibilitychange", onVisible);
    void poll();
    return () => { active.current = false; clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); ++generation.current; };
  }, [api, reloadTargets, targetId]);

  async function load(after: string | null = null, keepCount = 0) {
    if (!seriesId || (after && paging.current)) return;
    const token = after ? generation.current : ++generation.current;
    paging.current = true; setLoading(true);
    try {
      let next = await api.review({ seriesId, targetId: filterTarget || null, filter, after, limit: 60 });
      if (!active.current || token !== generation.current) return;
      const seenCursors = new Set<string>();
      while (!after && next.nextCursor && next.rows.length < keepCount) {
        const cursor = next.nextCursor;
        if (seenCursors.has(cursor)) break;
        seenCursors.add(cursor);
        const more = await api.review({ seriesId, targetId: filterTarget || null, filter, after: cursor, limit: 60 });
        if (!active.current || token !== generation.current) return;
        const known = new Set(next.rows.map(row => row.asset.id));
        next = { ...more, rows: [...next.rows, ...more.rows.filter(row => !known.has(row.asset.id))] };
      }
      setPage(previous => {
        const known = new Set(previous.rows.map(row => row.asset.id));
        return after ? { ...next, rows: [...previous.rows, ...next.rows.filter(row => !known.has(row.asset.id))] } : next;
      });
      if (!after) setSelection(previous => reconcileSelection(previous, next.rows.map(row => row.asset.id)));
    } catch (e) { if (active.current && token === generation.current) setError(commandErrorMessage(e, "검토 결과를 불러오지 못했습니다.")); }
    finally { if (token === generation.current) { paging.current = false; if (active.current) setLoading(false); } }
  }
  useEffect(() => {
    const changedScope = loadedScope.current !== scopeKey;
    loadedScope.current = scopeKey;
    if (changedScope) {
      setPage({ rows: [], nextCursor: null }); setSelection(emptySelection());
    }
    setUpdatesAvailable(false);
    if (seriesId) void load(null, changedScope ? 0 : pageRef.current.rows.length);
  }, [scopeKey, refresh, api]);
  useEffect(() => {
    if (backgroundVersion.current === refreshVersion) return;
    backgroundVersion.current = refreshVersion;
    if (selectionRef.current.ids.size || pending.current || paging.current) setUpdatesAvailable(true);
    else setRefresh(v => v + 1);
  }, [refreshVersion]);
  useEffect(() => { setHistory(null); }, [targetId, seriesId]);

  async function action(work: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null); setNotice(null);
    try { await work(); }
    catch (e) { if (active.current) { setError(commandErrorMessage(e, "설정 또는 원본이 바뀌었습니다. 다시 확인해 주세요.")); setRefresh(v => v + 1); } }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }
  async function scan() {
    if (!target || scanning) return;
    await action(async () => {
      const latest = (await reloadTargets()).find(t => t.id === target.id);
      if (!latest?.ready) throw new Error("기준 이미지 5장을 확인해 주세요.");
      const started = await api.start(latest.id, latest.fingerprint);
      if (active.current) {
        setRuns(old => [...old.filter(s => s.targetId !== latest.id), started]);
        setNotice(isRunning(started) ? "분류를 시작했습니다. 이 창을 닫아도 계속 진행합니다."
          : started.state === "completed" ? started.automaticQueued
            ? `이미지 분석 완료 · ${started.automaticQueued}장의 자동 분류를 이어갑니다.`
            : "이미지 분석 완료 · 결과를 확인하세요."
          : started.error ?? "분석을 완료하지 못했습니다.");
        if (!isRunning(started)) setRefresh(v => v + 1);
      }
    });
  }
  function cancel() {
    if (scanning) void action(async () => { await api.cancel(scanning.id); });
  }
  function close() { onClose(); }
  async function decideRows(rows: ReviewRow[], p: Prediction, decision: DecisionKind) {
    if (rows.length > 200) throw new Error("한 번에 최대 200장을 선택해 주세요.");
    const groups = new Map<string, ReturnType<typeof predictionRequest>>();
    for (const row of rows) {
      const prediction = row.predictions.find(item => item.targetId === p.targetId && item.evidence && ["recommended", "unmatched"].includes(item.state));
      if (!prediction) throw new Error("선택한 이미지에 재분석이 필요한 항목이 있습니다. 분석 후 다시 시도해 주세요.");
      const request = predictionRequest(prediction, [row.asset.id], decision);
      const key = `${request.scanId}:${request.expectedFingerprint}`;
      const group = [...groups.values()].find(group => group.scanId === request.scanId && group.expectedFingerprint === request.expectedFingerprint && group.assetIds.length < 200);
      if (group && group.assetIds.length < 200) group.assetIds.push(row.asset.id);
      else groups.set(`${key}:${groups.size}`, request);
    }
    const requests = [...groups.values()];
    if (requests.length === 1) await api.decide(requests[0]);
    else await api.decideBatch(requests);
    await reloadTargets();
    if (active.current) { setNotice(`${rows.length}장 ${decision === "accepted" ? "확정" : "거절"}`); setRefresh(v => v + 1); }
  }
  const batchPrediction = selectedRows[0]?.predictions.find(p => p.targetId === targetId && p.evidence && ["recommended", "unmatched"].includes(p.state));
  return <Dialog open title={`${target?.displayName ?? "캐릭터"} · 검토`} variant="fullscreen" onClose={close}>
    <div className="character-lab" aria-busy={busy}>
      <aside className="character-lab__index" aria-label="현재 캐릭터 정보">
        <header className="character-lab__identity"><small className="character-lab__series">{classifications.find(c => c.id === seriesId)?.name ?? "시리즈"}</small>
        <h2 data-tauri-drag-region="deep">{target?.displayName ?? "불러오는 중"}</h2>
        {target?.thumbnailAssetId && <img className={`character-lab__portrait${privacyMode ? " character-private" : ""}`} src={thumbnailUrl(target.thumbnailAssetId)} alt={target.displayName} />}
        {target?.description && <p className="series-description">{target.description}</p>}</header>
        <section className="character-lab__references" aria-label="분석 기준"><div className="character-registry__label"><span>기준 이미지</span><small>{target?.references.filter(r => r.status === "ready").length ?? 0}/5</small></div>
        <div className="character-refs">{target?.references.map(r => <span key={r.slot}>{r.assetId && <img className={privacyMode ? "character-private" : ""} src={thumbnailUrl(r.assetId)} alt={`기준 ${r.slot + 1}`} />}</span>)}</div>
        {!target?.ready && <small>기준 이미지와 활성 상태를 확인해 주세요.</small>}</section>
        {onEdit && <Button size="sm" variant="ghost" onClick={onEdit}>캐릭터 정보 수정</Button>}
        <div className="character-lab__runtime"><Button size="sm" variant="ghost" disabled={busy || Boolean(scanning)} onClick={() => void action(async () => { const ready = await api.setup(); if (active.current && ready) { setRuntimeReady(true); setNotice("분석 환경 확인 완료"); } })}>{runtimeReady ? "분석 환경" : "분석 환경 설정"}</Button></div>
      </aside>
      <main className="character-lab__main">
        <div className="character-review-toolbar" data-tauri-drag-region="deep">
          <div className="character-tabs" role="group" aria-label="검토 상태">
            <Button size="sm" variant="ghost" aria-pressed={filter === "recommended" && !history} onClick={() => { setFilter("recommended"); setHistory(null); }}>검토 대기</Button>
            <Button size="sm" variant="ghost" aria-pressed={filter === "confirmed" && !history} onClick={() => { setFilter("confirmed"); setHistory(null); }}>확정</Button>
          </div>
          <Select label="추가 필터" value={filters.some(([v]) => v === filter) ? filter : ""} onChange={e => { if (e.target.value) { setFilter(e.target.value as ReviewFilter); setHistory(null); } }}><option value="">필터</option>{filters.map(([value,label]) => <option key={value} value={value}>{label}</option>)}</Select>
          {filter === "error" && api.retryFailed && <Button size="sm" disabled={busy} onClick={() => void action(async () => {
            const count = await api.retryFailed!(seriesId);
            setNotice(count ? `${count}장의 재시도를 요청했습니다. 일시 정지 중이면 재개해 주세요.` : "이 시리즈에 재시도할 자동 분류 실패 항목이 없습니다.");
            setRefresh(v => v + 1);
          })}>시리즈 실패 항목 재시도 (최대 200장)</Button>}
          <Button size="sm" variant="ghost" disabled={!target} onClick={() => target && void action(async () => { setHistory(await api.history(target.id,null)); })}>이력</Button>
          <div className="character-review-toolbar__actions"><Button size="icon" variant="ghost" aria-label={updatesAvailable ? "새 결과 확인" : "새로고침"} data-tooltip={updatesAvailable ? "새 결과 확인" : "새로고침"} disabled={busy || loading} onClick={() => setRefresh(v => v + 1)}><ArrowPathIcon aria-hidden="true" /></Button>{updatesAvailable && <small role="status">새 결과 있음</small>}<Button size="sm" disabled={!target?.ready || !runtimeReady || busy || Boolean(scanning)} onClick={() => void scan()}>분류 시작</Button>
          {(scanning) && <Button size="sm" disabled={busy} onClick={cancel}>취소</Button>}<Button size="icon" variant="ghost" aria-label="검토 닫기" data-tooltip="검토 닫기" onClick={close}><XMarkIcon aria-hidden="true" /></Button></div>
        </div>
        {scanning && <div className="character-progress" role="status"><span>{scanning.targetId === targetId ? `${scanning.completed} / ${scanning.total}장 비교${scanning.reused ? ` · 이전 결과 ${scanning.reused}장 유지` : ""}` : "자동 판정을 위한 후보 확인 중"}</span><progress max={Math.max(1, scanning.total)} value={scanning.completed} /></div>}
        {!!runs.find(r => r.targetId === targetId)?.errors && <Button size="sm" variant="ghost" className="character-review-errors" onClick={() => { setFilter("error"); setHistory(null); }}>분석 오류 {runs.find(r => r.targetId === targetId)!.errors}장 · 확인</Button>}
        {error && <p className="character-message" role="alert">{error}</p>}{notice && <p className="character-message" role="status">{notice}</p>}
        {history ? <div className="character-history">
          <h3>{target?.displayName} · 판단 이력</h3>
          {history.length === 0 && <p>저장된 판단이 없습니다.</p>}
          {history.map(d => <div key={d.sequence}><>{d.assetId && <img width={64} height={64} src={thumbnailUrl(d.assetId)} className={privacyMode ? "character-private" : ""} alt="판단한 이미지" />}</><span>{new Date(d.createdAt).toLocaleString()} · {stateLabels[d.decision]}{d.origin === "automatic" ? " · 자동 분류" : ""}</span><small>{d.assetId ? "" : "원본 삭제됨"}</small>{d.assetId && target && <Button size="sm" disabled={busy} onClick={() => void action(async () => { await api.decide({ targetId: target.id, expectedFingerprint: target.fingerprint, assetIds: [d.assetId!], decision: "cleared", scanId: null, baselineFingerprint: null }); setHistory(await api.history(target.id, null)); setRefresh(v => v + 1); })}>판단 해제</Button>}</div>)}
          <Button disabled={busy || history.length % 50 !== 0 || history.length === 0} onClick={() => target && void action(async () => { const more = await api.history(target.id, history[history.length - 1]!.sequence); if (active.current) setHistory(old => [...old!, ...more]); })}>이전 이력</Button>
        </div> : <>
          {selection.ids.size > 0 && <div className="character-actions character-selection"><span>{selection.ids.size}장 선택</span><Button size="sm" disabled={busy || !batchPrediction} onClick={() => batchPrediction && void action(() => decideRows(selectedRows, batchPrediction, "accepted"))}>승인</Button><Button size="sm" disabled={busy || !batchPrediction} onClick={() => batchPrediction && void action(() => decideRows(selectedRows, batchPrediction, "rejected"))}>거절</Button><Button size="sm" onClick={() => setSelection(emptySelection())}>선택 해제</Button></div>}
          <div className="character-lab__workspace">
            <div className="character-lab__gallery">{!seriesId ? <p>왼쪽에서 시리즈 폴더를 선택하세요.</p> : !loading && page.rows.length === 0 ? <p>{seriesTargets.length ? "이 조건에 해당하는 이미지가 없습니다." : "캐릭터를 만들고 기준 이미지 5장을 지정하세요."}</p> : <AssetGallery layout="masonry" groupDates={false} scopeKey={scopeKey} items={page.rows.map(row => row.asset)} targetRowHeight={190} selectedAssetIds={selection.ids} focusAssetId={selection.focusId} privacyMode={privacyMode} metadataVisible onSelectionGesture={(asset, gesture) => setSelection(old => applySelectionGesture(old, itemIds, asset.id, gesture))} onSelectAll={() => setSelection(old => selectAllLoaded(old, itemIds))} onClearSelection={() => setSelection(emptySelection())} onMoveFocus={(delta, extend) => setSelection(old => moveSelectionFocus(old, itemIds, delta, extend))} onOpen={asset => setSelection(old => applySelectionGesture(old, itemIds, asset.id, { range: false, toggle: false }))} />}
              <div className="character-actions"><Button size="sm" disabled={loading || page.rows.length === 0} onClick={() => setSelection(old => selectAllLoaded(old, itemIds))}>불러온 이미지 선택</Button>{page.nextCursor && <Button disabled={loading} onClick={() => void load(page.nextCursor)}>더 불러오기</Button>}{loading && <span role="status">불러오는 중…</span>}</div>
            </div>
            <div className="character-evidence-slot">{focused ? <CharacterEvidence key={focused.asset.id} row={focused} privacyMode={privacyMode} busy={busy} onDecide={(p, decision) => void action(() => decideRows([focused], p, decision))} targetId={targetId} /> : <div className="character-evidence-empty"><PhotoIcon aria-hidden="true" /><p>이미지를 선택해 검토하세요</p></div>}</div>
          </div>
        </>}
      </main>
    </div>
  </Dialog>;
}

function CharacterEvidence({ row, targetId, privacyMode, busy, onDecide }: { row: ReviewRow; targetId: string; privacyMode: boolean; busy: boolean; onDecide: (p: Prediction, decision: DecisionKind) => void }) {
  const [original, setOriginal] = useState(false);
  const [size, setSize] = useState({ width: row.asset.width, height: row.asset.height });
  const prediction = row.predictions.find(p => p.targetId === targetId);
  const evidence = prediction?.evidence;
  const box = evidence?.queryBoxes?.[evidence.bestQueryCrop];
  return <aside className="character-evidence" aria-label="선택 이미지 판단">
    <div className="character-evidence__stage"><div className={`character-evidence__image${privacyMode ? " character-private" : ""}`} style={{ width: size.height > 0 ? `min(100%, ${36 * size.width / size.height}vh)` : undefined }}><img src={original ? assetUrl(row.asset.id) : thumbnailUrl(row.asset.id)} decoding="async" width={size.width || undefined} height={size.height || undefined} alt={row.asset.originalName} onLoad={e => { if (original) setSize({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight }); }} />{box && size.width > 0 && size.height > 0 && <svg viewBox={`0 0 ${size.width} ${size.height}`} aria-label="판단에 사용한 영역"><rect x={box[0]} y={box[1]} width={box[2]! - box[0]!} height={box[3]! - box[1]!} vectorEffect="non-scaling-stroke" /></svg>}</div><Button size="sm" variant="ghost" onClick={() => setOriginal(value => !value)}>{original ? "미리보기" : "원본 보기"}</Button></div>
    {prediction && <section><div className="character-evidence__heading"><strong>{prediction.targetName}</strong><span>{stateLabels[prediction.decision ?? prediction.state] ?? prediction.state}</span></div>{prediction.error && <small>{prediction.error}</small>}<div className="character-actions"><Button size="sm" variant="primary" disabled={busy || !evidence} onClick={() => onDecide(prediction, "accepted")}>승인</Button><Button size="sm" variant="ghost" disabled={busy || !evidence} onClick={() => onDecide(prediction, "rejected")}>거절</Button></div></section>}
    {evidence && <details><summary>판단 근거</summary><p>{evidence.evidence?.[evidence.bestQueryCrop]?.matchedReferences.length ?? 0} / {evidence.referenceHashes?.length ?? 5} 기준 일치</p><p>거리 {evidence.distance.toFixed(6)}</p>{Boolean(evidence.learnedReferenceCount) && <p>직접 승인한 이미지 {evidence.learnedReferenceCount}장 포함</p>}{evidence.wholeFallback && <p>유효한 인물 영역이 없어 전체 이미지로 비교했습니다.</p>}</details>}
  </aside>;
}
