/**
 * The shared object of a shelf item and its work screen, for the browser's shelf <-> work snapshot
 * (AreaSwitch `hero`). Capture outside the preserve-3d renderer: naming that renderer
 * would flatten its faces. The snapshot must contain the entire case or book.
 */
export function collectionHero(key: string, host: HTMLElement, collectionId: string) {
  if (key === "collection-work") return host.querySelector<HTMLElement>('.work-case-slot:not([aria-hidden="true"]) .collection-case-object, .manga-book-object, .work-flat-slot:not([aria-hidden="true"]) .work-flat-sheet');
  if (key !== "collections") return null;
  // The 책장's pulled-out case is the same 3D model as the work screen's.
  const out = Array.from(host.querySelectorAll<HTMLElement>(".spine-shelf__out:not(.is-leaving):not(.is-preparing)")).find(element => element.dataset.id === collectionId);
  if (out) return out.querySelector<HTMLElement>(".collection-case-object");
  const card = Array.from(host.querySelectorAll<HTMLElement>(".collection-card[data-collection-id]")).find(element => element.dataset.collectionId === collectionId);
  return card?.querySelector<HTMLElement>('.collection-card__light:not([aria-hidden="true"]) .collection-light-case, .collection-card__object:not([aria-hidden="true"]) .collection-card__cover') ?? null;
}
