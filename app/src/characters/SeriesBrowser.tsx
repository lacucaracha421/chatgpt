import { useEffect, useRef, useState, type ComponentProps } from "react";
import { InformationCircleIcon, PlusIcon } from "@heroicons/react/24/outline";
import type { AssetSummary, AssetView, ClassificationEntry } from "../library/types";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import { AssetGallery } from "../assets/AssetGallery";
import { AssetViewer } from "../assets/AssetViewer";
import { assetUrl, thumbnailUrl } from "../assets/mediaUrl";
import { applySelectionGesture, emptySelection, moveSelectionFocus, selectAllLoaded } from "../assets/selection";
import { Button } from "../shared/ui/Button";
import { Select } from "../shared/ui/Select";
import { AnchoredPanel } from "../shared/ui/AnchoredPanel";
import { ChromeContribution } from "../layout/WorkspaceChrome";
import { CharacterRegistry } from "./CharacterRegistry";
import { CharacterArtPicker } from "./CharacterArtPicker";
import { CharacterLab } from "./CharacterLab";
import { characterApi, type CharacterApi, type CharacterTarget } from "./api";
import { characterHubApi, type CharacterBrowsePage, type CharacterHubApi, type CharacterSeries } from "./hubApi";
import "./CharacterLab.css";
import "./SeriesBrowser.css";

