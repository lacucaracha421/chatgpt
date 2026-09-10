(() => {
  "use strict";

  function mount({ entries, profile, origin, onSave, onClose, onTemporary = null, container = null, editing = false, onReorder = null, inputKind = null, inputLocked = false }) {
    let tree = globalThis.LakomicsClassificationTree.createModel(entries, profile);
    const trail = [];
    let selectedId = null;
    let busy = false;
    let disposed = false;
    let gesture = null;
    let suppressClick = false;
    let interactionLocked = Boolean(inputLocked);
    const offsets = new Map();
    const host = document.createElement("div");
    host.id = "lakomics-list-collector";
    if (container) host.className = "embedded";
    host.classList.toggle("input-locked", interactionLocked);
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style"); style.textContent = CSS; shadow.append(style);
    const backdrop = document.createElement("div"); backdrop.className = "backdrop";
    const panel = document.createElement("section"); panel.className = `panel${editing ? " editing" : ""}`;
    panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", editing ? "분류 순서" : "분류 선택");
    panel.innerHTML = '<header><button class="back" aria-label="이전">‹</button><div class="path"></div><button class="save-current" aria-label="현재 분류에 저장">↤</button><button class="close" aria-label="닫기">×</button></header><div class="swipe"><span class="back-reveal" aria-hidden="true">‹</span><div class="rows"></div></div><div class="notice" role="status" hidden></div>';
    backdrop.append(panel); shadow.append(backdrop); (container || document.documentElement).append(host);
    const $ = (selector) => panel.querySelector(selector);
    const rows = $(".rows"), swipe = $(".swipe");
    const previousFocus = document.activeElement;
    const animations = new Set();
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    function animate(element, frames, duration, easing = 'cubic-bezier(.2,.8,.2,1)') {
      if (!element?.animate) return Promise.resolve();
      const animation = element.animate(frames, { duration: reducedMotion ? 0 : duration, easing, fill: 'forwards' });
      animations.add(animation);
      return animation.finished.catch(() => {}).finally(() => animations.delete(animation));
    }

    function parentId() { return trail.at(-1) ?? null; }
    function key() { return trail.join("/"); }
    function items() {
      if (!trail.length) return tree.rootItems();
      return tree.children(parentId()).map((entry) => ({ entry, shortcut: false }));
    }
    function pathText() {
      const current = parentId();
      return current ? tree.path(current).map((entry) => entry.name).join(" > ") : "";
    }
    function remember() { offsets.set(key(), rows.scrollTop); }
    function setInputLocked(value) {
      interactionLocked = Boolean(value);
      host.classList.toggle("input-locked", interactionLocked);
    }

    function close(result) {
      if (disposed) return;
      disposed = true;
      for (const animation of animations) animation.cancel();
      animations.clear();
      host.remove(); window.removeEventListener("resize", position);
      if (previousFocus?.isConnected) previousFocus.focus?.({ preventScroll: true });
      onClose?.(result);
    }
    function cancel() { if (!busy) close(); }
    function back() {
      if (busy || !trail.length) return;
      remember(); trail.pop(); selectedId = trail.at(-1) ?? null; render(); rows.querySelector(".row")?.focus({ preventScroll: true });
    }
    function position() {
      if (container) return;
      const width = panel.offsetWidth || 350, height = panel.offsetHeight || 480;
      const viewportWidth = window.visualViewport?.width || window.innerWidth;
      const viewportHeight = window.visualViewport?.height || window.innerHeight;
      const touch = inputKind === "touch";
      // Touch opens with the finger over the non-action header, not over row 1.
      // This removes the old +16/-80 drift that made the sheet feel detached.
      const desiredLeft = touch ? (origin?.x ?? viewportWidth / 2) - width / 2 : (origin?.x ?? 16) + 16;
      const desiredTop = touch ? (origin?.y ?? 34) - 26 : (origin?.y ?? 100) - 80;
      panel.style.left = `${Math.max(8, Math.min(viewportWidth - width - 8, desiredLeft))}px`;
      panel.style.top = `${Math.max(8, Math.min(viewportHeight - height - 8, desiredTop))}px`;
    }
    async function save(id, row = null) {
      if (editing || busy || !id || !tree.byId.has(id)) return;
      remember();
      busy = true; panel.setAttribute("aria-busy", "true");
      for (const button of panel.querySelectorAll("button")) button.disabled = true;
      const wrap = row?.parentElement, reveal = wrap?.querySelector(".reveal");
      wrap?.classList.add("saving");
      if (reveal) reveal.textContent = "···";
      const departure = row ? animate(row, [
        { transform: window.getComputedStyle?.(row)?.transform || "none" },
        { transform: "translateX(-105%)" },
      ], 170, "cubic-bezier(.4,0,.8,.4)") : Promise.resolve();
      $(".notice").hidden = true;
      try {
        const [result] = await Promise.all([onSave(id), departure]);
        if (disposed) return;
        if (result?.ok) {
          wrap?.classList.add("saved");
          if (reveal) reveal.textContent = "✓";
          else $(".save-current").textContent = "✓";
          panel.setAttribute("aria-label", "저장 완료");
          await animate(reveal || $(".save-current"), [{ opacity: .4 }, { opacity: 1 }], 150);
          if (disposed) return;
          await animate(panel, [
            { opacity: 1, transform: "scale(1)" },
            { opacity: 0, transform: "scale(.96) translateY(3px)" },
          ], 140, "cubic-bezier(.4,0,1,1)");
          if (!disposed) close(result);
          return;
        }
        $(".notice").textContent = result?.message || "저장 실패"; $(".notice").hidden = false;
      } catch {
        if (!disposed) { $(".notice").textContent = "연결 실패"; $(".notice").hidden = false; }
      } finally {
        if (!disposed) {
          await departure;
          if (row) await animate(row, [{ transform: "translateX(-105%)" }, { transform: "translateX(0)" }], 180, "cubic-bezier(.16,.84,.31,1)");
          for (const animation of animations) animation.cancel();
          animations.clear();
          busy = false;
          if (!disposed) { panel.removeAttribute("aria-busy"); render(); }
        }
      }
    }

    async function reorder(id, targetIndex) {
      if (!editing || !onReorder || busy) return;
      const current = items().map((item) => item.entry.id);
      const from = current.indexOf(id);
      if (from < 0 || from === targetIndex) return;
      const next = [...current]; next.splice(targetIndex, 0, next.splice(from, 1)[0]);
      busy = true;
      try {
        const result = await onReorder(parentId(), next);
        if (result?.ok && result.state?.profile) {
          tree = globalThis.LakomicsClassificationTree.createModel(entries, result.state.profile);
        }
      } finally {
        busy = false;
        if (!disposed) render();
      }
    }

    function render() {
      const depth = trail.length;
      panel.dataset.depth = String(depth);
      panel.style.setProperty("--paper", `hsl(48 25% ${83 - Math.min(depth, 6) * 3}%)`);
      panel.style.setProperty("--row-alt", `hsl(48 22% ${78 - Math.min(depth, 6) * 3}%)`);
      $(".path").textContent = pathText();
      if (editing) $(".path").textContent ||= "전체 분류";
      $(".back").disabled = busy || !trail.length;
      $(".close").hidden = editing;
      $(".save-current").hidden = editing;
      $(".save-current").disabled = busy || !parentId();
      rows.replaceChildren(); rows.style.transform = ""; $(".back-reveal").style.opacity = "0";
      for (const { entry } of items()) {
        const wrap = document.createElement("div"); wrap.className = "row-wrap";
        const reveal = document.createElement("span"); reveal.className = "reveal"; reveal.textContent = "저장"; reveal.setAttribute("aria-hidden", "true");
        const button = document.createElement("button"); button.className = "row"; button.dataset.classificationId = entry.id;
        button.setAttribute("aria-keyshortcuts", editing ? "Alt+ArrowUp Alt+ArrowDown" : "Control+Enter");
        const name = document.createElement("span"); name.className = "name"; name.textContent = entry.name;
        const branch = tree.hasChildren(entry.id);
        const mark = document.createElement("span"); mark.className = "mark"; mark.textContent = branch ? "›" : ""; mark.setAttribute("aria-hidden", "true");
        button.append(name, mark);
        button.onclick = () => {
          if (busy || suppressClick) return;
          remember(); selectedId = entry.id; $(".notice").hidden = true;
          if (branch) { if (!trail.includes(entry.id)) trail.push(entry.id); selectedId = trail.at(-1) ?? null; render(); rows.querySelector(".row")?.focus({ preventScroll: true }); }
          else render();
        };
        button.classList.toggle("selected", selectedId === entry.id);
        wrap.append(reveal, button); rows.append(wrap);
      }
      if (!trail.length && !editing && onTemporary) {
        const temporary = document.createElement("button"); temporary.className = "temporary-save"; temporary.textContent = "임시 저장";
        temporary.onclick = () => { if (!busy && onTemporary?.() !== false) close(); };
        rows.append(temporary);
      }
      rows.scrollTop = offsets.get(key()) || 0;
    }

    $(".back").onclick = back;
    $(".close").onclick = cancel;
    $(".save-current").onclick = () => void save(parentId());
    backdrop.addEventListener("click", (event) => { if (event.target === backdrop) cancel(); });
    for (const type of ["contextmenu", "selectstart", "dragstart"]) {
      panel.addEventListener(type, (event) => { event.preventDefault(); event.stopPropagation(); }, true);
    }
    panel.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); cancel(); return; }
      if (event.key === "Backspace" && trail.length) { event.preventDefault(); back(); }
      const buttons = [...rows.querySelectorAll(".row")];
      const index = buttons.indexOf(shadow.activeElement || event.target);
      if (["ArrowUp", "ArrowDown"].includes(event.key) && index >= 0) {
        event.preventDefault(); buttons[Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
      }
      if (!editing && event.ctrlKey && event.key === "Enter" && index >= 0) { event.preventDefault(); void save(buttons[index].dataset.classificationId, buttons[index]); }
      if (editing && event.altKey && ["ArrowUp", "ArrowDown"].includes(event.key) && index >= 0) {
        event.preventDefault(); void reorder(buttons[index].dataset.classificationId, Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowDown" ? 1 : -1))));
      }
    });

    swipe.addEventListener("pointerdown", (event) => {
      if (busy || event.button !== 0 || gesture) return;
      const row = event.target.closest?.(".row");
      if (!row) return;
      gesture = {
        id: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, dy: 0, axis: null, row,
        lastX: event.clientX, lastT: performance.now(), velocityX: 0, ready: false, targetIndex: null,
      };
      suppressClick = false;
    });
    swipe.addEventListener("pointermove", (event) => {
      if (!gesture || gesture.id !== event.pointerId) return;
      const now = performance.now();
      const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
      const dt = Math.max(1, now - gesture.lastT);
      gesture.velocityX = (event.clientX - gesture.lastX) / dt;
      gesture.lastX = event.clientX; gesture.lastT = now; gesture.dx = dx; gesture.dy = dy;
      if (!gesture.axis && Math.hypot(dx, dy) > 10) {
        gesture.axis = editing ? (Math.abs(dy) >= Math.abs(dx) ? "y" : "cancel")
          : (Math.abs(dx) > Math.abs(dy) * 1.2 ? "x" : "y");
        if (gesture.axis === "x") { swipe.setPointerCapture?.(event.pointerId); suppressClick = true; }
      }
      if (editing) {
        if (gesture.axis !== "y") return;
        event.preventDefault(); suppressClick = true;
        gesture.row.style.transform = `translateY(${dy}px)`;
        const candidates = [...rows.querySelectorAll(".row")].filter((row) => row !== gesture.row);
        const y = event.clientY;
        gesture.targetIndex = candidates.filter((row) => {
          const box = row.getBoundingClientRect();
          return y > box.top + box.height / 2;
        }).length;
        rows.querySelectorAll(".drop-before,.drop-after").forEach((row) => row.classList.remove("drop-before", "drop-after"));
        const target = candidates[gesture.targetIndex];
        if (target) target.parentElement.classList.add("drop-before");
        else candidates.at(-1)?.parentElement.classList.add("drop-after");
        return;
      }
      if (gesture.axis !== "x") return;
      event.preventDefault(); suppressClick = true;
      const limit = threshold();
      if (dx < 0) {
        // Leftward save: direct at first, then resistant beyond the commit threshold.
        const magnitude = -dx;
        const travel = magnitude <= limit ? magnitude : limit + (magnitude - limit) * .28;
        gesture.row.style.transition = "none";
        gesture.row.style.transform = `translateX(${-Math.min(travel, swipe.clientWidth * .72)}px)`;
        const ready = magnitude >= limit;
        gesture.row.parentElement.classList.toggle("ready", ready);
        gesture.ready = ready;
        rows.style.transform = ""; $(".back-reveal").style.opacity = "0";
      } else {
        gesture.row.style.transition = "none"; gesture.row.style.transform = ""; gesture.row.parentElement.classList.remove("ready"); gesture.ready = false;
        if (trail.length) {
          const travel = Math.min(limit, dx);
          rows.style.transform = `translateX(${travel}px)`;
          $(".back-reveal").style.opacity = String(Math.min(1, dx / limit));
        }
      }
    });
    function threshold() { return Math.min(100, Math.max(64, swipe.clientWidth * .32)); }
    function finish(event, cancelled = false) {
      if (!gesture || gesture.id !== event.pointerId) return;
      const done = gesture; gesture = null;
      rows.style.transform = ""; $(".back-reveal").style.opacity = "0";
      rows.querySelectorAll(".drop-before,.drop-after").forEach((row) => row.classList.remove("drop-before", "drop-after"));
      if (cancelled) {
        done.row.style.transition = "transform 180ms cubic-bezier(.16,.84,.31,1)"; done.row.style.transform = ""; done.row.parentElement.classList.remove("ready"); return;
      }
      if (editing) {
        done.row.style.transform = "";
        if (done.axis === "y" && Number.isInteger(done.targetIndex)) void reorder(done.row.dataset.classificationId, done.targetIndex);
        return;
      }
      if (done.axis !== "x") return;
      const limit = threshold();
      const flickSave = done.dx <= -limit * .55 && done.velocityX < -.55;
      if (done.dx <= -limit || flickSave) {
        // Keep the row under the finger; save() takes over with the leftward departure.
        done.row.style.transition = "none";
        void save(done.row.dataset.classificationId, done.row);
        return;
      }
      done.row.style.transition = "transform 190ms cubic-bezier(.16,.84,.31,1)"; done.row.style.transform = ""; done.row.parentElement.classList.remove("ready");
      if (done.dx >= limit && trail.length) back();
    }
    swipe.addEventListener("pointerup", (event) => finish(event));
    swipe.addEventListener("pointercancel", (event) => finish(event, true));
    swipe.addEventListener("lostpointercapture", (event) => { if (event.target === swipe && gesture?.id === event.pointerId) finish(event, true); });
    swipe.addEventListener("click", (event) => { if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); suppressClick = false; } }, true);

    window.addEventListener("resize", position);
    render(); position();
    if (!container) rows.querySelector(".row")?.focus({ preventScroll: true });
    return { host, close: cancel, tree, unlockInput: () => setInputLocked(false), lockInput: () => setInputLocked(true) };
  }

  const CSS = `
:host{--paper:#d7d3b9;--ink:#302f28;--line:#aaa68f;--quiet:#bdb9a1;font:14px/1.4 'Segoe UI',sans-serif;color:var(--ink);position:fixed;inset:0;z-index:2147483646;pointer-events:none;-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}
*{box-sizing:border-box;-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}button{font:inherit;color:inherit;cursor:pointer;border:0;border-radius:0}button:focus-visible{outline:2px solid var(--ink);outline-offset:-3px}button:disabled{opacity:.35;cursor:default}
.backdrop{position:fixed;inset:0;pointer-events:auto}:host(.input-locked) .backdrop{pointer-events:none}.panel{position:fixed;width:350px;height:480px;max-width:calc(100vw - 16px);max-height:calc(100dvh - 16px);background:var(--paper);box-shadow:0 14px 40px #0005;display:flex;flex-direction:column;border:1px solid var(--line)}
.panel:before{content:'';position:absolute;inset:8px auto 8px 7px;border-left:4px solid var(--quiet);width:3px;border-right:1px solid var(--line);pointer-events:none}
header{display:flex;align-items:center;gap:3px;min-height:52px;margin:0 10px 0 21px;border-bottom:1px solid var(--line)}header button{flex:none;width:30px;min-height:40px;background:none;font-size:22px}.save-current{font-size:19px}.path{flex:1;min-width:0;max-height:60px;overflow:auto;font-size:12px;overflow-wrap:anywhere}
.swipe{flex:1;min-height:0;position:relative;margin:8px 10px 8px 21px;touch-action:pan-y pinch-zoom;overflow:hidden}.rows{position:relative;height:100%;touch-action:pan-y pinch-zoom;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--ink) transparent;padding-right:5px;background:var(--paper)}
.row-wrap{position:relative;touch-action:pan-y pinch-zoom;overflow:hidden;margin-bottom:4px;--row-paper:var(--paper)}.row-wrap:nth-child(even){--row-paper:var(--row-alt,#c9c5ac)}.reveal{position:absolute;inset:0;display:flex;align-items:center;justify-content:flex-end;padding-right:16px;background:var(--quiet);color:var(--ink);font-size:12px;transition:background-color 100ms,color 100ms,letter-spacing 120ms}.ready .reveal{background:var(--ink);color:var(--paper);font-weight:600;letter-spacing:.08em}
.row{position:relative;display:flex;align-items:center;gap:10px;width:100%;min-height:44px;padding:9px 10px;background:var(--row-paper);text-align:left;user-select:none;-webkit-user-select:none}.row:before{content:'';width:10px;height:10px;flex:none;background:var(--ink)}.name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mark{font-size:17px}.row:hover{background:var(--quiet)}.row.selected{background:var(--ink);color:var(--paper)}.row.selected:before{background:var(--paper)}
.back-reveal{position:absolute;left:12px;right:auto;top:40%;z-index:2;font-size:40px;opacity:0;transform:none;pointer-events:none}.notice{font-size:12px;margin:0 12px 10px 23px;max-height:48px;overflow:auto}[hidden]{display:none!important}
.temporary-save{display:block;width:100%;min-height:44px;margin-top:12px;padding:10px 12px;border-top:1px solid #838e87;background:#a8b9ae;color:#263b32;text-align:left}.temporary-save:before{content:'↓';margin-right:12px}.temporary-save:hover{background:#97ad9f}.temporary-save:disabled{opacity:.65}
.saving .reveal{background:var(--ink);color:var(--paper);justify-content:center;font-size:20px;letter-spacing:4px;padding:0}.saved .reveal{letter-spacing:0;font-size:25px}.panel[aria-busy=true] .row:disabled{opacity:1}.panel[aria-busy=true] .row-wrap:not(.saving){opacity:.6}
:host(.embedded){position:relative;display:block;inset:auto;z-index:auto;pointer-events:auto;width:100%;max-width:350px;min-width:0}:host(.embedded) .backdrop{position:relative;inset:auto}:host(.embedded) .panel{position:relative;width:100%;max-width:100%;height:480px;box-shadow:none}
.editing .save-current,.editing .close{display:none}.editing .swipe,.editing .rows,.editing .row-wrap,.editing .row{touch-action:none}.editing .row-wrap{overflow:visible}.editing .row-wrap:has(.lifted){z-index:2}.editing .row{transition:transform 120ms ease-out}.editing .drop-before{box-shadow:0 -3px var(--ink)}.editing .drop-after{box-shadow:0 3px var(--ink)}
@media(prefers-reduced-motion:reduce){.row,.reveal{transition:none!important}}
`
  globalThis.LakomicsListCollector = { mount };
})();
