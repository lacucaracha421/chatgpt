import type {Classification} from './types';

export const RECENT_FOLDERS_KEY = 'lakomics.mobile.recentFolders';
/** The minimum a node needs for a breadcrumb: an identity, a label and its parent. */
export interface BreadcrumbNode {id:string;name:string;parentId:string|null}
/**
 * Names from the root down to `node`.
 *
 * `seen` bounds the walk, so a malformed parent chain — including a cycle — renders a
 * partial path instead of looping. The walk starts at the node itself rather than looking it
 * up, so a node the caller's list does not contain still yields its own name.
 */
function breadcrumbPath(node:BreadcrumbNode,lookup:(id:string)=>BreadcrumbNode|undefined) {
  const names:string[] = [], seen = new Set<string>();
  let current:BreadcrumbNode|undefined = node;
  while (current && !seen.has(current.id)) {
    seen.add(current.id); names.unshift(current.name);
    current = current.parentId ? lookup(current.parentId) : undefined;
  }
  return names.join(' / ');
}
export function folderBreadcrumb(item: Classification, items: Classification[]) {
  const byId = new Map(items.map(folder => [folder.id,folder]));
  return breadcrumbPath({id:item.id,name:item.name,parentId:item.parent_id}, id => {
    const folder = byId.get(id);
    return folder ? {id:folder.id,name:folder.name,parentId:folder.parent_id} : undefined;
  });
}
/**
 * The same breadcrumb over any parent-linked tree.
 *
 * The mobile Classification replica names its parent field `parentId` while the published
 * Classification list names it `parent_id`, so the walk is shared and each caller supplies
 * its own shape rather than the replica growing a second implementation of it.
 */
export function treeBreadcrumb(item:BreadcrumbNode,nodes:readonly BreadcrumbNode[]) {
  const byId = new Map(nodes.map(node => [node.id,node]));
  return breadcrumbPath(item, id => byId.get(id));
}
export function readRecentFolders(scope:string): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(RECENT_FOLDERS_KEY) ?? 'null');
    return saved?.scope === scope && Array.isArray(saved.ids) ? saved.ids.filter((id:unknown) => typeof id === 'string').slice(0,6) : [];
  } catch {return [];}
}
export function rememberFolder(ids:string[], id:string) {return [id,...ids.filter(value => value !== id)].slice(0,6);}
