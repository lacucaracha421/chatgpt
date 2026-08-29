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
import { Button } from "../shared/ui/Button";
import { TextField } from "../shared/ui/TextField";
import {
  creatorLabel,
  formatBytes,
  formatDuration,
  importSourceLabel,
  localDate,
  localDateTime,
  sourceLabel,
} from "./assetMetadata";
import { thumbnailUrl } from "./mediaUrl";

type Props = {
  assets: AssetSummary[];
  currentCollection?: CollectionSummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenAsset?: (asset: AssetSummary) => void;
  onAssetUpdated?: (asset: AssetSummary) => void;
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
}: Props) {
  const { gateway } = useLibrary();
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [draft, setDraft] = useState<MetadataDraft | null>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const restoreEditFocusRef = useRef(false);
  const assetIds = assets.map((asset) => asset.id).join(",");

  useEffect(() => {
    setEditing(false);
    setDraft(null);
    setSaveError(null);
  }, [assetIds]);

  useEffect(() => {
    if (!editing && restoreEditFocusRef.current) {
      restoreEditFocusRef.current = false;
      inspectorRef.current?.focus();
    }
  }, [editing]);

  if (!open) return null;
  const asset = assets.length === 1 ? assets[0] : null;

  const copySource = async () => {
    if (!asset?.sourceUrl) return;
    try {
      await navigator.clipboard.writeText(asset.sourceUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
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
            <img src={thumbnailUrl(asset.id)} alt="" loading="lazy" decoding="async" draggable={false} />
          </button>
          <section className="asset-inspector__section">
            <h3>출처</h3>
            <dl className="asset-inspector__metadata">
              <div>
                <dt>{asset.sourceUrl ? <button type="button" className="asset-inspector__link" aria-label="출처 열기" onClick={() => void openUrl(asset.sourceUrl!)}><ArrowTopRightOnSquareIcon aria-hidden="true" />출처</button> : "출처"}</dt>
                <dd className="asset-inspector__source">
                  {asset.sourceUrl ? <>
                    <span className="asset-inspector__source-url" title={asset.sourceUrl}>{sourceLabel(asset.sourceUrl)}</span>
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
    </aside>
  );
}

function nullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed || null;
}
