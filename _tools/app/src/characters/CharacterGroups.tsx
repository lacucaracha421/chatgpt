import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PhotoIcon, UserGroupIcon } from "@heroicons/react/24/outline";
import { PencilIcon } from "../shared/ui/ArchiveIcons";
import { Dialog } from "../shared/ui/Dialog";
import { Button } from "../shared/ui/Button";
import { TextField } from "../shared/ui/TextField";
import { commandErrorMessage } from "../library/errorMessage";
import { thumbnailUrl } from "../assets/mediaUrl";
import type { CharacterTarget } from "./api";

type Group = { id: string; name: string; revision: number; targetIds: string[] };
type Props = {
  seriesId: string;
  members: CharacterTarget[];
  groups?: Group[];
  activeGroupId?: string;
  privacyMode?: boolean;
  onOpenGroup?: (groupId: string | null) => void;
  onGroupsChanged?: () => void;
  folderCards?: ReactNode[];
  children: (members: CharacterTarget[]) => ReactNode;
};

export function CharacterGroups({ seriesId, members, groups: providedGroups, activeGroupId, privacyMode = false, onOpenGroup, onGroupsChanged, folderCards, children }: Props) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(1);
  const [pagination, setPagination] = useState({ scope: "", page: 0 });
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const measure = () => {
      const style = getComputedStyle(grid);
      const tracks = style.gridTemplateColumns.match(/[\d.]+px/g);
      const width = grid.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
      const cardWidth = parseFloat(style.getPropertyValue("--series-card-width")) || 180;
      const gap = parseFloat(style.columnGap) || 12;
      setColumns(Math.max(1, tracks?.length ?? Math.floor((width + gap) / (cardWidth + gap))));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    return () => observer.disconnect();
  }, []);
  const [loadedGroups, setLoadedGroups] = useState<Group[]>([]);
  const [draft, setDraft] = useState<Group | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (providedGroups) return;
    let alive = true;
    void invoke<Group[]>("character_groups", { seriesId }).then(result => {
      if (alive) { setLoadedGroups(result); setError(null); }
    }).catch(error => {
      if (alive) setError(commandErrorMessage(error, "캐릭터 그룹을 불러오지 못했습니다."));
    });
    return () => { alive = false; };
  }, [seriesId, revision, providedGroups]);
  const groups = providedGroups ?? loadedGroups;
  const current = groups.find(group => group.id === activeGroupId);
  const grouped = new Set(groups.flatMap(group => group.targetIds));
  const visibleMembers = current
    ? members.filter(target => current.targetIds.includes(target.id))
    : members.filter(target => !grouped.has(target.id));

  const scope = `${seriesId}:${current?.id ?? ""}`;
  const rootGroups = current ? [] : groups;
  const rootFolders = current ? [] : (folderCards ?? []).filter(Boolean);
  const pageSize = columns * 2;
  const pageCount = Math.max(1, Math.ceil((rootGroups.length + visibleMembers.length + rootFolders.length) / pageSize));
  const page = Math.min(pagination.scope === scope ? pagination.page : 0, pageCount - 1);
  const start = page * pageSize;
  const end = start + pageSize;
  const pageGroups = rootGroups.slice(start, end);
  const pageMembers = visibleMembers.slice(Math.max(0, start - rootGroups.length), Math.max(0, end - rootGroups.length));
  const folderOffset = rootGroups.length + visibleMembers.length;
  const pageFolders = rootFolders.slice(Math.max(0, start - folderOffset), Math.max(0, end - folderOffset));
  useEffect(() => {
    setPagination(previous => previous.scope === scope && previous.page === page ? previous : { scope, page });
  }, [scope, page]);

  async function save(remove = false) {
    if (!draft || busy) return;
    setBusy(true); setError(null);
    try {
      await invoke("save_character_group", { request: {
        id: draft.id || null, seriesId, expectedRevision: draft.id ? draft.revision : null,
        name: draft.name, targetIds: draft.targetIds, delete: remove,
      } });
      const removedId = remove || !draft.targetIds.length ? draft.id : null;
      setDraft(null);
      if (removedId && activeGroupId === removedId) onOpenGroup?.(null);
      setRevision(value => value + 1);
      onGroupsChanged?.();
    } catch (error) {
      setError(commandErrorMessage(error, "그룹을 저장하지 못했습니다."));
    } finally { setBusy(false); }
  }

  return <>
    <div className="series-gallery-heading character-group-heading">
      <h3 aria-label={current ? `그룹 · ${current.name}` : folderCards?.length ? "캐릭터 · 폴더" : "캐릭터"}>{current ? `그룹 · ${current.name}` : folderCards?.length ? "캐릭터 · 폴더" : "캐릭터"}<small aria-hidden="true">{current ? visibleMembers.length : members.length + (folderCards?.length ?? 0)}</small></h3>
      {current ? <>
        <Button size="sm" variant="ghost" onClick={() => onOpenGroup?.(null)}>시리즈로</Button>
        <Button size="sm" variant="ghost" onClick={() => setDraft({ ...current, targetIds: [...current.targetIds] })}>그룹 편집</Button>
      </> : <Button size="sm" variant="ghost" onClick={() => setDraft({ id: "", name: "", revision: 0, targetIds: [] })}>그룹 만들기</Button>}
    </div>
    {error && <p className="character-message" role="alert">{error}<Button size="sm" onClick={() => setRevision(value => value + 1)}>다시 불러오기</Button></p>}
    <div ref={gridRef} className={`series-characters${pageCount > 1 ? " series-characters--paged" : ""}`} aria-label={current ? `${current.name} 그룹 캐릭터` : folderCards?.length ? "캐릭터와 일반 폴더" : "등록 캐릭터"}>
      {pageGroups.map(group => <CharacterGroupCard key={group.id} group={group} members={members} privacyMode={privacyMode} onOpen={() => onOpenGroup?.(group.id)} onEdit={() => setDraft({ ...group, targetIds: [...group.targetIds] })} />)}
      {children(pageMembers)}
      {pageFolders}
      {!groups.length && !members.length && !folderCards && <p className="series-empty">캐릭터를 등록하고 기준 이미지를 선택하세요.</p>}
    </div>
    {pageCount > 1 && <nav className="series-card-pagination" aria-label="캐릭터·폴더 페이지">
      {Array.from({ length: pageCount }, (_, index) => <Button key={index} size="sm" variant="ghost" className="series-card-pagination__page" aria-label={`${index + 1}페이지`} aria-current={page === index ? "page" : undefined} onClick={() => setPagination({ scope, page: index })}>{index + 1}</Button>)}
    </nav>}
    {draft && <Dialog open title={draft.id ? "캐릭터 그룹 편집" : "캐릭터 그룹 만들기"} onClose={() => { if (!busy) setDraft(null); }}>
      <TextField label="그룹 이름" value={draft.name} maxLength={100} disabled={busy} onChange={event => setDraft({ ...draft, name: event.target.value })} />
      <p>탐색 목록만 묶습니다. 시리즈 소속, 이미지 분류와 분석 범위는 바뀌지 않습니다.</p>
      <p>소속 캐릭터가 모두 빠지면 그룹은 자동으로 해제됩니다.</p>
      <div className="character-group-members">{members.filter(target => !grouped.has(target.id) || groups.find(group => group.id === draft.id)?.targetIds.includes(target.id)).map(target => <label key={target.id}>
        <input type="checkbox" disabled={busy} checked={draft.targetIds.includes(target.id)} onChange={event => setDraft({ ...draft, targetIds: event.target.checked ? [...draft.targetIds, target.id] : draft.targetIds.filter(id => id !== target.id) })} />
        {target.displayName}
      </label>)}</div>
      {error && <p role="alert">{error}</p>}
      <div className="character-actions"><Button disabled={busy || !draft.name.trim() || (!draft.id && !draft.targetIds.length)} onClick={() => void save()}>{draft.id && !draft.targetIds.length ? "빈 그룹 해제" : "저장"}</Button>{draft.id && <Button variant="ghost" disabled={busy} onClick={() => void save(true)}>그룹 해제 · 캐릭터 유지</Button>}</div>
    </Dialog>}
  </>;
}

