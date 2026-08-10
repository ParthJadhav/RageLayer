import type {
  PerformanceEntities,
  PerformanceFrameBreakdown,
  PerformanceOptions,
  PerformanceQuality,
  PerformanceQualityTier,
  PerformanceSnapshot,
} from "./types";

const DEFAULT_SAMPLE_INTERVAL = 1_000;
const MAX_FRAME_SAMPLES = 240;
const SIXTY_FPS_BUDGET = 1_000 / 60;

export interface QualityProfile {
  /** Skip alternate rAF callbacks on displays faster than ~90 Hz. */
  minFrameIntervalMs: number;
  particleScale: number;
  flameScale: number;
  bodyScale: number;
  physicsIterations: number;
  flameLayers: number;
  postFX: boolean;
}

export const QUALITY_PROFILES: Record<PerformanceQualityTier, QualityProfile> = {
  high: {
    minFrameIntervalMs: 0,
    particleScale: 1,
    flameScale: 1,
    bodyScale: 1,
    physicsIterations: 8,
    flameLayers: 5,
    postFX: true,
  },
  balanced: {
    // 120 Hz → 60 Hz, while 60/90 Hz displays keep their native cadence.
    minFrameIntervalMs: 10,
    particleScale: 0.72,
    flameScale: 0.75,
    bodyScale: 0.8,
    physicsIterations: 6,
    flameLayers: 4,
    postFX: false,
  },
  low: {
    minFrameIntervalMs: 10,
    particleScale: 0.32,
    flameScale: 0.35,
    bodyScale: 0.5,
    physicsIterations: 4,
    flameLayers: 2,
    postFX: false,
  },
};

export interface FrameMeasurement {
  cadenceMs: number;
  frameMs: number;
  updateMs: number;
  surfaceMs: number;
  renderMs: number;
  postFXMs: number;
  entities: PerformanceEntities;
  quality: PerformanceQualityTier;
  pixelRatio: number;
  effectsPixelRatio: number;
  targetFps: number;
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  values.sort((a, b) => a - b);
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * fraction) - 1));
  return values[index];
}

function average(values: Float32Array, count: number): number {
  let total = 0;
  for (let i = 0; i < count; i++) total += values[i];
  return count > 0 ? total / count : 0;
}

function max(values: Float32Array, count: number): number {
  let result = 0;
  for (let i = 0; i < count; i++) if (values[i] > result) result = values[i];
  return result;
}

function stats(values: Float32Array, count: number) {
  const copy = Array.from(values.subarray(0, count));
  return {
    average: average(values, count),
    p50: percentile(copy.slice(), 0.5),
    p95: percentile(copy.slice(), 0.95),
    p99: percentile(copy, 0.99),
    max: max(values, count),
  };
}

function memorySnapshot(): PerformanceSnapshot["memory"] {
  const memory = (
    performance as Performance & {
      memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
    }
  ).memory;
  return memory
    ? {
        usedJSHeapBytes: memory.usedJSHeapSize,
        totalJSHeapBytes: memory.totalJSHeapSize,
        heapLimitBytes: memory.jsHeapSizeLimit,
      }
    : null;
}

export function detectInitialQuality(mode: PerformanceQuality): PerformanceQualityTier {
  if (mode !== "auto") return mode;
  const capabilities = navigator as Navigator & {
    deviceMemory?: number;
    connection?: { saveData?: boolean };
  };
  if (capabilities.connection?.saveData) return "low";
  const memory = capabilities.deviceMemory;
  const cores = navigator.hardwareConcurrency;
  if ((memory != null && memory <= 2) || (cores > 0 && cores <= 2)) return "low";
  if ((memory != null && memory <= 4) || (cores > 0 && cores <= 4)) return "balanced";
  return "high";
}

/**
 * Allocation-free per-frame recorder. It allocates only when publishing the
 * once-per-second snapshot, keeping the measured hot path from perturbing it.
 */
