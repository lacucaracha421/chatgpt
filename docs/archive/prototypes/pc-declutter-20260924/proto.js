// Static prototype helpers: icons, screen switching, placeholder art. No network, no build.
const ICONS = {
  stack: '<rect x="4" y="8" width="16" height="12"/><path d="M6.5 5h11M9 2.5h6"/>',
  book: '<path d="M4 5h5.5A2.5 2.5 0 0112 7.5V20a2 2 0 00-2-2H4zM20 5h-5.5A2.5 2.5 0 0012 7.5V20a2 2 0 012-2h6z"/>',
  photo: '<rect x="3.5" y="5" width="17" height="14"/><path d="M3.5 16l5-5 4 4 3-3 5 5"/><circle cx="15.5" cy="9" r="1.3"/>',
  calendar: '<rect x="4" y="5.5" width="16" height="14"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
  note: '<path d="M6 3.5h9l4 4v13H6z"/><path d="M14.5 3.5V8H19M9 12.5h7M9 16h5"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10"/><path d="M8 10.5V8a4 4 0 018 0v2.5"/>',
  dots: '<path d="M5.5 12h.01M12 12h.01M18.5 12h.01" stroke-width="2.6" stroke-linecap="round"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5.5 5.5"/>',
  adjust: '<path d="M4 7h9M18 7h2M4 17h3M11 17h9"/><rect x="13" y="5" width="4" height="4"/><rect x="7" y="15" width="4" height="4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  folder: '<path d="M3.5 6h6l2 2h9v11h-17z"/>',
  star: '<path d="M12 4l2.4 5 5.4.6-4 3.7 1.1 5.4L12 16l-4.9 2.7 1.1-5.4-4-3.7 5.4-.6z"/>',
  inbox: '<path d="M3.5 13.5h5l1.5 2.5h4l1.5-2.5h5"/><path d="M5.5 5h13l2 8.5V19h-17v-5.5z"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>',
  cog: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
  home: '<path d="M4 11l8-6.5 8 6.5V20h-5.5v-5.5h-5V20H4z"/>',
  chev: '<path d="M9 5l7 7-7 7"/>',
  chevdown: '<path d="M5 9l7 7 7-7"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  min: '<path d="M5 12h14"/>',
  max: '<rect x="5.5" y="5.5" width="13" height="13"/>',
  activity: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
  users: '<circle cx="9" cy="8.5" r="3.5"/><path d="M3 20c0-3.5 2.7-6 6-6s6 2.5 6 6M16 5.2a3.5 3.5 0 010 6.6M18 14.3c1.8.9 3 2.9 3 5.7"/>',
  cloud: '<path d="M7 18.5h10.5a4 4 0 00.5-8 6 6 0 00-11.5 1.5A3.3 3.3 0 007 18.5z"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0112 0v5.5l1.5 2h-15zM10 20.5h4"/>',
  heart: '<path d="M12 19.5s-7.5-4.6-7.5-10A4.2 4.2 0 0112 7a4.2 4.2 0 017.5 2.5c0 5.4-7.5 10-7.5 10z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  similar: '<rect x="3.5" y="7.5" width="10" height="10"/><rect x="10.5" y="4.5" width="10" height="10"/>',
  album: '<rect x="4" y="4" width="16" height="16"/><path d="M4 9h16"/>',
  chart: '<path d="M4 20h16M7 16v-5M12 16V7M17 16v-8"/>',
  import: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M4.5 19.5h15"/>',
  feather: '<path d="M19.5 4.5C11 4.5 6.5 9 6.5 18M6.5 18l-2.5 2.5M6.5 18c5 0 9-2.5 10.5-7.5"/>',
  sparkle: '<path d="M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2L5 10.5l5.2-1.8zM18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  link: '<path d="M10 14l4-4M8.5 11.5L6 14a3 3 0 004 4l2.5-2.5M15.5 12.5L18 10a3 3 0 00-4-4l-2.5 2.5"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.5v.5"/>',
  wrench: '<path d="M14.5 4.5a4 4 0 00-4.9 5.3L4 15.4 6.6 18l5.6-5.6a4 4 0 005.3-4.9l-2.4 2.4-2.1-.5-.5-2.1z"/>',
  play: '<path d="M8 5.5v13l10-6.5z"/>',
  arrowr: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  pause: '<path d="M9 5.5v13M15 5.5v13"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
};
function icon(name, cls = "") { return `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ""}</svg>`; }
function hydrateIcons(root = document) {
  root.querySelectorAll("i[data-i]").forEach((el) => { el.outerHTML = icon(el.dataset.i, el.className); });
}
const WINCTL = `<div class="winctl"><span>${icon("min")}</span><span>${icon("max")}</span><span>${icon("x")}</span></div>`;

