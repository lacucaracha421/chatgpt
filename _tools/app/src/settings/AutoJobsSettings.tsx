import { CheckIcon, ChevronDownIcon } from "@heroicons/react/24/outline";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AutoJobId, AutoJobStatus, LibraryGateway, TrashPage, TrashPolicy } from "../library/types";
import { commandErrorMessage } from "../library/errorMessage";
import { formatBytes } from "../assets/assetMetadata";
import { trashThumbnailUrl } from "../assets/mediaUrl";
import { notifyCloudBackfillSupervisor } from "../app/useCloudBackfillSupervisor";
import { updateWorkloadSettings, useWorkloadProfile } from "../app/workloadProfile";
import { displayDateTime } from "../shared/displayDate";
import { BusyLabel } from "../shared/ui/BusyLabel";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import { JobRow } from "../shared/ui/JobRow";
import { Menu } from "../shared/ui/Menu";
import { SectionLabel } from "../shared/ui/SectionLabel";
import { SettingsGroup, SettingsRow, StatusWord } from "../shared/ui/SettingsRow";
import { Skeleton } from "../shared/ui/Skeleton";
import { AssetImage } from "../privacy/AssetImage";
import { Switch } from "../shared/ui/Switch";
import { invalidateAutoTagVocabulary } from "../autotags/autoTagVocabulary";
import { getAutoTagInbox, setAutoTagInbox } from "../autotags/autoTagInbox";
import type { SettingsSection } from "./SettingsView";
import "./auto-jobs.css";

type JobDefinition = { name: string; group: string; cadence: string; action: string; busy: string; result: (n: number) => string };
const count = (n: number) => n.toLocaleString("ko-KR");
const JOBS: Record<AutoJobId, JobDefinition> = {
  catalog: { name: "온라인 카탈로그", group: "새 정보", cadence: "", action: "지금 갱신", busy: "갱신 중…", result: n => `새 작품 ${count(n)}개` },
  releaseCalendar: { name: "발매 캘린더", group: "새 정보", cadence: "매일", action: "지금 갱신", busy: "갱신 중…", result: n => `새 일정 ${count(n)}개` },
  releaseWatch: { name: "찜·신간 발매 확인", group: "새 정보", cadence: "1시간마다", action: "지금 확인", busy: "확인 중…", result: n => `변경 ${count(n)}개` },
  launchbox: { name: "게임 정보 (LaunchBox)", group: "새 정보", cadence: "매주 월요일", action: "지금 갱신", busy: "받는 중…", result: n => `게임 ${count(n)}개` },
  autoTags: { name: "자동 태그 가져오기", group: "분석", cadence: "매일", action: "지금 실행", busy: "태그 만드는 중…", result: n => `이미지 ${count(n)}장` },
  characters: { name: "캐릭터 자동 분류", group: "분석", cadence: "새 이미지가 들어오면", action: "지금 실행", busy: "분류 중…", result: n => `${count(n)}장 분류` },
  similarity: { name: "유사 이미지 준비", group: "분석", cadence: "새 이미지가 들어오면", action: "지금 실행", busy: "준비 중…", result: n => `이미지 ${count(n)}장` },
  videos: { name: "영상 미리보기 준비", group: "준비", cadence: "새 영상이 들어오면", action: "지금 실행", busy: "준비 중…", result: n => `영상 ${count(n)}개` },
  mangaSpines: { name: "만화 책등 스캔 받기", group: "준비", cadence: "새 권이 들어오면", action: "지금 받기", busy: "받는 중…", result: n => `${count(n)}권 받음` },
  cardCutouts: { name: "카드 누끼 만들기", group: "준비", cadence: "새 카드가 들어오면", action: "지금 만들기", busy: "만드는 중…", result: n => `카드 ${count(n)}장` },
  cloudBackfill: { name: "클라우드 복제", group: "준비", cadence: "바뀌면 바로", action: "지금 동기화", busy: "동기화 중…", result: n => `올림 ${count(n)}개` },
  backup: { name: "관리 정보 백업", group: "정리", cadence: "매일", action: "지금 백업", busy: "백업 중…", result: formatBytes },
  trash: { name: "휴지통 자동 비우기", group: "정리", cadence: "매일", action: "만료분 비우기", busy: "비우는 중…", result: n => `${count(n)}개 영구 삭제` },
};
const needsAttention = (job: AutoJobStatus) => job.state === "failed" || job.overdueSince !== null;
function overdueAge(since: string) {
  const hours = Math.max(1, Math.floor((Date.now() - Date.parse(since)) / 3600_000));
  return hours < 24 ? `${count(hours)}시간째` : `${count(Math.floor(hours / 24))}일째`;
}
const GROUPS = ["새 정보", "분석", "준비", "정리"];
const intervalLabel = (seconds: number | null) => seconds == null ? "간격 확인 필요" : `${seconds / 3600}시간마다`;

