import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { FlameField } from "../src/flames.ts";
import {
  baseTools,
  broom,
  chainsaw,
  flamethrower,
  gun,
  hammer,
  paintball,
  waterHose,
} from "../src/tools.ts";
import { WOOD } from "../src/wood.js";
import { makeCanvas, readPixels } from "./support/dom.mjs";
import {
  createTestEngine,
  damageFraction,
  disposeTestEngines,
  tick,
  useTool,
} from "./support/engine.mjs";

/**
 * The built-in tools are the product. These tests drive them through the real
 * pointer pipeline over a real destructible page and assert the effect a user
 * would see: material leaves the page, stains land without perforating it,
 * repairs put things back, and nothing happens when a tool is swung at a hole.
 */

afterEach(disposeTestEngines);

function armed(tool, options) {
  const engine = createTestEngine({ tools: [tool], ...options });
  engine.setTool(tool.id);
  return engine;
}

describe("every base tool is well-formed", () => {
  test("ids are unique and the metadata a toolbar needs is present", () => {
    const ids = baseTools.map((tool) => tool.id);

    expect(new Set(ids).size).toBe(ids.length);
    for (const tool of baseTools) {
      expect(tool.name.length).toBeGreaterThan(0);
      expect(tool.hint.length).toBeGreaterThan(0);
      expect(tool.icon.length).toBeGreaterThan(0);
    }
  });

  test("all base tools share one immutable wood physics contract", () => {
    expect(Object.isFrozen(WOOD)).toBe(true);
    expect(WOOD.toughness).toBeGreaterThan(1);
    expect(WOOD.flammability).toBe(1);
    expect(WOOD.burnRate).toBeGreaterThan(0);
  });

  test("no tool throws when used over an ordinary page", () => {
    for (const tool of baseTools) {
      const engine = armed(tool);
      expect(() =>
        useTool(
          engine,
          [
            [400, 300],
            [420, 310],
            [440, 300],
          ],
          { frames: 4 },
        ),
      ).not.toThrow();
    }
  });
});

describe("hammer", () => {
  test("the first blow cracks the page even when it does not break through", () => {
    const engine = armed(hammer);
    const before = readPixels(engine.content.surface, 380, 280, 40, 40);

    useTool(engine, [400, 300]);

    const after = readPixels(engine.content.surface, 380, 280, 40, 40);
    expect([...after]).not.toEqual([...before]);
  });

  test("sustained blows on one spot eventually break through", () => {
    const engine = armed(hammer);

    // Fixed wood takes several blows; keep a little margin for particle timing.
    for (let i = 0; i < 8; i++) useTool(engine, [400, 300], { frames: 2 });

    expect(damageFraction(engine, 400, 300, 20)).toBeGreaterThan(0);
  });

  test("swinging at a hole does nothing — there is nothing there to hit", () => {
    const engine = armed(hammer);
    // Open a large hole first, then swing into the middle of it.
    engine.content.punch(400, 300, 90);
    const before = engine.physics.count;

    useTool(engine, [400, 300]);
    tick(engine, 2);

    // No new debris was produced by hitting empty space.
    expect(engine.physics.count).toBe(before);
  });

  test("swinging over a hole still works on the page beside it", () => {
    const engine = armed(hammer);
    engine.content.punch(400, 300, 60);

    for (let i = 0; i < 8; i++) useTool(engine, [560, 300], { frames: 2 });

    expect(damageFraction(engine, 560, 300, 20)).toBeGreaterThan(0);
  });
});

describe("gun", () => {
  test("a shot punches a hole clean through the page", () => {
    const engine = armed(gun);

    useTool(engine, [400, 300], { frames: 2 });

    expect(engine.pageOpacityAt(400, 300)).toBe(0);
  });

  test("held fire keeps perforating along the drag", () => {
    const engine = armed(gun);

    useTool(
      engine,
      [
        [300, 300],
        [400, 300],
        [500, 300],
      ],
      { frames: 12 },
    );

    const hits = [300, 400, 500].filter((x) => damageFraction(engine, x, 300, 20) > 0);
    expect(hits.length).toBeGreaterThan(1);
  });
});

describe("flamethrower", () => {
  test("holding it lights fires", () => {
    const engine = armed(flamethrower);

    useTool(engine, [400, 300], { frames: 20 });

    expect(engine.flames.length).toBeGreaterThan(0);
  });

  test("sustained fire eats the page away", () => {
    const engine = armed(flamethrower);

    useTool(engine, [400, 300], { frames: 30 });
    // Let the fire keep working after the trigger is released.
    tick(engine, 120);

    expect(damageFraction(engine, 400, 300, 30)).toBeGreaterThan(0);
  });

  test("a fed flame stays fully alight well past the old twelve-second cutoff", () => {
    const fire = new FlameField();
    const host = {
      width: 800,
      height: 600,
      content: null,
      damageCtx: makeCanvas(800, 600).getContext("2d"),
      sound: { hiss() {}, pop() {} },
      pageOpacityAt: () => 1,
      spawnParticle() {},
      signalInteraction: () => [],
    };
    fire.spawn(host, 400, 300, 1);

    for (let frame = 0; frame < 16 * 20; frame++) {
      fire.step(host, 0.05, (frame + 1) * 50);
    }

    const original = fire.list.find((flame) => flame.age >= 15.9);
    expect(original).toBeDefined();
    expect(original.intensity).toBeGreaterThan(0.3);
  });

  test("contact heat creeps into nearby surviving wood without exceeding its cap", () => {
    const random = spyOn(Math, "random").mockReturnValue(0.5);
    try {
      const engine = armed(flamethrower, { maxFlames: 6 });
      engine.spawnFlame(400, 380, 1);

      let crept = false;
      for (let frame = 0; frame < 120; frame++) {
        tick(engine);
        crept ||= engine.flames.some((flame) => Math.hypot(flame.x - 400, flame.y - 380) > 12);
      }

      expect(crept).toBe(true);
      expect(engine.flames.length).toBeLessThanOrEqual(6);
    } finally {
      random.mockRestore();
    }
  });
});

