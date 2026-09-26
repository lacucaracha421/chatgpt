import { useState } from "react";
import { commandErrorMessage } from "../library/errorMessage";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import { artistHandle, ArtistThumb } from "./ArtistHub";
import { CheckIcon, MagnifyingGlassIcon, PlusIcon } from "./artistIcons";
import { invalidateArtists, useArtistGateway, useArtistRead } from "./artistStore";

type Target = { artistId: string; label: string } | { newName: string };

/**
 * 작가 지정: link the selected images to an existing artist or to a new one by name. The
 * images' files and source data stay as they are; the link can be removed in 작가 편집.
 */
export function AssignArtistDialog({ assetIds, privacyMode, onClose, onAssigned }: { assetIds: string[]; privacyMode: boolean; onClose: () => void; onAssigned: (artistId: string, label: string) => void }) {
  const gateway = useArtistGateway();
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<Target | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const search = query.trim();
  const results = useArtistRead((artists) => artists.list({ bucket: "all", search: search || null, sort: search ? "count" : "recent", limit: 6 }), `assign:${search}`).data;
  const label = !target ? null : "newName" in target ? target.newName : target.label;
  const assign = async () => {
    if (!gateway || !target) return;
    setPending(true); setError(null);
    try {
      const artistId = await gateway.assignAssets(assetIds, "newName" in target ? { newName: target.newName } : { artistId: target.artistId });
      invalidateArtists();
      onAssigned(artistId, label ?? "");
    } catch (cause) {
      setError(commandErrorMessage(cause, "작가를 지정하지 못했습니다."));
      setPending(false);
    }
  };
  return <Dialog open title={`작가 지정 · ${assetIds.length.toLocaleString("ko-KR")}장`} variant="medium" onClose={onClose}>
    <div className="artist-assign">
      <label className="artist-search">
        <MagnifyingGlassIcon aria-hidden="true" />
        <input type="search" autoFocus value={query} placeholder="작가 이름 · 핸들 · 초성" aria-label="작가 찾기" onChange={(event) => { setQuery(event.target.value); setTarget(null); }} />
      </label>
      <ul className="artist-assign__list" role="listbox" aria-label="붙일 작가">
        {(results?.artists ?? []).map((artist) => {
          const selected = target !== null && "artistId" in target && target.artistId === artist.id;
          return <li key={artist.id} role="option" aria-selected={selected}>
            <button type="button" className="artist-assign__row" onClick={() => setTarget({ artistId: artist.id, label: artist.label })}>
              <ArtistThumb assetId={artist.coverAssetIds[0]} privacyMode={privacyMode} className="artist-thumb artist-thumb--small" />
              <span className="artist-edit__copy">
                <span><span className="artist-name">{artist.label}</span>{artist.displayName && <span className="artist-badge">직접 지은 이름</span>}</span>
                <small>{artistHandle(artist) ?? ""}</small>
              </span>
              <span className="artist-list__count">{artist.assetCount.toLocaleString("ko-KR")}</span>
              {selected && <CheckIcon className="artist-assign__check" aria-hidden="true" />}
            </button>
          </li>;
        })}
        {search && <li role="option" aria-selected={target !== null && "newName" in target}>
          <button type="button" className="artist-assign__row" onClick={() => setTarget({ newName: search })}>
            <span className="artist-thumb artist-thumb--small artist-thumb--new" aria-hidden="true"><PlusIcon /></span>
            <span className="artist-edit__copy"><span>'{search}' 이름으로 새 작가 만들기</span><small>직접 지은 이름 · 원래 이름 없음</small></span>
            {target !== null && "newName" in target && <CheckIcon className="artist-assign__check" aria-hidden="true" />}
          </button>
        </li>}
      </ul>
      <p className="artist-muted">원래 파일과 출처 정보는 바꾸지 않고, 고른 이미지를 이 작가에 붙이기만 합니다. 작가 편집의 원래 이름 목록에 "직접 지정"으로 보이고 언제든 떼어낼 수 있어요.</p>
      {error && <p role="alert" className="artist-error">{error}</p>}
    </div>
    <div className="ui-dialog__actions">
      <Button variant="ghost" onClick={onClose}>취소</Button>
      <Button variant="primary" disabled={!target || pending} onClick={() => void assign()}>{label ? `${label}에 붙이기` : "작가를 고르세요"}</Button>
    </div>
  </Dialog>;
}
