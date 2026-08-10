import { afterEach, describe, expect, test } from "bun:test";
import { baseTools, broom, chainsaw, flamethrower, gun, hammer, paintball } from "../src/tools.ts";
import { readPixels } from "./support/dom.mjs";
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

    // A site needs up to six hits depending on the material's toughness.
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
  test("a tool carries no state from one engine into the next", () => {
    const first = armed(gun);
    useTool(first, [400, 300], { frames: 10 });
    first.dispose();

    const second = armed(gun);

    // Registration resets the shared singleton, so the new engine starts from
    // a cold trigger rather than mid-burst.
    expect(gun.heldFor).toBe(0);
    expect(second.flames.length).toBe(0);
  });
});
