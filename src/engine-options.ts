import type { DestroyerOptions } from "./types";

/** Soft transient effects default to CSS-pixel resolution; hosts can opt into supersampling. */
const DEFAULT_FX_DPR = 1;

export type ResolvedEngineOptions = Required<
  Pick<
    DestroyerOptions,
    | "zIndex"
    | "gravity"
    | "maxFlames"
    | "maxParticles"
    | "captureContent"
    | "captureMode"
    | "liveRefreshMs"
    | "physics"
    | "postFX"
    | "effectsPixelRatio"
    | "harvestElements"
    | "textMask"
    | "toolStyle"
    | "pauseWhenHidden"
  >
> & { toolScale: number };

function finiteOr(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : value;
}

function clampOption(value: number | undefined, fallback: number, min: number, max: number) {
  return Math.min(max, Math.max(min, finiteOr(value, fallback)));
}

/**
 * Resolve the options the engine reads throughout its lifetime.
 *
 * Keeping defaults and numeric invariants at one boundary makes the constructor
 * about wiring subsystems rather than validation. It also protects JavaScript
 * callers from `NaN`/infinite values, which TypeScript cannot prevent at runtime.
 */
export function resolveEngineOptions(options: DestroyerOptions): ResolvedEngineOptions {
  return {
    zIndex: Math.round(clampOption(options.zIndex, 2_147_483_000, -2_147_483_648, 2_147_483_647)),
    gravity: finiteOr(options.gravity, 1_750),
    // The simulation systems already enforce these operational floors. Resolve
    // them here too so the stored options tell the truth and quality scaling
    // never starts from a negative or fractional population budget.
    maxFlames: Math.max(4, Math.round(finiteOr(options.maxFlames, 32))),
    maxParticles: Math.max(64, Math.round(finiteOr(options.maxParticles, 1_400))),
    captureContent: options.captureContent ?? true,
    captureMode: options.captureMode ?? "auto",
    liveRefreshMs: Math.max(0, finiteOr(options.liveRefreshMs, 1_000)),
    physics: options.physics ?? true,
    postFX: options.postFX ?? true,
    effectsPixelRatio: clampOption(options.effectsPixelRatio, DEFAULT_FX_DPR, 0.5, 2),
    harvestElements: options.harvestElements ?? true,
    textMask: options.textMask ?? true,
    toolStyle: options.toolStyle ?? "3d",
    toolScale: clampOption(options.toolScale, 1, 0.5, 2),
    pauseWhenHidden: options.pauseWhenHidden ?? true,
  };
}
