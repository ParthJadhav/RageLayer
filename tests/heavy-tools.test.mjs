import { afterEach, describe, expect, test } from "bun:test";
import { advancedTools, gravityGun } from "../src/advanced-tools.ts";
import {
  blackHole,
  bugs,
  demolition,
  heavyTools,
  lightning,
  rocketLauncher,
} from "../src/heavy-tools.ts";
import { readPixels } from "./support/dom.mjs";
import {
  createTestEngine,
  damageFraction,
  disposeTestEngines,
  pageDamage,
  tick,
  useTool,
} from "./support/engine.mjs";

/**
 * The cinematic and advanced toolsets, driven the same way as the base tools.
 * Each test asserts the effect the tool advertises in its own hint, so a
 * refactor that quietly stops a tool from doing anything is caught here rather
 * than in a screenshot.
 */

afterEach(disposeTestEngines);

function armed(tool, options) {
  const engine = createTestEngine({ tools: [tool], ...options });
  engine.setTool(tool.id);
  return engine;
}

describe("toolset hygiene", () => {
  test("heavy and advanced ids never collide", () => {
    const ids = [...heavyTools, ...advancedTools].map((tool) => tool.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  test("only the supported fixed-wood toolsets ship", () => {
    expect(heavyTools.map(({ id }) => id)).toEqual([
      "demolition",
      "rocket",
      "lightning",
      "blackhole",
      "bugs",
    ]);
    expect(advancedTools.map(({ id }) => id)).toEqual([
      "laser-cutter",
      "acid-sprayer",
      "sticky-bombs",
    ]);
  });

  test("no heavy or advanced tool throws over an ordinary page", () => {
    for (const tool of [...heavyTools, ...advancedTools]) {
      const engine = armed(tool);
      expect(() =>
        useTool(
          engine,
          [
            [400, 300],
            [430, 320],
            [460, 300],
          ],
          { frames: 6 },
        ),
      ).not.toThrow();
    }
  });
});

describe("rocket launcher", () => {
  test("a launched rocket flies, detonates and tears the page open", () => {
    const engine = armed(rocketLauncher);
    expect(pageDamage(engine)).toBe(0);

    useTool(engine, [400, 300], { frames: 2 });
    // The rocket leaves the muzzle at speed and is armed only once it has
    // actually flown, so the hole is never where the click was. Stop as soon
    // as it lands: every simulated frame rasterizes, and a loaded CI runner
    // pays real wall time for frames the assertion no longer needs.
    for (let i = 0; i < 240 && pageDamage(engine) === 0; i += 20) tick(engine, 20);

    expect(pageDamage(engine)).toBeGreaterThan(0);
  }, 20_000);

  test("one engine cannot fly or detonate another engine's rocket", () => {
    const first = armed(rocketLauncher);
    const second = armed(rocketLauncher);
    useTool(first, [400, 300], { frames: 2 });

    tick(second, 240);
    expect(pageDamage(second)).toBe(0);
    expect(pageDamage(first)).toBe(0);

    for (let i = 0; i < 240 && pageDamage(first) === 0; i += 20) tick(first, 20);
    expect(pageDamage(first)).toBeGreaterThan(0);
  }, 20_000);

  test("a launched rocket keeps flying after another tool is selected", () => {
    const engine = armed(rocketLauncher);
    useTool(engine, [400, 300], { frames: 2 });
    engine.registerTool(blackHole);
    engine.setTool(blackHole.id);

    for (let i = 0; i < 240 && pageDamage(engine) === 0; i += 20) tick(engine, 20);

    expect(pageDamage(engine)).toBeGreaterThan(0);
  }, 20_000);
});

describe("lightning", () => {
  test("a strike scorches the page it hits", () => {
    const engine = armed(lightning);
    const before = readPixels(engine.content.surface, 380, 280, 40, 40);

    useTool(engine, [400, 300], { frames: 10 });

    expect([...readPixels(engine.content.surface, 380, 280, 40, 40)]).not.toEqual([...before]);
  });

  test("restrike queues are isolated between simultaneous engines", () => {
    const first = armed(lightning);
    const second = armed(lightning);
    lightning.onDown(first, { x: 400, y: 300, buttons: 1 });
    const firstParticles = first.particles.count;

    lightning.tick(second, 0.3, false, { x: 400, y: 300 });
    expect(second.particles.count).toBe(0);

    lightning.tick(first, 0.3, false, { x: 400, y: 300 });
    expect(first.particles.count).toBeGreaterThan(firstParticles);
  });
});

describe("demolition", () => {
  test("drag distance is measured against the same engine's previous hit", () => {
    const first = armed(demolition);
    const second = armed(demolition);
    let firstMoves = 0;
    first.demolish = () => {
      firstMoves++;
      return true;
    };
    second.demolish = () => true;

    demolition.onDown(first, { x: 200, y: 300, buttons: 1 });
    demolition.onDown(second, { x: 700, y: 300, buttons: 1 });
    firstMoves = 0;
    demolition.onMove(first, { x: 225, y: 300, buttons: 1 });

    expect(firstMoves).toBe(0);
  });
});

describe("black hole", () => {
  test("holding opens a singularity that closes on release", () => {
    const engine = armed(blackHole);

    engine.container.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        clientX: 400,
        clientY: 300,
        pointerId: 1,
        isPrimary: true,
        button: 0,
        buttons: 1,
      }),
    );
    tick(engine, 20);

    expect(engine.singularity).not.toBeNull();

    window.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        clientX: 400,
        clientY: 300,
        pointerId: 1,
        isPrimary: true,
        button: 0,
        buttons: 0,
      }),
    );
    tick(engine, 240);

    expect(engine.singularity).toBeNull();
  });

  test("a held singularity swallows the debris around it", () => {
    const engine = armed(blackHole);
    engine.fracture(400, 300, 60);
    // Track the actual pieces: the hole tears fresh debris off the page as it
    // pulls, so the total body count grows even while it is eating.
    const original = [...engine.physics.bodies];
    expect(original.length).toBeGreaterThan(0);

    useTool(engine, [400, 300], { frames: 300 });

    const survivors = original.filter((body) => engine.physics.bodies.includes(body));
    expect(survivors.length).toBeLessThan(original.length);
  });

  test("a fresh singularity does not inherit rumble cadence from the prior hold", () => {
    const engine = armed(blackHole);
    let shakes = 0;
    engine.shake = () => shakes++;

    blackHole.onDown(engine, { x: 400, y: 300, buttons: 1 });
    blackHole.tick(engine, 0.13, true, { x: 400, y: 300 });
    blackHole.onUp(engine);
    blackHole.onDown(engine, { x: 400, y: 300, buttons: 1 });
    blackHole.tick(engine, 0.02, true, { x: 400, y: 300 });

    expect(shakes).toBe(0);
  });
});

