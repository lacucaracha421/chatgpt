import { BusyLabel } from "../shared/ui/BusyLabel";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { workloadPollDelay, getWorkloadProfile } from "../app/workloadProfile";
import { characterApi, type CharacterTarget } from "../characters/api";
import { READY_EXAMPLES, READY_REVIEWED, enableS36Scoring, s36PublicationApi, type S36PublicationSettings, type S36Readiness } from "../characters/S36Publication";
import { shadowReviewApi, type ShadowBackfillStatus, type ShadowReviewSummary } from "../characters/shadowReviewApi";
import { commandErrorMessage } from "../library/errorMessage";
import { useLibrary } from "../library/LibraryContext";
import type { ClassificationEntry } from "../library/types";
import { Button } from "../shared/ui/Button";
import { SettingsRow } from "../shared/ui/SettingsRow";
import { accuracyRows, recognitionSeries } from "./recognitionStatusModel";

type Data = {
  targets: CharacterTarget[];
  readiness: Map<string, S36Readiness>;
  publication: S36PublicationSettings | null;
  candidates: ShadowReviewSummary | null;
  doubtful: ShadowReviewSummary | null;
  classifications: ClassificationEntry[];
};

async function readStatus(listClassifications: () => Promise<ClassificationEntry[]>): Promise<{ data: Data; problems: string[] }> {
  const problems: string[] = [];
  const settle = async <T,>(label: string, read: () => Promise<T>, empty: T): Promise<T> => {
    try { return await read(); } catch (e) { problems.push(commandErrorMessage(e, `${label}을 읽지 못했습니다.`)); return empty; }
  };
  const [targets, publication, candidates, doubtful, classifications] = await Promise.all([
    settle("캐릭터 목록", () => characterApi.targets(), [] as CharacterTarget[]),
    settle("학습 인식 설정", () => s36PublicationApi.get(), null),
    settle("확인 판단 수", async () => (await shadowReviewApi.page({ offset: 0, limit: 1 })).summary, null),
    settle("다시 확인 판단 수", async () => (await shadowReviewApi.page({ offset: 0, limit: 1, mode: "doubtful" })).summary, null),
    settle("시리즈 이름", listClassifications, [] as ClassificationEntry[]),
  ]);
  const seriesIds = [...new Set(targets.flatMap(target => target.seriesClassificationId && target.role !== "extras" ? [target.seriesClassificationId] : []))];
  const rows = await Promise.all(seriesIds.map(id => settle("캐릭터 판단 수", () => s36PublicationApi.readiness(id), [] as S36Readiness[])));
  const readiness = new Map(rows.flat().map(row => [row.targetId, row]));
  return { data: { targets, readiness, publication, candidates, doubtful, classifications }, problems: [...new Set(problems)] };
}

const percent = (value: number | null) => value === null ? "—" : `${value}%`;

/**
 * 설정 › 고급 › 캐릭터 인식 상태: read-only numbers per character (which recognition is in use, 확인 판단,
 * 맞음 예시, 틀림 / 허용) and the overall accuracy, plus the controls of the 학습 인식 준비 work. The original
 * model names appear only here, in parentheses.
 */
