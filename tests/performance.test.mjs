import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { detectInitialQuality, PerformanceMonitor, QUALITY_PROFILES } from "../src/performance.ts";

/** Controllable clock: the monitor samples `performance.now()` directly. */
const realNow = performance.now.bind(performance);
let clock = 0;
beforeEach(() => {
  clock = 0;
  performance.now = () => clock;
});
afterEach(() => {
  performance.now = realNow;
});

function measurement(overrides = {}) {
  return {
    cadenceMs: 16.7,
    frameMs: 2,
    updateMs: 1,
    surfaceMs: 0.3,
    renderMs: 0.5,
    postFXMs: 0.2,
    entities: { particles: 0, flames: 0, bodies: 0, bugs: 0 },
    quality: "high",
    pixelRatio: 1,
    effectsPixelRatio: 1,
    targetFps: 60,
    ...overrides,
  };
}

/** Feed `frames` and advance past the sample window so the last one publishes. */
function run(monitor, frames, intervalMs = 1000) {
  let recommendation = null;
  for (let i = 0; i < frames.length; i++) {
    if (i === frames.length - 1) clock = intervalMs + 1;
    else clock += 1;
    recommendation = monitor.record(frames[i]);
  }
  return recommendation;
}

describe("PerformanceMonitor percentiles", () => {
  test("p50/p95/p99/max over a known distribution", () => {
    const monitor = new PerformanceMonitor(undefined, "high");
    // 100 distinct frame times 1..100 ms, shuffled deterministically so the
    // sort inside stats() is actually exercised.
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    for (let i = values.length - 1; i > 0; i--) {
      const j = (i * 7919) % (i + 1);
      [values[i], values[j]] = [values[j], values[i]];
    }
    run(
      monitor,
      values.map((v) => measurement({ cadenceMs: v, frameMs: v / 2 })),
    );
    const snap = monitor.snapshot;
    // percentile(): ceil(n * f) - 1 over the sorted values.
    expect(snap.frame.p50).toBe(50);
    expect(snap.frame.p95).toBe(95);
    expect(snap.frame.p99).toBe(99);
    expect(snap.frame.max).toBe(100);
    expect(snap.frame.average).toBeCloseTo(50.5, 6);
    // CPU stats come from the frameMs channel of the same ring.
    expect(snap.cpu.p50).toBe(25);
    expect(snap.cpu.p95).toBe(47.5);
    expect(snap.cpu.max).toBe(50);
    expect(snap.frames).toBe(100);
  });

  test("ring buffer keeps a rolling window once past capacity", () => {
    const monitor = new PerformanceMonitor(undefined, "high");
    // 240-slot ring: 300 slow frames followed by 240 fast ones must leave no
    // trace of the slow ones in the published stats.
    const frames = [
      ...Array.from({ length: 300 }, () => measurement({ cadenceMs: 100 })),
      ...Array.from({ length: 240 }, () => measurement({ cadenceMs: 10 })),
    ];
    run(monitor, frames);
    const snap = monitor.snapshot;
    expect(snap.frame.p50).toBe(10);
    expect(snap.frame.max).toBe(10);
    // `frames` counts every observed frame, not just the ring's worth.
    expect(snap.frames).toBe(540);
  });

  test("long frames and dropped-frame estimates come from the cadence channel", () => {
    const monitor = new PerformanceMonitor(undefined, "high");
    // 16.7ms budget at 60fps: a 50ms frame is long and dropped ~2 frames.
    const frames = [
      ...Array.from({ length: 30 }, () => measurement({ cadenceMs: 16.7 })),
      ...Array.from({ length: 10 }, () => measurement({ cadenceMs: 50 })),
    ];
    run(monitor, frames);
    const snap = monitor.snapshot;
    expect(snap.longFrames).toBe(10);
    expect(snap.longFrameRate).toBeCloseTo(10 / 40, 6);
    expect(snap.estimatedDroppedFrames).toBe(20);
  });
});

