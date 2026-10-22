import {breadcrumbPath, type BreadcrumbNode} from '../src/shared/breadcrumb';

export const RECENT_FOLDERS_KEY = 'lakomics.mobile.recentFolders';
/**
 * The same breadcrumb over any parent-linked tree.
 *
 * The mobile Classification replica names its parent field `parentId` while the published
 * Classification list names it `parent_id`, so the walk is shared and each caller supplies
 * its own shape rather than the replica growing a second implementation of it.
 */
export function treeBreadcrumb(item:BreadcrumbNode,nodes:readonly BreadcrumbNode[]) {
  return breadcrumbPath(item,nodes);
}
export function readRecentFolders(scope:string): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(RECENT_FOLDERS_KEY) ?? 'null');
    return saved?.scope === scope && Array.isArray(saved.ids) ? saved.ids.filter((id:unknown) => typeof id === 'string').slice(0,6) : [];
  } catch {return [];}
}
export function rememberFolder(ids:string[], id:string) {return [id,...ids.filter(value => value !== id)].slice(0,6);}
