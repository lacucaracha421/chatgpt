import { useHorizontalWheel } from "../shared/ui/useHorizontalWheel";
import { ArrowTopRightOnSquareIcon, CheckIcon, ChevronRightIcon, ClipboardDocumentIcon, PencilSquareIcon } from "@heroicons/react/24/outline";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { artistHandle } from "../artists/format";
import { invalidateArtists } from "../artists/artistStore";
import type { ArtistStyleSuggestion, ArtistSummary } from "../artists/types";
import { AutoTagHighlights, AutoTagList, useAssetAutoTags } from "../autotags/AutoTagSections";
import { commandErrorMessage } from "../library/errorMessage";
import { useLibrary } from "../library/LibraryContext";
import type { AssetSummary, ClassificationEntry, CollectionSummary } from "../library/types";
import { breadcrumbPath } from "../shared/breadcrumb";
import { displayDateTime } from "../shared/displayDate";
import { formatBytes } from "../shared/formatBytes";
import { Button } from "../shared/ui/Button";
import { SectionLabel } from "../shared/ui/SectionLabel";
import { Skeleton } from "../shared/ui/Skeleton";
import { TextField } from "../shared/ui/TextField";
import { Toast } from "../shared/ui/Toast";
import { useAutoDismiss } from "../shared/ui/useAutoDismiss";
import { formatDuration, importSourceLabel, sourceLabel } from "./assetMetadata";
import { assetThumbnailUrl, thumbnailUrl } from "./mediaUrl";

type Props = {
  assets: AssetSummary[];
  currentCollection?: CollectionSummary | null;
  classifications?: ClassificationEntry[];
  onOpenAsset?: (asset: AssetSummary) => void;
  onAssetUpdated?: (asset: AssetSummary) => void;
  onAutoTagFilterApplied?: () => void;
  onOpenArtist?: (artistId: string) => void;
  privacyMode?: boolean;
};

type MetadataDraft = { creatorName: string; creatorHandle: string; creatorUrl: string };
const EMPTY_CLASSIFICATIONS: ClassificationEntry[] = [];

