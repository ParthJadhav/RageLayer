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
    toolsMs: 0.2,
    flamesMs: 0.15,
    bugsMs: 0.1,
    singularityMs: 0.05,
    particlesMs: 0.25,
    physicsMs: 0.2,
    render: { wet: 2, puffs: 4, solids: 6, hot: 8, flames: 3, bodies: 5 },
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

describe("PerformanceMonitor extended telemetry", () => {
  test("subsystem breakdown and render composition average over the window", () => {
    const monitor = new PerformanceMonitor(undefined, "high");
    run(
      monitor,
      Array.from({ length: 20 }, () => measurement()),
    );
    const snap = monitor.snapshot;
    for (const key of [
      "toolsMs",
      "flamesMs",
      "bugsMs",
      "singularityMs",
      "particlesMs",
      "physicsMs",
    ]) {
      expect(typeof snap.breakdown[key]).toBe("number");
    }
    expect(snap.breakdown.toolsMs).toBeCloseTo(0.2, 5);
    expect(snap.breakdown.physicsMs).toBeCloseTo(0.2, 5);
    expect(snap.render).toEqual({ wet: 2, puffs: 4, solids: 6, hot: 8, flames: 3, bodies: 5 });
  });

  test("pushed counters land in the snapshot and reset per window", () => {
    const monitor = new PerformanceMonitor(undefined, "high");
    monitor.count("surfaceUploads");
    monitor.count("surfaceUploadPixels", 10_000);
    monitor.count("surfaceCoverage", 0.5);
    monitor.count("surfaceReconciles");
    monitor.count("surfaceCoverage", 1);
    monitor.count("opacitySamples", 40);
    monitor.count("opacityPathTests", 120);
    monitor.count("opacityFlattens");
    monitor.count("recomposeMs", 3);
    monitor.count("recomposeMs", 5);
    monitor.count("gpuSurfaceMs", 1.5);
    monitor.count("gpuPostFXMs", 0.5);
    run(
      monitor,
      Array.from({ length: 10 }, () => measurement()),
    );
    const snap = monitor.snapshot;
    expect(snap.surface).toEqual({
      uploads: 1,
      uploadPixels: 10_000,
      reconciles: 1,
      coverage: 0.75,
    });
    expect(snap.opacity).toEqual({ samples: 40, pathTests: 120, flattens: 1 });
    expect(snap.capture).toEqual({ recomposes: 2, recomposeMs: 4 });
    expect(snap.gpu.surfaceMs).toBe(1.5);
    expect(snap.gpu.postFXMs).toBe(0.5);
    // No timer extension ever reported in, so gpu stays unavailable.
    expect(snap.gpu.available).toBe(false);

    // The next window starts from zero for every pushed counter.
    run(
      monitor,
      Array.from({ length: 10 }, () => measurement()),
      2100,
    );
    const next = monitor.snapshot;
    expect(next.surface).toEqual({ uploads: 0, uploadPixels: 0, reconciles: 0, coverage: 0 });
    expect(next.opacity).toEqual({ samples: 0, pathTests: 0, flattens: 0 });
    expect(next.capture).toEqual({ recomposes: 0, recomposeMs: 0 });
    expect(next.gpu).toEqual({ surfaceMs: 0, postFXMs: 0, available: false });
  });

  test("gpu availability is sticky once a timer extension reports in", () => {
    const monitor = new PerformanceMonitor(undefined, "high");
    monitor.count("gpuTimerAvailable", 0);
    run(
      monitor,
      Array.from({ length: 10 }, () => measurement()),
    );
    expect(monitor.snapshot.gpu.available).toBe(true);
    run(
      monitor,
      Array.from({ length: 10 }, () => measurement()),
      2100,
    );
    expect(monitor.snapshot.gpu.available).toBe(true);
  });

  test("new snapshot sections exist with numeric zeros before any sample", () => {
    const monitor = new PerformanceMonitor(undefined, "high");
    const snap = monitor.snapshot;
    for (const section of ["render", "surface", "opacity", "capture"]) {
      for (const value of Object.values(snap[section])) {
        expect(typeof value).toBe("number");
      }
    }
    expect(snap.gpu.surfaceMs).toBe(0);
    expect(snap.gpu.postFXMs).toBe(0);
    expect(snap.gpu.available).toBe(false);
    expect(typeof snap.breakdown.toolsMs).toBe("number");
  });

  test("disabled monitors ignore pushed counters", () => {
    const off = new PerformanceMonitor(false, "high");
    off.count("surfaceUploads", 5);
    expect(off.snapshot.surface.uploads).toBe(0);
  });
});

describe("PerformanceMonitor rate-vs-quality ladder", () => {
  test("outgrowing a fast display's budget caps the rate before quality", () => {
    const monitor = new PerformanceMonitor(undefined, "high");
    // 120fps native → 8.33ms budget; 8ms p95 fails its 72% share but fits the
    // 60fps budget comfortably, so the tier holds and only the rate caps.
    const rec = run(
      monitor,
      Array.from({ length: 30 }, () => measurement({ frameMs: 8, targetFps: 120 })),
    );
    expect(rec).toBeNull();
    expect(monitor.rateCap60).toBe(true);
    run(
      monitor,
      Array.from({ length: 15 }, () => measurement({ frameMs: 2, targetFps: 60 })),
      2100,
    );
    expect(monitor.snapshot.qualityReason).toContain("holding full quality at 60fps");
  });

  test("a capped tier that fails even the 60fps budget drops to balanced", () => {
    const monitor = new PerformanceMonitor(undefined, "high");
    run(
      monitor,
      Array.from({ length: 30 }, () => measurement({ frameMs: 8, targetFps: 120 })),
    );
    expect(monitor.rateCap60).toBe(true);
    // While capped the engine reports targetFps 60; 14ms breaks that too.
    clock = 1002;
    let rec = null;
    for (let i = 0; i < 30; i++) {
      if (i === 29) clock = 2100;
      else clock += 1;
      rec = monitor.record(measurement({ frameMs: 14, targetFps: 60 }));
    }
    expect(rec).toBe("balanced");
  });

  test("the cap releases only with headroom against the native cadence", () => {
    const monitor = new PerformanceMonitor(undefined, "high");
    // Teach the monitor it is on a ~120Hz display (uncapping requires it).
    monitor.observeRaf(1);
    monitor.observeRaf(9.4);
    run(
      monitor,
      Array.from({ length: 30 }, () => measurement({ frameMs: 8, targetFps: 120 })),
    );
    expect(monitor.rateCap60).toBe(true);
    // Cool against 60fps but NOT against 8.4ms native (p95 5 > 8.4 * 0.45):
    // five cool windows must leave the cap in place.
    for (let window = 0; window < 5; window++) {
      run(
        monitor,
        Array.from({ length: 30 }, () => measurement({ frameMs: 5, targetFps: 60 })),
        1000 * (window + 2) + 100,
      );
    }
    expect(monitor.rateCap60).toBe(true);
    // Deep headroom (2ms against an 8.4ms native budget) releases it.
    for (let window = 0; window < 5; window++) {
      run(
        monitor,
        Array.from({ length: 30 }, () => measurement({ frameMs: 2, targetFps: 60 })),
        1000 * (window + 8) + 100,
      );
    }
    expect(monitor.rateCap60).toBe(false);
    run(
      monitor,
      Array.from({ length: 15 }, () => measurement({ frameMs: 2, targetFps: 120 })),
      1000 * 14,
    );
    expect(monitor.snapshot.qualityReason).toContain("restored the native refresh cadence");
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
