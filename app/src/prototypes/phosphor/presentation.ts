import { TerritoryGame, type GameEvent } from './engine';

export class ArcadeSound {
  private context?: AudioContext;
  enabled = true;
  unlock() {
    this.context ??= new AudioContext();
    void this.context.resume().catch(() => {});
  }
  tone(frequency: number, duration: number, offset = 0, type: OscillatorType = 'square') {
    if (!this.enabled || !this.context) return;
    const c = this.context, t = c.currentTime + offset;
    const oscillator = c.createOscillator(), gain = c.createGain();
    oscillator.type = type; oscillator.frequency.setValueAtTime(frequency, t);
    gain.gain.setValueAtTime(.035, t); gain.gain.exponentialRampToValueAtTime(.001, t + duration);
    oscillator.connect(gain); gain.connect(c.destination); oscillator.start(t); oscillator.stop(t + duration);
  }
  event(type: GameEvent['type']) {
    if (type === 'capture') [392, 523, 659, 784].forEach((f, i) => this.tone(f, .16, i * .055));
    if (type === 'clear') [523, 659, 784, 1047, 784, 1047].forEach((f, i) => this.tone(f, .25, i * .13));
    if (type === 'hit') [180, 120, 65].forEach((f, i) => this.tone(f, .2, i * .08, 'sawtooth'));
    if (type === 'focus') [784, 988, 1175, 1568].forEach((f, i) => this.tone(f, .18, i * .085));
  }
  dispose() { void this.context?.close(); }
}

type Particle = { x: number; y: number; vx: number; vy: number; life: number; color: string };
export class ArcadeRenderer {
  particles: Particle[] = [];
  flashCells: number[] = [];
  flash = 0;
  shake = 0;
  label = '';
  labelLife = 0;
  private mask = document.createElement('canvas');
  private maskDirty = true;
  private previousGame?: TerritoryGame;
  reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  event(event: GameEvent, game: TerritoryGame) {
    this.maskDirty = true;
    if (event.type === 'capture') {
      this.flashCells = event.cells; this.flash = .3;
      this.label = event.amount < 3 ? 'SPLIT! TRY A CORNER' : `+${event.amount.toFixed(1)}%`; this.labelLife = .7;
    }
    if (event.type === 'hit') { this.shake = .35; this.label = 'SHORT CIRCUIT'; this.labelLife = 1.2; }
    if (event.type === 'focus') { this.label = 'CHANCE! +5000'; this.labelLife = .8; }
    if (event.type === 'clear') this.labelLife = 0;
    const ids = event.cells.length ? event.cells : [game.index(game.player.x, game.player.y)];
    for (let i = 0; i < Math.min(90, ids.length); i++) {
      const p = game.point(ids[Math.floor(i * ids.length / Math.min(90, ids.length))]);
      this.particles.push({ ...p, vx: (Math.random() - .5) * 15, vy: -Math.random() * 18, life: .5 + Math.random() * .6, color: event.type === 'hit' ? '#ff674b' : i % 3 ? '#a8efcf' : '#ffe4ad' });
    }
  }