/** One snapshot poll for Settings; switching sections keeps the last successful snapshot. */
export function useAutoJobs(gateway: LibraryGateway, sectionVisible: boolean, libraryRoot?: string) {
  const [jobs, setJobs] = useState<AutoJobStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  const [completedAt, setCompletedAt] = useState<Partial<Record<AutoJobId, number>>>({});
  const generation = useRef(0);
  const jobsRef = useRef(jobs); jobsRef.current = jobs;
  const receive = useCallback((next: AutoJobStatus[]) => {
    const finished = next.filter(job => job.lastOk && job.lastRunAt && job.state !== "running" && jobsRef.current?.some(before => before.id === job.id && before.lastRunAt !== job.lastRunAt));
    if (finished.length) {
      setCompletedAt(previous => ({ ...previous, ...Object.fromEntries(finished.map(job => [job.id, Date.now()])) }));
      if (finished.some(job => job.id === "autoTags")) invalidateAutoTagVocabulary();
    }
    jobsRef.current = next;
    setJobs(next);
  }, []);
  const running = jobs?.some(job => job.state === "running") ?? false;
  useEffect(() => {
    const changed = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  useEffect(() => {
    if (!gateway.autoJobsStatus || !visible) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const started = generation.current;
      try {
        const next = await gateway.autoJobsStatus!();
        if (active && started === generation.current && next.length) { receive(next); setError(null); }
      } catch (cause) {
        if (active) setError(commandErrorMessage(cause, "자동 작업 상태를 확인하지 못했습니다."));
      } finally {
        if (active) timer = setTimeout(poll, !jobsRef.current || sectionVisible && jobsRef.current.some(job => job.state === "running") ? 2_000 : 15_000);
      }
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [gateway, libraryRoot, sectionVisible, running, revision, receive, visible]);
  const accept = useCallback((next: AutoJobStatus) => {
    generation.current += 1;
    receive(jobsRef.current?.map(job => job.id === next.id ? next : job) ?? [next]);
  }, [receive]);
  return { jobs, error, completedAt, accept, refresh: () => setRevision(value => value + 1) };
}
type AutoJobsModel = ReturnType<typeof useAutoJobs>;

export function AutoJobsSummary({ jobs }: { jobs: AutoJobStatus[] | null }) {
  const failed = jobs?.filter(job => job.state === "failed").length ?? 0;
  const overdue = jobs?.filter(job => job.overdueSince !== null).length ?? 0;
  const running = jobs?.filter(job => job.state === "running").length ?? 0;
  return <>{failed > 0 && <StatusWord tone="danger">실패 {count(failed)}</StatusWord>}{overdue > 0 && <>{failed > 0 && " · "}<StatusWord tone="danger">늦음 {count(overdue)}</StatusWord></>}<BusyLabel busy={running > 0} delay={400}>{(failed > 0 || overdue > 0) && " · "}실행 중 {count(running)}</BusyLabel></>;
}

export function AutoJobsSettings({ gateway, model, onConfigure, privacyMode = false }: {
  gateway: LibraryGateway; model: AutoJobsModel; onConfigure: (section: SettingsSection) => void; privacyMode?: boolean;
}) {
  const workload = useWorkloadProfile();
  const manualTagImport = useRef<{ lastRunAt: string | null } | null>(null);
  const [policy, setPolicy] = useState<TrashPolicy | null>(null);
  const [trash, setTrash] = useState<TrashPage | null>(null);
  const [confirmation, setConfirmation] = useState<{ count: number; run: () => void } | null>(null);
  const confirmCount = confirmation?.count ?? null;
  useEffect(() => {
    let active = true;
    void gateway.getTrashPolicy().then(next => { if (active) setPolicy(next); }).catch(() => undefined);
    void gateway.listTrash({ after: null, limit: 50 }).then(next => { if (active) setTrash(next); }).catch(() => undefined);
    return () => { active = false; };
  }, [gateway]);
  const retention = policy?.retentionDays != null ? `${policy.retentionDays}일 지난 것` : "보존 기간 지난 것";
  const attention = model.jobs?.filter(needsAttention) ?? [];
  const attentionLabel = attention.some(job => job.overdueSince !== null) ? "확인 필요" : "실패";
  const expired = trash?.items.filter(item => item.purgeAt && new Date(item.purgeAt).getTime() <= Date.now()).slice(0, 2) ?? [];
  const renderJob = (job: AutoJobStatus) => <AutoJob key={job.id} job={job} manualImport={manualTagImport} completedAt={model.completedAt[job.id]} gateway={gateway} accept={model.accept} refresh={model.refresh} onConfigure={onConfigure} retention={retention} trashAutoDisabled={policy?.retentionDays === null} onConfirmTrash={run => setConfirmation({ count: job.pending ?? 0, run })} />;
  return <div className="settings-view__section auto-jobs">
    <header className="settings-view__header"><h2>자동 작업</h2></header>
    {workload.lightweight && <div className="auto-jobs__saver"><SettingsRow name="절약 모드" status="무거운 자동 작업 대기" control={<Switch aria-label="절약 모드" checked={workload.lightweight} onChange={event => void updateWorkloadSettings({ lightweight: event.target.checked })} />} />{workload.error && <p role="alert">{workload.error}</p>}</div>}
    {model.error && <p className="settings-view__row-message" role="alert">{model.error} <Button size="sm" variant="quiet" onClick={model.refresh}>다시 시도</Button></p>}
    {!model.jobs && !model.error && <Skeleton className="auto-jobs__skeleton" label="자동 작업 상태" />}
    {model.jobs && <div className="auto-jobs__groups">
      {attention.length > 0 && <section className="settings-view__group auto-jobs__failures" aria-label={attentionLabel}><SectionLabel as="h3" title={attentionLabel} count={attention.length} />{attention.map(renderJob)}</section>}
      {GROUPS.map(group => <SettingsGroup key={group} title={group} help={group === "준비" ? "영상 미리보기, 만화 책등, 카드 누끼와 클라우드 복제는 새 자료가 들어오면 자동으로 준비합니다. 지금 실행하면 대기 중인 자료를 바로 처리합니다." : undefined}>{model.jobs!.filter(job => JOBS[job.id].group === group && !needsAttention(job)).map(renderJob)}</SettingsGroup>)}
    </div>}
    <Dialog open={confirmCount !== null} title={`기간이 지난 ${count(confirmCount ?? 0)}개를 영구 삭제할까요?`} onClose={() => setConfirmation(null)} heading={<span className="auto-job-confirm">{!privacyMode && expired.length > 0 && <span className="auto-job-confirm__thumbs" aria-hidden="true">{expired.map(item => <span key={item.asset.id}><AssetImage asset={item.asset} src={trashThumbnailUrl(item.asset.id)} alt="" /></span>)}</span>}<span>기간이 지난 {count(confirmCount ?? 0)}개를 영구 삭제할까요?</span></span>}>
      <p className="auto-job-confirm__scope">{retention}만{trash && confirmCount !== null && trash.totalCount >= confirmCount && ` · 휴지통의 나머지 ${count(trash.totalCount - confirmCount)}개는 그대로`}</p>
      <div className="ui-dialog__actions"><Button onClick={() => setConfirmation(null)}>취소</Button><Button variant="danger" onClick={() => {
        setConfirmation(null);
        confirmation?.run();
      }}>영구 삭제</Button></div>
    </Dialog>
  </div>;
}

function AutoJob({ job, manualImport, completedAt, gateway, accept, refresh, onConfigure, retention, trashAutoDisabled, onConfirmTrash }: {
  job: AutoJobStatus; gateway: LibraryGateway; accept: AutoJobsModel["accept"]; refresh: () => void;
  manualImport: { current: { lastRunAt: string | null } | null };
  completedAt?: number;
  trashAutoDisabled: boolean;
  onConfigure: (section: SettingsSection) => void; retention: string; onConfirmTrash: (run: () => void) => void;
}) {
  const definition = JOBS[job.id];
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const locked = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);
  const [noFiles, setNoFiles] = useState<{ lastRunAt: string | null } | null>(null);
  useEffect(() => {
    if (job.id !== "autoTags" || busy || job.state === "running" || !manualImport.current) return;
    const before = manualImport.current;
    manualImport.current = null;
    if (job.state !== "failed" && job.lastOk !== false && job.lastRunAt === before.lastRunAt) setNoFiles(before);
  }, [busy, job, manualImport]);
  useEffect(() => {
    const remaining = (completedAt ?? 0) + 1600 - Date.now();
    setCompleted(remaining > 0);
    if (remaining <= 0) return;
    const timer = setTimeout(() => setCompleted(false), remaining);
    return () => clearTimeout(timer);
  }, [completedAt]);
  async function act(action: () => Promise<void>, settings = false) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setSaving(settings); setError(null); setNoFiles(null);
    try { await action(); }
    catch (cause) { setError(commandErrorMessage(cause, "작업을 처리하지 못했습니다.")); }
    finally { locked.current = false; setBusy(false); }
  }
  async function save(enabled: boolean, interval = job.intervalSeconds) {
    await act(async () => {
      if (job.id === "catalog") {
        const next = await gateway.setOnlineCatalogUpdateSettings(enabled, interval ?? 3600);
        accept({ ...job, enabled: next.updateEnabled, intervalSeconds: next.updateIntervalSeconds });
      } else if (job.id === "cloudBackfill") {
        const current = await gateway.getCloudCaptureSettings();
        const next = await gateway.setCloudCaptureSettings(enabled, current.apiBaseUrl, current.captureEnabled ?? current.enabled);
        accept({ ...job, enabled: next.enabled });
        notifyCloudBackfillSupervisor();
      } else if (job.id === "characters") {
        await gateway.setCharacterAutomationEnabled!(enabled);
        accept({ ...job, enabled });
      }
      refresh();
    }, true);
  }
  const running = job.state === "running";
  const unconfigured = job.state === "unconfigured";
  const canConfigure = unconfigured && job.unconfiguredReason !== "noLibraryContent";
  const cadence = job.state === "waiting" ? job.waitingReason === "lightweight" ? "절약 모드" : "다른 작업 대기" : job.enabled === false || job.state === "off" || job.id === "trash" && trashAutoDisabled ? "꺼짐" : definition.cadence;
  const progress = job.progress && job.progress.total > 0 ? job.progress : null;
  const idle = <>{job.overdueSince && <><StatusWord tone="danger">늦음</StatusWord>{` · ${overdueAge(job.overdueSince)} · `}</>}{job.state === "failed" || job.lastOk === false ? <><StatusWord tone="danger">실패</StatusWord>{job.lastError && ` · ${job.lastError}`}{job.lastRunAt && ` · ${displayDateTime(job.lastRunAt)}`}</> : unconfigured ? ({ noServer: "서버 연결 안 됨", noFolder: "가져올 폴더 없음", noProviderKey: "공급원 키 없음", noLibraryContent: "대상 자료 없음" }[job.unconfiguredReason ?? "noLibraryContent"]) : job.state === "waiting" && progress ? `${count(progress.done)} / ${count(progress.total)}에서 멈춤` : <>{job.lastRunAt ? displayDateTime(job.lastRunAt) : "실행 기록 없음"}{job.lastCount !== null && ` · ${job.lastCount === 0 && job.id !== "backup" ? "할 일 없음" : definition.result(job.lastCount)}`}</>}</>;
  const action = running && job.canStop ? "중지" : job.state === "failed" ? "다시 시도" : canConfigure ? job.unconfiguredReason === "noFolder" ? "폴더 선택" : "연결 설정" : definition.action;
  const next = job.id === "trash" ? trashAutoDisabled ? "자동 비우기 안 함" : `${retention}${job.pending == null ? " · 수량 확인 필요" : job.pending > 0 ? ` ${count(job.pending)}개` : " 없음"}` : job.state === "waiting" && progress && job.waitingReason === "lightweight" ? "끄면 이어서" : job.nextRunAt && job.enabled !== false && Date.parse(job.nextRunAt) > Date.now() ? `다음 ${displayDateTime(job.nextRunAt)}` : job.pending !== null ? job.pending > 0 ? `대기 ${count(job.pending)}개` : "대기 없음" : null;
  return <JobRow name={definition.name} state={job.state} completed={completed}
    status={<><span className="auto-job__text"><BusyLabel busy={busy || running} delay={400} idle={idle}>{busy && saving ? "저장 중…" : definition.busy}{!(busy && saving) && progress && ` ${count(progress.done)} / ${count(progress.total)}`}</BusyLabel></span>{progress && <span className="auto-job__bar" role="progressbar" aria-label={`${definition.name} 진행률`} aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}><i style={{ width: `${Math.min(100, progress.done / progress.total * 100)}%` }} /></span>}{completed && <CheckIcon className="auto-job__check" aria-label="완료" />}</>}
    cadence={job.id === "catalog" ? <Menu label="갱신 간격" disabled={busy} triggerClassName="auto-job__interval" trigger={<>{cadence || intervalLabel(job.intervalSeconds)}<ChevronDownIcon aria-hidden="true" /></>} items={[3600, 21600, 86400].map(seconds => ({ id: String(seconds), group: "갱신 간격", label: intervalLabel(seconds), selected: seconds === job.intervalSeconds, onSelect: () => void save(job.enabled ?? false, seconds) }))} /> : cadence}
    next={<>{next}{(job.failed ?? 0) > 0 && <>{next && " · "}<StatusWord tone="danger">실패 {count(job.failed!)}개</StatusWord></>}</>}
    toggle={job.enabled !== null && job.id !== "trash" && <Switch aria-label={job.id === "cloudBackfill" ? "클라우드로 복제" : `${definition.name} 자동 실행`} checked={job.enabled} disabled={busy || unconfigured} onChange={event => void save(event.target.checked)} />}
    action={<Button size="sm" variant="quiet" disabled={busy || !gateway.runAutoJob || running && !job.canStop || unconfigured && !canConfigure || job.id === "trash" && !(job.pending && job.pending > 0)} onClick={() => {
      if (canConfigure) {
        if (job.unconfiguredReason === "noFolder") {
          void act(async () => {
            const folder = await open({ directory: true, multiple: false, title: "매일 자동 가져오기 폴더" });
            if (typeof folder !== "string") return;
            const current = await getAutoTagInbox();
            await setAutoTagInbox(folder, current.applyTaggerReview);
            refresh();
          }, true);
        } else onConfigure("connection");
        return;
      }
      const run = () => void act(async () => {
        const next = await (running && job.canStop ? gateway.stopAutoJob!(job.id) : gateway.runAutoJob!(job.id));
        if (job.id === "autoTags") manualImport.current = { lastRunAt: job.lastRunAt };
        accept(next);
        refresh();
      });
      if (job.id === "trash" && !running) { onConfirmTrash(run); return; }
      run();
    }}>{action}</Button>}>
    {error && <dd className="settings-view__row-message" role="alert">{error}</dd>}
    {noFiles && !running && job.state !== "failed" && job.lastOk !== false && job.lastRunAt === noFiles.lastRunAt && <dd className="settings-view__row-message" role="status">새 파일 없음</dd>}
  </JobRow>;
}
