import { nativeDropClientPoint } from "../app/workspaceDragTargets";

/**
 * A screen piece that takes files dropped on it for itself (Home's 전송 tile sends them to the tablet).
 * The app-wide drop import ignores a drag while the pointer is over a claimed element.
 */
const claims = new Set<HTMLElement>();

export function claimNativeDrop(element: HTMLElement): () => void {
  claims.add(element);
  return () => { claims.delete(element); };
}

export function nativeDropClaimed(position: { x: number; y: number }): boolean {
  if (!claims.size) return false;
  const point = nativeDropClientPoint(position);
  for (const element of claims) {
    const box = element.getBoundingClientRect();
    if (box.width > 0 && box.height > 0 && point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom) return true;
  }
  return false;
}
