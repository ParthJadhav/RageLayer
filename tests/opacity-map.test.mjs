import { beforeEach, describe, expect, test } from "bun:test";
import { OpacityMap } from "../src/opacity-map.ts";
import { makeCanvas } from "./support/dom.mjs";

/**
 * `OpacityMap` is the single source of truth for "does the page still exist
 * here". Every content-aware tool routes through it: a hammer swung at a hole
 * must meet nothing, a repaired region must come back, and a long flamethrower
 * session must not degrade the answer as its operation lists flatten.
 */

const WIDTH = 400;
const HEIGHT = 300;

function discPath(x, y, r) {
  const path = new Path2D();
  path.arc(x, y, r, 0, Math.PI * 2);
  return path;
}

function discBounds(x, y, r) {
  return { x0: x - r, y0: y - r, x1: x + r, y1: y + r };
}

function removeDisc(map, x, y, r) {
  map.removeDisc(discPath(x, y, r), discBounds(x, y, r), x, y, r);
}

let map;
let source;

beforeEach(() => {
  source = makeCanvas(WIDTH, HEIGHT, "#204080");
  map = new OpacityMap();
  map.reset(source, WIDTH, HEIGHT);
});

describe("pristine capture", () => {
  test("an opaque page reads as solid everywhere", () => {
    expect(map.sample(0, 0)).toBe(1);
    expect(map.sample(WIDTH / 2, HEIGHT / 2)).toBe(1);
    expect(map.sample(WIDTH - 1, HEIGHT - 1)).toBe(1);
  });

  test("transparent regions of the capture stay void", () => {
    // A page can legitimately be see-through; assuming otherwise would let
    // tools "damage" pixels that were never there.
    const ctx = source.getContext("2d");
    ctx.clearRect(0, 0, 120, 120);
    map.reset(source, WIDTH, HEIGHT);

    expect(map.sample(40, 40)).toBe(0);
    expect(map.sample(300, 200)).toBe(1);
  });

  test("points outside the page are void", () => {
    expect(map.sample(-1, 10)).toBe(0);
    expect(map.sample(10, -1)).toBe(0);
    expect(map.sample(WIDTH, 10)).toBe(0);
    expect(map.sample(10, HEIGHT)).toBe(0);
  });
});

describe("removal", () => {
  test("a removed disc is void inside and untouched outside", () => {
    removeDisc(map, 200, 150, 40);

    expect(map.sample(200, 150)).toBe(0);
    expect(map.sample(200, 185)).toBe(0);
    // Just beyond the rim the page survives.
    expect(map.sample(200, 195)).toBe(1);
    expect(map.sample(20, 20)).toBe(1);
  });

  test("a cut is detected along its stroke, not just its fill", () => {
    // The chainsaw kerf is a stroked line a few pixels wide; sampling it as a
    // fill would report the whole page intact.
    const kerf = new Path2D();
    kerf.moveTo(50, 150);
    kerf.lineTo(350, 150);
    const nicks = new Path2D();
    map.removeCut(kerf, nicks, 8, { x0: 50, y0: 140, x1: 350, y1: 160 });

    expect(map.sample(200, 150)).toBe(0);
    expect(map.sample(200, 152)).toBe(0);
    expect(map.sample(200, 170)).toBe(1);
  });

  test("overlapping removals stay void where they meet", () => {
    removeDisc(map, 180, 150, 30);
    removeDisc(map, 220, 150, 30);

    expect(map.sample(200, 150)).toBe(0);
    expect(map.sample(180, 150)).toBe(0);
    expect(map.sample(220, 150)).toBe(0);
  });
});

describe("repair", () => {
  test("the newest operation wins, so a restore reopens the page", () => {
    removeDisc(map, 200, 150, 50);
    expect(map.sample(200, 150)).toBe(0);

    map.restoreDisc(200, 150, 50);

    expect(map.sample(200, 150)).toBe(1);
  });

  test("removing again after a restore wins in turn", () => {
    removeDisc(map, 200, 150, 50);
    map.restoreDisc(200, 150, 50);
    removeDisc(map, 200, 150, 20);

    expect(map.sample(200, 150)).toBe(0);
    // Outside the second, smaller hole the repair still stands.
    expect(map.sample(200, 180)).toBe(1);
  });

  test("a restore cannot resurrect page that was never there", () => {
    const ctx = source.getContext("2d");
    ctx.clearRect(0, 0, 120, 120);
    map.reset(source, WIDTH, HEIGHT);

    map.restoreDisc(60, 60, 40);

    expect(map.sample(60, 60)).toBe(0);
  });

  test("restoreAll returns the whole page to pristine", () => {
    removeDisc(map, 100, 100, 40);
    removeDisc(map, 300, 200, 40);

    map.restoreAll();

    expect(map.sample(100, 100)).toBe(1);
    expect(map.sample(300, 200)).toBe(1);
  });
});

describe("bounded history", () => {
  test("sustained damage in one cell keeps answering correctly after flattening", () => {
    // Well past the per-cell flatten threshold: the oldest wounds are
    // rasterized into the resolved plane and their Path2D state is dropped.
    // Every one of them must still read as a hole.
    const centres = [];
    for (let i = 0; i < 80; i++) {
      const x = 200 + (i % 8);
      const y = 150 + Math.floor(i / 8);
      centres.push([x, y]);
      removeDisc(map, x, y, 6);
    }

    for (const [x, y] of centres) expect(map.sample(x, y)).toBe(0);
    // And a point far from the barrage is still page.
    expect(map.sample(40, 40)).toBe(1);
  });

  test("a restore issued after flattening still wins over the flattened plane", () => {
    for (let i = 0; i < 80; i++) removeDisc(map, 200 + (i % 5), 150 + (i % 5), 8);
    expect(map.sample(200, 150)).toBe(0);

    map.restoreDisc(200, 150, 30);

    expect(map.sample(200, 150)).toBe(1);
  });
});

describe("structural topology", () => {
  test("states distinguish void, material and removed material", () => {
    const ctx = source.getContext("2d");
    ctx.clearRect(0, 0, 60, 60);
    map.reset(source, WIDTH, HEIGHT);

    removeDisc(map, 200, 150, 30);

    expect(map.stateAt(20, 20)).toBe(0); // never existed
    expect(map.stateAt(320, 250)).toBe(1); // surviving page
    expect(map.stateAt(200, 150)).toBe(2); // torn out
  });

  test("a repair marks removed material as material again", () => {
    removeDisc(map, 200, 150, 30);
    expect(map.stateAt(200, 150)).toBe(2);

    map.restoreDisc(200, 150, 30);

    expect(map.stateAt(200, 150)).toBe(1);
  });
});

describe("lifecycle", () => {
  test("an unreset map reports everything as void rather than throwing", () => {
    const fresh = new OpacityMap();
    expect(fresh.sample(10, 10)).toBe(0);
    expect(fresh.stateAt(10, 10)).toBe(0);
  });

  test("dispose is safe and leaves the map inert", () => {
    removeDisc(map, 200, 150, 30);
    map.dispose();

    expect(() => map.sample(200, 150)).not.toThrow();
  });
});
