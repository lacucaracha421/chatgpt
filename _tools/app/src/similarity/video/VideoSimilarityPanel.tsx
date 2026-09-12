import { XMarkIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatBytes } from "../../assets/assetMetadata";
import { thumbnailUrl } from "../../assets/mediaUrl";
import { commandErrorMessage } from "../../library/errorMessage";
import type { AssetSummary } from "../../library/types";
import { ViewToolbar } from "../../layout/ViewToolbar";
import { usePrivacy } from "../../privacy/PrivacyContext";
import { Button } from "../../shared/ui/Button";
import { EmptyState } from "../../shared/ui/EmptyState";
import { Skeleton } from "../../shared/ui/Skeleton";
import { Toast } from "../../shared/ui/Toast";
import { VideoPlayer } from "../../video/VideoPlayer";
import { videoSimilarityApi, type VideoDecision, type VideoReview, type VideoScanProgress, type VideoSimilarityApi } from "./client";
import "./VideoSimilarity.css";

type Props = { assetIds: string[]; onClose(): void; api?: VideoSimilarityApi };
const running = (scan: VideoScanProgress | null) => scan?.state === "queued" || scan?.state === "running";
const resumable = (scan: VideoScanProgress | null) => ["paused", "cancelled", "failed"].includes(scan?.state ?? "");
const stateLabels: Record<string, string> = { queued: "대기", running: "분석 중", paused: "일시 중지", cancelled: "중지됨", failed: "실패", completed: "완료" };
const reasonLabels: Record<string, string> = { interrupted: "앱 종료로 중단됨", cancelled: "사용자가 중지함", timeout: "처리 시간 초과", tool_unavailable: "영상 처리 도구를 찾을 수 없음", source_changed: "원본 파일이 변경됨", processing_failed: "영상 처리 실패", database_failed: "분석 기록 저장 실패", unsupported_geometry: "지원하지 않는 화면 크기", capacity_reached: "분석 저장 한도 도달", insufficient_evidence: "비교할 프레임이 부족함" };

