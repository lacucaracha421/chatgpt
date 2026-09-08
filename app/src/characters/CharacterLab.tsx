import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClassificationEntry } from "../library/types";
import { AssetGallery } from "../assets/AssetGallery";
import { assetUrl } from "../assets/mediaUrl";
import { applySelectionGesture, emptySelection, moveSelectionFocus, selectAllLoaded } from "../assets/selection";
import { Dialog } from "../shared/ui/Dialog";
import { Select } from "../shared/ui/Select";
import { Button } from "../shared/ui/Button";
import { commandErrorMessage } from "../library/errorMessage";
import { CharacterRegistry } from "./CharacterRegistry";
import { characterApi, isRunning, predictionRequest, type CharacterApi, type CharacterTarget, type Decision, type DecisionKind, type Prediction, type ReviewFilter, type ReviewPage, type ReviewRow, type ScanStatus } from "./api";
import "./CharacterLab.css";

const filters: [ReviewFilter, string][] = [["recommended", "추천"], ["unmatched", "미확정"], ["multiple", "다중 후보"], ["confirmed", "확정"], ["pending", "분석 필요"], ["error", "오류"], ["all", "전체"]];
const stateLabels: Record<string, string> = { pending: "분석 전", recommended: "추천", unmatched: "일치 없음", error: "분석 실패", stale: "다시 분석 필요", accepted: "확정", rejected: "거절", cleared: "판단 해제", running: "분석 중", cancelling: "취소 중", cancelled: "취소됨", completed: "완료", failed: "실패" };

