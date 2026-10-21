import { useRef, useState } from "react";
import { FolderOpenIcon, PhotoIcon, PlusIcon } from "@heroicons/react/24/outline";
import type { CharacterTarget } from "../../characters/api";
import type { CharacterBrowsePage } from "../../characters/hubApi";
import type { CollectionSummary, FavoriteEntry, FavoriteSet } from "../../library/types";
import { useLibrary } from "../../library/LibraryContext";
import { commandErrorMessage } from "../../library/errorMessage";
import { AssetGallery } from "../../assets/AssetGallery";
import { AssetViewer } from "../../assets/AssetViewer";
import { usePrivacy } from "../../privacy/PrivacyContext";
import { Button } from "../../shared/ui/Button";
import { DDay } from "../../shared/ui/DDay";
import { EmptyState } from "../../shared/ui/EmptyState";
import { SectionLabel } from "../../shared/ui/SectionLabel";
import { Toast } from "../../shared/ui/Toast";
import { ContextMenu } from "../../shared/ui/ContextMenu";
import { CollectionCard } from "../CollectionCard";
import { collectionCoverUrl } from "../CollectionBrowser";
import { FavoriteProfileEditor } from "./FavoriteProfileEditor";
import { birthdayDays } from "./model";
import { FavoritePortrait } from "./FavoritePortrait";
import { browseFavoriteAssets, type FavoriteCatalog } from "./useFavoriteCatalog";