export function AssetInfoPanel({
  assets,
  currentCollection = null,
  classifications = EMPTY_CLASSIFICATIONS,
  onOpenAsset,
  onAssetUpdated = () => undefined,
  onAutoTagFilterApplied,
  onOpenArtist,
  privacyMode = false,
}: Props) {
  const { gateway } = useLibrary();
  const rootRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<MetadataDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const editSession = useRef(0);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [sourceGroup, setSourceGroup] = useState<AssetSummary[]>([]);
  const [folderPaths, setFolderPaths] = useState<string[]>([]);
  const [artist, setArtist] = useState<ArtistSummary | null>(null);
  const [styleSuggestion, setStyleSuggestion] = useState<ArtistStyleSuggestion | null>(null);
  const [styleSuggestionHidden, setStyleSuggestionHidden] = useState(false);
  const [styleSuggestionPending, setStyleSuggestionPending] = useState(false);
  const [styleSuggestionError, setStyleSuggestionError] = useState<string | null>(null);
  useAutoDismiss(copyError, setCopyError);
  const assetIds = assets.map((item) => item.id).join(",");
  const asset = assets.length === 1 ? assets[0] : null;
  const autoTags = useAssetAutoTags(gateway.autoTags, asset?.id ?? null, onAutoTagFilterApplied);

  useEffect(() => {
    ++editSession.current;
    setSaving(false);
    setEditing(false);
    setDraft(null);
    setSaveError(null);
    setCopyError(null);
    setStyleSuggestion(null);
    setStyleSuggestionHidden(false);
    setStyleSuggestionError(null);
    return () => { ++editSession.current; };
  }, [assetIds]);

  useEffect(() => {
    let active = true;
    if (!asset || typeof gateway.listSourceGroupAssets !== "function") { setSourceGroup([]); return; }
    void gateway.listSourceGroupAssets(asset.id).then((items) => { if (active) setSourceGroup(items); }, () => { if (active) setSourceGroup([]); });
    return () => { active = false; };
  }, [asset?.id, gateway]);

  useEffect(() => {
    let active = true;
    if (!asset || typeof gateway.getAssetClassifications !== "function") { setFolderPaths([]); return; }
    void gateway.getAssetClassifications(asset.id).then((ids) => {
      if (!active) return;
      setFolderPaths(ids.map((id) => classifications.find((entry) => entry.id === id)).filter((entry): entry is ClassificationEntry => Boolean(entry)).map((entry) => breadcrumbPath(entry, classifications)));
    }, () => { if (active) setFolderPaths([]); });
    return () => { active = false; };
  }, [asset?.id, classifications, gateway]);

  useEffect(() => {
    let active = true;
    const artists = gateway.artists;
    const query = asset?.creatorHandle || asset?.creatorName || asset?.creatorUrl;
    if (!asset || !artists || typeof artists.list !== "function" || !query) { setArtist(null); return; }
    void artists.list({ search: query, limit: 20 }).then((page) => {
      if (!active) return;
      const keys = [asset.creatorHandle?.replace(/^@+/, ""), asset.creatorUrl].filter(Boolean);
      setArtist(page.artists.find((item) => item.keys.some((key) => keys.includes(key)) || item.label === asset.creatorName) ?? null);
    }, () => { if (active) setArtist(null); });
    return () => { active = false; };
  }, [asset?.id, asset?.creatorHandle, asset?.creatorName, asset?.creatorUrl, gateway.artists]);

  useEffect(() => {
    let active = true;
    const artists = gateway.artists;
    if (!asset || !artists || typeof artists.styleSuggestion !== "function") { setStyleSuggestion(null); return; }
    void artists.styleSuggestion(asset.id).then((suggestion) => { if (active) setStyleSuggestion(suggestion); }, () => { if (active) setStyleSuggestion(null); });
    return () => { active = false; };
  }, [asset?.id, gateway.artists]);

  const artistKeys = useMemo(() => artist?.keys ?? [asset?.creatorHandle?.replace(/^@+/, ""), asset?.creatorUrl].filter((key): key is string => Boolean(key)), [artist, asset?.creatorHandle, asset?.creatorUrl]);
  const handle = artistHandle({ keys: artistKeys });

  const handleEscape = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || !editing) return;
    event.preventDefault();
    event.stopPropagation();
    setEditing(false);
    setDraft(null);
    setSaveError(null);
    rootRef.current?.querySelector<HTMLButtonElement>("[data-edit-source]")?.focus();
  };

  if (!asset) return <div ref={rootRef} className="asset-info-panel">{assets.length > 0 ? `${assets.length}개 자산 선택` : "선택한 자산이 없습니다."}</div>;

  const beginEditing = () => {
    setDraft({ creatorName: asset.creatorName ?? "", creatorHandle: asset.creatorHandle ?? "", creatorUrl: asset.creatorUrl ?? "" });
    setSaveError(null);
    setEditing(true);
  };
  const cancelEditing = () => { setEditing(false); setDraft(null); setSaveError(null); };
  const saveMetadata = async () => {
    if (!draft || saving) return;
    const session = editSession.current;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await gateway.updateAssetMetadata({ assetId: asset.id, sourcePublishedAt: asset.sourcePublishedAt, creatorName: nullable(draft.creatorName), creatorHandle: nullable(draft.creatorHandle), creatorUrl: nullable(draft.creatorUrl) });
      onAssetUpdated(updated);
      if (session === editSession.current) cancelEditing();
    } catch (error) {
      if (session === editSession.current) setSaveError(commandErrorMessage(error, "출처 정보를 저장하지 못했습니다."));
    } finally { if (session === editSession.current) setSaving(false); }
  };
  const copySource = async () => {
    if (!asset.sourceUrl) return;
    try { await navigator.clipboard.writeText(asset.sourceUrl); setCopyError(null); setCopied(true); window.setTimeout(() => setCopied(false), 1_500); }
    catch (error) { setCopied(false); setCopyError(commandErrorMessage(error, "출처를 복사하지 못했습니다.")); }
  };
  const openArtist = () => {
    const key = artist?.id ?? asset.creatorHandle?.replace(/^@+/, "") ?? asset.creatorUrl;
    if (key && onOpenArtist) onOpenArtist(key); else if (asset.creatorUrl) void openUrl(asset.creatorUrl);
  };

  return <div ref={rootRef} className="asset-info-panel" onKeyDown={handleEscape}>
    {/* Image left; artist, source and file facts gathered on its right. */}
    <section className="asset-info-panel__head" data-info-section="artist">
      <button type="button" className="asset-inspector__preview" aria-label={`${asset.title || asset.originalName} 감상 화면으로 열기`} onClick={() => onOpenAsset?.(asset)}>
        {privacyMode ? <span className="asset-inspector__preview-placeholder"><Skeleton className="privacy-mask" label="비공개 모드" /></span> : <img src={assetThumbnailUrl(asset)} alt="" loading="lazy" decoding="async" draggable={false} />}
      </button>
      <div className="asset-info-panel__facts">
        <div className="asset-info-panel__artist-copy">
          <div className="asset-info-panel__artist-line"><strong className="artist-name">{artist?.label ?? asset.creatorName ?? handle ?? "작가 미상"}</strong><Button data-edit-source size="icon" variant="ghost" aria-label="출처 정보 편집" onClick={beginEditing}><PencilSquareIcon aria-hidden="true" /></Button></div>
          <span>{handle ?? "계정 정보 없음"}{artist ? ` · 모은 그림 ${artist.assetCount.toLocaleString("ko-KR")}장` : ""}</span>
          {(artist?.id || asset.creatorHandle || asset.creatorUrl) && (onOpenArtist || asset.creatorUrl) && <Button size="sm" variant="quiet" className="asset-info-panel__artist-link" onClick={openArtist}>작가 페이지 <ChevronRightIcon aria-hidden="true" /></Button>}
        </div>
        <dl className="asset-info-panel__facts-list" data-info-section="source" aria-label="출처와 파일">
          <div><dt>{asset.sourceUrl ? <button type="button" className="asset-inspector__link" aria-label="출처 열기" onClick={() => void openUrl(asset.sourceUrl!)}>게시물<ArrowTopRightOnSquareIcon aria-hidden="true" /></button> : "게시물"}</dt><dd className="asset-inspector__source">{asset.sourceUrl ? <><span className="asset-inspector__source-url" aria-description={asset.sourceUrl}>{sourceLabel(asset.sourceUrl)}</span><Button size="icon" variant="ghost" aria-label="출처 복사" onClick={() => void copySource()}>{copied ? <CheckIcon aria-hidden="true" /> : <ClipboardDocumentIcon aria-hidden="true" />}</Button></> : "—"}</dd></div>
          <div><dt>게시</dt><dd>{displayDateTime(asset.sourcePublishedAt, new Date(), { withTime: true }) || "—"}</dd></div>
          <div data-info-section="file"><dt>파일</dt><dd><span>{asset.width}×{asset.height}</span> · <span>{formatBytes(asset.byteSize)}</span>{asset.media.kind === "video" && <> · <span>{formatDuration(asset.media.durationMs)}</span></>}</dd></div>
          <div><dt>가져옴</dt><dd><span>{displayDateTime(asset.collectedAt, new Date(), { withTime: true }) || "—"}</span> · <span>{importSourceLabel(asset.importSource)}</span></dd></div>
          <div><dt>폴더</dt><dd title={folderPaths.join(" · ")}>{folderPaths.join(" · ") || "—"}</dd></div>
        </dl>
      </div>
    </section>
    {editing && draft && <div className="asset-inspector__metadata-editor">
      <TextField autoFocus label="제작자 이름" value={draft.creatorName} onChange={(event) => setDraft({ ...draft, creatorName: event.target.value })} />
      <TextField label="계정명" value={draft.creatorHandle} onChange={(event) => setDraft({ ...draft, creatorHandle: event.target.value })} />
      <TextField label="제작자 URL" type="url" value={draft.creatorUrl} onChange={(event) => setDraft({ ...draft, creatorUrl: event.target.value })} />
      {saveError && <p className="asset-inspector__save-error" role="alert">{saveError}</p>}
      <div className="asset-inspector__metadata-actions"><Button variant="ghost" disabled={saving} onClick={cancelEditing}>취소</Button><Button variant="primary" disabled={saving} onClick={() => void saveMetadata()}>저장</Button></div>
    </div>}
    {sourceGroup.length > 1 && <section className="asset-inspector__section asset-inspector__source-group" data-info-section="same-post" aria-label="같은 게시물">
      <SectionLabel as="h3" title="같은 게시물" count={sourceGroup.length} />
      <div className="asset-inspector__source-group-strip">{sourceGroup.map((sibling) => <button key={sibling.id} type="button" className="asset-inspector__source-group-item" aria-label={`${sibling.title || sibling.originalName} 같은 게시물에서 열기`} aria-current={sibling.id === asset.id ? "true" : undefined} onClick={() => onOpenAsset?.(sibling)}>{!privacyMode && <img src={assetThumbnailUrl(sibling)} alt="" loading="lazy" decoding="async" draggable={false} />}</button>)}</div>
    </section>}
    <section className="asset-inspector__section" data-info-section="tags"><AutoTagHighlights state={autoTags.state} /><AutoTagList state={autoTags.state} /></section>
    {currentCollection && <CollectionInfo collection={currentCollection} />}
    {styleSuggestion && !styleSuggestionHidden && <AssetStyleSuggestionBox suggestion={styleSuggestion} privacyMode={privacyMode} pending={styleSuggestionPending} error={styleSuggestionError} onOpen={(id) => { void gateway.getAsset(id).then((item) => onOpenAsset?.(item), () => undefined); }} onAssign={() => void (async () => { if (!gateway.artists || styleSuggestionPending) return; setStyleSuggestionPending(true); setStyleSuggestionError(null); try { await gateway.artists.assignAssets([asset.id], { artistId: styleSuggestion.artist.id }); setStyleSuggestionHidden(true); invalidateArtists(); } catch (error) { setStyleSuggestionError(commandErrorMessage(error, "작가를 지정하지 못했습니다.")); } finally { setStyleSuggestionPending(false); } })()} onDismiss={() => void (async () => { if (!gateway.artists || styleSuggestionPending) return; setStyleSuggestionPending(true); setStyleSuggestionError(null); try { await gateway.artists.dismissStyleSuggestion([asset.id], styleSuggestion.artist.id); setStyleSuggestionHidden(true); invalidateArtists(); } catch (error) { setStyleSuggestionError(commandErrorMessage(error, "추천을 제외하지 못했습니다.")); } finally { setStyleSuggestionPending(false); } })()} />}
    {copyError && <Toast tone="error" onDismiss={() => setCopyError(null)}>{copyError}</Toast>}
    {autoTags.notices}
  </div>;
}

