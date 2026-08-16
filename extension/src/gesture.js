(() => {
  "use strict";

  const OPEN_DISTANCE_PX = 12;
  const DWELL_MS = 300;
  const CENTER_RADIUS = 42;
  const PRIMARY_INNER_RADIUS = 48;
  const PRIMARY_OUTER_RADIUS = 110;
  const SECONDARY_INNER_RADIUS = 130;
  const SECONDARY_OUTER_RADIUS = 185;
  const CONTROL_RADIUS = 210;
  const CONTROL_HIT_HALF_HEIGHT = 72;

  function createSession(origin, entries, layout) {
    let opened = false;
    let expandedParentId = null;
    let lastExpandedParentId = null;
    let primaryPage = 0;
    let secondaryPage = 0;
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
        if (target.type === "center") {
          if (expandedParentId !== null) {
            lastExpandedParentId = expandedParentId;
            expandedParentId = null;
            secondaryPage = 0;
          }
        } else {
          lastExpandedParentId = null;
        }
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
      if (hover?.type === "secondary-slot" && hover.entry) {
        return { type: "select", classificationId: hover.entry.id };
      }
      if (hover?.type === "primary-slot" && hover.entry) {
        return { type: "select", classificationId: hover.entry.id };
      }
      if (hover?.type === "center" && lastExpandedParentId) {
        return { type: "select", classificationId: lastExpandedParentId };
      }
      if (hover?.type === "center") {
        return { type: "cancel" };
      }
      return { type: "cancel" };
    }

    function hitTest(point) {
      const dx = point.x - origin.x;
      const dy = point.y - origin.y;
      const radius = Math.hypot(dx, dy);

      if (radius <= CENTER_RADIUS) return { type: "center" };

      if (expandedParentId !== null && radius >= SECONDARY_INNER_RADIUS && radius <= SECONDARY_OUTER_RADIUS) {
        const level = currentSecondaryLevel();
        const sector = (Math.PI * 2) / level.slotCount;
        const angle = (Math.atan2(dy, dx) + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2);
        const index = Math.floor(((angle + sector / 2) % (Math.PI * 2)) / sector);
        return { type: "secondary-slot", index, entry: level.slots[index] ?? null };
      }

      if (radius >= PRIMARY_INNER_RADIUS && radius <= PRIMARY_OUTER_RADIUS) {
        const level = currentPrimaryLevel();
        const sector = (Math.PI * 2) / level.slotCount;
        const angle = (Math.atan2(dy, dx) + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2);
        const index = Math.floor(((angle + sector / 2) % (Math.PI * 2)) / sector);
        return { type: "primary-slot", index, entry: level.slots[index] ?? null };
      }

      if (radius <= CONTROL_RADIUS && Math.abs(dy) <= CONTROL_HIT_HALF_HEIGHT) {
        if (dx > SECONDARY_OUTER_RADIUS) {
          if (expandedParentId !== null) {
            const level = currentSecondaryLevel();
            if (secondaryPage + 1 < level.pageCount) return { type: "next" };
          } else {
            const level = currentPrimaryLevel();
            if (primaryPage + 1 < level.pageCount) return { type: "next" };
          }
        }
        if (dx < -SECONDARY_OUTER_RADIUS) {
          if (expandedParentId !== null) {
            if (secondaryPage > 0) return { type: "previous" };
          } else {
            if (primaryPage > 0) return { type: "previous" };
          }
        }
      }
      return { type: "outside" };
    }

    function canDwell(target) {
      if (target?.type === "next" || target?.type === "previous") return true;
      if (target?.type !== "primary-slot") return false;
      if (!target.entry) return false;
      return entries.some((entry) => entry.parentId === target.entry.id);
    }

    function applyDwell() {
      if (hover?.type === "primary-slot" && hover.entry
        && entries.some((entry) => entry.parentId === hover.entry.id)) {
        if (expandedParentId !== hover.entry.id) {
          expandedParentId = hover.entry.id;
          secondaryPage = 0;
        }
      } else if (hover?.type === "next") {
        if (expandedParentId !== null) secondaryPage += 1;
        else primaryPage += 1;
      } else if (hover?.type === "previous") {
        if (expandedParentId !== null) secondaryPage -= 1;
        else primaryPage -= 1;
      }
      hover = null;
      hoverSince = null;
      dwellDeadline = null;
    }

    function currentPrimaryLevel() {
      return globalThis.LakomicsRadial.getLevel(entries, layout, null, primaryPage);
    }

    function currentSecondaryLevel() {
      return globalThis.LakomicsRadial.getLevel(entries, layout, expandedParentId, secondaryPage);
    }

    function snapshot() {
      const primaryLevel = currentPrimaryLevel();
      primaryPage = primaryLevel.page;
      const secondaryLevel = expandedParentId !== null ? currentSecondaryLevel() : null;
      if (secondaryLevel) secondaryPage = secondaryLevel.page;
      return {
        opened,
        expandedParentId,
        primaryPage,
        secondaryPage,
        hover,
        hoverSince,
        dwellDeadline,
        primaryLevel,
        secondaryLevel,
      };
    }

    return { move, tick, release, snapshot };
  }

  function distance(a, b) {
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  function sameTarget(a, b) {
    if (!a || !b || a.type !== b.type) return false;
    if (a.type === "primary-slot" || a.type === "secondary-slot") return a.index === b.index;
    return true;
  }

  globalThis.LakomicsGesture = {
    OPEN_DISTANCE_PX,
    DWELL_MS,
    CENTER_RADIUS,
    PRIMARY_INNER_RADIUS,
    PRIMARY_OUTER_RADIUS,
    SECONDARY_INNER_RADIUS,
    SECONDARY_OUTER_RADIUS,
    CONTROL_RADIUS,
    createSession,
    distance,
  };
})();
