import { packPanels, spokeHits } from "./printAssets";
import type { PackCover } from "./types";

const cache = new Map<string, Promise<string>>();
const hues = ["#d8452e", "#2f6fd0", "#7b3fc6", "#e3a01c", "#1f977a", "#cf3a86", "#3550c4"];
function load(src: string): Promise<HTMLImageElement | null> {
  return new Promise(resolve => {
    const image = new Image();
    const timer = setTimeout(() => resolve(null), 1800);
    image.onload = () => { clearTimeout(timer); resolve(image); };
    image.onerror = () => { clearTimeout(timer); resolve(null); };
    image.src = src;
  });
}
function cover(context: CanvasRenderingContext2D, image: HTMLImageElement, x: number, y: number, w: number, h: number) {
  const scale = Math.max(w / image.width, h / image.height);
  context.drawImage(image, x + (w - image.width * scale) / 2, y + (h - image.height * scale) * .3, image.width * scale, image.height * scale);
}

/** Composite once; the wrapper's three print copies share one decoded bitmap. */
export function composePackCover(art: PackCover) {
  const urls = art.imageUrls.slice(0, 7);
  const key = JSON.stringify([urls, art.centreCutoutUrl]);
  if (cache.has(key)) return cache.get(key)!;
  const job = (async () => {
    const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 973;
    const c = canvas.getContext("2d");
    if (!c) return "";
    const images = await Promise.all(urls.map(load));
    packPanels.forEach((panel, index) => {
      c.save();
      const points = [...panel.clip.matchAll(/([\d.-]+)% ([\d.-]+)%/g)];
      c.beginPath(); points.forEach((point, i) => { const x = Number(point[1]) * 6.4, y = Number(point[2]) * 9.73; if (i) c.lineTo(x, y); else c.moveTo(x, y); }); c.closePath(); c.clip();
      const [x, y, w, h] = panel.box.map((value, i) => value * (i % 2 ? 9.73 : 6.4));
      c.fillStyle = hues[index]; c.fillRect(0, 0, 640, 973);
      const image = images.length ? images[index % images.length] : null;
      if (image) cover(c, image, x, y, w, h);
      else {
        c.fillStyle = c.strokeStyle = "rgba(255,255,255,.16)";
        if (index % 4 === 0) for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 20) {
          c.beginPath(); c.moveTo(48 * 6.4, 66 * 6.4); c.lineTo(48 * 6.4 + 2000 * Math.cos(angle), 66 * 6.4 + 2000 * Math.sin(angle)); c.lineTo(48 * 6.4 + 2000 * Math.cos(angle + Math.PI / 60), 66 * 6.4 + 2000 * Math.sin(angle + Math.PI / 60)); c.fill();
        }
        else if (index % 4 === 1) for (let py = y; py < y + h; py += 19) for (let px = x; px < x + w; px += 19) { c.beginPath(); c.arc(px, py, 3, 0, Math.PI * 2); c.fill(); }
        else if (index % 4 === 2) for (let py = y; py < y + h; py += 70) for (let px = x; px < x + w; px += 70) { c.fillRect(px + 8, py + 10, 6, 30); c.fillRect(px + 20, py + 4, 6, 40); c.fillRect(px + 32, py + 10, 6, 30); }
        else { c.lineWidth = 6; for (let line = -973; line < 1613; line += 19) { c.beginPath(); c.moveTo(line, 0); c.lineTo(line - 973, 973); c.stroke(); } }
      }
      c.globalCompositeOperation = "soft-light"; c.globalAlpha = .55; c.fillStyle = hues[index]; c.fillRect(0, 0, 640, 973);
      c.globalCompositeOperation = "source-over"; c.globalAlpha = 1;
      const highlight = c.createRadialGradient(panel.mid[0] * 6.4, panel.mid[1] * 9.73, 0, panel.mid[0] * 6.4, panel.mid[1] * 9.73, Math.max(w, h) * .6);
      highlight.addColorStop(0, "rgba(255,255,255,.2)"); highlight.addColorStop(1, "transparent"); c.fillStyle = highlight; c.fillRect(x, y, w, h);
      const shadow = c.createLinearGradient(0, y, 0, y + h); shadow.addColorStop(.5, "transparent"); shadow.addColorStop(1, "rgba(5,8,30,.35)"); c.fillStyle = shadow; c.fillRect(x, y, w, h); c.restore();
    });
    spokeHits.forEach(([x, y]) => { ([ [13, "#070a24"], [4, "#e9f0ff"] ] as const).forEach(([width, color]) => { c.lineWidth = width; c.strokeStyle = color; c.beginPath(); c.moveTo(48 * 6.4, 66 * 6.4); c.lineTo(x * 6.4, y * 6.4); c.stroke(); }); });
    if (art.centreCutoutUrl) {
      const hero = await load(art.centreCutoutUrl);
      if (hero) { const width = 78 * 6.4; c.save(); c.shadowColor = "#a9c9ff"; c.shadowBlur = 14; c.drawImage(hero, (48 - 39) * 6.4, 24 * 6.4, width, width * hero.height / hero.width); c.restore(); }
    } else if (images[0]) {
      c.save(); c.translate(48 * 6.4, 69 * 6.4); c.rotate(-6 * Math.PI / 180);
      c.fillStyle = "#f6f1e4"; c.fillRect(-200, -219, 400, 438); c.strokeStyle = "#d6ac4e"; c.lineWidth = 4; c.strokeRect(-204, -223, 408, 446);
      c.beginPath(); c.rect(-192, -211, 384, 422); c.clip(); cover(c, images[0], -192, -211, 384, 422); c.restore();
    }
    c.globalCompositeOperation = "destination-in";
    const fade = c.createLinearGradient(0, 0, 0, 973); fade.addColorStop(0, "#000"); fade.addColorStop(.78, "#000"); fade.addColorStop(.99, "transparent"); c.fillStyle = fade; c.fillRect(0, 0, 640, 973);
    try { const url = canvas.toDataURL("image/webp", .9); await load(url); return url; } catch { return ""; }
  })();
  if (cache.size >= 12) cache.delete(cache.keys().next().value!);
  cache.set(key, job); return job;
}
