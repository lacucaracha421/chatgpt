import { useFirstAppearance } from "../shared/motion/useFirstAppearance";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { assetThumbnailUrl } from "../assets/mediaUrl";
import { useLibrary } from "../library/LibraryContext";
import type { AlbumEntry, AssetSummary, AssetView } from "../library/types";
import { usePrivacy } from "../privacy/PrivacyContext";
import { Button } from "../shared/ui/Button";
import { PhotoIcon, PlusIcon } from "../shared/ui/ArchiveIcons";
import { ViewToolbar } from "../layout/ViewToolbar";
import "./albumOverview.css";

type AlbumOverviewProps = {
  albums: AlbumEntry[];
  onNavigate: (view: AssetView) => void;
  onCreateAlbum?: () => void;
  onChanged?: () => void;
};

export function AlbumOverview({ albums, onNavigate, onCreateAlbum, onChanged }: AlbumOverviewProps) {
  const { gateway } = useLibrary();
  const { privacyMode } = usePrivacy();
  const topLevelAlbums = useMemo(() => albums.filter((album) => album.parentId === null), [albums]);
  const [visibleAlbumIds, setVisibleAlbumIds] = useState<Set<string>>(() => new Set());
  const host = useRef<HTMLElement>(null);
  useFirstAppearance(host, topLevelAlbums.length, true, "classification-albums", ".album-overview__card-wrap");
  const covers = useAlbumCovers(gateway, visibleAlbumIds, privacyMode);
  const requestCreate = useCallback(() => {
    if (onCreateAlbum) {
      onCreateAlbum();
      return;
    }
    void gateway.createAlbum({ name: "새 앨범", parentId: null }).then(() => onChanged?.());
  }, [gateway, onChanged, onCreateAlbum]);
  const markVisible = useCallback((albumId: string) => {
    setVisibleAlbumIds((current) => current.has(albumId) ? current : new Set(current).add(albumId));
  }, []);
  const createButton = <Button type="button" size="sm" variant="quiet" onClick={requestCreate}><PlusIcon aria-hidden="true" />새 앨범</Button>;

  return <section ref={host} className="album-overview" aria-label="앨범">
    <ViewToolbar title="앨범" titleAccessory={<span className="album-overview__toolbar-count">{albums.length.toLocaleString("ko-KR")}</span>} ariaLabel="앨범 도구" actions={createButton} chrome={{ status: createButton }} />
    {topLevelAlbums.length > 0 ? <div className="album-overview__grid">
      {topLevelAlbums.map((album) => <AlbumCard key={album.id} album={album} subAlbumCount={albums.filter((candidate) => candidate.parentId === album.id).length} covers={covers[album.id] ?? []} privacyMode={privacyMode} onVisible={markVisible} onNavigate={onNavigate} />)}
    </div> : <div className="album-overview__empty-state">
      <div className="album-overview__empty">
        <PhotoIcon aria-hidden="true" />
        <span>앨범 없음</span>
        <Button type="button" size="sm" onClick={requestCreate}><PlusIcon aria-hidden="true" />새 앨범</Button>
      </div>
    </div>}
  </section>;
}

function AlbumCard({ album, subAlbumCount, covers, privacyMode, onVisible, onNavigate }: {
  album: AlbumEntry;
  subAlbumCount: number;
  covers: AssetSummary[];
  privacyMode: boolean;
  onVisible: (albumId: string) => void;
  onNavigate: (view: AssetView) => void;
}) {
  const cardRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const element = cardRef.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      onVisible(album.id);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        onVisible(album.id);
        observer.disconnect();
      }
    }, { rootMargin: "160px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [album.id, onVisible]);
  const mosaicAssets = covers.length < 2 ? [covers[0] ?? null] : [covers[0] ?? null, covers[1] ?? null, covers[2] ?? null];
  const mosaicKind = mosaicAssets.length < 2 ? "single" : `n${mosaicAssets.length}`;
  const count = album.assetCount ?? covers.length;
  return <article className="album-overview__card-wrap">
    <button ref={cardRef} type="button" className="album-overview__card" aria-label={`${album.name} ${count.toLocaleString("ko-KR")}장`} onClick={() => onNavigate({ kind: "album", albumId: album.id })}>
      <span className={`album-overview__mosaic album-overview__mosaic--${mosaicKind}`} aria-hidden="true">
        {mosaicAssets.map((asset, index) => <span className="album-overview__mosaic-cell" key={asset?.id ?? `empty-${index}`}>
          {asset && !privacyMode && <img src={assetThumbnailUrl(asset)} alt="" loading="lazy" decoding="async" draggable={false} />}
        </span>)}
      </span>
      <span className="album-overview__caption">
        <span className="album-overview__name">{album.name}</span>
        <span className="album-overview__count">{count.toLocaleString("ko-KR")}</span>
        {subAlbumCount > 0 && <span className="album-overview__children">하위 {subAlbumCount.toLocaleString("ko-KR")}</span>}
      </span>
    </button>
  </article>;
}

function useAlbumCovers(gateway: ReturnType<typeof useLibrary>["gateway"], visibleAlbumIds: Set<string>, privacyMode: boolean) {
  const [covers, setCovers] = useState<Record<string, AssetSummary[]>>({});
  const loaded = useRef(new Set<string>());
  const visibleKey = [...visibleAlbumIds].sort().join(",");
  useEffect(() => {
    if (privacyMode || !visibleKey) return;
    let active = true;
    const ids = visibleKey.split(",").filter((id) => !loaded.current.has(id));
    ids.forEach((albumId) => {
      loaded.current.add(albumId);
      void gateway.listAssets({
        classificationId: null,
        albumId,
        collectionId: null,
        directOnly: false,
        unclassifiedOnly: false,
        mediaKind: null,
        aspectRatio: null,
        sort: "newest",
        randomPivot: null,
        after: null,
        limit: 3,
      }).then((page) => {
        if (active) setCovers((current) => ({ ...current, [albumId]: page.items.slice(0, 3) }));
      }).catch(() => {
        if (active) setCovers((current) => ({ ...current, [albumId]: [] }));
      });
    });
    return () => { active = false; };
  }, [gateway, privacyMode, visibleKey]);
  return covers;
}
