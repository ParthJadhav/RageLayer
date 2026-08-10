import { describe, expect, test } from "bun:test";
import { atopAsOver, teeContexts } from "../src/ctx-proxy.ts";
import { alphaAt, makeCanvas, readPixels } from "./support/dom.mjs";

/**
 * Both proxies exist so that plain imperative decal code — including
 * third-party tools nobody controls — behaves correctly on surfaces that hold
 * no page pixels. The interesting assertions are therefore about what actually
 * lands on the canvas, not about which properties were forwarded.
 */

function contextOf(canvas) {
  return canvas.getContext("2d");
}

describe("atopAsOver", () => {
  test("a source-atop decal still draws on a transparent overlay", () => {
    // Decals hard-code `source-atop` because a mark is damage to the page. On
    // the transparent overlay canvas (capture disabled) that would compose
    // against nothing and vanish, taking every decal with it.
    const canvas = makeCanvas(50, 50);
    const ctx = atopAsOver(contextOf(canvas));

    ctx.globalCompositeOperation = "source-atop";
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(10, 10, 20, 20);

    expect(alphaAt(canvas, 20, 20)).toBe(255);
  });

  test("the rewrite is confined to source-atop", () => {
    const canvas = makeCanvas(50, 50, "#0000ff");
    const raw = contextOf(canvas);
    const ctx = atopAsOver(raw);

    ctx.globalCompositeOperation = "destination-out";
    ctx.fillRect(10, 10, 20, 20);

    // Other modes are passed through untouched, so erasing still erases.
    expect(alphaAt(canvas, 20, 20)).toBe(0);
    expect(raw.globalCompositeOperation).toBe("destination-out");
  });

  test("other properties and reads pass through", () => {
    const canvas = makeCanvas(50, 50);
    const raw = contextOf(canvas);
    const ctx = atopAsOver(raw);

    ctx.lineWidth = 7;
    ctx.fillStyle = "#00ff00";

    expect(raw.lineWidth).toBe(7);
    expect(ctx.lineWidth).toBe(7);
    expect(ctx.canvas).toBe(canvas);
  });
});

describe("teeContexts", () => {
  test("a draw lands on both the visible surface and the decals buffer", () => {
    // In live mode the visible canvas is rebuilt from a fresh page capture;
    // only what was mirrored into the decals buffer survives that refresh.
    const visible = makeCanvas(50, 50, "#3366cc");
    const decals = makeCanvas(50, 50);
    const ctx = teeContexts(contextOf(visible), contextOf(decals));

    ctx.fillStyle = "#ff0000";
    ctx.fillRect(10, 10, 20, 20);

    expect([...readPixels(visible, 20, 20, 1, 1).slice(0, 3)]).toEqual([255, 0, 0]);
    expect([...readPixels(decals, 20, 20, 1, 1).slice(0, 3)]).toEqual([255, 0, 0]);
  });

  test("source-atop clips on the visible page but not in the decals buffer", () => {
    // The buffer is transparent by construction; keeping `source-atop` there
    // would discard the decal, and the clip is applied once later anyway when
    // the whole buffer is composited back over the page.
    const visible = makeCanvas(50, 50);
    contextOf(visible).fillRect(0, 0, 25, 50); // page exists only on the left
    const decals = makeCanvas(50, 50);
    const ctx = teeContexts(contextOf(visible), contextOf(decals));

    ctx.globalCompositeOperation = "source-atop";
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, 50, 50);

    // Visible surface: the decal is clipped to surviving page pixels.
    expect(alphaAt(visible, 10, 10)).toBe(255);
    expect(alphaAt(visible, 40, 10)).toBe(0);
    // Decals buffer: kept whole, so a later refresh can re-clip it correctly.
    expect(alphaAt(decals, 40, 10)).toBe(255);
  });

  test("reads run once and are not mirrored", () => {
    const visible = makeCanvas(50, 50, "#3366cc");
    const decals = makeCanvas(50, 50);
    const decalsCtx = contextOf(decals);
    let mirroredReads = 0;
    const spy = new Proxy(decalsCtx, {
      get(target, prop) {
        if (prop === "getImageData") mirroredReads++;
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const ctx = teeContexts(contextOf(visible), spy);

    const pixels = ctx.getImageData(0, 0, 1, 1);

    expect(pixels.data[3]).toBe(255);
    expect(mirroredReads).toBe(0);
  });

  test("a failure in the decals buffer never breaks the visible draw", () => {
    const visible = makeCanvas(50, 50);
    const hostile = new Proxy(contextOf(makeCanvas(50, 50)), {
      get(_target, prop) {
        if (prop === "fillRect") {
          return () => {
            throw new Error("decals buffer is gone");
          };
        }
        return () => {};
      },
      set() {
        throw new Error("decals buffer is gone");
      },
    });
    const ctx = teeContexts(contextOf(visible), hostile);

    expect(() => {
      ctx.fillStyle = "#ff0000";
      ctx.fillRect(10, 10, 20, 20);
    }).not.toThrow();
    expect(alphaAt(visible, 20, 20)).toBe(255);
  });
});
