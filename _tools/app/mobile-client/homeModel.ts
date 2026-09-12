import type {Classification} from './types';

export const RECENT_FOLDERS_KEY = 'lakomics.mobile.recentFolders';
export function dayNumber(date = new Date()) {
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);
}
export function discoveryFolders(items: Classification[], day = dayNumber()) {
  const byId = new Map(items.map(item => [item.id,item]));
  const rootFor = (item:Classification) => {
    const path:string[] = [], visited = new Map<string,number>();
    let current = item;
    while (true) {
      const cycle = visited.get(current.id);
      // Every entry into the same malformed cycle must resolve to the same group.
      if (cycle !== undefined) return path.slice(cycle).sort()[0];
      visited.set(current.id,path.length); path.push(current.id);
      const parent = current.parent_id ? byId.get(current.parent_id) : undefined;
      if (!parent) return current.id;
      current = parent;
    }
  };
  const grouped = new Map<string,Classification[]>();
  for (const item of byId.values()) if (item.asset_count > 0) {
    const root = rootFor(item);
    const group = grouped.get(root);
    if (group) group.push(item); else grouped.set(root,[item]);
  }
  const groups = [...grouped].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([,group]) => group.sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const offset = (length:number) => ((day % length) + length) % length;
  const result:Classification[] = [];
  const count = Math.min(4,groups.reduce((sum,group) => sum+group.length,0));
  // First pass gives distinct roots a slot; later passes fill from their remaining candidates.
  for (let round=0;result.length<count;round++) {
    for (let index=0;index<groups.length && result.length<count;index++) {
      const group = groups[(offset(groups.length)+index)%groups.length];
      if (round<group.length) result.push(group[(offset(group.length)+round)%group.length]);
    }
  }
  return result;
}
export function folderBreadcrumb(item: Classification, items: Classification[]) {
  const byId = new Map(items.map(folder => [folder.id,folder]));
  const names: string[] = [], seen = new Set<string>();
  let current: Classification | undefined = item;
  while (current && !seen.has(current.id)) {
    seen.add(current.id); names.unshift(current.name);
    current = current.parent_id ? byId.get(current.parent_id) : undefined;
  }
  return names.join(' / ');
}
export function readRecentFolders(scope:string): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(RECENT_FOLDERS_KEY) ?? 'null');
    return saved?.scope === scope && Array.isArray(saved.ids) ? saved.ids.filter((id:unknown) => typeof id === 'string').slice(0,6) : [];
  } catch {return [];}
}
export function rememberFolder(ids:string[], id:string) {return [id,...ids.filter(value => value !== id)].slice(0,6);}
