import { beforeEach, describe, expect, test } from "bun:test";
import { ContentLayer } from "../src/content.ts";
import { alphaAt, makeCanvas, readPixels } from "./support/dom.mjs";

/**
 * These tests run against a real Canvas2D rasterizer, so they assert the thing
 * the library actually promises: destruction removes page pixels, repair puts
 * them back, and washing cleans stains without healing structure.
 */

const WIDTH = 400;
const HEIGHT = 300;

let layer;
let raster;

/** Alpha of the layer's presented surface at a document coordinate. */
function surfaceAlpha(x, y) {
  return alphaAt(layer.surface, x * layer.dpr, y * layer.dpr);
}

/** Fraction of a disc that has been removed from the page. */
function voidFraction(cx, cy, r, samples = 24) {
  let gone = 0;
  let total = 0;
  for (let i = 0; i < samples; i++) {
    const angle = (i / samples) * Math.PI * 2;
    for (const scale of [0, 0.35, 0.7, 1]) {
      total++;
      if (layer.opacityAt(cx + Math.cos(angle) * r * scale, cy + Math.sin(angle) * r * scale) < 0.3)
        gone++;
    }
  }
  return gone / total;
}

/** True when every pixel of a disc is still fully opaque. */
function discFullyOpaque(cx, cy, r) {
  for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 12) {
    for (const scale of [0, 0.5, 0.9, 1, 1.05]) {
      const x = Math.round(cx + Math.cos(angle) * r * scale);
      const y = Math.round(cy + Math.sin(angle) * r * scale);
      if (surfaceAlpha(x, y) !== 255) return { x, y, alpha: surfaceAlpha(x, y) };
    }
  }
  return null;
}

beforeEach(() => {
  raster = makeCanvas(WIDTH, HEIGHT, "#3d6fb5");
  layer = new ContentLayer();
  layer.adopt(raster, WIDTH, HEIGHT);
});

describe("adoption", () => {
  test("a fresh layer is not ready and reports the page as intact", () => {
    const empty = new ContentLayer();

    expect(empty.ready).toBe(false);
    // No destructible surface means nothing can be void.
    expect(empty.opacityAt(10, 10)).toBe(1);
    expect(empty.patch(10, 10, 20, 20)).toBeNull();
  });

  test("adopting a raster makes the layer live and solid", () => {
    expect(layer.ready).toBe(true);
    expect(layer.width).toBe(WIDTH);
    expect(layer.height).toBe(HEIGHT);
    expect(layer.opacityAt(200, 150)).toBe(1);
    expect(surfaceAlpha(200, 150)).toBe(255);
  });

  test("re-adopting discards wounds from the previous capture", () => {
    layer.punch(200, 150, 30);
    expect(layer.opacityAt(200, 150)).toBe(0);

    layer.adopt(makeCanvas(WIDTH, HEIGHT, "#3d6fb5"), WIDTH, HEIGHT);

    expect(layer.opacityAt(200, 150)).toBe(1);
    expect(surfaceAlpha(200, 150)).toBe(255);
  });
});

describe("destruction removes page pixels", () => {
  test("punch clears the surface and the coverage map together", () => {
    layer.punch(200, 150, 30);

    expect(surfaceAlpha(200, 150)).toBe(0);
    expect(layer.opacityAt(200, 150)).toBe(0);
    // Far outside the blast the page is untouched.
    expect(surfaceAlpha(40, 40)).toBe(255);
    expect(layer.opacityAt(40, 40)).toBe(1);
  });

  test("a cut opens a void along its whole length, not just at its ends", () => {
    layer.cut(80, 150, 320, 150);

    expect(layer.opacityAt(200, 150)).toBe(0);
    expect(layer.opacityAt(120, 150)).toBe(0);
    expect(layer.opacityAt(300, 150)).toBe(0);
    expect(layer.opacityAt(200, 200)).toBe(1);
  });

  test("carving a shape removes exactly that region", () => {
    const square = new Path2D();
    square.rect(150, 100, 100, 100);

    layer.carveShape(square, { x: 150, y: 100, w: 100, h: 100 });

    expect(layer.opacityAt(200, 150)).toBe(0);
    expect(surfaceAlpha(200, 150)).toBe(0);
    // Outside the carved square the page is untouched.
    expect(layer.opacityAt(120, 150)).toBe(1);
    expect(surfaceAlpha(120, 150)).toBe(255);
  });

  test("burning removes material rather than only darkening it", () => {
    layer.burn(200, 150, 25);

    // The blobs are scattered randomly inside the blast, so the assertion is
    // about area consumed rather than any one point.
    expect(voidFraction(200, 150, 25)).toBeGreaterThan(0);
  });

  test("charring stains surviving pixels but never punches through", () => {
    const before = readPixels(layer.surface, 200, 150, 1, 1);
    layer.char(200, 150, 30, 0.6);
    const after = readPixels(layer.surface, 200, 150, 1, 1);

    // Soot darkens the page...
    expect(after[0]).toBeLessThan(before[0]);
    // ...but `source-atop` keeps the page's own alpha, so it is still page.
    expect(after[3]).toBe(255);
    expect(layer.opacityAt(200, 150)).toBe(1);
  });
});

