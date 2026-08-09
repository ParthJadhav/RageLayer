import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { pickPixelRatio } from "../src/capture.ts";

/** `pickPixelRatio` reads `window.devicePixelRatio`; give bun a stand-in. */
const hadWindow = "window" in globalThis;
const realWindow = globalThis.window;
beforeEach(() => {
  globalThis.window = { devicePixelRatio: 2 };
});
afterEach(() => {
  if (hadWindow) globalThis.window = realWindow;
  else delete globalThis.window;
});

const MAX_CANVAS_PIXELS = 20e6;

describe("pickPixelRatio", () => {
  test("ordinary pages capture at the device ratio, capped at 2", () => {
    expect(pickPixelRatio(1280, 800)).toBe(2);
    window.devicePixelRatio = 3;
    expect(pickPixelRatio(1280, 800)).toBe(2);
    window.devicePixelRatio = 1;
    expect(pickPixelRatio(1280, 800)).toBe(1);
  });

  test("a missing devicePixelRatio falls back to 1", () => {
    window.devicePixelRatio = 0;
    expect(pickPixelRatio(1280, 800)).toBe(1);
    window.devicePixelRatio = undefined;
    expect(pickPixelRatio(1280, 800)).toBe(1);
  });

  test("the tall-page step-down kicks in strictly above 4500 CSS px", () => {
    // At and below the boundary the 1.5 cap does not apply; just above it does.
    expect(pickPixelRatio(800, 4500)).toBe(2);
    expect(pickPixelRatio(800, 4501)).toBe(1.5);
    expect(pickPixelRatio(400, 4501)).toBe(1.5);
  });

  test("the total pixel budget clamps very long documents", () => {
    const ratio = pickPixelRatio(1200, 30000);
    expect(ratio).toBeCloseTo(Math.sqrt(MAX_CANVAS_PIXELS / (1200 * 30000)), 10);
    // The invariant the budget exists for: the backing store never exceeds it.
    expect(1200 * ratio * 30000 * ratio).toBeLessThanOrEqual(MAX_CANVAS_PIXELS + 1);
  });

  test("degenerate zero-size documents do not divide by zero", () => {
    const ratio = pickPixelRatio(0, 0);
    expect(Number.isFinite(ratio)).toBe(true);
    expect(ratio).toBeGreaterThan(0);
  });
});
