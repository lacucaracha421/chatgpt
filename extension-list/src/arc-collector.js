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
    const requestFrame = window.requestAnimationFrame?.bind(window) || (callback => setTimeout(() => callback(performance.now()), 16));
    const cancelFrame = window.cancelAnimationFrame?.bind(window) || (id => clearTimeout(id));
    const host = document.createElement("div"); host.id = "lakomics-arc-collector"; host.classList.toggle("editing", editing);
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style"); style.textContent = CSS; shadow.append(style);
    const backdrop = document.createElement("div"); backdrop.className = "backdrop";
    const panel = document.createElement("section"); panel.className = "panel";
    panel.setAttribute("role", editing ? "region" : "dialog"); if (!editing) panel.setAttribute("aria-modal", "true"); panel.setAttribute("aria-label", editing ? "반원 폴더 배치" : "분류 선택");
    panel.innerHTML = '<div class="path" aria-live="polite"></div><div class="arc"><div class="sectors"></div><div class="dial-labels" aria-hidden="true"></div><div class="center"><button class="back"><span>‹ 뒤로</span></button><button class="save-current"><span class="save-label"><span class="destination"></span><strong>저장</strong></span></button></div></div><footer><button class="root-next" hidden></button><div class="notice" role="status" hidden></div></footer>';
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
    function close(result) {
      if (disposed) return;
      disposed = true; host.remove();
      clearTimeout(temporaryTimer); clearTimeout(wheelTimer);
      if (dialFrame !== null) cancelFrame(dialFrame);
      window.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
      !editing && previousFocus?.isConnected && previousFocus.focus?.({ preventScroll: true });
      onClose?.(result);
    }
    function cancel() { if (editing || available()) close(); }
    function focusFirst() { $(".sector:not(:disabled)")?.focus({ preventScroll: true }); }
    function back() {
      if (!available() || history.length < 2) return;
      lastTap = null; history.pop();
      if (history.length === 1) {
        temporaryBlockedUntil = performance.now() + 400;
        clearTimeout(temporaryTimer);
        temporaryTimer = setTimeout(() => { temporaryTimer = null; if (!disposed) render(); }, 400);
      }
      notice(""); render(); focusFirst();
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
      history.push({ id, page: 0, selectedId: editing ? null : id, dialPosition: 0 }); notice(""); render(); focusFirst();
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
      const from = centerAngle - step / 2 + .25, to = centerAngle + step / 2 - .25;
      function ringPolygon(outerRadius, innerRadius) {
        const points = [];
        for (let angle = from; angle < to; angle += 2) points.push(point(outerRadius, angle));
        points.push(point(outerRadius, to));
        for (let angle = to; angle > from; angle -= 2) points.push(point(innerRadius, angle));
        points.push(point(innerRadius, from));
        return `polygon(${points.map(p => p.map(n => `${n.toFixed(2)}px`).join(" ")).join(",")})`;
      }
      const polygon = innerRadius => ringPolygon(radius, innerRadius);
      button.style.clipPath = polygon(radius * .48);
      if (button.classList.contains("branch")) {
        button.style.setProperty("--branch-ring", ringPolygon(radius, radius - 5));
        button.style.setProperty("--branch-highlight", ringPolygon(radius - 5, radius - 6));
      } else {
        button.style.removeProperty("--branch-ring"); button.style.removeProperty("--branch-highlight");
      }
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
      $(".back span").textContent = root ? "임시 저장" : "‹ 뒤로";
      $(".back").setAttribute("aria-label", root ? "임시 저장" : "뒤로");
      $(".back").disabled = busy || (root && (editing || !onTemporary || performance.now() < temporaryBlockedUntil));
      $(".save-current").disabled = busy || !destination() || (editing && (!hasChildren(destination()?.id) || destination()?.id === current.id));
      $(".save-current").setAttribute("aria-label", editing ? "선택한 폴더의 하위 폴더 열기" : destination() ? `${path}에 저장` : "폴더 선택 후 저장");
      $(".destination").textContent = destination()?.name || "폴더 선택";
      $(".save-current strong").textContent = editing ? "열기" : busy ? "저장 중…" : "저장";
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
      panel.querySelectorAll(".sector").forEach((button, index) => shape(button, index));
      paintDialLabels(Number(frame().dialPosition) || 0, true);
    }
    $(".back").onclick = async () => {
      if (frame().id !== null) { back(); return; }
      if (!available() || editing || !onTemporary || performance.now() < temporaryBlockedUntil) return;
      busy = true; render();
      try { if (await onTemporary() !== false) close(); }
      catch { notice("임시 저장을 열지 못했습니다."); }
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
    setLocked(locked); render(); position(); if (!editing) focusFirst();
    window.addEventListener("resize", position);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    return { host, close: cancel, update, get tree() { return tree; }, unlockInput: () => setLocked(false), lockInput: () => setLocked(true) };
  }

  const CSS = `
:host{--paper:#d9d8d2;--ink:#343532;--line:#a6a59f;--muted:#73746f;--sector:#d8d7d1;--selected:#454744;--inverse:#f6f5f0;position:fixed;inset:0;z-index:2147483646;pointer-events:none;font:15px/1.4 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI','Malgun Gothic',sans-serif;color:var(--ink);-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}
*{box-sizing:border-box;-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}button{font:inherit;color:inherit;cursor:pointer;border:0;touch-action:manipulation}button:disabled{cursor:default;color:#777865}button:focus-visible{outline:2px solid var(--ink);outline-offset:-4px}[hidden]{display:none!important}
.backdrop{position:fixed;inset:0;pointer-events:auto;background:rgba(0,0,0,.14)}:host(.input-locked) .backdrop{pointer-events:none}
.panel{position:fixed;width:var(--radius,224px);overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;scrollbar-width:none;padding-bottom:8px;filter:drop-shadow(0 2px 2px rgba(0,0,0,.30)) drop-shadow(0 14px 28px rgba(0,0,0,.22))}
.path{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.root-next{width:100%;min-height:44px;padding:2px;background:none;color:var(--inverse);text-shadow:0 1px 3px #000c;font-size:12px}
.arc{position:relative;width:var(--radius);height:calc(var(--radius) * 2);border-radius:100% 0 0 100% / 50% 0 0 50%;background:var(--line);margin:6px 0;isolation:isolate;box-shadow:inset 0 0 0 1px rgba(255,255,255,.22);--dial-angle:0deg;--dial-counter-angle:0deg;--dial-brightness:1}:host(:not(.editing)) .arc{overflow:hidden;touch-action:none}.sectors{position:absolute;inset:0;z-index:1}.dial-labels{display:none}:host(:not(.editing)) .sectors{width:calc(var(--radius) * 2);height:calc(var(--radius) * 2);right:auto;bottom:auto;transform-origin:50% 50%;transform:rotate(var(--dial-angle));filter:brightness(var(--dial-brightness));will-change:transform,filter}:host(:not(.editing)) .dial-labels{display:block;position:absolute;left:0;top:0;width:calc(var(--radius) * 2);height:calc(var(--radius) * 2);z-index:2;pointer-events:none;filter:brightness(var(--dial-brightness))}:host(:not(.editing)) .sector>.sector-label{display:none}.dial-label{position:absolute;transform:translate(-50%,-50%);width:calc(var(--radius) * .36);display:flex;flex-direction:column;align-items:center;gap:2px;color:var(--ink);opacity:0;pointer-events:none;will-change:left,top,opacity}.dial-label.selected{color:var(--inverse)}.center{z-index:3}:host(:not(.editing)) .sector:disabled{pointer-events:none}:host(:not(.editing)) .sector.dial-buffer:disabled{color:inherit}@media(pointer:fine){:host(:not(.editing)) .sector:not(:disabled){cursor:grab}:host(:not(.editing)) .arc.dial-moving .sector:not(:disabled){cursor:grabbing}}
.sector{position:absolute;inset:0;width:100%;height:100%;background:linear-gradient(115deg,#dfded8 0%,var(--sector) 56%,#cfcec8 100%);padding:0}.sector:nth-child(even){background:linear-gradient(115deg,#dad9d3 0%,#d3d2cc 58%,#cac9c3 100%)}.sector:not(:disabled):hover{background:#c8c7c1}.sector[aria-pressed=true]{background:linear-gradient(120deg,#4c4e4a 0%,var(--selected) 58%,#3d3f3c 100%);color:var(--inverse)}.sector[aria-pressed=true] small{color:#e3e2dd}.sector.empty{background:#cecdc7}
.sector.branch:before,.sector.branch:after{content:'';position:absolute;inset:0;pointer-events:none}.sector.branch:before{background:linear-gradient(180deg,#3b3d3a 0%,#2f312f 55%,#282a28 100%);clip-path:var(--branch-ring);filter:drop-shadow(0 1px 1px rgba(0,0,0,.24))}.sector.branch:after{background:rgba(255,255,255,.34);clip-path:var(--branch-highlight);opacity:.52}.sector[aria-pressed=true].branch:before{background:linear-gradient(180deg,#4b4d49 0%,#343633 58%,#2a2c2a 100%)}.sector[aria-pressed=true].branch:after{background:rgba(255,255,255,.42);opacity:.62}
.sector-label{position:absolute;transform:translate(-50%,-50%) rotate(var(--dial-counter-angle));width:calc(var(--radius) * .36);display:flex;flex-direction:column;align-items:center;gap:2px;pointer-events:none}.name{width:100%;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;overflow-wrap:anywhere;text-align:center;font-size:14px;font-weight:500;letter-spacing:-.01em;line-height:1.25}.dial-label .name{font-weight:600}.sector-label small{font-size:11px;color:var(--muted)}.sector.next{background:#bdbba3}.sector.next:disabled{background:#c6c3ae}
.sector:focus-visible,.center button:focus-visible{outline:none}.sector:focus-visible .name,.back:focus-visible>span,.save-current:focus-visible strong{text-decoration:underline;text-underline-offset:3px;text-decoration-thickness:2px}
.center{position:absolute;right:0;top:50%;transform:translateY(-50%);width:calc(var(--radius) * .47);height:calc(var(--radius) * .94);border-radius:100% 0 0 100% / 50% 0 0 50%;overflow:hidden;background:var(--line);box-shadow:inset 0 0 0 1px rgba(255,255,255,.16)}.center button{position:absolute;right:0;width:100%;height:50%;padding:0;background:linear-gradient(145deg,#e7e6e0,#d9d8d2)}.back{top:0;border-radius:100% 0 0 0;font-size:14px}.back:not(:disabled):hover{background:#cfcec8}.save-current{bottom:0;border-radius:0 0 0 100%;border-top:1px solid var(--line)}.save-current:not(:disabled){background:linear-gradient(120deg,#4c4e4a,var(--selected) 62%,#3d3f3c);color:var(--inverse)}.save-current:not(:disabled):hover{background:#50524e}.back>span,.save-label{position:absolute;left:64%;width:70%;transform:translate(-50%,-50%);pointer-events:none}.back>span{top:66%;white-space:nowrap}.save-label{top:35%;display:flex;flex-direction:column;align-items:center;gap:4px}.destination{width:100%;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;overflow-wrap:anywhere;font-size:12px}.save-current strong{font-size:16px;font-weight:600}
footer{background:none}.center .temporary:not(:disabled){background:linear-gradient(145deg,#e4e3dd,#d6d5cf);color:#4a4b48}.center .temporary:not(:disabled):hover{background:#cfcec8}.notice{padding:10px;max-height:100px;overflow:auto;background:var(--paper);font-size:13px;color:#794425}
.panel[data-side=left] .arc{transform:scaleX(-1)}.panel[data-side=left] .sector-label{transform:translate(-50%,-50%) rotate(var(--dial-counter-angle)) scaleX(-1)}.panel[data-side=left] .dial-label{transform:translate(-50%,-50%) scaleX(-1)}.panel[data-side=left] .back>span,.panel[data-side=left] .save-label{transform:translate(-50%,-50%) scaleX(-1)}
:host(.editing){position:relative;inset:auto;z-index:auto;display:block;pointer-events:auto;width:100%;font-family:inherit}
:host(.editing) .backdrop{position:static;background:none}
:host(.editing) .panel{position:relative;width:100%;overflow:visible;filter:none;padding:0}
:host(.editing) .arc{margin:18px auto 12px;overflow:visible;touch-action:manipulation}:host(.editing) .sectors{transform:none}
:host(.editing) .root-next{color:var(--inverse);text-shadow:none;border:1px solid #55564d;max-width:224px;display:block;margin:0 auto 12px}
.edit-controls{border-top:1px solid #55564d;padding-top:14px;color:var(--inverse)}
.edit-selection{min-height:40px;text-align:center;font-size:13px;overflow-wrap:anywhere}
.edit-actions{display:flex;gap:6px;justify-content:center}
.edit-actions button{min-height:44px;flex:1;max-width:120px;padding:8px 4px;border:1px solid #77786d;background:#292b26;color:var(--inverse);font-size:13px}
.edit-actions button:not(:disabled):hover{background:#41443a}.edit-actions button:disabled{color:#828477;background:#24251f}
:host(.editing) .notice{margin-bottom:12px}
`;
  globalThis.LakomicsArcCollector = { mount };
})();
