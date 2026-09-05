/** Disposable prototype. Pure grid simulation; no DOM, asset writes or persistence. */
export type Point = { x: number; y: number };
export type Direction = 'up' | 'down' | 'left' | 'right';
export type Phase = 'ready' | 'playing' | 'paused' | 'clear' | 'over';
export type GameEvent = { type: 'capture' | 'hit' | 'clear' | 'focus'; cells: number[]; amount: number };
export const TARGET = 80;
const vectors: Record<Direction, Point> = {
  up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 },
};

export class TerritoryGame {
  readonly cols: number;
  readonly rows: number;
  readonly safe: Uint8Array;
  player: Point;
  anchor: Point;
  enemy: Point & { vx: number; vy: number };
  rival: Point & { vx: number; vy: number };
  focus: Point;
  focusClaimed = false;
  chance = 0;
  continues = 0;
  trail: number[] = [];
  phase: Phase = 'ready';
  lives = 3;
  time = 150;
  score = 0;
  percent = 0;
  armed = false;
  immunity = 1.5;
  elapsed = 0;
  fuse = -1;
  trailAge = 0;
  spark = 0;
  events: GameEvent[] = [];
  private moveClock = 0;
  private pendingMove?: { direction: Direction; draw: boolean };
  private lastCapture = -100;
  combo = 0;

  constructor(aspect = 4 / 3, readonly stage = 0) {
    const ratio = Math.max(.35, Math.min(2.8, aspect));
    this.cols = ratio >= 1 ? 72 : Math.max(16, Math.round(64 * ratio));
    this.rows = ratio >= 1 ? Math.max(16, Math.round(72 / ratio)) : 64;
    this.safe = new Uint8Array(this.cols * this.rows);
    for (let y = 0; y < this.rows; y++) for (let x = 0; x < this.cols; x++) {
      if (x === 0 || y === 0 || x === this.cols - 1 || y === this.rows - 1) this.safe[this.index(x, y)] = 1;
    }
    this.player = { x: Math.floor(this.cols / 2), y: 0 };
    this.anchor = { ...this.player };
    this.enemy = { x: this.cols * .71, y: this.rows * .61, vx: -7.1, vy: 5.3 };
    this.rival = { x: this.cols * .27, y: this.rows * .32, vx: 4.2, vy: -4.8 };
    this.focus = { x: Math.floor(this.cols / 2), y: Math.floor(this.rows / 2) };
    this.spark = this.cols + this.rows - 2;
  }

  index(x: number, y: number) { return y * this.cols + x; }
  get enemies() { return [this.enemy, this.rival]; }
  get fuseDelay() { return Math.max(this.cols, this.rows) / 22 + .8; }
  setFocus(x: number, y: number) {
    if (this.phase !== 'ready') return;
    this.focus = { x: Math.max(2, Math.min(this.cols - 3, Math.round(x))), y: Math.max(2, Math.min(this.rows - 3, Math.round(y))) };
  }
  continue() {
    if (this.phase !== 'over') return;
    this.continues++; this.score = Math.floor(this.score / 2); this.lives = 3; this.time = 90;
    this.player = { ...this.anchor }; this.trail = []; this.trailAge = 0; this.fuse = -1;
    this.pendingMove = undefined; this.armed = false; this.chance = 2; this.immunity = 2;
    this.phase = 'playing';
  }
  point(i: number): Point { return { x: i % this.cols, y: Math.floor(i / this.cols) }; }
  get perimeter() { return 2 * (this.cols + this.rows - 2); }
  get sparkPoint(): Point {
    let n = Math.floor(this.spark) % this.perimeter;
    if (n < this.cols - 1) return { x: n, y: 0 };
    n -= this.cols - 1;
    if (n < this.rows - 1) return { x: this.cols - 1, y: n };
    n -= this.rows - 1;
    if (n < this.cols - 1) return { x: this.cols - 1 - n, y: this.rows - 1 };
    return { x: 0, y: this.rows - 1 - (n - this.cols + 1) };
  }
  start() { if (this.phase === 'ready') this.phase = 'playing'; }
  pause() {
    if (this.phase === 'playing') this.phase = 'paused';
    else if (this.phase === 'paused') this.phase = 'playing';
    this.pendingMove = undefined;
  }
  arm() { if (this.phase === 'playing' && !this.trail.length) this.armed = !this.armed; }
  /** Preserve short taps between frames; tapping cannot exceed held-key movement speed. */
  queueMove(direction: Direction, draw = false) {
    if (this.phase === 'playing') this.pendingMove = { direction, draw };
  }

  move(direction: Direction, draw = false) {
    if (this.phase !== 'playing') return;
    const v = vectors[direction];
    const next = { x: this.player.x + v.x, y: this.player.y + v.y };
    if (next.x < 0 || next.y < 0 || next.x >= this.cols || next.y >= this.rows) return;
    const id = this.index(next.x, next.y);
    if (!this.safe[id] && !this.trail.length && !draw && !this.armed) return;
    if (this.trail.includes(id)) {
      // One-cell backtracking is forgiving; crossing any older part is a short circuit.
      if (this.trail[this.trail.length - 2] === id) {
        this.trail.pop(); this.player = next; return;
      }
      this.hit(); return;
    }
    if (!this.safe[id]) {
      if (!this.trail.length) { this.anchor = { ...this.player }; this.trailAge = 0; this.fuse = -1; }
      this.trail.push(id);
    }
    this.player = next;
    if (this.safe[id] && this.trail.length) this.capture();
    this.checkCollision();
  }