export type CharacterGalleryDrag = Pick<ComponentProps<typeof AssetGallery>, "onPointerDragStart" | "onPointerDragMove" | "onPointerDragEnd" | "onPointerDragCancel">;
type Props = {
  requestedAsset?: AssetSummary | null; onRequestedAssetHandled?: () => void;
  clearSelectionRequest?: number; galleryDrag?: CharacterGalleryDrag;
  series: CharacterSeries; targetId?: string; targets: CharacterTarget[]; classifications: ClassificationEntry[];
  privacyMode: boolean; metadataVisible: boolean; thumbnailRowHeight: number; refreshVersion: number;
  onNavigate: (view: AssetView) => void; onChanged: () => void;
  api?: CharacterApi; hubApi?: CharacterHubApi;
};
export function SeriesBrowser({ requestedAsset, onRequestedAssetHandled, clearSelectionRequest = 0, galleryDrag, series, targetId, targets, classifications, privacyMode, metadataVisible, thumbnailRowHeight, refreshVersion, onNavigate, onChanged, api = characterApi, hubApi = characterHubApi }: Props) {
  const { gateway } = useLibrary();
  const [page, setPage] = useState<CharacterBrowsePage>({ items: [], nextCursor: null, totalCount: 0 });
  const [all, setAll] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [selection, setSelection] = useState(emptySelection);
  const [externalAsset, setExternalAsset] = useState<AssetSummary | null>(null);
  const [viewer, setViewer] = useState<string | null>(null);
  const [assignTo, setAssignTo] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [heroPicker, setHeroPicker] = useState(false);
  const [review, setReview] = useState(false);
  const generation = useRef(0), pending = useRef(false);
  const loadedScope = useRef<string | null>(null);
  const scope = `${series.classificationId}:${targetId ?? ""}:${all}`;
  const current = targets.find(t => t.id === targetId);
  const members = targets.filter(t => t.seriesClassificationId === series.classificationId);
  const name = classifications.find(c => c.id === series.classificationId)?.name ?? "시리즈";
  const ids = page.items.map(a => a.id);
  function refresh() { setReload(v => v + 1); onChanged(); }
  async function load(after: string | null = null) {
    if (after && pending.current) return;
    const token = after ? generation.current : ++generation.current;
    pending.current = true; setLoading(true); setError(null);
    try {
      const next = await hubApi.browse({ seriesId: series.classificationId, targetId: targetId ?? null, all, after, limit: 100 });
      if (token === generation.current) setPage(old => after ? { ...next, items: [...old.items, ...next.items.filter(a => !old.items.some(b => b.id === a.id))] } : next);
    } catch (e) { if (token === generation.current) setError(commandErrorMessage(e, "이미지를 불러오지 못했습니다.")); }
    finally { if (token === generation.current) { pending.current = false; setLoading(false); } }
  }
  useEffect(() => {
    if (loadedScope.current !== scope) {
      loadedScope.current = scope; setPage({ items: [], nextCursor: null, totalCount: 0 }); setSelection(emptySelection()); setViewer(null);
    }
    void load(); return () => { ++generation.current; };
  }, [scope, refreshVersion, reload, hubApi]);
  useEffect(() => setSelection(emptySelection()), [clearSelectionRequest]);
  useEffect(() => {
    if (requestedAsset) { setExternalAsset(requestedAsset); setViewer(requestedAsset.id); onRequestedAssetHandled?.(); }
  }, [requestedAsset]);
  async function action(work: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true); setError(null);
    try { await work(); refresh(); }
    catch (e) { setError(commandErrorMessage(e, "변경을 저장하지 못했습니다.")); }
    finally { setBusy(false); }
  }
  function saved(target: CharacterTarget) { setEditing(target.id); refresh(); }
  function characterPanel(target: CharacterTarget | null, trigger: React.ReactElement) {
    const id = target?.id ?? "new";
    return <AnchoredPanel open={editing === id} onOpenChange={open => setEditing(open ? id : null)} title={target ? `${target.displayName} · 캐릭터 정보` : "새 캐릭터"} trigger={trigger}>
      <CharacterRegistry key={`${id}:${target?.revision ?? 0}`} api={api} target={target} seriesId={series.classificationId} classifications={classifications} privacyMode={privacyMode} onSaved={saved} />
    </AnchoredPanel>;
  }
  return <section className="series-browser" aria-label={current?.displayName ?? name}>
    <ChromeContribution title={current ? `${name} / ${current.displayName}` : name} spec={{}} />
    <div className="series-gallery" aria-busy={loading}>
      <AssetGallery {...galleryDrag} intro={<>
    <div className="series-browser__overview">
      {!current && series.heroAssetId && <img className={`series-hero${privacyMode ? " character-private" : ""}`} src={assetUrl(series.heroAssetId)} alt={`${name} hero art`} />}
      <div className="series-heading"><h2>{current?.displayName ?? name}</h2><div className="character-actions">
        {current ? <><Button onClick={() => onNavigate({ kind: "classification", classificationId: series.classificationId })}>시리즈로</Button>{characterPanel(current, <Button>캐릭터 정보</Button>)}</> : <>
          {characterPanel(null, <Button><PlusIcon aria-hidden="true" />캐릭터 등록</Button>)}
          <Button onClick={() => setHeroPicker(true)}>Hero 이미지 선택</Button>
          {series.heroAssetId && <Button disabled={busy} onClick={() => void action(() => hubApi.saveSeries({ ...series, heroAssetId: null }))}>Hero 해제</Button>}
        </>}
        <Button onClick={() => setReview(true)}>분석 · 검토</Button>
      </div></div>
      {!current && <label className="character-check"><input type="checkbox" checked={series.autoClassify} disabled={busy} onChange={e => void action(() => hubApi.saveSeries({ ...series, autoClassify: e.target.checked }))} />수집 후 자동 분류 · 애매한 결과는 검토</label>}
      {current?.description && <p className="series-description">{current.description}</p>}
      {!current && <div className="series-characters" aria-label="등록 캐릭터">
        {members.map(target => <article className="series-character" key={target.id}>
          <button className="series-character__open" aria-label={`${target.displayName} 열기`} onClick={() => onNavigate({ kind: "classification", classificationId: series.classificationId, characterId: target.id })}>
            {(target.thumbnailAssetId ?? target.references.find(r => r.status === "ready")?.assetId) ? <img loading="lazy" className={privacyMode ? "character-private" : ""} src={thumbnailUrl((target.thumbnailAssetId ?? target.references.find(r => r.status === "ready")!.assetId)!)} alt="" /> : <span className="series-character__placeholder">대표 이미지 선택</span>}
            <strong>{target.displayName}</strong><small>{target.ready ? "분석 준비됨" : `기준 ${target.references.filter(r => r.status === "ready").length}/5 · ${target.enabled ? "준비 필요" : "비활성"}`}</small>
          </button>
          {characterPanel(target, <Button className="series-character__info" size="icon" variant="ghost" aria-label={`${target.displayName} 정보`}><InformationCircleIcon aria-hidden="true" /></Button>)}
        </article>)}
        {members.length === 0 && <p className="series-empty">캐릭터를 등록하고 기준 이미지 5장을 선택하세요.</p>}
      </div>}
    </div>
    <div className="series-gallery-heading"><h3>{current ? "캐릭터 에셋" : all ? "시리즈 전체" : "캐릭터 미분류"} <small>{page.totalCount}</small></h3>{!current && <Button size="sm" aria-pressed={all} onClick={() => setAll(v => !v)}>{all ? "미분류만 보기" : "전체 보기"}</Button>}<Button size="sm" onClick={() => { setReload(v => v + 1); onChanged(); }}>새로고침</Button></div>
    {error && <p className="character-message" role="alert">{error}<Button onClick={() => setReload(v => v + 1)}>다시 시도</Button></p>}
    {selection.ids.size > 0 && <div className="character-actions series-selection"><span>{selection.ids.size}장 선택</span><Select label="캐릭터 지정" value={assignTo} onChange={e => setAssignTo(e.target.value)}><option value="">캐릭터 선택</option>{members.filter(t => t.enabled).map(t => <option key={t.id} value={t.id}>{t.displayName}</option>)}</Select><Button disabled={busy || !assignTo} onClick={() => void action(async () => { const target = (await api.targets()).find(t => t.id === assignTo); if (!target) throw new Error("캐릭터를 다시 선택해 주세요."); await api.decide({ targetId: target.id, expectedFingerprint: target.fingerprint, assetIds: [...selection.ids], decision: "accepted", baselineFingerprint: null, scanId: null }); })}>지정</Button>{current && <Button disabled={busy} onClick={() => void action(() => api.decide({ targetId: current.id, expectedFingerprint: current.fingerprint, assetIds: [...selection.ids], decision: "rejected", baselineFingerprint: null, scanId: null }))}>이 캐릭터 아님</Button>}<Button onClick={() => setSelection(emptySelection())}>선택 해제</Button></div>}
      {!loading && !error && page.items.length === 0 && <p className="series-gallery__empty">{current ? "시리즈에서 이미지를 수집한 뒤 기준 이미지나 캐릭터 에셋으로 지정하세요." : "캐릭터 미분류 이미지가 없습니다."}</p>}
      </>} layout="masonry" groupDates items={page.items} scopeKey={scope} totalCount={page.totalCount} metadataVisible={metadataVisible} privacyMode={privacyMode} targetRowHeight={thumbnailRowHeight} selectedAssetIds={selection.ids} focusAssetId={selection.focusId} hasNextPage={Boolean(page.nextCursor) && !loading && !error} onLoadNextPage={() => void load(page.nextCursor)} onSelectionGesture={(a, gesture) => setSelection(old => applySelectionGesture(old, ids, a.id, gesture))} onSelectAll={() => setSelection(old => selectAllLoaded(old, ids))} onClearSelection={() => setSelection(emptySelection())} onMoveFocus={(delta, extend) => setSelection(old => moveSelectionFocus(old, ids, delta, extend))} onOpen={a => setViewer(a.id)} />

    </div>
    {loading && <span className="series-loading" role="status">불러오는 중…</span>}
    {heroPicker && <CharacterArtPicker seriesId={series.classificationId} privacyMode={privacyMode} title="시리즈 Hero 이미지" onClose={() => setHeroPicker(false)} onChoose={id => { setHeroPicker(false); void action(() => hubApi.saveSeries({ ...series, heroAssetId: id })); }} />}
    {review && <CharacterLab api={api} classifications={classifications} initialSeriesId={series.classificationId} privacyMode={privacyMode} onClose={() => { setReview(false); refresh(); }} />}
    <AssetViewer items={externalAsset && !page.items.some(a => a.id === externalAsset.id) ? [externalAsset, ...page.items] : page.items} activeId={viewer} onActiveIdChange={setViewer} onClose={() => setViewer(null)} privacyMode={privacyMode} onAssetOpened={a => gateway.recordAssetOpened(a.id, new Date().toISOString())} onToggleFavorite={a => void action(() => gateway.setAssetFavorite(a.id, !a.favorite))} onTrash={a => void action(() => gateway.trashAssets([a.id]))} />
  </section>;
}
