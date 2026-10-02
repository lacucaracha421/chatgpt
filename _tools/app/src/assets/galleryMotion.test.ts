import { describe, expect, it, vi } from 'vitest';
import { anchorScrollTop, animateVisibleTiles, captureVisibleTileRects } from './galleryMotion';
const rect = (x: number, y: number, width = 100, height = 100) => new DOMRect(x, y, width, height);
function fixture() {
  const scroller = document.createElement('div');
  vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 500, 400));
  const space = document.createElement("div"); space.className = "asset-gallery__virtual-space"; scroller.append(space);
  vi.spyOn(space, "getBoundingClientRect").mockReturnValue(rect(0, 0, 500, 1000));
  const cells = [0, 1, 2].map(index => {
    const cell = document.createElement('div'); cell.dataset.galleryCell = '';
    cell.innerHTML = `<div data-asset-id="${index}"></div>`;
    cell.style.cssText = `left:20px;top:${index === 2 ? 900 : index * 100}px;width:100px;height:100px`;
    space.append(cell);
    vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue(rect(20, index === 2 ? 900 : index * 100));
    cell.animate = vi.fn().mockReturnValue({ cancel: vi.fn() });
    return cell;
  });
  return { scroller, cells };
}
describe('gallery spatial motion', () => {
  it('measures and animates only tiles in the viewport, using translation and 200 ms', () => {
    const { scroller, cells } = fixture();
    const first = captureVisibleTileRects(scroller);
    expect([...first.keys()]).toEqual(['0', '1']);
    expect(cells[2].getBoundingClientRect).not.toHaveBeenCalled();
    cells[0].style.left = "80px"; cells[0].style.top = "40px";
    cells[1].style.top = "800px";
    vi.mocked(cells[0].getBoundingClientRect).mockReturnValue(rect(80, 40));
    vi.mocked(cells[1].getBoundingClientRect).mockReturnValue(rect(200, 800));
    const animations = animateVisibleTiles(scroller, first, false);
    expect(animations).toHaveLength(1);
    expect(cells[0].animate).toHaveBeenCalledWith([{ transform: 'translate(-60px, -40px)' }, { transform: 'translate(0, 0)' }], expect.objectContaining({ duration: 200 }));
    expect(cells[1].animate).not.toHaveBeenCalled();
    expect(cells[2].animate).not.toHaveBeenCalled();
  });
  it('switches instantly under reduced motion', () => {
    const { scroller, cells } = fixture();
    expect(animateVisibleTiles(scroller, captureVisibleTileRects(scroller), true)).toEqual([]);
    cells.forEach(cell => expect(cell.animate).not.toHaveBeenCalled());
  });
  it('keeps the top tile at its offset after reflow, and tolerates missing anchors', () => {
    const previous = [{ asset: { id: 'a' }, top: 0, height: 120 }, { asset: { id: 'b' }, top: 128, height: 120 }];
    const next = [{ asset: { id: 'a' }, top: 0, height: 240 }, { asset: { id: 'b' }, top: 248, height: 240 }];
    expect(anchorScrollTop(previous, next, 148)).toBe(268);
    expect(anchorScrollTop(previous, [], 148)).toBe(148);
  });
});
