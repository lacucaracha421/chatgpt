import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

/* The game's pure simulation scripts, evaluated straight out of the bundled page in an isolated context. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Api = any;
function loadGame(): { Items: Api; Core: Api; Reveal: Api } {
  const html = readFileSync(resolve(__dirname, "fault.html"), "utf8");
  const sandbox: Record<string, Api> = {};
  for (const name of ["levels.js", "items.js", "engine.js", "reveal.js"]) {
    const match = html.match(new RegExp(`<script>\\s*/\\* ${name.replace(".", "\\.")} \\*/([\\s\\S]*?)</script>`));
    if (!match) throw new Error(`${name} is missing from fault.html`);
    runInNewContext(match[1], sandbox);
  }
  return { Items: sandbox.FaultItems, Core: sandbox.FaultCore, Reveal: sandbox.FaultReveal };
}
const { Items, Core, Reveal } = loadGame();

function playing(stage = 0) {
  const engine = new Reveal.Engine({ seed: 5 });
  engine.start(stage, 1);
  engine.launch();
  engine.takeEvents();
  return engine;
}
const superBalls = (engine: Api) => engine.balls.filter((ball: Api) => ball.power);

describe("FAULT super attack", () => {
  it.each([1, 2, 3])("fires the LV%i attack when the gauge has reached that level", (level) => {
    const engine = playing();
    engine.reveal.power = level * Reveal.SUPER_STEP;
    const alive = engine.bricks.filter((brick: Api) => brick.alive).length;
    expect(engine.fireSuper()).toBe(true);
    const attack = Reveal.SUPER_ATTACKS[level];
    expect(engine.takeEvents().filter((event: Api) => event.type === "super").map((event: Api) => event.level)).toEqual([level]);
    expect(engine.reveal.power).toBe(0);
    const balls = superBalls(engine);
    expect(balls).toHaveLength(attack.angles.length);
    for (const ball of balls) expect(ball).toMatchObject({ power: level, r: attack.r, life: attack.life, damage: attack.core });
    const after = engine.bricks.filter((brick: Api) => brick.alive).length;
    if (attack.shock) expect(after).toBeLessThan(alive);
    else expect(after).toBe(alive);
  });

  it("scales with the level: more balls, longer or stronger, and only LV3 shocks", () => {
    const [, one, two, three] = Reveal.SUPER_ATTACKS;
    expect(two.angles.length).toBeGreaterThan(one.angles.length);
    expect(three.angles.length).toBeGreaterThanOrEqual(two.angles.length);
    expect(three.core).toBeGreaterThan(one.core);
    expect([one.shock, two.shock, three.shock]).toEqual([false, false, true]);
  });

  it("fires only completed levels: a part-filled segment does not count", () => {
    const engine = playing();
    engine.reveal.power = 2 * Reveal.SUPER_STEP - 1;
    engine.fireSuper();
    expect(engine.takeEvents().find((event: Api) => event.type === "super").level).toBe(1);
    engine.reveal.power = Reveal.SUPER_STEP - 1;
    expect(engine.fireSuper()).toBe(false);
  });

  it("smashes armored bricks, rebounds off the paddle line while live and then drops out without costing a life", () => {
    const engine = playing();
    engine.reveal.power = Reveal.SUPER_STEP;
    engine.fireSuper();
    const [ball] = superBalls(engine);
    let lowest = 0, rebounded = false;
    for (let i = 0; i < 120 * 3.5 && !rebounded && engine.balls.includes(ball); i++) {
      engine.balls[0].x = 30; engine.balls[0].y = 700; engine.balls[0].vx = 0; engine.balls[0].vy = -1e-4; // park the normal ball
      engine.step(1 / 120);
      lowest = Math.max(lowest, ball.y);
      if (engine.takeEvents().some((event: Api) => event.type === "floor")) rebounded = true;
    }
    expect(rebounded).toBe(true);
    expect(lowest).toBeLessThanOrEqual(engine.paddle.y);
    ball.age = ball.life; ball.x = 240; ball.y = engine.paddle.y - 20; ball.vx = 0; ball.vy = 600;
    for (let i = 0; i < 60; i++) { engine.balls[0].x = 30; engine.balls[0].y = 700; engine.balls[0].vy = -1e-4; engine.step(1 / 120); }
    expect(engine.balls.includes(ball)).toBe(false);
    expect(engine.lives).toBe(engine.config().lives);
  });
});

describe("FAULT pierce item", () => {
  function hit(kind: string, hp: number, pierce: boolean) {
    const engine = playing();
    const brick = engine.bricks.find((b: Api) => b.alive && b.kind !== "steel" && b.kind !== "core");
    Object.assign(brick, { kind, hp, maxHp: hp, moving: false, x: 200, bx: 200, y: 300 });
    engine.bricks = [brick, ...engine.bricks.filter((b: Api) => b.kind === "core").map((b: Api) => Object.assign(b, { x: 40, bx: 40, y: 140, moving: false }))];
    engine.buffs.pierce = pierce ? Items.byId.pierce.duration : 0;
    const ball = engine.balls[0];
    Object.assign(ball, { x: brick.x + brick.w / 2, y: brick.y + brick.h + 20, vx: 0, vy: -engine.speed });
    engine.moveBall(ball, 0.05);
    return { brick, ball };
  }

  it("slips through a brick one hit breaks", () => {
    const { brick, ball } = hit("normal", 1, true);
    expect(brick.alive).toBe(false);
    expect(ball.vy).toBeLessThan(0);
  });

  it("no longer one-shots armored bricks: it deals one hit and rebounds", () => {
    const { brick, ball } = hit("armor", 3, true);
    expect(brick.alive).toBe(true);
    expect(brick.hp).toBe(2);
    expect(ball.vy).toBeGreaterThan(0);
  });

  it("is shorter and rarer than the other capsules", () => {
    expect(Items.byId.pierce.duration).toBe(4);
    const draws = Array.from({ length: 1000 }, (_, i) => Items.pick((i + 0.5) / 1000));
    const share = draws.filter((kind: string) => kind === "pierce").length / draws.length;
    expect(share).toBeGreaterThan(0.05);
    expect(share).toBeLessThan(0.1);
  });
});

describe("FAULT item drops", () => {
  it("drops about half as often as before (one guaranteed per 20 breaks plus a 3.5% roll)", () => {
    expect(Core.DROP_EVERY).toBe(20);
    expect(Core.DROP_CHANCE).toBe(0.035);
  });

  it("never drops capsules from bricks a super attack breaks", () => {
    const engine = playing(3);
    engine.reveal.power = Reveal.SUPER_MAX;
    engine.destroyed = Core.DROP_EVERY - 1;
    engine.fireSuper();
    expect(engine.drops).toHaveLength(0);
    expect(engine.destroyed).toBeGreaterThan(Core.DROP_EVERY);
  });
});
