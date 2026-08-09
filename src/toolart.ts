/**
 * Hand-drawn pseudo-3D tool renderings.
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

import type { ToolArtFn, ToolArtState } from "./types";

type Ctx = CanvasRenderingContext2D;
type Stops = [number, string][];

const TAU = Math.PI * 2;

const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
/** Fast out, settling in — the shape of everything spring-loaded here. */
const easeOut = (t: number) => 1 - (1 - clamp01(t)) ** 3;

/** Deterministic per-seed noise, so nothing flickers differently in an icon bake. */
function hash(seed: number) {
  const s = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

// ── Materials ────────────────────────────────────────────────────────────────
// Gradient stop ramps that read as a lit cylinder when run across a body:
// shadowed edge, hot specular band, mid tone, falloff to the dark side.

const STEEL: Stops = [
  [0, "#2e3237"],
  [0.16, "#9aa4af"],
  [0.32, "#eef2f6"],
  [0.5, "#a9b2bc"],
  [0.78, "#565d66"],
  [1, "#1f2226"],
];
const IRON: Stops = [
  [0, "#141519"],
  [0.22, "#4c4f55"],
  [0.4, "#83888f"],
  [0.62, "#3c4046"],
  [1, "#0e0f12"],
];
const WOOD: Stops = [
  [0, "#4a2e13"],
  [0.18, "#8a5a2a"],
  [0.38, "#cf9354"],
  [0.58, "#a4703a"],
  [0.85, "#5d3a1c"],
  [1, "#361f0c"],
];
const BRASS: Stops = [
  [0, "#54401a"],
  [0.2, "#c79b45"],
  [0.38, "#f6df92"],
  [0.58, "#c69c4c"],
  [0.82, "#6e5220"],
  [1, "#3f2f10"],
];
const ORANGE: Stops = [
  [0, "#6e2a07"],
  [0.2, "#dd651f"],
  [0.38, "#ffa352"],
  [0.6, "#cd5a15"],
  [1, "#571f05"],
];
const RED: Stops = [
  [0, "#5c0e0e"],
  [0.2, "#bb2a1f"],
  [0.38, "#f0604a"],
  [0.6, "#9e1e15"],
  [1, "#470b09"],
];
const TEAL: Stops = [
  [0, "#0c3540"],
  [0.2, "#2593a8"],
  [0.38, "#7edeee"],
  [0.6, "#1b7080"],
  [1, "#08262d"],
];
const OLIVE: Stops = [
  [0, "#272d10"],
  [0.2, "#5d6b2c"],
  [0.38, "#93a44f"],
  [0.6, "#48541f"],
  [1, "#1d230b"],
];
const STRAW: Stops = [
  [0, "#7a5a1e"],
  [0.25, "#c99e46"],
  [0.45, "#ecc86e"],
  [0.7, "#b0873a"],
  [1, "#6b4c18"],
];
const DARKMETAL: Stops = [
  [0, "#101014"],
  [0.2, "#34363e"],
  [0.38, "#5c606c"],
  [0.6, "#2b2d34"],
  [1, "#0a0a0d"],
];

function grad(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, stops: Stops) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  for (const [t, c] of stops) g.addColorStop(t, c);
  return g;
}

/** The thin dark contour that keeps a tool legible over any page. */
function outline(ctx: Ctx, alpha = 0.45) {
  ctx.strokeStyle = `rgba(12, 10, 8, ${alpha})`;
  ctx.lineWidth = 1;
  ctx.stroke();
}

/**
 * A shaded cylinder from (x0,y0) to (x1,y1) — handles, barrels, tubes.
 * The gradient runs across the rod, which is what makes it read as round.
 */
