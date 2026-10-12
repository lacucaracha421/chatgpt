import type {SavedPosition} from './types';

/** The place the user was in, kept so a recreated activity or a restarted renderer reopens it instead of Home. */
export type AppArea = 'assets'|'collections'|'catalog'|'notes';
export interface RememberedRoute {area: AppArea; tab: 'home'|'library'; position?: SavedPosition}

export const ROUTE_KEY = 'lakomics.mobile.route';
const AREAS: readonly AppArea[] = ['assets','collections','catalog','notes'];

/** The native host adds `?restore=1` only when the system recreated the activity or the renderer died. */
export function restoreRequested(search = window.location.search) {
  try {return new URLSearchParams(search).get('restore') === '1';} catch {return false;}
}

export function rememberRoute(route: RememberedRoute) {
  try {localStorage.setItem(ROUTE_KEY, JSON.stringify(route));} catch { /* Optional convenience. */ }
}

export function forgetRoute() {
  try {localStorage.removeItem(ROUTE_KEY);} catch { /* Optional convenience. */ }
}

export function recallRoute(): RememberedRoute | null {
  try {
    const raw = localStorage.getItem(ROUTE_KEY);
    const value = raw ? JSON.parse(raw) as Partial<RememberedRoute> : null;
    if (!value || !AREAS.includes(value.area as AppArea) || (value.tab !== 'home' && value.tab !== 'library')) return null;
    const position = value.position;
    const valid = !!position && typeof position === 'object' && !!position.view && typeof position.view === 'object'
      && position.view.tab === 'library' && (position.cursor === null || typeof position.cursor === 'string')
      && Array.isArray(position.previous) && typeof position.scroll === 'number' && !!position.filters && typeof position.filters === 'object';
    return {area: value.area as AppArea, tab: value.tab, ...(valid ? {position: position as SavedPosition} : {})};
  } catch {return null;}
}
