/** Both galleries reveal only the date group under the pointer or keyboard focus. */
export function revealGalleryDateCount(scroller: HTMLElement | null, target: EventTarget | null) {
  const element = target instanceof Element ? target.closest<HTMLElement>('[data-date-label]') : null;
  scroller?.querySelectorAll<HTMLElement>('[data-gallery-date]').forEach(heading => {
    heading.dataset.active = String(Boolean(element && heading.dataset.dateLabel === element.dataset.dateLabel));
  });
}
