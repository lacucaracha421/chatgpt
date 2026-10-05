import { Component, type ReactNode, type RefObject } from 'react';
import { READY_CAP_MS } from '../shared/motion/AreaSwitch';
import { IMAGE_READY_CAP_MS, revealTogether, waitForViewportImages } from '../shared/motion/viewportImages';

/** AssetBrowser supplies a serialized query; sort/filter changes are not navigation. */
export function folderMoveScope(scopeKey?: string) {
  if (!scopeKey) return scopeKey;
  try {
    const query = JSON.parse(scopeKey);
    if (query && typeof query === 'object') return JSON.stringify([
      query.classificationId ?? null, query.albumId ?? null, query.collectionId ?? null,
      query.creatorKey ?? null, query.unclassifiedOnly ?? false,
    ]);
  } catch { /* Other gallery owners may supply a plain scope identity. */ }
  return scopeKey;
}

type Props = { scope?: string; queryKey?: string; visible: boolean; privacyKey: string; count: number; host: RefObject<HTMLDivElement | null>; children: ReactNode };
const interactionEvents = ['wheel', 'pointerdown', 'keydown', 'touchstart'] as const;

function visibleCells(host: HTMLElement) {
  const viewport = host.getBoundingClientRect();
  return Array.from(host.querySelectorAll<HTMLElement>('[data-gallery-cell]')).map(cell => ({cell, rect: cell.getBoundingClientRect()}))
    .filter(({rect}) => rect.width > 0 && rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom && rect.right > viewport.left && rect.left < viewport.right);
}

/**
 * Folder to folder: the old folder's decoded images stay painted while the new tiles wait hidden for
 * their first viewport (capped), then the new folder appears in one step with no animation (user
 * 2026-10-05). A pre-mutation snapshot is needed: layout-effect cleanup already sees replaced tiles.
 */
export class FolderMove extends Component<Props> {
  private layer: HTMLDivElement | null = null;
  private frame = 0;
  private timer = 0;
  private generation = 0;
  private scrollTop = 0;
  private stopImages: (() => void) | undefined;
  /** Releases first-screen tiles still loading at the cap; they appear together, not one by one. */
  private releaseLate: (() => void) | undefined;

  getSnapshotBeforeUpdate(previous: Props) {
    if (!previous.visible || !this.props.visible || previous.scope === undefined || previous.scope === this.props.scope || previous.privacyKey !== this.props.privacyKey) return null;
    const host = this.props.host.current;
    if (!host || !this.props.count) return null;
    if (this.layer) return this.layer;
    const viewport = host.getBoundingClientRect();
    const layer = document.createElement('div');
    layer.className = 'asset-gallery__folder-snapshot';
    layer.setAttribute('inert', ''); layer.setAttribute('aria-hidden', 'true');
    for (const {cell} of visibleCells(host)) {
      // Only copy decoded, visible images. No tile subtrees, video capture or new loads.
      for (const source of cell.querySelectorAll('img')) {
        if (!source.complete || !source.naturalWidth) continue;
        const style = getComputedStyle(source);
        if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;
        const imageRect = source.getBoundingClientRect();
        if (!imageRect.width || !imageRect.height) continue;
        const clone = document.createElement('img');
        clone.src = source.currentSrc || source.src;
        clone.alt = source.alt;
        Object.assign(clone.style, {position: 'absolute', left: `${imageRect.left - viewport.left}px`, top: `${imageRect.top - viewport.top}px`, width: `${imageRect.width}px`, height: `${imageRect.height}px`, objectFit: style.objectFit, objectPosition: style.objectPosition, borderRadius: style.borderRadius, filter: style.filter, opacity: style.opacity});
        layer.append(clone);
      }
    }
    return layer.childElementCount ? layer : null;
  }

  componentDidUpdate(previous: Props, _state: unknown, snapshot: HTMLDivElement | null) {
    if (previous.queryKey !== this.props.queryKey || previous.scope !== this.props.scope || !this.props.visible || previous.privacyKey !== this.props.privacyKey) { this.finish(); this.releaseLate?.(); }
    if (!snapshot) return;
    const host = this.props.host.current!;
    this.layer = snapshot;
    host.append(snapshot);
    host.dataset.folderMove = 'pending';
    this.positionSnapshot();
    for (const event of interactionEvents) host.addEventListener(event, this.finish, {capture: true, passive: true});
    host.addEventListener('scroll', this.onScroll);
    const generation = this.generation;
    this.timer = window.setTimeout(this.finish, READY_CAP_MS);
    // Let scope scroll restoration and virtual row measurement settle before choosing the batch.
    this.frame = window.requestAnimationFrame(() => {
      this.frame = 0;
      this.positionSnapshot();
      const cells = visibleCells(host);
      if (!cells.length) { this.finish(); return; }
      // Ready: drop the old images and unhide the new tiles together, in one step.
      this.stopImages = waitForViewportImages(host, () => { if (generation === this.generation) this.finish(); }, IMAGE_READY_CAP_MS, late => {
        // Hold late tiles past the swap until the whole batch is ready (within the fail-safe).
        this.releaseLate?.();
        this.releaseLate = revealTogether(late, READY_CAP_MS - IMAGE_READY_CAP_MS);
      });
    });
  }

  private positionSnapshot() {
    const host = this.props.host.current!;
    this.scrollTop = host.scrollTop;
    if (this.layer) Object.assign(this.layer.style, {top: `${host.scrollTop}px`, left: `${host.scrollLeft}px`, width: `${host.clientWidth}px`, height: `${host.clientHeight}px`});
  }
  private onScroll = () => { if (!this.frame && this.props.host.current?.scrollTop !== this.scrollTop) this.finish(); };
  private finish = () => {
    this.generation++;
    this.stopImages?.(); this.stopImages = undefined;
    window.cancelAnimationFrame(this.frame); window.clearTimeout(this.timer);
    this.frame = 0; this.timer = 0;
    this.layer?.remove(); this.layer = null;
    const host = this.props.host.current;
    if (host) {
      delete host.dataset.folderMove;
      for (const event of interactionEvents) host.removeEventListener(event, this.finish, true);
      host.removeEventListener('scroll', this.onScroll);
    }
  };
  componentWillUnmount() { this.finish(); this.releaseLate?.(); }
  render() { return this.props.children; }
}