  capture() {
    const before = this.safe.slice();
    for (const id of this.trail) this.safe[id] = 1;
    // Both guardians retain their components. A blind bisect can leave enemies on both sides:
    // players must carve pockets, or wait until the guardians share a region.
    const reached = new Uint8Array(this.safe.length);
    const queue = this.enemies.map(e => this.index(Math.round(e.x), Math.round(e.y)));
    if (queue.some(seed => this.safe[seed])) { this.safe.set(before); this.hit(); return; }
    for (const seed of queue) reached[seed] = 1;
    for (let head = 0; head < queue.length; head++) {
      const id = queue[head]; const { x, y } = this.point(id);
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) continue;
        const n = this.index(nx, ny);
        if (!this.safe[n] && !reached[n]) { reached[n] = 1; queue.push(n); }
      }
    }
    const cells: number[] = [];
    let count = 0;
    for (let y = 1; y < this.rows - 1; y++) for (let x = 1; x < this.cols - 1; x++) {
      const id = this.index(x, y);
      if (!reached[id]) this.safe[id] = 1;
      if (this.safe[id]) count++;
      if (this.safe[id] && !before[id]) cells.push(id);
    }
    const previous = this.percent;
    this.percent = count / ((this.cols - 2) * (this.rows - 2)) * 100;
    this.combo = this.elapsed - this.lastCapture < 9 ? Math.min(5, this.combo + 1) : 1;
    this.score += Math.round(cells.length * 10 * (1 + (this.combo - 1) * .25));
    this.lastCapture = this.elapsed;
    this.trail = []; this.armed = false; this.fuse = -1; this.trailAge = 0;
    this.events.push({ type: 'capture', cells, amount: this.percent - previous });
    // The focus is a small viewing window, not a one-cell reward for a blind straight cut.
    const focusOpen = Array.from({ length: 25 }, (_, i) => this.safe[this.index(this.focus.x + i % 5 - 2, this.focus.y + Math.floor(i / 5) - 2)]).every(Boolean);
    if (!this.focusClaimed && focusOpen) {
      this.focusClaimed = true; this.chance = 3; this.time += 10; this.score += 5000;
      this.events.push({ type: 'focus', cells: [], amount: 5000 });
    }
    if (this.percent >= TARGET) {
      this.phase = 'clear';
      this.score += Math.floor(this.time) * 100 + this.lives * 1000;
      this.events.push({ type: 'clear', cells: [], amount: this.percent });
    }
  }

  hit() {
    if (this.phase !== 'playing') return;
    this.lives--;
    this.events.push({ type: 'hit', cells: [...this.trail], amount: this.lives });
    this.player = { ...this.anchor };
    this.trail = []; this.armed = false; this.trailAge = 0; this.fuse = -1;
    this.immunity = 2; this.combo = 0;
    if (this.lives <= 0) this.phase = 'over';
  }

  private checkCollision() {
    if (this.phase !== 'playing') return;
    // Protection covers the player on safe ground, never an exposed live wire.
    if (this.trail.some(id => { const p = this.point(id); return this.enemies.some(e => Math.hypot(p.x - e.x, p.y - e.y) < 1.1); })) {
      this.hit(); return;
    }
    if (this.immunity <= 0 && Math.hypot(this.player.x - this.sparkPoint.x, this.player.y - this.sparkPoint.y) < 1) {
      if (!this.trail.length) this.anchor = { ...this.player };
      this.hit();
    }
  }

  step(dt: number, direction?: Direction, draw = false) {
    if (this.phase !== 'playing') return;
    dt = Math.min(.05, Math.max(0, dt));
    this.elapsed += dt; this.time = Math.max(0, this.time - dt); this.immunity -= dt;
    if (!this.time) { this.phase = 'over'; return; }
    this.moveClock += dt;
    const nextDirection = direction ?? this.pendingMove?.direction;
    const shouldDraw = draw || !!this.pendingMove?.draw;
    const interval = this.trail.length || shouldDraw || this.armed ? 1 / 22 : 1 / 29;
    if (nextDirection) {
      if (this.moveClock >= interval) {
        this.moveClock -= interval; this.pendingMove = undefined; this.move(nextDirection, shouldDraw);
      }
    } else this.moveClock = Math.min(this.moveClock, interval);
    if (this.phase !== 'playing') return;
    this.chance = Math.max(0, this.chance - dt);
    if (this.chance <= 0) for (const [enemyIndex, e] of this.enemies.entries()) {
    const speed = 1 + Math.min(this.stage, 6) * .1;
    // Gentle steering makes the core alive, but it cannot home through captured walls.
    const bend = Math.sin(this.elapsed * 1.8 + enemyIndex * 2) * .65 * dt;
    const vx = e.vx * Math.cos(bend) - e.vy * Math.sin(bend);
    e.vy = e.vx * Math.sin(bend) + e.vy * Math.cos(bend); e.vx = vx;
    const canEnter = (x: number, y: number) => x >= 1 && y >= 1 && x <= this.cols - 2 && y <= this.rows - 2 && !this.safe[this.index(Math.round(x), Math.round(y))];
    const nx = e.x + e.vx * dt * speed;
    if (canEnter(nx, e.y)) e.x = nx; else e.vx *= -1;
    const ny = e.y + e.vy * dt * speed;
    if (canEnter(e.x, ny)) e.y = ny; else e.vy *= -1;
    }
    if (this.chance <= 0) this.spark = (this.spark + dt * (7 + this.stage)) % this.perimeter;
    if (this.trail.length) {
      if (this.chance <= 0) this.trailAge += dt;
      if (this.trailAge > this.fuseDelay && this.chance <= 0) this.fuse = (this.trailAge - this.fuseDelay) * 12;
      if (this.fuse >= this.trail.length - .5) { this.hit(); return; }
    }
    this.checkCollision();
  }
}
