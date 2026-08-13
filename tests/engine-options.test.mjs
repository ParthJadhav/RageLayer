import { describe, expect, test } from "bun:test";
import { resolveEngineOptions } from "../src/engine-options.ts";

describe("resolveEngineOptions", () => {
  test("keeps runtime defaults in one explicit contract", () => {
    expect(resolveEngineOptions({})).toEqual({
      zIndex: 2_147_483_000,
      gravity: 1_750,
      maxFlames: 32,
      maxParticles: 1_400,
      captureContent: true,
      captureMode: "auto",
      liveRefreshMs: 1_000,
      physics: true,
      postFX: true,
      effectsPixelRatio: 1,
      harvestElements: true,
      textMask: true,
      toolStyle: "3d",
      toolScale: 1,
      pauseWhenHidden: true,
    });
  });

  test("clamps rendering scales at the public boundary", () => {
    expect(resolveEngineOptions({ effectsPixelRatio: 20, toolScale: 0.1 })).toMatchObject({
      effectsPixelRatio: 2,
      toolScale: 0.5,
    });
    expect(resolveEngineOptions({ effectsPixelRatio: 0.1, toolScale: 8 })).toMatchObject({
      effectsPixelRatio: 0.5,
      toolScale: 2,
    });
  });

  test("rejects non-finite numeric input instead of poisoning canvas geometry", () => {
    expect(
      resolveEngineOptions({
        zIndex: Number.NaN,
        gravity: Number.NaN,
        maxFlames: Number.POSITIVE_INFINITY,
        maxParticles: Number.NEGATIVE_INFINITY,
        liveRefreshMs: Number.NaN,
        effectsPixelRatio: Number.NaN,
        toolScale: Number.POSITIVE_INFINITY,
      }),
    ).toMatchObject({
      zIndex: 2_147_483_000,
      gravity: 1_750,
      maxFlames: 32,
      maxParticles: 1_400,
      liveRefreshMs: 1_000,
      effectsPixelRatio: 1,
      toolScale: 1,
    });
  });

  test("normalizes population, cadence and stacking values to runtime-safe ranges", () => {
    expect(
      resolveEngineOptions({
        zIndex: Number.MAX_SAFE_INTEGER,
        maxFlames: -10,
        maxParticles: 2.4,
        liveRefreshMs: -1,
        gravity: -800,
      }),
    ).toMatchObject({
      zIndex: 2_147_483_647,
      maxFlames: 4,
      maxParticles: 64,
      liveRefreshMs: 0,
      gravity: -800,
    });
  });
});
