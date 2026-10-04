import { fireEvent } from '@testing-library/react';

/** jsdom never loads images; emulate the first work's painted images for screen fixtures. */
export function workImageLoads() {
  const loaded = new WeakSet<Element>();
  const settle = () => document.querySelectorAll('[data-motion-view="work"] .tablet-work img').forEach(image => {
    if (image.closest('.motion-stage')?.getAttribute('data-motion-shown') === 'work') return;
    if (image.closest('[data-work-pending]') || loaded.has(image)) return;
    loaded.add(image); fireEvent.load(image);
  });
  const observer = new MutationObserver(settle);
  observer.observe(document.body, {subtree: true, childList: true, attributes: true});
  return () => observer.disconnect();
}