export function CharacterLab({ classifications, initialSeriesId, privacyMode = false, onClose, api = characterApi }: { classifications: ClassificationEntry[]; initialSeriesId: string | null; privacyMode?: boolean; onClose: () => void; api?: CharacterApi }) {
  const [seriesId, setSeriesId] = useState(initialSeriesId ?? "");
  const [targets, setTargets] = useState<CharacterTarget[]>([]);
  const [targetId, setTargetId] = useState("");
  const [filterTarget, setFilterTarget] = useState("");
  const [filter, setFilter] = useState<ReviewFilter>("recommended");
  const [page, setPage] = useState<ReviewPage>({ rows: [], nextCursor: null });
  const [runs, setRuns] = useState<ScanStatus[]>([]);
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [batchRunning, setBatchRunning] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [selection, setSelection] = useState(emptySelection);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [history, setHistory] = useState<Decision[] | null>(null);
  const active = useRef(true);
  const generation = useRef(0);
  const paging = useRef(false);
  const pending = useRef(false);
  const queueStop = useRef(false);
  const ownedScan = useRef<string | null>(null);
  const terminal = useRef("");
  const currentSeries = useRef(seriesId); currentSeries.current = seriesId;
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
    async function poll() {
      try {
        const next = await api.runs();
        if (!active.current) return;
        setRuns(next);
        const stamp = next.filter(s => !isRunning(s)).map(s => `${s.id}:${s.state}`).join("|");
        if (stamp !== terminal.current) { terminal.current = stamp; setRefresh(v => v + 1); }
      } catch (e) { if (active.current) setError(commandErrorMessage(e, "분석 상태를 불러오지 못했습니다.")); }
      if (active.current) timer = setTimeout(() => void poll(), 1000);
    }
    void poll();
    return () => { active.current = false; queueStop.current = true; clearTimeout(timer); ++generation.current; };
  }, [api, reloadTargets]);

  async function load(after: string | null = null) {
    if (!seriesId || (after && paging.current)) return;
    const token = after ? generation.current : ++generation.current;
    paging.current = true; setLoading(true);
    try {
      const next = await api.review({ seriesId, targetId: filterTarget || null, filter, after, limit: 60 });
      if (!active.current || token !== generation.current) return;
      setPage(previous => after ? { ...next, rows: [...previous.rows, ...next.rows.filter(row => !previous.rows.some(old => old.asset.id === row.asset.id))] } : next);
    } catch (e) { if (active.current && token === generation.current) setError(commandErrorMessage(e, "검토 결과를 불러오지 못했습니다.")); }
    finally { if (token === generation.current) { paging.current = false; if (active.current) setLoading(false); } }
  }
  useEffect(() => { setPage({ rows: [], nextCursor: null }); setSelection(emptySelection()); if (seriesId) void load(); }, [scopeKey, refresh, api]);
  useEffect(() => { setHistory(null); }, [targetId, seriesId]);

  async function action(work: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null); setNotice(null);
    try { await work(); }
    catch (e) { if (active.current) { setError(commandErrorMessage(e, "설정 또는 원본이 바뀌었습니다. 다시 확인해 주세요.")); setRefresh(v => v + 1); } }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }
  function saved(value: CharacterTarget) {
    if (!active.current || value.seriesClassificationId !== currentSeries.current) return;
    setTargets(old => [...old.filter(t => t.id !== value.id), value]); setTargetId(value.id); setRefresh(v => v + 1);
  }
  async function scan(list: CharacterTarget[]) {
    if (batchRunning || scanning || !list.length) return;
    queueStop.current = false; setBatchRunning(true); setError(null);
    try {
      for (const entry of list) {
        if (queueStop.current || !active.current) break;
        const latest = (await reloadTargets()).find(t => t.id === entry.id);
        if (!latest?.ready) throw new Error(`${entry.displayName}: 기준 이미지 5장을 확인해 주세요.`);
        const started = await api.start(latest.id, latest.fingerprint);
        ownedScan.current = started.id;
        if (!active.current || queueStop.current) { await api.cancel(started.id); break; }
        setRuns(old => [...old.filter(s => s.targetId !== latest.id), started]);
        for (;;) {
          await new Promise(resolve => setTimeout(resolve, 500));
          const states = await api.runs();
          if (active.current) setRuns(states);
          const status = states.find(s => s.id === started.id);
          if (!status) throw new Error("라이브러리 또는 분석 작업이 바뀌었습니다.");
          if (!isRunning(status)) {
            if (status.state === "failed" || status.state === "stale") throw new Error(status.error ?? "분석을 완료하지 못했습니다.");
            break;
          }
          if (!active.current || queueStop.current) { await api.cancel(started.id); break; }
        }
        if (active.current) setRefresh(v => v + 1);
      }
    } catch (e) { if (active.current) setError(commandErrorMessage(e, "캐릭터 분석을 완료하지 못했습니다.")); }
    finally { ownedScan.current = null; if (active.current) setBatchRunning(false); }
  }
  function cancel() {
    queueStop.current = true;
    if (scanning) void action(async () => { await api.cancel(scanning.id); });
  }
  function close() { queueStop.current = true; if (ownedScan.current) void api.cancel(ownedScan.current).catch(() => undefined); onClose(); }
  async function decideRows(rows: ReviewRow[], p: Prediction, decision: DecisionKind) {
    const compatible = rows.every(row => row.predictions.some(item => item.targetId === p.targetId && item.scanId === p.scanId && item.targetFingerprint === p.targetFingerprint && item.evidence && ["recommended", "unmatched"].includes(item.state)));
    if (!compatible) throw new Error("선택한 이미지에 현재 분석 결과가 없는 항목이 있습니다.");
    await api.decide(predictionRequest(p, rows.map(row => row.asset.id), decision));
    if (active.current) { setNotice(`${rows.length}장 ${decision === "accepted" ? "확정" : "거절"}`); setRefresh(v => v + 1); }
  }
  const batchPrediction = selectedRows[0]?.predictions.find(p => p.targetId === targetId && p.evidence && ["recommended", "unmatched"].includes(p.state));
  async function decideAllCandidates(row: ReviewRow, decision: DecisionKind) {
    const candidates=row.predictions.filter(p => p.state === "recommended" && p.evidence && p.decision !== "rejected");
    await api.decideBatch(candidates.map(p => predictionRequest(p,[row.asset.id],decision)));
    if (active.current) { setNotice(decision === "accepted" ? "후보 캐릭터 모두 확정" : "후보 캐릭터 모두 거절"); setRefresh(v => v + 1); }
  }

  return <Dialog open title="캐릭터 검토" variant="fullscreen" onClose={close}>
    <div className="character-lab" aria-busy={busy}>
      <aside className="character-lab__index">
        <Select label="시리즈 폴더" value={seriesId} disabled={busy || batchRunning} onChange={e => { setSeriesId(e.target.value); setTargetId(""); setFilterTarget(""); }}><option value="">폴더 선택</option>{classifications.map(c => <option value={c.id} key={c.id}>{classificationPath(c, classifications)}</option>)}</Select>
        <small>선택한 폴더와 모든 하위 폴더</small>
        <Select label="캐릭터 설정" value={targetId} disabled={!seriesId || busy} onChange={e => setTargetId(e.target.value)}><option value="">새 캐릭터</option>{targets.filter(t => t.seriesClassificationId === seriesId || t.seriesClassificationId === null).map(t => <option key={t.id} value={t.id}>{t.displayName}{t.enabled ? "" : " · 비활성"}{t.seriesClassificationId ? "" : " · 폴더 연결 필요"}</option>)}</Select>
        {seriesId && <CharacterRegistry key={`${seriesId}:${targetId}`} api={api} target={target} seriesId={seriesId} classifications={classifications} privacyMode={privacyMode} onSaved={saved} />}
        <div className="character-lab__runtime"><Button size="sm" disabled={busy || Boolean(scanning)} onClick={() => void action(async () => { const ready = await api.setup(); if (active.current && ready) { setRuntimeReady(true); setNotice("런타임 검증 완료"); } })}>{runtimeReady ? "분석 환경 변경" : "분석 환경 설정"}</Button>{!runtimeReady && <small>Python 실행 파일과 검증된 모델 폴더를 선택해 주세요.</small>}</div>
      </aside>
      <main className="character-lab__main">
        <div className="character-actions">
          <Select label="검토 대상" value={filterTarget} onChange={e => setFilterTarget(e.target.value)}><option value="">모든 캐릭터</option>{seriesTargets.map(t => <option key={t.id} value={t.id}>{t.displayName}</option>)}</Select>
          <Button disabled={!target?.ready || !runtimeReady || busy || batchRunning || Boolean(scanning)} onClick={() => target && void scan([target])}>선택 캐릭터 분석</Button>
          <Button disabled={!runtimeReady || busy || batchRunning || Boolean(scanning) || !seriesTargets.some(t => t.ready)} onClick={() => void scan(seriesTargets.filter(t => t.ready))}>시리즈 분석</Button>
          {(scanning || batchRunning) && <Button disabled={busy} onClick={cancel}>분석 취소</Button>}
          <Button size="sm" onClick={close}>닫기</Button>
        </div>
        {scanning && <div className="character-progress" role="status"><span>{targets.find(t => t.id === scanning.targetId)?.displayName} · {scanning.completed} / {scanning.total} · 새 추론 {scanning.extractions} · 캐시 {scanning.cacheHits} · 오류 {scanning.errors}</span><progress max={Math.max(1, scanning.total)} value={scanning.completed} /></div>}
        {error && <p className="character-message" role="alert">{error}</p>}{notice && <p className="character-message" role="status">{notice}</p>}
        <div className="character-tabs" role="group" aria-label="검토 상태">{filters.map(([value, label]) => <Button size="sm" key={value} aria-pressed={filter === value} onClick={() => { setFilter(value); setHistory(null); }}>{label}</Button>)}<Button size="sm" disabled={!target} onClick={() => target && void action(async () => { const data = await api.history(target.id, null); if (active.current) setHistory(data); })}>판단 이력</Button><Button size="sm" onClick={() => { setRefresh(v => v + 1); void reloadTargets().catch(e => setError(commandErrorMessage(e, "설정을 불러오지 못했습니다."))); }}>새로고침</Button></div>
        {history ? <div className="character-history">
          <h3>{target?.displayName} · 판단 이력</h3>
          {history.length === 0 && <p>저장된 판단이 없습니다.</p>}
          {history.map(d => <div key={d.sequence}><span>{new Date(d.createdAt).toLocaleString()} · {stateLabels[d.decision]}</span><small>{d.sourceAssetId}{d.assetId ? "" : " · 원본 삭제됨"}</small>{d.assetId && target && <Button size="sm" disabled={busy} onClick={() => void action(async () => { await api.decide({ targetId: target.id, expectedFingerprint: target.fingerprint, assetIds: [d.assetId!], decision: "cleared", scanId: null, baselineFingerprint: null }); setHistory(await api.history(target.id, null)); setRefresh(v => v + 1); })}>판단 해제</Button>}</div>)}
          <Button disabled={busy || history.length % 50 !== 0 || history.length === 0} onClick={() => target && void action(async () => { const more = await api.history(target.id, history[history.length - 1]!.sequence); if (active.current) setHistory(old => [...old!, ...more]); })}>이전 이력</Button>
        </div> : <>
          {selection.ids.size > 0 && <div className="character-actions character-selection"><span>{selection.ids.size}장 선택</span><Button size="sm" disabled={busy || !batchPrediction} onClick={() => batchPrediction && void action(() => decideRows(selectedRows, batchPrediction, "accepted"))}>선택 캐릭터로 승인</Button><Button size="sm" disabled={busy || !batchPrediction} onClick={() => batchPrediction && void action(() => decideRows(selectedRows, batchPrediction, "rejected"))}>선택 캐릭터 거절</Button><Button size="sm" disabled={busy || !target?.enabled} onClick={() => target && void action(async () => { await api.decide({ targetId: target.id, expectedFingerprint: target.fingerprint, assetIds: [...selection.ids], decision: "accepted", scanId: null, baselineFingerprint: null }); setNotice(`${selection.ids.size}장 수동 지정`); setRefresh(v => v + 1); })}>선택 캐릭터 수동 지정</Button><Button size="sm" onClick={() => setSelection(emptySelection())}>선택 해제</Button></div>}
          <div className="character-lab__workspace">
            <div className="character-lab__gallery">{!seriesId ? <p>왼쪽에서 시리즈 폴더를 선택하세요.</p> : !loading && page.rows.length === 0 ? <p>{seriesTargets.length ? "이 조건에 해당하는 이미지가 없습니다." : "캐릭터를 만들고 기준 이미지 5장을 지정하세요."}</p> : <AssetGallery layout="masonry" groupDates={false} scopeKey={scopeKey} items={page.rows.map(row => row.asset)} targetRowHeight={190} selectedAssetIds={selection.ids} focusAssetId={selection.focusId} privacyMode={privacyMode} metadataVisible onSelectionGesture={(asset, gesture) => setSelection(old => applySelectionGesture(old, itemIds, asset.id, gesture))} onSelectAll={() => setSelection(old => selectAllLoaded(old, itemIds))} onClearSelection={() => setSelection(emptySelection())} onMoveFocus={(delta, extend) => setSelection(old => moveSelectionFocus(old, itemIds, delta, extend))} onOpen={asset => setSelection(old => applySelectionGesture(old, itemIds, asset.id, { range: false, toggle: false }))} />}
              <div className="character-actions"><Button size="sm" disabled={loading || page.rows.length === 0} onClick={() => setSelection(old => selectAllLoaded(old, itemIds))}>불러온 이미지 선택</Button>{page.nextCursor && <Button disabled={loading} onClick={() => void load(page.nextCursor)}>더 불러오기</Button>}{loading && <span role="status">불러오는 중…</span>}</div>
            </div>
            {focused && <CharacterEvidence key={focused.asset.id} row={focused} privacyMode={privacyMode} busy={busy} onDecide={(p, decision) => void action(() => decideRows([focused], p, decision))} onDecideAll={decision => void action(() => decideAllCandidates(focused, decision))} />}
          </div>
        </>}
      </main>
    </div>
  </Dialog>;
}

