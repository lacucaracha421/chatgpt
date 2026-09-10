import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useState } from "react";
import { thumbnailUrl } from "../assets/mediaUrl";
import { commandErrorMessage } from "../library/errorMessage";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import { characterHubApi, type CharacterSeriesSuggestionPage, type CharacterSuggestionApi } from "./hubApi";
import "./SeriesBrowser.css";

export function CharacterSeriesSuggestions({ rootId, rootName, privacyMode, onClose, onMoved, api = characterHubApi }: {
  rootId: string;
  rootName: string;
  privacyMode: boolean;
  onClose: () => void;
  onMoved: () => void;
  api?: CharacterSuggestionApi;
}) {
  const [page, setPage] = useState<CharacterSeriesSuggestionPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const next = await api.suggestions(rootId, 100);
      setPage(next);
      setError(null);
    } catch (e) {
      setError(commandErrorMessage(e, "작품 후보를 불러오지 못했습니다."));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [api, rootId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!page?.pendingCount) return;
    const timer = window.setInterval(() => void load(true), 2000);
    return () => window.clearInterval(timer);
  }, [page?.pendingCount, load]);

  async function queueDiscovery() {
    if (busyId) return;
    setBusyId("queue"); setError(null); setNotice(null);
    try {
      const queued = await api.queueDiscovery(rootId);
      setNotice(queued ? `${queued}장 분석을 예약했습니다. 완료되는 대로 후보가 나타납니다.` : "새로 분석할 이미지가 없습니다.");
      await load(true);
    } catch (e) {
      setError(commandErrorMessage(e, "미분류 이미지 분석을 시작하지 못했습니다."));
    } finally { setBusyId(null); }
  }

  async function move(assetId: string, seriesId: string, seriesName: string) {
    if (busyId) return;
    setBusyId(assetId); setError(null); setNotice(null);
    try {
      await api.acceptSuggestion(rootId, assetId, seriesId);
      setPage(current => current ? { ...current, items: current.items.filter(item => item.asset.id !== assetId) } : current);
      setNotice(`${seriesName}로 이동했습니다.`);
      onMoved();
    } catch (e) {
      setError(commandErrorMessage(e, "작품 폴더로 이동하지 못했습니다."));
      await load(true);
    } finally { setBusyId(null); }
  }

  async function dismiss(assetId: string, seriesId: string) {
    if (busyId) return;
    setBusyId(assetId); setError(null); setNotice(null);
    try {
      await api.dismissSuggestion(rootId, assetId, seriesId);
      setPage(current => current ? { ...current, items: current.items.filter(item => item.asset.id !== assetId) } : current);
    } catch (e) {
      setError(commandErrorMessage(e, "작품 후보를 숨기지 못했습니다."));
      await load(true);
    } finally { setBusyId(null); }
  }

  return <Dialog open title={`${rootName} · 작품 후보`} variant="wide" onClose={onClose}>
    <div className="character-series-suggestions">
      <div className="character-series-suggestions__summary">
        <p>이미 분석된 결과에서 작품 후보를 모읍니다. 특징 캐시가 있으면 다시 추출하지 않습니다.</p>
        <div className="character-actions">
          {page && page.unscannedCount > 0 && <Button size="sm" disabled={Boolean(busyId)} onClick={() => void queueDiscovery()}>남은 {page.unscannedCount.toLocaleString()}장 분석</Button>}
          {page && page.pendingCount > 0 && <small>분석 중 {page.pendingCount.toLocaleString()}장</small>}
          <Button size="icon" variant="ghost" aria-label="작품 후보 새로고침" data-tooltip="새로고침" disabled={loading || Boolean(busyId)} onClick={() => void load()}><ArrowPathIcon aria-hidden="true" /></Button>
          <Button size="sm" variant="ghost" onClick={onClose}>닫기</Button>
        </div>
      </div>
      {error && <p className="character-message" role="alert">{error}</p>}
      {notice && <p className="character-message" role="status">{notice}</p>}
      {loading && !page ? <p className="character-series-suggestions__empty">후보를 불러오는 중…</p>
        : page && page.items.length === 0 ? <p className="character-series-suggestions__empty">{page.pendingCount > 0 ? "분석이 끝나는 대로 작품 후보가 나타납니다." : page.unscannedCount > 0 ? "아직 분석하지 않은 이미지가 있습니다." : "현재 확인할 작품 후보가 없습니다."}</p>
        : <div className="character-series-suggestions__list">
          {page?.items.map(item => <article className="character-series-suggestion" key={item.asset.id}>
            <img className={privacyMode ? "character-private" : ""} src={thumbnailUrl(item.asset.id)} alt={item.asset.originalName} loading="lazy" decoding="async" />
            <div className="character-series-suggestion__body">
              <strong>{item.seriesName}</strong>
              <span>{item.targetName}{item.targetCount > 1 ? ` 외 ${item.targetCount - 1}명` : ""} 일치</span>
              <small>기준 이미지 {item.matchedReferences}장 일치</small>
            </div>
            <div className="character-series-suggestion__actions">
              <Button size="sm" variant="primary" disabled={Boolean(busyId)} onClick={() => void move(item.asset.id, item.seriesId, item.seriesName)}>{item.seriesName}로 이동</Button>
              <Button size="sm" variant="ghost" disabled={Boolean(busyId)} onClick={() => void dismiss(item.asset.id, item.seriesId)}>그대로 두기</Button>
            </div>
          </article>)}
        </div>}
    </div>
  </Dialog>;
}
