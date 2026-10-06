import { useEffect, useId, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "../shared/ui/Button";
import { BusyLabel } from "../shared/ui/BusyLabel";
import { Dialog } from "../shared/ui/Dialog";
import { commandErrorMessage } from "../library/errorMessage";

type LinkedTag = { tag: string; pendingRecommendations: number };
export type CharacterTagLinks = { linked: LinkedTag[]; excluded: string[] };
export const characterTaggerTagsApi = {
  list: (targetId: string): Promise<CharacterTagLinks> => invoke("character_tagger_tags", { targetId }),
  unlink: (targetId: string, tag: string, expectedPending: number): Promise<void> => invoke("unlink_character_tagger_tag", { targetId, tag, expectedPending }),
  relink: (targetId: string, tag: string): Promise<void> => invoke("relink_character_tagger_tag", { targetId, tag }),
};

/** PC-only management, saved immediately rather than with the character draft. */
export function CharacterTaggerTags({ targetId, disabled, api = characterTaggerTagsApi }: {
  targetId: string; disabled?: boolean; api?: typeof characterTaggerTagsApi;
}) {
  const headingId = useId();
  const [links, setLinks] = useState<CharacterTagLinks | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<LinkedTag | null>(null);
  const working = useRef(false);
  useEffect(() => {
    let active = true;
    setLinks(null); setLoading(true); setError(null); setConfirming(null);
    api.list(targetId).then(value => { if (active) setLinks(value); })
      .catch(e => { if (active) setError(commandErrorMessage(e, "태거 태그를 불러오지 못했습니다.")); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, targetId]);
  async function refresh() {
    setLoading(true);
    try { setLinks(await api.list(targetId)); }
    catch (e) { setLinks(null); setError(commandErrorMessage(e, "태거 태그를 불러오지 못했습니다.")); }
    finally { setLoading(false); }
  }
  async function change(tag: string, unlink?: LinkedTag) {
    if (working.current) return;
    working.current = true; setBusy(tag); setError(null);
    try {
      if (unlink) await api.unlink(targetId, tag, unlink.pendingRecommendations);
      else await api.relink(targetId, tag);
      setConfirming(null);
      await refresh();
    } catch (e) {
      setConfirming(null);
      setError(commandErrorMessage(e, "태거 태그 연결을 변경하지 못했습니다."));
      await refresh();
    } finally { working.current = false; setBusy(null); }
  }
  return <section className="character-tagger-tags" aria-labelledby={headingId} aria-busy={loading || Boolean(busy)}>
    <h3 className="character-registry__heading" id={headingId}>태거 태그</h3>
    <BusyLabel busy={loading}>불러오는 중…</BusyLabel>
    {error && <p className="character-message" role="alert">{error}</p>}
    {!loading && !links && <Button size="sm" disabled={disabled || Boolean(busy)} onClick={() => { setError(null); void refresh(); }}>다시 시도</Button>}
    {links && <>
      {links.linked.length === 0 && <p className="character-registry__hint">연결된 태거 태그가 없습니다.</p>}
      {links.linked.map(link => <div className="character-tagger-tags__row" key={link.tag}>
        <span>{link.tag}</span>
        <Button size="sm" variant="ghost" disabled={disabled || loading || Boolean(busy)} aria-label={`${link.tag} 연결 끊기`}
          onClick={() => link.pendingRecommendations > 0 ? setConfirming(link) : void change(link.tag, link)}>
          <BusyLabel busy={busy === link.tag} idle="연결 끊기">끊는 중…</BusyLabel>
        </Button>
      </div>)}
      {links.excluded.length > 0 && <details className="character-registry__section">
        <summary>연결을 끊은 태그 · {links.excluded.length}</summary>
        <div className="character-registry__section-body">{links.excluded.map(tag => <div className="character-tagger-tags__row" key={tag}>
          <span>{tag}</span>
          <Button size="sm" variant="ghost" disabled={disabled || loading || Boolean(busy)} aria-label={`${tag} 다시 연결`} onClick={() => void change(tag)}>
            <BusyLabel busy={busy === tag} idle="다시 연결">연결하는 중…</BusyLabel>
          </Button>
        </div>)}</div>
      </details>}
    </>}
    {confirming && <Dialog open title="태거 태그 연결 끊기" onClose={() => { if (!busy) setConfirming(null); }}>
      <p>{confirming.tag}</p>
      <p>추천 {confirming.pendingRecommendations.toLocaleString("ko-KR")}장이 사라집니다.</p>
      <div className="dialog-actions">
        <Button variant="ghost" disabled={Boolean(busy)} onClick={() => setConfirming(null)}>취소</Button>
        <Button variant="primary" disabled={Boolean(busy)} onClick={() => void change(confirming.tag, confirming)}>
          <BusyLabel busy={Boolean(busy)} idle="연결 끊기">끊는 중…</BusyLabel>
        </Button>
      </div>
    </Dialog>}
  </section>;
}
