/**
 * The angle a shelf's pulled-out case was turned to when its work opened, so the work screen's case starts there
 * and the shelf-to-work hero move reads as one object. It applies only to the work opened just now.
 */
let handed: { id: string; angle: number; at: number } | null = null;
const FRESH_MS = 5000;

export function handOffCaseAngle(id: string, angle: number) {
  handed = Number.isFinite(angle) ? { id, angle, at: Date.now() } : null;
}
export function handedCaseAngle(id: string): number | undefined {
  return handed && handed.id === id && Date.now() - handed.at < FRESH_MS ? handed.angle : undefined;
}