function CharacterEvidence({ row, privacyMode, busy, onDecide, onDecideAll }: { row: ReviewRow; privacyMode: boolean; busy: boolean; onDecide: (p: Prediction, decision: DecisionKind) => void; onDecideAll: (decision: DecisionKind) => void }) {
  const [chosen, setChosen] = useState(row.predictions[0]?.targetId ?? "");
  const [size, setSize] = useState({ width: row.asset.width, height: row.asset.height });
  const prediction = row.predictions.find(p => p.targetId === chosen);
  const evidence = prediction?.evidence;
  const box = evidence?.queryBoxes[evidence.bestQueryCrop];
  return <aside className="character-evidence" aria-label="선택 이미지 판단">
    {row.predictions.filter(p => p.state === "recommended" && p.evidence && p.decision !== "rejected").length > 1 && <div className="character-actions"><Button size="sm" disabled={busy} onClick={() => onDecideAll("accepted")}>후보 모두 승인</Button><Button size="sm" disabled={busy} onClick={() => onDecideAll("rejected")}>모두 아님</Button></div>}
    <div className={`character-evidence__image${privacyMode ? " character-private" : ""}`}><img src={assetUrl(row.asset.id)} alt={row.asset.originalName} onLoad={e => setSize({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })} />{box && size.width > 0 && size.height > 0 && <svg viewBox={`0 0 ${size.width} ${size.height}`} aria-label="판단에 사용한 영역"><rect x={box[0]} y={box[1]} width={box[2]! - box[0]!} height={box[3]! - box[1]!} vectorEffect="non-scaling-stroke" /></svg>}</div>
    {row.predictions.map(p => <section key={p.targetId}><Button size="sm" aria-pressed={chosen === p.targetId} onClick={() => setChosen(p.targetId)}>{p.targetName}</Button><span>{stateLabels[p.decision ?? p.state] ?? p.state}</span>{p.error && <small>{p.error}</small>}<div className="character-actions"><Button size="sm" disabled={busy || !p.evidence} onClick={() => onDecide(p, "accepted")}>승인</Button><Button size="sm" disabled={busy || !p.evidence} onClick={() => onDecide(p, "rejected")}>아님</Button></div></section>)}
    {evidence && <details><summary>판단 근거</summary><p>{evidence.evidence?.[evidence.bestQueryCrop]?.matchedReferences.length ?? 0} / 5 기준 일치</p><p>거리 {evidence.distance.toFixed(6)}</p>{evidence.wholeFallback && <p>유효한 인물 영역이 없어 전체 이미지로 비교했습니다.</p>}</details>}
  </aside>;
}

function classificationPath(entry: ClassificationEntry, entries: ClassificationEntry[]) {
  const names = [entry.name], seen = new Set([entry.id]); let parent = entry.parentId;
  while (parent && !seen.has(parent)) { seen.add(parent); const next = entries.find(c => c.id === parent); if (!next) break; names.unshift(next.name); parent = next.parentId; }
  return names.join(" / ");
}