export class PerformanceMonitor {
  private readonly enabled: boolean;
  private readonly adaptive: boolean;
  private readonly sampleIntervalMs: number;
  private readonly callbacks = new Set<(snapshot: PerformanceSnapshot) => void>();
  private readonly frame = new Float32Array(MAX_FRAME_SAMPLES);
  private readonly cadence = new Float32Array(MAX_FRAME_SAMPLES);
  private readonly update = new Float32Array(MAX_FRAME_SAMPLES);
  private readonly surface = new Float32Array(MAX_FRAME_SAMPLES);
  private readonly render = new Float32Array(MAX_FRAME_SAMPLES);
  private readonly postFX = new Float32Array(MAX_FRAME_SAMPLES);
  /** Valid samples in the ring buffers (≤ MAX_FRAME_SAMPLES). */
  private count = 0;
  /** Next ring slot to write; wraps so long windows keep a rolling sample. */
  private writeIndex = 0;
  /** Frames observed this window — may exceed the ring capacity. */
  private frames = 0;
  private sampleStartedAt = performance.now();
  private lastRafAt = 0;
  private displayIntervalMs = SIXTY_FPS_BUDGET;
  private captureMs: number | null = null;
  private qualityReason = "initial device capability";
  private coolSamples = 0;
  private peakSamples = 0;
  private latest: PerformanceSnapshot;
  private disposed = false;

  constructor(
    options: boolean | PerformanceOptions | undefined,
    initialQuality: PerformanceQualityTier,
    allowAdaptive = true,
  ) {
    const normalized = typeof options === "object" ? options : {};
    this.enabled = options !== false && (normalized.enabled ?? true);
    this.adaptive = allowAdaptive && (normalized.adaptive ?? true);
    this.sampleIntervalMs = Math.max(250, normalized.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL);
    if (normalized.onSample) this.callbacks.add(normalized.onSample);
    this.latest = this.emptySnapshot(initialQuality);
  }

  private emptySnapshot(quality: PerformanceQualityTier): PerformanceSnapshot {
    const zero = { average: 0, p50: 0, p95: 0, p99: 0, max: 0 };
    return {
      timestamp: performance.now(),
      windowMs: 0,
      fps: 0,
      targetFps: 60,
      frames: 0,
      frame: { ...zero },
      cpu: { ...zero },
      breakdown: { updateMs: 0, surfaceMs: 0, renderMs: 0, postFXMs: 0 },
      longFrames: 0,
      longFrameRate: 0,
      estimatedDroppedFrames: 0,
      quality,
      qualityReason: this.qualityReason,
      pixelRatio: 1,
      effectsPixelRatio: 1,
      entities: { particles: 0, flames: 0, bodies: 0, bugs: 0 },
      captureMs: null,
      memory: memorySnapshot(),
    };
  }

  get snapshot(): PerformanceSnapshot {
    return this.latest;
  }

  get nativeTargetFps(): number {
    // The smallest observed interval can be a one-off scheduler jitter, so do
    // not advertise a target above the common 120 Hz ceiling.
    return Math.max(30, Math.min(120, Math.round(1_000 / this.displayIntervalMs)));
  }

