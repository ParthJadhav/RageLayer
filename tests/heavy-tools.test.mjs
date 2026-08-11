import { afterEach, describe, expect, test } from "bun:test";
import { advancedTools } from "../src/advanced-tools.ts";
import {
  blackHole,
  bugs,
  freezeRay,
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
  test(
    "a launched rocket flies, detonates and tears the page open",
    () => {
      const engine = armed(rocketLauncher);
      expect(pageDamage(engine)).toBe(0);

      useTool(engine, [400, 300], { frames: 2 });
      // The rocket leaves the muzzle at speed and is armed only once it has
      // actually flown, so the hole is never where the click was. Stop as soon
      // as it lands: every simulated frame rasterizes, and a loaded CI runner
      // pays real wall time for frames the assertion no longer needs.
      for (let i = 0; i < 240 && pageDamage(engine) === 0; i += 20) tick(engine, 20);

      expect(pageDamage(engine)).toBeGreaterThan(0);
    },
    20_000,
  );
});

describe("lightning", () => {
  test("a strike scorches the page it hits", () => {
    const engine = armed(lightning);
    const before = readPixels(engine.content.surface, 380, 280, 40, 40);

    useTool(engine, [400, 300], { frames: 10 });

    expect([...readPixels(engine.content.surface, 380, 280, 40, 40)]).not.toEqual([...before]);
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
});

describe("freeze ray", () => {
  test("holding it frosts the page, and heat melts the frost away", () => {
    const engine = armed(freezeRay);

    useTool(engine, [400, 300], { frames: 30 });
    const frosted = engine.frostAt(400, 300);
    expect(frosted).toBeGreaterThan(0);

    engine.meltFrost(400, 300, 60, 1);

    expect(engine.frostAt(400, 300)).toBeLessThan(frosted);
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
  });

  test("the acid sprayer corrodes the page it is held over", () => {
    const acid = advancedTools.find((tool) => tool.id === "acid-sprayer");
    const engine = armed(acid);

    useTool(engine, [400, 300], { frames: 60 });
    tick(engine, 120);

    expect(damageFraction(engine, 400, 300, 30)).toBeGreaterThan(0);
  });

  test("the glitch gun stays visible against a white page", () => {
    // Regression guard: corruption used to composite with `screen`, which is
    // very nearly a no-op on white and made the tool look broken on light sites.
    const glitch = advancedTools.find((tool) => tool.id === "glitch-gun");
    const engine = armed(glitch, { pageColor: "#ffffff" });
    const before = readPixels(engine.content.surface, 330, 260, 140, 80);

    useTool(engine, [400, 300], { frames: 20 });

    const after = readPixels(engine.content.surface, 330, 260, 140, 80);
    let changed = 0;
    for (let i = 0; i < after.length; i += 4) {
      if (after[i] !== before[i] || after[i + 1] !== before[i + 1]) changed++;
    }
    expect(changed).toBeGreaterThan(0);
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

  test("the gravity gun drags debris toward the cursor", () => {
    const gravity = advancedTools.find((tool) => tool.id === "gravity-gun");
    const engine = armed(gravity);
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
