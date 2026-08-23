import { afterEach, describe, expect, test } from "bun:test";
import "./support/dom.mjs";
import {
  canvasUploadCostMs,
  measuredUploadCostMs,
  resetUploadCostCache,
  SLOW_UPLOAD_THRESHOLD_MS,
} from "../src/gl.ts";

/**
 * A GL stub whose uploads burn a fixed amount of wall clock, so the probe
 * sees the same signal a slow-upload browser produces.
 */
function stubGl(uploadMs) {
  return {
    TEXTURE_2D: 0x0de1,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    createTexture: () => ({}),
    deleteTexture: () => {},
    bindTexture: () => {},
    texImage2D: () => {},
    texSubImage2D: () => {
      const until = performance.now() + uploadMs;
      while (performance.now() < until) {
        // busy-wait: the probe measures wall clock around the call
      }
    },
    finish: () => {},
  };
}

afterEach(() => resetUploadCostCache());

describe("canvasUploadCostMs", () => {
  test("reports null until a context has been probed", () => {
    expect(measuredUploadCostMs()).toBe(null);
  });

  test("fast uploads land under the slow threshold", () => {
    expect(canvasUploadCostMs(stubGl(0))).toBeLessThan(SLOW_UPLOAD_THRESHOLD_MS);
  });

  test("slow uploads are measured and exceed the threshold", () => {
    const cost = canvasUploadCostMs(stubGl(4));
    expect(cost).toBeGreaterThan(SLOW_UPLOAD_THRESHOLD_MS);
    expect(measuredUploadCostMs()).toBe(cost);
  });

  test("the probe result is cached across contexts", () => {
    const first = canvasUploadCostMs(stubGl(4));
    // A second, instant context must not overwrite the browser-wide verdict.
    expect(canvasUploadCostMs(stubGl(0))).toBe(first);
  });

  test("a context that throws reports fast rather than degrading", () => {
    const broken = {
      createTexture: () => {
        throw new Error("no gl");
      },
    };
    expect(canvasUploadCostMs(broken)).toBe(0);
  });
});
