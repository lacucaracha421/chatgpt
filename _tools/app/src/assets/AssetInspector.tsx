import {
  ArrowTopRightOnSquareIcon,
  CheckIcon,
  ClipboardDocumentIcon,
  PencilSquareIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import { commandErrorMessage } from "../library/errorMessage";
import { useLibrary } from "../library/LibraryContext";
import type {
  AssetSummary,
  CollectionSummary,
} from "../library/types";
import { invalidateArtists } from "../artists/artistStore";
import type { ArtistStyleSuggestion } from "../artists/types";
import { Button } from "../shared/ui/Button";
import { TextField } from "../shared/ui/TextField";
import { Skeleton } from "../shared/ui/Skeleton";
import { Toast } from "../shared/ui/Toast";
import { useAutoDismiss } from "../shared/ui/useAutoDismiss";
import {
  creatorLabel,
  formatBytes,
  formatDuration,
  importSourceLabel,
  localDate,
  localDateTime,
  sourceLabel,
} from "./assetMetadata";
import { assetThumbnailUrl, thumbnailUrl } from "./mediaUrl";
import { AutoTagHighlights, AutoTagList, useAssetAutoTags } from "../autotags/AutoTagSections";

type Props = {
  assets: AssetSummary[];
  currentCollection?: CollectionSummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenAsset?: (asset: AssetSummary) => void;
  onAssetUpdated?: (asset: AssetSummary) => void;
  privacyMode?: boolean;
  /** After a 자동 태그 chip applied its tag as an 에셋 filter, e.g. to open the 에셋 screen. */
  onAutoTagFilterApplied?: () => void;
};

type MetadataDraft = {
  creatorName: string;
  creatorHandle: string;
  creatorUrl: string;
};

export function AssetInspector({
  assets,
  currentCollection = null,
  open,
  onOpenChange,
  onOpenAsset,
  onAssetUpdated = () => undefined,
  privacyMode = false,
  onAutoTagFilterApplied,
}: Props) {
  const { gateway } = useLibrary();
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  useAutoDismiss(copyError, setCopyError);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [draft, setDraft] = useState<MetadataDraft | null>(null);
  const [sourceGroup, setSourceGroup] = useState<AssetSummary[]>([]);
  const [styleSuggestion, setStyleSuggestion] = useState<ArtistStyleSuggestion | null>(null);
  const [styleSuggestionHidden, setStyleSuggestionHidden] = useState(false);
  const [styleSuggestionPending, setStyleSuggestionPending] = useState(false);
  const [styleSuggestionError, setStyleSuggestionError] = useState<string | null>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const restoreEditFocusRef = useRef(false);
  const assetIds = assets.map((asset) => asset.id).join(",");
  const asset = assets.length === 1 ? assets[0] : null;
  const autoTags = useAssetAutoTags(gateway.autoTags, open && asset ? asset.id : null, onAutoTagFilterApplied);

  useEffect(() => {
    setEditing(false);
    setDraft(null);
    setSaveError(null);
    setCopyError(null);
    setStyleSuggestion(null);
    setStyleSuggestionHidden(false);
    setStyleSuggestionError(null);
    setStyleSuggestionPending(false);
  }, [assetIds]);

  useEffect(() => {
    if (!editing && restoreEditFocusRef.current) {
      restoreEditFocusRef.current = false;
      inspectorRef.current?.focus();
    }
  }, [editing]);

  useEffect(() => {
    let active = true;
    if (!open || !asset) {
      setSourceGroup([]);
      return () => { active = false; };
    }
    if (typeof gateway.listSourceGroupAssets !== "function") {
      setSourceGroup([]);
      return () => { active = false; };
    }
    void gateway.listSourceGroupAssets(asset.id).then((group) => {
      if (active) setSourceGroup(group);
    }).catch(() => {
      if (active) setSourceGroup([]);
    });
    return () => { active = false; };
  }, [asset?.id, gateway, open]);

  useEffect(() => {
    let active = true;
    const styleGateway = gateway.artists;
    if (!open || !asset || !styleGateway) {
      setStyleSuggestion(null);
      return () => { active = false; };
    }
    void styleGateway.styleSuggestion(asset.id).then((suggestion) => {
      if (active) setStyleSuggestion(suggestion);
    }).catch(() => {
      if (active) setStyleSuggestion(null);
    });
    return () => { active = false; };
  }, [asset?.id, gateway.artists, open]);

  if (!open) return null;

  const copySource = async () => {
    if (!asset?.sourceUrl) return;
    try {
      await navigator.clipboard.writeText(asset.sourceUrl);
      setCopyError(null);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch (error) {
      setCopied(false);
      setCopyError(commandErrorMessage(error, "출처를 복사하지 못했습니다."));
    }
  };

  const beginEditing = () => {
    if (!asset) return;
    setDraft({
      creatorName: asset.creatorName ?? "",
      creatorHandle: asset.creatorHandle ?? "",
      creatorUrl: asset.creatorUrl ?? "",
    });
    setSaveError(null);
    setEditing(true);
  };

  const cancelEditing = () => {
    restoreEditFocusRef.current = true;
    setEditing(false);
    setDraft(null);
    setSaveError(null);
  };

  const saveMetadata = async () => {
    if (!asset || !draft || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await gateway.updateAssetMetadata({
        assetId: asset.id,
        sourcePublishedAt: asset.sourcePublishedAt,
        creatorName: nullable(draft.creatorName),
        creatorHandle: nullable(draft.creatorHandle),
        creatorUrl: nullable(draft.creatorUrl),
      });
      onAssetUpdated(updated);
      cancelEditing();
    } catch (error) {
      setSaveError(
        commandErrorMessage(error, "출처 정보를 저장하지 못했습니다."),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <aside
      ref={inspectorRef}
      tabIndex={-1}
      className="asset-inspector"
      aria-label="자산 정보"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        if (editing) {
          event.preventDefault();
          event.stopPropagation();
          cancelEditing();
        } else {
          onOpenChange(false);
        }
      }}
    >
      <header className="asset-inspector__header">
        {asset && !editing && (
          <Button
            size="icon"
            variant="ghost"
            aria-label="출처 정보 편집"
            onClick={beginEditing}
          >
            <PencilSquareIcon aria-hidden="true" />
          </Button>
        )}
        <Button
          size="icon"
          variant="ghost"
          aria-label="정보 닫기"
          onClick={() => onOpenChange(false)}
        >
          <XMarkIcon aria-hidden="true" />
        </Button>
      </header>
      {asset ? (
        <>
          <button
            type="button"
            className="asset-inspector__preview"
            aria-label={`${asset.title || asset.originalName} 감상 화면으로 열기`}
            onClick={() => onOpenAsset?.(asset)}
          >
            {privacyMode ? <span className="asset-inspector__preview-placeholder"><Skeleton className="privacy-mask" label="비공개 모드" /></span> : <img src={assetThumbnailUrl(asset)} alt="" loading="lazy" decoding="async" draggable={false} />}
          </button>
          {sourceGroup.length > 1 && (
            <section className="asset-inspector__section asset-inspector__source-group" aria-label="같은 게시물">
              <div className="asset-inspector__source-group-heading">
                <h3>같은 게시물</h3>
                <span>{sourceGroup.length}개</span>
              </div>
              <div className="asset-inspector__source-group-strip">
                {sourceGroup.map((sibling) => (
                  <button
                    key={sibling.id}
                    type="button"
                    className="asset-inspector__source-group-item"
                    aria-label={`${sibling.title || sibling.originalName} 같은 게시물에서 열기`}
                    aria-current={sibling.id === asset.id ? "true" : undefined}
                    onClick={() => onOpenAsset?.(sibling)}
                  >
                    {!privacyMode && <img src={assetThumbnailUrl(sibling)} alt="" loading="lazy" decoding="async" draggable={false} />}
                  </button>
                ))}
              </div>
            </section>
          )}
          <AutoTagHighlights state={autoTags.state} />
          <section className="asset-inspector__section">
            <h3>출처</h3>
            <dl className="asset-inspector__metadata">
              <div>
                <dt>{asset.sourceUrl ? <button type="button" className="asset-inspector__link" aria-label="출처 열기" onClick={() => void openUrl(asset.sourceUrl!)}><ArrowTopRightOnSquareIcon aria-hidden="true" />출처</button> : "출처"}</dt>
                <dd className="asset-inspector__source">
                  {asset.sourceUrl ? <>
                    <span className="asset-inspector__source-url" aria-description={asset.sourceUrl}>{sourceLabel(asset.sourceUrl)}</span>
                    <Button size="icon" variant="ghost" aria-label="출처 복사" onClick={() => void copySource()}>{copied ? <CheckIcon aria-hidden="true" /> : <ClipboardDocumentIcon aria-hidden="true" />}</Button>
                  </> : "—"}
                </dd>
              </div>
              <div>
                <dt>{asset.creatorUrl ? <button type="button" className="asset-inspector__link" aria-label="제작자 페이지 열기" onClick={() => void openUrl(asset.creatorUrl!)}><ArrowTopRightOnSquareIcon aria-hidden="true" />제작자</button> : "제작자"}</dt>
                <dd>{creatorLabel(asset.creatorName, asset.creatorHandle)}</dd>
              </div>
              <div>
                <dt>게시 시각</dt>
                <dd>{asset.sourcePublishedAt ? localDateTime(asset.sourcePublishedAt) : "—"}</dd>
              </div>
            </dl>
          </section>
          {styleSuggestion && !styleSuggestionHidden && <AssetStyleSuggestionBox suggestion={styleSuggestion} privacyMode={privacyMode} pending={styleSuggestionPending} error={styleSuggestionError}
            onOpen={(assetId) => {
              void gateway.getAsset(assetId).then((item) => onOpenAsset?.(item), () => undefined);
            }}
            onAssign={() => void (async () => {
              if (!gateway.artists || styleSuggestionPending) return;
              setStyleSuggestionPending(true); setStyleSuggestionError(null);
              try {
                await gateway.artists.assignAssets([asset.id], { artistId: styleSuggestion.artist.id });
                setStyleSuggestionHidden(true);
                invalidateArtists();
              } catch (cause) {
                setStyleSuggestionError(commandErrorMessage(cause, "작가를 지정하지 못했습니다."));
              } finally { setStyleSuggestionPending(false); }
            })()}
            onDismiss={() => void (async () => {
              if (!gateway.artists || styleSuggestionPending) return;
              setStyleSuggestionPending(true); setStyleSuggestionError(null);
              try {
                await gateway.artists.dismissStyleSuggestion([asset.id], styleSuggestion.artist.id);
                setStyleSuggestionHidden(true);
                invalidateArtists();
              } catch (cause) {
                setStyleSuggestionError(commandErrorMessage(cause, "추천을 제외하지 못했습니다."));
              } finally { setStyleSuggestionPending(false); }
            })()} />}
          <AutoTagList state={autoTags.state} />
          <section className="asset-inspector__section">
            <h3>파일</h3>
            <dl className="asset-inspector__metadata">
              <div><dt>해상도</dt><dd>{asset.width}×{asset.height}</dd></div>
              <div><dt>크기</dt><dd>{formatBytes(asset.byteSize)}</dd></div>
              {asset.media.kind === "video" && <div><dt>재생 시간</dt><dd>{formatDuration(asset.media.durationMs)}</dd></div>}
            </dl>
          </section>
          <section className="asset-inspector__section">
            <h3>가져오기</h3>
            <dl className="asset-inspector__metadata">
              <div><dt>가져온 날짜</dt><dd>{localDate(asset.collectedAt)}</dd></div>
              <div><dt>가져온 방식</dt><dd>{importSourceLabel(asset.importSource)}</dd></div>
            </dl>
          </section>
          {editing && draft ? (
            <div className="asset-inspector__metadata-editor">
              <TextField autoFocus label="제작자 이름" value={draft.creatorName} onChange={(event) => setDraft({ ...draft, creatorName: event.target.value })} />
              <TextField label="계정명" value={draft.creatorHandle} onChange={(event) => setDraft({ ...draft, creatorHandle: event.target.value })} />
              <TextField label="제작자 URL" type="url" value={draft.creatorUrl} onChange={(event) => setDraft({ ...draft, creatorUrl: event.target.value })} />
              {saveError && <p className="asset-inspector__save-error" role="alert">{saveError}</p>}
              <div className="asset-inspector__metadata-actions">
                <Button variant="ghost" disabled={saving} onClick={cancelEditing}>취소</Button>
                <Button variant="primary" disabled={saving} onClick={() => void saveMetadata()}>저장</Button>
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <p>{assets.length > 0 ? `${assets.length}개 자산 선택` : "선택한 자산이 없습니다."}</p>
      )}
      {currentCollection && assets.length === 1 && (
        <section className="asset-inspector__collection-info" aria-label="컬렉션 정보">
          <h3>{currentCollection.name}</h3>
          {currentCollection.description?.trim() && (
            <p className="asset-inspector__collection-description">{currentCollection.description}</p>
          )}
          <dl>
            {currentCollection.type === "game" && (
              <>
                {currentCollection.author && <div><dt>제작사</dt><dd>{currentCollection.author}</dd></div>}
                {currentCollection.externalScore != null && <div><dt>외부 점수</dt><dd>{currentCollection.externalScore}</dd></div>}
                {currentCollection.myScore != null && <div><dt>내 점수</dt><dd>{currentCollection.myScore}</dd></div>}
              </>
            )}
            {currentCollection.type === "manga" && (
              <>
                {currentCollection.author && <div><dt>작가</dt><dd>{currentCollection.author}</dd></div>}
                {currentCollection.year != null && <div><dt>출간 연도</dt><dd>{currentCollection.year}</dd></div>}
              </>
            )}
            {currentCollection.type === "movie" && (
              <>
                {currentCollection.director && <div><dt>감독</dt><dd>{currentCollection.director}</dd></div>}
                {currentCollection.year != null && <div><dt>개봉 연도</dt><dd>{currentCollection.year}</dd></div>}
              </>
            )}
          </dl>
        </section>
      )}
      {copyError && <Toast tone="error" onDismiss={() => setCopyError(null)}>{copyError}</Toast>}
      {autoTags.notices}
    </aside>
  );
}

function AssetStyleSuggestionBox({ suggestion, privacyMode, pending, error, onOpen, onAssign, onDismiss }: {
  suggestion: ArtistStyleSuggestion;
  privacyMode: boolean;
  pending: boolean;
  error: string | null;
  onOpen: (assetId: string) => void;
  onAssign: () => void;
  onDismiss: () => void;
}) {
  return <section className="asset-inspector__style-suggestion" aria-label="닮은 작가">
    <div className="asset-inspector__style-heading">
      <span className="asset-inspector__style-avatar">{!privacyMode && suggestion.artist.coverAssetIds[0] && <img src={thumbnailUrl(suggestion.artist.coverAssetIds[0])} alt="" loading="lazy" decoding="async" draggable={false} />}</span>
      <span className="asset-inspector__style-copy">
        <span className="asset-inspector__style-kicker">닮은 작가 · 유사도 {suggestion.score.toFixed(2)}</span>
        <strong className="artist-name">{suggestion.artist.label}</strong>
      </span>
    </div>
    <p className="asset-inspector__style-reference-label">이 작가의 가장 비슷한 그림</p>
    <div className="asset-inspector__style-references">
      {suggestion.referenceAssetIds.slice(0, 3).map((assetId, index) => <button key={assetId} type="button" aria-label={`${suggestion.artist.label} 참고 이미지 ${index + 1} 열기`} onClick={() => onOpen(assetId)}>
        {!privacyMode && <img src={thumbnailUrl(assetId)} alt="" loading="lazy" decoding="async" draggable={false} />}
      </button>)}
    </div>
    <div className="asset-inspector__style-actions">
      <Button size="sm" variant="primary" disabled={pending} onClick={onAssign}>{suggestion.artist.label}로 지정</Button>
      <Button size="sm" disabled={pending} onClick={onDismiss}>아님</Button>
    </div>
    {suggestion.runnerUp && <p className="asset-inspector__style-runner">다음 후보: {suggestion.runnerUp.artist.label} {suggestion.runnerUp.score.toFixed(2)}</p>}
    {error && <p className="asset-inspector__save-error" role="alert">{error}</p>}
  </section>;
}

function nullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed || null;
}