function rod(
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
function castShadow(ctx: Ctx, cx: number, cy: number, rx: number, ry: number, alpha: number) {
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
function glow(ctx: Ctx, x: number, y: number, r: number, color: string, alpha: number) {
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
function rivet(ctx: Ctx, x: number, y: number, r: number) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fillStyle = "#2a2c30";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x - r * 0.25, y - r * 0.25, r * 0.55, 0, TAU);
  ctx.fillStyle = "#9aa2ab";
  ctx.fill();
}

// ── Hammer ───────────────────────────────────────────────────────────────────

/**
 * Claw hammer, held from the lower right, striking face at the origin.
 * The whole tool pivots around the grip: raised at rest, snapping down on
 * press, easing back up after — the swing IS the feedback that a click landed.
 */
export const hammerArt: ToolArtFn = (ctx, s) => {
  // 1 = raised (rest), 0 = face on the page.
  let lift: number;
  if (s.held) lift = Math.max(0, 1 - s.sinceDown / 0.06);
  else lift = easeOut(s.sinceUp / 0.28);
  if (!Number.isFinite(s.sinceUp) && !s.held) lift = 1;
  const idle = Math.sin(s.time * 1.7) * 0.035;
  // Cocked back ~30° at rest — enough to read as "raised", little enough that
  // the striking face still points at the hotspot.
  const ang = lift * 0.52 + idle * lift;

  castShadow(ctx, 30, 46, 46, 15, 0.16 + (1 - lift) * 0.1);

  const px = 62;
  const py = 78;
  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(ang);
  ctx.translate(-px, -py);

  // Handle first, head over it so the eye (the joint) is covered.
  rod(ctx, 62, 78, 14, 6, 10, WOOD);
  // Flared grip cap.
  ctx.save();
  ctx.translate(62, 78);
  ctx.rotate(Math.atan2(78 - 6, 62 - 14));
  ctx.fillStyle = grad(ctx, 0, -7, 0, 7, WOOD);
  ctx.beginPath();
  ctx.roundRect(-4, -7, 10, 14, 4);
  ctx.fill();
  outline(ctx);
  ctx.restore();

  // Head: forged block along its own axis, striking face kissing the origin.
  // Nearly horizontal in contact pose, so the raised rest pose (+0.5 around
  // the grip) leaves it at a readable hammer angle rather than upright.
  ctx.save();
  ctx.rotate(0.18); // head axis: +x runs from the face back into the cheek
  // Cheek block.
  ctx.fillStyle = grad(ctx, 0, -12, 0, 12, STEEL);
  ctx.beginPath();
  ctx.roundRect(-1, -11, 34, 22, 5);
  ctx.fill();
  outline(ctx);
  // Striking face: a slightly proud cap with its own bright rim.
  ctx.fillStyle = grad(ctx, 0, -13, 0, 13, STEEL);
  ctx.beginPath();
  ctx.roundRect(-4, -12.5, 8, 25, 3.5);
  ctx.fill();
  outline(ctx);
  // Claw: two curved prongs sweeping up and back, with the V-notch between
  // them facing out — the silhouette that says "claw hammer" at a glance.
  ctx.fillStyle = grad(ctx, 0, -16, 0, 10, STEEL);
  ctx.beginPath();
  ctx.moveTo(30, -10);
  ctx.quadraticCurveTo(46, -16, 56, -28);
  ctx.quadraticCurveTo(50, -14, 50, -8);
  ctx.lineTo(46, -2);
  ctx.quadraticCurveTo(56, -6, 66, -4);
  ctx.quadraticCurveTo(50, 4, 33, 9);
  ctx.closePath();
  ctx.fill();
  outline(ctx);
  // Top-edge highlight across the cheek.
  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(2, -9.5);
  ctx.lineTo(30, -9.5);
  ctx.stroke();
  ctx.restore();

  ctx.restore();
};

// ── Gun ──────────────────────────────────────────────────────────────────────

/**
 * Semi-auto pistol, muzzle at the origin. Recoil is two motions at once: the
 * whole gun kicks back and rotates muzzle-up, while the slide runs further
 * back and returns a beat later. On full-auto the kick re-fires on the
 * engine's real 85 ms cadence.
 */
export const gunArt: ToolArtFn = (ctx, s) => {
  // Per-shot kick, 0..1. Single shot decays; held auto re-kicks on cadence.
  let kick = Math.exp(-s.sinceDown * 16);
  if (s.held && s.sinceDown > 0.22) {
    const p = (s.time % 0.085) / 0.085;
    kick = Math.max(kick, (1 - p) * 0.85);
  }
  if (!Number.isFinite(s.sinceDown)) kick = 0;
  const bob = Math.sin(s.time * 1.9) * 0.9;

  castShadow(ctx, 34, 40, 40, 13, 0.16);

  ctx.save();
  ctx.rotate(0.5 - kick * 0.13);
  ctx.translate(kick * 5, bob * 0.2);

  // Frame + trigger guard under the slide.
  ctx.fillStyle = grad(ctx, 0, 0, 0, 16, DARKMETAL);
  ctx.beginPath();
  ctx.roundRect(6, 2, 46, 12, 3);
  ctx.fill();
  outline(ctx);
  // Trigger guard: an open loop; trigger inside.
  ctx.strokeStyle = "#26282e";
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  ctx.moveTo(24, 13);
  ctx.quadraticCurveTo(24, 26, 37, 25);
  ctx.lineTo(40, 14);
  ctx.stroke();
  ctx.strokeStyle = "#8b9099";
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.moveTo(32, 14);
  ctx.quadraticCurveTo(30, 20, 33, 22);
  ctx.stroke();

  // Grip: raked back, stippled, tucked up into the frame.
  ctx.save();
  ctx.translate(40, 6);
  ctx.rotate(0.42);
  ctx.fillStyle = grad(ctx, 0, 0, 14, 0, [
    [0, "#3a2c20"],
    [0.3, "#6b4c33"],
    [0.6, "#4a3424"],
    [1, "#241a11"],
  ]);
  ctx.beginPath();
  ctx.roundRect(0, 0, 15, 34, 4);
  ctx.fill();
  outline(ctx);
  ctx.fillStyle = "rgba(20,14,9,0.6)";
  for (let r = 0; r < 5; r++)
    for (let c = 0; c < 3; c++) {
      ctx.beginPath();
      ctx.arc(4 + c * 4, 7 + r * 5.4, 0.9, 0, TAU);
      ctx.fill();
    }
  ctx.restore();

  // Slide: runs back with the kick, harder than the frame.
  const slideBack = kick * 7;
  ctx.save();
  ctx.translate(slideBack, 0);
  ctx.fillStyle = grad(ctx, 0, -10, 0, 4, STEEL);
  ctx.beginPath();
  ctx.roundRect(0, -10, 56, 13, 3);
  ctx.fill();
  outline(ctx);
  // Rear serrations.
  ctx.strokeStyle = "rgba(15,16,20,0.7)";
  ctx.lineWidth = 1.2;
  for (let i = 0; i < 5; i++) {
    ctx.beginPath();
    ctx.moveTo(42 + i * 2.6, -8);
    ctx.lineTo(42 + i * 2.6, 1);
    ctx.stroke();
  }
  // Ejection port: open while cycling.
  ctx.fillStyle = kick > 0.35 ? "#0a0a0c" : "#31353c";
  ctx.beginPath();
  ctx.roundRect(26, -8, 12, 6, 1.5);
  ctx.fill();
  // Sights.
  ctx.fillStyle = "#15161a";
  ctx.fillRect(2, -12.5, 3, 3);
  ctx.fillRect(50, -13, 4, 3.5);
  ctx.restore();

  // Muzzle: bore sits just past the slide at the origin.
  ctx.fillStyle = grad(ctx, 0, -8, 0, 2, IRON);
  ctx.beginPath();
  ctx.roundRect(-3 + slideBack * 0.2, -8.5, 6, 10, 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(-1, -3.5, 2.6, 0, TAU);
  ctx.fillStyle = "#050506";
  ctx.fill();

  // Barrel heat while hammering on auto.
  if (s.held && s.sinceDown > 0.4)
    glow(ctx, 0, -4, 14, "rgba(255,120,40,0.5)", Math.min(0.5, (s.sinceDown - 0.4) * 0.5));

  ctx.restore();
};

// ── Flamethrower ─────────────────────────────────────────────────────────────

/** Torch gun with a slung fuel bottle; pilot flame breathing at the nozzle. */
export const flamethrowerArt: ToolArtFn = (ctx, s) => {
  const a = Math.atan2(s.aimY, s.aimX);
  const rumble = s.held ? Math.sin(s.time * 71) * 1.1 : 0;

  castShadow(ctx, 34, 44, 42, 14, 0.16);

  ctx.save();
  ctx.rotate(a + Math.PI); // +x runs from the nozzle back into the body
  ctx.translate(rumble * 0.5, rumble);

  // Fuel bottle slung under the body, hazard-striped.
  ctx.save();
  ctx.translate(30, 10);
  ctx.fillStyle = grad(ctx, 0, 0, 0, 16, [
    [0, "#7a5a08"],
    [0.25, "#e0b52a"],
    [0.45, "#ffe268"],
    [0.7, "#bd9418"],
    [1, "#5c4406"],
  ]);
  ctx.beginPath();
  ctx.roundRect(0, 0, 30, 15, 7);
  ctx.fill();
  outline(ctx);
  ctx.fillStyle = "rgba(30,26,10,0.75)";
  ctx.beginPath();
  ctx.roundRect(12, 0, 6, 15, 1);
  ctx.fill();
  ctx.restore();

  // Body tube.
  rod(ctx, 12, 0, 58, 0, 14, RED);
  // Heat-shield ribs.
  ctx.strokeStyle = "rgba(20,6,4,0.5)";
  ctx.lineWidth = 1.2;
  for (let i = 0; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(20 + i * 6, -7);
    ctx.lineTo(20 + i * 6, 7);
    ctx.stroke();
  }
  // Grip + trigger under the body.
  rod(ctx, 46, 5, 52, 24, 9, DARKMETAL);
  // Nozzle: steel taper down to the tip at the origin, with a flame guard ring.
  ctx.fillStyle = grad(ctx, 0, -7, 0, 7, STEEL);
  ctx.beginPath();
  ctx.moveTo(14, -7);
  ctx.lineTo(2, -3.2);
  ctx.lineTo(2, 3.2);
  ctx.lineTo(14, 7);
  ctx.closePath();
  ctx.fill();
  outline(ctx);
  rod(ctx, 12, 0, 16, 0, 17, IRON, 0.5);
  // Bore.
  ctx.beginPath();
  ctx.arc(2.5, 0, 2.4, 0, TAU);
  ctx.fillStyle = "#050403";
  ctx.fill();
  ctx.restore();

  // Pilot light at the tip: a small breathing teardrop; swells when firing.
  const breathe = 0.75 + 0.25 * Math.sin(s.time * 9) + (s.held ? 1.6 : 0);
  glow(ctx, s.aimX * 4, s.aimY * 4, 10 * breathe, "rgba(255,160,40,0.85)", 0.7);
  glow(ctx, s.aimX * 3, s.aimY * 3, 4.5 * breathe, "rgba(255,240,190,0.95)", 0.85);
};

// ── Water hose ───────────────────────────────────────────────────────────────

/** Brass nozzle on a green garden hose that trails off toward the ground. */
export const waterHoseArt: ToolArtFn = (ctx, s) => {
  const a = Math.atan2(s.aimY, s.aimX);
  const wob = s.held ? Math.sin(s.time * 23) * 1.6 : Math.sin(s.time * 2.1) * 0.5;
  const back = Math.cos(a + Math.PI);
  const backY = Math.sin(a + Math.PI);
  // Where the nozzle body ends and the rubber starts, in tool space.
  const hx = back * 40 + wob * 0.2;
  const hy = backY * 40 + wob * 0.4;

  castShadow(ctx, 36, 48, 44, 14, 0.15);

  // Hose first (under the nozzle): a rubber curve sagging toward lower right,
  // swaying while the water is on.
  ctx.strokeStyle = "#1d4d2b";
  ctx.lineWidth = 11;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(hx, hy);
  ctx.bezierCurveTo(hx + 28 + wob, hy + 34, 66, 66 + wob, 96, 108);
  ctx.stroke();
  ctx.strokeStyle = "#3f8f52";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(hx - 1, hy - 2);
  ctx.bezierCurveTo(hx + 26 + wob, hy + 30, 63, 62 + wob, 93, 104);
  ctx.stroke();
  ctx.lineCap = "butt";

  ctx.save();
  ctx.rotate(a + Math.PI);
  ctx.translate(0, wob * 0.3);
  // Collar where hose meets brass.
  rod(ctx, 30, 0, 42, 0, 13, IRON);
  // Brass body with knurled ring.
  rod(ctx, 10, 0, 32, 0, 12, BRASS);
  ctx.strokeStyle = "rgba(60,42,10,0.6)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 5; i++) {
    ctx.beginPath();
    ctx.moveTo(22 + i * 2, -5.5);
    ctx.lineTo(24 + i * 2, 5.5);
    ctx.stroke();
  }
  // Taper to the tip.
  ctx.fillStyle = grad(ctx, 0, -6, 0, 6, BRASS);
  ctx.beginPath();
  ctx.moveTo(12, -6);
  ctx.lineTo(1, -2.6);
  ctx.lineTo(1, 2.6);
  ctx.lineTo(12, 6);
  ctx.closePath();
  ctx.fill();
  outline(ctx);
  ctx.beginPath();
  ctx.arc(1.5, 0, 1.8, 0, TAU);
  ctx.fillStyle = "#0a1c26";
  ctx.fill();
  ctx.restore();

  // A wet glint at the tip while spraying.
  if (s.held) glow(ctx, s.aimX * 3, s.aimY * 3, 7, "rgba(170,220,255,0.9)", 0.6);
};

// ── Chainsaw ─────────────────────────────────────────────────────────────────

/** Orange body, steel guide bar, and a chain that visibly crawls when cutting. */
export const chainsawArt: ToolArtFn = (ctx, s) => {
  const running = s.held;
  const shake = running ? 1.6 : 0;
  const jx = shake * Math.sin(s.time * 67);
  const jy = shake * Math.sin(s.time * 59 + 2);

  castShadow(ctx, 52, 44, 58, 16, 0.17);

  ctx.save();
  ctx.rotate(0.52);
  ctx.translate(jx, jy);

  // Guide bar: rounded steel blade, tip at the origin.
  ctx.fillStyle = grad(ctx, 0, -6, 0, 6, STEEL);
  ctx.beginPath();
  ctx.roundRect(-2, -6, 66, 12, 6);
  ctx.fill();
  outline(ctx);
  // Chain: a dashed dark band around the bar's rim; the dash offset is the
  // whole running-chain effect.
  ctx.save();
  ctx.strokeStyle = "#181a1e";
  ctx.lineWidth = 4;
  ctx.setLineDash([4, 3.2]);
  ctx.lineDashOffset = running ? -((s.time * 260) % 7.2) : Math.sin(s.time * 1.3) * 0.8;
  ctx.beginPath();
  ctx.roundRect(-2, -6, 66, 12, 6);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
  // Bar nose rivet.
  rivet(ctx, 4, 0, 2.6);

  // Body: orange housing over the bar's rear.
  ctx.fillStyle = grad(ctx, 0, -18, 0, 20, ORANGE);
  ctx.beginPath();
  ctx.moveTo(58, -16);
  ctx.quadraticCurveTo(96, -22, 102, -4);
  ctx.quadraticCurveTo(106, 14, 92, 18);
  ctx.lineTo(62, 18);
  ctx.quadraticCurveTo(54, 6, 58, -16);
  ctx.closePath();
  ctx.fill();
  outline(ctx);
  // Vents.
  ctx.fillStyle = "rgba(40,12,2,0.55)";
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.roundRect(80, -12 + i * 6, 14, 3, 1.5);
    ctx.fill();
  }
  // Front hand guard: an arc over the bar root.
  ctx.strokeStyle = "#22242a";
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(60, -2, 20, -2.2, -0.6);
  ctx.stroke();
  // Top handle.
  ctx.strokeStyle = "#2c2f36";
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(66, -18);
  ctx.quadraticCurveTo(80, -30, 94, -20);
  ctx.stroke();
  // Pull-cord grip bouncing on the housing.
  const cord = running ? Math.abs(Math.sin(s.time * 40)) * 3 : 0;
  ctx.fillStyle = "#d8d3c8";
  ctx.beginPath();
  ctx.roundRect(97, -8 - cord, 7, 5, 1.5);
  ctx.fill();
  outline(ctx, 0.35);
  rivet(ctx, 66, 8, 3);
  rivet(ctx, 88, 10, 3);

  // Exhaust puff while running.
  if (running) {
    const p = (s.time * 3) % 1;
    glow(ctx, 100 + p * 10, 20 + p * -6, 6 + p * 8, "rgba(120,120,120,0.5)", (1 - p) * 0.4);
  }
  ctx.restore();
};