describe("tool aim", () => {
  test("stays in one direction however the pointer is swung", () => {
    const engine = armed(flamethrower);
    const before = engine.toolAim;

    useTool(
      engine,
      [
        [200, 300],
        [700, 300],
        [700, 500],
        [200, 500],
      ],
      { frames: 6 },
    );
    tick(engine, 30);

    expect(engine.toolAim).toEqual(before);
  });

  test("a jet leaves the nozzle along that direction, not along the stroke", () => {
    const engine = armed(flamethrower);
    const aim = engine.toolAim;
    const jets = [];
    const spawnParticle = engine.spawnParticle.bind(engine);
    engine.spawnParticle = (particle) => {
      if (particle.kind === "jet") jets.push(particle);
      spawnParticle(particle);
    };

    // Dragged hard to the right — the old motion-steered aim would have swung
    // the cone with the stroke, firing +x while the drawn nozzle points up-left.
    useTool(
      engine,
      [
        [200, 300],
        [420, 300],
        [640, 300],
      ],
      { frames: 8 },
    );

    expect(jets.length).toBeGreaterThan(0);
    const mean = jets.reduce((sum, jet) => sum + Math.atan2(jet.vy, jet.vx), 0) / jets.length;
    // Within the cone's own spread of the fixed aim.
    expect(Math.abs(mean - Math.atan2(aim.y, aim.x))).toBeLessThan(0.31);
  });
});

describe("chainsaw", () => {
  test("dragging opens a kerf along the stroke", () => {
    const engine = armed(chainsaw);

    useTool(
      engine,
      [
        [200, 300],
        [300, 300],
        [400, 300],
        [500, 300],
      ],
      { frames: 3 },
    );

    expect(engine.pageOpacityAt(350, 300)).toBe(0);
    expect(engine.pageOpacityAt(350, 360)).toBe(1);
  });
});

describe("water hose", () => {
  test("emits a coherent core, droplets, and nozzle mist while held", () => {
    const engine = armed(waterHose);
    const kinds = new Set();
    const spawnParticle = engine.spawnParticle.bind(engine);
    engine.spawnParticle = (particle) => {
      kinds.add(particle.kind);
      spawnParticle(particle);
    };

    useTool(engine, [400, 300], { frames: 20 });

    expect(kinds.has("stream")).toBe(true);
    expect(kinds.has("water")).toBe(true);
    expect(kinds.has("steam")).toBe(true);
  });

  test("extinguishes along the visible jet without repairing holes", () => {
    const engine = armed(waterHose);
    engine.spawnFlame(400, 300, 1);
    engine.content.punch(500, 300, 24);

    useTool(engine, [400, 300], { frames: 45 });

    expect(engine.flames.length).toBe(0);
    expect(engine.pageOpacityAt(500, 300)).toBe(0);
  });
});

describe("paintball", () => {
  test("a splat stains the page without perforating it", () => {
    const engine = armed(paintball);
    const before = readPixels(engine.content.surface, 400, 300, 1, 1);

    useTool(engine, [400, 300], { frames: 2 });

    const after = readPixels(engine.content.surface, 400, 300, 1, 1);
    // The colour changed...
    expect([...after.slice(0, 3)]).not.toEqual([...before.slice(0, 3)]);
    // ...but paint is not a weapon: the page is still there.
    expect(engine.pageOpacityAt(400, 300)).toBe(1);
  });

  test("held fire is automatic and has the same cadence across frame rates", () => {
    const countShots = (frames, dt) => {
      const engine = armed(paintball);
      let shots = 0;
      engine.sound.splat = () => shots++;
      useTool(engine, [400, 300], { frames, dt });
      engine.dispose();
      return shots;
    };

    expect(countShots(36, 1 / 60)).toBe(countShots(18, 1 / 30));
  });

  test("release resets the automatic cadence before the next press", () => {
    const engine = armed(paintball);
    let shots = 0;
    engine.sound.splat = () => shots++;

    useTool(engine, [350, 300], { frames: 2 });
    tick(engine, 20);
    useTool(engine, [450, 300], { frames: 2 });

    expect(shots).toBe(2);
  });
});