export function VideoSimilarityPanel({ assetIds, onClose, api = videoSimilarityApi }: Props) {
  const [scan, setScan] = useState<VideoScanProgress | null>(null);
  const [review, setReview] = useState<VideoReview | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const generation = useRef(0);
  const pendingRef = useRef(false);
  const scanRef = useRef<VideoScanProgress | null>(null);
  const scanOperation = useRef(0);
  const listOperation = useRef(0);

  const acceptScan = useCallback((next: VideoScanProgress) => {
    scanRef.current = next;
    setScan(next);
  }, []);

  const load = useCallback(async (epoch: number) => {
    const operation = ++listOperation.current;
    const page = await api.list();
    if (generation.current !== epoch || operation !== listOperation.current) return;
    setReview(page.items[0] ?? null);
    setTotal(page.totalCount);
    setLoading(false);
  }, [api]);

  useEffect(() => {
    const epoch = ++generation.current;
    setLoading(true);
    void load(epoch).catch((error: unknown) => {
      if (generation.current !== epoch) return;
      setMessage(commandErrorMessage(error, "영상 검토 목록을 불러오지 못했습니다."));
      setLoading(false);
    });
    const operation = scanOperation.current;
    void api.latest().then((next) => {
      if (next && generation.current === epoch && operation === scanOperation.current) acceptScan(next);
    }).catch((error: unknown) => {
      if (generation.current === epoch && operation === scanOperation.current) setMessage(commandErrorMessage(error, "이전 영상 분석을 불러오지 못했습니다."));
    });
    return () => { generation.current += 1; };
  }, [acceptScan, api, load]);

  useEffect(() => {
    if (!scan || !running(scan)) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const epoch = generation.current;
    async function poll() {
      const operation = scanOperation.current;
      try {
        const next = await api.get(scan!.id);
        if (disposed || epoch !== generation.current) return;
        // A cancel or resume response must not be overwritten by an older poll.
        if (!pendingRef.current && operation === scanOperation.current) {
          acceptScan(next);
          await load(epoch);
        }
      } catch (error) {
        if (!disposed && epoch === generation.current && operation === scanOperation.current) setMessage(commandErrorMessage(error, "분석 상태를 확인하지 못했습니다."));
      }
      if (!disposed) timer = setTimeout(() => void poll(), 1200);
    }
    timer = setTimeout(() => void poll(), 1200);
    return () => { disposed = true; clearTimeout(timer); };
  }, [acceptScan, api, load, scan?.id, scan?.state]);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !pendingRef.current) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);

  async function act(action: () => Promise<void>) {
    if (pendingRef.current) return;
    const epoch = generation.current;
    pendingRef.current = true;
    listOperation.current += 1;
    setPending(true);
    setMessage(null);
    try { await action(); }
    catch (error) {
      if (epoch === generation.current) setMessage(commandErrorMessage(error, "요청을 처리하지 못했습니다. 다시 시도해 주세요."));
    } finally {
      if (epoch === generation.current) {
        pendingRef.current = false;
        setPending(false);
      }
    }
  }

  function control(kind: "start" | "resume" | "cancel") {
    const epoch = generation.current;
    void act(async () => {
      scanOperation.current += 1;
      const next = kind === "start" ? await api.start(assetIds) : kind === "resume" ? await api.resume(scanRef.current!.id) : await api.cancel(scanRef.current!.id);
      if (generation.current === epoch) { acceptScan(next); await load(epoch); }
    });
  }

  function decide(decision: VideoDecision) {
    if (!review) return;
    const epoch = generation.current;
    void act(async () => { await api.decide(review.id, decision); await load(epoch); });
  }

  return <section className="similarity-review video-similarity" aria-label="영상 유사 검토" onKeyDown={(event) => {
    if (event.key === "Escape" && !event.defaultPrevented && !pendingRef.current) {
      event.preventDefault();
      onClose();
    }
    event.stopPropagation();
  }}>
    <ViewToolbar title="영상 유사 검토" actions={<Button size="icon" variant="ghost" aria-label="영상 검토 닫기" disabled={pending} onClick={onClose}><XMarkIcon aria-hidden="true" /></Button>}>
      <span>검토 대기 {total}쌍</span>
    </ViewToolbar>
    <div className="video-similarity__scan">
      <div className="video-similarity__scan-actions">
        <Button disabled={pending || running(scan) || assetIds.length < 2 || assetIds.length > 100} onClick={() => control("start")}>선택한 영상 {assetIds.length}개 분석</Button>
        {running(scan) && <Button variant="secondary" disabled={pending} onClick={() => control("cancel")}>분석 중지</Button>}
        {resumable(scan) && <Button variant="secondary" disabled={pending} onClick={() => control("resume")}>이전 분석 이어서</Button>}
        <Button variant="ghost" disabled={pending} onClick={() => void act(() => load(generation.current))}>목록 새로고침</Button>
      </div>
      <p>선택한 영상끼리 프레임을 비교합니다. 한쪽만 보관하면 다른 영상은 휴지통으로 이동합니다.</p>
      {scan && <p role="status">{stateLabels[scan.state] ?? "상태 확인 필요"} · {scan.completed + scan.failed + scan.skipped} / {scan.total}개 · 후보 {scan.candidateCount}쌍{scan.failed > 0 && ` · 실패 ${scan.failed}개`}{scan.skipped > 0 && ` · 제외 ${scan.skipped}개`}{scan.reason && ` · ${reasonLabels[scan.reason] ?? "분석 중 문제가 발생했습니다"}`}</p>}
    </div>
    {message && <Toast onDismiss={() => setMessage(null)}>{message}</Toast>}
    {loading ? <Skeleton className="similarity-review__skeleton" label="유사 영상을 불러오는 중" /> : !review ? <EmptyState title="검토할 유사 영상이 없습니다">보관함에서 영상 2–100개를 선택한 뒤 비교할 수 있습니다.</EmptyState> : <>
      <div className="similarity-review__comparison">
        <VideoAssetPanel side="왼쪽 영상" asset={review.left} />
        <VideoAssetPanel side="오른쪽 영상" asset={review.right} />
        <details className="video-similarity__evidence"><summary>비교 근거 · {review.evidence.matchedFrames} / {review.evidence.attemptedFrames}프레임 일치</summary>
          <p>시간 구간 {Math.round(review.evidence.matchingSpanPermille / 10)}% · 유효 프레임 {review.evidence.validFrames}개</p>
          <ul>{review.evidence.matches.map((match, index) => <li key={index}>{seconds(match.leftRequestedAtMs)} ↔ {seconds(match.rightRequestedAtMs)} · 거리 {match.distance}</li>)}</ul>
        </details>
      </div>
      <footer className="similarity-review__actions">
        <Button disabled={pending} onClick={() => decide("keep_left")}>왼쪽 보관 · 오른쪽 휴지통</Button>
        <Button disabled={pending} onClick={() => decide("keep_right")}>오른쪽 보관 · 왼쪽 휴지통</Button>
        <Button variant="secondary" disabled={pending} onClick={() => decide("keep_both")}>둘 다 보관</Button>
        <Button variant="ghost" disabled={pending} onClick={() => decide("not_similar")}>다른 영상</Button>
      </footer>
    </>}
  </section>;
}

function seconds(ms: number) { return `${(ms / 1000).toFixed(1)}초`; }
function VideoAssetPanel({ side, asset }: { side: string; asset: AssetSummary }) {
  const { privacyMode } = usePrivacy();
  return <section className="similarity-review__asset" aria-label={side}>
    <div className="similarity-review__preview">{privacyMode ? <Skeleton className="privacy-mask similarity-review__preview-mask" label="비공개 모드" /> : asset.media.kind === "video" && asset.media.preparationState === "ready" ? <VideoPlayer key={asset.id} asset={{ ...asset, media: asset.media }} /> : <img src={thumbnailUrl(asset.id)} alt={side} />}</div>
    <h3>{asset.title || asset.originalName}</h3>
    <dl><div><dt>파일 크기</dt><dd>{formatBytes(asset.byteSize)}</dd></div><div><dt>해상도</dt><dd>{asset.width} × {asset.height}</dd></div>{asset.media.kind === "video" && <div><dt>재생 시간</dt><dd>{asset.media.durationMs == null ? "알 수 없음" : seconds(asset.media.durationMs)}</dd></div>}</dl>
    {!privacyMode && asset.media.kind === "video" && asset.media.preparationState !== "ready" && <p>재생 준비가 끝나면 영상을 확인할 수 있습니다.</p>}
  </section>;
}