function CharacterGroupCard({ group, members, privacyMode, onOpen, onEdit }: { group: Group; members: CharacterTarget[]; privacyMode: boolean; onOpen: () => void; onEdit: () => void }) {
  const groupMembers = group.targetIds.map(id => members.find(member => member.id === id)).filter((member): member is CharacterTarget => Boolean(member));
  const previews = groupMembers.slice(0, 4);
  return <article className="series-character series-character--group">
    <button className="series-character__open" aria-label={`${group.name} 그룹 열기`} onClick={onOpen}>
      <span className="character-group-card__mosaic" data-count={Math.max(1, previews.length)}>
        {previews.length ? previews.map(target => {
          const assetId = target.thumbnailAssetId ?? target.references.find(reference => reference.status === "ready")?.assetId;
          return assetId ? <img key={target.id} loading="lazy" className={privacyMode ? "character-private" : undefined} src={thumbnailUrl(assetId)} alt="" /> : <span key={target.id} className="character-group-card__slot"><PhotoIcon aria-hidden="true" /></span>;
        }) : <span className="character-group-card__slot"><UserGroupIcon aria-hidden="true" /></span>}
      </span>
      <strong><UserGroupIcon className="character-group-card__icon" aria-hidden="true" /><span className="series-character__name">{group.name}</span></strong>
      <small>{group.targetIds.length.toLocaleString()}명{groupMembers.length ? ` · ${groupMembers.slice(0, 3).map(member => member.displayName).join(" · ")}${groupMembers.length > 3 ? "…" : ""}` : ""}</small>
    </button>
    <Button className="series-character__info" size="icon" variant="ghost" aria-label={`${group.name} 그룹 편집`} aria-description="그룹 편집" onClick={onEdit}><PencilIcon aria-hidden="true" /></Button>
  </article>;
}
