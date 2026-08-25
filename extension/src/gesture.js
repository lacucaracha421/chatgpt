(() => {
  "use strict";

  const OPEN_DISTANCE_PX = 12;
  const TOUCH_CANCEL_DISTANCE_PX = 20;
  const DWELL_MS = 300;
  const CENTER_RADIUS = 42;
  const PRIMARY_INNER_RADIUS = 48;
  const PRIMARY_OUTER_RADIUS = 110;
  const SECONDARY_INNER_RADIUS = 118;
  const SECONDARY_OUTER_RADIUS = 180;
  const CONTROL_RADIUS = 210;
  const CONTROL_HIT_HALF_HEIGHT = 72;
  const SECONDARY_CLUSTER_ARC_MAX = (Math.PI / 180) * 140;
  const SECONDARY_SECTOR_MIN_SPAN = (Math.PI / 180) * 28;
  const SECONDARY_SECTOR_GAP = (Math.PI / 180) * 2;
  const SECONDARY_FULL_CIRCLE_THRESHOLD = 6;

  function primaryAngle(index, count) {
    return -Math.PI / 2 + (Math.PI * 2 * index) / count;
  }

  function secondaryAngles(primaryIndex, primaryCount, secondaryCount) {
    const safeCount = Math.max(1, secondaryCount || 1);
    const anchor = primaryAngle(primaryIndex, primaryCount);
    const gap = SECONDARY_SECTOR_GAP;
    const useFullCircle = safeCount > SECONDARY_FULL_CIRCLE_THRESHOLD;
    const maxArc = useFullCircle ? Math.PI * 2 : SECONDARY_CLUSTER_ARC_MAX;
    const naturalArc = (Math.PI * 2 * safeCount) / Math.max(primaryCount, 1);
    const minArc = safeCount * SECONDARY_SECTOR_MIN_SPAN + gap * (safeCount - 1);
    const arc = Math.min(maxArc, Math.max(naturalArc, minArc));
    const sectorSpan = (arc - gap * (safeCount - 1)) / safeCount;
    const startAngle = useFullCircle ? -Math.PI / 2 : anchor - arc / 2;
    const angles = [];
    for (let i = 0; i < safeCount; i++) {
      const start = startAngle + i * (sectorSpan + gap);
      const end = start + sectorSpan;
      angles.push({ start, end, center: (start + end) / 2 });
    }
    return angles;
  }

  function normalizeAngle(angle) {
    const twoPi = Math.PI * 2;
    return (angle % twoPi + twoPi) % twoPi;
  }

  function isAngleWithin(angle, start, end) {
    const a = normalizeAngle(angle);
    const s = normalizeAngle(start);
    const e = normalizeAngle(end);
    if (s <= e) return a >= s && a <= e;
    return a >= s || a <= e;
  }

  function createSession(origin, entries, layout, pinnedIds = [], options = {}) {
    let opened = options.openImmediately === true;
    const centerSelectsExpandedParent = options.centerSelectsExpandedParent === true;
    const confirmSelectionWithCenter = options.confirmSelectionWithCenter === true;
    let expandedParentId = null;
    let pendingClassificationId = null;
    let lastExpandedParentId = null;
    let primaryPage = 0;
    let secondaryPage = 0;
    let hover = null;
    let hoverSince = null;
    let dwellDeadline = null;
    let lastPoint = null;

    function move(point, time) {
      lastPoint = point;
      if (!opened) {
        if (distance(origin, point) < OPEN_DISTANCE_PX) return snapshot();
        opened = true;
      }
      const target = hitTest(point);
      if (!sameTarget(target, hover)) {
        if (target.type === "center") {
          if (expandedParentId !== null && !centerSelectsExpandedParent) {
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
      return selectionAction(currentTarget());
    }

    function activate() {
      if (!opened) return { type: "click" };
      const target = currentTarget();

      if (confirmSelectionWithCenter) {
        if (target?.type === "center") {
          const classificationId = pendingClassificationId ?? expandedParentId;
          return classificationId
            ? { type: "select", classificationId }
            : { type: "cancel" };
        }
        if (target?.type === "primary-slot" && target.entry) {
          pendingClassificationId = target.entry.id;
          const hasChildren = entries.some((entry) => entry.parentId === target.entry.id);
          if (hasChildren && expandedParentId !== target.entry.id) {
            expandedParentId = target.entry.id;
            secondaryPage = 0;
            hover = null;
            hoverSince = null;
            dwellDeadline = null;
            return { type: "expand", classificationId: target.entry.id };
          }
          return { type: "pending", classificationId: target.entry.id };
        }
        if (target?.type === "secondary-slot" && target.entry) {
          pendingClassificationId = target.entry.id;
          return { type: "pending", classificationId: target.entry.id };
        }
        return selectionAction(target);
      }

      if (target?.type === "center" && expandedParentId !== null) {
        return { type: "select", classificationId: expandedParentId };
      }
      if (target?.type === "primary-slot" && target.entry
        && entries.some((entry) => entry.parentId === target.entry.id)
        && expandedParentId !== target.entry.id) {
        expandedParentId = target.entry.id;
        secondaryPage = 0;
        hover = null;
        hoverSince = null;
        dwellDeadline = null;
        return { type: "expand", classificationId: target.entry.id };
      }
      return selectionAction(target);
    }

    function currentTarget() {
      if (hover) return hover;
      return lastPoint ? hitTest(lastPoint) : null;
    }

    function selectionAction(target) {
      if (target?.type === "secondary-slot" && target.entry) {
        return { type: "select", classificationId: target.entry.id };
      }
      if (target?.type === "primary-slot" && target.entry) {
        return { type: "select", classificationId: target.entry.id };
      }
      if (target?.type === "center") return { type: "cancel" };
      return { type: "cancel" };
    }

    function hitTest(point) {
      const dx = point.x - origin.x;
      const dy = point.y - origin.y;
      const radius = Math.hypot(dx, dy);

      if (radius <= CENTER_RADIUS) return { type: "center" };

      if (expandedParentId !== null && radius >= SECONDARY_INNER_RADIUS && radius <= SECONDARY_OUTER_RADIUS) {
        const primaryLevel = currentPrimaryLevel();
        const secondaryLevel = currentSecondaryLevel();
        const primaryIndex = primaryLevel.slots.findIndex((s) => s?.id === expandedParentId);
        const angles = secondaryAngles(primaryIndex, primaryLevel.slotCount, secondaryLevel.slotCount);
        const pointAngle = Math.atan2(dy, dx);
        for (let i = 0; i < angles.length; i++) {
          if (isAngleWithin(pointAngle, angles[i].start, angles[i].end)) {
            return { type: "secondary-slot", index: i, entry: secondaryLevel.slots[i] ?? null };
          }
        }
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
      return globalThis.LakomicsRadial.getPinnedLevel(entries, layout, pinnedIds, primaryPage);
    }

    function currentSecondaryLevel() {
      return globalThis.LakomicsRadial.getLevel(entries, layout, expandedParentId, secondaryPage);
    }

    function snapshot() {
      const primaryLevel = currentPrimaryLevel();
      primaryPage = primaryLevel.page;
      const secondaryLevel = expandedParentId !== null ? currentSecondaryLevel() : null;
      if (secondaryLevel) secondaryPage = secondaryLevel.page;
      let secondaryAnglesResult = null;
      if (secondaryLevel) {
        const primaryIndex = primaryLevel.slots.findIndex((s) => s?.id === expandedParentId);
        secondaryAnglesResult = secondaryAngles(primaryIndex, primaryLevel.slotCount, secondaryLevel.slotCount);
      }
      return {
        opened,
        expandedParentId,
        pendingClassificationId,
        primaryPage,
        secondaryPage,
        hover,
        hoverSince,
        dwellDeadline,
        primaryLevel,
        secondaryLevel,
        secondaryAngles: secondaryAnglesResult,
      };
    }

    return { move, tick, release, activate, snapshot };
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
    TOUCH_CANCEL_DISTANCE_PX,
    DWELL_MS,
    CENTER_RADIUS,
    PRIMARY_INNER_RADIUS,
    PRIMARY_OUTER_RADIUS,
    SECONDARY_INNER_RADIUS,
    SECONDARY_OUTER_RADIUS,
    CONTROL_RADIUS,
    SECONDARY_CLUSTER_ARC_MAX,
    createSession,
    distance,
    secondaryAngles,
    primaryAngle,
    normalizeAngle,
    isAngleWithin,
  };
})();
