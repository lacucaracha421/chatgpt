export type StageBox = { width: number; height: number };
const CASE_HEIGHT = 520;
const CASE_DEPTH = 34;
const FLAT_SPINE = 40;
const EDGE_TARGETS = 112;
const VERTICAL_SPACE = 48;
// Reserve perspective/tilt room even when the opened object is dragged edge-on.
const PROJECTION_ROOM = 1.25;

export function fitCollectionCase(box: StageBox, ratio: number, open: boolean) {
  const width = CASE_HEIGHT * ratio * (open ? 2 : 1) + CASE_DEPTH;
  const scale = Math.max(0, Math.min(1, (box.width - EDGE_TARGETS) / (width * PROJECTION_ROOM), (box.height - VERTICAL_SPACE) / (CASE_HEIGHT * PROJECTION_ROOM)));
  return { height: CASE_HEIGHT * scale, scale };
}

export function fitFlatJacket(box: StageBox, ratio: number) {
  const scale = Math.max(0, Math.min(1, (box.width - EDGE_TARGETS) / (CASE_HEIGHT * ratio * 2 + FLAT_SPINE), (box.height - VERTICAL_SPACE * 2) / CASE_HEIGHT));
  return { height: CASE_HEIGHT * scale, spine: FLAT_SPINE * scale };
}
