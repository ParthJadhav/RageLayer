/**
 * Helpers for driving a real engine over a real destructible page.
 *
 * `captureContent` is left off and a `ContentLayer` is installed by hand: the
 * production capture path rasterizes live DOM through an SVG `foreignObject`,
 * which no headless DOM implements. Everything downstream of the raster — the
 * coverage map, the wound compositing, every content-aware tool — is the real
 * code, so tests still assert genuine destruction rather than a mock.
 */

import { ContentLayer } from "../../src/content.ts";
import { RageLayerEngine } from "../../src/engine.ts";
import { makeCanvas, pointerEvent, setViewport, stubRect } from "./dom.mjs";

const live = new Set();

/**
 * Build an engine whose page is a flat, fully opaque raster of `width` ×
 * `height`. Post-FX and element harvesting are off by default: both need
 * WebGL or real layout, and neither changes what the tools do to the page.
 */
export function createTestEngine({
  width = 800,
  height = 600,
  tools = [],
  pageColor = "#3d6fb5",
  ...options
} = {}) {
  setViewport(width, Math.min(height, 768), height);

  const engine = new RageLayerEngine({
    captureContent: false,
    postFX: false,
    harvestElements: false,
    textMask: false,
    physics: true,
    ...options,
  });
  live.add(engine);

  const raster = makeCanvas(width, height, pageColor);
  const layer = new ContentLayer();
  layer.adopt(raster, width, height);
  // Mounts the canvas in the right place in the layer stack as well.
  engine.contentLayer = layer;
  stubRect(engine.container, { x: 0, y: 0, width, height });

  for (const tool of tools) engine.registerTool(tool);

  return engine;
}

export function disposeTestEngines() {
  for (const engine of live) {
    if (!engine.disposed) engine.dispose();
  }
  live.clear();
  globalThis.document.body.replaceChildren();
}

/**
 * Press, optionally drag, and release — the gesture almost every tool is
 * driven by. `frames` ticks the engine while the pointer is held so that
 * tick-driven tools (sprays, saws, beams) get to do their work.
 */
export function useTool(engine, path, { frames = 0, dt = 1 / 60 } = {}) {
  const points = Array.isArray(path[0]) ? path : [path];
  const [first, ...rest] = points;

  engine.container.dispatchEvent(pointerEvent("pointerdown", first[0], first[1]));
  tick(engine, frames, dt);

  for (const [x, y] of rest) {
    engine.container.dispatchEvent(pointerEvent("pointermove", x, y));
    tick(engine, frames, dt);
  }

  const last = points[points.length - 1];
  globalThis.window.dispatchEvent(pointerEvent("pointerup", last[0], last[1]));
  return engine;
}

/**
 * Advance the engine by whole frames.
 *
 * This drives the engine's own frame function rather than poking the
 * subsystems individually, so tool ticks, fire spread, particles, the physics
 * step and the surface reconcile all run in their real order — fire that
 * spreads and burns through the page only does so from here.
 */
export function tick(engine, frames = 1, dt = 1 / 60) {
  for (let i = 0; i < frames; i++) {
    if (engine.disposed) return;
    clock += dt * 1000;
    engine.frame(clock);
  }
}

// A virtual frame clock. `performance.now()` advances by microseconds between
// synchronous calls, which would make every simulated frame a zero-length one.
let clock = 1000;

/**
 * Fraction of the whole page that has been removed, sampled on a grid. Use
 * this for tools whose damage lands somewhere other than the cursor — a rocket
 * flies before it detonates, so the hole is never where you clicked.
 */
export function pageDamage(engine, step = 16) {
  let void_ = 0;
  let total = 0;
  for (let y = step; y < engine.height; y += step) {
    for (let x = step; x < engine.width; x += step) {
      total++;
      if (engine.pageOpacityAt(x, y) < 0.3) void_++;
    }
  }
  return void_ / total;
}

/** How much of a disc has been removed from the page, as a 0..1 fraction. */
export function damageFraction(engine, x, y, radius, samples = 24) {
  let void_ = 0;
  let total = 0;
  for (let i = 0; i < samples; i++) {
    const angle = (i / samples) * Math.PI * 2;
    for (const scale of [0, 0.35, 0.7, 1]) {
      const px = x + Math.cos(angle) * radius * scale;
      const py = y + Math.sin(angle) * radius * scale;
      total++;
      if (engine.pageOpacityAt(px, py) < 0.3) void_++;
    }
  }
  return void_ / total;
}
