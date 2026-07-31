export type JustifiedSource = {
  id: string;
  width: number;
  height: number;
};

export type JustifiedRow<T extends JustifiedSource> = {
  height: number;
  items: T[];
};

// A nearly full widow is completed so small width rounding does not leave a
// conspicuous trailing gap; clearly incomplete rows stay at target height.
const FINAL_ROW_COMPLETION_RATIO = 0.9;

export function buildJustifiedRows<T extends JustifiedSource>(
  items: T[],
  containerWidth: number,
  targetHeight: number,
  gap: number,
): JustifiedRow<T>[] {
  if (
    !Number.isFinite(containerWidth) ||
    containerWidth <= 0 ||
    !Number.isFinite(targetHeight) ||
    targetHeight <= 0 ||
    !Number.isFinite(gap) ||
    gap < 0 ||
    gap >= containerWidth ||
    items.some(
      (item) =>
        !Number.isFinite(item.width) ||
        item.width <= 0 ||
        !Number.isFinite(item.height) ||
        item.height <= 0 ||
        !Number.isFinite((item.width / item.height) * targetHeight),
    )
  ) {
    return [];
  }

  const rows: JustifiedRow<T>[] = [];
  let pending: T[] = [];
  for (const item of items) {
    pending.push(item);
    if (gap * (pending.length - 1) >= containerWidth) {
      const overflow = pending.pop()!;
      rows.push(completedRow(pending, containerWidth, gap));
      pending = [overflow];
    }
    if (widthAtTarget(pending, targetHeight, gap) >= containerWidth) {
      rows.push(completedRow(pending, containerWidth, gap));
      pending = [];
    }
  }

  if (pending.length > 0) {
    const shouldComplete =
      widthAtTarget(pending, targetHeight, gap) >=
      containerWidth * FINAL_ROW_COMPLETION_RATIO;
    rows.push(
      shouldComplete
        ? completedRow(pending, containerWidth, gap)
        : rowAtHeight(pending, targetHeight),
    );
  }
  return rows;
}

function widthAtTarget<T extends JustifiedSource>(
  items: T[],
  targetHeight: number,
  gap: number,
): number {
  return (
    items.reduce(
      (width, item) => width + (item.width / item.height) * targetHeight,
      0,
    ) +
    gap * (items.length - 1)
  );
}

function completedRow<T extends JustifiedSource>(
  items: T[],
  containerWidth: number,
  gap: number,
): JustifiedRow<T> {
  const maxRatio = items.reduce(
    (maximum, item) => Math.max(maximum, item.width / item.height),
    0,
  );
  const normalizedRatioSum = items.reduce(
    (sum, item) => sum + item.width / item.height / maxRatio,
    0,
  );
  const height =
    ((containerWidth - gap * (items.length - 1)) / maxRatio) /
    normalizedRatioSum;
  return rowAtHeight(items, height);
}

function rowAtHeight<T extends JustifiedSource>(
  items: T[],
  height: number,
): JustifiedRow<T> {
  return {
    height,
    items: items.map((item) => ({
      ...item,
      width: (item.width / item.height) * height,
    })),
  };
}
