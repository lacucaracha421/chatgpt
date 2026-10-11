import { AssetImage } from "../privacy/AssetImage";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PencilIcon, PhotoIcon, UserGroupIcon } from "@heroicons/react/24/outline";
import { Dialog } from "../shared/ui/Dialog";
import { Button } from "../shared/ui/Button";
import { TextField } from "../shared/ui/TextField";
import { commandErrorMessage } from "../library/errorMessage";
import { groupMemberImage, groupPreviewMembers } from "./shelfImages";
import type { CharacterTarget } from "./api";
import { FolderShelf } from "../assets/FolderShelf";
import { characterExtrasApi } from "./extrasApi";
import { useExtrasPreviews } from "./ExtrasCard";
import type { CharacterHubApi } from "./hubApi";

type Group = { id: string; name: string; revision: number; targetIds: string[]; extrasTargetId?: string | null };
type Props = {
  seriesId: string;
  members: CharacterTarget[];
  groups?: Group[];
  activeGroupId?: string;
  privacyMode?: boolean;
  onOpenGroup?: (groupId: string | null) => void;
  onGroupsChanged?: () => void;
  folderCards?: ReactNode[];
  suggestionCards?: ReactNode[];
  /** The 기타 card: always the last character card, after the characters (and before suggestions and folders). */
  extrasCard?: ReactNode;
  suggestionCount?: number;
  /**
   * Where a group card reads its 기타 images from. A group card's mosaic is its members' pictures first,
   * then (up to four slots in all) its own 기타's newest images; without this, a group shows members only.
   */
  extrasPreviewApi?: Pick<CharacterHubApi, "browse">;
  /** Changes when the 기타 images may have changed; a group card re-reads then and keeps its pictures meanwhile. */
  extrasPreviewVersion?: number;
  memberCounts?: Record<string, number | undefined>;
  /** Quiet action on the right of the series count line (e.g. waiting S36 candidates). */
  headerAccessory?: ReactNode;
  /** Incremented by the owner's "그룹 만들기" command; each change opens a new group draft. */
  groupCreateRequest?: number;
  /** Increments open the current group's editor (the titlebar 그룹 더보기 menu owns the entry). */
  groupEditRequest?: number;
  children: (members: CharacterTarget[]) => ReactNode;
};

