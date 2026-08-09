import { describe, expect, test } from "bun:test";
import { findDetachedPolygons, polygonArea2, surfaceRuns } from "../src/topology.ts";

function distanceToSegment(x, y, [ax, ay, bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(x - (ax + dx * t), y - (ay + dy * t));
}

function detached(cuts, bounds, pristineVoid = () => false) {
  const removed = (x, y) => cuts.some((cut) => distanceToSegment(x, y, cut) < 2.05);
  return findDetachedPolygons(
    {
      width: 200,
      height: 200,
      stateAt(x, y) {
        if (removed(x, y)) return 2;
        return pristineVoid(x, y) ? 0 : 1;
      },
    },
    bounds,
  );
}

describe("material topology", () => {
  test("an open cut releases nothing", () => {
    expect(
      detached(
        [
          [50.7, 50.3, 149.4, 51.1],
          [149.4, 51.1, 150.2, 149.8],
        ],
        { x0: 50, y0: 50, x1: 151, y1: 150 },
      ),
    ).toHaveLength(0);
  });

  test("an imperfect endpoint still closes the physical kerf", () => {
    const pieces = detached(
      [
        [50.7, 50.3, 149.4, 51.1],
        [149.4, 51.1, 150.2, 149.8],
        [150.2, 149.8, 49.8, 150.6],
        [49.8, 150.6, 52.8, 51.9],
      ],
      { x0: 49, y0: 50, x1: 151, y1: 151 },
    );
    expect(pieces).toHaveLength(1);
    expect(Math.abs(polygonArea2(pieces[0])) / 2).toBeGreaterThan(8_000);
  });

  test("a self-crossing trail releases the closed lobe", () => {
    const pieces = detached(
      [
        [40.3, 40.6, 160.1, 160.4],
        [160.1, 160.4, 39.7, 159.8],
        [39.7, 159.8, 160.5, 39.9],
      ],
      { x0: 39, y0: 39, x1: 161, y1: 161 },
    );
    expect(pieces).toHaveLength(1);
  });

  test("the document edge can complete a cut without dropping the main sheet", () => {
    const pieces = detached(
      [
        [50.4, 0, 50.7, 100.3],
        [50.7, 100.3, 150.2, 99.7],
        [150.2, 99.7, 150.6, 0],
      ],
      { x0: 50, y0: 0, x1: 151, y1: 101 },
    );
    expect(pieces).toHaveLength(1);
    expect(Math.abs(polygonArea2(pieces[0])) / 2).toBeLessThan(12_000);
  });

  test("a severed document corner falls instead of acting permanently anchored", () => {
    const pieces = detached(
      [[0, 72.4, 74.1, 0]],
      { x0: 0, y0: 0, x1: 75, y1: 73 },
    );
    expect(pieces).toHaveLength(1);
    expect(Math.abs(polygonArea2(pieces[0])) / 2).toBeGreaterThan(1_800);
    expect(Math.abs(polygonArea2(pieces[0])) / 2).toBeLessThan(3_500);
  });

  test("an existing hole participates in connectivity", () => {
    const pieces = detached(
      [
        [79.2, 100, 50.3, 100.2],
        [50.3, 100.2, 50.7, 50.3],
        [50.7, 50.3, 149.6, 50.8],
        [149.6, 50.8, 150.1, 100.3],
        [150.1, 100.3, 120.5, 100],
      ],
      { x0: 50, y0: 50, x1: 150, y1: 100 },
      (x, y) => Math.hypot(x - 100, y - 100) < 21,
    );
    expect(pieces).toHaveLength(1);
  });

  test("a stroke crossing void is clipped into independent material runs", () => {
    const runs = surfaceRuns(0, 50, 100, 50, (x, y) => Math.hypot(x - 50, y - 50) > 15);
    expect(runs).toHaveLength(2);
    expect(runs[0].x2).toBeCloseTo(35, 0);
    expect(runs[1].x1).toBeCloseTo(65, 0);
  });
});
