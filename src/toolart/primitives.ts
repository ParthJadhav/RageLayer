/**
 * Shared drawing primitives for the hand-drawn pseudo-3D tool renderings.
 *
 * Every tool used to be an emoji glued to the cursor. These are the real
 * things: a hammer with a forged steel head and a wooden handle, a pistol
 * whose slide cycles, a chainsaw whose chain actually crawls around the bar.
 * Each is pure canvas vector work — layered gradients for the round-body
 * shading, a specular band where the light hits, a soft cast shadow under the
 * tool — so there are still no image assets and nothing to load.
 *
 * Conventions shared by every drawing:
 *
 * - The canvas origin is the pointer hotspot: the hammer face, the gun
 *   muzzle, the nozzle tip. The tool body extends down and to the right, the
 *   way a right hand would hold it into the page.
 * - Light comes from the upper left. Cylinders get a bright band about a
 *   third of the way across, faces get a lit top edge.
 * - Animation is derived, never stored: everything a pose needs is in
 *   `ToolArtState` (clock, held, time since press/release, smoothed motion),
 *   so the functions stay stateless and deterministic — the same state always
 *   draws the same pixels, which is also what lets the toolbar bake icons
 *   from them.
 */

import { clamp01, TAU } from "../math";

export type Ctx = CanvasRenderingContext2D;
export type Stops = [number, string][];

/** Fast out, settling in — the shape of everything spring-loaded here. */
export const easeOut = (t: number) => 1 - (1 - clamp01(t)) ** 3;

/** Deterministic per-seed noise, so nothing flickers differently in an icon bake. */
export function hash(seed: number) {
  const s = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

// ── Materials ────────────────────────────────────────────────────────────────
// Gradient stop ramps that read as a lit cylinder when run across a body:
// shadowed edge, hot specular band, mid tone, falloff to the dark side.

export const STEEL: Stops = [
  [0, "#2e3237"],
  [0.16, "#9aa4af"],
  [0.32, "#eef2f6"],
  [0.5, "#a9b2bc"],
  [0.78, "#565d66"],
  [1, "#1f2226"],
];
export const IRON: Stops = [
  [0, "#141519"],
  [0.22, "#4c4f55"],
  [0.4, "#83888f"],
  [0.62, "#3c4046"],
  [1, "#0e0f12"],
];
export const WOOD: Stops = [
  [0, "#4a2e13"],
  [0.18, "#8a5a2a"],
  [0.38, "#cf9354"],
  [0.58, "#a4703a"],
  [0.85, "#5d3a1c"],
  [1, "#361f0c"],
];
export const BRASS: Stops = [
  [0, "#54401a"],
  [0.2, "#c79b45"],
  [0.38, "#f6df92"],
  [0.58, "#c69c4c"],
  [0.82, "#6e5220"],
  [1, "#3f2f10"],
];
export const ORANGE: Stops = [
  [0, "#6e2a07"],
  [0.2, "#dd651f"],
  [0.38, "#ffa352"],
  [0.6, "#cd5a15"],
  [1, "#571f05"],
];
export const RED: Stops = [
  [0, "#5c0e0e"],
  [0.2, "#bb2a1f"],
  [0.38, "#f0604a"],
  [0.6, "#9e1e15"],
  [1, "#470b09"],
];
export const TEAL: Stops = [
  [0, "#0c3540"],
  [0.2, "#2593a8"],
  [0.38, "#7edeee"],
  [0.6, "#1b7080"],
  [1, "#08262d"],
];
export const OLIVE: Stops = [
  [0, "#272d10"],
  [0.2, "#5d6b2c"],
  [0.38, "#93a44f"],
  [0.6, "#48541f"],
  [1, "#1d230b"],
];
export const STRAW: Stops = [
  [0, "#7a5a1e"],
  [0.25, "#c99e46"],
  [0.45, "#ecc86e"],
  [0.7, "#b0873a"],
  [1, "#6b4c18"],
];
export const DARKMETAL: Stops = [
  [0, "#101014"],
  [0.2, "#34363e"],
  [0.38, "#5c606c"],
  [0.6, "#2b2d34"],
  [1, "#0a0a0d"],
];

export function grad(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, stops: Stops) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  for (const [t, c] of stops) g.addColorStop(t, c);
  return g;
}

/** The thin dark contour that keeps a tool legible over any page. */
export function outline(ctx: Ctx, alpha = 0.45) {
  ctx.strokeStyle = `rgba(12, 10, 8, ${alpha})`;
  ctx.lineWidth = 1;
  ctx.stroke();
}

/**
 * A shaded cylinder from (x0,y0) to (x1,y1) — handles, barrels, tubes.
 * The gradient runs across the rod, which is what makes it read as round.
 */
export function rod(
  ctx: Ctx,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  w: number,
  stops: Stops,
  edge = 0.45,
) {
  const a = Math.atan2(y1 - y0, x1 - x0);
  const len = Math.hypot(x1 - x0, y1 - y0);
  ctx.save();
  ctx.translate(x0, y0);
  ctx.rotate(a);
  ctx.fillStyle = grad(ctx, 0, -w / 2, 0, w / 2, stops);
  ctx.beginPath();
  ctx.roundRect(0, -w / 2, len, w, w / 2);
  ctx.fill();
  if (edge > 0) outline(ctx, edge);
  ctx.restore();
}

/**
 * Soft elliptical cast shadow on the page. Offset down-right of the tool —
 * the one cheap trick that lifts the whole drawing off the surface.
 */
export function castShadow(
  ctx: Ctx,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  alpha: number,
) {
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rx);
  g.addColorStop(0, `rgba(0,0,0,${alpha})`);
  g.addColorStop(0.7, `rgba(0,0,0,${alpha * 0.5})`);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1, ry / rx);
  ctx.translate(-cx, -cy);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, rx, 0, TAU);
  ctx.fill();
  ctx.restore();
}

/** Soft additive glow puff (pilot lights, emitters, muzzle heat). */
export function glow(ctx: Ctx, x: number, y: number, r: number, color: string, alpha: number) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, color);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
  ctx.restore();
}

/** Screw/rivet head: a dark ring with a lit crescent. Sells "assembled machine". */
export function rivet(ctx: Ctx, x: number, y: number, r: number) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fillStyle = "#2a2c30";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x - r * 0.25, y - r * 0.25, r * 0.55, 0, TAU);
  ctx.fillStyle = "#9aa2ab";
  ctx.fill();
}