describe("PerformanceMonitor adaptive quality", () => {
  test("sustained p95 overload steps high down to balanced", () => {
    const monitor = new PerformanceMonitor(undefined, "high");
    // 60fps → 16.67ms budget; p95 threshold is 72% of it (12ms).
    const rec = run(
      monitor,
      Array.from({ length: 30 }, () => measurement({ frameMs: 14 })),
    );
    expect(rec).toBe("balanced");
    // The updated reason rides the *next* snapshot (the recommendation itself
    // is what the engine acts on immediately).
    run(
      monitor,
      Array.from({ length: 15 }, () => measurement({ frameMs: 2, quality: "balanced" })),
      2100,
    );
    expect(monitor.snapshot.qualityReason).toContain("p95 engine cost");
  });

  test("a single peak spike does not downgrade until it repeats", () => {
    const monitor = new PerformanceMonitor(undefined, "high");
    // Cool frames with one giant spike: peak-only pressure must wait for a
    // second sample before downgrading (shader-warmup forgiveness).
    const spiky = [
      ...Array.from({ length: 29 }, () => measurement({ frameMs: 2 })),
      measurement({ frameMs: 40 }),
    ];
    expect(run(monitor, spiky)).toBeNull();
    clock = 1002;
    const monitorClockStart = clock;
    let rec = null;
    for (let i = 0; i < 30; i++) {
      clock = i === 29 ? monitorClockStart + 1001 : clock + 1;
      rec = monitor.record(spiky[i]);
    }
    expect(rec).toBe("balanced");
  });

  test("persistent cadence pressure catches deferred canvas work", () => {
    const monitor = new PerformanceMonitor(undefined, "high");
    const rec = run(
      monitor,
      Array.from({ length: 30 }, () => measurement({ cadenceMs: 34, frameMs: 6 })),
    );
    expect(rec).toBe("balanced");
  });

  test("a meaningful minority of deferred late frames can trigger adaptation", () => {
    const monitor = new PerformanceMonitor(undefined, "high");
    const frames = [
      ...Array.from({ length: 26 }, () => measurement({ cadenceMs: 16.7, frameMs: 6 })),
      ...Array.from({ length: 4 }, () => measurement({ cadenceMs: 34, frameMs: 6 })),
    ];
    expect(run(monitor, frames)).toBe("balanced");
  });

  test("catastrophic sustained overload skips the ineffective middle tier", () => {
    const monitor = new PerformanceMonitor(undefined, "high");
    const rec = run(
      monitor,
      Array.from({ length: 30 }, () => measurement({ cadenceMs: 55, frameMs: 30 })),
    );
    expect(rec).toBe("low");
  });

  test("slow cadence alone does not blame a cheap engine", () => {
    const monitor = new PerformanceMonitor(undefined, "high");
    const rec = run(
      monitor,
      Array.from({ length: 30 }, () => measurement({ cadenceMs: 50, frameMs: 2 })),
    );
    expect(rec).toBeNull();
  });

  test("sustained headroom climbs low back toward balanced after five cool samples", () => {
    const monitor = new PerformanceMonitor(undefined, "low");
    let rec = null;
    let windowStart = 0;
    for (let sample = 0; sample < 5; sample++) {
      for (let i = 0; i < 20; i++) {
        clock = i === 19 ? windowStart + 1001 : clock + 1;
        rec = monitor.record(measurement({ frameMs: 1, quality: "low" }));
      }
      windowStart = clock;
      if (sample < 4) expect(rec).toBeNull();
    }
    expect(rec).toBe("balanced");
  });

  test("disabled or non-adaptive monitors never recommend", () => {
    const off = new PerformanceMonitor(false, "high");
    expect(
      run(
        off,
        Array.from({ length: 30 }, () => measurement({ frameMs: 50 })),
      ),
    ).toBeNull();

    const pinned = new PerformanceMonitor(undefined, "high", false);
    expect(
      run(
        pinned,
        Array.from({ length: 30 }, () => measurement({ frameMs: 50 })),
      ),
    ).toBeNull();
  });
});

describe("quality profiles and detection", () => {
  test("explicit quality mode wins over device detection", () => {
    expect(detectInitialQuality("low")).toBe("low");
    expect(detectInitialQuality("high")).toBe("high");
  });

  test("data-saver devices start in the low-cost profile", () => {
    const previous = Object.getOwnPropertyDescriptor(navigator, "connection");
    Object.defineProperty(navigator, "connection", {
      configurable: true,
      value: { saveData: true },
    });
    try {
      expect(detectInitialQuality("auto")).toBe("low");
    } finally {
      if (previous) Object.defineProperty(navigator, "connection", previous);
      else delete navigator.connection;
    }
  });

  test("profiles degrade monotonically", () => {
    const { high, balanced, low } = QUALITY_PROFILES;
    expect(high.particleScale).toBeGreaterThan(balanced.particleScale);
    expect(balanced.particleScale).toBeGreaterThan(low.particleScale);
    expect(high.physicsIterations).toBeGreaterThanOrEqual(balanced.physicsIterations);
    expect(balanced.physicsIterations).toBeGreaterThanOrEqual(low.physicsIterations);
    expect(high.postFX).toBe(true);
    expect(balanced.postFX).toBe(false);
    expect(low.postFX).toBe(false);
  });
});