export function CharacterRecognitionStatus({ disabled = false }: { disabled?: boolean }) {
  const { gateway } = useLibrary();
  const [data, setData] = useState<Data | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [reload, setReload] = useState(0);
  const [backfill, setBackfill] = useState<ShadowBackfillStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const wasRunning = useRef(false);

  useEffect(() => {
    let live = true;
    void readStatus(() => gateway.listClassifications()).then(result => { if (live) { setData(result.data); setProblems(result.problems); } });
    return () => { live = false; };
  }, [gateway, reload]);

  const updateBackfill = useCallback((status: ShadowBackfillStatus) => {
    setBackfill(status);
    // The numbers move when the preparation finishes.
    if (wasRunning.current && !status.running) setReload(value => value + 1);
    wasRunning.current = status.running;
  }, []);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        if (getWorkloadProfile().hidden) return;
        const status = await shadowReviewApi.status();
        if (!disposed) updateBackfill(status);
      } catch (e) {
        if (!disposed) setMessage(commandErrorMessage(e, "학습 인식 준비 상태를 불러오지 못했습니다."));
      } finally {
        if (!disposed) timer = setTimeout(() => void poll(), workloadPollDelay(1000));
      }
    }
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [updateBackfill]);

  async function startBackfill() {
    if (starting || backfill?.running) return;
    setStarting(true); setMessage(null);
    wasRunning.current = true;
    try { updateBackfill(await shadowReviewApi.start()); }
    catch (e) { setMessage(commandErrorMessage(e, "기존 이미지 학습 인식 준비를 시작하지 못했습니다.")); }
    finally { setStarting(false); }
  }
  async function cancelBackfill() {
    try { updateBackfill(await shadowReviewApi.cancel()); }
    catch (e) { setMessage(commandErrorMessage(e, "학습 인식 준비를 그만두지 못했습니다.")); }
  }
  async function enableScoring() {
    setMessage(null);
    try { await enableS36Scoring(); setReload(value => value + 1); }
    catch (e) { setMessage(commandErrorMessage(e, "학습 인식 준비를 켜지 못했습니다.")); }
  }

  const seriesName = useMemo(() => {
    const names = new Map((data?.classifications ?? []).map(entry => [entry.id, entry.name]));
    return (id: string) => names.get(id);
  }, [data?.classifications]);
  const series = useMemo(() => data ? recognitionSeries(data.targets, data.readiness, data.publication, seriesName) : [], [data, seriesName]);
  const accuracy = useMemo(() => accuracyRows(data?.candidates ?? null, data?.doubtful ?? null), [data]);
  const scoring = data?.publication?.scoringEnabled;
  const working = Boolean(starting || backfill?.running);

  return <div className="recognition-status">
    <SettingsRow name="자동 태그 (PixAI · canary)" status="새 이미지마다 자동으로 읽습니다" />
    <SettingsRow name="학습 인식 준비 (S36 채점)"
      status={scoring === undefined ? undefined : scoring ? "새 이미지마다 자동으로 준비합니다" : "꺼져 있어 학습 인식 후보가 늘지 않습니다"}
      control={<span className="settings-view__control-pair">
        {scoring === false && <Button size="sm" variant="secondary" disabled={disabled} onClick={() => void enableScoring()}>켜기</Button>}
        <Button size="sm" variant="secondary" disabled={disabled || working} onClick={() => void startBackfill()}>기존 이미지도 준비</Button>
        {backfill?.running && <Button size="sm" variant="ghost" onClick={() => void cancelBackfill()}>그만두기</Button>}
      </span>} />
    {(working || (backfill?.total ?? 0) > 0 || backfill?.cancelled) && <p className="recognition-status__note" role="status">
      <BusyLabel busy={Boolean(starting || backfill?.preparing)} idle={`기존 이미지도 준비 ${backfill?.scored ?? 0} / ${backfill?.total ?? 0} · 건너뜀 ${backfill?.skipped ?? 0}`}>기존 이미지 확인 중…</BusyLabel>
      {backfill?.cancelled && " · 취소됨"}
    </p>}
    {(message || backfill?.error) && <p className="settings-view__row-message" role="alert">{message || backfill?.error}</p>}
    {problems.map(problem => <p key={problem} className="settings-view__row-message" role="alert">{problem}</p>)}

    <table className="settings-view__table recognition-status__table" aria-label="확인 판단 정확도">
      <thead><tr><th scope="col">종류</th><th scope="col">판단</th><th scope="col">맞음</th><th scope="col">비율</th></tr></thead>
      <tbody>{accuracy.map(row => <tr key={row.label}><th scope="row">{row.label}</th><td className="numeric">{row.judged.toLocaleString()}</td><td className="numeric">{row.accepted.toLocaleString()}</td><td className="numeric">{percent(row.percent)}</td></tr>)}</tbody>
    </table>
    <p className="recognition-status__note">오늘까지의 판단입니다. 앞으로의 정확도를 보장하지는 않습니다.</p>

    <p className="recognition-status__note">기본 인식 (B36) · 학습 인식 (S36). 학습 인식으로 넘어가려면 확인 판단 {READY_REVIEWED}건 · 맞음 예시 {READY_EXAMPLES}장이 필요하고, 틀림이 허용치(판단의 5%, 최소 1건) 안이어야 합니다.</p>
    {!data ? <p className="recognition-status__note" role="status"><BusyLabel busy>불러오는 중…</BusyLabel></p>
      : series.length === 0 ? <p className="recognition-status__note">등록한 캐릭터가 없습니다.</p>
        : series.map(group => <details key={group.seriesId} className="recognition-status__series" open={group.learning > 0 || group.rows.some(row => row.judged > 0)}>
          <summary><b>{group.seriesName}</b><span className="numeric">캐릭터 {group.rows.length.toLocaleString()} · 학습 인식 {group.learning.toLocaleString()}</span></summary>
          <table className="settings-view__table recognition-status__table" aria-label={`${group.seriesName} 캐릭터 인식 상태`}>
            <thead><tr><th scope="col">캐릭터</th><th scope="col">인식</th><th scope="col">확인 판단</th><th scope="col">맞음 예시</th><th scope="col">틀림 / 허용</th></tr></thead>
            <tbody>{group.rows.map(row => <tr key={row.targetId}>
              <th scope="row">{row.name}</th>
              <td>{row.recognition}</td>
              <td className="numeric">{row.judged.toLocaleString()} / {READY_REVIEWED}</td>
              <td className="numeric">{row.examples.toLocaleString()} / {READY_EXAMPLES}</td>
              <td className="numeric">{row.judged > 0 ? `${row.wrong.toLocaleString()} / ${row.allowed.toLocaleString()}` : "—"}</td>
            </tr>)}</tbody>
          </table>
        </details>)}
  </div>;
}