describe("bugs", () => {
  test("a released bug can be swept away again", () => {
    const engine = armed(bugs);

    useTool(engine, [400, 300], { frames: 4 });
    tick(engine, 30);
    const released = engine.bugs.count;
    expect(released).toBeGreaterThan(0);

    engine.flushBugs(400, 300, 400);

    expect(engine.bugs.count).toBeLessThan(released);
  });
});

describe("advanced tools", () => {
  test("the laser cutter opens a clean kerf along a drag", () => {
    const laser = advancedTools.find((tool) => tool.id === "laser-cutter");
    const engine = armed(laser);

    useTool(
      engine,
      [
        [200, 300],
        [300, 300],
        [400, 300],
        [500, 300],
      ],
      { frames: 6 },
    );

    expect(damageFraction(engine, 350, 300, 6)).toBeGreaterThan(0);
    // Sparse pointer events must still produce one continuous, narrow line —
    // never the ragged/dashed chainsaw cut the laser used to share.
    for (let x = 202; x <= 498; x += 4) {
      expect(engine.pageOpacityAt(x, 300)).toBeLessThan(0.3);
      expect(engine.pageOpacityAt(x, 308)).toBeGreaterThan(0.9);
    }
  });

  test("the laser cuts immediately without a material-dependent dwell", () => {
    const laser = advancedTools.find((tool) => tool.id === "laser-cutter");
    const engine = armed(laser);

    useTool(
      engine,
      [
        [200, 300],
        [500, 300],
      ],
      { frames: 1 },
    );
    expect(engine.pageOpacityAt(350, 300)).toBeLessThan(0.3);
  });

  test("the laser leaves a red-hot lip beside its clean kerf", () => {
    const laser = advancedTools.find((tool) => tool.id === "laser-cutter");
    const engine = armed(laser);

    useTool(
      engine,
      [
        [200, 300],
        [500, 300],
      ],
      { frames: 1 },
    );

    const [red, green, blue, alpha] = readPixels(engine.content.surface, 350, 305, 1, 1);
    expect(alpha).toBeGreaterThan(0);
    expect(red).toBeGreaterThan(green);
    expect(red).toBeGreaterThan(blue);
  });

  test("the laser drops a fully isolated piece like the chainsaw", () => {
    const laser = advancedTools.find((tool) => tool.id === "laser-cutter");
    const engine = armed(laser);

    useTool(
      engine,
      [
        [300, 220],
        [500, 220],
        [500, 380],
        [300, 380],
        [300, 220],
      ],
      { frames: 1 },
    );

    expect(engine.physics.count).toBeGreaterThan(0);
    expect(engine.pageOpacityAt(400, 300)).toBeLessThan(0.3);
  });

  test("simultaneous laser gestures keep independent path and topology state", () => {
    const laser = advancedTools.find((tool) => tool.id === "laser-cutter");
    const first = armed(laser);
    const second = armed(laser);

    laser.onDown(first, { x: 260, y: 300, buttons: 1 });
    laser.onDown(second, { x: 620, y: 300, buttons: 1 });
    laser.onMove(first, { x: 360, y: 300, buttons: 1 });

    expect(first.pageOpacityAt(310, 300)).toBeLessThan(0.3);
    expect(first.pageOpacityAt(500, 300)).toBe(1);
    expect(second.pageOpacityAt(500, 300)).toBe(1);
  });

  test("the acid sprayer corrodes the page it is held over", () => {
    const acid = advancedTools.find((tool) => tool.id === "acid-sprayer");
    const engine = armed(acid);

    useTool(engine, [400, 300], { frames: 60 });
    tick(engine, 120);

    expect(damageFraction(engine, 400, 300, 30)).toBeGreaterThan(0);
  });

  test("acid damage and the visible bead use the exact same impact coordinate", () => {
    const acid = advancedTools.find((tool) => tool.id === "acid-sprayer");
    const engine = armed(acid);
    const burns = [];
    const particles = [];
    const burn = engine.content.burn.bind(engine.content);
    engine.content.burn = (x, y, radius) => {
      burns.push({ x, y, radius });
      burn(x, y, radius);
    };
    engine.spawnParticle = (particle) => particles.push(particle);

    acid.tick(engine, 1 / 24, true, { x: 400, y: 300 });

    const bead = particles.find(({ kind }) => kind === "acid");
    expect(burns).toHaveLength(1);
    expect(bead).toBeDefined();
    expect({ x: bead.x, y: bead.y }).toEqual({ x: burns[0].x, y: burns[0].y });
    expect(bead.maxLife).toBeGreaterThanOrEqual(1.8);
    expect(bead.vy).toBeGreaterThan(0);
    expect(bead.gravity).toBeGreaterThan(0);
  });

  test("acid creeps a little beyond the impact without recursively spreading", () => {
    const acid = advancedTools.find((tool) => tool.id === "acid-sprayer");
    const engine = armed(acid);
    const burns = [];
    const burn = engine.content.burn.bind(engine.content);
    engine.content.burn = (x, y, radius) => {
      burns.push({ x, y, radius });
      burn(x, y, radius);
    };

    useTool(engine, [400, 300], { frames: 12 });
    tick(engine, 120);

    const impactRadius = Math.max(...burns.map(({ radius }) => radius));
    const impacts = burns.filter(({ radius }) => radius === impactRadius);
    const creep = burns.filter(({ radius }) => radius < impactRadius);
    expect(impacts.length).toBeGreaterThan(0);
    expect(creep.length).toBeGreaterThan(0);
    for (const point of creep) {
      const nearestImpact = Math.min(
        ...impacts.map(({ x, y }) => Math.hypot(point.x - x, point.y - y)),
      );
      expect(nearestImpact).toBeLessThanOrEqual(28.001);
    }

    // The spray aims away from the cursor, so assert actual page damage in its
    // impact corridor rather than assuming a random droplet overlaps the exact
    // pointer pixel.
    expect(pageDamage(engine, 4)).toBeGreaterThan(0);
    for (let i = 0; i < 32; i++) {
      const angle = (i / 32) * Math.PI * 2;
      expect(engine.pageOpacityAt(400 + Math.cos(angle) * 58, 300 + Math.sin(angle) * 58)).toBe(1);
    }
  });

  test("acid deposits and creep stay isolated between simultaneous engines", () => {
    const acid = advancedTools.find((tool) => tool.id === "acid-sprayer");
    const first = armed(acid);
    const second = armed(acid);

    useTool(first, [400, 300], { frames: 12 });
    expect(damageFraction(first, 400, 300, 30)).toBeGreaterThan(0);
    expect(damageFraction(second, 400, 300, 60)).toBe(0);

    // The second engine must neither apply nor consume the first engine's
    // pending creep when its own frame loop advances.
    tick(second, 120);
    expect(damageFraction(second, 400, 300, 60)).toBe(0);

    first.clear();
    tick(first, 120);
    expect(damageFraction(first, 400, 300, 60)).toBe(0);
  });

  test("sticky bombs detonate on their own timer", () => {
    const sticky = advancedTools.find((tool) => tool.id === "sticky-bombs");
    const engine = armed(sticky);

    useTool(engine, [400, 300], { frames: 2 });
    expect(damageFraction(engine, 400, 300, 40)).toBe(0);

    // No further input: the charge is timed.
    tick(engine, 400);

    expect(damageFraction(engine, 400, 300, 40)).toBeGreaterThan(0);
  });

  test("a sticky-bomb fuse keeps running after another tool is selected", () => {
    const sticky = advancedTools.find((tool) => tool.id === "sticky-bombs");
    const engine = armed(sticky);
    useTool(engine, [400, 300], { frames: 2 });
    engine.registerTool(gravityGun);
    engine.setTool(gravityGun.id);

    tick(engine, 400);

    expect(damageFraction(engine, 400, 300, 40)).toBeGreaterThan(0);
  });

  test("a second engine cannot advance or detonate another engine's sticky bombs", () => {
    const sticky = advancedTools.find((tool) => tool.id === "sticky-bombs");
    const first = armed(sticky);
    const second = armed(sticky);

    useTool(first, [400, 300], { frames: 2 });
    tick(second, 400);

    expect(damageFraction(first, 400, 300, 40)).toBe(0);
    expect(damageFraction(second, 400, 300, 40)).toBe(0);

    tick(first, 400);
    expect(damageFraction(first, 400, 300, 40)).toBeGreaterThan(0);
  });

  test("the gravity gun drags debris toward the cursor", () => {
    const engine = armed(gravityGun);
    // Inside the 260px grip radius, and off to one side so the pull is
    // distinguishable from the fall.
    engine.fracture(420, 300, 40);
    const piece = engine.physics.bodies[0];
    expect(piece).toBeDefined();
    const startX = piece.x;

    useTool(engine, [600, 300], { frames: 45 });

    expect(piece.x).toBeGreaterThan(startX);
  });
});