  onSample(callback: (snapshot: PerformanceSnapshot) => void): () => void {
    if (this.disposed) return () => {};
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  /** Release host callbacks when the owning engine is disposed. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.callbacks.clear();
    this.count = 0;
    this.writeIndex = 0;
    this.frames = 0;
    this.captureMs = null;
  }

  setCaptureDuration(durationMs: number) {
    if (this.disposed) return;
    this.captureMs = durationMs;
  }

  setQualityReason(reason: string) {
    if (this.disposed) return;
    this.qualityReason = reason;
  }

  observeRaf(now: number) {
    if (this.disposed) return;
    if (this.lastRafAt > 0) {
      const interval = now - this.lastRafAt;
      if (interval >= 4 && interval < this.displayIntervalMs) this.displayIntervalMs = interval;
    }
    this.lastRafAt = now;
  }

  record(measurement: FrameMeasurement): PerformanceQualityTier | null {
    if (!this.enabled || this.disposed) return null;
    // Ring buffer: past capacity the oldest sample is overwritten, so a long
    // sample interval keeps a rolling window instead of freezing one slot.
    const index = this.writeIndex;
    this.cadence[index] = measurement.cadenceMs;
    this.frame[index] = measurement.frameMs;
    this.update[index] = measurement.updateMs;
    this.surface[index] = measurement.surfaceMs;
    this.render[index] = measurement.renderMs;
    this.postFX[index] = measurement.postFXMs;
    this.writeIndex = (this.writeIndex + 1) % MAX_FRAME_SAMPLES;
    if (this.count < MAX_FRAME_SAMPLES) this.count++;
    this.frames++;

    const now = performance.now();
    if (now - this.sampleStartedAt < this.sampleIntervalMs) return null;
    const recommendation = this.publish(now, measurement);
    this.count = 0;
    this.writeIndex = 0;
    this.frames = 0;
    this.sampleStartedAt = now;
    return recommendation;
  }

  private publish(now: number, measurement: FrameMeasurement): PerformanceQualityTier | null {
    const windowMs = now - this.sampleStartedAt;
    const frame = stats(this.cadence, this.count);
    const cpu = stats(this.frame, this.count);
    const targetBudget = 1_000 / measurement.targetFps;
    let longFrames = 0;
    let estimatedDroppedFrames = 0;
    for (let i = 0; i < this.count; i++) {
      const value = this.cadence[i];
      if (value > targetBudget * 1.5) longFrames++;
      estimatedDroppedFrames += Math.max(0, Math.round(value / targetBudget) - 1);
    }
    const breakdown: PerformanceFrameBreakdown = {
      updateMs: average(this.update, this.count),
      surfaceMs: average(this.surface, this.count),
      renderMs: average(this.render, this.count),
      postFXMs: average(this.postFX, this.count),
    };
    this.latest = {
      timestamp: now,
      windowMs,
      fps: (this.frames * 1_000) / Math.max(1, windowMs),
      targetFps: measurement.targetFps,
      frames: this.frames,
      // Executed-frame cadence is derived from the publication window. CPU is
      // separately measured around the engine work, which is the actionable part.
      frame,
      cpu,
      breakdown,
      longFrames,
      longFrameRate: longFrames / Math.max(1, this.count),
      estimatedDroppedFrames,
      quality: measurement.quality,
      qualityReason: this.qualityReason,
      pixelRatio: measurement.pixelRatio,
      effectsPixelRatio: measurement.effectsPixelRatio,
      entities: measurement.entities,
      captureMs: this.captureMs,
      memory: memorySnapshot(),
    };
    for (const callback of this.callbacks) callback(this.latest);

    if (!this.adaptive || this.count < 12) return null;
    const cpuOverload = cpu.p95 > targetBudget * 0.72;
    // Canvas2D rasterization and texture uploads may complete after the JS call
    // returns, so `frameMs` alone can under-report their cost. Treat cadence as
    // engine pressure only when frames are persistently late *and* the engine
    // itself is doing meaningful work; a busy host page with a cheap destroyer
    // must not lower our quality.
    const cadenceOverload =
      frame.p95 > targetBudget * 1.8 &&
      longFrames / Math.max(1, this.count) > 0.1 &&
      cpu.p95 > targetBudget * 0.3;
    const sustainedOverload = cpuOverload || cadenceOverload;
    const peakOverload = cpu.max > targetBudget * 1.2;
    if (sustainedOverload || peakOverload) {
      this.coolSamples = 0;
      // Shader/canvas initialization can create one large first-frame spike
      // while every recurring frame remains cool. Only a p95 overload is
      // immediately actionable; a peak-only signal must repeat in the next
      // sample before it is allowed to reduce visual quality.
      if (!sustainedOverload && ++this.peakSamples < 2) return null;
      this.peakSamples = 0;
      const pressure = cpuOverload
        ? `p95 engine cost ${cpu.p95.toFixed(1)}ms`
        : cadenceOverload
          ? `p95 cadence ${frame.p95.toFixed(1)}ms with ${cpu.p95.toFixed(1)}ms engine cost`
          : `peak engine cost ${cpu.max.toFixed(1)}ms`;
      if (measurement.quality === "high") {
        const catastrophic =
          cpu.p95 > targetBudget * 1.5 ||
          (cadenceOverload && frame.p95 > targetBudget * 3 && cpu.p95 > targetBudget * 0.5);
        if (catastrophic) {
          this.qualityReason = `${pressure} required an immediate low-end profile`;
          return "low";
        }
        this.qualityReason = `${pressure} exceeded the safe share of a ${targetBudget.toFixed(1)}ms frame budget`;
        return "balanced";
      }
      if (measurement.quality === "balanced") {
        this.qualityReason = `sustained ${pressure} required the low-end profile`;
        return "low";
      }
      return null;
    }

    this.peakSamples = 0;

    const cool = cpu.p95 < targetBudget * 0.34 && cpu.max < targetBudget * 0.7;
    this.coolSamples = cool ? this.coolSamples + 1 : 0;
    if (this.coolSamples < 5) return null;
    this.coolSamples = 0;
    if (measurement.quality === "low") {
      this.qualityReason = "five consecutive samples stayed well under budget";
      return "balanced";
    }
    if (measurement.quality === "balanced" && this.displayIntervalMs < 12) {
      this.qualityReason = "sustained headroom restored the native refresh profile";
      return "high";
    }
    return null;
  }
}