export function CharacterGroups({ seriesId, members, groups: providedGroups, activeGroupId, privacyMode = false, onOpenGroup, onGroupsChanged, folderCards, suggestionCards = [], extrasCard, suggestionCount = 0, extrasPreviewApi, extrasPreviewVersion = 0, memberCounts = {}, headerAccessory, groupCreateRequest = 0, groupEditRequest = 0, children }: Props) {
  const [loadedGroups, setLoadedGroups] = useState<Group[]>([]);
  const [draft, setDraft] = useState<Group | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const seenCreateRequest = useRef(groupCreateRequest);
  useEffect(() => {
    if (groupCreateRequest === seenCreateRequest.current) return;
    seenCreateRequest.current = groupCreateRequest;
    setDraft({ id: "", name: "", revision: 0, targetIds: [] });
  }, [groupCreateRequest]);
  const seenEditRequest = useRef(groupEditRequest);
  useEffect(() => {
    if (groupEditRequest === seenEditRequest.current) return;
    seenEditRequest.current = groupEditRequest;
    const group = groups.find(item => item.id === activeGroupId);
    if (group) setDraft({ ...group, targetIds: [...group.targetIds] });
  }, [groupEditRequest]);
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

  const draftGroup = draft?.id ? groups.find(group => group.id === draft.id) : undefined;
  const rootGroups = current ? [] : groups;
  const rootFolders = current ? [] : (folderCards ?? []).filter(Boolean);
  const labelParts = [
    ...((current ? visibleMembers.length : members.length) > 0 ? [["캐릭터", current ? visibleMembers.length : members.length]] : []),
    ...(!current && rootGroups.length ? [["그룹", rootGroups.length]] : []),
    ...(extrasCard ? [["기타", 0]] : []),
    ...(!current && suggestionCount > 0 ? [["제안", suggestionCount]] : []),
    ...(!current && rootFolders.length ? [["폴더", rootFolders.length]] : []),
  ] as [string, number][];
  const cards: ReactNode[] = [
    ...rootGroups.map(group => <CharacterGroupCard key={group.id} seriesId={seriesId} group={group} members={members} extrasPreviewApi={extrasPreviewApi} extrasPreviewVersion={extrasPreviewVersion} memberCounts={memberCounts} privacyMode={privacyMode} onOpen={() => onOpenGroup?.(group.id)} onEdit={() => setDraft({ ...group, targetIds: [...group.targetIds] })} />),
    ...(visibleMembers.length > 0 ? [<Fragment key="members">{children(visibleMembers)}</Fragment>] : []),
    ...(extrasCard ? [<Fragment key="extras">{extrasCard}</Fragment>] : []),
    ...suggestionCards,
    ...rootFolders,
  ];

  async function save(remove = false) {
    if (!draft || busy) return;
    setBusy(true); setError(null);
    try {
      if (!remove && !draft.id && draft.targetIds.length === 0) {
        // A group that only has a 기타: its members come later, by 캐릭터로 or by adding characters.
        await characterExtrasApi.createGroup(seriesId, draft.name.trim());
        setDraft(null);
        setRevision(value => value + 1);
        onGroupsChanged?.();
        return;
      }
      await invoke("save_character_group", { request: {
        id: draft.id || null, seriesId, expectedRevision: draft.id ? draft.revision : null,
        name: draft.name, targetIds: draft.targetIds, delete: remove,
      } });
      // A group whose 기타 still holds images stays when its last member leaves.
      const editing = groups.find(group => group.id === draft.id);
      const keeps = Boolean(editing?.extrasTargetId) && (memberCounts[editing!.extrasTargetId!] ?? 0) > 0;
      const removedId = remove || (!draft.targetIds.length && !keeps) ? draft.id : null;
      setDraft(null);
      if (removedId && activeGroupId === removedId) onOpenGroup?.(null);
      setRevision(value => value + 1);
      onGroupsChanged?.();
    } catch (error) {
      setError(commandErrorMessage(error, "그룹을 저장하지 못했습니다."));
    } finally { setBusy(false); }
  }

  return <>
    {/* A group view starts with its member tiles: the breadcrumb returns to the series and 그룹 편집 lives in the titlebar menu. */}
    {(labelParts.length > 0 || headerAccessory) && <FolderShelf
      label={labelParts.map(([kind, count]) => count > 0 ? `${kind} ${count.toLocaleString()}` : kind).join(" · ")}
      appearanceKey="classification-characters"
      cards={cards}
      accessory={headerAccessory}
      className="series-characters"
      labelClassName="character-group-heading"
      ariaLabel={current ? `${current.name} 그룹 캐릭터` : folderCards?.length ? "캐릭터와 일반 폴더" : "등록 캐릭터"}
    />}
    {!labelParts.length && !cards.length && <p className="series-empty">캐릭터를 등록하고 레퍼런스를 선택하세요.</p>}
    {error && <p className="character-message" role="alert">{error}<Button size="sm" onClick={() => setRevision(value => value + 1)}>다시 시도</Button></p>}
    {draft && <Dialog open title={draft.id ? "캐릭터 그룹 편집" : "캐릭터 그룹 만들기"} onClose={() => { if (!busy) setDraft(null); }}>
      <TextField label="그룹 이름" value={draft.name} maxLength={100} disabled={busy} onChange={event => setDraft({ ...draft, name: event.target.value })} />
      <p>탐색 목록만 묶습니다. 시리즈 소속, 이미지 분류와 분석 범위는 바뀌지 않습니다.</p>
      <p>소속 캐릭터가 모두 빠져도 기타에 이미지가 있으면 그룹은 남습니다. 둘 다 비면 자동으로 해제됩니다.</p>
      <div className="character-group-members">{members.filter(target => !grouped.has(target.id) || groups.find(group => group.id === draft.id)?.targetIds.includes(target.id)).map(target => <label key={target.id}>
        <input type="checkbox" disabled={busy} checked={draft.targetIds.includes(target.id)} onChange={event => setDraft({ ...draft, targetIds: event.target.checked ? [...draft.targetIds, target.id] : draft.targetIds.filter(id => id !== target.id) })} />
        {target.displayName}
      </label>)}</div>
      {error && <p role="alert">{error}</p>}
      <div className="character-actions"><Button disabled={busy || !draft.name.trim()} onClick={() => void save()}>{!draft.id && !draft.targetIds.length ? "기타만 있는 그룹 만들기" : draft.id && !draft.targetIds.length && !(draftGroup?.extrasTargetId && (memberCounts[draftGroup.extrasTargetId] ?? 0) > 0) ? "빈 그룹 해제" : "저장"}</Button>{draft.id && <Button variant="ghost" disabled={busy} onClick={() => void save(true)}>그룹 해제 · 캐릭터 유지</Button>}</div>
    </Dialog>}
  </>;
}

