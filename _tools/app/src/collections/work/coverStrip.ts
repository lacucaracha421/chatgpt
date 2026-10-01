// Centre the stored head coordinate within the cover cut, clamped at its edges.
export function stripPosition(focus: number | null, fullWidth: number, stripWidth: number) {
  return focus === null || fullWidth <= stripWidth ? 50 : Math.max(0, Math.min(1, (focus * fullWidth - stripWidth / 2) / (fullWidth - stripWidth))) * 100;
}
