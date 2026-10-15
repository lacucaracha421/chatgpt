import { useEffect, useRef } from "react";
import type { CardTier } from "./types";

const specs = {
  sr: { duration: 620, rays: 0, sparks: 16, shards: 0, rings: 1, colors: ["#dfe8ff", "#9fb4ff"] },
  ssr: { duration: 800, rays: 14, sparks: 30, shards: 0, rings: 1, colors: ["#c9bbff", "#8a6cff"] },
  ur: { duration: 900, rays: 18, sparks: 46, shards: 14, rings: 1, colors: ["#ffe3a0", "#ffb21e"] },
  lr: { duration: 1000, rays: 26, sparks: 72, shards: 20, rings: 2, colors: ["#fff3cf", "#ffcf5a", "#ffb3d0", "#b8f0ff", "#d6c2ff"] },
};

/** Two local canvases: bloom/rays behind the card, rings/sparks/foil above it. Sized from layout (not the on-screen rect) so a card that is mid-transform still gets its own centre. */
export function RevealEffects({ tier, reduced }: { tier: CardTier; reduced: boolean }) {
  const under = useRef<HTMLCanvasElement>(null), over = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (reduced || tier === "n" || tier === "r") return;
    const spec = specs[tier], u = under.current!, o = over.current!;
    const rect = { width: u.offsetWidth, height: u.offsetHeight }, dpr = Math.min(2, devicePixelRatio || 1);
    [u, o].forEach(canvas => { canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr); });
    const a = u.getContext("2d"), b = o.getContext("2d"); if (!a || !b) return;
    const w = u.width, h = u.height, cx = w / 2, cy = h / 2, radius = w * .3;
    const sparks = Array.from({ length: spec.sparks + spec.shards }, (_, i) => {
      const angle = i * 2.39996, speed = (80 + i * 37 % 180) * dpr;
      return { angle, speed, color: spec.colors[i % spec.colors.length], shard: i >= spec.sparks };
    });
    let frame = 0; const start = performance.now();
    const draw = (now: number) => {
      const t = (now - start) / spec.duration;
      a.clearRect(0, 0, w, h); b.clearRect(0, 0, w, h);
      if (t >= 1.3) return;
      const alpha = Math.max(0, Math.min(1, t / .1) * (1 - t));
      a.globalCompositeOperation = b.globalCompositeOperation = "lighter";
      a.globalAlpha = alpha * .7;
      const glow = a.createRadialGradient(cx, cy, 0, cx, cy, w * .65); glow.addColorStop(0, spec.colors[0]); glow.addColorStop(1, "transparent"); a.fillStyle = glow; a.fillRect(0, 0, w, h);
      for (let i = 0; i < spec.rays; i++) {
        const angle = i / spec.rays * Math.PI * 2 + t * .2, length = radius * (1 + t);
        a.globalAlpha = alpha * .25; a.fillStyle = spec.colors[i % spec.colors.length]; a.beginPath(); a.moveTo(cx, cy); a.lineTo(cx + Math.cos(angle - .025) * length, cy + Math.sin(angle - .025) * length); a.lineTo(cx + Math.cos(angle + .025) * length, cy + Math.sin(angle + .025) * length); a.fill();
      }
      for (let i = 0; i < spec.rings; i++) {
        const p = Math.max(0, Math.min(1, (t - i * .12) / .6));
        b.globalAlpha = (1 - p) * .7; b.strokeStyle = spec.colors[i]; b.lineWidth = (4 - 3 * p) * dpr; b.beginPath(); b.ellipse(cx, cy, radius * (.55 + 1.3 * (1 - (1 - p) ** 3)), radius * (.55 + 1.3 * (1 - (1 - p) ** 3)) * .92, 0, 0, Math.PI * 2); b.stroke();
      }
      sparks.forEach((spark, i) => {
        const seconds = t * spec.duration / 1000, x = cx + Math.cos(spark.angle) * (radius * .55 + spark.speed * seconds), y = cy + Math.sin(spark.angle) * (radius * .7 + spark.speed * seconds) + 160 * dpr * seconds ** 2;
        b.globalAlpha = Math.max(0, 1 - t); b.fillStyle = b.strokeStyle = spark.color;
        if (spark.shard) { b.save(); b.translate(x, y); b.rotate(spark.angle + seconds * 7); b.scale(1, .35 + .65 * Math.abs(Math.cos(seconds * 7))); b.fillRect(-4 * dpr, -2 * dpr, 8 * dpr, 4 * dpr); b.restore(); }
        else { b.lineWidth = (1.2 + i % 3 * .5) * dpr; b.beginPath(); b.moveTo(x, y); b.lineTo(x - Math.cos(spark.angle) * 9 * dpr, y - Math.sin(spark.angle) * 9 * dpr); b.stroke(); }
      });
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw); return () => cancelAnimationFrame(frame);
  }, [tier, reduced]);
  if (reduced || tier === "n" || tier === "r") return null;
  return <><canvas ref={under} className="card-reveal-fx card-reveal-fx--under" aria-hidden="true" /><canvas ref={over} className="card-reveal-fx card-reveal-fx--over" aria-hidden="true" /></>;
}
