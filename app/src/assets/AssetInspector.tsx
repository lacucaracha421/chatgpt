import {
  ArrowTopRightOnSquareIcon,
  CheckIcon,
  MinusIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import { commandErrorMessage } from "../library/errorMessage";
import { useLibrary } from "../library/LibraryContext";
import type {
  AlbumEntry,
  AssetSummary,
  ClassificationEntry,
} from "../library/types";
import { Button } from "../shared/ui/Button";
import { TextField } from "../shared/ui/TextField";
import {
  creatorLabel,
  formatBytes,
  importSourceLabel,
  localDate,
  localDateTime,
  sourceLabel,
} from "./assetMetadata";

type Props = {
  assets: AssetSummary[];
  classifications: ClassificationEntry[];
  albums: AlbumEntry[];
  open: boolean;
  membershipVersion?: number;
  onOpenChange: (open: boolean) => void;
  onMoveToFolder: (classificationId: string | null) => void;
  onPatchAlbum: (albumId: string, operation: "add" | "remove") => void;
  onAssetUpdated?: (asset: AssetSummary) => void;
};

type MetadataDraft = {
  sourcePublishedAt: string;
  creatorName: string;
  creatorHandle: string;
  creatorUrl: string;
};

export function AssetInspector({
  assets,
  classifications,
  albums,
  open,
  membershipVersion = 0,
  onOpenChange,
  onMoveToFolder,
  onPatchAlbum,
  onAssetUpdated = () => undefined,
}: Props) {
  const { gateway } = useLibrary();
  const [folderIds, setFolderIds] = useState<Array<string | null>>([]);
  const [albumIds, setAlbumIds] = useState<string[]>([]);
  const [membershipError, setMembershipError] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [draft, setDraft] = useState<MetadataDraft | null>(null);
  const reloadRef = useRef(0);
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

  useEffect(() => {
    if (!open || assets.length === 0) return;
    const reload = ++reloadRef.current;
    setMembershipError(false);
    void Promise.all(
      assets.map(async (asset) => {
        const [folders, memberships] = await Promise.all([
          gateway.getAssetClassifications(asset.id),
          gateway.getAssetAlbums(asset.id),
        ]);
        return { folderId: folders[0] ?? null, albumIds: memberships };
      }),
    )
      .then((results) => {
        if (reload === reloadRef.current) {
          setFolderIds(results.map((result) => result.folderId));
          setAlbumIds(results.flatMap((result) => result.albumIds));
        }
      })
      .catch(() => {
        if (reload === reloadRef.current) setMembershipError(true);
      });
  }, [assetIds, assets, gateway, membershipVersion, open]);

  if (!open) return null;
  const asset = assets.length === 1 ? assets[0] : null;

  const beginEditing = () => {
    if (!asset) return;
    setDraft({
      sourcePublishedAt: asset.sourcePublishedAt ?? "",
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
        sourcePublishedAt: nullable(draft.sourcePublishedAt),
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
        <h2>정보</h2>
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
          <dl className="asset-inspector__metadata">
            <div><dt>파일명</dt><dd>{asset.originalName}</dd></div>
            <div><dt>출처</dt><dd>{sourceLabel(asset.sourceUrl)}</dd></div>
            <div><dt>가져온 날짜</dt><dd>{localDate(asset.collectedAt)}</dd></div>
            <div><dt>크기</dt><dd>{formatBytes(asset.byteSize)}</dd></div>
            <div><dt>제작자</dt><dd>{creatorLabel(asset.creatorName, asset.creatorHandle)}</dd></div>
            <div><dt>게시 시각</dt><dd>{localDateTime(asset.sourcePublishedAt)}</dd></div>
            <div><dt>가져온 방식</dt><dd>{importSourceLabel(asset.importSource)}</dd></div>
            <div><dt>원본 수정 시각</dt><dd>{localDateTime(asset.originalModifiedAt)}</dd></div>
            {asset.importBatchId && (
              <div><dt>가져오기 작업</dt><dd className="asset-inspector__batch-id">{asset.importBatchId}</dd></div>
            )}
          </dl>
          <div className="asset-inspector__link-actions">
            {asset.sourceUrl && (
              <Button variant="ghost" onClick={() => void openUrl(asset.sourceUrl!)}>
                <ArrowTopRightOnSquareIcon aria-hidden="true" />출처 열기
              </Button>
            )}
            {asset.creatorUrl && (
              <Button
                variant="ghost"
                aria-label="제작자 페이지 열기"
                onClick={() => void openUrl(asset.creatorUrl!)}
              >
                <ArrowTopRightOnSquareIcon aria-hidden="true" />제작자
              </Button>
            )}
          </div>
          {editing && draft ? (
            <div className="asset-inspector__metadata-editor">
              <TextField autoFocus label="게시 시각" value={draft.sourcePublishedAt} onChange={(event) => setDraft({ ...draft, sourcePublishedAt: event.target.value })} />
              <TextField label="제작자 이름" value={draft.creatorName} onChange={(event) => setDraft({ ...draft, creatorName: event.target.value })} />
              <TextField label="계정명" value={draft.creatorHandle} onChange={(event) => setDraft({ ...draft, creatorHandle: event.target.value })} />
              <TextField label="제작자 URL" type="url" value={draft.creatorUrl} onChange={(event) => setDraft({ ...draft, creatorUrl: event.target.value })} />
              {saveError && <p className="asset-inspector__save-error" role="alert">{saveError}</p>}
              <div className="asset-inspector__metadata-actions">
                <Button variant="ghost" disabled={saving} onClick={cancelEditing}>취소</Button>
                <Button variant="primary" disabled={saving} onClick={() => void saveMetadata()}>저장</Button>
              </div>
            </div>
          ) : (
            <Button variant="ghost" aria-label="출처 정보 편집" onClick={beginEditing}>편집</Button>
          )}
        </>
      ) : (
        <p>{assets.length > 0 ? `${assets.length}개 자산 선택` : "선택한 자산이 없습니다."}</p>
      )}
      {assets.length > 0 && (
        <section className="asset-inspector__classifications" aria-labelledby="asset-inspector-classifications">
          <h3 id="asset-inspector-classifications">정리</h3>
          {membershipError ? (
            <p className="asset-inspector__membership-error">폴더와 앨범 상태를 불러오지 못했습니다.</p>
          ) : (
            <>
              <label className="asset-inspector__folder-select">
                <span>폴더</span>
                <select aria-label="폴더" value={commonFolderValue(folderIds)} onChange={(event) => onMoveToFolder(event.target.value || null)}>
                  {commonFolderValue(folderIds) === "__mixed" && <option value="__mixed" disabled>여러 폴더</option>}
                  <option value="">미분류</option>
                  {classifications.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
                </select>
              </label>
              <h4>앨범</h4>
              <ul>{albums.map((entry) => {
                const count = albumIds.filter((id) => id === entry.id).length;
                const checked = count === assets.length;
                const indeterminate = count > 0 && !checked;
                return (
                  <li key={entry.id}>
                    <label className="asset-inspector__classification">
                      <input type="checkbox" checked={checked} aria-label={`${entry.name} 앨범`} ref={(element) => { if (element) element.indeterminate = indeterminate; }} onChange={() => onPatchAlbum(entry.id, checked ? "remove" : "add")} />
                      {indeterminate ? <MinusIcon aria-hidden="true" className="asset-inspector__checkbox-icon" /> : <CheckIcon aria-hidden="true" className="asset-inspector__checkbox-icon" />}
                      <span>{entry.name}</span>
                    </label>
                  </li>
                );
              })}</ul>
            </>
          )}
        </section>
      )}
    </aside>
  );
}

function nullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed || null;
}

function commonFolderValue(folderIds: Array<string | null>): string {
  if (folderIds.length === 0) return "";
  return folderIds.every((id) => id === folderIds[0]) ? folderIds[0] ?? "" : "__mixed";
}