describe("repair", () => {
  test("restore brings back both the pixels and the coverage", () => {
    layer.punch(200, 150, 40);
    expect(layer.opacityAt(200, 150)).toBe(0);

    layer.restore(200, 150, 60);

    expect(layer.opacityAt(200, 150)).toBe(1);
    expect(surfaceAlpha(200, 150)).toBe(255);
  });

  test("restoring an undamaged page leaves no partial-alpha rim", () => {
    // Regression guard: composing the pristine disc with clip + clear + draw
    // antialiases the rim twice and leaves a ring of alpha < 255, which the
    // surface shader reads as a wound — the broom used to paint a trail of
    // phantom torn edges across intact pages.
    layer.restore(200, 150, 40);

    expect(discFullyOpaque(200, 150, 40)).toBeNull();
  });

  test("repeated overlapping sweeps still leave no seam", () => {
    for (let x = 150; x <= 250; x += 10) layer.restore(x, 150, 30);

    expect(discFullyOpaque(200, 150, 25)).toBeNull();
  });

  test("restoreAll returns the entire page to pristine", () => {
    layer.punch(100, 100, 30);
    layer.punch(300, 200, 30);

    layer.restoreAll();

    expect(layer.opacityAt(100, 100)).toBe(1);
    expect(layer.opacityAt(300, 200)).toBe(1);
    expect(surfaceAlpha(100, 100)).toBe(255);
  });
});

describe("washing cleans stains without repairing structure", () => {
  test("a hole stays a hole while soot around it is rinsed away", () => {
    layer.punch(200, 150, 25);
    layer.char(200, 150, 110, 0.9);
    // Sampled outside the punch's ragged rim (which reaches ~1.7r) but well
    // inside the soot, so the pixel is stained page rather than void.
    const stained = readPixels(layer.surface, 260, 150, 1, 1);
    expect(stained[3]).toBe(255);

    layer.wash(200, 150, 120, 1);

    // The stain lifted...
    const washed = readPixels(layer.surface, 260, 150, 1, 1);
    expect(washed[0]).toBeGreaterThan(stained[0]);
    // ...and the hole is still a hole. Washing is not repair.
    expect(layer.opacityAt(200, 150)).toBe(0);
    expect(surfaceAlpha(200, 150)).toBe(0);
  });
});

describe("checkpoints", () => {
  test("a checkpoint restores the exact page state it captured", () => {
    layer.punch(150, 150, 30);
    const checkpoint = layer.createCheckpoint();
    expect(checkpoint).not.toBeNull();

    layer.punch(280, 150, 30);
    expect(layer.opacityAt(280, 150)).toBe(0);

    layer.restoreCheckpoint(checkpoint);

    // The later hole is gone...
    expect(layer.opacityAt(280, 150)).toBe(1);
    expect(surfaceAlpha(280, 150)).toBe(255);
    // ...and the earlier one survived the round trip.
    expect(layer.opacityAt(150, 150)).toBe(0);
    checkpoint.dispose();
  });

  test("checkpoint cost is reported so history can bound its memory", () => {
    const checkpoint = layer.createCheckpoint();

    expect(checkpoint.pixelCost).toBeGreaterThan(0);
    expect(layer.checkpointPixelCost).toBeGreaterThan(0);
    checkpoint.dispose();
  });

  test("an unready layer has nothing to check point", () => {
    expect(new ContentLayer().createCheckpoint()).toBeNull();
  });
});

describe("shard sourcing", () => {
  test("a patch addresses the pristine snapshot in device pixels", () => {
    const patch = layer.patch(200, 150, 40, 20);

    expect(patch.img).toBe(raster);
    expect(patch.sx).toBe((200 - 20) * layer.dpr);
    expect(patch.sy).toBe((150 - 10) * layer.dpr);
    expect(patch.sw).toBe(40 * layer.dpr);
    expect(patch.sh).toBe(20 * layer.dpr);
  });

  test("a patch never addresses outside the snapshot", () => {
    const patch = layer.patch(5, 5, 40, 40);

    expect(patch.sx).toBe(0);
    expect(patch.sy).toBe(0);
  });
});

describe("material measurement", () => {
  test("surviving area inside a polygon shrinks as the page is destroyed", () => {
    const region = [150, 100, 250, 100, 250, 200, 150, 200];
    const before = layer.materialArea(region);

    layer.punch(200, 150, 40);

    expect(before).toBeGreaterThan(0);
    expect(layer.materialArea(region)).toBeLessThan(before);
  });
});

describe("lifecycle", () => {
  test("dispose makes the layer inert without throwing", () => {
    layer.punch(200, 150, 20);
    layer.dispose();

    expect(() => layer.punch(100, 100, 20)).not.toThrow();
    expect(() => layer.present()).not.toThrow();
  });

  test("operations on an unready layer are no-ops", () => {
    const empty = new ContentLayer();

    expect(() => {
      empty.punch(10, 10, 5);
      empty.cut(0, 0, 10, 10);
      empty.restore(10, 10, 5);
      empty.wash(10, 10, 5);
      empty.restoreAll();
    }).not.toThrow();
  });
});
