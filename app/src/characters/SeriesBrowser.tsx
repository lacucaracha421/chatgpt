import { useEffect, useRef, useState, type ComponentProps } from "react";
import { ArrowPathIcon, BoltIcon, BoltSlashIcon, CheckIcon, ChevronRightIcon, InformationCircleIcon, EllipsisHorizontalIcon, PhotoIcon, PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import type { AlbumEntry, AssetSummary, AssetView, ClassificationEntry } from "../library/types";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import { AssetGallery } from "../assets/AssetGallery";
import { AssetViewer } from "../assets/AssetViewer";
import { AssetInspector } from "../assets/AssetInspector";
import { libraryContextItems } from "../assets/libraryContextItems";
import { assetUrl, thumbnailUrl } from "../assets/mediaUrl";
import { applySelectionGesture, emptySelection, moveSelectionFocus, selectAllLoaded } from "../assets/selection";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import { TextField } from "../shared/ui/TextField";
import { ContextMenu, type ContextMenuItem } from "../shared/ui/ContextMenu";
import { AnchoredPanel } from "../shared/ui/AnchoredPanel";
import { useBackHandler } from "../shared/navigation/BackNavigation";
import { ViewToolbar } from "../layout/ViewToolbar";
import { CharacterRegistry, characterDraft, type CharacterEditorDraft } from "./CharacterRegistry";
import { CharacterConversion } from "./CharacterConversion";
import { CharacterGroups } from "./CharacterGroups";
import { CharacterLab } from "./CharacterLab";
import { characterApi, type CharacterApi, type CharacterTarget } from "./api";
import { characterHubApi, type CharacterBrowsePage, type CharacterGroup, type CharacterHubApi, type CharacterSeries } from "./hubApi";
import "./CharacterLab.css";
import "./SeriesBrowser.css";

export type CharacterGalleryDrag = Pick<ComponentProps<typeof AssetGallery>, "onPointerDragStart" | "onPointerDragMove" | "onPointerDragEnd" | "onPointerDragCancel">;
type Props = {
  requestedAsset?: AssetSummary | null; onRequestedAssetHandled?: () => void;
  clearSelectionRequest?: number; galleryDrag?: CharacterGalleryDrag; albums?: AlbumEntry[];
  series: CharacterSeries; targetId?: string; groupId?: string; targets: CharacterTarget[]; groups?: CharacterGroup[]; classifications: ClassificationEntry[];
  privacyMode: boolean; metadataVisible: boolean; thumbnailRowHeight: number; refreshVersion: number;
  onNavigate: (view: AssetView) => void; onChanged: () => void;
  api?: CharacterApi; hubApi?: CharacterHubApi;
};
type Editor = { target: CharacterTarget | null; draft: CharacterEditorDraft };
type Picking = { kind: "thumbnail" | "references" | "hero"; ids: string[]; previousAll: boolean };
const emptyPage = (): CharacterBrowsePage => ({ items: [], nextCursor: null, totalCount: 0 });

export function SeriesBrowser({ requestedAsset, onRequestedAssetHandled, clearSelectionRequest = 0, galleryDrag, albums = [], series, targetId, groupId, targets, groups = [], classifications, privacyMode, metadataVisible, thumbnailRowHeight, refreshVersion, onNavigate, onChanged, api = characterApi, hubApi = characterHubApi }: Props) {
  const { gateway } = useLibrary();
  const [page, setPage] = useState<CharacterBrowsePage>(emptyPage);
  const [all, setAll] = useState(false), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null), [editorError, setEditorError] = useState<string | null>(null);
  const [reload, setReload] = useState(0), [selection, setSelection] = useState(emptySelection);
  const [externalAsset, setExternalAsset] = useState<AssetSummary | null>(null), [viewer, setViewer] = useState<string | null>(null);
  const [assignTo, setAssignTo] = useState<string[]>([]), [editor, setEditor] = useState<Editor | null>(null);
  const [pickFromSeries, setPickFromSeries] = useState(false);
  const [picking, setPicking] = useState<Picking | null>(null), [review, setReview] = useState(false), [inspector, setInspector] = useState(false);
  const [converting, setConverting] = useState(false);
  const [excludedOnly, setExcludedOnly] = useState(false);
  const [manualName, setManualName] = useState<string | null>(null);
  const [reviewPending, setReviewPending] = useState<boolean | null>(null);
  const [undo, setUndo] = useState<string[]>([]);
  const generation = useRef(0), pending = useRef(false), saving = useRef(false);
  const loadedScope = useRef<string | null>(null);
  const pickerPages = useRef(new Map<string, CharacterBrowsePage>());
  const returnGallery = useRef<{ scope: string; page: CharacterBrowsePage } | null>(null);
  const current = targets.find(t => t.id === targetId);
  const currentGroup = groups.find(group => group.id === groupId && group.seriesId === series.classificationId);
  const members = targets.filter(t => t.seriesClassificationId === series.classificationId);
  const name = classifications.find(c => c.id === series.classificationId)?.name ?? "시리즈";
  const pickerScope = picking && picking.kind !== "hero" ? `${series.classificationId}:${editor?.target?.id ?? "new"}:${pickFromSeries ? "series" : "character"}:${all}` : null;
  const scope = `${series.classificationId}:${picking ? picking.kind === "hero" ? "pick-hero" : `pick-${editor?.target?.id ?? "new"}-${pickFromSeries}` : targetId ? `character-${targetId}` : currentGroup ? `group-${currentGroup.id}` : excludedOnly ? "excluded" : "series"}:${all}`;
  const ids = page.items.map(a => a.id);
  const selectedIds = [...selection.ids];
  function refresh() { setReload(v => v + 1); onChanged(); }
  async function load(after: string | null = null) {
    if (after && pending.current) return;
    if (!after && pickerScope) {
      const cached = pickerPages.current.get(pickerScope);
      if (cached) { setPage(cached); setLoading(false); setError(null); return; }
    }
    const token = after ? generation.current : ++generation.current;
    pending.current = true; setLoading(true); setError(null);
    try {
      const next = !picking && !targetId && !currentGroup && excludedOnly
        ? await hubApi.excludedAssets(series.classificationId, after, 100)
        : await hubApi.browse({ seriesId: series.classificationId,
        targetId: picking ? picking.kind !== "hero" && !pickFromSeries ? editor?.target?.id ?? null : null : targetId ?? null,
        groupId: picking ? null : currentGroup?.id ?? null,
        ...(picking && picking.kind !== "hero" ? { referenceTargetId: editor?.target?.id ?? "" } : {}), all, after, limit: 100 });
      if (token === generation.current) setPage(old => {
        const value = after ? { ...next, items: [...old.items, ...next.items.filter(a => !old.items.some(b => b.id === a.id))] } : next;
        if (pickerScope) pickerPages.current.set(pickerScope, value);
        return value;
      });
    } catch (e) { if (token === generation.current) setError(commandErrorMessage(e, "이미지를 불러오지 못했습니다.")); }
    finally { if (token === generation.current) { pending.current = false; setLoading(false); } }
  }
  useEffect(() => {
    if (!picking && returnGallery.current?.scope === scope) {
      setPage(returnGallery.current.page); returnGallery.current = null; loadedScope.current = scope; setLoading(false); return;
    }
    if (loadedScope.current !== scope) {
      loadedScope.current = scope; setPage(emptyPage()); setSelection(emptySelection()); setViewer(null);
    }
    void load(); return () => { ++generation.current; };
  }, [scope, refreshVersion, reload, hubApi]);
  useEffect(() => {
    if (!current || picking) { setReviewPending(null); return; }
    let active = true;
    setReviewPending(null);
    void (api.reviewPending
      ? api.reviewPending(series.classificationId, current.id)
      : api.review({ seriesId: series.classificationId, targetId: current.id, filter: "recommended", after: null, limit: 1 }).then(result => result.rows.length > 0))
      .then(found => { if (active) setReviewPending(found); })
      .catch(() => { if (active) setReviewPending(null); });
    return () => { active = false; };
  }, [api, current?.id, current?.fingerprint, series.classificationId, refreshVersion, reload, review, picking]);
  useEffect(() => setAssignTo([]), [series.classificationId]);
  useEffect(() => setSelection(emptySelection()), [clearSelectionRequest]);
  useEffect(() => { if (requestedAsset) { setExternalAsset(requestedAsset); setViewer(requestedAsset.id); onRequestedAssetHandled?.(); } }, [requestedAsset]);
  async function action(work: () => Promise<unknown>) {
    if (saving.current) return;
    saving.current = true; setBusy(true); setError(null);
    try { await work(); refresh(); }
    catch (e) { setError(commandErrorMessage(e, "변경을 저장하지 못했습니다.")); }
    finally { saving.current = false; setBusy(false); }
  }
  async function createManualCharacter() {
    const displayName = manualName?.trim();
    if (!displayName || !selectedIds.length || saving.current) return;
    saving.current = true; setBusy(true); setError(null);
    try {
      const target = await hubApi.createManualCharacter({ seriesId: series.classificationId, displayName, assetIds: selectedIds });
      setManualName(null); setSelection(emptySelection()); refresh();
      onNavigate({ kind: "classification", classificationId: series.classificationId, characterId: target.id });
    } catch (e) { setError(commandErrorMessage(e, "수동 캐릭터를 만들지 못했습니다.")); }
    finally { saving.current = false; setBusy(false); }
  }
  function openEditor(target: CharacterTarget | null) { pickerPages.current.clear(); setEditor({ target, draft: characterDraft(target) }); setEditorError(null); }
  function beginPick(kind: Picking["kind"]) {
    setPickFromSeries(false);
    returnGallery.current = { scope, page }; ++generation.current; setPage(emptyPage()); setError(null);
    setPicking({ kind, previousAll: all, ids: kind === "hero" ? series.heroAssetId ? [series.heroAssetId] : [] : kind === "thumbnail" ? editor?.draft.thumbnail ? [editor.draft.thumbnail] : [] : editor?.draft.references ?? [] });
    setAll(kind === "hero" || Boolean(editor?.target));
  }
  function finishPick(accept: boolean) {
    if (!picking) return;
    if (accept && picking.kind === "hero") void action(() => hubApi.saveSeries({ ...series, heroAssetId: picking.ids[0] ?? null }));
    if (accept && editor && picking.kind !== "hero") setEditor({ ...editor, draft: { ...editor.draft,
      ...(picking.kind === "thumbnail" ? { thumbnail: picking.ids[0] ?? null } : { references: picking.ids }) } });
    ++generation.current; setAll(picking.previousAll); setPicking(null); setError(null);
  }
  useBackHandler(() => finishPick(false), 85, Boolean(picking));
  function choose(id: string) {
    if (!picking || busy) return;
    if (picking.kind !== "references") { setPicking({ ...picking, ids: [id] }); return; }
    if (picking.ids.includes(id)) setPicking({ ...picking, ids: picking.ids.filter(value => value !== id) });
    else if (picking.ids.length < 5) setPicking({ ...picking, ids: [...picking.ids, id] });
    else setError("기준 이미지는 최대 5장입니다. 먼저 한 장을 해제해 주세요.");
  }
  async function saveEditor() {
    if (!editor || saving.current) return;
    saving.current = true; setBusy(true); setEditorError(null);
    try {
      const { draft, target } = editor;
      let saved = await api.save({ id: target?.id ?? null, expectedRevision: target?.revision ?? null,
        seriesClassificationId: series.classificationId, linkedClassificationId: target?.linkedClassificationId ?? null,
        displayName: draft.name.trim(), description: draft.description, thumbnailAssetId: draft.thumbnail, enabled: draft.enabled }, true);
      setEditor({ target: saved, draft }); // Keep the new identity if reference saving needs a retry.
      if (JSON.stringify(saved.references.flatMap(r => r.assetId ? [r.assetId] : [])) !== JSON.stringify(draft.references))
        saved = await api.refs(saved.id, saved.revision, draft.references, true);
      setEditor(null); refresh();
    } catch (e) { setEditorError(commandErrorMessage(e, "캐릭터 설정을 저장하지 못했습니다.")); onChanged(); }
    finally { saving.current = false; setBusy(false); }
  }
  const editorPanel = <AnchoredPanel open={Boolean(editor) && !picking} onOpenChange={open => { if (open) openEditor(current ?? null); else if (!picking && !busy) setEditor(null); }} title={editor?.target ? `${editor.target.displayName} · 캐릭터 정보` : "새 캐릭터"}
    trigger={<Button size="icon" variant="ghost" aria-label={current ? "캐릭터 더보기" : "캐릭터 등록"} data-tooltip={current ? "캐릭터 더보기" : "캐릭터 등록"}><>{current ? <EllipsisHorizontalIcon aria-hidden="true" /> : <PlusIcon aria-hidden="true" />}</></Button>}>
    {editor && <><CharacterRegistry draft={editor.draft} target={editor.target} privacyMode={privacyMode} busy={busy} error={editorError}
      onExcludeReference={api.excludeReference ? assetId => void (async () => {
        if (!editor?.target || saving.current) return;
        saving.current = true; setBusy(true); setEditorError(null);
        try { const target = await api.excludeReference!(editor.target.id, editor.target.revision, assetId); setEditor(old => old ? { ...old, target } : old); refresh(); }
        catch (error) { setEditorError(commandErrorMessage(error, "추가 참조를 제외하지 못했습니다.")); }
        finally { saving.current = false; setBusy(false); }
      })() : undefined}
      onOpenReference={assetId => void (async () => {
        try { const asset = await gateway.getAsset(assetId); setExternalAsset(asset); setViewer(assetId); }
        catch (error) { setEditorError(commandErrorMessage(error, "원본을 열지 못했습니다.")); }
      })()}
      onChange={draft => setEditor({ ...editor, draft })} onPick={beginPick} onSave={() => void saveEditor()} />{current && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setEditor(null); setConverting(true); }}>일반 폴더로 전환</Button>}</>}
  </AnchoredPanel>;
  const automation = <Button className="series-automatic-toggle" size="icon" variant="ghost" aria-label={`자동 분류 ${series.autoClassify ? "켜짐" : "꺼짐"}`} data-tooltip={`자동 분류 ${series.autoClassify ? "켜짐" : "꺼짐"}`} aria-pressed={series.autoClassify} disabled={busy || Boolean(picking)} onClick={() => void action(() => hubApi.saveSeries({ ...series, autoClassify: !series.autoClassify }))}>{series.autoClassify ? <BoltIcon aria-hidden="true" /> : <BoltSlashIcon aria-hidden="true" />}</Button>;
  const contextItems: ContextMenuItem[] = picking ? [
    { id: "cancel-pick", label: "이미지 선택 취소", onSelect: () => finishPick(false) },
  ] : [
    ...libraryContextItems({ count: selectedIds.length, busy, classifications, albums,
      onFavorite: favorite => void action(() => gateway.setAssetsFavorite(selectedIds, favorite)),
      onMove: classificationId => void action(() => gateway.setAssetClassification({ assetIds: selectedIds, classificationId })),
      onAlbum: id => void action(() => gateway.patchAssetAlbums({ assetIds: selectedIds, addAlbumIds: [id], removeAlbumIds: [] })) }),
    { id: "info", label: "정보 열기", disabled: !selectedIds.length, onSelect: () => setInspector(true) },
    { id: "all", label: "불러온 이미지 선택", onSelect: () => setSelection(old => selectAllLoaded(old, ids)) },
    { id: "clear", label: "선택 해제", onSelect: () => setSelection(emptySelection()) },
    { id: "refresh", label: "새로고침", onSelect: refresh },
    { id: "trash", label: "휴지통으로 이동", destructive: true, disabled: busy || !selectedIds.length, onSelect: () => void action(async () => { await gateway.trashAssets(selectedIds); setUndo(selectedIds); setSelection(emptySelection()); }) },
  ];
  const focusedName = current?.displayName ?? currentGroup?.name;
  return <section className="series-browser" aria-label={focusedName ?? name}>
    <ViewToolbar title={focusedName ? `${name} / ${focusedName}` : name} ariaLabel="시리즈 도구"
      titleContent={focusedName ? <span className="series-breadcrumb"><button onClick={() => onNavigate({ kind: "classification", classificationId: series.classificationId })}>{name}</button><ChevronRightIcon aria-hidden="true" /><span>{focusedName}</span><small className="series-header-count">{page.totalCount.toLocaleString()}장</small></span> : name}
      titleAccessory={<div className="series-header-actions">
        {!picking && current && (selectedIds.length > 0 ? <>
          <small className="series-selection-count">{selectedIds.length.toLocaleString()}장 선택</small>
          <Button size="icon" variant="ghost" aria-label="선택 해제" data-tooltip="선택 해제" onClick={() => setSelection(emptySelection())}><XMarkIcon aria-hidden="true" /></Button>
          <Button size="sm" variant="ghost" disabled={busy || selectedIds.length > 200} title="한 번에 최대 200장" onClick={() => void action(async () => {
            await api.decide({ targetId: current.id, expectedFingerprint: current.fingerprint, assetIds: selectedIds, decision: "rejected", baselineFingerprint: null, scanId: null });
            setSelection(emptySelection());
          })}>캐릭터에서 제외</Button>
        </> : <>
          {!current.manualOnly && <Button className="series-review-button" size="sm" variant="ghost" aria-label={reviewPending ? "검토 · 검토 대기 있음" : reviewPending === null ? "검토 · 대기 상태 확인 필요" : "검토"} onClick={() => setReview(true)}>검토<span className="series-review-badge" data-pending={reviewPending === true} aria-hidden="true">!</span></Button>}
          <Button size="icon" variant="ghost" aria-label="새로고침" data-tooltip="새로고침" onClick={refresh}><ArrowPathIcon aria-hidden="true" /></Button>
        </>)}
        {!current && !currentGroup && !picking && <>
          <Button size="icon" variant="ghost" aria-label="히어로 이미지 선택" data-tooltip="히어로 이미지" onClick={() => beginPick("hero")}><PhotoIcon aria-hidden="true" /></Button>
          {series.heroAssetId && <Button size="icon" variant="ghost" aria-label="히어로 이미지 해제" disabled={busy} onClick={() => void action(() => hubApi.saveSeries({ ...series, heroAssetId: null }))}><XMarkIcon aria-hidden="true" /></Button>}
          <Button size="icon" variant="ghost" aria-label="새로고침" data-tooltip="새로고침" onClick={refresh}><ArrowPathIcon aria-hidden="true" /></Button>
        </>}
        {!picking && !currentGroup && editorPanel}
      </div>}
      chrome={{ status: automation }} actions={automation} />
    {picking && <div className="series-picking" role="region" aria-label="갤러리 이미지 선택">
      <div className="series-picking__title"><strong>{picking.kind === "references" ? `기준 이미지 선택 · ${picking.ids.length}/5` : picking.kind === "hero" ? "히어로 이미지 선택" : "대표 이미지 선택"}</strong><small>{picking.kind === "hero" ? name : editor?.target ? `${editor.target.displayName} 캐릭터 폴더 · 다른 캐릭터와 공유된 이미지는 제외됩니다` : "다른 캐릭터의 이미지는 제외됩니다"}</small></div>
      <div className="series-picking__chosen">{picking.ids.map((id,i) => <button key={id} aria-label={`선택 이미지 ${i + 1} 해제`} onClick={() => setPicking({ ...picking, ids: picking.ids.filter(v => v !== id) })}><img src={thumbnailUrl(id)} className={privacyMode ? "character-private" : ""} alt="" /><span>×</span></button>)}</div>
      <Button size="sm" disabled={busy || !picking.ids.length} onClick={() => finishPick(true)}>완료</Button><Button size="sm" variant="ghost" onClick={() => finishPick(false)}>취소</Button>
    </div>}
    <ContextMenu items={contextItems}><div className="series-gallery" aria-busy={loading} onContextMenu={event => {
      if (picking) return;
      const id = (event.target as HTMLElement).closest<HTMLElement>("[data-asset-id]")?.dataset.assetId;
      if (id && !selection.ids.has(id)) setSelection(old => applySelectionGesture(old, ids, id, { range: false, toggle: false }));
    }}>
      {!picking && !current && !currentGroup && selection.ids.size > 0 && <div className="character-actions series-selection" role="region" aria-label={excludedOnly ? "캐릭터 분류 제외 선택" : "선택 이미지 캐릭터 지정"}>
        <span>{selection.ids.size}장 선택</span>
        {excludedOnly ? <>
          <Button size="sm" disabled={busy || selectedIds.length > 200} onClick={() => void action(async () => {
            await hubApi.setSeriesAssetExcluded({ seriesId: series.classificationId, assetIds: selectedIds, excluded: false });
            setSelection(emptySelection());
          })}>분류 다시 시작</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setSelection(emptySelection())}>선택 해제</Button>
        </> : <>
          <fieldset className="series-assignment" disabled={busy}>
            <legend>캐릭터 지정 · 복수 선택</legend>
            <div className="series-assignment__options">{members.filter(t => t.enabled).map(target => <label key={target.id}>
              <input type="checkbox" checked={assignTo.includes(target.id)} onChange={event => { const checked = event.target.checked; setAssignTo(old => checked ? [...old, target.id] : old.filter(id => id !== target.id)); }} />
              {target.displayName}
            </label>)}</div>
          </fieldset>
          <Button size="sm" disabled={busy || !assignTo.length || selectedIds.length * assignTo.length > 200} onClick={() => void action(async () => {
            const available = await api.targets();
            const chosen = assignTo.map(id => {
              const target = available.find(t => t.id === id && t.enabled && t.seriesClassificationId === series.classificationId);
              if (!target) throw new Error("캐릭터를 다시 선택해 주세요.");
              return target;
            });
            await api.decideBatch(chosen.map(target => ({ targetId: target.id, expectedFingerprint: target.fingerprint, assetIds: selectedIds, decision: "accepted", baselineFingerprint: null, scanId: null })));
            setSelection(emptySelection()); setAssignTo([]);
          })}>지정{assignTo.length > 0 ? ` · ${assignTo.length}명` : ""}</Button>
          {!all && <><Button size="sm" variant="ghost" disabled={busy || selectedIds.length > 200} onClick={() => setManualName("")}>새 수동 캐릭터</Button>
            <Button size="sm" variant="ghost" disabled={busy || selectedIds.length > 200} onClick={() => void action(async () => {
              await hubApi.setSeriesAssetExcluded({ seriesId: series.classificationId, assetIds: selectedIds, excluded: true });
              setSelection(emptySelection());
            })}>캐릭터 분류 제외</Button></>}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setSelection(emptySelection())}>선택 해제</Button>
          {selectedIds.length * assignTo.length > 200 && <small role="status">이미지 수 × 캐릭터 수는 한 번에 200개까지 지정할 수 있습니다.</small>}
        </>}
      </div>}
      <AssetGallery {...(!picking ? galleryDrag : {})} intro={<>
        {!picking && !current && !excludedOnly && <div className="series-browser__overview">
          {!currentGroup && series.heroAssetId && <img className={`series-hero${privacyMode ? " character-private" : ""}`} src={assetUrl(series.heroAssetId)} alt={`${name} 히어로 이미지`} />}
          <CharacterGroups key={`${series.classificationId}:${currentGroup?.id ?? "series"}`} seriesId={series.classificationId} members={members} groups={groups.filter(group => group.seriesId === series.classificationId)} activeGroupId={currentGroup?.id} privacyMode={privacyMode}
            onOpenGroup={id => onNavigate({ kind: "classification", classificationId: series.classificationId, ...(id ? { characterGroupId: id } : {}) })}
            onGroupsChanged={onChanged}>{visibleMembers => <>{visibleMembers.map(target => <article className="series-character" key={target.id}>
              <button className="series-character__open" aria-label={`${target.displayName} 열기`} onClick={() => onNavigate({ kind: "classification", classificationId: series.classificationId, characterId: target.id })}>
                {(target.thumbnailAssetId ?? target.references.find(r => r.status === "ready")?.assetId) ? <img loading="lazy" className={privacyMode ? "character-private" : ""} src={thumbnailUrl((target.thumbnailAssetId ?? target.references.find(r => r.status === "ready")!.assetId)!)} alt="" /> : <span className="series-character__placeholder"><PhotoIcon aria-hidden="true" />대표 이미지</span>}
                <strong><span className="series-character__name">{target.displayName}</span>{target.ready && <CheckIcon className="series-character__ready" aria-label="기준 이미지 준비 완료" data-tooltip="기준 이미지 준비 완료" />}</strong>
                {target.manualOnly ? <small>수동 관리 · 기준 {target.references.filter(r => r.status === "ready").length}/5</small> : !target.ready && <small>기준 {target.references.filter(r => r.status === "ready").length}/5 · {target.enabled ? "준비 필요" : "비활성"}</small>}
              </button>
              <Button className="series-character__info" size="icon" variant="ghost" aria-label={`${target.displayName} 정보`} data-tooltip="캐릭터 정보" onClick={() => openEditor(target)}><InformationCircleIcon aria-hidden="true" /></Button>
            </article>)}</>}</CharacterGroups>
        </div>}
        {!picking && current?.description && <p className="series-description">{current.description}</p>}
        {picking && picking.kind !== "hero" && editor?.target ? <div className="series-gallery-heading"><h3>{pickFromSeries ? "시리즈에서 이미지 선택" : `${editor.target.displayName} 캐릭터 폴더`}<small>{page.totalCount}</small></h3><Button size="sm" variant="ghost" onClick={() => setPickFromSeries(v => !v)}>{pickFromSeries ? "캐릭터 폴더로 돌아가기" : "시리즈에서 이미지 찾기"}</Button></div>
          : currentGroup && !picking ? <div className="series-gallery-heading"><h3>{currentGroup.name} 이미지<small>{page.totalCount}</small></h3></div>
          : (!current || picking) && <div className="series-gallery-heading"><h3>{excludedOnly && !picking ? "캐릭터 분류 제외" : all ? picking && picking.kind !== "hero" ? "선택 가능한 전체" : "시리즈 전체" : "미분류 · 추가 확인"}<small>{page.totalCount}</small></h3>{!picking && excludedOnly ? <Button size="sm" variant="ghost" onClick={() => setExcludedOnly(false)}>미분류로 돌아가기</Button> : <><Button size="sm" variant="ghost" aria-pressed={all} onClick={() => setAll(v => !v)}>{all ? "미분류만 보기" : "전체 보기"}</Button>{!picking && !all && <Button size="sm" variant="ghost" onClick={() => { setExcludedOnly(true); setSelection(emptySelection()); }}>분류 제외 보기</Button>}</>}</div>}
        {error && <p className="character-message" role="alert">{error}<Button size="sm" onClick={() => setReload(v => v + 1)}>다시 시도</Button></p>}
        {!!undo.length && <div className="character-actions"><span>휴지통으로 이동했습니다.</span><Button size="sm" onClick={() => void action(async () => { await gateway.restoreAssets(undo); setUndo([]); })}>실행 취소</Button></div>}
        {!loading && !error && !page.items.length && <p className="series-gallery__empty">{picking ? "선택할 수 있는 이미지가 없습니다." : current ? "이 캐릭터의 이미지가 없습니다." : currentGroup ? "이 그룹에 연결된 이미지가 없습니다." : excludedOnly ? "캐릭터 분류에서 제외한 이미지가 없습니다." : "미분류 또는 추가 확인할 이미지가 없습니다."}</p>}
      </>} layout="masonry" groupDates items={page.items} scopeKey={scope} totalCount={page.totalCount} metadataVisible={metadataVisible} privacyMode={privacyMode} targetRowHeight={thumbnailRowHeight}
        selectedAssetIds={picking ? new Set(picking.ids) : selection.ids} focusAssetId={picking ? null : selection.focusId}
        hasNextPage={Boolean(page.nextCursor) && !loading && !error} onLoadNextPage={() => void load(page.nextCursor)}
        onSelectionGesture={(a,gesture) => picking ? choose(a.id) : setSelection(old => applySelectionGesture(old, ids, a.id, gesture))}
        onSelectAll={picking ? undefined : () => setSelection(old => selectAllLoaded(old, ids))} onClearSelection={() => picking ? setPicking({ ...picking, ids: [] }) : setSelection(emptySelection())}
        onMoveFocus={picking ? undefined : (delta,extend) => setSelection(old => moveSelectionFocus(old, ids, delta, extend))} onOpen={a => picking ? choose(a.id) : setViewer(a.id)} />
    </div></ContextMenu>
    {manualName !== null && <Dialog open title="새 수동 캐릭터" onClose={() => { if (!busy) setManualName(null); }}>
      <div className="character-manual-dialog">
        <p>선택한 {selectedIds.length.toLocaleString()}장을 바로 이 캐릭터로 지정합니다. 기준 이미지 5장은 필요하지 않으며, 나중에 5장을 채우면 자동 분류 캐릭터로 전환됩니다.</p>
        <TextField label="캐릭터 이름" value={manualName} disabled={busy} onChange={event => setManualName(event.target.value)} />
        <div className="character-actions"><Button disabled={busy || !manualName.trim()} onClick={() => void createManualCharacter()}>수동 캐릭터 만들기</Button><Button variant="ghost" disabled={busy} onClick={() => setManualName(null)}>취소</Button></div>
      </div>
    </Dialog>}
    {converting && current && <CharacterConversion targetId={current.id} onClose={() => setConverting(false)} onConverted={folderId => { setConverting(false); refresh(); onNavigate({ kind: "classification", classificationId: folderId }); }} />}
    {review && current && <CharacterLab refreshVersion={refreshVersion} api={api} classifications={classifications} initialSeriesId={series.classificationId} targetId={current.id} privacyMode={privacyMode} onEdit={() => { setReview(false); openEditor(current); }} onClose={() => { setReview(false); refresh(); }} />}
    <AssetInspector assets={page.items.filter(a => selection.ids.has(a.id))} open={inspector} onOpenChange={setInspector} onOpenAsset={a => setViewer(a.id)} onAssetUpdated={refresh} />
    <AssetViewer items={externalAsset && !page.items.some(a => a.id === externalAsset.id) ? [externalAsset, ...page.items] : page.items} activeId={viewer} onActiveIdChange={setViewer} onClose={() => setViewer(null)} privacyMode={privacyMode} onAssetOpened={a => gateway.recordAssetOpened(a.id, new Date().toISOString())} onToggleFavorite={a => void action(() => gateway.setAssetFavorite(a.id, !a.favorite))} onTrash={a => void action(() => gateway.trashAssets([a.id]))} />
  </section>;
}