// ── Paintball marker ─────────────────────────────────────────────────────────

/** Stubby teal marker with a hopper of paint on top and a CO₂ tank behind. */
export const paintballArt: ToolArtFn = (ctx, s) => {
  let kick = Math.exp(-s.sinceDown * 14) * 0.8;
  if (!Number.isFinite(s.sinceDown)) kick = 0;

  castShadow(ctx, 34, 42, 40, 13, 0.16);

  ctx.save();
  ctx.rotate(0.5 - kick * 0.09);
  ctx.translate(kick * 4, 0);

  // CO₂ tank slung behind, angled with the grip.
  ctx.save();
  ctx.translate(44, 12);
  ctx.rotate(0.5);
  ctx.fillStyle = grad(ctx, 0, -8, 0, 8, STEEL);
  ctx.beginPath();
  ctx.roundRect(0, -8, 30, 16, 8);
  ctx.fill();
  outline(ctx);
  ctx.restore();

  // Hopper: a fat teardrop of paint on top, with a few balls visible.
  ctx.save();
  ctx.translate(26, -14);
  ctx.fillStyle = grad(ctx, -14, -12, 12, 12, [
    [0, "#7c8288"],
    [0.35, "#d5dade"],
    [0.6, "#aeb4b9"],
    [1, "#5d6268"],
  ]);
  ctx.beginPath();
  ctx.ellipse(0, 0, 15, 12, -0.2, 0, TAU);
  ctx.fill();
  outline(ctx);
  // Window with paintballs.
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(0, 1, 9.5, 7, -0.2, 0, TAU);
  ctx.clip();
  ctx.fillStyle = "#20242a";
  ctx.fillRect(-12, -8, 24, 18);
  const ballColors = ["#ff4d6d", "#ffd23f", "#3ec86f", "#4f9dff", "#c86bff"];
  for (let i = 0; i < 6; i++) {
    const bx = -6 + (i % 3) * 6;
    const by = -2 + Math.floor(i / 3) * 6;
    ctx.fillStyle = ballColors[i % ballColors.length];
    ctx.beginPath();
    ctx.arc(bx, by, 3, 0, TAU);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.beginPath();
    ctx.arc(bx - 1, by - 1, 1, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
  ctx.restore();

  // Feed neck.
  rod(ctx, 24, -8, 28, 0, 7, DARKMETAL);

  // Body.
  ctx.fillStyle = grad(ctx, 0, -8, 0, 8, TEAL);
  ctx.beginPath();
  ctx.roundRect(4, -7, 42, 14, 5);
  ctx.fill();
  outline(ctx);
  // Barrel with porting holes.
  rod(ctx, 0, 0, 8, 0, 8, DARKMETAL);
  ctx.fillStyle = "rgba(220,230,240,0.35)";
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.arc(2 + i * 2.4, -1.5, 0.7, 0, TAU);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(0, 0, 2.4, 0, TAU);
  ctx.fillStyle = "#0a0d10";
  ctx.fill();

  // Grip + trigger guard.
  ctx.save();
  ctx.translate(32, 6);
  ctx.rotate(0.42);
  ctx.fillStyle = grad(ctx, 0, 0, 12, 0, DARKMETAL);
  ctx.beginPath();
  ctx.roundRect(0, 0, 12, 26, 4);
  ctx.fill();
  outline(ctx);
  ctx.restore();
  ctx.strokeStyle = "#22262c";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(20, 7);
  ctx.quadraticCurveTo(20, 18, 31, 17);
  ctx.stroke();

  // A drip of the next ball's paint at the muzzle.
  const drip = (Math.sin(s.time * 1.1) + 1) * 0.5;
  ctx.fillStyle = "#ff4d6d";
  ctx.beginPath();
  ctx.ellipse(0, 3 + drip * 2, 1.6, 2.2 + drip * 1.2, 0, 0, TAU);
  ctx.fill();

  ctx.restore();
};

// ── Broom ────────────────────────────────────────────────────────────────────

/** Corn broom. The bristles lag behind pointer motion the way drag would bend them. */
export const broomArt: ToolArtFn = (ctx, s) => {
  // Bend: bristle tips trail opposite the sweep.
  const bend = Math.max(-14, Math.min(14, -s.vx * 0.014));
  const sway = Math.sin(s.time * 1.6) * 1.2;

  castShadow(ctx, 8, 10, 36, 10, 0.18);

  // Handle up to the top right.
  rod(ctx, 30, -14, 90, -74, 9, WOOD);

  // The bundle: a solid straw wedge flaring from the binding down to the
  // sweeping edge just below the origin. Filled first — individual strokes
  // over bare page read as a rake, not a broom.
  const edgeY = 7;
  ctx.fillStyle = grad(ctx, 8, -20, 4, edgeY, STRAW);
  ctx.beginPath();
  ctx.moveTo(22, -22);
  ctx.lineTo(42, -4);
  ctx.lineTo(30 + bend + sway, edgeY);
  ctx.lineTo(-20 + bend + sway, edgeY - 3);
  ctx.lineTo(14, -18);
  ctx.closePath();
  ctx.fill();
  outline(ctx, 0.35);

  // Bristle strands: darker splits over the wedge, bending with the sweep.
  for (let i = 0; i < 14; i++) {
    const t = i / 13;
    const seed = hash(i * 3.7);
    const rx = 17 + t * 22; // root along the binding line
    const ry = -19 + t * 14;
    const tipX = -18 + t * 46 + bend + sway + (seed - 0.5) * 5;
    const tipY = edgeY - 2 + seed * 3 - (1 - t) * 3;
    ctx.strokeStyle = seed < 0.5 ? "rgba(122, 88, 30, 0.75)" : "rgba(236, 204, 118, 0.9)";
    ctx.lineWidth = 1.6;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(rx, ry);
    ctx.quadraticCurveTo(rx + (tipX - rx) * 0.4, ry + (tipY - ry) * 0.75, tipX, tipY);
    ctx.stroke();
  }
  ctx.lineCap = "butt";

  // Binding wrapping the bundle to the handle, over the strand roots.
  ctx.save();
  ctx.translate(29, -13);
  ctx.rotate(-0.78);
  ctx.fillStyle = grad(ctx, 0, -8, 0, 8, BRASS);
  ctx.beginPath();
  ctx.roundRect(-13, -8, 26, 16, 5);
  ctx.fill();
  outline(ctx);
  // Stitch lines.
  ctx.strokeStyle = "rgba(120,30,30,0.85)";
  ctx.lineWidth = 1.4;
  for (let i = 0; i < 2; i++) {
    ctx.beginPath();
    ctx.moveTo(-12, -3 + i * 6);
    ctx.lineTo(12, -3 + i * 6);
    ctx.stroke();
  }
  ctx.restore();
};

// ── Demolition: wrecking ball ────────────────────────────────────────────────

/** An iron wrecking ball on a chain from above; it swings with your motion. */
export const demolitionArt: ToolArtFn = (ctx, s) => {
  // The ball lags the pointer: fast motion tilts the chain.
  const tilt = Math.max(-0.5, Math.min(0.5, s.vx * 0.0012)) + Math.sin(s.time * 1.4) * 0.03;
  let drop = 0;
  if (Number.isFinite(s.sinceDown)) drop = Math.exp(-s.sinceDown * 10) * 5;

  const r = 21;
  const cx = 0;
  const cy = -r + drop; // ball bottom kisses the origin

  castShadow(ctx, 2, 4, 26, 9, 0.22);

  ctx.save();
  // Chain pivots above the ball; tilt swings ball + chain together.
  ctx.translate(cx, cy - r);
  ctx.rotate(tilt);
  ctx.translate(-cx, -(cy - r));

  // Chain links climbing off toward the upper right.
  ctx.strokeStyle = "#3c4046";
  ctx.lineWidth = 3;
  for (let i = 0; i < 5; i++) {
    const lx = cx + 8 + i * 11;
    const ly = cy - r - 6 - i * 13;
    ctx.save();
    ctx.translate(lx, ly);
    ctx.rotate(0.65 + (i % 2) * Math.PI * 0.5);
    ctx.strokeStyle = i % 2 ? "#575c63" : "#33363c";
    ctx.beginPath();
    ctx.ellipse(0, 0, 6.5, 4, 0, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  // Shackle on top of the ball.
  ctx.strokeStyle = "#4a4e55";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(cx + 2, cy - r + 1, 6, Math.PI, TAU);
  ctx.stroke();

  // The ball: iron sphere with an off-centre specular bloom.
  const g = ctx.createRadialGradient(cx - r * 0.4, cy - r * 0.45, r * 0.1, cx, cy, r * 1.15);
  g.addColorStop(0, "#b9bfc7");
  g.addColorStop(0.25, "#6f757d");
  g.addColorStop(0.6, "#33373d");
  g.addColorStop(1, "#0d0e11");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.fill();
  outline(ctx, 0.5);
  // Casting seam.
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.ellipse(cx, cy, r * 0.96, r * 0.4, 0.5, 0, TAU);
  ctx.stroke();
  // Hot specular dot.
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.beginPath();
  ctx.ellipse(cx - r * 0.42, cy - r * 0.48, 3.2, 2.2, -0.6, 0, TAU);
  ctx.fill();

  ctx.restore();
};

// ── Rocket launcher ──────────────────────────────────────────────────────────

/** Shoulder tube, bore at the origin. The rocket's nose ducks out of sight while reloading. */
export const rocketArt: ToolArtFn = (ctx, s) => {
  let kick = Math.exp(-s.sinceDown * 9);
  if (!Number.isFinite(s.sinceDown)) kick = 0;
  // Rocket visible except for ~1.4 s after firing.
  const loaded = !Number.isFinite(s.sinceDown) || s.sinceDown > 1.4 || s.sinceDown < 0.02;
  const bob = Math.sin(s.time * 1.6) * 1;

  castShadow(ctx, 44, 48, 52, 15, 0.17);

  ctx.save();
  ctx.rotate(0.45 - kick * 0.06);
  ctx.translate(kick * 8, bob * 0.3);

  // Tube.
  ctx.fillStyle = grad(ctx, 0, -13, 0, 13, OLIVE);
  ctx.beginPath();
  ctx.roundRect(2, -12, 96, 24, 6);
  ctx.fill();
  outline(ctx);
  // Wrapped grip bands.
  ctx.fillStyle = "rgba(20,24,8,0.5)";
  for (const bx of [14, 66]) {
    ctx.beginPath();
    ctx.roundRect(bx, -12, 7, 24, 2);
    ctx.fill();
  }
  // Iron sight flipped up.
  ctx.strokeStyle = "#20240e";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(34, -12);
  ctx.lineTo(34, -22);
  ctx.moveTo(30, -22);
  ctx.lineTo(38, -22);
  ctx.stroke();
  // Grip + trigger under the tube.
  rod(ctx, 44, 12, 44, 32, 9, DARKMETAL);
  rod(ctx, 58, 12, 58, 26, 8, DARKMETAL);

  // Muzzle rim: a proud ring; the bore behind it is black, with the rocket's
  // nose cone poking out when loaded.
  ctx.fillStyle = grad(ctx, 0, -14, 0, 14, OLIVE);
  ctx.beginPath();
  ctx.roundRect(-2, -14, 8, 28, 3);
  ctx.fill();
  outline(ctx);
  ctx.beginPath();
  ctx.ellipse(1, 0, 3.4, 10.5, 0, 0, TAU);
  ctx.fillStyle = "#08090a";
  ctx.fill();
  if (loaded) {
    ctx.fillStyle = grad(ctx, 0, -8, 0, 8, RED);
    ctx.beginPath();
    ctx.moveTo(2, -7);
    ctx.quadraticCurveTo(-12, -3, -13, 0);
    ctx.quadraticCurveTo(-12, 3, 2, 7);
    ctx.closePath();
    ctx.fill();
    outline(ctx, 0.4);
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.beginPath();
    ctx.ellipse(-7, -2.8, 3.5, 1.2, -0.15, 0, TAU);
    ctx.fill();
  }

  // Backblast flare out the rear right after firing.
  if (kick > 0.25) {
    glow(ctx, 104, 0, 22 * kick, "rgba(255,170,60,0.8)", kick * 0.8);
    glow(ctx, 112, 0, 34 * kick, "rgba(200,200,200,0.5)", kick * 0.5);
  }
  ctx.restore();
};

// ── Lightning: storm rod ─────────────────────────────────────────────────────

/** Obsidian wand with a charged glass orb; miniature bolts arc inside it. */
export const lightningArt: ToolArtFn = (ctx, s) => {
  const flash = Number.isFinite(s.sinceDown) ? Math.exp(-s.sinceDown * 7) : 0;
  const orbX = 12;
  const orbY = 12;
  const orbR = 12;

  castShadow(ctx, 30, 40, 36, 12, 0.15);

  // Rod down to the lower right.
  rod(ctx, 20, 22, 74, 82, 8, DARKMETAL);
  // Brass collar between rod and orb.
  rod(ctx, 16, 17, 26, 28, 12, BRASS);

  // Orb: charged glass. Base sphere, inner storm, arcs, rim light.
  const g = ctx.createRadialGradient(orbX - 4, orbY - 5, 1, orbX, orbY, orbR * 1.1);
  g.addColorStop(0, "#e8ddff");
  g.addColorStop(0.3, "#8e6fd8");
  g.addColorStop(0.7, "#3c2478");
  g.addColorStop(1, "#160a33");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(orbX, orbY, orbR, 0, TAU);
  ctx.fill();
  outline(ctx, 0.5);

  // Interior arcs: 3 jagged filaments re-rolled ~15×/s, frozen per icon bake.
  const seed = Math.floor(s.time * 15);
  ctx.save();
  ctx.beginPath();
  ctx.arc(orbX, orbY, orbR - 1, 0, TAU);
  ctx.clip();
  ctx.globalCompositeOperation = "lighter";
  for (let b = 0; b < 3; b++) {
    const a0 = hash(seed + b * 17) * TAU;
    const a1 = a0 + Math.PI * (0.6 + hash(seed + b * 29) * 0.8);
    const px = orbX + Math.cos(a0) * (orbR - 2);
    const py = orbY + Math.sin(a0) * (orbR - 2);
    const ex = orbX + Math.cos(a1) * (orbR - 2);
    const ey = orbY + Math.sin(a1) * (orbR - 2);
    ctx.strokeStyle = `rgba(220, 200, 255, ${0.55 + flash * 0.45})`;
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(px, py);
    for (let k = 1; k <= 3; k++) {
      const t = k / 4;
      const nx = px + (ex - px) * t + (hash(seed + b * 7 + k) - 0.5) * 8;
      const ny = py + (ey - py) * t + (hash(seed + b * 13 + k) - 0.5) * 8;
      ctx.lineTo(nx, ny);
    }
    ctx.lineTo(ex, ey);
    ctx.stroke();
  }
  ctx.restore();

  // Glass rim light + charge glow (blows out on strike).
  ctx.strokeStyle = "rgba(240,235,255,0.5)";
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(orbX - 2, orbY - 2, orbR - 2.5, Math.PI * 0.9, Math.PI * 1.6);
  ctx.stroke();
  glow(ctx, orbX, orbY, orbR * (1.6 + flash * 2.2), "rgba(170,140,255,0.7)", 0.4 + flash * 0.6);
};

// ── Freeze ray ───────────────────────────────────────────────────────────────

/** Retro raygun: cooling fins, glowing cryo emitter, icicles under the barrel. */
export const freezeArt: ToolArtFn = (ctx, s) => {
  const charge = s.held ? Math.min(1, s.sinceDown * 2) : 0;
  const pulse = 0.7 + 0.3 * Math.sin(s.time * 6);

  castShadow(ctx, 34, 42, 40, 13, 0.16);

  ctx.save();
  ctx.rotate(0.5);

  // Barrel.
  rod(ctx, 4, 0, 48, 0, 11, TEAL);
  // Cooling fins: three discs seen edge-on, shrinking toward the muzzle.
  for (let i = 0; i < 3; i++) {
    const fx = 12 + i * 10;
    const fr = 12 - i * 1.5;
    ctx.fillStyle = grad(ctx, fx, -fr, fx, fr, STEEL);
    ctx.beginPath();
    ctx.ellipse(fx, 0, 3, fr, 0, 0, TAU);
    ctx.fill();
    outline(ctx, 0.4);
  }
  // Body bulb at the rear with a dome.
  ctx.fillStyle = grad(ctx, 0, -13, 0, 13, TEAL);
  ctx.beginPath();
  ctx.ellipse(54, 0, 14, 13, 0, 0, TAU);
  ctx.fill();
  outline(ctx);
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.beginPath();
  ctx.ellipse(50, -5, 5, 3, -0.5, 0, TAU);
  ctx.fill();
  // Grip.
  ctx.save();
  ctx.translate(52, 10);
  ctx.rotate(0.35);
  ctx.fillStyle = grad(ctx, 0, 0, 12, 0, DARKMETAL);
  ctx.beginPath();
  ctx.roundRect(0, 0, 12, 26, 5);
  ctx.fill();
  outline(ctx);
  ctx.restore();

  // Icicles hanging off the barrel.
  ctx.fillStyle = "rgba(200,240,255,0.85)";
  for (let i = 0; i < 3; i++) {
    const ix = 10 + i * 12;
    const il = 5 + hash(i * 5.1) * 6;
    ctx.beginPath();
    ctx.moveTo(ix - 2, 5);
    ctx.lineTo(ix, 5 + il);
    ctx.lineTo(ix + 2, 5);
    ctx.closePath();
    ctx.fill();
  }

  // Emitter: cryo glow at the muzzle, spinning frost star while firing.
  ctx.beginPath();
  ctx.arc(2, 0, 3.4, 0, TAU);
  ctx.fillStyle = "#dff6ff";
  ctx.fill();
  outline(ctx, 0.4);
  ctx.restore();

  glow(ctx, 0, 0, 10 + charge * 10, "rgba(150,220,255,0.9)", 0.45 * pulse + charge * 0.4);
  if (charge > 0.1) {
    ctx.save();
    ctx.strokeStyle = `rgba(220,245,255,${0.7 * charge})`;
    ctx.lineWidth = 1.4;
    ctx.rotate(s.time * 2.4);
    for (let i = 0; i < 6; i++) {
      ctx.rotate(TAU / 6);
      ctx.beginPath();
      ctx.moveTo(4, 0);
      ctx.lineTo(9 + charge * 5, 0);
      ctx.stroke();
    }
    ctx.restore();
  }
};

// ── Black hole: singularity ring ─────────────────────────────────────────────

/** A containment ring on a handle. Held open, a vortex spins up inside it. */
export const blackHoleArt: ToolArtFn = (ctx, s) => {
  const charge = s.held ? Math.min(1, 0.3 + s.sinceDown * 0.9) : 0.18;
  const R = 17;

  castShadow(ctx, 20, 34, 34, 11, 0.15);

  // Handle to the lower right, forked to grip the ring.
  rod(ctx, 22, 16, 62, 58, 8, DARKMETAL);
  rod(ctx, 12, 18, 24, 20, 6, DARKMETAL, 0.4);
  rod(ctx, 18, 8, 26, 16, 6, DARKMETAL, 0.4);

  // Vortex inside the ring: spiral filaments falling inward, spinning faster
  // the harder it is held open. Purple-on-black so it reads against any page.
  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, R - 2, 0, TAU);
  ctx.clip();
  ctx.fillStyle = "rgba(6,3,12,0.92)";
  ctx.fillRect(-R, -R, R * 2, R * 2);
  ctx.globalCompositeOperation = "lighter";
  const spin = s.time * (1.5 + charge * 6);
  for (let arm = 0; arm < 3; arm++) {
    ctx.strokeStyle =
      arm === 0
        ? "rgba(190,140,255,0.8)"
        : arm === 1
          ? "rgba(120,90,230,0.65)"
          : "rgba(255,190,120,0.5)";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let k = 0; k <= 14; k++) {
      const t = k / 14;
      const ang = spin + arm * (TAU / 3) + t * 3.2;
      const rr = (R - 3) * (1 - t * 0.92);
      const x = Math.cos(ang) * rr;
      const y = Math.sin(ang) * rr * 0.8;
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.restore();

  // The ring itself: a brass torus with a lit upper arc.
  ctx.strokeStyle = grad(ctx, -R, -R, R, R, BRASS);
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(0, 0, R, 0, TAU);
  ctx.stroke();
  ctx.strokeStyle = "rgba(12,10,8,0.5)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(0, 0, R + 2.5, 0, TAU);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, R - 2.5, 0, TAU);
  ctx.stroke();
  // Ring runes: three studs.
  for (let i = 0; i < 3; i++) {
    const a = -0.7 + i * (TAU / 3);
    rivet(ctx, Math.cos(a) * R, Math.sin(a) * R, 2);
  }

  glow(ctx, 0, 0, R * (1.3 + charge), "rgba(150,110,255,0.6)", 0.25 + charge * 0.5);
};

// ── Bugs: specimen jar ───────────────────────────────────────────────────────

/** A tilted glass jar, lid ajar, one escapee on the rim. Click tips it further. */
export const bugsArt: ToolArtFn = (ctx, s) => {
  let tip = Number.isFinite(s.sinceDown) ? Math.exp(-s.sinceDown * 6) * 0.3 : 0;
  tip += Math.sin(s.time * 1.8) * 0.02;

  castShadow(ctx, 26, 40, 32, 11, 0.16);

  ctx.save();
  ctx.translate(30, 26);
  ctx.rotate(-0.55 - tip); // mouth aims down-left toward the origin
  ctx.translate(-30, -26);

  // Jar body: glass — translucent fill, bright rim strokes.
  const jx = 30;
  const jy = 26;
  ctx.fillStyle = "rgba(210, 230, 240, 0.2)";
  ctx.beginPath();
  ctx.roundRect(jx - 14, jy - 18, 28, 38, 8);
  ctx.fill();
  ctx.strokeStyle = "rgba(235, 245, 250, 0.75)";
  ctx.lineWidth = 1.6;
  ctx.stroke();
  // Glass highlights.
  ctx.strokeStyle = "rgba(255,255,255,0.65)";
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.moveTo(jx - 9, jy - 12);
  ctx.quadraticCurveTo(jx - 11, jy, jx - 9, jy + 12);
  ctx.stroke();

  // Bugs inside: dark beetles crawling (positions orbit slowly).
  for (let i = 0; i < 3; i++) {
    const a = s.time * (0.7 + i * 0.23) + i * 2.4;
    const bx = jx + Math.cos(a) * 7;
    const by = jy + 2 + Math.sin(a * 1.3) * 9;
    drawBug(ctx, bx, by, a + 1.2, 0.8);
  }

  // Rim band at the mouth, so the lid has something to sit against.
  ctx.fillStyle = grad(ctx, jx - 14, 0, jx + 14, 0, BRASS);
  ctx.beginPath();
  ctx.roundRect(jx - 15, jy - 20, 30, 5, 2);
  ctx.fill();
  outline(ctx, 0.4);

  // Lid: hinged at the mouth's left corner, tipped open across it. One end
  // stays planted on the rim so it reads attached, not floating.
  ctx.save();
  ctx.translate(jx - 13, jy - 20);
  ctx.rotate(-0.38 - tip * 1.4);
  ctx.fillStyle = grad(ctx, 0, -6, 0, 2, BRASS);
  ctx.beginPath();
  ctx.roundRect(-1, -6, 30, 7, 3);
  ctx.fill();
  outline(ctx);
  // Air holes.
  ctx.fillStyle = "rgba(40,28,8,0.8)";
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.arc(6 + i * 8, -2.5, 1.1, 0, TAU);
    ctx.fill();
  }
  ctx.restore();

  ctx.restore();

  // The escapee, scuttling near the hotspot.
  const wob = Math.sin(s.time * 12);
  drawBug(ctx, 6 + wob * 1.2, 6, -2.2 + wob * 0.15, 1.1);
};

/** One beetle: body capsule, head dot, three leg pairs, antennae. */
function drawBug(ctx: Ctx, x: number, y: number, ang: number, scale: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  ctx.scale(scale, scale);
  // Legs.
  ctx.strokeStyle = "#241b12";
  ctx.lineWidth = 0.9;
  for (let i = -1; i <= 1; i++) {
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(i * 2.4, 0);
      ctx.lineTo(i * 2.4 + i * 1.2, side * 4.4);
      ctx.stroke();
    }
  }
  // Body.
  const g = ctx.createLinearGradient(0, -3, 0, 3);
  g.addColorStop(0, "#6b4a2a");
  g.addColorStop(0.4, "#3c2a16");
  g.addColorStop(1, "#1c130a");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(0, 0, 4.6, 2.9, 0, 0, TAU);
  ctx.fill();
  // Wing split.
  ctx.strokeStyle = "rgba(0,0,0,0.5)";
  ctx.lineWidth = 0.7;
  ctx.beginPath();
  ctx.moveTo(-4, 0);
  ctx.lineTo(3, 0);
  ctx.stroke();
  // Head + antennae.
  ctx.fillStyle = "#17100a";
  ctx.beginPath();
  ctx.arc(5, 0, 1.7, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = "#241b12";
  ctx.beginPath();
  ctx.moveTo(6, -1);
  ctx.lineTo(8.5, -2.6);
  ctx.moveTo(6, 1);
  ctx.lineTo(8.5, 2.6);
  ctx.stroke();
  ctx.restore();
}

// ── Icon baking ──────────────────────────────────────────────────────────────

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

/** Reopening an identical toolbar should not rasterize and PNG-encode 13 tools again. */
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

  // Alpha bounds of what was actually drawn.
  const data = bctx.getImageData(0, 0, 256, 256).data;
  let x0 = 256,
    y0 = 256,
    x1 = 0,
    y1 = 0;
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
  if (x1 <= x0 || y1 <= y0) return "";

  const dpr = 2;
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
