/**
 * The shared object of a shelf item and its work screen, for the browser's shelf <-> work snapshot
 * (AreaSwitch `hero`): the cover face on the shelf, the front of the stage case or book.
 */
export function collectionHero(key: string, host: HTMLElement, collectionId: string) {
  if (key === "collection-work") return host.querySelector<HTMLElement>('.work-case-slot:not([aria-hidden="true"]) .k-front, .manga-bigbook .manga-bb-front');
  if (key !== "collections") return null;
  const card = Array.from(host.querySelectorAll<HTMLElement>(".collection-card[data-collection-id]")).find(element => element.dataset.collectionId === collectionId);
  return card?.querySelector<HTMLElement>(".cs-front, .collection-card__cover") ?? null;
}
