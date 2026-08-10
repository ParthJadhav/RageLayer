/**
 * Baking a tool's art into a toolbar icon.
 *
 * The art draws around a pointer hotspot rather than inside a box, so a bake
 * renders large, finds the true alpha bounds, and fits that crop into the icon.
 */

import { registerToolIconBounds, toolIconBounds } from "../icon-bounds";
import type { ToolArtFn, ToolArtState } from "../types";
import {
  broomArt,
  chainsawArt,
  flamethrowerArt,
  gunArt,
  hammerArt,
  paintballArt,
  waterHoseArt,
} from "./base";
import { blackHoleArt, bugsArt, demolitionArt, freezeArt, lightningArt, rocketArt } from "./heavy";

/** The rest pose every icon is baked from: mid-idle, nothing pressed. */
const ICON_STATE: ToolArtState = {
  time: 0.35,
  held: false,
  sinceDown: Infinity,
  sinceUp: Infinity,
  vx: 0,
  vy: 0,
  aimX: -0.55,
  aimY: -0.835,
};

/**
 * Exact alpha silhouettes for the built-in rest poses, measured at the icon
 * bake's 64px origin. Besides protecting narrow details (claws, bristles,
 * antennae) from clipping, this avoids a 256×256 `getImageData` readback for
 * every built-in toolbar icon. Custom art still gets the accurate scan path.
 */
for (const [art, bounds] of [
  [hammerArt, [69, 32, 175, 148]],
  [gunArt, [61, 53, 119, 119]],
  [flamethrowerArt, [56, 54, 120, 125]],
  [waterHoseArt, [62, 63, 165, 177]],
  [chainsawArt, [59, 58, 157, 126]],
  [paintballArt, [59, 51, 119, 122]],
  [broomArt, [43, 0, 150, 80]],
  [demolitionArt, [42, 0, 89, 74]],
  [rocketArt, [52, 51, 155, 120]],
  [lightningArt, [63, 63, 139, 147]],
  [freezeArt, [56, 56, 125, 122]],
  [blackHoleArt, [44, 44, 127, 123]],
  [bugsArt, [60, 53, 114, 112]],
] as const) {
  registerToolIconBounds(art, bounds);
}

/** Reopening an identical toolbar should not rasterize and PNG-encode built-ins again. */
const iconCache = new WeakMap<ToolArtFn, Map<number, string>>();

/**
 * Render a tool's art to a data-URL icon.
 *
 * The art draws around a pointer hotspot, not inside a box, so the bake
 * renders large, scans the alpha channel for the true bounds, and fits that
 * crop into the icon. Runs once per tool when a toolbar mounts.
 */
export function toolIconDataUrl(
  art: ToolArtFn,
  size = 30,
  state: Partial<ToolArtState> = {},
): string {
  size = Math.min(256, Math.max(8, Math.round(Number.isFinite(size) ? size : 30)));
  const cacheable = Object.keys(state).length === 0;
  if (cacheable) {
    const cached = iconCache.get(art)?.get(size);
    if (cached !== undefined) return cached;
  }

  const pad = 64;
  const big = document.createElement("canvas");
  big.width = big.height = 256;
  const bctx = big.getContext("2d");
  if (!bctx) return "";
  bctx.translate(pad, pad);
  art(bctx, { ...ICON_STATE, ...state });

  const measuredBounds = toolIconBounds(art);
  let [x0, y0, x1, y1] = measuredBounds ?? [256, 256, 0, 0];
  if (!measuredBounds || !cacheable) {
    // Custom/stateful art has no manifest: retain the exact alpha scan fallback.
    const data = bctx.getImageData(0, 0, 256, 256).data;
    x0 = y0 = 256;
    x1 = y1 = 0;
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        if (data[(y * 256 + x) * 4 + 3] > 24) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
  }
  if (x1 <= x0 || y1 <= y0) return "";

  const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
  const out = document.createElement("canvas");
  out.width = out.height = size * dpr;
  const octx = out.getContext("2d");
  if (!octx) return "";
  const w = x1 - x0 + 2;
  const h = y1 - y0 + 2;
  const scale = Math.min((size * dpr * 0.92) / w, (size * dpr * 0.92) / h);
  const dw = w * scale;
  const dh = h * scale;
  octx.imageSmoothingQuality = "high";
  octx.drawImage(big, x0 - 1, y0 - 1, w, h, (size * dpr - dw) / 2, (size * dpr - dh) / 2, dw, dh);
  const url = out.toDataURL();
  if (cacheable) {
    let sizes = iconCache.get(art);
    if (!sizes) {
      sizes = new Map();
      iconCache.set(art, sizes);
    }
    sizes.set(size, url);
  }
  return url;
}
