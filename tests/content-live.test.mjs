import { describe, expect, test } from "bun:test";
import { ContentLayer } from "../src/content.ts";
import { drawScorch } from "../src/decals.ts";
import { alphaAt, makeCanvas, readPixels } from "./support/dom.mjs";

/**
 * Live-mode buffer geometry: the wound/decal layers are sized to the damage
 * rect rather than the document, grow without dropping a pixel, and survive
 * checkpoint round trips across a growth boundary. Assertions run end to end
 * through `refreshBase` (a real recompose from base + buffers) wherever
 * possible, because that is the path a live page actually exercises every
 * second.
 */

const WIDTH = 800;
const HEIGHT = 600;
const BASE = "#3d6fb5";
const BASE_RED = 0x3d;

function makeLive() {
  const layer = new ContentLayer();
  // Set before adopt, as the capture controller does: `adopt` resets the
  // wound buffers and `live` decides whether damage is recorded into them.
  layer.live = true;
  layer.adopt(makeCanvas(WIDTH, HEIGHT, BASE), WIDTH, HEIGHT);
  return layer;
}

/** Recompose the whole page from base + wounds + decals, in place. */
function recompose(layer) {
  layer.refreshBase(layer.baseImage);
}

describe("live buffers are damage-rect sized", () => {
  test("damage in one corner allocates buffers far smaller than the document", () => {
    const layer = makeLive();

    layer.punch(60, 60, 20);

    expect(layer.wounds).not.toBeNull();
    expect(layer.decals).not.toBeNull();
    const area = layer.wounds.width * layer.wounds.height;
    expect(area).toBeGreaterThan(0);
    expect(area).toBeLessThan((WIDTH * HEIGHT) / 4);
    // The bounded buffer still recomposes the hole exactly.
    recompose(layer);
    expect(alphaAt(layer.surface, 60, 60)).toBe(0);
    expect(alphaAt(layer.surface, 400, 300)).toBe(255);
  });

  test("a snapshot-mode layer never allocates the buffers at all", () => {
    const layer = new ContentLayer();
    layer.adopt(makeCanvas(WIDTH, HEIGHT, BASE), WIDTH, HEIGHT);

    layer.punch(60, 60, 20);

    expect(layer.wounds).toBeNull();
    expect(layer.decals).toBeNull();
  });

  test("repairing everything releases the buffers", () => {
    const layer = makeLive();
    layer.punch(60, 60, 20);
    expect(layer.wounds).not.toBeNull();

    layer.restoreAll();

    expect(layer.wounds).toBeNull();
    expect(alphaAt(layer.surface, 60, 60)).toBe(255);
  });
});

describe("growth preserves existing damage", () => {
  test("a far-away hit reallocates without moving a pixel of old wounds or decals", () => {
    const layer = makeLive();
    layer.punch(100, 100, 20);
    layer.char(140, 100, 25, 0.9);
    const before = layer.wounds;

    layer.punch(700, 500, 20);

    // The buffer really was reallocated for the new extent.
    expect(layer.wounds).not.toBe(before);
    // Recomposing from base + buffers reproduces old and new damage alike:
    // the hole survived in the wound mask, the soot in the decals buffer.
    recompose(layer);
    expect(alphaAt(layer.surface, 100, 100)).toBe(0);
    expect(alphaAt(layer.surface, 700, 500)).toBe(0);
    const charred = readPixels(layer.surface, 152, 100, 1, 1);
    expect(charred[3]).toBe(255);
    expect(charred[0]).toBeLessThan(BASE_RED);
  });
});

describe("tee decals recorded before their mark", () => {
  test("a decal drawn through toolCtx lands once its bounds are reported", () => {
    const layer = makeLive();

    // Tools draw first and mark after (`drawSplat(...)` then `markSurface`).
    const ctx = layer.toolCtx;
    ctx.save();
    ctx.fillStyle = "#112233";
    ctx.fillRect(300, 200, 20, 20);
    ctx.restore();

    // Nothing allocated yet: the draw is recorded, waiting for its bounds.
    expect(layer.wounds).toBeNull();

    layer.markSurface(310, 210, 30);

    expect(layer.wounds).not.toBeNull();
    expect(layer.wounds.width * layer.wounds.height).toBeLessThan((WIDTH * HEIGHT) / 4);
    // The mark survives a full recompose — the exact pixels the tool drew.
    recompose(layer);
    const px = readPixels(layer.surface, 310, 210, 1, 1);
    expect([px[0], px[1], px[2], px[3]]).toEqual([0x11, 0x22, 0x33, 255]);
  });

  test("marks drawn after damage landed elsewhere survive growth and recompose", () => {
    const layer = makeLive();
    layer.punch(100, 100, 20);

    const ctx = layer.toolCtx;
    ctx.fillStyle = "#221100";
    ctx.fillRect(600, 450, 12, 12);
    layer.markSurface(606, 456, 20);

    recompose(layer);
    const px = readPixels(layer.surface, 606, 456, 1, 1);
    expect([px[0], px[1], px[2], px[3]]).toEqual([0x22, 0x11, 0x00, 255]);
    expect(alphaAt(layer.surface, 100, 100)).toBe(0);
  });
});

describe("checkpoints across a growth boundary", () => {
  test("checkpoint → damage far away → restore puts every buffer pixel back", () => {
    const layer = makeLive();
    layer.punch(120, 120, 25);
    const checkpoint = layer.createCheckpoint();
    expect(checkpoint).not.toBeNull();
    expect(checkpoint.layersOrigin).not.toBeNull();

    // Grows (and re-places) the live buffers past the checkpoint's extent.
    layer.punch(700, 500, 25);
    expect(layer.opacityAt(700, 500)).toBe(0);

    expect(layer.restoreCheckpoint(checkpoint)).toBe(true);

    expect(layer.opacityAt(700, 500)).toBe(1);
    expect(alphaAt(layer.surface, 700, 500)).toBe(255);
    expect(layer.opacityAt(120, 120)).toBe(0);
    // The restored wounds sit at the right document position even though the
    // buffers changed shape in between: a live refresh keeps the old hole
    // open and the rewound area intact.
    recompose(layer);
    expect(alphaAt(layer.surface, 120, 120)).toBe(0);
    expect(alphaAt(layer.surface, 700, 500)).toBe(255);
    checkpoint.dispose();
  });

  test("checkpoint cost reflects the bounded buffers, not the document", () => {
    const layer = makeLive();
    layer.punch(60, 60, 20);

    const checkpoint = layer.createCheckpoint();

    // Surface plus two corner-sized buffers: far below three document layers.
    expect(checkpoint.pixelCost).toBeLessThan(WIDTH * HEIGHT * 1.5);
    expect(layer.checkpointPixelCost).toBe(checkpoint.pixelCost);
    checkpoint.dispose();
  });
});

describe("stamp cache eviction", () => {
  test("evicted stamp sizes are released and quietly rebuilt on reuse", () => {
    const canvas = makeCanvas(200, 200, "#888888");
    const ctx = canvas.getContext("2d");
    // Far more distinct sizes than the FIFO holds, so early entries are
    // evicted (and their backing stores zeroed) along the way.
    for (let radius = 5; radius < 40; radius++) drawScorch(ctx, 100, 100, radius, 0.4);

    // Re-using an evicted size must rebuild the stamp, not draw a dead canvas.
    expect(() => drawScorch(ctx, 100, 100, 5, 1)).not.toThrow();
    expect(readPixels(canvas, 100, 100, 1, 1)[0]).toBeLessThan(0x88);
  });
});
