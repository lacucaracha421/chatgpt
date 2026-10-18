import { useMemo, useState } from "react";
import { MagnifyingGlassIcon } from "../artists/artistIcons";
import { useDelayedBusy } from "../shared/useDelayedBusy";
import type { ClassificationEntry } from "../library/types";
import "../artists/artists.css";

const formatCount = (value: number) => value.toLocaleString("ko-KR");

export function folderBreadcrumb(entries: ClassificationEntry[], entry: ClassificationEntry) {
  const byId = new Map(entries.map((candidate) => [candidate.id, candidate]));
  const names: string[] = [];
  const seen = new Set<string>();
  let current: ClassificationEntry | undefined = entry;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    names.push(current.name);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return names.reverse().join(" › ");
}

/** Search-and-pick list over the library's folders; the shared "exclude these folders" choice. */
export function FolderSearchPicker({ folders, hiddenIds, pending, onPick }: {
  /** `null` while the folder list is still loading. */
  folders: ClassificationEntry[] | null;
  hiddenIds: ReadonlySet<string>;
  pending: boolean;
  onPick(id: string): void;
}) {
  const [search, setSearch] = useState("");
  const options = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return (folders ?? [])
      .filter((entry) => !hiddenIds.has(entry.id))
      .map((entry) => ({ entry, breadcrumb: folderBreadcrumb(folders ?? [], entry) }))
      .filter(({ breadcrumb }) => !needle || breadcrumb.toLocaleLowerCase().includes(needle))
      .slice(0, 100);
  }, [folders, search, hiddenIds]);
  const showFolders = useDelayedBusy(folders === null);
  return <div className="artist-exclusion__picker">
    <label className="artist-search artist-exclusion__search"><MagnifyingGlassIcon aria-hidden="true" /><span className="artist-sr-only">제외 폴더 검색</span><input type="search" value={search} placeholder="폴더 경로 검색" onChange={(event) => setSearch(event.target.value)} /></label>
    {folders === null || showFolders ? showFolders && <p className="artist-muted">폴더를 불러오는 중…</p> : options.length === 0 ? <p className="artist-muted">추가할 폴더가 없습니다.</p> : <ul className="artist-exclusion__options" role="listbox" aria-label="제외할 폴더 선택">
      {options.map(({ entry, breadcrumb }) => <li key={entry.id}><button type="button" role="option" className="artist-exclusion__option" disabled={pending} onClick={() => { setSearch(""); onPick(entry.id); }}><span>{breadcrumb}</span><small>{formatCount(entry.totalAssetCount ?? entry.assetCount ?? 0)}장</small></button></li>)}
    </ul>}
  </div>;
}