const GROUP_MOSAIC_SLOTS = 4;

function CharacterGroupCard({ seriesId, group, members, extrasPreviewApi, extrasPreviewVersion, memberCounts, privacyMode, onOpen, onEdit }: { seriesId: string; group: Group; extrasPreviewApi?: Pick<CharacterHubApi, "browse">; extrasPreviewVersion: number; members: CharacterTarget[]; memberCounts: Record<string, number | undefined>; privacyMode: boolean; onOpen: () => void; onEdit: () => void }) {
  const { groupMembers, previews } = groupPreviewMembers(group, members);
  // Members first; the free slots (if any) are filled with the group's own 기타 images. At most one read per card and refresh.
  const wantsExtras = Boolean(extrasPreviewApi && group.extrasTargetId && previews.length < GROUP_MOSAIC_SLOTS);
  const extrasRead = useExtrasPreviews(seriesId, wantsExtras ? group.extrasTargetId! : null, extrasPreviewVersion, extrasPreviewApi);
  const extrasPreviews = wantsExtras ? (extrasRead ?? []).slice(0, GROUP_MOSAIC_SLOTS - previews.length) : [];
  const slotCount = previews.length + extrasPreviews.length;
  const pending = wantsExtras && extrasRead === undefined && previews.length === 0;
  const count = [...groupMembers.map(member => member.id), ...(group.extrasTargetId ? [group.extrasTargetId] : [])].reduce<number | undefined>((sum, id) => {
    const next = memberCounts[id];
    return next === undefined ? sum : (sum ?? 0) + next;
  }, undefined);
  return <article className="series-character folder-shelf__card series-character--group">
    <button className="series-character__open" aria-label={`${group.name} 그룹 열기`} aria-description={`${group.targetIds.length.toLocaleString()}명${groupMembers.length ? ` · ${groupMembers.map(member => member.displayName).join(" · ")}` : ""}${group.extrasTargetId ? " · 기타" : ""}`} onClick={onOpen}>
      <span className="character-group-card__mosaic" data-count={Math.max(1, slotCount)}>
        {previews.map(target => {
          const image = groupMemberImage(target);
          return privacyMode ? <span key={target.id} className="character-group-card__slot privacy-mask" aria-label="비공개 모드"/> : image ? <AssetImage key={target.id} draggable={false} loading="lazy" src={image} alt="" /> : <span key={target.id} className="character-group-card__slot"><PhotoIcon aria-hidden="true" /></span>;
        })}
        {extrasPreviews.map(preview => privacyMode
          ? <span key={`extras:${preview.id}`} className="character-group-card__slot privacy-mask" aria-label="비공개 모드"/>
          : <AssetImage key={`extras:${preview.id}`} draggable={false} loading="lazy" src={preview.src} alt="" />)}
        {slotCount === 0 && <span className="character-group-card__slot">{!pending && <UserGroupIcon aria-hidden="true" />}</span>}
      </span>
      <strong><UserGroupIcon className="character-group-card__icon" aria-hidden="true" /><span className="series-character__name">{group.name}</span></strong>
      <small className="folder-shelf__meta" aria-hidden={count === undefined || undefined}>{count === undefined ? null : `${count.toLocaleString("ko-KR")}장`}</small>
    </button>
    <Button className="series-character__info" size="icon" variant="ghost" aria-label={`${group.name} 그룹 편집`} aria-description="그룹 편집" onClick={onEdit}><PencilIcon aria-hidden="true" /></Button>
  </article>;
}
