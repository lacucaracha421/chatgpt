(() => {
  "use strict";

  const OPEN_DISTANCE_PX = 12;
  const DWELL_MS = 300;
  const INNER_RADIUS = 42;
  const OUTER_RADIUS = 126;
  const CONTROL_RADIUS = 184;

  function createSession(origin, entries, layout) {
    let opened = false;
    let path = [];
    let page = 0;
    let hover = null;
    let hoverSince = null;
    let dwellDeadline = null;

    function move(point, time) {
      if (!opened) {
        if (distance(origin, point) < OPEN_DISTANCE_PX) return snapshot();
        opened = true;
      }
      const target = hitTest(point);
      if (!sameTarget(target, hover)) {
        hover = target;
        hoverSince = time;
        dwellDeadline = canDwell(target) ? time + DWELL_MS : null;
      } else if (dwellDeadline !== null && time >= dwellDeadline) {
        applyDwell();
      }
      return snapshot();
    }

    function tick(time) {
      if (opened && dwellDeadline !== null && time >= dwellDeadline) applyDwell();
      return snapshot();
    }

    function release() {
      if (!opened) return { type: "click" };
      if (hover?.type === "slot" && hover.entry) {
        return { type: "select", classificationId: hover.entry.id };
      }
      if (hover?.type === "center" && path.length) {
        return { type: "select", classificationId: path.at(-1).id };
      }
      return { type: "cancel" };
    }

    function hitTest(point) {
      const dx = point.x - origin.x;
      const dy = point.y - origin.y;
      const radius = Math.hypot(dx, dy);
      const level = currentLevel();
      if (radius <= INNER_RADIUS) return { type: "center" };
      if (radius <= OUTER_RADIUS) {
        const sector = (Math.PI * 2) / level.slotCount;
        const angle = (Math.atan2(dy, dx) + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2);
        const index = Math.floor(((angle + sector / 2) % (Math.PI * 2)) / sector);
        return { type: "slot", index, entry: level.slots[index] ?? null };
      }
      if (radius <= CONTROL_RADIUS && Math.abs(dy) <= 72) {
        if (dx > OUTER_RADIUS && level.page + 1 < level.pageCount) return { type: "next" };
        if (dx < -OUTER_RADIUS && level.page > 0) return { type: "previous" };
      }
      if (radius <= CONTROL_RADIUS && dy > OUTER_RADIUS && path.length) return { type: "back" };
      return { type: "outside" };
    }

    function canDwell(target) {
      if (target?.type === "next" || target?.type === "previous" || target?.type === "back") return true;
      return target?.type === "slot"
        && target.entry
        && entries.some((entry) => entry.parentId === target.entry.id);
    }

    function applyDwell() {
      if (hover?.type === "slot" && hover.entry
        && entries.some((entry) => entry.parentId === hover.entry.id)) {
        path.push(hover.entry);
        page = 0;
      } else if (hover?.type === "next") {
        page += 1;
      } else if (hover?.type === "previous") {
        page -= 1;
      } else if (hover?.type === "back") {
        path.pop();
        page = 0;
      }
      hover = null;
      hoverSince = null;
      dwellDeadline = null;
    }

    function currentLevel() {
      return globalThis.LakomicsRadial.getLevel(
        entries,
        layout,
        path.at(-1)?.id ?? null,
        page,
      );
    }

    function snapshot() {
      const level = currentLevel();
      page = level.page;
      return {
        opened,
        parentId: path.at(-1)?.id ?? null,
        path: [...path],
        page,
        hover,
        hoverSince,
        dwellDeadline,
        level,
      };
    }

    return { move, tick, release, snapshot };
  }

  function distance(a, b) {
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  function sameTarget(a, b) {
    if (!a || !b || a.type !== b.type) return false;
    return a.type !== "slot" || a.index === b.index;
  }

  globalThis.LakomicsGesture = {
    OPEN_DISTANCE_PX,
    DWELL_MS,
    INNER_RADIUS,
    OUTER_RADIUS,
    createSession,
    distance,
  };
})();
