(() => {
  "use strict";
  const { ICON, svg } = MockArc;
  const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const el = (tag, className, html) => { const node = document.createElement(tag); if (className) node.className = className; if (html != null) node.innerHTML = html; return node; };
  const TOAST_ICON = {
    success: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    info: '<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>',
    temp: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19h14"/></svg>',
    warn: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 8v5M12 16.2v.1"/></svg>',
  };
  const POP_ICON = {
    close: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
    copy: '<svg viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1"/><path d="M3 10.5V3.5a.5.5 0 0 1 .5-.5h7"/></svg>',
    download: '<svg viewBox="0 0 16 16"><path d="M8 2.5v7M5 6.8L8 9.8l3-3M3 12.5h10"/></svg>',
  };
  const ACT = {
    reply: '<svg viewBox="0 0 24 24"><path d="M4 11a7 7 0 0 1 7-7h2a7 7 0 0 1 0 14h-1l-5 3v-4a7 7 0 0 1-3-6z"/></svg>',
    repost: '<svg viewBox="0 0 24 24"><path d="M7 7h9a3 3 0 0 1 3 3v6M4 10l3-3 3 3M17 17H8a3 3 0 0 1-3-3V8M20 14l-3 3-3-3"/></svg>',
    like: '<svg viewBox="0 0 24 24"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>',
    views: '<svg viewBox="0 0 24 24"><path d="M5 20V12M10 20V6M15 20v-9M20 20V9"/></svg>',
    share: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7.5 8.5L12 4l4.5 4.5M5 14v5h14v-5"/></svg>',
  };

  // ---------- shared bits ----------
  function toast(frame, kind, text) {
    const host = frame.querySelector(".toasts");
    const node = el("div", `toast ${kind === "temp" ? "success" : kind}`, `${TOAST_ICON[kind] || ""}<span>${text}</span>`);
    host.append(node);
    while (host.children.length > 2) host.firstElementChild.remove();
    if (!reduced()) node.animate([{ opacity: 0, transform: "translateY(-4px)" }, { opacity: 1, transform: "none" }], { duration: 140, easing: "cubic-bezier(.2,0,0,1)" });
    setTimeout(() => {
      if (reduced()) { node.remove(); return; }
      node.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160 }).onfinish = () => node.remove();
    }, 2000);
  }

  function xcard({ art, text = "새 만화 1페이지입니다 #創作漫画", name = "견본 작가", handle = "@sample_artist", time = "3시간", light = false, two = null, alt = false, saved = false, avatar = "" }) {
    const card = el("article", `xcard${light ? " light" : ""}`);
    card.append(el("div", `xav ${avatar}`));
    const main = el("div");
    main.append(el("div", "xhead", `<b>${name}</b><span>${handle} · ${time}</span>`));
    main.append(el("div", "xtext", text));
    const media = el("div", `xmedia${two ? " two" : ""}`);
    const images = [];
    for (const [index, item] of (two || [art]).entries()) {
      const box = el("div", "ximg", item.svg);
      box.style.aspectRatio = `${item.w} / ${item.h}`;
      box.art = item;
      box.append(el("div", "marks"));
      if (alt && index === 0) box.append(el("span", "alt-badge", "ALT"));
      if (saved && index === (two ? 1 : 0)) box.append(el("span", "saved-badge", "✓"));
      media.append(box); images.push(box);
    }
    main.append(media);
    main.append(el("div", "xacts", `<span>${ACT.reply}12</span><span>${ACT.repost}48</span><span>${ACT.like}1,204</span><span>${ACT.views}3.1만</span><span>${ACT.share}</span>`));
    card.append(main);
    return { card, images };
  }

  // Translation popover in the style of context-menu/menu.css (dark).
  function showTranslation(frame, image, { onSave, onClose, inline = false } = {}) {
    closeTranslation(frame);
    const art = image.art;
    const pop = el("div", `pop${inline ? " inline" : ""}`);
    pop.setAttribute("role", "dialog"); pop.setAttribute("aria-label", "이미지 글자 번역");
    const head = el("div", "h", `<span>이미지 글자 번역</span><span class="sp"></span>`);
    const x = el("button", "x", POP_ICON.close); x.type = "button"; x.setAttribute("aria-label", "닫기");
    x.addEventListener("click", event => { event.stopPropagation(); closeTranslation(frame); onClose?.(); });
    head.append(x);
    const body = el("div", "body");
    for (const width of ["70%", "90%", "55%"]) { const bar = el("span", "sk"); bar.style.width = width; body.append(bar); }
    pop.append(head, body);
    frame.append(pop);
    frame.classList.add("pop-open");
    if (!reduced()) pop.animate([{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], { duration: 120, easing: "cubic-bezier(.2,0,0,1)" });
    pop.timer = setTimeout(() => {
      const before = body.getBoundingClientRect().height;
      body.replaceChildren();
      const list = el("ol");
      art.lines.forEach((line, index) => list.append(el("li", "", `<span class="ln">${index + 1}</span><b lang="ko">${line.korean}</b><small lang="ja">${line.original}</small>`)));
      if (!art.lines.length) list.append(el("li", "", "<b>글자 없음</b>"));
      body.append(list);
      const foot = el("div", "f");
      const copy = el("button", "", `${POP_ICON.copy}<span>모두 복사</span>`); copy.type = "button";
      copy.addEventListener("click", event => { event.stopPropagation(); copy.querySelector("span").textContent = "복사됨"; setTimeout(() => { copy.querySelector("span").textContent = "모두 복사"; }, 1600); });
      foot.append(copy);
      if (onSave) {
        const save = el("button", "", `${POP_ICON.download}<span>저장</span>`); save.type = "button";
        save.addEventListener("click", event => { event.stopPropagation(); closeTranslation(frame); onSave(); });
        foot.append(save);
      }
      body.append(foot);
      const after = body.getBoundingClientRect().height;
      if (!reduced() && before && after) body.animate([{ height: `${before}px` }, { height: `${after}px` }], { duration: 140, easing: "cubic-bezier(.2,0,0,1)" });
      const marks = image.querySelector(".marks");
      marks.replaceChildren(...art.lines.map((line, index) => { const m = el("span", "mark", String(index + 1)); m.style.left = `${line.x}%`; m.style.top = `${line.y}%`; return m; }));
      if (!reduced()) marks.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120 });
    }, frame.dataset.instant ? 0 : 900);
    pop.image = image;
  }
  function closeTranslation(frame) {
    const pop = frame.querySelector(".pop");
    if (!pop) return;
    clearTimeout(pop.timer);
    pop.image?.querySelector(".marks")?.replaceChildren();
    pop.remove(); frame.classList.remove("pop-open");
  }

  // ---------- menu frame ----------
  function menuFrame(frame, options, log) {
    frame.replaceChildren();
    const stage = el("div", "stage");
    const page = el("div", `xpage`);
    const art = MockArt.manga();
    const { card, images } = xcard({ art, alt: false });
    page.append(card);
    stage.append(page);
    frame.append(stage, el("div", "dim"), el("div", "toasts"), el("div", "hint", "이미지를 누르면 메뉴가 다시 열려요"));
    const arc = MockArc.create(frame, { ...options, onAction: (type, detail) => handle(type, detail) });
    const sync = () => { frame.classList.toggle("menu-open", arc.open); frame.classList.toggle("idle", !arc.open && !frame.classList.contains("pop-open")); };
    function handle(type, detail = {}) {
      const say = text => log?.(text);
      switch (type) {
        case "select": say(`${detail.name} 고름${detail.branch ? " (두 번 누르면 열림)" : ""}`); break;
        case "open": say(`${detail.name} 열기`); break;
        case "save": toast(frame, "success", `저장 · ${detail.path.join(" › ")}`); say(`저장 → ${detail.path.join(" › ")}`); break;
        case "save-none": toast(frame, "warn", "먼저 폴더를 고르세요"); say("여기 저장: 고른 폴더가 없어 아무 일 없음"); break;
        case "back": toast(frame, "info", `뒤로 · ${detail.from} → ${detail.to}`); say(`뒤로: ${detail.from} → ${detail.to}`); break;
        case "back-none": toast(frame, "warn", "맨 위라서 뒤로 갈 곳이 없어요"); say("뒤로: 맨 위라서 없음"); break;
        case "temporary": toast(frame, "temp", "임시 다운로드 시작됨"); say("임시저장 (분류 없이 다운로드)"); break;
        case "translate": say("번역: 메뉴 닫고 번역 창 열기"); showTranslation(frame, images[0], { onSave: () => { arc.show(); say("번역 창의 저장 → 메뉴 다시 열림"); sync(); }, onClose: sync }); break;
        case "drag": say(`끌기 → ${detail.action === "back" ? "뒤로" : "임시저장"}`); break;
        case "swipe": break;
        case "drag-short": say(detail.dy < 0 ? "위로 밀기 — 아무 동작 없음 (아래로만 밉니다)" : `아래로 ${Math.round(detail.dy)}px — 48px 전이라 취소`); break;
      }
      sync();
    }
    frame.onclick = event => {
      // The path is fixed at dispatch, so it still holds the menu after a re-render detached the target.
      if (event.composedPath().some(node => node.classList?.contains("am") || node.classList?.contains("pop"))) return;
      if (arc.open) { arc.close(); log?.("바깥을 눌러 닫음"); }
      else if (event.composedPath().some(node => node.classList?.contains("ximg"))) { closeTranslation(frame); arc.show(); log?.("이미지 길게 누르기 → 메뉴 열림"); }
      sync();
    };
    sync();
    return { arc, images, sync, handle };
  }

  // ---------- Section A ----------
  const preset = { initialRoot: "illust", initial: [{ id: "illust", selectedId: "genshin" }] };
  menuFrame(document.getElementById("a-now-tab"), { variant: "current", R: 208, touch: true, ...preset });
  menuFrame(document.getElementById("a-new-tab"), { variant: "v3", R: 208, touch: true, ...preset });
  menuFrame(document.getElementById("a-now-pc"), { variant: "current", R: 200, touch: false, ...preset });
  menuFrame(document.getElementById("a-new-pc"), { variant: "v3", R: 200, touch: false, ...preset });

  // ---------- Section B ----------
  const bFrame = document.getElementById("b-frame"), bLog = document.getElementById("b-log");
  const bState = { variant: "v3", device: "tablet", side: "right" };
  let started = performance.now(), bCtx;
  function log(text) {
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    const item = el("li", "", `<span class="t">${seconds}s</span>${text}`);
    bLog.prepend(item);
    while (bLog.children.length > 8) bLog.lastElementChild.remove();
  }
  function buildB() {
    const touch = bState.device === "tablet";
    bFrame.className = `frame ${touch ? "tablet touch" : "pc"}`;
    bCtx = menuFrame(bFrame, { variant: bState.variant, R: touch ? 208 : 200, touch, side: bState.side }, log);
    for (const note of document.querySelectorAll("[data-variant-note]")) note.hidden = note.dataset.variantNote !== bState.variant;
  }
  function segment(id, key, after) {
    const group = document.getElementById(id);
    group.addEventListener("click", event => {
      const button = event.target.closest("button[data-v]"); if (!button) return;
      for (const other of group.querySelectorAll("button")) other.setAttribute("aria-pressed", String(other === button));
      bState[key] = button.dataset.v; after();
    });
  }
  segment("b-device", "device", buildB);
  segment("b-side", "side", buildB);
  segment("b-variant", "variant", buildB);
  document.getElementById("b-reset").addEventListener("click", () => { bLog.replaceChildren(); started = performance.now(); buildB(); log("처음부터 · 맨 위, 고른 폴더 없음"); });
  buildB();
  log("메뉴 열림 · 맨 위, 고른 폴더 없음");

  // ---------- Section C ----------
  const cCards = document.getElementById("c-cards"), cTiles = document.getElementById("c-tiles"), cStates = document.getElementById("c-states");
  const section = document.getElementById("c");
  function addChip(image, frameForPop) {
    const chip = el("button", "tchip", "文<i>→</i>가");
    chip.type = "button"; chip.setAttribute("aria-label", "이미지 글자 번역"); chip.setAttribute("aria-pressed", "false");
    chip.addEventListener("click", event => {
      event.stopPropagation();
      if (!frameForPop) return;
      const on = chip.getAttribute("aria-pressed") === "true";
      for (const other of frameForPop.querySelectorAll(".tchip")) other.setAttribute("aria-pressed", "false");
      if (on) { closeTranslation(frameForPop); return; }
      chip.setAttribute("aria-pressed", "true");
      showTranslation(frameForPop, image, { inline: true, onClose: () => chip.setAttribute("aria-pressed", "false") });
    });
    image.append(chip);
    return chip;
  }
  // Card 1: dark theme, two images (light manga page + dark night photo).
  const wrap1 = el("div", "col");
  wrap1.append(el("div", "frame-cap", "다크 테마 · 2장 묶음 (각 장마다 칩)"));
  const host1 = el("div", "chip-host");
  host1.style.position = "relative"; host1.style.width = "560px"; host1.style.maxWidth = "100%";
  const c1 = xcard({ two: [MockArt.manga(), MockArt.night()], text: "밤 산책 만화 + 사진 🌙", alt: true, saved: true, avatar: "b", name: "견본 계정", handle: "@night_walk", time: "10.14" });
  c1.card.classList.add("standalone");
  host1.append(c1.card, el("div", "toasts"));
  c1.images.forEach(image => addChip(image, host1));
  wrap1.append(host1);
  wrap1.append(el("ul", "points", "<li>왼쪽 아래 ALT, 오른쪽 위 저장됨(✓) 표시와 겹치지 않음</li><li>칩을 누르면 칩이 밝게 바뀌고 번역 창과 번호 표시가 뜸. 다시 누르면 닫힘</li>"));
  // Card 2: light theme, single bright image.
  const wrap2 = el("div", "col");
  wrap2.append(el("div", "frame-cap", "라이트 테마 · 1장"));
  const host2 = el("div", "chip-host");
  host2.style.position = "relative"; host2.style.width = "560px"; host2.style.maxWidth = "100%";
  const c2 = xcard({ art: MockArt.bright(), text: "신작 알림입니다!", light: true, name: "견본 서클", handle: "@sample_circle", time: "1시간" });
  c2.card.classList.add("standalone");
  host2.append(c2.card);
  c2.images.forEach(image => { image.style.aspectRatio = "auto"; image.style.height = "300px"; addChip(image, host2); });
  wrap2.append(host2);
  cCards.append(wrap1, wrap2);

  for (const [name, maker, note] of [["밝은 하늘·구름", MockArt.sky, "흰 구름 위"], ["어두운 밤", MockArt.night, "거의 검은 바탕"], ["화려한 색", MockArt.bright, "노랑·분홍 위"], ["흑백 만화", MockArt.manga, "흰 칸 + 효과음"], ["중간 회색", MockArt.grey, "대비가 가장 낮은 경우"]]) {
    const art = maker();
    const tile = el("div", "tile");
    const image = el("div", "ximg", art.svg); image.art = art;
    addChip(image, null);
    const zoom = el("div", "zoom");
    const clone = image.cloneNode(true); clone.style.width = "200px"; clone.style.height = "200px";
    zoom.append(clone);
    tile.append(image, zoom, el("div", "cap", `${name} · ${note}`));
    cTiles.append(tile);
  }
  for (const [label, setup] of [
    ["쉴 때 (86%)", () => {}],
    ["올렸을 때 / 누르는 중", chip => { chip.style.opacity = "1"; chip.style.background = "rgba(14,15,16,.74)"; }],
    ["번역 창 열림", chip => chip.setAttribute("aria-pressed", "true")],
    ["태블릿 28px + 누르는 범위", (chip, image) => { image.classList.add("touch", "show-hit"); }],
  ]) {
    const art = MockArt.sky();
    const box = el("div", "state");
    const image = el("div", "ximg", art.svg); image.art = art;
    const chip = addChip(image, null);
    setup(chip, image);
    box.append(image, el("span", "", label));
    cStates.append(box);
  }
  function cSegment(id, apply) {
    const group = document.getElementById(id);
    group.addEventListener("click", event => {
      const button = event.target.closest("button[data-v]"); if (!button) return;
      for (const other of group.querySelectorAll("button")) other.setAttribute("aria-pressed", String(other === button));
      apply(button.dataset.v);
    });
  }
  cSegment("c-mode", v => { cCards.classList.toggle("chip-hover", v === "hover"); });
  cSegment("c-size", v => { for (const host of [host1, host2]) host.classList.toggle("touch", v === "touch"); cTiles.classList.toggle("touch", v === "touch"); });
  document.getElementById("c-hit").addEventListener("change", event => { cCards.classList.toggle("show-hit", event.target.checked); cTiles.classList.toggle("show-hit", event.target.checked); });

  // ---------- presets for screenshots: #drag-temp #drag-back #translate #chip #hit #left #edge #pc ----------
  function applyHash() {
    const flags = new Set(location.hash.slice(1).split(",").filter(Boolean));
    if (!flags.size) return;
    bFrame.dataset.instant = "1"; host1.dataset.instant = "1";
    if (flags.has("hit")) {
      for (const id of ["c-hit"]) { const box = document.getElementById(id); box.checked = true; box.dispatchEvent(new Event("change")); }
    }
    if (flags.has("pc")) document.querySelector('#b-device [data-v="pc"]').click();
    if (flags.has("left")) document.querySelector('#b-side [data-v="left"]').click();
    for (const v of ["v1", "v2", "v3"]) if (flags.has(v)) document.querySelector(`#b-variant [data-v="${v}"]`).click();
    if (flags.has("deep")) bCtx.arc.choosePath(["illust", "ba"]);
    if (flags.has("pick")) bCtx.arc.choosePath(["illust"]);
    if (flags.has("drag-back")) { bCtx.arc.choosePath(["illust", "ba"]); bCtx.arc.previewDrag(40); }
    if (flags.has("drag-temp")) bCtx.arc.previewDrag(60);
    if (flags.has("translate")) { bCtx.arc.root.querySelector('[data-kind="translate"]').click(); }
    if (flags.has("chip")) c1.images[0].querySelector(".tchip").click();
    // Headless screenshots cannot scroll, so a section flag shows that section alone.
    const target = [...flags].find(flag => document.getElementById(flag));
    if (target) { document.body.classList.add("solo"); document.getElementById(target).closest(".doc > *").classList.add("solo-section"); }
  }
  applyHash();
})();