describe("broom", () => {
  test("sweeping repairs damage back to the pristine page", () => {
    const engine = armed(broom);
    engine.content.punch(400, 300, 25);
    expect(engine.pageOpacityAt(400, 300)).toBe(0);

    useTool(
      engine,
      [
        [380, 300],
        [400, 300],
        [420, 300],
      ],
      { frames: 3 },
    );

    expect(engine.pageOpacityAt(400, 300)).toBe(1);
  });

  test("sweeping an intact page leaves it perfectly intact", () => {
    // Regression guard for the phantom torn-edge trail: a repair pass over
    // undamaged page must not leave partial alpha behind for the shader to
    // read as a wound.
    const engine = armed(broom);

    useTool(
      engine,
      [
        [300, 300],
        [400, 300],
        [500, 300],
      ],
      { frames: 3 },
    );

    const pixels = readPixels(engine.content.surface, 300, 290, 200, 20);
    for (let i = 3; i < pixels.length; i += 4) expect(pixels[i]).toBe(255);
  });
});

describe("tool state isolation", () => {
  test("gun cadence is independent across simultaneous engines", () => {
    const first = armed(gun);
    const second = armed(gun);
    let secondShots = 0;
    second.sound.shot = () => secondShots++;

    gun.onDown(first, { x: 400, y: 300, buttons: 1 });
    gun.tick(first, 0.21, true, { x: 400, y: 300 });
    gun.tick(second, 0.02, true, { x: 400, y: 300 });

    expect(secondShots).toBe(0);
  });

  test("hammer strike history belongs to the engine that made it", () => {
    const first = armed(hammer);
    const second = armed(hammer);
    const random = Math.random;
    Math.random = () => 0.99;
    try {
      for (let i = 0; i < 3; i++) hammer.onDown(first, { x: 400, y: 300, buttons: 1 });
      for (let i = 0; i < 3; i++) hammer.onDown(second, { x: 400, y: 300, buttons: 1 });
    } finally {
      Math.random = random;
    }

    expect(second.pageOpacityAt(400, 300)).toBe(1);
  });

  test("flamethrower ignition cadence is independent", () => {
    const first = armed(flamethrower);
    const second = armed(flamethrower);

    flamethrower.tick(first, 0.06, true, { x: 400, y: 300 });
    flamethrower.tick(second, 0.06, true, { x: 400, y: 300 });

    expect(first.flames.length).toBeGreaterThan(0);
    expect(second.flames.length).toBeGreaterThan(0);
  });

  test("water emission debt cannot spill into another engine", () => {
    const first = armed(waterHose);
    const second = armed(waterHose);

    waterHose.tick(first, 0.005, true, { x: 400, y: 300 });
    waterHose.tick(second, 0.005, true, { x: 400, y: 300 });

    expect(first.particles.count).toBe(0);
    expect(second.particles.count).toBe(0);
  });

  test("chainsaw paths cannot jump between engines", () => {
    const first = armed(chainsaw);
    const second = armed(chainsaw);
    const starts = [];
    const cut = first.content.cut.bind(first.content);
    first.content.cut = (x1, y1, x2, y2) => {
      starts.push([x1, y1, x2, y2]);
      return cut(x1, y1, x2, y2);
    };

    chainsaw.onDown(first, { x: 200, y: 300, buttons: 1 });
    chainsaw.onDown(second, { x: 700, y: 300, buttons: 1 });
    chainsaw.onMove(first, { x: 225, y: 300, dx: 25, dy: 0, buttons: 1 });

    expect(starts.length).toBeGreaterThan(0);
    expect(starts[0][0]).toBeLessThan(250);
  });

  test("paintball automatic cadence is independent", () => {
    const first = armed(paintball);
    const second = armed(paintball);
    let secondShots = 0;
    second.sound.splat = () => secondShots++;

    paintball.onDown(first, { x: 350, y: 300, buttons: 1 });
    paintball.onDown(second, { x: 450, y: 300, buttons: 1 });
    paintball.tick(first, 0.1, true, { x: 350, y: 300 });
    paintball.tick(second, 0.1, true, { x: 450, y: 300 });

    expect(secondShots).toBe(1);
  });

  test("broom travel debt cannot trigger a sweep in another engine", () => {
    const first = armed(broom);
    const second = armed(broom);
    let secondSweeps = 0;
    second.sound.sweep = () => secondSweeps++;

    broom.onMove(first, { x: 400, y: 300, dx: 20, dy: 0, buttons: 1 });
    broom.onMove(second, { x: 400, y: 300, dx: 10, dy: 0, buttons: 1 });

    expect(secondSweeps).toBe(0);
  });

  test("a new broom gesture discards distance debt from the prior stroke", () => {
    const engine = armed(broom);
    let sweeps = 0;
    engine.sound.sweep = () => sweeps++;

    broom.onMove(engine, { x: 400, y: 300, dx: 20, dy: 0, buttons: 1 });
    broom.onDown(engine, { x: 400, y: 300, buttons: 1 });
    const afterDown = sweeps;
    broom.onMove(engine, { x: 410, y: 300, dx: 10, dy: 0, buttons: 1 });

    expect(sweeps).toBe(afterDown);
  });
});