  render(canvas: HTMLCanvasElement, game: TerritoryGame, image: HTMLImageElement | null, dt: number, now: number, preview = false) {
    const bounds = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(bounds.width * dpr), height = Math.round(bounds.height * dpr);
    if (!width || !height) return;
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const c = canvas.getContext('2d')!;
    const cw = width / game.cols, ch = height / game.rows;
    c.save();
    c.fillStyle = '#101e26'; c.fillRect(0, 0, width, height);
    if (this.shake > 0 && !this.reducedMotion) c.translate(Math.sin(now * 93) * this.shake * 14, Math.cos(now * 81) * this.shake * 10);
    if (image) {
      const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight);
      const iw = image.naturalWidth * scale, ih = image.naturalHeight * scale;
      c.drawImage(image, (width - iw) / 2, (height - ih) / 2, iw, ih);
    }
    if (game !== this.previousGame) { this.maskDirty = true; this.previousGame = game; this.particles = []; this.flash = 0; this.labelLife = 0; }
    const fullyRevealed = game.phase === 'clear' || preview;
    if (!fullyRevealed) {
      if (this.maskDirty) {
        this.mask.width = game.cols; this.mask.height = game.rows;
        const m = this.mask.getContext('2d')!;
        m.fillStyle = '#181044'; m.fillRect(0, 0, game.cols, game.rows);
        m.fillStyle = '#211453';
        for (let y = 0; y < game.rows; y++) for (let x = 0; x < game.cols; x++) if ((x + y) % 2 === 0) m.fillRect(x, y, 1, 1);
        for (let i = 0; i < game.safe.length; i++) if (game.safe[i]) m.clearRect(i % game.cols, Math.floor(i / game.cols), 1, 1);
        this.maskDirty = false;
      }
      c.imageSmoothingEnabled = false;
      c.globalAlpha = game.phase === 'ready' ? .60 : 1;
      c.drawImage(this.mask, 0, 0, width, height); c.globalAlpha = 1;
      c.save(); c.beginPath();
      for (let i = 0; i < game.safe.length; i++) if (!game.safe[i]) c.rect((i % game.cols) * cw, Math.floor(i / game.cols) * ch, cw, ch);
      c.clip();
      c.strokeStyle = '#6750af25'; c.lineWidth = dpr * .5;
      c.beginPath();
      for (let x = 2; x < game.cols; x += 3) { c.moveTo(x * cw, 0); c.lineTo(x * cw, height); }
      for (let y = 2; y < game.rows; y += 3) { c.moveTo(0, y * ch); c.lineTo(width, y * ch); }
      c.stroke(); c.restore();
      // Exposed edge, including new territory: bright enough to read possible routes.
      c.fillStyle = '#7efbff';
      for (let y = 0; y < game.rows; y++) for (let x = 0; x < game.cols; x++) {
        if (!game.safe[game.index(x, y)]) continue;
        if (x < game.cols - 1 && !game.safe[game.index(x + 1, y)]) c.fillRect((x + 1) * cw - dpr, y * ch, dpr, ch);
        if (x > 0 && !game.safe[game.index(x - 1, y)]) c.fillRect(x * cw, y * ch, dpr, ch);
        if (y < game.rows - 1 && !game.safe[game.index(x, y + 1)]) c.fillRect(x * cw, (y + 1) * ch - dpr, cw, dpr);
        if (y > 0 && !game.safe[game.index(x, y - 1)]) c.fillRect(x * cw, y * ch, cw, dpr);
      }
    }
    if (this.flash > 0 && !this.reducedMotion) {
      c.fillStyle = `rgba(201,255,221,${this.flash * .85})`;
      for (const id of this.flashCells) { const p = game.point(id); c.fillRect(p.x * cw, p.y * ch, cw + .5, ch + .5); }
    }
    if (game.trail.length) {
      c.beginPath(); c.moveTo((game.anchor.x + .5) * cw, (game.anchor.y + .5) * ch);
      for (const id of game.trail) { const p = game.point(id); c.lineTo((p.x + .5) * cw, (p.y + .5) * ch); }
      c.strokeStyle = '#ffdf39'; c.lineWidth = 4 * dpr; c.stroke();
      c.strokeStyle = '#fff6ad'; c.lineWidth = dpr; c.stroke();
      if (game.fuse >= 0) {
        const p = game.point(game.trail[Math.min(game.trail.length - 1, Math.floor(game.fuse))]);
        this.diamond(c, (p.x + .5) * cw, (p.y + .5) * ch, 7 * dpr, '#ff6549');
      }
    }
    if (!fullyRevealed) {
      for (const [i, e] of game.enemies.entries()) this.monster(c, (e.x + .5) * cw, (e.y + .5) * ch, Math.max(1.5, Math.min(cw, ch) / dpr / 4) * dpr, game.chance > 0 ? '#beb7e4' : i ? '#45caff' : '#ff48a0', Math.floor(game.elapsed * 6) % 2);
      const s = game.sparkPoint;
      this.diamond(c, (s.x + .5) * cw, (s.y + .5) * ch, 6 * dpr, '#ff7552');
      const p = game.player, px = (p.x + .5) * cw, py = (p.y + .5) * ch;
      if (game.immunity <= 0 || Math.floor(now * 8) % 2 || game.phase === 'ready') {
        c.strokeStyle = '#131e25'; c.lineWidth = 4 * dpr;
        c.strokeRect(px - 5 * dpr, py - 5 * dpr, 10 * dpr, 10 * dpr);
        c.fillStyle = game.armed || game.trail.length ? '#ffd78e' : '#c6ffe1'; c.fillRect(px - 5 * dpr, py - 5 * dpr, 10 * dpr, 10 * dpr);
        c.fillStyle = '#183d39'; c.fillRect(px - 2 * dpr, py - 2 * dpr, 4 * dpr, 4 * dpr);
        if (!game.elapsed) {
          c.font = `bold ${11 * dpr}px monospace`; c.textAlign = 'center'; c.fillStyle = '#c6ffe1'; c.fillText('▼ YOU', px, py + 27 * dpr);
        }
      }
    }
    if (!game.focusClaimed && game.phase !== 'clear' && (game.phase !== 'ready' || preview)) {
      const x = (game.focus.x + .5) * cw, y = (game.focus.y + .5) * ch;
      const r = Math.max(11 * dpr, Math.min(cw, ch) * 2.5);
      c.strokeStyle = '#19032e'; c.lineWidth = 5 * dpr; c.strokeRect(x-r,y-r,r*2,r*2);
      c.strokeStyle = '#fff448'; c.lineWidth = 2 * dpr; c.strokeRect(x-r,y-r,r*2,r*2);
      c.beginPath(); c.moveTo(x-r-4*dpr,y); c.lineTo(x+r+4*dpr,y); c.moveTo(x,y-r-4*dpr); c.lineTo(x,y+r+4*dpr); c.stroke();
      c.font = `bold ${9*dpr}px monospace`; c.textAlign='center'; c.lineWidth=3*dpr; c.strokeStyle='#100322';
      c.strokeText('CHANCE',x,y-r-6*dpr); c.fillStyle='#fff66c'; c.fillText('CHANCE',x,y-r-6*dpr);
    }
    for (const p of this.particles) {
      if (!this.reducedMotion) { c.globalAlpha = Math.max(0, p.life); c.fillStyle = p.color; c.fillRect(p.x * cw, p.y * ch, 3 * dpr, 3 * dpr); }
      p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 25 * dt; p.life -= dt;
    }
    c.globalAlpha = 1; this.particles = this.particles.filter(p => p.life > 0);
    if (this.labelLife > 0) {
      c.textAlign = 'center'; c.font = `900 ${Math.min(40 * dpr, width / 12)}px monospace`;
      c.lineWidth = 6 * dpr; c.strokeStyle = '#10232b'; c.fillStyle = this.label.startsWith('+') ? '#d6f7c8' : '#ffd3ad';
      c.strokeText(this.label, width / 2, 38 * dpr); c.fillText(this.label, width / 2, 38 * dpr);
    }
    this.flash = Math.max(0, this.flash - dt); this.shake = Math.max(0, this.shake - dt); this.labelLife = Math.max(0, this.labelLife - dt);
    c.restore();
  }
  private monster(c: CanvasRenderingContext2D, x: number, y: number, pixel: number, color: string, frame: number) {
    const rows = ['00100100','00111100','01111110','11211211','11211211','11111111','01111110',frame ? '01011010' : '10100101'];
    c.fillStyle = '#10041f'; c.fillRect(Math.round(x-5*pixel),Math.round(y-5*pixel),10*pixel,10*pixel);
    for (let py=0;py<rows.length;py++) for(let px=0;px<rows[py].length;px++) {
      if(rows[py][px]==='0')continue;
      c.fillStyle=rows[py][px]==='2'?'#fff':color;
      c.fillRect(Math.round(x+(px-4)*pixel),Math.round(y+(py-4)*pixel),Math.ceil(pixel),Math.ceil(pixel));
    }
  }
  private diamond(c: CanvasRenderingContext2D, x: number, y: number, radius: number, color: string) {
    c.save(); c.translate(x, y); c.rotate(Math.PI / 4); c.fillStyle = color; c.shadowColor = color; c.shadowBlur = radius * 2; c.fillRect(-radius / 2, -radius / 2, radius, radius); c.restore();
  }
}
