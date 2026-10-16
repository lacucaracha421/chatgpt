// Mock of the Lakomics Companion arc save menu (extension-list/src/arc-collector.js).
// variant "current" recreates today's menu (geometry, colours and centre drag ported
// from the real code). Variants "v1" "v2" "v3" are the calm redesigns: neutral glass
// fan, one ivory accent (the save disc and the selected folder), and 뒤로 / 임시저장 /
// 번역 as small quiet parts. All variants keep the hidden centre drag (up 뒤로, down 임시저장).
(() => {
  "use strict";
  const COMMIT = 48, SLOP = 10, HOLD_MS = 120;
  const ICON = {
    save: "M -12 -5 V 9 Q -12 11 -10 11 H 10 Q 12 11 12 9 V -4 Q 12 -6 10 -6 H 1 L -3 -9 H -10 Q -12 -9 -12 -7 Z M 2 -2 V 6 M -2 2 L 2 6 L 6 2",
    download: "M 0 -9 V 3 M -4 -1 L 0 3 L 4 -1 M -8 5 V 9 H 8 V 5",
    back: "M 7 -7 H -2 Q -9 -7 -9 0 V 4 M -13 0 L -9 4 L -5 0",
    up: "M -7 3 L 0 -4 L 7 3",
    left: "M 3 -7 L -4 0 L 3 7",
  };
  const svg = path => `<svg viewBox="-18 -18 36 36" aria-hidden="true"><path d="${path}"/></svg>`;
  const TREE = [
    { id: "illust", name: "일러스트", children: [
      { id: "genshin", name: "원신" }, { id: "ba", name: "블루 아카이브" }, { id: "wuwa", name: "명조" },
      { id: "nikke", name: "니케" }, { id: "orig", name: "오리지널" }] },
    { id: "manga", name: "망가" },
    { id: "cos", name: "코스프레", children: [{ id: "cos-kr", name: "한국" }, { id: "cos-jp", name: "일본" }] },
    { id: "wall", name: "배경화면" },
    { id: "meme", name: "밈" },
    { id: "ref", name: "참고자료", children: [{ id: "pose", name: "포즈" }, { id: "paint", name: "채색" }, { id: "bgref", name: "배경" }] },
  ];
  const byId = new Map(), parentOf = new Map();
  (function walk(list, parent) { for (const item of list) { byId.set(item.id, item); parentOf.set(item.id, parent); if (item.children) walk(item.children, item.id); } })(TREE, null);
  const pathOf = id => { const out = []; for (let at = id; at; at = parentOf.get(at)) out.unshift(byId.get(at)); return out; };
  const children = id => (id === null ? TREE : byId.get(id)?.children) || [];
  const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const el = (tag, className, html) => { const node = document.createElement(tag); if (className) node.className = className; if (html != null) node.innerHTML = html; return node; };
  const esc = text => text.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // Fan geometry per skin: step (degrees per folder), gap (degrees each side), radii as R fractions.
  const SKIN = {
    current: { step: 360 / 14, gap: 1.5, inner: .5, corner: 7, label: .75, labelWidth: .36 },
    calm: { step: 22, gap: .3, inner: .54, corner: 3, label: .77, labelWidth: .34 },
  };

  function create(frame, options) {
    const opts = { variant: "v3", R: 208, side: "right", touch: true, initial: null, onAction: () => {}, ...options };
    let history, open = true, drag = null, suppressClick = false, lastTap = null, commitTimer = null;
    const root = el("div", "am");
    frame.append(root);

    function reset() {
      history = [{ id: null, selectedId: opts.initialRoot || null }];
      if (opts.initial) for (const step of opts.initial) history.push({ ...step });
    }
    const top = () => history.at(-1);
    const destination = () => byId.get(top().selectedId) || null;
    const canBack = () => history.length > 1;
    const parentName = () => history.length > 2 ? byId.get(history.at(-2).id).name : "맨 위";
    const calm = () => opts.variant !== "current";
    const skin = () => SKIN[calm() ? "calm" : "current"];

    function point(r, degrees, sector) {
      const a = degrees * Math.PI / 180, R = opts.R;
      return [opts.side === "left" ? (sector ? R : 0) + r * Math.cos(a) : R - r * Math.cos(a), R + r * Math.sin(a)];
    }
    function wedge(centerAngle, outer, inner) {
      const { step, gap, corner } = skin();
      return wedgeRange(centerAngle - step / 2 + gap, centerAngle + step / 2 - gap, outer, inner, corner);
    }
    function wedgeRange(from, to, outer, inner, corner) {
      const od = corner / outer * 180 / Math.PI, id = corner / inner * 180 / Math.PI;
      const p = (r, a) => point(r, a, true).map(n => n.toFixed(2)).join(" ");
      const sweep = opts.side === "left" ? 1 : 0;
      return `path("M ${p(outer, from + od)} A ${outer} ${outer} 0 0 ${sweep} ${p(outer, to - od)} Q ${p(outer, to)} ${p(outer - corner, to)} L ${p(inner + corner, to)} Q ${p(inner, to)} ${p(inner, to - id)} A ${inner} ${inner} 0 0 ${1 - sweep} ${p(inner, from + id)} Q ${p(inner, from)} ${p(inner + corner, from)} L ${p(outer - corner, from)} Q ${p(outer, from)} ${p(outer, from + od)} Z")`;
    }

    function render(fade = false) {
      const R = opts.R, S = skin();
      root.replaceChildren();
      root.dataset.side = opts.side; root.dataset.variant = opts.variant; root.dataset.touch = String(opts.touch);
      root.dataset.skin = calm() ? "calm" : "current";
      root.style.setProperty("--R", `${R}px`);
      root.classList.toggle("closed", !open);
      root.setAttribute("role", "dialog"); root.setAttribute("aria-label", "분류 선택");

      renderCaption();

      const arc = el("div", "am-arc"); root.append(arc);
      const folders = el("div", "am-folders"); arc.append(folders);
      const sectors = el("div", "am-sectors"), labels = el("div", "am-labels");
      folders.append(sectors, labels);
      const list = children(top().id), origin = -((list.length - 1) * S.step) / 2;
      if (calm() && list.length) {
        // One continuous dark ring behind the folders; the thin seams between folders show it.
        const ring = el("div", "am-ring");
        ring.style.clipPath = wedgeRange(origin - S.step / 2, origin + (list.length - .5) * S.step, R, R * S.inner, 3);
        sectors.append(ring);
      }
      list.forEach((item, index) => {
        const angle = origin + index * S.step;
        const branch = Boolean(item.children?.length);
        const selected = top().selectedId === item.id;
        const button = el("button", `am-sector${branch ? " branch" : ""}`);
        button.type = "button";
        button.setAttribute("aria-pressed", String(selected));
        button.setAttribute("aria-label", pathOf(item.id).map(x => x.name).join(" / ") + (branch ? " (하위 폴더 있음)" : ""));
        button.style.clipPath = wedge(angle, R, R * S.inner);
        button.style.setProperty("--sector-face", wedge(angle, branch && !calm() ? R - 5 : R, R * S.inner));
        button.addEventListener("click", event => choose(item, event));
        sectors.append(button);
        const label = el("span", `am-label${selected ? " selected" : ""}`);
        label.style.width = `${R * S.labelWidth}px`;
        label.append(el("span", "am-name", esc(item.name)));
        if (branch && calm()) label.append(el("span", "am-more", `하위 ${item.children.length}`));
        const [x, y] = point(R * S.label, angle, false);
        label.style.left = `${x}px`; label.style.top = `${y}px`;
        labels.append(label);
      });
      if (fade && !reduced()) folders.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: "cubic-bezier(.2,0,0,1)" });

      const center = el("div", "am-center"); arc.append(center);
      if (calm()) renderDisc(center); else renderCurrentCenter(center);
      bindCenterDrag(center);
      if (calm()) renderSecondary();
    }

    // ---- caption above the arc
    function renderCaption() {
      if (!calm()) {
        const caption = el("div", "am-caption");
        const trail = history.slice(1).map(item => byId.get(item.id));
        const selected = destination();
        if (selected && trail.at(-1)?.id !== selected.id) trail.push(selected);
        trail.forEach((item, index) => {
          if (index) caption.append(el("span", "am-sep", "›"));
          caption.append(el("span", `am-pill${item.id === selected?.id ? " selected" : ""}`, esc(item.name)));
        });
        root.append(caption); return;
      }
      const caption = el("div", "am-caption calm");
      if (opts.variant === "v3") {
        // 뒤로 lives where the path is: one quiet button naming the folder it returns to.
        if (canBack()) {
          const back = el("button", "am-crumb", `${svg(ICON.left)}<span>${esc(parentName())}</span>`);
          back.type = "button"; back.setAttribute("aria-label", `뒤로 · ${parentName()}`);
          back.addEventListener("click", () => act("back"));
          caption.append(back);
        }
      } else if (canBack()) {
        caption.append(el("span", "am-path", history.slice(1).map(item => esc(byId.get(item.id).name)).join(" › ")));
      }
      root.append(caption);
    }

    // ---- today's one-button centre
    function renderCurrentCenter(center) {
      center.classList.add("current");
      const dest = destination();
      const button = el("button", "am-save", `<span class="am-face"></span><span class="am-icon main">${svg(ICON.save)}</span><span class="am-icon preview">${svg(ICON.download)}</span>`);
      button.type = "button";
      button.setAttribute("aria-label", dest ? `${pathOf(dest.id).map(x => x.name).join(" / ")}에 저장` : "저장");
      button.setAttribute("aria-disabled", String(!dest));
      button.addEventListener("click", event => { if (consumeSuppressed(event)) return; act("save"); });
      center.append(button);
    }

    // ---- calm centre: one ivory disc with one primary action.
    // Top level, nothing chosen: 임시저장. Otherwise: 여기 저장 (the chosen folder).
    // Swiping down: 임시저장 at the top level, 뒤로 inside a folder. No up swipe.
    const tapAction = () => (history.length === 1 && !destination() ? "temporary" : "save");
    const swipeAction = () => (history.length === 1 ? "temporary" : "back");
    const DISC_TEXT = {
      temporary: { icon: ICON.download, meta: "분류 없이 받기" },
      save: { icon: ICON.save, meta: "여기 저장" },
    };
    function discMeta() { return DISC_TEXT[tapAction()].meta; }
    function renderDisc(center) {
      center.classList.add("disc");
      const dest = destination(), tap = tapAction(), swipe = swipeAction();
      const name = tap === "temporary" ? "임시저장" : esc(dest.name);
      // The hint names the swipe only when it differs from the tap.
      const hint = swipe === tap ? "" : `<span class="d-hint">${svg("M -7 -3 L 0 4 L 7 -3")}${swipe === "back" ? "뒤로" : "임시저장"}</span>`;
      const button = el("button", "am-disc",
        `<span class="d-col">${svg(DISC_TEXT[tap].icon)}<b class="d-name">${name}</b><small class="d-meta">${DISC_TEXT[tap].meta}</small></span>${hint}`);
      button.type = "button"; button.dataset.tap = tap;
      button.setAttribute("aria-label", tap === "temporary" ? "임시저장 (분류 없이 받기)" : `${pathOf(dest.id).map(x => x.name).join(" / ")}에 저장`);
      button.setAttribute("aria-description", `아래로 밀면 ${swipe === "back" ? "뒤로" : "임시저장"}`);
      button.addEventListener("click", event => { if (consumeSuppressed(event)) return; act(tap); });
      center.append(button);
    }

    function quiet(kind, iconHtml, label, className) {
      const button = el("button", className, `<span class="q-ic">${iconHtml}</span><span class="q-tx">${label}</span>`);
      button.type = "button"; button.dataset.kind = kind;
      button.setAttribute("aria-label", kind === "back" ? `뒤로 · ${parentName()}` : "이미지 글자 번역");
      button.addEventListener("click", () => act(kind));
      return button;
    }
    const TRANSLATE = '<span class="glyph" aria-hidden="true">文<i>→</i>가</span>';

    function renderSecondary() {
      // 임시저장 never has its own button: it is the centre's action at the top level.
      if (opts.variant === "v1") {
        // A slim glass row under the fan: 뒤로 (inside a folder) nearest the screen edge, 번역 farther.
        const bar = el("div", "am-bar");
        bar.append(quiet("translate", TRANSLATE, "번역", "am-act"));
        if (canBack()) bar.append(quiet("back", svg(ICON.up), "뒤로", "am-act"));
        root.append(bar);
      } else if (opts.variant === "v2") {
        // 뒤로 as a small tab on the disc's top rim (inside a folder), 번역 a round satellite
        // in the far corner outside the fan.
        if (canBack()) root.append(quiet("back", svg(ICON.up), "뒤로", "am-tab"));
        root.append(quiet("translate", TRANSLATE, "번역", "am-sat translate"));
      } else {
        // v3: 뒤로 is the crumb above the fan; 번역 the one satellite in the far corner.
        root.append(quiet("translate", TRANSLATE, "번역", "am-sat translate"));
      }
    }

    function consumeSuppressed(event) {
      if (!open) return true;
      if (suppressClick) { suppressClick = false; event?.preventDefault(); return true; }
      return false;
    }

    function choose(item, event) {
      if (!open || consumeSuppressed(event)) return;
      const now = performance.now();
      const doubleTap = lastTap?.id === item.id && now - lastTap.at <= 350;
      lastTap = { id: item.id, at: now };
      top().selectedId = item.id;
      if (doubleTap) {
        lastTap = null;
        if (item.children?.length) {
          history.push({ id: item.id, selectedId: item.id });
          render(true); opts.onAction("open", { name: item.name }); return;
        }
        act("save"); return;
      }
      render();
      opts.onAction("select", { name: item.name, branch: Boolean(item.children?.length) });
    }

    function act(kind) {
      if (!open) return;
      if (kind === "save") {
        const dest = destination();
        if (!dest) { opts.onAction("save-none"); return; }
        close(); opts.onAction("save", { name: dest.name, path: pathOf(dest.id).map(x => x.name) }); return;
      }
      if (kind === "back") {
        if (!canBack()) { opts.onAction("back-none"); return; }
        const from = byId.get(top().id).name;
        history.pop(); render(true);
        opts.onAction("back", { from, to: history.length > 1 ? byId.get(top().id).name : "맨 위" }); return;
      }
      if (kind === "temporary") { close(); opts.onAction("temporary"); return; }
      if (kind === "translate") { close(); opts.onAction("translate"); }
    }

    // ---- Centre drag (all variants): up = 뒤로, down = 임시저장, commit at 48 px.
    function bindCenterDrag(center) {
      center.addEventListener("pointerdown", event => {
        if (!open || event.button > 0 || commitTimer) return;
        drag = { id: event.pointerId, x: event.clientX, y: event.clientY, axis: null, dy: 0 };
      });
      center.addEventListener("pointermove", event => {
        if (drag?.id !== event.pointerId) return;
        const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
        if (!drag.axis && Math.hypot(dx, dy) >= SLOP) {
          drag.axis = Math.abs(dy) > Math.abs(dx) ? "vertical" : "cancelled"; lastTap = null;
          try { center.setPointerCapture(event.pointerId); } catch {}
        }
        if (drag.axis === "vertical") { drag.dy = dy; preview(center, dy); }
      });
      const finish = (event, cancelled) => {
        if (drag?.id !== event.pointerId) return;
        const moved = Boolean(drag.axis), dy = drag.dy; drag = null;
        try { center.releasePointerCapture(event.pointerId); } catch {}
        if (moved) { suppressClick = true; setTimeout(() => { suppressClick = false; }, 0); }
        const action = !cancelled && moved && Math.abs(dy) >= COMMIT ? dragAction(dy) : null;
        if (!action) { preview(center, 0, true); if (moved && !cancelled) opts.onAction("drag-short", { dy }); return; }
        preview(center, dy < 0 ? -COMMIT : COMMIT);
        if (calm()) opts.onAction("swipe", { action });
        commitTimer = setTimeout(() => {
          commitTimer = null;
          opts.onAction("drag", { action });
          act(action);
          if (open) preview(root.querySelector(".am-center"), 0, true);
        }, HOLD_MS);
      };
      center.addEventListener("pointerup", event => finish(event, false));
      center.addEventListener("pointercancel", event => finish(event, true));
    }

    // Today: up = 뒤로, down = 임시저장. Calm: down only, meaning depends on depth.
    function dragAction(dy) {
      if (calm()) return dy > 0 ? swipeAction() : null;
      return dy < 0 ? (canBack() ? "back" : null) : "temporary";
    }
    function preview(center, dy, animate = false) {
      if (!center) return;
      const direction = dy < 0 ? -1 : 1;
      const supported = Boolean(dragAction(direction * COMMIT));
      const progress = supported ? Math.min(1, Math.abs(dy) / COMMIT) : 0;
      if (!calm()) {
        const face = center.querySelector(".am-face"), main = center.querySelector(".am-icon.main"), prev = center.querySelector(".am-icon.preview");
        const slide = reduced() ? 0 : 24, hidden = (1 - progress) * 100;
        const time = animate && !reduced() ? "150ms" : "0ms";
        for (const node of [face, main, prev]) node.style.transition = `clip-path ${time} ease-out, transform ${time} ease-out, opacity ${time} ease-out`;
        face.style.background = direction > 0 ? "#2f7d5b" : "#39495f";
        prev.querySelector("path").setAttribute("d", direction > 0 ? ICON.download : ICON.back);
        face.style.clipPath = direction > 0 ? `inset(${hidden}% 0 0 0)` : `inset(0 0 ${hidden}% 0)`;
        main.style.transform = `translateY(${-direction * slide * progress}px)`; main.style.opacity = String(1 - progress);
        prev.style.transform = `translateY(${direction * slide * (1 - progress)}px)`; prev.style.opacity = String(progress);
        return;
      }
      // Calm: the disc's small line names what letting go will do; nothing else lights up.
      const disc = center.querySelector(".am-disc"), meta = disc.querySelector(".d-meta");
      disc.classList.toggle("animating", animate && !reduced());
      disc.style.setProperty("--p", progress.toFixed(3));
      disc.style.setProperty("--shift", `${reduced() ? 0 : direction * progress * 6}px`);
      disc.classList.toggle("armed", progress >= 1);
      meta.textContent = progress > .25 ? (swipeAction() === "back" ? "놓으면 뒤로" : "놓으면 임시저장") : discMeta();
    }

    function close() {
      if (!open) return;
      open = false;
      if (reduced()) { root.classList.add("closed"); return; }
      root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 100, easing: "linear" }).onfinish = () => { if (!open) root.classList.add("closed"); };
    }
    function show() {
      reset(); open = true; render();
      if (!reduced()) root.animate([{ opacity: 0, transform: `translateX(${opts.side === "right" ? 8 : -8}px)` }, { opacity: 1, transform: "translateX(0)" }], { duration: 140, easing: "cubic-bezier(.2,0,0,1)" });
    }

    root.addEventListener("keydown", event => {
      if (!open) return;
      if (event.key === "Backspace") { event.preventDefault(); act("back"); }
      if (event.key === "t" || event.key === "T") { event.preventDefault(); act("temporary"); }
    });

    reset(); render();
    return {
      root,
      get open() { return open; },
      show, close,
      set(next) { Object.assign(opts, next); if (open) render(); },
      previewDrag(dy) { preview(root.querySelector(".am-center"), dy); },
      choosePath(ids) { history = [{ id: null, selectedId: ids[0] }]; for (let i = 0; i < ids.length - 1; i++) history.push({ id: ids[i], selectedId: ids[i + 1] }); render(); },
    };
  }

  globalThis.MockArc = { create, ICON, svg };
})();
