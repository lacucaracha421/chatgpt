export const MIN_SIDEBAR_WIDTH = 176;
export const MAX_SIDEBAR_WIDTH = 320;

export function clampSidebarWidth(width: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}