export function FavoriteDetail({ target, entry, catalog, initialPage, collections, editing, busy, onEdit, onSave, onCover, onFolder, onWork }: {
  target: CharacterTarget; entry: FavoriteEntry; catalog: FavoriteCatalog; initialPage: CharacterBrowsePage; collections: CollectionSummary[];
  editing: boolean; busy: boolean; onEdit(value: boolean): void; onSave(set: FavoriteSet): Promise<boolean>;
  onCover(): void; onFolder(): void; onWork(work: CollectionSummary): void;
}) {
  const { gateway } = useLibrary();
  const { privacyMode } = usePrivacy();
  const [page, setPage] = useState(initialPage);
  const [viewer, setViewer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [contextAsset, setContextAsset] = useState<string | null>(null);
  const loading = useRef(false);
  const series = catalog.classifications.find(folder => folder.id === target.seriesClassificationId)?.name ?? "";
  const profile = entry.profile;
  const birthday = profile.birthMonth && profile.birthDay ? `${profile.birthMonth}월 ${profile.birthDay}일` : null;
  const rows = [
    { label: "생일", value: birthday, birthday: true },
    { label: "키", value: profile.heightCm != null ? `${profile.heightCm}cm` : null },
    { label: "성우", value: profile.voiceActor },
    { label: "소속", value: profile.affiliation },
    { label: "메모", value: profile.memo },
  ].filter(row => row.value);
  const works = entry.workIds.flatMap(id => collections.find(work => work.id === id) ?? []);
  const loadMore = async () => {
    if (!page.nextCursor || loading.current) return;
    loading.current = true;
    try {
      const next = await browseFavoriteAssets(target, page.nextCursor);
      setPage(previous => ({ ...next, items: [...previous.items, ...next.items] })); setError(null);
    } catch (reason) { setError(commandErrorMessage(reason, "에셋을 불러오지 못했습니다.")); }
    finally { loading.current = false; }
  };
  const toggleFavorite = async (id: string) => {
    const asset = page.items.find(item => item.id === id);
    if (!asset) return;
    try {
      await gateway.setAssetFavorite(id, !asset.favorite);
      setPage(current => ({ ...current, items: current.items.map(item => item.id === id ? { ...item, favorite: !asset.favorite } : item) }));
    } catch (reason) { setError(commandErrorMessage(reason, "좋아요를 바꾸지 못했습니다.")); }
  };
  return <>
    <div className="favorite-detail">
      <aside className="favorite-profile" aria-label="캐릭터 프로필">
        <div className="favorite-profile__image"><FavoritePortrait coverId={catalog.unavailableAssets.has(entry.coverAssetId ?? "") ? null : entry.coverAssetId} thumbnailId={target.thumbnailAssetId} firstAssetId={catalog.firstAssets[target.id] ?? page.items[0]?.id} coverY={entry.coverY} alt={target.displayName} />
          <span className="favorite-profile__swap"><Button variant="quiet" size="sm" onClick={onCover}><PhotoIcon aria-hidden="true" />바꾸기</Button></span>
        </div>
        {editing ? <FavoriteProfileEditor name={target.displayName} series={series} entry={entry} collections={collections} busy={busy} onCancel={() => onEdit(false)} onSave={onSave} /> : <>
          <div className="favorite-profile__name"><h3>{target.displayName}</h3><span>{[profile.originalName, series].filter(Boolean).join(" · ")}</span></div>
          {!!rows.length && <dl className="favorite-facts">{rows.map(row => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}{row.birthday && <DDay as="text" className="favorite-birthday" days={birthdayDays(profile.birthMonth, profile.birthDay)} />}</dd></div>)}</dl>}
          {!Object.values(profile).some(value => value != null && value !== "") && <Button variant="quiet" size="sm" onClick={() => onEdit(true)}><PlusIcon aria-hidden="true" />정보 추가</Button>}
        </>}
      </aside>
      <div className="favorite-detail__right">
        {(works.length > 0 || entry.extraWorks.length > 0) && <section className="favorite-works" aria-label="등장 작품">
          <SectionLabel title="등장 작품" />
          <div className="favorite-works__covers">{works.map(work => <CollectionCard key={work.id} collection={work} selected={false} coverUrl={collectionCoverUrl(work)} meta={false} onClick={() => onWork(work)} />)}</div>
          {!!entry.extraWorks.length && <ul className="favorite-works__extra">{entry.extraWorks.map(name => <li key={name}>{name}</li>)}</ul>}
        </section>}
        <ContextMenu items={[{ id: "representative", label: "대표 이미지로", disabled: !contextAsset || busy, onSelect: () => { if (contextAsset) void onSave({ coverAssetId: contextAsset, coverY: 50 }); } }]}><section className="favorite-assets" aria-label="캐릭터 에셋" onContextMenuCapture={event => {
          setContextAsset((event.target as HTMLElement).closest<HTMLElement>("[data-asset-id]")?.dataset.assetId ?? null);
        }}>
          <AssetGallery items={page.items} privacyMode={privacyMode} groupDates={false} scopeKey={`favorite:${target.id}`} totalCount={page.totalCount}
            intro={<SectionLabel title="에셋" count={page.totalCount} unit="장" actions={<Button variant="quiet" size="sm" onClick={onFolder}><FolderOpenIcon aria-hidden="true" />폴더 열기</Button>} />}
            onOpen={asset => setViewer(asset.id)} onToggleFavorite={asset => void toggleFavorite(asset.id)} hasNextPage={!!page.nextCursor} onLoadNextPage={() => void loadMore()} />
          {!page.totalCount && <EmptyState inline title="이 캐릭터의 이미지가 없습니다" />}
        </section></ContextMenu>
      </div>
    </div>
    <AssetViewer items={page.items} activeId={viewer} onActiveIdChange={setViewer} onClose={() => setViewer(null)} privacyMode={privacyMode} totalCount={page.totalCount} classifications={catalog.classifications}
      onNearEnd={() => void loadMore()} onToggleFavorite={asset => void toggleFavorite(asset.id)} onAssetOpened={asset => gateway.recordAssetOpened(asset.id, new Date().toISOString())}
      renderExtraActions={asset => <Button variant="quiet" onClick={() => void onSave({ coverAssetId: asset.id, coverY: 50 })}>대표 이미지로</Button>} />
    {error && <Toast tone="error" onDismiss={() => setError(null)} actionLabel="다시 시도" onAction={() => void loadMore()}>{error}</Toast>}
  </>;
}
