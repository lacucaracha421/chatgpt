import { useMemo, useState } from "react";
import { InformationCircleIcon, MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import type { FavoriteEntry } from "../../library/types";
import { thumbnailUrl } from "../../assets/mediaUrl";
import { AssetImage } from "../../privacy/AssetImage";
import { usePrivacy } from "../../privacy/PrivacyContext";
import { Button } from "../../shared/ui/Button";
import { Checkbox } from "../../shared/ui/Checkbox";
import { EmptyState } from "../../shared/ui/EmptyState";
import { Menu } from "../../shared/ui/Menu";
import { SectionLabel } from "../../shared/ui/SectionLabel";
import { SegmentedControl } from "../../shared/ui/SegmentedControl";
import { TextInput } from "../../shared/ui/TextInput";
import { BusyLabel } from "../../shared/ui/BusyLabel";
import { displayCount } from "../../shared/displayDate";
import { matchesKoreanSearch } from "../../shared/koreanSearch";
import { containerId, favoriteScopes, representativeAsset } from "./model";
import type { FavoriteCatalog } from "./useFavoriteCatalog";

export function FavoriteAddPicker({ catalog, entries, busy, onAdd, onCreate, onLink, onClose }: {
  catalog: FavoriteCatalog; entries: FavoriteEntry[]; busy: boolean; onAdd?(ids: string[]): Promise<boolean>;
  onCreate?(name: string): Promise<boolean>; onLink?(id: string): Promise<boolean>; onClose(): void;
}) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all");
  const [selected, setSelected] = useState<string[]>([]);
  const { privacyMode } = usePrivacy();
  const byId = new Map(entries.map(entry => [entry.characterId, entry]));
  const scopes = favoriteScopes(catalog.targets, catalog.classifications);
  const groups = useMemo(() => {
    const series = new Map<string, typeof catalog.targets>();
    for (const target of catalog.targets) {
      const seriesName = catalog.classifications.find(folder => folder.id === target.seriesClassificationId)?.name ?? "";
      const originalName = entries.find(entry => entry.characterId === target.id)?.profile.originalName;
      if (scope !== "all" && containerId(target, catalog.classifications) !== scope) continue;
      if (!matchesKoreanSearch([target.displayName, originalName, seriesName], query)) continue;
      const rows = series.get(target.seriesClassificationId!) ?? [];
      rows.push(target); series.set(target.seriesClassificationId!, rows);
    }
    return [...series].map(([id, targets]) => {
      const seriesName = catalog.classifications.find(folder => folder.id === id)?.name ?? "";
      const container = catalog.classifications.find(folder => folder.id === containerId(targets[0], catalog.classifications));
      return { id, name: [container?.name, seriesName].filter(Boolean).join(" · "), targets };
    }).sort((a, b) => a.name.localeCompare(b.name, "ko"));
  }, [catalog, entries, query, scope]);
  return <div className="favorite-picker" onKeyDown={event => event.stopPropagation()}>
    <div className="favorite-picker__head">
      <TextInput type="search" autoFocus icon={MagnifyingGlassIcon} aria-label="캐릭터 찾기" placeholder="이름 · 작품 검색" maxLength={120} value={query} onChange={event => setQuery(event.target.value)} />
      {!onLink && <Menu label="캐릭터 추가 안내" trigger={<InformationCircleIcon aria-hidden="true" />} content={<p className="favorite-help">에셋에 없는 캐릭터도 이름으로 추가할 수 있습니다.</p>} />}
    </div>
    <div className="favorite-picker__scope"><SegmentedControl label="분류함" options={scopes} value={scope} onChange={setScope} /></div>
    <div className="favorite-picker__list" data-native-scrollbar="true">
      {query.trim() && onCreate && !onLink && <button type="button" className="favorite-picker__row favorite-picker__create" disabled={busy || entries.length >= 300}
        onClick={() => void onCreate(query.trim()).then(saved => { if (saved) onClose(); })}><span className="favorite-picker__name">'{query.trim()}' 이름으로 추가</span></button>}
      {groups.map(({ id, name, targets }) => <section key={id}>
        <SectionLabel title={name} count={targets.length} unit="명" />
        {targets.map(target => {
          const entry = byId.get(target.id), added = !!entry;
          const image = representativeAsset(entry && { coverAssetId: catalog.unavailableAssets.has(entry.coverAssetId ?? "") ? null : entry.coverAssetId }, target,
            catalog.firstAssets[target.id] ?? target.references.find(reference => reference.status === "ready")?.assetId);
          if (onLink) return <button type="button" className="favorite-picker__row favorite-picker__select" key={target.id} disabled={added || busy} data-added={added || undefined}
            onClick={() => void onLink(target.id).then(saved => { if (saved) onClose(); })}>
            <span className="favorite-picker__thumbnail">{image && !privacyMode && <AssetImage src={thumbnailUrl(image)} alt="" draggable={false} />}</span>
            <span className="favorite-picker__name">{target.displayName}</span><small>{added ? "추가됨" : displayCount(catalog.counts[target.id] ?? 0, "장")}</small>
          </button>;
          return <label className="favorite-picker__row" key={target.id} data-added={added || undefined}>
            <Checkbox aria-label={target.displayName} checked={added || selected.includes(target.id)} disabled={added || busy}
              onChange={event => setSelected(ids => event.target.checked ? [...ids, target.id] : ids.filter(id => id !== target.id))} />
            <span className="favorite-picker__thumbnail">{image && !privacyMode && <AssetImage src={thumbnailUrl(image)} alt="" draggable={false} />}</span>
            <span className="favorite-picker__name">{target.displayName}</span>
            <small>{added ? "추가됨" : displayCount(catalog.counts[target.id] ?? 0, "장")}</small>
          </label>;
        })}
      </section>)}
      {!groups.length && <EmptyState inline title="검색 결과 없음" />}
    </div>
    {onLink ? <div className="favorite-picker__foot"><Button variant="ghost" onClick={onClose}>취소</Button></div> : <div className="favorite-picker__foot"><span>{displayCount(selected.length, "명")} 선택</span>
      <Button variant="ghost" onClick={onClose}>취소</Button><Button variant="primary" disabled={busy || !onAdd || !selected.length || entries.length + selected.length > 300} onClick={() => void onAdd?.(selected).then(saved => { if (saved) onClose(); })}>
        <BusyLabel busy={busy} delay={400} idle="추가">추가 중</BusyLabel>
      </Button>
    </div>}
  </div>;
}
