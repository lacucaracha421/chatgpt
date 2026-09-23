(() => {
  "use strict";
  const ROOT_SLOTS = 6, CHILD_SLOTS = 5;
  const DIAL_VISIBLE_SLOTS = 6, DIAL_POOL_SLOTS = 14, DIAL_POOL_LEAD = 4;
  const DIAL_VISUAL_STEP_DEGREES = 360 / DIAL_POOL_SLOTS, DIAL_CENTER_SLOT = (DIAL_VISIBLE_SLOTS - 1) / 2;
  const DIAL_WHEEL_BURST_MS = 110, DIAL_WHEEL_IDLE_MS = 120, DIAL_NOTCH_MS = 220;
  const CENTER_SLOP = 10, CENTER_COMMIT = 48, CENTER_RETURN_MS = 150;
  const CENTER_WHEEL_IDLE_MS = 200, CENTER_TEMPORARY_IDLE_MS = 300, CENTER_PROGRESS_IDLE_MS = 600;
  const CENTER_TEMPORARY_WHEEL_PX = 150, CENTER_WHEEL_NOTCHES = 3, CENTER_STEP_MS = 120, CENTER_HOLD_MS = 120;
  const DIAL_SAMPLE_MS = 100, DIAL_HOLD_MS = 60, DIAL_DECELERATION = .998, DIAL_RUBBER_SPAN = 1.5;

  function mount({ entries, profile, arcLayout, hiddenClassificationIds = [], origin, onSave, onClose, onTemporary = null, inputLocked = false, inputKind = null, container = null, onReorder, onHide }) {
    const editing = Boolean(container);
    const model = globalThis.LakomicsClassificationTree;
    let tree, layout, fullLayout;
    function readModel() {
      tree = model.createModel(model.visibleEntries(entries, hiddenClassificationIds), profile);
      fullLayout = model.reconcileArcLayout(entries, profile, arcLayout);
      const pinned = new Set(tree.profile.pinnedClassificationIds);
      layout = Object.fromEntries(Object.entries(fullLayout).map(([key, value]) => {
        const slots = value.slots.filter(id => id === null || (tree.byId.has(id) && (key === "__root__" || !pinned.has(id))));
        return [key, { ...value, slots: editing ? slots : slots.filter(Boolean) }];
      }));
    }
    readModel();
    const history = [{ id: null, page: 0, selectedId: null, dialPosition: 0 }];
    const previousFocus = document.activeElement;
    const viewport = window.visualViewport;
    const midpoint = (viewport?.offsetLeft || 0) + (viewport?.width || window.innerWidth) / 2;
    const side = !editing && Number.isFinite(origin?.x) && origin.x < midpoint ? "left" : "right";
    let busy = false, disposed = false, locked = Boolean(inputLocked), pointer = null, suppressClick = false;
    let radius = 224, lastTap = null;
    let centerWheel = null, centerWheelTimer = null, centerCommitTimer = null, centerProgress = 0, centerDirection = 1;
    let dialFrame = null, dialVelocity = 0, dialTarget = null, wheelTimer = null, wheelGesture = null;
    let wheelBurstUntil = 0, wheelBurstDirection = 0, dialNodeParent = null, dialPoolStart = null, dialLabelSignature = null;
    const dialNodes = new Map(), dialLabels = new Map(), bubbles = new Map(), retiringBubbles = new Set();
    let keyboardModality = inputKind === "keyboard", selectedBubbleId = null, collapsedBubble = null;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const motions = new Map();
    let outgoing = null, exitTimer = null;
    const SAVE_ICON = 'M -12 -5 V 9 Q -12 11 -10 11 H 10 Q 12 11 12 9 V -4 Q 12 -6 10 -6 H 1 L -3 -9 H -10 Q -12 -9 -12 -7 Z M 2 -2 V 6 M -2 2 L 2 6 L 6 2';
    const DOWNLOAD_ICON = 'M 0 -9 V 3 M -4 -1 L 0 3 L 4 -1 M -8 5 V 9 H 8 V 5';
    const BACK_ICON = 'M 7 -7 H -2 Q -9 -7 -9 0 V 4 M -13 0 L -9 4 L -5 0';
    const icon = path => `<svg viewBox="-18 -18 36 36" aria-hidden="true"><path d="${path}"/></svg>`;
    const requestFrame = window.requestAnimationFrame?.bind(window) || (callback => setTimeout(() => callback(performance.now()), 16));
    const cancelFrame = window.cancelAnimationFrame?.bind(window) || (id => clearTimeout(id));
    const host = document.createElement("div"); host.id = "lakomics-arc-collector"; host.classList.toggle("editing", editing);
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style"); style.textContent = CSS; shadow.append(style);
    const backdrop = document.createElement("div"); backdrop.className = "backdrop";
    const panel = document.createElement("section"); panel.className = "panel";
    panel.setAttribute("role", editing ? "region" : "dialog"); if (!editing) panel.setAttribute("aria-modal", "true"); panel.setAttribute("aria-label", editing ? "반원 폴더 배치" : "분류 선택");
    panel.innerHTML = `<div class="path" aria-live="polite"></div><div class="arc"><div class="folders"><div class="sectors"></div><div class="dial-labels" aria-hidden="true"></div></div><div class="center"><button class="save-current">${editing ? "" : `<span class="center-face" aria-hidden="true"></span>`}<span class="action-icon">${icon(SAVE_ICON)}</span>${editing ? "" : `<span class="action-icon center-preview" aria-hidden="true">${icon(DOWNLOAD_ICON)}</span>`}<span class="destination" hidden></span></button>${editing ? `<button class="back"><span class="action-icon">${icon(DOWNLOAD_ICON)}</span></button>` : ""}</div></div><footer><button class="root-next" hidden></button><div class="notice" role="status" hidden></div></footer>`;
    const caption = document.createElement("div"); caption.className = "destination-caption"; caption.hidden = true; caption.setAttribute("aria-hidden", "true");
    panel.querySelector("footer").prepend(caption);
    if (!editing) {
      const arc = panel.querySelector(".arc"); arc.setAttribute("role", "group"); arc.setAttribute("aria-label", "폴더");
    }
    if (editing) {
      const controls = document.createElement("div"); controls.className = "edit-controls";
      controls.innerHTML = '<div class="edit-selection" aria-live="polite"></div><div class="edit-actions"><button class="move-before">이전 칸</button><button class="move-after">다음 칸</button><button class="hide-folder">숨기기</button></div>';
      panel.append(controls);
    }
    backdrop.append(panel); shadow.append(backdrop); (container || document.documentElement).append(host);
    const $ = selector => panel.querySelector(selector);
    const frame = () => history.at(-1);
    const available = () => !disposed && !busy && !locked && centerCommitTimer === null;
    const hasChildren = id => Boolean(layout[id]?.slots.some(Boolean));
    const destination = () => tree.byId.get(frame().selectedId);
    function notice(message) { $(".notice").textContent = message; $(".notice").hidden = !message; }
    function pageInfo() {
      const current = frame(), size = current.id === null ? ROOT_SLOTS : CHILD_SLOTS;
      const slots = layout[current.id ?? "__root__"]?.slots || [];
      return { slots, size, count: Math.max(1, Math.ceil(slots.length / size)) };
    }
    function dialInfo(current = frame()) {
      const slots = layout[current.id ?? "__root__"]?.slots || [];
      return { slots, max: Math.max(0, slots.length - DIAL_VISIBLE_SLOTS) };
    }
    function clampedDialPosition(current = frame()) {
      const { max } = dialInfo(current);
      return Math.max(0, Math.min(max, Number(current.dialPosition) || 0));
    }
    function setLocked(value) {
      locked = Boolean(value); host.classList.toggle("input-locked", locked);
      if (locked && pointer?.center) {
        releaseCenterPointer(); pointer = null; suppressClick = true; resetCenterPreview();
      }
      if (locked && centerCommitTimer !== null) { clearTimeout(centerCommitTimer); centerCommitTimer = null; resetCenterPreview(); }
      if (locked && centerWheel) { centerWheel.committed = true; resetCenterPreview(); }
    }
    function stopMotion(target) {
      const animation = motions.get(target);
      if (!animation) return;
      motions.delete(target); animation.onfinish = null; animation.cancel();
    }
    function motion(target, frames, duration, after, easing = "cubic-bezier(.2,0,0,1)") {
      stopMotion(target);
      if (reducedMotion?.matches || !target.animate) { after?.(); return; }
      const animation = target.animate(frames, { duration, easing });
      motions.set(target, animation);
      animation.onfinish = () => {
        if (motions.get(target) !== animation) return;
        motions.delete(target); after?.();
      };
    }
    function clearFolderMotion() {
      stopMotion($(".folders"));
      if (outgoing) { stopMotion(outgoing); outgoing.remove(); outgoing = null; }
    }
    function snapshotFolders() {
      if (reducedMotion?.matches || !$(".folders").animate) return null;
      const foreground = $(".folders");
      const useOutgoing = outgoing && Number(window.getComputedStyle(foreground).opacity) < .5;
      const source = useOutgoing ? outgoing.shadowRoot.querySelector(".folder-exit") : foreground;
      const opacity = parseFloat(window.getComputedStyle(useOutgoing ? outgoing : source).opacity);
      const layer = source.cloneNode(true);
      layer.className = "folders folder-exit"; layer.inert = true;
      layer.setAttribute("inert", ""); layer.setAttribute("aria-hidden", "true");
      // Freeze the old dial independently of the new folder's rotation variables.
      if (!useOutgoing) {
        layer.style.setProperty("--dial-angle", $(".arc").style.getPropertyValue("--dial-angle"));
        layer.style.setProperty("--dial-counter-angle", $(".arc").style.getPropertyValue("--dial-counter-angle"));
      }
      for (const button of layer.querySelectorAll("button")) { button.disabled = true; button.tabIndex = -1; }
      return { layer, opacity: Number.isFinite(opacity) ? opacity : 1 };
    }
    function changeFolder(change) {
      const snapshot = snapshotFolders();
      clearFolderMotion(); stopDialSpring(); clearTimeout(wheelTimer);
      wheelBurstUntil = 0; wheelBurstDirection = 0; wheelGesture = null;
      change(); render(); focusFirst();
      if (!snapshot) return;
      // A separate shadow tree keeps inert snapshots out of live button queries.
      const wrapper = document.createElement("div"); wrapper.className = "folder-exit-host";
      wrapper.inert = true; wrapper.setAttribute("aria-hidden", "true");
      wrapper.classList.toggle("editing", editing);
      const root = wrapper.attachShadow({ mode: "open" });
      const snapshotStyle = style.cloneNode(true);
      snapshotStyle.textContent += ':host{position:absolute;inset:0;z-index:2;pointer-events:none;width:100%;height:100%}';
      root.append(snapshotStyle, snapshot.layer);
      $(".arc").append(wrapper); outgoing = wrapper;
      motion(wrapper, [{ opacity: snapshot.opacity }, { opacity: 0 }], 140, () => { wrapper.remove(); if (outgoing === wrapper) outgoing = null; });
      motion($(".folders"), [{ opacity: 0 }, { opacity: 1 }], 180);
    }
    function cleanup() {
      disposed = true;
      clearTimeout(centerWheelTimer); clearTimeout(centerCommitTimer); clearTimeout(wheelTimer);
      releaseCenterPointer();
      stopDialSpring(); clearFolderMotion();
      for (const target of [...motions.keys()]) stopMotion(target);
      if (pointer) { try { $(".arc").releasePointerCapture?.(pointer.id); } catch {} pointer = null; }
      window.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
    }
    function dispose() {
      cleanup(); clearTimeout(exitTimer); host.remove();
      reducedMotion?.removeEventListener?.("change", onReducedMotion);
      window.removeEventListener("pagehide", dispose);
    }
    function onReducedMotion() {
      if (!reducedMotion.matches) return;
      if (disposed) { dispose(); return; }
      clearFolderMotion(); finishBubbleExits();
      for (const [target, animation] of [...motions]) { animation.onfinish?.(); stopMotion(target); animation.cancel(); }
      if (!editing) paintCenter(centerProgress, centerDirection);
      const target = dialTarget ?? Math.round(clampedDialPosition());
      stopDialSpring(); if (!editing) paintDial(target, false, true);
    }
    function close(result, action = ".save-current") {
      if (disposed) return;
      const success = result?.ok && !editing && !reducedMotion?.matches && Boolean(panel.animate);
      cleanup();
      if (success) {
        host.inert = true; host.removeAttribute("id"); host.setAttribute("aria-hidden", "true"); host.classList.add("exiting");
        motion($(`${action} ${centerProgress ? ".center-preview" : ".action-icon"}`), [{ transform: "scale(1)" }, { transform: "scale(1.12)", offset: .45 }, { transform: "scale(1)" }], 100);
        motion(panel, [{ opacity: 1 }, { opacity: 0 }], 100, dispose);
        exitTimer = setTimeout(dispose, 160);
      } else dispose();
      !editing && previousFocus?.isConnected && previousFocus.focus?.({ preventScroll: true });
      onClose?.(result);
    }
    function cancel() { if (editing || available()) close(); }
    function focusFirst() { $(".sector:not(:disabled):not([aria-hidden=true])")?.focus({ preventScroll: true }); }
    function back() {
      if (!available() || history.length < 2) return;
      lastTap = null; finishBubbleExits();
      changeFolder(() => history.pop());
      notice(""); render();
    }
    function nextPage() {
      if (!available() || pageInfo().count < 2) return;
      lastTap = null;
      frame().page = (frame().page + 1) % pageInfo().count;
      notice(""); render();
      (frame().id === null ? $(".root-next") : $(".next"))?.focus({ preventScroll: true });
    }
    function choose(id, event) {
      if (!available() || !tree.byId.has(id)) return;
      const now = performance.now();
      const doubleTap = event.detail > 0 && lastTap?.id === id && now - lastTap.at <= 350;
      lastTap = event.detail > 0 ? { id, at: now } : null;
      frame().selectedId = id;
      notice("");
      if (doubleTap) {
        lastTap = null;
        if (hasChildren(id)) { openSelected(); return; }
        if (!editing) { void save(); return; }
      }
      render();
      if (editing || hasChildren(id)) [...panel.querySelectorAll(".sector")].find(button => button.dataset.classificationId === id)?.focus({ preventScroll: true });
      else $(".save-current").focus({ preventScroll: true });
    }
    function openSelected() {
      const id = destination()?.id;
      if (!available() || !hasChildren(id) || history.some(item => item.id === id)) return;
      lastTap = null;
      notice("");
      changeFolder(() => history.push({ id, page: 0, selectedId: editing ? null : id, dialPosition: 0 }));
    }
    function update(next) {
      entries = next.classifications?.entries ?? entries; profile = next.profile ?? profile;
      arcLayout = next.arcLayout ?? arcLayout; hiddenClassificationIds = next.hiddenClassificationIds ?? hiddenClassificationIds;
      readModel();
      const invalid = history.findIndex(item => item.id !== null && !tree.byId.has(item.id));
      if (invalid >= 0) history.splice(invalid);
      for (const item of history) {
        if (!tree.byId.has(item.selectedId)) item.selectedId = null;
        const slots = layout[item.id ?? "__root__"]?.slots || [];
        const max = Math.max(0, slots.length - DIAL_VISIBLE_SLOTS);
        item.dialPosition = Math.max(0, Math.min(max, Number(item.dialPosition) || 0));
      }
      dialPoolStart = null; dialLabelSignature = null; render();
    }
    async function edit(action, focusSelector) {
      if (!available() || !destination()) return;
      busy = true; notice(""); render();
      try {
        const result = await action();
        if (disposed) return;
        if (!result?.ok) notice("변경하지 못했습니다. 다시 시도해 주세요.");
        else {
          if (result.state) update(result.state);
          const info = pageInfo(), index = info.slots.indexOf(frame().selectedId);
          if (index >= 0) frame().page = Math.floor(index / info.size);
          notice(result.pending ? "오프라인 · 연결되면 순서를 동기화합니다." : "");
        }
      } catch { if (!disposed) notice("변경하지 못했습니다. 다시 시도해 주세요."); }
      finally { busy = false; if (!disposed) { render(); $(focusSelector)?.focus({ preventScroll: true }); } }
    }
    function moveSelected(delta) {
      const current = frame(), id = current.selectedId, key = current.id ?? "__root__";
      const visible = pageInfo().slots.filter(Boolean), index = visible.indexOf(id), neighbor = visible[index + delta];
      if (!neighbor) return;
      const ids = fullLayout[key].slots.filter(Boolean), from = ids.indexOf(id), to = ids.indexOf(neighbor);
      [ids[from], ids[to]] = [ids[to], ids[from]];
      void edit(() => onReorder?.(current.id, ids), delta < 0 ? ".move-before" : ".move-after");
    }
    async function save() {
      if (!available() || !destination()) return;
      const id = destination().id;
      busy = true; notice(""); render();
      try {
        const result = await onSave(id);
        if (disposed) return;
        if (result?.ok) { close(result); return; }
        notice(result?.message || "저장 실패 · 다시 시도해 주세요.");
      } catch { if (!disposed) notice("연결 실패 · 다시 시도해 주세요."); }
      finally {
        busy = false;
        if (!disposed) { render(); $(".save-current").focus({ preventScroll: true }); }
      }
    }
    function point(r, degrees, sector = false) {
      const angle = degrees * Math.PI / 180;
      return [side === "left" ? (sector ? radius : 0) + r * Math.cos(angle) : radius - r * Math.cos(angle), radius + r * Math.sin(angle)];
    }
    function snapDevicePixel(value) {
      const dpr = Math.max(1, Number(window.devicePixelRatio) || 1);
      return Math.round(value * dpr) / dpr;
    }
    function runtimeDialOrigin() {
      if (editing) return -75;
      const count = dialInfo().slots.length;
      if (count > 0 && count <= DIAL_VISIBLE_SLOTS) return -((count - 1) * DIAL_VISUAL_STEP_DEGREES) / 2;
      return -DIAL_CENTER_SLOT * DIAL_VISUAL_STEP_DEGREES;
    }
    function shape(button, index) {
      const step = editing ? 30 : DIAL_VISUAL_STEP_DEGREES;
      const centerAngle = (editing ? -75 : runtimeDialOrigin()) + index * step;
      const from = centerAngle - step / 2 + 1.5, to = centerAngle + step / 2 - 1.5;
      function roundedWedge(outer, inner) {
        const corner = 7, od = corner / outer * 180 / Math.PI, id = corner / inner * 180 / Math.PI;
        const p = (r, a) => point(r, a, true).map(n => n.toFixed(2)).join(" ");
        const sweep = side === "left" ? 1 : 0;
        return `path("M ${p(outer, from + od)} A ${outer} ${outer} 0 0 ${sweep} ${p(outer, to - od)} Q ${p(outer, to)} ${p(outer - corner, to)} L ${p(inner + corner, to)} Q ${p(inner, to)} ${p(inner, to - id)} A ${inner} ${inner} 0 0 ${1 - sweep} ${p(inner, from + id)} Q ${p(inner, from)} ${p(inner + corner, from)} L ${p(outer - corner, from)} Q ${p(outer, from)} ${p(outer, from + od)} Z")`;
      }
      button.style.clipPath = roundedWedge(radius, radius * .50);
      button.style.setProperty("--sector-face", roundedWedge(button.classList.contains("branch") ? radius - 5 : radius, radius * .50));
      const label = button.querySelector(".sector-label"), center = point(radius * .75, centerAngle, true);
      label.style.left = `${center[0]}px`; label.style.top = `${center[1]}px`;
    }
    function makeDialSector() {
      const button = document.createElement("button"); button.className = "sector";
      const label = document.createElement("span"); label.className = "sector-label";
      const name = document.createElement("span"); name.className = "name";
      label.append(name); button.append(label); return button;
    }
    function makeDialLabel(itemIndex, entry, current) {
      const label = document.createElement("span"); label.className = "dial-label";
      label.dataset.dialIndex = String(itemIndex); label.dataset.classificationId = entry.id;
      const name = document.createElement("span"); name.className = "name"; name.textContent = entry.name;
      label.append(name); label.classList.toggle("selected", current.selectedId === entry.id); return label;
    }
    function renderDialLabels(slots, current) {
      const signature = slots.join("\u0000"), labels = $(".dial-labels");
      if (dialLabelSignature === signature && dialLabels.size === slots.length) return;
      dialLabelSignature = signature; dialLabels.clear(); labels.replaceChildren();
      for (let itemIndex = 0; itemIndex < slots.length; itemIndex += 1) {
        const entry = tree.byId.get(slots[itemIndex]); if (!entry) continue;
        const label = makeDialLabel(itemIndex, entry, current); dialLabels.set(itemIndex, label); labels.append(label);
      }
    }
    function paintDialLabels(position, crisp = false) {
      const origin = runtimeDialOrigin(), fadeStart = 68, fadeEnd = 102;
      for (const [itemIndex, label] of dialLabels) {
        const angle = origin + (itemIndex - position) * DIAL_VISUAL_STEP_DEGREES, distance = Math.abs(angle);
        const opacity = distance <= fadeStart ? 1 : distance >= fadeEnd ? 0 : (fadeEnd - distance) / (fadeEnd - fadeStart);
        label.style.opacity = opacity.toFixed(3);
        if (opacity <= 0) continue;
        let [left, top] = point(radius * .75, angle);
        if (crisp) { left = snapDevicePixel(left); top = snapDevicePixel(top); }
        label.style.left = `${left}px`; label.style.top = `${top}px`;
      }
    }
    function physicalSlot(itemIndex) {
      return ((itemIndex % DIAL_POOL_SLOTS) + DIAL_POOL_SLOTS) % DIAL_POOL_SLOTS;
    }
    function updateDialSector(button, itemIndex, slotIndex, entry, current) {
      button.className = "sector";
      button.dataset.slot = String(slotIndex); button.dataset.dialIndex = String(itemIndex);
      const name = button.querySelector(".name");
      delete button.dataset.classificationId; button.removeAttribute("aria-description"); button.removeAttribute("aria-pressed");
      if (entry) {
        name.textContent = entry.name;
        button.classList.toggle("branch", hasChildren(entry.id));
        button.dataset.classificationId = entry.id;
        button.setAttribute("aria-label", tree.path(entry.id).map(item => item.name).join(" / "));
        button.setAttribute("aria-description", hasChildren(entry.id) ? "한 번 누르면 선택, 더블탭 또는 오른쪽 방향키로 하위 폴더 열기" : "저장 위치 선택");
        button.setAttribute("aria-pressed", String(current.selectedId === entry.id));
        button.onclick = event => {
          if (button.dataset.peek) {
            if (!available()) return;
            lastTap = null; clearTimeout(wheelTimer);
            kickDial(button.dataset.peek === "before" ? -1 : 1);
          } else if (!button.hasAttribute("aria-hidden")) choose(entry.id, event);
        };
      } else {
        name.textContent = ""; button.onclick = null; button.classList.add("empty"); button.setAttribute("aria-label", "빈 칸");
      }
      shape(button, slotIndex);
    }
    function syncDialSectorState(position) {
      const current = frame(), { slots, max } = dialInfo(current);
      const clamped = Math.max(0, Math.min(max, Number(position) || 0));
      const base = Math.max(0, Math.min(max, Math.round(clamped)));
      for (const button of dialNodes.values()) {
        const itemIndex = Number(button.dataset.dialIndex);
        const entry = tree.byId.get(slots[itemIndex]);
        const visible = Boolean(entry) && itemIndex >= base && itemIndex < base + DIAL_VISIBLE_SLOTS;
        const peek = Boolean(entry) && max > 0 && (itemIndex === base - 1 || itemIndex === base + DIAL_VISIBLE_SLOTS);
        button.classList.toggle("dial-buffer", !visible);
        if (peek) button.dataset.peek = itemIndex < base ? "before" : "after"; else delete button.dataset.peek;
        if (visible) button.removeAttribute("aria-hidden"); else button.setAttribute("aria-hidden", "true");
        button.tabIndex = visible ? 0 : -1;
        if (!visible && shadow.activeElement === button) button.blur();
        button.disabled = busy || !entry || (!visible && !peek);
        // Paint by continuous angle, independent of the rounded interaction window.
        // The same pooled wedge brightens as it enters, with no half-slot switch.
        const distance = Math.abs(runtimeDialOrigin() + (itemIndex - position) * DIAL_VISUAL_STEP_DEGREES);
        const exposure = Math.max(0, Math.min(1, (90 - distance) / DIAL_VISUAL_STEP_DEGREES));
        button.style.opacity = (.45 + .55 * exposure).toFixed(3);
        if (entry) button.setAttribute("aria-pressed", String(current.selectedId === entry.id));
      }
      for (const label of dialLabels.values()) label.classList.toggle("selected", current.selectedId === label.dataset.classificationId);
      panel.dataset.dialIndex = String(base);
      const arc = $(".arc"), description = max > 0 ? `폴더 ${slots.length}개 · 휠이나 드래그로 더 보기` : null;
      if (arc.getAttribute("aria-description") !== description) {
        if (description) arc.setAttribute("aria-description", description); else arc.removeAttribute("aria-description");
      }
    }
    function renderDialSectors(position = clampedDialPosition()) {
      const current = frame(), { slots } = dialInfo(current), parentKey = current.id ?? "__root__";
      const clamped = Math.max(0, Number(position) || 0), start = Math.floor(clamped) - DIAL_POOL_LEAD;
      const sectors = $(".sectors"), labels = $(".dial-labels");
      if (dialNodeParent !== parentKey) {
        dialNodeParent = parentKey; dialPoolStart = null; dialLabelSignature = null; dialNodes.clear(); dialLabels.clear(); sectors.replaceChildren(); labels.replaceChildren();
      }
      renderDialLabels(slots, current);
      if (dialPoolStart !== start || dialNodes.size !== DIAL_POOL_SLOTS) {
        const forceRefresh = dialPoolStart === null;
        for (let itemIndex = start; itemIndex < start + DIAL_POOL_SLOTS; itemIndex += 1) {
          const slotIndex = physicalSlot(itemIndex), entry = tree.byId.get(slots[itemIndex]);
          let button = dialNodes.get(slotIndex);
          if (!button) { button = makeDialSector(); dialNodes.set(slotIndex, button); }
          if (forceRefresh || Number(button.dataset.dialIndex) !== itemIndex) updateDialSector(button, itemIndex, slotIndex, entry, current);
        }
        dialPoolStart = start;
        sectors.append(...[...dialNodes.entries()].sort((a, b) => a[0] - b[0]).map(([, button]) => button));
      }
      syncDialSectorState(position);
    }
    function paintDial(value, rubber = false, crisp = false) {
      const current = frame(), { max } = dialInfo(current);
      let next = Number.isFinite(value) ? value : 0;
      if (rubber) {
        if (next < 0) next = -rubberDistance(-next);
        else if (next > max) next = max + rubberDistance(next - max);
      }
      current.dialPosition = next;
      renderDialSectors(next); paintDialLabels(next, crisp);
      const angle = next * DIAL_VISUAL_STEP_DEGREES * (side === "left" ? -1 : 1);
      const arc = $(".arc"), detent = 1 - Math.min(1, Math.abs(next - Math.round(next)) * 2);
      arc.style.setProperty("--dial-angle", `${angle.toFixed(3)}deg`);
      arc.style.setProperty("--dial-counter-angle", `${(-angle).toFixed(3)}deg`);
      arc.style.setProperty("--dial-brightness", (0.985 + detent * 0.015).toFixed(3));
      panel.dataset.dialPosition = next.toFixed(3);
    }
    function rubberDistance(x) { return (1 - 1 / (x * .55 / DIAL_RUBBER_SPAN + 1)) * DIAL_RUBBER_SPAN; }
    function rawDialPosition() {
      const value = Number(frame().dialPosition) || 0, { max } = dialInfo();
      const outside = value < 0 ? -value : value > max ? value - max : 0;
      const raw = outside / (.55 * (1 - Math.min(.999, outside / DIAL_RUBBER_SPAN)));
      return value < 0 ? -raw : value > max ? max + raw : value;
    }
    function sample(gesture, position, now) {
      if (position !== gesture.samples.at(-1)?.position) gesture.changedAt = now;
      gesture.samples.push({ position, at: now });
      gesture.samples = gesture.samples.filter(item => now - item.at <= DIAL_SAMPLE_MS);
    }
    function releaseVelocity(gesture, now) {
      const samples = gesture.samples.filter(item => now - item.at <= DIAL_SAMPLE_MS);
      if (now - gesture.changedAt > DIAL_HOLD_MS || samples.length < 2) return 0;
      const first = samples[0], last = samples.at(-1);
      return (last.position - first.position) / Math.max(1, last.at - first.at);
    }
    function stopDialSpring() {
      if (dialFrame !== null) cancelFrame(dialFrame);
      dialFrame = null; dialVelocity = 0; dialTarget = null;
      $(".arc")?.classList.remove("dial-moving");
    }
    function startDialMotion(velocity = 0, target = null, duration = null) {
      const start = Number(frame().dialPosition) || 0, { max } = dialInfo();
      const outside = start < 0 || start > max;
      target = Math.max(0, Math.min(max, target ?? Math.round(outside ? start : start + velocity * DIAL_DECELERATION / (1 - DIAL_DECELERATION))));
      duration ??= outside ? 350 : Math.abs(velocity) < .001 ? 250 : Math.min(700, 300 + Math.abs(velocity) * 60000);
      stopDialSpring();
      const distance = target - start;
      if (reducedMotion?.matches || Math.abs(distance) < .00001) { paintDial(target, false, true); return; }
      // Critically damped displacement, with a smooth time warp to reach the
      // exact endpoint at duration. Its initial derivative remains velocity;
      // choosing omega from the stopping distance prevents target overshoot.
      if (outside && velocity * distance < 0) velocity = 0;
      const omega = Math.max(3 / duration, velocity * distance > 0 ? velocity / distance : 0);
      const started = performance.now(), offset = -distance, coefficient = velocity + omega * offset;
      dialTarget = target; dialVelocity = velocity; $(".arc").classList.add("dial-moving");
      const step = now => {
        dialFrame = null;
        if (disposed || editing) { stopDialSpring(); return; }
        const t = Math.min(1, Math.max(0, (now - started) / duration));
        const remaining = 1 - t, elapsed = t === 1 ? 0 : duration * t / remaining;
        const decay = t === 1 ? 0 : Math.exp(-omega * elapsed);
        const value = target + (offset + coefficient * elapsed) * decay;
        dialVelocity = t === 1 ? 0 : (velocity - omega * coefficient * elapsed) * decay / (remaining * remaining);
        paintDial(t === 1 ? target : value, false, t === 1);
        if (t === 1) { stopDialSpring(); return; }
        dialFrame = requestFrame(step);
      };
      dialFrame = requestFrame(step);
    }
    function kickDial(direction) {
      const position = clampedDialPosition(), { max } = dialInfo();
      const requested = (dialTarget ?? Math.round(position)) + direction;
      const ahead = direction > 0 ? Math.floor(position + 3) : Math.ceil(position - 3);
      const target = Math.max(0, Math.min(max, direction > 0 ? Math.min(requested, ahead) : Math.max(requested, ahead)));
      wheelGesture = null; startDialMotion(dialTarget === null ? (target - position) * 3 / DIAL_NOTCH_MS : dialVelocity, target, DIAL_NOTCH_MS);
    }
    function dialAngle(event) {
      const bounds = $(".arc").getBoundingClientRect();
      const centerX = side === "right" ? bounds.right : bounds.left, centerY = bounds.top + bounds.height / 2;
      const radialX = side === "right" ? centerX - event.clientX : event.clientX - centerX;
      return Math.atan2(event.clientY - centerY, radialX) * 180 / Math.PI;
    }
    function angleDelta(value, origin) {
      let delta = value - origin;
      while (delta > 180) delta -= 360;
      while (delta < -180) delta += 360;
      return delta;
    }
    function render() {
      const current = frame(), { slots, size, count } = pageInfo();
      if (editing) current.page = Math.min(current.page, count - 1);
      panel.dataset.depth = String(history.length - 1);
      panel.setAttribute("aria-busy", String(busy));
      const path = current.selectedId ? tree.path(current.selectedId).map(entry => entry.name).join(" / ") : "분류 선택";
      $(".path").textContent = path;
      renderBreadcrumbs();
      positionCaption();
      const root = current.id === null;
      if (editing) {
        $(".back").classList.toggle("temporary", root);
        $(".back path").setAttribute("d", root ? DOWNLOAD_ICON : BACK_ICON);
        $(".back").setAttribute("aria-label", root ? "임시 저장" : "뒤로");
        $(".back").disabled = busy || root;
      }
      // A missing destination disables Save semantically, but must still allow
      // pointer gestures on the live center for Back and Temporary.
      $(".save-current").disabled = busy || (editing && (!destination() || !hasChildren(destination()?.id) || destination()?.id === current.id));
      $(".save-current").setAttribute("aria-disabled", String($(".save-current").disabled || !destination()));
      $(".save-current").setAttribute("aria-label", editing ? "선택한 폴더의 하위 폴더 열기" : destination() ? `${path}에 저장` : "저장");
      if (!editing) $(".save-current").setAttribute("aria-description", "위로 끌어 뒤로, 아래로 끌어 임시저장");
      $(".destination").textContent = destination()?.name || "폴더 선택";
      $(".save-current").setAttribute("aria-busy", String(busy));
      $(".root-next").hidden = !editing || current.id !== null || count < 2;
      $(".root-next").disabled = busy;
      const pageLabel = `${current.page === count - 1 ? "처음으로" : "다음"} · ${current.page + 1}/${count}`;
      $(".root-next").textContent = pageLabel;
      if (editing) {
        panel.dataset.page = String(current.page + 1);
        const ids = slots.filter(Boolean), index = ids.indexOf(current.selectedId);
        $(".edit-selection").textContent = destination() ? path : "폴더를 눌러 배치를 수정하세요";
        $(".move-before").disabled = busy || index <= 0;
        $(".move-after").disabled = busy || index < 0 || index >= ids.length - 1;
        $(".hide-folder").disabled = busy || index < 0;
        const sectors = $(".sectors"); sectors.replaceChildren();
        for (let index = 0; index < ROOT_SLOTS; index += 1) {
          const paging = current.id !== null && index === CHILD_SLOTS;
          const entry = paging ? null : tree.byId.get(slots[current.page * size + index]);
          const button = document.createElement("button"); button.className = `sector${paging ? " next" : ""}`;
          button.dataset.slot = String(index);
          const label = document.createElement("span"); label.className = "sector-label";
          const name = document.createElement("span"); name.className = "name";
          const detail = document.createElement("small");
          if (paging) {
            name.textContent = count === 1 ? "다음" : current.page === count - 1 ? "처음으로" : "다음";
            detail.textContent = `${current.page + 1}/${count}`;
            button.setAttribute("aria-label", pageLabel); button.onclick = nextPage;
            button.disabled = busy || count < 2;
          } else if (entry) {
            name.textContent = entry.name;
            button.classList.toggle("branch", hasChildren(entry.id));
            button.dataset.classificationId = entry.id;
            button.setAttribute("aria-label", tree.path(entry.id).map(item => item.name).join(" / "));
            button.setAttribute("aria-description", hasChildren(entry.id) ? "한 번 누르면 선택, 더블탭 또는 오른쪽 방향키로 하위 폴더 열기" : "배치할 폴더 선택");
            button.setAttribute("aria-pressed", String(current.selectedId === entry.id));
            button.onclick = event => choose(entry.id, event); button.disabled = busy;
          } else {
            name.textContent = ""; button.disabled = true; button.classList.add("empty"); button.setAttribute("aria-label", "빈 칸");
          }
          label.append(name); if (paging) label.append(detail);
          button.append(label); shape(button, index); sectors.append(button);
        }
      } else {
        delete panel.dataset.page;
        if (dialFrame === null && !pointer?.dial?.dragging && !wheelGesture) current.dialPosition = clampedDialPosition(current);
        renderDialSectors(current.dialPosition); paintDial(current.dialPosition, false, dialFrame === null && !pointer?.dial?.dragging && !wheelGesture);
      }
    }
    function removeBubble(node) {
      stopMotion(node); for (const child of node.querySelectorAll("*")) stopMotion(child);
      retiringBubbles.delete(node); node.remove(); caption.hidden = !caption.children.length;
    }
    function finishBubbleExits() { for (const node of [...retiringBubbles]) removeBubble(node); }
    function renderBreadcrumbs() {
      if (editing) return;
      const path = history.slice(1).map(item => tree.byId.get(item.id)).filter(Boolean), selected = destination();
      if (selected && path.at(-1)?.id !== selected.id) path.push(selected);
      const ids = new Set(path.map(item => item.id)), previousSelected = bubbles.get(selectedBubbleId);
      // Reuse the selected position for a sibling change, but never an ancestor
      // becoming selected on Back or a selected folder becoming an ancestor.
      const sibling = selected && previousSelected && !ids.has(selectedBubbleId)
        && !bubbles.has(selected.id) && previousSelected.dataset.depth === String(history.length);
      if (sibling) {
        bubbles.delete(selectedBubbleId); bubbles.set(selected.id, previousSelected);
        const pill = previousSelected.querySelector(".bubble-pill"), oldText = previousSelected.dataset.name;
        for (const child of pill.querySelectorAll("*")) stopMotion(child);
        const oldWidth = pill.getBoundingClientRect().width; stopMotion(pill);
        pill.textContent = selected.name;
        const newWidth = pill.getBoundingClientRect().width;
        if (oldText !== selected.name) {
          // Keep the old text in the same pill while the new text crossfades.
          const old = document.createElement("span"); old.className = "bubble-old"; old.textContent = oldText;
          const fresh = document.createElement("span"); fresh.textContent = selected.name;
          pill.replaceChildren(old, fresh);
          motion(old, [{ opacity: 1 }, { opacity: 0 }], 140, () => old.remove());
          motion(fresh, [{ opacity: 0 }, { opacity: 1 }], 140);
          motion(pill, [{ width: `${oldWidth}px` }, { width: `${newWidth}px` }], 140);
        }
      }
      for (const [id, node] of bubbles) {
        if (ids.has(id)) continue;
        bubbles.delete(id); retiringBubbles.add(node);
        node.style.left = `${node.offsetLeft}px`; node.style.top = `${node.offsetTop}px`; node.classList.add("leaving");
        motion(node, [{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(.96)" }], 120, () => removeBubble(node));
      }
      for (const entry of path) {
        let node = bubbles.get(entry.id);
        const appended = !node;
        if (!node) {
          node = document.createElement("span"); node.className = "breadcrumb";
          const separator = document.createElement("span"); separator.className = "bubble-separator"; separator.textContent = " › ";
          const pill = document.createElement("span"); pill.className = "bubble-pill"; pill.textContent = entry.name;
          node.append(separator, pill); bubbles.set(entry.id, node);
        }
        node.dataset.classificationId = entry.id; node.dataset.depth = String(history.length);
        node.classList.toggle("selected", entry.id === selected?.id);
        const pill = node.querySelector(".bubble-pill");
        if (node.dataset.name !== entry.name && !(sibling && node === previousSelected)) {
          for (const child of pill.querySelectorAll("*")) stopMotion(child);
          stopMotion(pill); pill.textContent = entry.name;
        }
        node.dataset.name = entry.name;
        // Insert only when order actually changed; unchanged bubbles stay mounted.
        const previous = path[path.indexOf(entry) - 1], anchor = previous ? bubbles.get(previous.id).nextSibling : caption.firstChild;
        if (anchor !== node) caption.insertBefore(node, anchor);
        if (appended) motion(node, [{ opacity: 0, transform: "translateY(4px) scale(.92)" }, { opacity: 1, transform: "translateY(0) scale(1)" }], 180, null, "cubic-bezier(.2,.8,.2,1)");
      }
      selectedBubbleId = selected?.id ?? null;
      if (!bubbles.size) collapsedBubble?.remove();
      caption.hidden = !caption.children.length; layoutBreadcrumbs();
    }
    function layoutBreadcrumbs() {
      if (editing || !bubbles.size) return;
      const nodes = [...bubbles.values()];
      collapsedBubble?.remove();
      for (const [index, node] of nodes.entries()) {
        node.hidden = false; node.classList.toggle("first", index === 0);
        node.querySelector(".bubble-separator").textContent = index === 0 ? "" : " › ";
        node.style.maxWidth = `${node.classList.contains("selected") ? radius : radius * .6}px`;
      }
      // This is a render/resize-only measurement, never part of dial paint.
      // Budget two rows, then retain the last two ancestors and destination.
      let lines = 1, used = 0;
      for (const node of nodes) {
        const width = node.offsetWidth;
        if (used && used + 4 + width > radius) { lines++; used = 0; }
        used += (used ? 4 : 0) + width;
      }
      if (lines <= 2) return;
      const keep = nodes.at(-1).classList.contains("selected") ? 3 : 2;
      const collapse = nodes.length > keep;
      if (collapse) {
        if (!collapsedBubble) {
          collapsedBubble = document.createElement("span"); collapsedBubble.className = "breadcrumb bubble-collapse first";
          const pill = document.createElement("span"); pill.className = "bubble-pill"; pill.textContent = "…"; collapsedBubble.append(pill);
        }
        caption.prepend(collapsedBubble);
      }
      nodes.slice(0, -keep).forEach(node => { node.hidden = true; });
      for (const node of nodes.slice(-keep)) {
        node.classList.toggle("first", !collapse && node === nodes[0]);
        node.querySelector(".bubble-separator").textContent = !collapse && node === nodes[0] ? "" : " › ";
        // Two compact ancestors share the first row with the ellipsis. The
        // selected pill may take the entire second row, including its chevron.
        node.style.maxWidth = `${node.classList.contains("selected") ? radius : Math.min(radius * .6, (radius - (collapse ? 44 : 4)) / 2)}px`;
      }
    }
    function positionCaption() {
      if (caption.hidden) return;
      const bounds = $(".arc").getBoundingClientRect(), top = window.visualViewport?.offsetTop || 0;
      // Reserve two lines above the arc. In short windows the footer scrolls
      // with the arc, keeping the below-arc fallback reachable.
      const above = bounds.top - top >= 62;
      caption.dataset.placement = above ? "above" : "below";
      caption.style.width = `${radius}px`;
      caption.dataset.side = side;
      caption.style.left = above && side === "left" ? panel.style.left : "auto";
      caption.style.right = above && side === "right" ? panel.style.right : "auto";
      caption.style.bottom = above ? `${window.innerHeight - bounds.top + 6}px` : "auto";
      if (above) backdrop.append(caption); else $("footer").prepend(caption);
    }
    function position() {
      const viewport = window.visualViewport;
      const width = viewport?.width || window.innerWidth, height = viewport?.height || window.innerHeight;
      // Keep targets usable on small windows; the bounded panel can scroll in a
      // short landscape viewport instead of shrinking the controls indefinitely.
      const coarsePointer = Boolean(window.matchMedia?.("(pointer: coarse)")?.matches) || Number(window.navigator?.maxTouchPoints || 0) > 0;
      const runtimeRadiusCap = coarsePointer && height >= width ? 208 : 200;
      radius = editing ? Math.max(140, Math.min(224, container.clientWidth || 224)) : Math.max(176, Math.min(runtimeRadiusCap, width - 16, (height - 200) / 2));
      panel.style.setProperty("--radius", `${radius}px`);
      panel.style.setProperty("--dial-left", side === "left" ? `${-radius}px` : "0px");
      if (editing) {
        panel.dataset.side = "right";
        panel.querySelectorAll(".sector").forEach((button, index) => shape(button, index));
        return;
      }
      panel.style.maxHeight = `${Math.max(80, height - 16)}px`;
      panel.style.left = side === "left" ? `${viewport?.offsetLeft || 0}px` : "auto";
      panel.style.right = side === "right" ? `${Math.max(0, window.innerWidth - width - (viewport?.offsetLeft || 0))}px` : "auto";
      panel.style.top = `${(viewport?.offsetTop || 0) + Math.max(8, (height - (radius * 2 + 104)) / 2)}px`;
      panel.dataset.side = side;
      panel.querySelectorAll(".sector").forEach(button => shape(button, Number(button.dataset.slot)));
      paintDialLabels(Number(frame().dialPosition) || 0, true);
      layoutBreadcrumbs(); positionCaption();
    }
    async function temporary() {
      if (!available() || editing || !onTemporary) return;
      lastTap = null; previewCenter(CENTER_COMMIT); busy = true; render();
      try {
        const result = await onTemporary();
        if (disposed) return;
        if (result !== false && result?.ok !== false) close(result?.ok ? result : undefined);
        else if (result?.message) notice(result.message);
      }
      catch { if (!disposed) notice("임시 저장을 열지 못했습니다."); }
      finally { busy = false; if (!disposed) { resetCenterPreview(); render(); } }
    }
    function centerAction(distance) {
      if (editing || !available() || Math.abs(distance) < CENTER_COMMIT) return null;
      return distance < 0 ? (history.length > 1 ? "back" : null) : (onTemporary ? "temporary" : null);
    }
    function paintCenter(progress, direction, duration = 0) {
      const button = $(".save-current"), face = button.querySelector(".center-face");
      const save = button.querySelector(".action-icon"), preview = button.querySelector(".center-preview");
      centerProgress = progress; centerDirection = direction;
      face.style.background = direction > 0 ? "#2f7d5b" : "#39495f";
      preview.querySelector("path").setAttribute("d", direction > 0 ? DOWNLOAD_ICON : BACK_ICON);
      const hidden = (1 - progress) * 100, slide = reducedMotion?.matches ? 0 : 24;
      const styles = [
        [face, { clipPath: direction > 0 ? `inset(${hidden}% 0 0 0)` : `inset(0 0 ${hidden}% 0)` }],
        [save, { transform: `translateY(${-direction * slide * progress}px)`, opacity: String(1 - progress) }],
        [preview, { transform: `translateY(${direction * slide * (1 - progress)}px)`, opacity: String(progress) }],
      ];
      for (const [target, next] of styles) {
        const from = Object.fromEntries(Object.keys(next).map(key => [key, target.style[key] || next[key]]));
        stopMotion(target); Object.assign(target.style, next);
        if (duration) motion(target, [from, next], duration, null, "ease-out");
      }
      button.classList.toggle("commit-back", progress === 1 && direction < 0);
      button.classList.toggle("commit-temporary", progress === 1 && direction > 0);
    }
    function previewCenter(distance, threshold = CENTER_COMMIT, duration = 0) {
      const direction = distance < 0 ? -1 : 1;
      const supported = direction < 0 ? history.length > 1 : Boolean(onTemporary);
      const progress = supported ? Math.min(1, Math.abs(distance) / threshold) : 0;
      paintCenter(progress, direction, duration);
      return progress === 1 ? centerAction(direction * CENTER_COMMIT) : null;
    }
    function resetCenterPreview() {
      if (!editing) paintCenter(0, centerDirection, CENTER_RETURN_MS);
    }
    function commitCenter(action, step = 0) {
      if (!action || !available()) return;
      // Reserve the action throughout the reveal and full-face hold.
      centerCommitTimer = setTimeout(() => {
        centerCommitTimer = null;
        if (!available()) { resetCenterPreview(); return; }
        if (action === "back") { back(); resetCenterPreview(); }
        else void temporary();
      }, CENTER_HOLD_MS + (reducedMotion?.matches ? 0 : step));
    }
    function releaseCenterPointer() {
      if (!pointer?.center) return;
      try { $(".save-current").releasePointerCapture?.(pointer.id); } catch {}
    }
    function moveCenterPointer(event) {
      const dx = event.clientX - pointer.x, dy = event.clientY - pointer.y;
      if (!pointer.axis && Math.hypot(dx, dy) >= CENTER_SLOP) {
        pointer.axis = Math.abs(dy) > Math.abs(dx) ? "vertical" : "cancelled";
        suppressClick = true; lastTap = null;
      }
      if (pointer.axis === "vertical") previewCenter(dy);
      return dy;
    }
    function wheelCenter(event) {
      if (!event.deltaY || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      event.preventDefault(); event.stopPropagation();
      // Keep extending an existing gesture during an async save, so late OS
      // inertia cannot retry a failed Temporary action.
      if (!centerWheel && (!available() || pointer)) return;
      const now = performance.now(), direction = Math.sign(event.deltaY);
      centerWheel ??= { distance: 0, committed: false, temporary: false, burstDirection: 0, burstUntil: 0 };
      const gesture = centerWheel;
      clearTimeout(centerWheelTimer);
      if (available() && !pointer && !gesture.committed) {
        lastTap = null;
        const notch = event.deltaMode || Math.abs(event.deltaY) >= 40;
        let action = null;
        if (notch) {
          if (direction !== gesture.burstDirection || now >= gesture.burstUntil) {
            gesture.burstDirection = direction; gesture.burstUntil = now + DIAL_WHEEL_BURST_MS;
            if (direction < 0) {
              const cancelProgress = gesture.distance > 0;
              gesture.distance = 0; resetCenterPreview();
              if (!cancelProgress) back();
            } else {
              gesture.distance = onTemporary ? Math.max(0, gesture.distance) + CENTER_TEMPORARY_WHEEL_PX / CENTER_WHEEL_NOTCHES : 0;
              action = previewCenter(gesture.distance, CENTER_TEMPORARY_WHEEL_PX, CENTER_STEP_MS);
            }
          }
        } else {
          gesture.distance += event.deltaY;
          if (!onTemporary) gesture.distance = Math.min(0, gesture.distance);
          action = previewCenter(gesture.distance, gesture.distance > 0 ? CENTER_TEMPORARY_WHEEL_PX : CENTER_COMMIT);
        }
        if (action) {
          gesture.committed = true; gesture.temporary = action === "temporary";
          commitCenter(action, notch ? CENTER_STEP_MS : 0);
        }
      }
      if (disposed) return;
      centerWheelTimer = setTimeout(() => {
        centerWheelTimer = null; centerWheel = null;
        if (!busy && centerCommitTimer === null) resetCenterPreview();
      }, gesture.committed ? (gesture.temporary ? CENTER_TEMPORARY_IDLE_MS : CENTER_WHEEL_IDLE_MS) : CENTER_PROGRESS_IDLE_MS);
    }
    if (editing) $(".back").onclick = back;
    $(".save-current").onclick = () => editing ? openSelected() : void save();
    if (editing) {
      $(".move-before").onclick = () => moveSelected(-1);
      $(".move-after").onclick = () => moveSelected(1);
      $(".hide-folder").onclick = () => void edit(() => onHide?.(destination().id), ".back");
    }
    $(".root-next").onclick = nextPage;
    backdrop.addEventListener("click", event => {
      if (editing || !available() || suppressClick || event.target.closest?.("button,.notice")) return;
      const bounds = $(".arc").getBoundingClientRect();
      const centerX = side === "right" ? bounds.right : bounds.left;
      const centerY = bounds.top + bounds.height / 2;
      const inside = event.clientX >= bounds.left && event.clientX <= bounds.right
        && Math.hypot(event.clientX - centerX, event.clientY - centerY) <= bounds.height / 2;
      if (!inside) { event.preventDefault(); event.stopPropagation(); cancel(); }
    });
    panel.addEventListener("click", event => {
      if (locked || busy || suppressClick) { lastTap = null; event.preventDefault(); event.stopImmediatePropagation(); suppressClick = false; }
    }, true);
    $(".arc").addEventListener("wheel", event => {
      if (editing) return;
      if (event.target.closest?.(".center")) { wheelCenter(event); return; }
      if (!available()) return;
      const { max } = dialInfo(); if (max <= 0) return;
      const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      if (!delta) return;
      const now = performance.now(), direction = Math.sign(delta);
      event.preventDefault(); event.stopPropagation(); lastTap = null;
      clearTimeout(wheelTimer);
      if (event.deltaMode || Math.abs(delta) >= 40) {
        if (direction !== wheelBurstDirection || now >= wheelBurstUntil) {
          kickDial(direction); wheelBurstDirection = direction; wheelBurstUntil = now + DIAL_WHEEL_BURST_MS;
        }
      } else {
        if (!wheelGesture) {
          wheelGesture = { position: rawDialPosition(), changedAt: now, samples: [{ position: rawDialPosition(), at: now }] };
          stopDialSpring();
        }
        wheelBurstDirection = 0;
        wheelGesture.position += delta / (radius * .75 * DIAL_VISUAL_STEP_DEGREES * Math.PI / 180);
        sample(wheelGesture, wheelGesture.position, now);
        paintDial(wheelGesture.position, true); $(".arc").classList.add("dial-moving");
        if (reducedMotion?.matches) { paintDial(Math.round(clampedDialPosition()), false, true); $(".arc").classList.remove("dial-moving"); }
      }
      wheelTimer = setTimeout(() => {
        wheelBurstDirection = 0;
        if (!wheelGesture) return;
        // OS inertia is already in the deltas. At idle, stale samples contribute
        // no second fling; a fresh sample still uses the same release projection.
        const velocity = releaseVelocity(wheelGesture, performance.now()); wheelGesture = null;
        startDialMotion(velocity);
      }, DIAL_WHEEL_IDLE_MS);
    }, { passive: false });
    panel.addEventListener("pointerdown", event => {
      keyboardModality = false; syncKeyboardFocus();
      if (pointer?.center || event.isPrimary === false || event.button > 0) return;
      if (!editing && event.target.closest?.(".save-current")) {
        suppressClick = !available();
        if (!available()) return;
        clearTimeout(centerWheelTimer); centerWheel = null; resetCenterPreview();
        pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, center: true, axis: null };
        try { $(".save-current").setPointerCapture?.(event.pointerId); } catch {}
        return;
      }
      if (event.target.closest?.(".sector[data-peek]")) event.preventDefault();
      const ring = !editing && available() && event.target.closest?.(".arc") && !event.target.closest?.(".center");
      if (ring) { clearTimeout(wheelTimer); wheelGesture = null; stopDialSpring(); }
      pointer = { id: event.pointerId, x: event.clientX, y: event.clientY,
        dial: ring ? { startAngle: dialAngle(event), startPosition: rawDialPosition(), changedAt: performance.now(), samples: [{ position: rawDialPosition(), at: performance.now() }], dragging: false } : null };
      suppressClick = false;
    });
    panel.addEventListener("pointermove", event => {
      if (pointer?.id !== event.pointerId) return;
      if (pointer.center) {
        if (available()) moveCenterPointer(event);
        return;
      }
      const distance = Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y);
      if (pointer.dial) {
        const now = performance.now();
        if (!pointer.dial.dragging && distance > 6) {
          pointer.dial.dragging = true; suppressClick = true; lastTap = null; $(".arc").classList.add("dial-moving");
          try { $(".arc").setPointerCapture?.(event.pointerId); } catch {}
        }
        if (pointer.dial.dragging) {
          const total = angleDelta(dialAngle(event), pointer.dial.startAngle);
          const next = pointer.dial.startPosition - total / DIAL_VISUAL_STEP_DEGREES;
          sample(pointer.dial, next, now); paintDial(next, true);
        }
      } else if (distance > 10) { suppressClick = true; lastTap = null; }
    });
    panel.addEventListener("pointerup", event => {
      if (pointer?.id !== event.pointerId) return;
      if (pointer.center) {
        const distance = available() ? moveCenterPointer(event) : 0;
        const action = pointer.axis === "vertical" ? centerAction(distance) : null;
        suppressClick = Boolean(pointer.axis) || !available();
        releaseCenterPointer(); pointer = null;
        if (action) commitCenter(action); else resetCenterPreview();
        return;
      }
      if (pointer.dial?.dragging) {
        startDialMotion(releaseVelocity(pointer.dial, performance.now()));
        suppressClick = true; lastTap = null;
      } else if (pointer?.dial) {
        startDialMotion(0);
      }
      pointer = null;
    });
    panel.addEventListener("pointercancel", event => {
      if (pointer?.id !== event.pointerId) return;
      if (pointer.center) { releaseCenterPointer(); resetCenterPreview(); }
      if (pointer.dial) { startDialMotion(0); }
      pointer = null; suppressClick = true; lastTap = null;
    });
    $(".save-current").addEventListener("lostpointercapture", event => {
      if (!pointer?.center || pointer.id !== event.pointerId) return;
      pointer = null; suppressClick = true; lastTap = null; resetCenterPreview();
    });
    for (const type of ["contextmenu", "selectstart", "dragstart"]) panel.addEventListener(type, event => { event.preventDefault(); event.stopPropagation(); });
    function syncKeyboardFocus() {
      panel.classList.toggle("keyboard-focus", keyboardModality);
    }
    syncKeyboardFocus();
    if (!editing) paintCenter(0, 1);
    panel.addEventListener("keydown", event => {
      keyboardModality = true; syncKeyboardFocus(); event.stopPropagation();
      if (event.key === "Escape") { if (!editing) { event.preventDefault(); cancel(); } return; }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        if (!available()) return;
        const id = shadow.activeElement?.dataset.classificationId;
        if (id) frame().selectedId = id;
        openSelected(); return;
      }
      if (!editing && (event.key === "t" || event.key === "T") && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
          && !shadow.activeElement?.closest("input,textarea,select,[contenteditable]:not([contenteditable=false]),[role=textbox]")
          && !event.target.closest?.("input,textarea,select,[contenteditable]:not([contenteditable=false]),[role=textbox]")) {
        if (onTemporary) { event.preventDefault(); void temporary(); }
        return;
      }
      if (event.key === "Backspace") { event.preventDefault(); back(); return; }
      if (event.key === "PageDown" || event.key === "PageUp") {
        event.preventDefault();
        if (editing && available() && pageInfo().count > 1) {
          lastTap = null;
          frame().page = (frame().page + (event.key === "PageDown" ? 1 : pageInfo().count - 1)) % pageInfo().count;
          render(); focusFirst();
        } else if (!editing && available() && dialInfo().max > 0) {
          lastTap = null; clearTimeout(wheelTimer); kickDial(event.key === "PageDown" ? 1 : -1); focusFirst();
        }
        return;
      }
      if (event.key === "Tab" && !editing) {
        const buttons = [...panel.querySelectorAll("button")].filter(button => !button.disabled && !button.hidden && button.tabIndex >= 0);
        const index = buttons.indexOf(shadow.activeElement);
        event.preventDefault(); buttons[(index + (event.shiftKey ? buttons.length - 1 : 1)) % buttons.length]?.focus();
      }
      if (["ArrowUp", "ArrowDown"].includes(event.key)) {
        const buttons = [...panel.querySelectorAll(".sector:not(:disabled):not([aria-hidden=true])")];
        const index = buttons.indexOf(shadow.activeElement);
        event.preventDefault(); buttons[(index + (event.key === "ArrowUp" ? buttons.length - 1 : 1)) % buttons.length]?.focus();
      }
      if (event.key === "Enter" && event.ctrlKey) { event.preventDefault(); if (editing) openSelected(); else void save(); }
      if (event.key === "Enter" || event.key === " ") suppressClick = false;
    });
    setLocked(locked); render(); position();
    reducedMotion?.addEventListener?.("change", onReducedMotion);
    window.addEventListener("pagehide", dispose);
    if (!editing) {
      focusFirst();
      motion(panel, [{ opacity: 0, transform: `translateX(${side === "right" ? 8 : -8}px)` }, { opacity: 1, transform: "translateX(0)" }], 140);
    }
    window.addEventListener("resize", position);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    return { host, close: cancel, dispose, update, get tree() { return tree; }, unlockInput: () => setLocked(false), lockInput: () => setLocked(true) };
  }

  const CSS = `
:host{--paper:#252f3e;--ink:#e2eaf5;--line:#465265;--muted:#a5b3c6;--sector:#343e4e;--selected:#3579df;--inverse:#fff;position:fixed;inset:0;z-index:2147483646;pointer-events:none;font:15px/1.4 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI','Malgun Gothic',sans-serif;color:var(--ink);-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}
*{box-sizing:border-box;-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}button{font:inherit;color:inherit;cursor:pointer;border:0;touch-action:manipulation}button:disabled{cursor:default;color:var(--muted)}button:focus-visible{outline:2px solid var(--ink);outline-offset:-4px}[hidden]{display:none!important}
.backdrop{position:fixed;inset:0;pointer-events:auto;background:rgba(0,0,0,.14)}:host(.input-locked) .backdrop,:host(.exiting) .backdrop{pointer-events:none}
.panel{position:fixed;width:var(--radius,224px);overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;scrollbar-width:none;padding-bottom:8px;filter:drop-shadow(0 2px 2px rgba(0,0,0,.30)) drop-shadow(0 14px 28px rgba(0,0,0,.22))}
.path{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.root-next{width:100%;min-height:44px;padding:2px;background:none;color:var(--inverse);text-shadow:0 1px 3px #000c;font-size:12px}
.arc{position:relative;width:var(--radius);height:calc(var(--radius) * 2);border-radius:100% 0 0 100% / 50% 0 0 50%;background:transparent;margin:6px 0;isolation:isolate;--dial-angle:0deg;--dial-counter-angle:0deg;--dial-brightness:1}:host(:not(.editing)) .arc{overflow:hidden;touch-action:none}.folders{position:absolute;inset:0;opacity:1}.folder-exit-host{position:absolute;inset:0;z-index:2;pointer-events:none}.sectors{position:absolute;inset:0;z-index:1}.dial-labels{display:none}:host(:not(.editing)) .sectors{width:calc(var(--radius) * 2);height:calc(var(--radius) * 2);left:var(--dial-left,0px);right:auto;bottom:auto;transform-origin:50% 50%;transform:rotate(var(--dial-angle));filter:brightness(var(--dial-brightness));will-change:transform,filter}:host(:not(.editing)) .dial-labels{display:block;position:absolute;left:0;top:0;width:calc(var(--radius) * 2);height:calc(var(--radius) * 2);z-index:2;pointer-events:none;filter:brightness(var(--dial-brightness))}:host(:not(.editing)) .sector>.sector-label{display:none}.dial-label{position:absolute;transform:translate(-50%,-50%);width:calc(var(--radius) * .36);display:flex;flex-direction:column;align-items:center;gap:2px;color:var(--ink);opacity:0;pointer-events:none;will-change:left,top,opacity}.dial-label.selected{color:var(--inverse)}.center{z-index:3}:host(:not(.editing)) .sector:disabled{pointer-events:none}:host(:not(.editing)) .sector.dial-buffer:disabled{color:inherit}@media(pointer:fine){:host(:not(.editing)) .sector:not(:disabled){cursor:grab}:host(:not(.editing)) .arc.dial-moving .sector:not(:disabled){cursor:grabbing}}
.sector{position:absolute;inset:0;width:100%;height:100%;background:transparent;padding:0}.sector:before{content:'';position:absolute;inset:0;clip-path:var(--sector-face);background:var(--sector);pointer-events:none;transition:background-color 90ms ease-out}.sector.branch{background:#647187}.sector.branch[aria-pressed=true]{background:#8eb8f5}.sector:not(:disabled):not([aria-pressed=true]):hover:before{background:#424f63}.sector[aria-pressed=true]:before{background:var(--selected)}.sector[aria-pressed=true]{color:var(--inverse)}.sector:not(:disabled):not([aria-pressed=true]):active:before{background:#53627a}.sector[aria-pressed=true]:active:before{background:#2865bf}.sector.empty:before{background:#242d3a}:host(:not(.editing)) .sector.empty{visibility:hidden}
.sector-label{position:absolute;transform:translate(-50%,-50%) rotate(var(--dial-counter-angle));width:calc(var(--radius) * .36);display:flex;flex-direction:column;align-items:center;gap:2px;pointer-events:none}.name{width:100%;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;word-break:keep-all;overflow-wrap:anywhere;text-align:center;font-size:14px;font-weight:500;letter-spacing:-.01em;line-height:1.25}.dial-label .name{font-weight:600}.sector-label small{font-size:11px;color:var(--muted)}.sector.next:before{background:#2b3749}
.sector:focus-visible,.center button:focus-visible{outline:none}.panel.keyboard-focus .sector:focus:before{background:#526985}.panel.keyboard-focus .sector[aria-pressed=true]:focus:before{background:#195bbd}.panel.keyboard-focus .center button:focus .action-icon{outline:2px solid #fff;outline-offset:3px;border-radius:8px}
.center{position:absolute;right:0;top:50%;transform:translateY(-50%);width:calc(var(--radius) * .43);height:calc(var(--radius) * .86);border-radius:100% 0 0 100% / 50% 0 0 50%;overflow:hidden;background:#2b3749;box-shadow:inset 0 0 0 1px #49596f}.center button{position:absolute;right:0;width:100%;padding:0;background:transparent;color:#c5d1e3}.save-current{top:0;height:61%;border-bottom:1px solid #49596f}.back{bottom:0;height:39%}.save-current:not(:disabled){background:#326ed0;color:#fff}.save-current:not(:disabled):hover{background:#407fdf}.back:not(:disabled):hover{background:#39495f}.center button:disabled{color:#8291a6}.action-icon{position:absolute;width:34px;height:34px;left:calc(62% - 17px);top:calc(55% - 17px);pointer-events:none}.back .action-icon{left:calc(66% - 16px);top:calc(40% - 16px);width:32px;height:32px}.action-icon svg{display:block;width:100%;height:100%;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.save-current[aria-busy=true] .action-icon{opacity:.55}
:host(:not(.editing)) .save-current{height:100%;border-bottom:0;touch-action:none}
:host(:not(.editing)) .save-current .action-icon{top:calc(50% - 17px);left:calc(57.56% - 17px)}
:host(:not(.editing)) .panel[data-side=left] .save-current .action-icon{left:auto;right:calc(57.56% - 17px)}
:host(:not(.editing)) .save-current[aria-disabled=true]{background:transparent;color:#8291a6}
:host(:not(.editing)) .center-face{position:absolute;inset:0;pointer-events:none;clip-path:inset(100% 0 0 0)}
:host(:not(.editing)) .center-preview{color:#fff;opacity:0}
footer{background:none}.notice{padding:10px;max-height:100px;overflow:auto;background:var(--paper);border-radius:12px;font-size:13px;color:#f0c5aa}
.panel[data-side=left] .arc,.panel[data-side=left] .center{border-radius:0 100% 100% 0 / 0 50% 50% 0}.panel[data-side=left] .center{left:0;right:auto}.panel[data-side=left] .action-icon{left:auto;right:calc(62% - 17px)}.panel[data-side=left] .back .action-icon{right:calc(66% - 16px)}
.destination-caption{position:relative;margin:6px 0;display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:4px;pointer-events:none;line-height:18px}.destination-caption[data-side=left]{justify-content:flex-start}.destination-caption[data-placement=above]{position:fixed;margin:0}:host(.editing) .destination-caption{display:none}.breadcrumb{display:inline-flex;align-items:center;min-width:0;flex:none;transform-origin:center}.bubble-pill{position:relative;display:block;min-width:0;max-width:100%;padding:4px 10px;border:1px solid var(--line);border-radius:999px;background:var(--paper);color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.breadcrumb.selected .bubble-pill{background:var(--selected);color:var(--inverse);font-size:13px;font-weight:600}.bubble-separator{flex:none;width:12px;color:var(--muted);font-size:12px;white-space:pre}.breadcrumb.first .bubble-separator{display:none}.bubble-old{position:absolute;left:10px;right:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.breadcrumb.leaving{position:absolute;pointer-events:none}
@media(prefers-reduced-motion:reduce){.sector:before{transition:none}}
:host(.editing){position:relative;inset:auto;z-index:auto;display:block;pointer-events:auto;width:100%;font-family:inherit}
:host(.editing) .backdrop{position:static;background:none}
:host(.editing) .panel{position:relative;width:100%;overflow:visible;filter:none;padding:0}
:host(.editing) .arc{margin:18px auto 12px;overflow:visible;touch-action:manipulation}:host(.editing) .sectors{transform:none}
:host(.editing) .root-next{color:var(--inverse);text-shadow:none;border:1px solid var(--line);border-radius:12px;max-width:224px;display:block;margin:0 auto 12px}
.edit-controls{border-top:1px solid var(--line);padding-top:14px;color:var(--inverse)}
.edit-selection{min-height:40px;text-align:center;font-size:13px;overflow-wrap:anywhere}
.edit-actions{display:flex;gap:6px;justify-content:center}
.edit-actions button{min-height:44px;flex:1;max-width:120px;padding:8px 4px;border:1px solid var(--line);border-radius:12px;background:#2b3749;color:var(--inverse);font-size:13px}
.edit-actions button:not(:disabled):hover{background:#39495f}.edit-actions button:disabled{color:#8291a6;background:#242d3a}
:host(.editing) .notice{margin-bottom:12px}
`;
  globalThis.LakomicsArcCollector = { mount };
})();
