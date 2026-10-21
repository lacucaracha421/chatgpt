import { useRef, useState } from "react";
import type { CharacterTarget } from "../../characters/api";
import type { CharacterBrowsePage } from "../../characters/hubApi";
import type { FavoriteEntry, FavoriteSet } from "../../library/types";
import { AssetGallery } from "../../assets/AssetGallery";
import { thumbnailUrl } from "../../assets/mediaUrl";
import { AssetImage } from "../../privacy/AssetImage";
import { usePrivacy } from "../../privacy/PrivacyContext";
import { Button } from "../../shared/ui/Button";
import { Dialog } from "../../shared/ui/Dialog";
import { TextInput, Field } from "../../shared/ui/TextInput";
import { BusyLabel } from "../../shared/ui/BusyLabel";
import { EmptyState } from "../../shared/ui/EmptyState";
import { browseFavoriteAssets } from "./useFavoriteCatalog";
import { representativeAsset } from "./model";
import { commandErrorMessage } from "../../library/errorMessage";

export function FavoriteCoverDialog({ target, entry, initialPage, busy, onSave, onClose }: {
  target: CharacterTarget; entry: FavoriteEntry; initialPage: CharacterBrowsePage; busy: boolean;
  onSave(set: FavoriteSet): Promise<boolean>; onClose(): void;
}) {
  const [page, setPage] = useState(initialPage);
  const [selected, setSelected] = useState(() => representativeAsset(entry, target, initialPage.items[0]?.id));
  const [coverY, setCoverY] = useState(entry.coverY);
  const [error, setError] = useState<string | null>(null);
  const loading = useRef(false);
  const drag = useRef<{ pointer: number; y: number; focus: number } | null>(null);
  const { privacyMode } = usePrivacy();
  const loadMore = async () => {
    if (!page.nextCursor || loading.current) return;
    loading.current = true;
    try {
      const next = await browseFavoriteAssets(target, page.nextCursor);
      setPage(previous => ({ ...next, items: [...previous.items, ...next.items] })); setError(null);
    } catch (reason) { setError(commandErrorMessage(reason, "에셋을 불러오지 못했습니다.")); }
    finally { loading.current = false; }
  };
  return <Dialog open title="대표 이미지 바꾸기" variant="wide" onClose={() => { if (!busy) onClose(); }}>
    <div className="favorite-cover-dialog">
      <div className="favorite-cover-dialog__gallery"><AssetGallery items={page.items} groupDates={false} scopeKey={`favorite-cover:${target.id}`} selectedAssetIds={new Set(selected ? [selected] : [])}
        privacyMode={privacyMode} totalCount={page.totalCount} onSelectionGesture={asset => { setSelected(asset.id); setCoverY(50); }} onOpen={asset => { setSelected(asset.id); setCoverY(50); }}
        hasNextPage={!!page.nextCursor} onLoadNextPage={() => void loadMore()} />
        {!page.totalCount && <EmptyState inline title="선택할 수 있는 이미지가 없습니다" />}
      </div>
      <div className="favorite-cover-dialog__side">
        <div className="favorite-cover-preview" onPointerDown={event => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId); drag.current = { pointer: event.pointerId, y: event.clientY, focus: coverY };
        }} onPointerMove={event => {
          const start = drag.current;
          if (!start || start.pointer !== event.pointerId) return;
          setCoverY(Math.max(0, Math.min(100, start.focus - (event.clientY - start.y) / event.currentTarget.clientHeight * 100)));
        }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
          {selected && !privacyMode && <AssetImage src={thumbnailUrl(selected)} alt="카드 미리보기" draggable={false} style={{ objectPosition: `50% ${coverY}%` }} />}
        </div>
        <p className="favorite-meta">미리보기를 끌어 잘리는 위치 조절</p>
        <Field label="세로 위치 · %"><TextInput type="range" min={0} max={100} value={coverY} onChange={event => setCoverY(Number(event.target.value))} /></Field>
      </div>
    </div>
    {error && <p role="alert">{error}<Button variant="quiet" onClick={() => void loadMore()}>다시 시도</Button></p>}
    <div className="favorite-editor__foot"><Button variant="ghost" disabled={busy} onClick={onClose}>취소</Button><Button variant="primary" disabled={busy || !selected} onClick={() => void onSave({ coverAssetId: selected, coverY }).then(saved => { if (saved) onClose(); })}><BusyLabel busy={busy} delay={400} idle="바꾸기">저장 중</BusyLabel></Button></div>
  </Dialog>;
}
