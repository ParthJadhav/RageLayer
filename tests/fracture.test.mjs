import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { convexHull, gridCells, shardBudget, voronoiCells } from "../src/fracture.ts";
import { pointInPolygon, polygonArea2 } from "../src/topology.ts";

/**
 * Deterministic Math.random (mulberry32) so the geometry assertions are exact
 * and reproducible instead of flaking on an unlucky draw.
 */
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const realRandom = Math.random;
beforeEach(() => {
  Math.random = seededRandom(0xdd5eed);
});
afterEach(() => {
  Math.random = realRandom;
});

/** All cross products around the polygon share a sign (or are ~zero). */
function isConvex(points) {
  const n = points.length / 2;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const k = (i + 2) % n;
    const cross =
      (points[j * 2] - points[i * 2]) * (points[k * 2 + 1] - points[j * 2 + 1]) -
      (points[j * 2 + 1] - points[i * 2 + 1]) * (points[k * 2] - points[j * 2]);
    if (Math.abs(cross) < 1e-9) continue;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }
  return true;
}

describe("convexHull", () => {
  test("recovers the square from corners plus interior points", () => {
    const hull = convexHull([0, 0, 10, 0, 10, 10, 0, 10, 5, 5, 2, 7, 8, 3]);
    expect(hull).toHaveLength(8);
    const corners = new Set(["0,0", "10,0", "10,10", "0,10"]);
    for (let i = 0; i < hull.length; i += 2) {
      expect(corners.has(`${hull[i]},${hull[i + 1]}`)).toBe(true);
    }
  });

  test("hull of random points is convex and contains every input point", () => {
    const points = [];
    for (let i = 0; i < 60; i++) points.push(Math.random() * 200 - 100, Math.random() * 160 - 80);
    const hull = convexHull(points);
    expect(hull.length).toBeGreaterThanOrEqual(6);
    expect(isConvex(hull)).toBe(true);
    // Containment is tested on a hull grown by an epsilon-free trick: hull
    // vertices are input points, so strict pointInPolygon can reject them.
    // Test the slightly shrunk input toward the hull centroid instead.
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < hull.length; i += 2) {
      cx += hull[i] / (hull.length / 2);
      cy += hull[i + 1] / (hull.length / 2);
    }
    for (let i = 0; i < points.length; i += 2) {
      const x = points[i] + (cx - points[i]) * 1e-6;
      const y = points[i + 1] + (cy - points[i + 1]) * 1e-6;
      expect(pointInPolygon(hull, x, y)).toBe(true);
    }
  });

  test("hull area is at least the area of any triangle of input points", () => {
    const points = [0, 0, 40, 5, 20, 30, 18, 12, 25, 8];
    const hull = convexHull(points);
    const hullArea = Math.abs(polygonArea2(hull)) / 2;
    const triArea = Math.abs(polygonArea2([0, 0, 40, 5, 20, 30])) / 2;
    expect(hullArea).toBeGreaterThanOrEqual(triArea);
  });

  test("degenerate inputs are returned unchanged", () => {
    expect(convexHull([1, 2])).toEqual([1, 2]);
    expect(convexHull([1, 2, 3, 4])).toEqual([1, 2, 3, 4]);
  });
});

describe("voronoiCells", () => {
  test("cells are convex, near their own region, and conserve the shattered area", () => {
    const cx = 100;
    const cy = 80;
    const radius = 60;
    const count = 14;

    // Replay the generator's own random sequence to reconstruct the outer
    // boundary it clipped against: 2 draws per site, then 2 per hull vertex.
    const replay = seededRandom(0xdd5eed);
    for (let i = 0; i < count * 2; i++) replay();
    const TAU = Math.PI * 2;
    const sides = 13;
    const hull = [];
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * TAU;
      const r = radius * (0.86 + replay() * 0.34);
      hull.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    const hullArea = Math.abs(polygonArea2(hull)) / 2;

    const cells = voronoiCells(cx, cy, radius, count);
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.length).toBeLessThanOrEqual(count);

    let total = 0;
    for (const cell of cells) {
      expect(cell.length).toBeGreaterThanOrEqual(6);
      // Interior cells are convex; rim cells may inherit the deliberately
      // ragged (slightly concave) outer boundary, so convexity is only
      // asserted for cells that don't touch the rim.
      const touchesRim = (() => {
        for (let i = 0; i < cell.length; i += 2) {
          if (Math.hypot(cell[i] - cx, cell[i + 1] - cy) > radius * 0.85) return true;
        }
        return false;
      })();
      if (!touchesRim) expect(isConvex(cell)).toBe(true);
      // Every vertex stays inside the jittered boundary's outer radius.
      for (let i = 0; i < cell.length; i += 2) {
        expect(Math.hypot(cell[i] - cx, cell[i + 1] - cy)).toBeLessThanOrEqual(radius * 1.2 + 1e-6);
      }
      total += Math.abs(polygonArea2(cell)) / 2;
    }
    // The cells partition the clipped boundary: no area invented, none lost
    // (up to float noise). Dropped empty cells would show up here as a deficit.
    expect(total).toBeCloseTo(hullArea, 6);
  });

  test("single-site shatter returns the whole clipped region", () => {
    const cells = voronoiCells(0, 0, 40, 1);
    expect(cells).toHaveLength(1);
    expect(Math.abs(polygonArea2(cells[0])) / 2).toBeGreaterThan(Math.PI * 40 * 40 * 0.5);
  });
});

describe("gridCells", () => {
  test("partitions the rectangle exactly, even with interior jitter", () => {
    for (const jitter of [0, 0.28, 0.5]) {
      const cells = gridCells(10, 20, 300, 200, 4, 3, jitter);
      expect(cells).toHaveLength(12);
      let total = 0;
      for (const cell of cells) {
        expect(cell).toHaveLength(8);
        total += Math.abs(polygonArea2(cell)) / 2;
      }
      // Interior vertices are shared between neighbours and the outer ring is
      // never jittered, so the split conserves the area exactly.
      expect(total).toBeCloseTo(300 * 200, 6);
    }
  });

  test("jitter never moves the outer boundary", () => {
    const cells = gridCells(0, 0, 100, 100, 2, 2, 0.5);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const cell of cells) {
      for (let i = 0; i < cell.length; i += 2) {
        minX = Math.min(minX, cell[i]);
        maxX = Math.max(maxX, cell[i]);
        minY = Math.min(minY, cell[i + 1]);
        maxY = Math.max(maxY, cell[i + 1]);
      }
    }
    expect(minX).toBe(0);
    expect(minY).toBe(0);
    expect(maxX).toBe(100);
    expect(maxY).toBe(100);
  });
});

describe("shardBudget", () => {
  test("clamps to the 4..26 range", () => {
    expect(shardBudget(1, 1)).toBe(4);
    expect(shardBudget(0, 2.2)).toBe(4);
    expect(shardBudget(10_000, 2.2)).toBe(26);
  });

  test("scales linearly with radius and quality between the clamps", () => {
    expect(shardBudget(160, 1)).toBe(10);
    expect(shardBudget(160, 1.4)).toBe(14);
    expect(shardBudget(80, 2.2)).toBe(11);
    // Monotonic in both arguments.
    expect(shardBudget(200, 1.4)).toBeGreaterThanOrEqual(shardBudget(160, 1.4));
    expect(shardBudget(160, 2.2)).toBeGreaterThanOrEqual(shardBudget(160, 1.4));
  });
});