function rng(seed) { let s = Math.imul(seed + 0x9e37, 2654435761) >>> 0; s = (s ^ (s >>> 15)) >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const HUES = [[212, 34], [18, 42], [336, 30], [168, 26], [42, 48], [262, 26], [196, 40], [6, 36], [120, 18], [228, 20], [30, 22], [290, 18]];
// Placeholder "artwork": layered gradients suggesting a figure + backdrop. No real imagery.
function artBg(r) {
  const [h, s] = HUES[Math.floor(r() * HUES.length)];
  const h2 = (h + 20 + r() * 60) % 360;
  const l1 = 18 + r() * 30, l2 = 38 + r() * 34;
  const fx = 30 + r() * 40, fy = 45 + r() * 25;
  return `radial-gradient(ellipse 34% 42% at ${fx}% ${fy + 20}%, hsla(${h2},${s + 10}%,${Math.min(l2 + 18, 86)}%,.85), transparent 70%),`
    + `radial-gradient(circle at ${fx}% ${fy - 16}%, hsla(${(h2 + 12) % 360},${s}%,${Math.min(l2 + 24, 90)}%,.3) 0 8%, transparent 9%),`
    + `radial-gradient(circle at ${r() * 100}% ${r() * 40}%, hsla(${(h + 40) % 360},${s + 20}%,70%,.35), transparent 45%),`
    + `linear-gradient(${140 + r() * 60}deg, hsl(${h},${s}%,${l1}%), hsl(${h2},${s - 6}%,${l2}%))`;
}
const ARTISTS = ["mori_haru", "kiyo.png", "Aoi Sera", "rin_0412", "nabe", "Tsubaki", "hoshino.k", "yuu__", "PAPERMOON", "sakuya_m", "Lumi", "okami_t", "sio", "Kanade", "tt_ren", "harune"];
const RATIOS = [0.66, 0.7, 0.75, 0.8, 1, 1.33, 0.56, 0.72, 1.5, 0.62];

// Build date-grouped masonry. groups: [{date, day, count, cols}], colWidth px.
function masonry(el, { seed = 1, colWidth = 200, groups, selected = [] }) {
  const r = rng(seed); let idx = 0; let html = "";
  const rows = []; let row = []; let used = 0; const maxCols = groups.maxCols || 6;
  for (const g of groups.list) { if (used + g.cols > maxCols) { rows.push(row); row = []; used = 0; } row.push(g); used += g.cols; if (g.cols >= maxCols) { rows.push(row); row = []; used = 0; } }
  if (row.length) rows.push(row);
  for (const rw of rows) {
    html += '<div class="date-row">';
    for (const g of rw) {
      const cols = Array.from({ length: g.cols }, () => ({ h: 0, items: [] }));
      for (let k = 0; k < g.count; k++) {
        const ratio = RATIOS[Math.floor(r() * RATIOS.length)];
        const h = Math.round(colWidth / ratio);
        const c = cols.reduce((a, b) => (b.h < a.h ? b : a));
        const sel = selected.includes(idx);
        const hh = String(Math.floor(r() * 24)).padStart(2, "0"), mm = String(Math.floor(r() * 60)).padStart(2, "0");
        c.items.push(`<div class="tile" style="width:${colWidth}px"><div class="art${sel ? " sel" : ""}" style="height:${h}px;background:${artBg(r)}"></div><div class="cap"><span class="who">${ARTISTS[Math.floor(r() * ARTISTS.length)]}</span><span class="t">${hh}:${mm}</span></div></div>`);
        c.h += h + 35; idx++;
      }
      const w = g.cols * colWidth + (g.cols - 1) * 20;
      html += `<section class="group" style="width:${w}px"><h3>${g.date}<small>${g.day}</small><span class="rule"></span><small class="num">${g.count}</small></h3><div class="cols">${cols.map((c) => `<div class="col">${c.items.join("")}</div>`).join("")}</div></section>`;
    }
    html += "</div>";
  }
  el.innerHTML = html;
}
function artDiv(seed, w, h, extra = "") { const r = rng(seed); return `<div class="art" style="width:${w};height:${h};background:${artBg(r)};${extra}"></div>`; }
function fillArt(root = document) { root.querySelectorAll("[data-art]").forEach((el) => { el.style.background = artBg(rng(Number(el.dataset.art))); }); }

function showScreen() {
  const id = (location.hash || "").slice(1);
  const screens = [...document.querySelectorAll(".screen")];
  const target = screens.find((s) => s.id === id) || screens[0];
  screens.forEach((s) => s.classList.toggle("on", s === target));
}
window.addEventListener("hashchange", showScreen);
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("[data-winctl]").forEach((el) => { el.outerHTML = WINCTL; });
  if (window.build) window.build();
  hydrateIcons(); fillArt(); showScreen();
});