function CollectionInfo({ collection }: { collection: CollectionSummary }) {
  return <section className="asset-inspector__collection-info" data-info-section="collection" aria-label="컬렉션 정보"><SectionLabel as="h3" title="컬렉션" /><strong className="asset-inspector__collection-name">{collection.name}</strong>{collection.description?.trim() && <p className="asset-inspector__collection-description">{collection.description}</p>}<dl>
    {collection.type === "game" && <>{collection.author && <div><dt>제작사</dt><dd>{collection.author}</dd></div>}{collection.externalScore != null && <div><dt>외부 점수</dt><dd>{collection.externalScore}</dd></div>}{collection.myScore != null && <div><dt>내 점수</dt><dd>{collection.myScore}</dd></div>}</>}
    {collection.type === "manga" && <>{collection.author && <div><dt>작가</dt><dd>{collection.author}</dd></div>}{collection.year != null && <div><dt>출간 연도</dt><dd>{collection.year}</dd></div>}</>}
    {collection.type === "movie" && <>{collection.director && <div><dt>감독</dt><dd>{collection.director}</dd></div>}{collection.year != null && <div><dt>개봉 연도</dt><dd>{collection.year}</dd></div>}</>}
  </dl></section>;
}

function AssetStyleSuggestionBox({ suggestion, privacyMode, pending, error, onOpen, onAssign, onDismiss }: { suggestion: ArtistStyleSuggestion; privacyMode: boolean; pending: boolean; error: string | null; onOpen: (assetId: string) => void; onAssign: () => void; onDismiss: () => void }) {
  const stripWheel = useHorizontalWheel();
  return <section className="asset-inspector__style-suggestion" data-info-section="similar-artist" aria-label="닮은 작가"><div className="asset-inspector__style-heading"><span className="asset-inspector__style-avatar">{!privacyMode && suggestion.artist.coverAssetIds[0] && <img src={thumbnailUrl(suggestion.artist.coverAssetIds[0])} alt="" loading="lazy" decoding="async" draggable={false} />}</span><span className="asset-inspector__style-copy"><span className="asset-inspector__style-kicker">닮은 작가 · 유사도 {suggestion.score.toFixed(2)}</span><strong className="artist-name">{suggestion.artist.label}</strong></span></div><p className="asset-inspector__style-reference-label">이 작가의 가장 비슷한 그림</p><div ref={stripWheel} className="asset-inspector__style-references">{suggestion.referenceAssetIds.slice(0, 3).map((id, index) => <button key={id} type="button" aria-label={`${suggestion.artist.label} 참고 이미지 ${index + 1} 열기`} onClick={() => onOpen(id)}>{!privacyMode && <img src={thumbnailUrl(id)} alt="" loading="lazy" decoding="async" draggable={false} />}</button>)}</div><div className="asset-inspector__style-actions"><Button size="sm" variant="primary" disabled={pending} onClick={onAssign}>{suggestion.artist.label}로 지정</Button><Button size="sm" disabled={pending} onClick={onDismiss}>아님</Button></div>{suggestion.runnerUp && <p className="asset-inspector__style-runner">다음 후보: {suggestion.runnerUp.artist.label} {suggestion.runnerUp.score.toFixed(2)}</p>}{error && <p className="asset-inspector__save-error" role="alert">{error}</p>}</section>;
}

function nullable(value: string): string | null { return value.trim() || null; }
