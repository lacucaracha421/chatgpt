(() => {
  "use strict";
  const ROOT_SLOTS = 6, CHILD_SLOTS = 5;
  const DIAL_VISIBLE_SLOTS = 6, DIAL_POOL_SLOTS = 14, DIAL_POOL_LEAD = 4;
  const DIAL_VISUAL_STEP_DEGREES = 360 / DIAL_POOL_SLOTS, DIAL_GESTURE_STEP_DEGREES = 30, DIAL_CENTER_SLOT = 2;
  const DIAL_WHEEL_BURST_MS = 110, DIAL_WHEEL_ANALOG_THRESHOLD = 48;
  const DIAL_WHEEL_IMPULSE = 2.6, DIAL_MAX_VELOCITY = 3.4;
  const DIAL_FREE_FRICTION = 4.2, DIAL_INPUT_FRICTION = 1.0;
  const DIAL_DETENT_CAPTURE_SPEED = 1.15, DIAL_DETENT_SPRING = 95, DIAL_DETENT_DAMPING = 18;
  const DIAL_EDGE_SPRING = 120, DIAL_EDGE_DAMPING = 20;

  function mount({ entries, profile, arcLayout, hiddenClassificationIds = [], origin, onSave, onClose, onTemporary = null, inputLocked = false, container = null, onReorder, onHide }) {
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
    const side = Number.isFinite(origin?.x) && origin.x < midpoint ? "left" : "right";
    let busy = false, disposed = false, locked = Boolean(inputLocked), pointer = null, suppressClick = false;
    let radius = 224, lastTap = null, temporaryBlockedUntil = 0, temporaryTimer = null;
    let dialFrame = null, dialVelocity = 0, dialLastTime = 0, dialMoving = false, dialInputUntil = 0, dialDetentTarget = null, wheelTimer = null;
    let wheelBurstUntil = 0, wheelBurstDirection = 0, wheelAccumulator = 0, dialNodeParent = null, dialPoolStart = null, dialLabelSignature = null;
    const dialNodes = new Map(), dialLabels = new Map();
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
    panel.innerHTML = `<div class="path" aria-live="polite"></div><div class="arc"><div class="folders"><div class="sectors"></div><div class="dial-labels" aria-hidden="true"></div></div><div class="center"><button class="save-current"><span class="action-icon">${icon(SAVE_ICON)}</span><span class="destination" hidden></span></button><button class="back"><span class="action-icon">${icon(DOWNLOAD_ICON)}</span></button></div></div><footer><button class="root-next" hidden></button><div class="notice" role="status" hidden></div></footer>`;
    if (editing) {
      const controls = document.createElement("div"); controls.className = "edit-controls";
      controls.innerHTML = '<div class="edit-selection" aria-live="polite"></div><div class="edit-actions"><button class="move-before">이전 칸</button><button class="move-after">다음 칸</button><button class="hide-folder">숨기기</button></div>';
      panel.append(controls);
    }
    backdrop.append(panel); shadow.append(backdrop); (container || document.documentElement).append(host);
    const $ = selector => panel.querySelector(selector);
    const frame = () => history.at(-1);
    const available = () => !disposed && !busy && !locked;
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
    function setLocked(value) { locked = Boolean(value); host.classList.toggle("input-locked", locked); }
    function stopMotion(target) {
      const animation = motions.get(target);
      if (!animation) return;
      motions.delete(target); animation.onfinish = null; animation.cancel();
    }
    function motion(target, frames, duration, after) {
      stopMotion(target);
      if (reducedMotion?.matches || !target.animate) { after?.(); return; }
      const animation = target.animate(frames, { duration, easing: "cubic-bezier(.2,0,0,1)" });
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
      wheelBurstUntil = 0; wheelBurstDirection = 0; wheelAccumulator = 0;
      change(); render(); focusFirst();
      if (!snapshot) return;
      // A separate shadow tree keeps inert snapshots out of live button queries.
      const wrapper = document.createElement("div"); wrapper.className = "folder-exit-host";
      wrapper.inert = true; wrapper.setAttribute("aria-hidden", "true");
      wrapper.classList.toggle("editing", editing);
      const root = wrapper.attachShadow({ mode: "open" });
      const snapshotStyle = style.cloneNode(true);
      snapshotStyle.textContent += `:host{position:absolute;inset:0;z-index:2;pointer-events:none;width:100%;height:100%}${side === "left" && !editing ? '.dial-label{transform:translate(-50%,-50%) scaleX(-1)}' : ''}`;
      root.append(snapshotStyle, snapshot.layer);
      $(".arc").append(wrapper); outgoing = wrapper;
      motion(wrapper, [{ opacity: snapshot.opacity }, { opacity: 0 }], 140, () => { wrapper.remove(); if (outgoing === wrapper) outgoing = null; });
      motion($(".folders"), [{ opacity: 0 }, { opacity: 1 }], 180);
    }
    function cleanup() {
      disposed = true;
      clearTimeout(temporaryTimer); clearTimeout(wheelTimer);
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
      clearFolderMotion();
      for (const target of [...motions.keys()]) stopMotion(target);
      stopDialSpring(); if (!editing) paintDial(Math.round(clampedDialPosition()), false, true);
    }
    function close(result, action = ".save-current") {
      if (disposed) return;
      const success = result?.ok && !editing && !reducedMotion?.matches && Boolean(panel.animate);
      cleanup();
      if (success) {
        host.inert = true; host.removeAttribute("id"); host.setAttribute("aria-hidden", "true"); host.classList.add("exiting");
        motion($(`${action} .action-icon`), [{ transform: "scale(1)" }, { transform: "scale(1.12)", offset: .45 }, { transform: "scale(1)" }], 100);
        motion(panel, [{ opacity: 1 }, { opacity: 0 }], 100, dispose);
        exitTimer = setTimeout(dispose, 160);
      } else dispose();
      !editing && previousFocus?.isConnected && previousFocus.focus?.({ preventScroll: true });
      onClose?.(result);
    }
    function cancel() { if (editing || available()) close(); }
    function focusFirst() { $(".sector:not(:disabled)")?.focus({ preventScroll: true }); }
    function back() {
      if (!available() || history.length < 2) return;
      lastTap = null;
      changeFolder(() => history.pop());
      if (history.length === 1) {
        temporaryBlockedUntil = performance.now() + 400;
        clearTimeout(temporaryTimer);
        temporaryTimer = setTimeout(() => { temporaryTimer = null; if (!disposed) render(); }, 400);
      }
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
      if (doubleTap && hasChildren(id)) { openSelected(); return; }
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
    function point(r, degrees) {
      const angle = degrees * Math.PI / 180;
      return [radius - r * Math.cos(angle), radius + r * Math.sin(angle)];
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
        const p = (r, a) => point(r, a).map(n => n.toFixed(2)).join(" ");
        return `path("M ${p(outer, from + od)} A ${outer} ${outer} 0 0 0 ${p(outer, to - od)} Q ${p(outer, to)} ${p(outer - corner, to)} L ${p(inner + corner, to)} Q ${p(inner, to)} ${p(inner, to - id)} A ${inner} ${inner} 0 0 1 ${p(inner, from + id)} Q ${p(inner, from)} ${p(inner + corner, from)} L ${p(outer - corner, from)} Q ${p(outer, from)} ${p(outer, from + od)} Z")`;
      }
      button.style.clipPath = roundedWedge(radius, radius * .50);
      button.style.setProperty("--sector-face", roundedWedge(button.classList.contains("branch") ? radius - 5 : radius, radius * .50));
      const label = button.querySelector(".sector-label"), center = point(radius * .75, centerAngle);
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
      const origin = runtimeDialOrigin(), fadeStart = 68, fadeEnd = 96;
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
        button.onclick = event => choose(entry.id, event);
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
        button.classList.toggle("dial-buffer", !visible);
        if (visible) button.removeAttribute("aria-hidden"); else button.setAttribute("aria-hidden", "true");
        button.disabled = busy || !entry || !visible;
        if (entry) button.setAttribute("aria-pressed", String(current.selectedId === entry.id));
      }
      for (const label of dialLabels.values()) label.classList.toggle("selected", current.selectedId === label.dataset.classificationId);
      panel.dataset.dialIndex = String(base);
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
      syncDialSectorState(clamped);
    }
    function paintDial(value, rubber = false, crisp = false) {
      const current = frame(), { max } = dialInfo(current);
      let next = Number.isFinite(value) ? value : 0;
      if (rubber) {
        if (next < 0) next = -Math.min(.24, Math.abs(next) * .22);
        else if (next > max) next = max + Math.min(.24, (next - max) * .22);
      } else next = Math.max(0, Math.min(max, next));
      current.dialPosition = next;
      const clamped = Math.max(0, Math.min(max, next));
      renderDialSectors(clamped); paintDialLabels(next, crisp);
      const angle = next * DIAL_VISUAL_STEP_DEGREES;
      const arc = $(".arc"), detent = 1 - Math.min(1, Math.abs(next - Math.round(next)) * 2);
      arc.style.setProperty("--dial-angle", `${angle.toFixed(3)}deg`);
      arc.style.setProperty("--dial-counter-angle", `${(-angle).toFixed(3)}deg`);
      arc.style.setProperty("--dial-brightness", (0.985 + detent * 0.015).toFixed(3));
      panel.dataset.dialPosition = clamped.toFixed(3);
    }
    function stopDialSpring() {
      if (dialFrame !== null) cancelFrame(dialFrame);
      dialFrame = null; dialVelocity = 0; dialMoving = false; dialDetentTarget = null; dialInputUntil = 0;
      $(".arc")?.classList.remove("dial-moving", "dial-detent");
    }
    function startDialMotion(initialVelocity = null) {
      if (reducedMotion?.matches) { stopDialSpring(); paintDial(Math.round(clampedDialPosition()), false, true); return; }
      if (Number.isFinite(initialVelocity)) dialVelocity = Math.max(-DIAL_MAX_VELOCITY, Math.min(DIAL_MAX_VELOCITY, initialVelocity));
      if (dialFrame !== null) return;
      dialMoving = true; $(".arc").classList.add("dial-moving"); dialLastTime = performance.now();
      const step = now => {
        dialFrame = null;
        if (disposed || editing) { stopDialSpring(); return; }
        const dt = Math.min(.032, Math.max(.008, (now - dialLastTime) / 1000 || .016)); dialLastTime = now;
        const current = frame(), { max } = dialInfo(current), position = Number(current.dialPosition) || 0;
        const inputActive = now < dialInputUntil;
        let acceleration = 0, phase = "free";
        if (position < 0 || position > max) {
          const boundary = Math.max(0, Math.min(max, position));
          acceleration = DIAL_EDGE_SPRING * (boundary - position) - DIAL_EDGE_DAMPING * dialVelocity; phase = "edge"; dialDetentTarget = null;
        } else if (dialDetentTarget !== null && !inputActive) {
          acceleration = DIAL_DETENT_SPRING * (dialDetentTarget - position) - DIAL_DETENT_DAMPING * dialVelocity; phase = "detent";
        } else if (!inputActive && Math.abs(dialVelocity) <= DIAL_DETENT_CAPTURE_SPEED) {
          dialDetentTarget = Math.max(0, Math.min(max, Math.round(position)));
          acceleration = DIAL_DETENT_SPRING * (dialDetentTarget - position) - DIAL_DETENT_DAMPING * dialVelocity; phase = "detent";
        } else {
          acceleration = -(inputActive ? DIAL_INPUT_FRICTION : DIAL_FREE_FRICTION) * dialVelocity;
        }
        dialVelocity += acceleration * dt;
        paintDial(position + dialVelocity * dt, true);
        const arc = $(".arc"); arc.classList.toggle("dial-detent", phase === "detent");
        if (!inputActive && dialDetentTarget !== null
          && Math.abs(dialVelocity) < .06 && Math.abs(dialDetentTarget - (Number(current.dialPosition) || 0)) < .008) {
          paintDial(dialDetentTarget, false, true); dialVelocity = 0; dialMoving = false; dialDetentTarget = null;
          arc.classList.remove("dial-moving", "dial-detent"); return;
        }
        dialFrame = requestFrame(step);
      };
      dialFrame = requestFrame(step);
    }
    function kickDial(direction) {
      const current = frame(), { max } = dialInfo(current), position = clampedDialPosition(current);
      if (reducedMotion?.matches) { stopDialSpring(); paintDial(Math.round(position) + direction, false, true); return; }
      if ((position <= 0 && direction < 0) || (position >= max && direction > 0)) {
        dialDetentTarget = null; dialVelocity = 0; paintDial(position + direction * .10, true); startDialMotion(0); return;
      }
      dialDetentTarget = null; dialInputUntil = performance.now() + 150;
      startDialMotion(Math.max(-DIAL_MAX_VELOCITY, Math.min(DIAL_MAX_VELOCITY, dialVelocity + direction * DIAL_WHEEL_IMPULSE)));
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
      const root = current.id === null;
      $(".back").classList.toggle("temporary", root);
      $(".back path").setAttribute("d", root ? DOWNLOAD_ICON : BACK_ICON);
      $(".back").setAttribute("aria-label", root ? "임시 저장" : "뒤로");
      $(".back").disabled = busy || (root && (editing || !onTemporary || performance.now() < temporaryBlockedUntil));
      $(".save-current").disabled = busy || !destination() || (editing && (!hasChildren(destination()?.id) || destination()?.id === current.id));
      $(".save-current").setAttribute("aria-label", editing ? "선택한 폴더의 하위 폴더 열기" : destination() ? `${path}에 저장` : "폴더 선택 후 저장");
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
        current.dialPosition = clampedDialPosition(current);
        renderDialSectors(current.dialPosition); paintDial(current.dialPosition, false, true);
      }
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
    }
    $(".back").onclick = async () => {
      if (frame().id !== null) { back(); return; }
      if (!available() || editing || !onTemporary || performance.now() < temporaryBlockedUntil) return;
      busy = true; render();
      try {
        const result = await onTemporary();
        if (result !== false) close(result?.ok ? result : undefined, ".back");
      }
      catch { if (!disposed) notice("임시 저장을 열지 못했습니다."); }
      finally { busy = false; if (!disposed) render(); }
    };
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
      if (editing || !available() || event.target.closest?.(".center")) return;
      const { max } = dialInfo(); if (max <= 0) return;
      let delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      if (!delta) return;
      if (event.deltaMode === 1) delta *= 16; else if (event.deltaMode === 2) delta *= 160;
      const magnitude = Math.abs(delta), now = performance.now();
      let direction = 0;
      if (magnitude >= 40) { direction = Math.sign(delta); wheelAccumulator = 0; }
      else {
        wheelAccumulator += delta;
        if (Math.abs(wheelAccumulator) >= DIAL_WHEEL_ANALOG_THRESHOLD) { direction = Math.sign(wheelAccumulator); wheelAccumulator = 0; }
      }
      event.preventDefault(); event.stopPropagation(); lastTap = null;
      if (direction && (direction !== wheelBurstDirection || now >= wheelBurstUntil)) {
        kickDial(direction); wheelBurstDirection = direction; wheelBurstUntil = now + DIAL_WHEEL_BURST_MS;
      }
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => { wheelAccumulator = 0; wheelBurstDirection = 0; }, DIAL_WHEEL_BURST_MS);
    }, { passive: false });
    panel.addEventListener("pointerdown", event => {
      const ring = !editing && available() && event.target.closest?.(".arc") && !event.target.closest?.(".center");
      if (ring) { clearTimeout(wheelTimer); stopDialSpring(); }
      pointer = { id: event.pointerId, x: event.clientX, y: event.clientY,
        dial: ring ? { startAngle: dialAngle(event), startPosition: Number(frame().dialPosition) || 0, lastPosition: Number(frame().dialPosition) || 0, lastAt: performance.now(), velocity: 0, dragging: false } : null };
      suppressClick = false;
    });
    panel.addEventListener("pointermove", event => {
      if (pointer?.id !== event.pointerId) return;
      const distance = Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y);
      if (pointer.dial) {
        const now = performance.now();
        if (!pointer.dial.dragging && distance > 6) {
          pointer.dial.dragging = true; suppressClick = true; lastTap = null; dialMoving = true; $(".arc").classList.add("dial-moving");
          try { $(".arc").setPointerCapture?.(event.pointerId); } catch {}
        }
        if (pointer.dial.dragging) {
          const total = angleDelta(dialAngle(event), pointer.dial.startAngle);
          const next = pointer.dial.startPosition - total / DIAL_GESTURE_STEP_DEGREES;
          const dt = Math.max(.008, (now - pointer.dial.lastAt) / 1000);
          const instant = (next - pointer.dial.lastPosition) / dt;
          pointer.dial.velocity = pointer.dial.velocity * .68 + instant * .32;
          pointer.dial.lastPosition = next; pointer.dial.lastAt = now; paintDial(next, true);
        }
      } else if (distance > 10) { suppressClick = true; lastTap = null; }
    });
    panel.addEventListener("pointerup", event => {
      if (pointer?.id === event.pointerId && pointer.dial?.dragging) {
        dialDetentTarget = null; dialInputUntil = performance.now();
        startDialMotion(Math.max(-DIAL_MAX_VELOCITY, Math.min(DIAL_MAX_VELOCITY, pointer.dial.velocity * .22)));
        suppressClick = true; lastTap = null;
      } else if (pointer?.dial) {
        dialDetentTarget = null; dialInputUntil = performance.now(); startDialMotion(0);
      }
      pointer = null;
    });
    panel.addEventListener("pointercancel", event => {
      if (pointer?.id === event.pointerId && pointer.dial) { dialDetentTarget = null; dialInputUntil = performance.now(); startDialMotion(0); }
      pointer = null; suppressClick = true; lastTap = null;
    });
    for (const type of ["contextmenu", "selectstart", "dragstart"]) panel.addEventListener(type, event => { event.preventDefault(); event.stopPropagation(); });
    for (const type of ["focusin", "focusout"]) panel.addEventListener(type, () => {
      const id = shadow.activeElement?.dataset.classificationId;
      for (const label of dialLabels.values()) label.classList.toggle("focused", type === "focusin" && label.dataset.classificationId === id);
    });
    panel.addEventListener("keydown", event => {
      event.stopPropagation();
      if (event.key === "Escape") { if (!editing) { event.preventDefault(); cancel(); } return; }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        if (!available()) return;
        const id = shadow.activeElement?.dataset.classificationId;
        if (id) frame().selectedId = id;
        openSelected(); return;
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
        const buttons = [...panel.querySelectorAll("button")].filter(button => !button.disabled && !button.hidden);
        const index = buttons.indexOf(shadow.activeElement);
        event.preventDefault(); buttons[(index + (event.shiftKey ? buttons.length - 1 : 1)) % buttons.length]?.focus();
      }
      if (["ArrowUp", "ArrowDown"].includes(event.key)) {
        const buttons = [...panel.querySelectorAll(".sector:not(:disabled)")];
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
.arc{position:relative;width:var(--radius);height:calc(var(--radius) * 2);border-radius:100% 0 0 100% / 50% 0 0 50%;background:transparent;margin:6px 0;isolation:isolate;--dial-angle:0deg;--dial-counter-angle:0deg;--dial-brightness:1}:host(:not(.editing)) .arc{overflow:hidden;touch-action:none}.folders{position:absolute;inset:0;opacity:1}.folder-exit-host{position:absolute;inset:0;z-index:2;pointer-events:none}.sectors{position:absolute;inset:0;z-index:1}.dial-labels{display:none}:host(:not(.editing)) .sectors{width:calc(var(--radius) * 2);height:calc(var(--radius) * 2);right:auto;bottom:auto;transform-origin:50% 50%;transform:rotate(var(--dial-angle));filter:brightness(var(--dial-brightness));will-change:transform,filter}:host(:not(.editing)) .dial-labels{display:block;position:absolute;left:0;top:0;width:calc(var(--radius) * 2);height:calc(var(--radius) * 2);z-index:2;pointer-events:none;filter:brightness(var(--dial-brightness))}:host(:not(.editing)) .sector>.sector-label{display:none}.dial-label{position:absolute;transform:translate(-50%,-50%);width:calc(var(--radius) * .36);display:flex;flex-direction:column;align-items:center;gap:2px;color:var(--ink);opacity:0;pointer-events:none;will-change:left,top,opacity}.dial-label.selected{color:var(--inverse)}.center{z-index:3}:host(:not(.editing)) .sector:disabled{pointer-events:none}:host(:not(.editing)) .sector.dial-buffer:disabled{color:inherit}@media(pointer:fine){:host(:not(.editing)) .sector:not(:disabled){cursor:grab}:host(:not(.editing)) .arc.dial-moving .sector:not(:disabled){cursor:grabbing}}
.sector{position:absolute;inset:0;width:100%;height:100%;background:transparent;padding:0}.sector:before{content:'';position:absolute;inset:0;clip-path:var(--sector-face);background:var(--sector);pointer-events:none;transition:background-color 90ms ease-out}.sector.branch{background:#647187}.sector.branch[aria-pressed=true]{background:#8eb8f5}.sector:not(:disabled):hover:before{background:#424f63}.sector[aria-pressed=true]:before{background:var(--selected)}.sector[aria-pressed=true]{color:var(--inverse)}.sector:not(:disabled):active:before{background:#53627a}.sector[aria-pressed=true]:active:before{background:#2865bf}.sector.empty:before{background:#242d3a}:host(:not(.editing)) .sector.empty{visibility:hidden}
.sector-label{position:absolute;transform:translate(-50%,-50%) rotate(var(--dial-counter-angle));width:calc(var(--radius) * .36);display:flex;flex-direction:column;align-items:center;gap:2px;pointer-events:none}.name{width:100%;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;overflow-wrap:anywhere;text-align:center;font-size:14px;font-weight:500;letter-spacing:-.01em;line-height:1.25}.dial-label .name{font-weight:600}.sector-label small{font-size:11px;color:var(--muted)}.sector.next:before{background:#2b3749}
.sector:focus-visible,.center button:focus-visible{outline:none}.sector:focus-visible:before{background:#526985}.sector[aria-pressed=true]:focus-visible:before{background:#195bbd}.sector:focus-visible .name,.dial-label.focused .name{text-decoration:underline;text-underline-offset:3px}.center button:focus-visible .action-icon{outline:2px solid #fff;outline-offset:3px;border-radius:8px}
.center{position:absolute;right:0;top:50%;transform:translateY(-50%);width:calc(var(--radius) * .43);height:calc(var(--radius) * .86);border-radius:100% 0 0 100% / 50% 0 0 50%;overflow:hidden;background:#2b3749;box-shadow:inset 0 0 0 1px #49596f}.center button{position:absolute;right:0;width:100%;padding:0;background:transparent;color:#c5d1e3}.save-current{top:0;height:61%;border-bottom:1px solid #49596f}.back{bottom:0;height:39%}.save-current:not(:disabled){background:#326ed0;color:#fff}.save-current:not(:disabled):hover{background:#407fdf}.back:not(:disabled):hover{background:#39495f}.center button:disabled{color:#8291a6}.action-icon{position:absolute;width:34px;height:34px;left:calc(62% - 17px);top:calc(55% - 17px);pointer-events:none}.back .action-icon{left:calc(66% - 16px);top:calc(40% - 16px);width:32px;height:32px}.action-icon svg{display:block;width:100%;height:100%;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.save-current[aria-busy=true] .action-icon{opacity:.55}
footer{background:none}.notice{padding:10px;max-height:100px;overflow:auto;background:var(--paper);border-radius:12px;font-size:13px;color:#f0c5aa}
.panel[data-side=left] .arc{transform:scaleX(-1)}.panel[data-side=left] .sector-label{transform:translate(-50%,-50%) rotate(var(--dial-counter-angle)) scaleX(-1)}.panel[data-side=left] .dial-label{transform:translate(-50%,-50%) scaleX(-1)}.panel[data-side=left] .action-icon svg{transform:scaleX(-1)}
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
