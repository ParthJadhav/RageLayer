import { beforeEach, describe, expect, test } from "bun:test";
import { Body, MAX_BODIES, PhysicsWorld } from "../src/physics.ts";
import "./support/dom.mjs";

/**
 * The solver is what turns "pixels were removed" into "pieces fell". These
 * tests pin the properties consumers actually depend on: debris obeys gravity,
 * comes to rest on the floor instead of tunnelling through it, sleeps when
 * settled, and can never grow past the budget that keeps frame time bounded.
 */

function square(cx, cy, size = 20) {
  const h = size / 2;
  return [cx - h, cy - h, cx + h, cy - h, cx + h, cy + h, cx - h, cy + h];
}

function box(cx, cy, size = 20, init = {}) {
  return new Body({ points: square(cx, cy, size), ttl: Number.POSITIVE_INFINITY, ...init });
}

/** Advance the world by `seconds` in fixed, solver-friendly slices. */
function simulate(world, seconds, step = 1 / 60) {
  for (let elapsed = 0; elapsed < seconds; elapsed += step) world.step(step);
}

let world;

beforeEach(() => {
  world = new PhysicsWorld({ gravity: 2000, iterations: 8 });
  world.setBounds(800, 600);
});

describe("bodies", () => {
  test("a polygon gets a centre of mass and a bounding radius", () => {
    const body = box(100, 100, 40);

    expect(body.x).toBeCloseTo(100, 5);
    expect(body.y).toBeCloseTo(100, 5);
    expect(body.radius).toBeGreaterThan(0);
    expect(body.dead).toBe(false);
  });

  test("winding is normalised so mass is never negative", () => {
    // Clockwise and counter-clockwise descriptions of the same square must
    // produce the same body; a negative area would invert gravity.
    const ccw = new Body({ points: [0, 0, 20, 0, 20, 20, 0, 20] });
    const cw = new Body({ points: [0, 0, 0, 20, 20, 20, 20, 0] });

    expect(ccw.invMass).toBeGreaterThan(0);
    expect(cw.invMass).toBeGreaterThan(0);
    expect(cw.invMass).toBeCloseTo(ccw.invMass, 6);
  });

  test("a fixed body has no inverse mass and never moves", () => {
    const anchor = box(100, 100, 40, { fixed: true });
    world.add(anchor);

    simulate(world, 0.5);

    expect(anchor.invMass).toBe(0);
    expect(anchor.y).toBeCloseTo(100, 5);
  });

  test("an impulse off centre imparts spin as well as speed", () => {
    const body = box(100, 100, 40);

    body.applyImpulse(50, 0, 100, 80);

    expect(body.vx).toBeGreaterThan(0);
    expect(body.av).not.toBe(0);
  });
});

describe("simulation", () => {
  test("debris falls under gravity", () => {
    const body = world.add(box(400, 100));

    simulate(world, 0.25);

    expect(body.y).toBeGreaterThan(100);
    expect(body.vy).toBeGreaterThan(0);
  });

  test("a falling piece comes to rest on the floor instead of tunnelling", () => {
    const body = world.add(box(400, 100, 20));

    simulate(world, 3);

    expect(body.y).toBeLessThan(600);
    expect(body.y).toBeGreaterThan(560);
    expect(Math.abs(body.vy)).toBeLessThan(20);
  });

  test("the side walls contain debris", () => {
    const left = world.add(box(40, 100, 20, { vx: -3000 }));
    const right = world.add(box(760, 100, 20, { vx: 3000 }));

    simulate(world, 1);

    expect(left.x).toBeGreaterThan(-40);
    expect(right.x).toBeLessThan(840);
  });

  test("a settled heap reports itself inactive so frames can be skipped", () => {
    for (let i = 0; i < 6; i++) world.add(box(400 + i * 22, 100, 20));
    expect(world.active).toBe(true);

    simulate(world, 6);

    expect(world.count).toBe(6);
    expect(world.active).toBe(false);
  });

  test("a blast wakes a heap that had gone to sleep", () => {
    world.add(box(400, 100, 20));
    simulate(world, 6);
    expect(world.active).toBe(false);

    world.blast(400, 580, 200, 5000);

    expect(world.active).toBe(true);
  });

  test("stacked pieces pile up rather than sinking into each other", () => {
    const lower = world.add(box(400, 560, 20));
    const upper = world.add(box(400, 500, 20));

    simulate(world, 3);

    // The upper piece stays above the lower one, by roughly a piece's height.
    expect(upper.y).toBeLessThan(lower.y);
    expect(lower.y - upper.y).toBeGreaterThan(10);
  });
});

describe("forces", () => {
  test("a blast pushes debris away from its centre", () => {
    const body = world.add(box(400, 300, 20));

    world.blast(300, 300, 400, 5000);

    expect(body.vx).toBeGreaterThan(0);
  });

  test("a blast outside its radius does nothing", () => {
    const body = world.add(box(400, 300, 20));

    world.blast(50, 300, 100, 5000);

    expect(body.vx).toBe(0);
  });

  test("pull draws debris toward a point and reports what it moved", () => {
    const body = world.add(box(500, 300, 20));

    const moved = world.pull(300, 300, 400, 4000, 1 / 60);

    expect(moved).toBeGreaterThan(0);
    expect(body.vx).toBeLessThan(0);
  });

  test("attract consumes debris that reaches the singularity", () => {
    world.add(box(300, 300, 20));

    const eaten = world.attract(300, 300, 5000, 1 / 60, 40);

    expect(eaten.length).toBe(1);
  });

  test("launchNearest throws the closest piece along the aim direction", () => {
    const near = world.add(box(320, 300, 20));
    const far = world.add(box(700, 300, 20));

    expect(world.launchNearest(300, 300, 200, 1, 0, 900)).toBe(true);

    expect(near.vx).toBeCloseTo(900, 5);
    expect(near.vy).toBeCloseTo(0, 5);
    // Only the nearest piece is picked up.
    expect(far.vx).toBe(0);
  });

  test("launchNearest reports failure when nothing is in reach", () => {
    world.add(box(700, 300, 20));

    expect(world.launchNearest(100, 100, 80, 1, 0, 900)).toBe(false);
  });
});

describe("budget", () => {
  test("the world never exceeds the body limit", () => {
    for (let i = 0; i < MAX_BODIES + 50; i++) world.add(box(100 + (i % 600), 100, 8));

    expect(world.count).toBeLessThanOrEqual(MAX_BODIES);
  });

  test("lowering the limit trims the oldest debris immediately", () => {
    for (let i = 0; i < 40; i++) world.add(box(100 + i * 10, 100, 8));

    world.setBodyLimit(10);

    expect(world.count).toBeLessThanOrEqual(10);
  });

  test("clear removes everything", () => {
    for (let i = 0; i < 10; i++) world.add(box(100 + i * 20, 100, 8));

    world.clear();

    expect(world.count).toBe(0);
  });

  test("expired debris is retired on its own", () => {
    world.add(box(400, 560, 20, { ttl: 0.05 }));
    expect(world.count).toBe(1);

    simulate(world, 4);

    expect(world.count).toBe(0);
  });
});
