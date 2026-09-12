(() => {
  "use strict";
  const ROOT_SLOTS = 6, CHILD_SLOTS = 5;

  function mount({ entries, profile, arcLayout, hiddenClassificationIds = [], origin, onSave, onClose, onTemporary = null, inputLocked = false, container = null, onReorder, onHide }) {
    const editing = Boolean(container);
    const model = globalThis.LakomicsClassificationTree;
    let tree, layout, fullLayout;
    function readModel() {
      tree = model.createModel(model.visibleEntries(entries, hiddenClassificationIds), profile);
      fullLayout = model.reconcileArcLayout(entries, profile, arcLayout);
      const pinned = new Set(tree.profile.pinnedClassificationIds);
      layout = Object.fromEntries(Object.entries(fullLayout).map(([key, value]) => [key, {
        ...value, slots: value.slots.filter(id => id === null || (tree.byId.has(id) && (key === "__root__" || !pinned.has(id)))),
      }]));
    }
    readModel();
    const history = [{ id: null, page: 0, selectedId: null }];
    const previousFocus = document.activeElement;
    const viewport = window.visualViewport;
    const midpoint = (viewport?.offsetLeft || 0) + (viewport?.width || window.innerWidth) / 2;
    const side = Number.isFinite(origin?.x) && origin.x < midpoint ? "left" : "right";
    let busy = false, disposed = false, locked = Boolean(inputLocked), pointer = null, suppressClick = false;
    let radius = 224, lastTap = null, temporaryBlockedUntil = 0, temporaryTimer = null;
    const host = document.createElement("div"); host.id = "lakomics-arc-collector"; host.classList.toggle("editing", editing);
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style"); style.textContent = CSS; shadow.append(style);
    const backdrop = document.createElement("div"); backdrop.className = "backdrop";
    const panel = document.createElement("section"); panel.className = "panel";
    panel.setAttribute("role", editing ? "region" : "dialog"); if (!editing) panel.setAttribute("aria-modal", "true"); panel.setAttribute("aria-label", editing ? "반원 폴더 배치" : "분류 선택");
    panel.innerHTML = '<div class="path" aria-live="polite"></div><div class="arc"><div class="sectors"></div><div class="center"><button class="back"><span>‹ 뒤로</span></button><button class="save-current"><span class="save-label"><span class="destination"></span><strong>저장</strong></span></button></div></div><footer><button class="root-next" hidden></button><div class="notice" role="status" hidden></div></footer>';
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
    function setLocked(value) { locked = Boolean(value); host.classList.toggle("input-locked", locked); }
    function close(result) {
      if (disposed) return;
      disposed = true; host.remove();
      clearTimeout(temporaryTimer);
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
      history.push({ id, page: 0, selectedId: editing ? null : id }); notice(""); render(); focusFirst();
    }
    function update(next) {
      entries = next.classifications?.entries ?? entries; profile = next.profile ?? profile;
      arcLayout = next.arcLayout ?? arcLayout; hiddenClassificationIds = next.hiddenClassificationIds ?? hiddenClassificationIds;
      readModel();
      const invalid = history.findIndex(item => item.id !== null && !tree.byId.has(item.id));
      if (invalid >= 0) history.splice(invalid);
      for (const item of history) if (!tree.byId.has(item.selectedId)) item.selectedId = null;
      render();
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
    function shape(button, index) {
      const from = -90 + index * 30 + .5, to = from + 29;
      function polygon(innerRadius) {
        const points = [];
        for (let angle = from; angle < to; angle += 2) points.push(point(radius - 1, angle));
        points.push(point(radius - 1, to));
        for (let angle = to; angle > from; angle -= 2) points.push(point(innerRadius, angle));
        points.push(point(innerRadius, from));
        return `polygon(${points.map(p => p.map(n => `${n.toFixed(2)}px`).join(" ")).join(",")})`;
      }
      button.style.clipPath = polygon(radius * .48);
      if (button.classList.contains("branch")) button.style.setProperty("--branch-ring", polygon(radius - 11));
      const label = button.querySelector(".sector-label"), center = point(radius * .75, -75 + index * 30);
      label.style.left = `${center[0]}px`; label.style.top = `${center[1]}px`;
    }
    function render() {
      const current = frame(), { slots, size, count } = pageInfo();
      current.page = Math.min(current.page, count - 1);
      panel.dataset.page = String(current.page + 1);
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
      $(".root-next").hidden = current.id !== null || count < 2;
      $(".root-next").disabled = busy;
      const pageLabel = `${current.page === count - 1 ? "처음으로" : "다음"} · ${current.page + 1}/${count}`;
      $(".root-next").textContent = pageLabel;
      if (editing) {
        const ids = slots.filter(Boolean), index = ids.indexOf(current.selectedId);
        $(".edit-selection").textContent = destination() ? path : "폴더를 눌러 배치를 수정하세요";
        $(".move-before").disabled = busy || index <= 0;
        $(".move-after").disabled = busy || index < 0 || index >= ids.length - 1;
        $(".hide-folder").disabled = busy || index < 0;
      }
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
          button.setAttribute("aria-description", hasChildren(entry.id) ? "한 번 누르면 선택, 더블탭 또는 오른쪽 방향키로 하위 폴더 열기" : editing ? "배치할 폴더 선택" : "저장 위치 선택");
          button.setAttribute("aria-pressed", String(current.selectedId === entry.id));
          button.onclick = event => choose(entry.id, event); button.disabled = busy;
        } else {
          name.textContent = ""; button.disabled = true; button.classList.add("empty"); button.setAttribute("aria-label", "빈 칸");
        }
        label.append(name); if (paging) label.append(detail);
        button.append(label); shape(button, index); sectors.append(button);
      }
    }
    function position() {
      const viewport = window.visualViewport;
      const width = viewport?.width || window.innerWidth, height = viewport?.height || window.innerHeight;
      // Keep targets usable on small windows; the bounded panel can scroll in a
      // short landscape viewport instead of shrinking the controls indefinitely.
      radius = editing ? Math.max(140, Math.min(224, container.clientWidth || 224)) : Math.max(176, Math.min(224, width - 16, (height - 200) / 2));
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
    panel.addEventListener("pointerdown", event => { pointer = { id: event.pointerId, x: event.clientX, y: event.clientY }; suppressClick = false; });
    panel.addEventListener("pointermove", event => {
      if (pointer?.id === event.pointerId && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 10) { suppressClick = true; lastTap = null; }
    });
    panel.addEventListener("pointerup", () => { pointer = null; });
    panel.addEventListener("pointercancel", () => { pointer = null; suppressClick = true; lastTap = null; });
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
        if (available() && pageInfo().count > 1) {
          lastTap = null;
          frame().page = (frame().page + (event.key === "PageDown" ? 1 : pageInfo().count - 1)) % pageInfo().count;
          render(); focusFirst();
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
:host{--paper:#d7d3be;--ink:#35372f;--line:#999681;--muted:#686956;--sector:#d3cfb9;--selected:#41443a;--inverse:#f0ecdb;position:fixed;inset:0;z-index:2147483646;pointer-events:none;font:15px/1.4 'Segoe UI','Malgun Gothic',sans-serif;color:var(--ink);-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}
*{box-sizing:border-box;-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}button{font:inherit;color:inherit;cursor:pointer;border:0;touch-action:manipulation}button:disabled{cursor:default;color:#777865}button:focus-visible{outline:2px solid var(--ink);outline-offset:-4px}[hidden]{display:none!important}
.backdrop{position:fixed;inset:0;pointer-events:auto;background:#0002}:host(.input-locked) .backdrop{pointer-events:none}
.panel{position:fixed;width:var(--radius,224px);overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;scrollbar-width:none;padding-bottom:8px;filter:drop-shadow(-4px 4px 10px #0004)}
.path{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.root-next{width:100%;min-height:44px;padding:2px;background:none;color:var(--inverse);text-shadow:0 1px 3px #000c;font-size:12px}
.arc{position:relative;width:var(--radius);height:calc(var(--radius) * 2);border-radius:100% 0 0 100% / 50% 0 0 50%;background:var(--line);margin:6px 0;isolation:isolate}
.sector{position:absolute;inset:0;width:100%;height:100%;background:var(--sector);padding:0}.sector:nth-child(even){background:#cbc7b0}.sector:not(:disabled):hover{background:#b9b69e}.sector[aria-pressed=true]{background:var(--selected);color:var(--inverse)}.sector[aria-pressed=true] small{color:#d8d6c1}.sector.empty{background:#c6c3ae}
.sector.branch:before{content:'';position:absolute;inset:0;background:#303229;clip-path:var(--branch-ring);pointer-events:none}
.sector-label{position:absolute;transform:translate(-50%,-50%);width:calc(var(--radius) * .36);display:flex;flex-direction:column;align-items:center;gap:2px;pointer-events:none}.name{width:100%;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;overflow-wrap:anywhere;text-align:center;font-size:14px;line-height:1.25}.sector-label small{font-size:11px;color:var(--muted)}.sector.next{background:#bdbba3}.sector.next:disabled{background:#c6c3ae}
.sector:focus-visible,.center button:focus-visible{outline:none}.sector:focus-visible .name,.back:focus-visible>span,.save-current:focus-visible strong{text-decoration:underline;text-underline-offset:3px;text-decoration-thickness:2px}
.center{position:absolute;right:0;top:50%;transform:translateY(-50%);width:calc(var(--radius) * .47);height:calc(var(--radius) * .94);border-radius:100% 0 0 100% / 50% 0 0 50%;overflow:hidden;background:var(--line)}.center button{position:absolute;right:0;width:100%;height:50%;padding:0;background:#e0dcc8}.back{top:0;border-radius:100% 0 0 0;font-size:14px}.back:not(:disabled):hover{background:#c0bca5}.save-current{bottom:0;border-radius:0 0 0 100%;border-top:1px solid var(--line)}.save-current:not(:disabled){background:var(--selected);color:var(--inverse)}.save-current:not(:disabled):hover{background:#55594a}.back>span,.save-label{position:absolute;left:64%;width:70%;transform:translate(-50%,-50%);pointer-events:none}.back>span{top:66%;white-space:nowrap}.save-label{top:35%;display:flex;flex-direction:column;align-items:center;gap:4px}.destination{width:100%;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;overflow-wrap:anywhere;font-size:12px}.save-current strong{font-size:16px;font-weight:500}
footer{background:none}.center .temporary:not(:disabled){background:#b8c3ad;color:#344231}.center .temporary:not(:disabled):hover{background:#aab89e}.notice{padding:10px;max-height:100px;overflow:auto;background:var(--paper);font-size:13px;color:#794425}
.panel[data-side=left] .arc{transform:scaleX(-1)}.panel[data-side=left] .sector-label{transform:translate(-50%,-50%) scaleX(-1)}.panel[data-side=left] .back>span,.panel[data-side=left] .save-label{transform:translate(-50%,-50%) scaleX(-1)}
:host(.editing){position:relative;inset:auto;z-index:auto;display:block;pointer-events:auto;width:100%;font-family:inherit}
:host(.editing) .backdrop{position:static;background:none}
:host(.editing) .panel{position:relative;width:100%;overflow:visible;filter:none;padding:0}
:host(.editing) .arc{margin:18px auto 12px}
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
