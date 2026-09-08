type Point = { x: number; y: number; z?: number };
const MAX_WIDTH = 168;
const MAX_HEIGHT = 231;
const DEPTH = 15;
const VIEW_WIDTH = 184;
const VIEW_HEIGHT = 260;
const CASE_SCALE = 0.95;

/** One projected surface for the closed shells, seam, artwork and lip. */
export function drawGameCase(canvas: HTMLCanvasElement, image: HTMLImageElement | null, width: number, focused?: "front" | "spine" | "back") {
  // Fit the shell to the artwork, so the full cover reaches every front edge.
  const artworkRatio = image && image.naturalWidth > 0 && image.naturalHeight > 0
    ? image.naturalWidth / image.naturalHeight : MAX_WIDTH / MAX_HEIGHT;
  const WIDTH = Math.min(MAX_WIDTH, MAX_HEIGHT * artworkRatio);
  const HEIGHT = WIDTH / artworkRatio;
  const ratio = Math.min(6, Math.max(1, window.devicePixelRatio * 2 * width / VIEW_WIDTH));
  canvas.width = Math.ceil(VIEW_WIDTH * ratio);
  canvas.height = Math.ceil(VIEW_HEIGHT * ratio);
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  ctx.setTransform(canvas.width / VIEW_WIDTH, 0, 0, canvas.height / VIEW_HEIGHT, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  // Focused stops look straight at the actual selected surface. The spine image's
  // own aspect defines its width; no illustrated side is synthesized from a front.
  const rx = focused ? 0 : -8 * Math.PI / 180, ry = focused ? 0 : -26 * Math.PI / 180;
  const project = (x: number, y: number, z: number): Point => {
    x -= WIDTH / 2; y -= HEIGHT / 2;
    const tx = Math.cos(ry) * x + Math.sin(ry) * z;
    const tz = -Math.sin(ry) * x + Math.cos(ry) * z;
    const ty = Math.cos(rx) * y - Math.sin(rx) * tz;
    const depth = Math.sin(rx) * y + Math.cos(rx) * tz;
    const perspective = CASE_SCALE * 1100 / (1100 - depth);
    return { x: VIEW_WIDTH / 2 + tx * perspective, y: VIEW_HEIGHT / 2 + ty * perspective, z: depth };
  };
  const polygon = (points: Point[]) => {
    ctx.beginPath();
    points.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
    ctx.closePath();
  };
  const edge: Point[] = [];
  const radius = focused ? Math.min(6, WIDTH / 2, HEIGHT / 2) : 6;
  for (const [x, y, start] of [[WIDTH - radius, radius, -90], [WIDTH - radius, HEIGHT - radius, 0], [radius, HEIGHT - radius, 90], [radius, radius, 180]]) {
    for (let step = 0; step <= 10; step++) {
      const angle = (start + step * 9) * Math.PI / 180;
      edge.push({ x: x + radius * Math.cos(angle), y: y + radius * Math.sin(angle) });
    }
  }
  polygon(edge.map((p) => project(p.x, p.y, -DEPTH / 2)));
  ctx.fillStyle = "#343838"; ctx.fill();
  const faces: Array<{ points: Point[]; depth: number; tone: number }> = [];
  edge.forEach((a, index) => {
    const b = edge[(index + 1) % edge.length];
    const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
    if (length < 0.001) return;
    const nx = dy / length, ny = -dx / length;
    if (Math.sin(rx) * ny - Math.cos(rx) * Math.sin(ry) * nx <= 0) return;
    for (const [back, front, tone] of [[-7.5, -5.3, 91], [-5.3, -0.65, 70], [-0.65, 0.65, 18], [0.65, 5.3, 77], [5.3, 7.5, 103]]) {
      const points = [project(a.x, a.y, back), project(b.x, b.y, back), project(b.x, b.y, front), project(a.x, a.y, front)];
      faces.push({ points, depth: points.reduce((sum, p) => sum + (p.z ?? 0), 0), tone: Math.round(tone * (0.82 + 0.3 * Math.max(0, -ny) + 0.08 * Math.max(0, nx))) });
    }
  });
  faces.sort((a, b) => a.depth - b.depth).forEach(({ points, tone }) => {
    polygon(points); ctx.fillStyle = `rgb(${tone},${tone + 3},${tone + 3})`;
    ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 0.28; ctx.fill(); ctx.stroke();
  });
  // Use the standard shell while the artwork's proportions are unknown.
  if (!image) {
    polygon(edge.map((p) => project(p.x, p.y, DEPTH / 2)));
    ctx.fillStyle = "#303434"; ctx.fill();
    ctx.strokeStyle = "#bcc8c36b"; ctx.lineWidth = 0.8; ctx.stroke();
    return true;
  }
  const texture = document.createElement("canvas");
  texture.width = WIDTH * 3; texture.height = HEIGHT * 3;
  const paint = texture.getContext("2d");
  if (!paint) return false;
  paint.drawImage(image, 0, 0, texture.width, texture.height);
  ctx.save();
  polygon(edge.map((p) => project(p.x, p.y, DEPTH / 2))); ctx.clip();
  // Shared UV coordinates avoid independently antialiased CSS face edges.
  for (let row = 0; row < 7; row++) for (let column = 0; column < 5; column++) {
    const a = { x: column * WIDTH / 5, y: row * HEIGHT / 7 };
    const b = { x: (column + 1) * WIDTH / 5, y: a.y };
    const c = { x: b.x, y: (row + 1) * HEIGHT / 7 };
    const d = { x: a.x, y: c.y };
    for (const source of [[a, b, c], [a, c, d]]) {
      const target = source.map((p) => project(p.x, p.y, DEPTH / 2));
      const [s0, s1, s2] = source, [t0, t1, t2] = target;
      const det = (s1.x - s0.x) * (s2.y - s0.y) - (s2.x - s0.x) * (s1.y - s0.y);
      const aa = ((t1.x - t0.x) * (s2.y - s0.y) - (t2.x - t0.x) * (s1.y - s0.y)) / det;
      const bb = ((t1.y - t0.y) * (s2.y - s0.y) - (t2.y - t0.y) * (s1.y - s0.y)) / det;
      const cc = ((t2.x - t0.x) * (s1.x - s0.x) - (t1.x - t0.x) * (s2.x - s0.x)) / det;
      const dd = ((t2.y - t0.y) * (s1.x - s0.x) - (t1.y - t0.y) * (s2.x - s0.x)) / det;
      const center = { x: (t0.x + t1.x + t2.x) / 3, y: (t0.y + t1.y + t2.y) / 3 };
      ctx.save();
      polygon(target.map((p) => { const length = Math.hypot(p.x - center.x, p.y - center.y); return { x: p.x + (p.x - center.x) / length * 0.38, y: p.y + (p.y - center.y) / length * 0.38 }; }));
      ctx.clip(); ctx.transform(aa, bb, cc, dd, t0.x - aa * s0.x - cc * s0.y, t0.y - bb * s0.x - dd * s0.y);
      ctx.drawImage(texture, 0, 0, WIDTH, HEIGHT); ctx.restore();
    }
  }
  ctx.restore();
  polygon(edge.map((p) => project(p.x, p.y, DEPTH / 2)));
  ctx.strokeStyle = "#bcc8c36b"; ctx.lineWidth = 0.8; ctx.stroke();
  texture.width = texture.height = 0;
  return true;
}
