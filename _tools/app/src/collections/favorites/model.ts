import type { CharacterTarget } from "../../characters/api";
import type { ClassificationEntry, FavoriteCommand, FavoriteEntry, FavoriteProfile } from "../../library/types";
import { daysUntil } from "../../shared/displayDate";

export const isManualFavorite = (id: string) => id.startsWith("manual-");

/** A manual favourite has presentation data, but never a character folder. */
export function favoriteTargets(entries: FavoriteEntry[], targets: CharacterTarget[]): CharacterTarget[] {
  return entries.flatMap<CharacterTarget>(entry => isManualFavorite(entry.characterId) ? [{
    id: entry.characterId, displayName: entry.name ?? "", seriesClassificationId: null,
    linkedClassificationId: null, enabled: false, manualOnly: true, revision: 0,
    references: [], ready: false, fingerprint: "",
  }] : targets.find(target => target.id === entry.characterId) ?? []);
}

export function createFavoriteCommand(name: string): FavoriteCommand {
  return { op: "create", id: `manual-${crypto.randomUUID()}`, name: name.trim() };
}

export function linkFavoriteCommand(id: string, characterId: string): FavoriteCommand {
  return { op: "link", id, characterId };
}

export function representativeAsset(entry: Pick<FavoriteEntry, "coverAssetId"> | undefined, target: Pick<CharacterTarget, "thumbnailAssetId"> & { id?: string }, firstAssetId?: string | null): string | null {
  if (target.id && isManualFavorite(target.id)) return entry?.coverAssetId ?? null;
  return entry?.coverAssetId ?? target.thumbnailAssetId ?? firstAssetId ?? null;
}

/** Leap-day birthdays wait for the next actual February 29, rather than silently becoming March 1. */
export function birthdayDays(month?: number | null, day?: number | null, now = new Date()): number | null {
  if (!month || !day) return null;
  for (let year = now.getFullYear(); year <= now.getFullYear() + 8; year++) {
    const date: Date = new Date(year, month - 1, day);
    if (date.getMonth() !== month - 1 || date.getDate() !== day) continue;
    const days = daysUntil(date, now)!;
    if (days >= 0) return days <= 30 ? days : null;
  }
  return null;
}

export function containerId(target: CharacterTarget, classifications: ClassificationEntry[]): string | null {
  let folder = classifications.find(item => item.id === target.seriesClassificationId);
  while (folder?.parentId) folder = classifications.find(item => item.id === folder!.parentId);
  return folder?.isContainer ? folder.id : null;
}

export function favoriteScopes(targets: CharacterTarget[], classifications: ClassificationEntry[]) {
  const counts = new Map<string, number>();
  for (const target of targets) {
    const id = containerId(target, classifications);
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [{ value: "all", label: "전체", count: targets.length }, ...classifications
    .filter(folder => !folder.parentId && folder.isContainer && counts.has(folder.id))
    .map(folder => ({ value: folder.id, label: folder.name, count: counts.get(folder.id)! }))];
}

/** Replace only the visible slots. Hidden entries (including deleted characters) keep their places. */
export function reorderCommand(entries: FavoriteEntry[], visibleIds: readonly string[], reorderedIds: readonly string[]): FavoriteCommand | null {
  if (visibleIds.length !== reorderedIds.length || new Set(reorderedIds).size !== visibleIds.length
    || reorderedIds.some(id => !visibleIds.includes(id))) return null;
  const visible = new Set(visibleIds);
  let index = 0;
  const ids = entries.map(entry => visible.has(entry.characterId) ? reorderedIds[index++] : entry.characterId);
  return ids.every((id, i) => id === entries[i].characterId) ? null : { op: "order", ids };
}

/** The profile facts a character detail shows, in this order, on the PC and the tablet. */
export function favoriteFacts(profile: FavoriteProfile): { label: string; value: string; birthday?: boolean }[] {
  const rows: { label: string; value: string | null | undefined; birthday?: boolean }[] = [
    { label: "생일", value: profile.birthMonth && profile.birthDay ? `${profile.birthMonth}월 ${profile.birthDay}일` : null, birthday: true },
    { label: "키", value: profile.heightCm != null ? `${profile.heightCm}cm` : null },
    { label: "성우", value: profile.voiceActor },
    { label: "소속", value: profile.affiliation },
    { label: "메모", value: profile.memo },
  ];
  return rows.flatMap(row => row.value ? [{ ...row, value: row.value }] : []);
}

/** Whether a profile has any fact at all (else the detail offers 정보 추가). */
export const hasFavoriteProfile = (profile: FavoriteProfile) => Object.values(profile).some(value => value != null && value !== "");
