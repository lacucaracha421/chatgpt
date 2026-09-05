import { describe, expect, it } from 'vitest';
import { TerritoryGame } from './engine';

function cutDown(game: TerritoryGame) {
  for (let y = 1; y < game.rows; y++) game.move('down', true);
}

describe('territory capture rules', () => {
  it('buffers brief taps but never allows fast tapping to bypass movement speed', () => {
    const game = new TerritoryGame(); game.start(); const startY = game.player.y;
    for (let i = 0; i < 100; i++) game.queueMove('down', true);
    expect(game.player.y).toBe(startY);
    game.step(.05); expect(game.player.y).toBe(startY + 1);
    game.step(.05); expect(game.player.y).toBe(startY + 1);
  });
  it.each([4 / 3, 2 / 3, 1, 2.8, .35])('captures only the enemy-free component at aspect %s', aspect => {
    const game = new TerritoryGame(aspect); game.start();
    game.rival.x = game.cols * .8;
    cutDown(game);
    expect(game.percent).toBeGreaterThan(45);
    expect(game.percent).toBeLessThan(56);
    expect(game.safe[game.index(2, 2)]).toBe(1);
    expect(game.safe[game.index(game.cols - 3, 2)]).toBe(0);
    expect(game.trail).toHaveLength(0);
    expect(game.events[0].type).toBe('capture');
  });

  it('requires drawing to leave safety and permits return to the anchor', () => {
    const game = new TerritoryGame(); game.start(); const origin = {...game.player};
    game.move('down'); expect(game.player).toEqual(origin);
    game.move('down', true); game.move('up');
    expect(game.trail).toHaveLength(0);
    expect(game.percent).toBeLessThan(1);
  });

  it('ends a life for self-intersection but allows one-step backtracking', () => {
    const game = new TerritoryGame(); game.start();
    game.move('down', true); game.move('down'); game.move('down'); game.move('up');
    expect(game.lives).toBe(3); expect(game.trail).toHaveLength(2);
    game.move('right'); game.move('up'); game.move('left');
    expect(game.lives).toBe(2); expect(game.trail).toHaveLength(0);
    expect(game.player).toEqual(game.anchor);
  });

  it('a core touching an exposed trail causes damage even during respawn protection', () => {
    const game = new TerritoryGame(); game.start(); game.move('down', true);
    game.enemy.x = game.player.x; game.enemy.y = game.player.y; game.enemy.vx = 0; game.enemy.vy = 0;
    game.step(.01); expect(game.lives).toBe(2); expect(game.trail).toHaveLength(0);
  });

  it('freezes time, enemies, and position while paused', () => {
    const game = new TerritoryGame(); game.start(); game.pause();
    const snapshot = JSON.stringify(game); game.step(.05, 'down', true); game.move('down', true);
    expect(JSON.stringify(game)).toBe(snapshot);
  });

  it('fuse catches a stalled short trail; zero lives and zero time end play', () => {
    const game = new TerritoryGame(); game.start(); game.move('down', true);
    game.enemy.vx = game.enemy.vy = 0;
    for (let i = 0; i < (game.fuseDelay + .2) / .05; i++) game.step(.05);
    expect(game.lives).toBe(2);
    game.hit(); game.hit(); expect(game.phase).toBe('over');
    const timeout = new TerritoryGame(); timeout.start(); timeout.time = .01; timeout.step(.02);
    expect(timeout.phase).toBe('over');
  });

  it('clears at 80% and leaves no drawing or later movement active', () => {
    const game = new TerritoryGame(); game.start();
    for (const enemy of game.enemies) { enemy.x = game.cols * .85; enemy.y = game.rows * .85; }
    cutDown(game);
    // Move up the safe seam, then split the remaining right-hand region horizontally.
    for (let y = game.rows - 1; y > Math.floor(game.rows * .65); y--) game.move('up');
    for (let x = game.player.x; x < game.cols - 1; x++) game.move('right', true);
    expect(game.phase).toBe('clear'); expect(game.percent).toBeGreaterThanOrEqual(80);
    const player = {...game.player}; game.step(.05, 'down', true); expect(game.player).toEqual(player);
    expect(game.events.some(event => event.type === 'clear')).toBe(true);
  });

  it('keeps the enemy out of newly captured territory over subsequent simulation steps', () => {
    const game = new TerritoryGame(); game.start(); cutDown(game);
    for (let i = 0; i < 500; i++) {
      game.step(.02);
      for (const enemy of game.enemies) expect(game.safe[game.index(Math.round(enemy.x), Math.round(enemy.y))]).toBe(0);
    }
  });
  it('retains both guarded regions when a cut separates the guardians', () => {
    const game = new TerritoryGame(); game.start(); cutDown(game);
    expect(game.percent).toBeLessThan(3);
    expect(game.safe[game.index(2, 2)]).toBe(0);
    expect(game.safe[game.index(game.cols - 3, 2)]).toBe(0);
    expect(game.focusClaimed).toBe(false);
    for (let y = game.rows - 1; y > Math.floor(game.rows / 2); y--) game.move('up');
    for (let x = game.player.x; x < game.cols - 1; x++) game.move('right', true);
    expect(game.phase).toBe('playing'); expect(game.percent).toBeLessThan(40);
  });
  it('rewards a manually chosen focus only once and freezes hazards during the chance', () => {
    const game = new TerritoryGame(); game.setFocus(4, 4); game.rival.x = game.cols * .8;
    game.start(); cutDown(game);
    expect(game.focusClaimed).toBe(true); expect(game.chance).toBe(3); expect(game.time).toBe(160);
    const enemies = JSON.stringify(game.enemies); const spark = game.spark;
    game.step(.05); expect(JSON.stringify(game.enemies)).toBe(enemies); expect(game.spark).toBe(spark);
    expect(game.events.filter(event => event.type === 'focus')).toHaveLength(1);
  });
  it('continues preserve revealed territory while charging score instead of erasing the image', () => {
    const game = new TerritoryGame(); game.rival.x = game.cols * .8; game.start(); cutDown(game);
    const safe = [...game.safe], percent = game.percent;
    game.hit(); game.hit(); game.hit(); const score = game.score; game.continue();
    expect([...game.safe]).toEqual(safe); expect(game.percent).toBe(percent);
    expect(game.lives).toBe(3); expect(game.time).toBe(90); expect(game.score).toBe(Math.floor(score / 2));
    expect(game.phase).toBe('playing'); expect(game.continues).toBe(1);
  });
});
