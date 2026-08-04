/**
 * Procedural damage decals stamped onto the persistent damage canvas.
 * Everything is drawn, not image-based, so damage scales with DPR for free
 * and the package ships zero assets.
 *
 * Every fracture is drawn as a *pair* of strokes — a dark one offset down-right
 * and a bright one on top. A single dark line disappears on a dark page and a
 * single bright one disappears on a light one; the pair reads as a lit edge on
 * either, which is what makes cracked glass look cracked.
 */

import { blit, sprites } from "./sprites";

const TAU = Math.PI * 2;

function rand(min: number, max: number) {
  return min + Math.random() * (max - min);
}

/**
 * Stroke the current path twice: a dark shadow offset away from the light, then
 * a thinner bright highlight along the fracture itself.
 */
function fractureStroke(
  ctx: CanvasRenderingContext2D,
  path: Path2D,
  width: number,
  shadow: number,
  highlight: number,
) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.save();
  ctx.translate(0.9, 1.1);
  ctx.strokeStyle = `rgba(8, 6, 5, ${shadow})`;
  ctx.lineWidth = width;
  ctx.stroke(path);
  ctx.restore();
  ctx.strokeStyle = `rgba(255, 252, 246, ${highlight})`;
  ctx.lineWidth = width * 0.55;
  ctx.stroke(path);
}

/** Ring sample points, reused so a hit doesn't allocate a web's worth of arrays. */
const MAX_BRANCHES = 14;
const RING_FRACTIONS = [0.32, 0.6, 0.86];
const webX = new Float64Array(MAX_BRANCHES * RING_FRACTIONS.length);
const webY = new Float64Array(MAX_BRANCHES * RING_FRACTIONS.length);

export interface CrackOptions {
  /**
   * Direction (radians) to bias the web toward — used when a second hit lands
   * beside an existing one, so the damage grows outward instead of stacking a
   * fresh symmetric star on top of the old one.
   */
  bias?: number;
}

/**
 * Hammer impact: a shattered-glass web that spans far wider than the hole.
 *
 * Radial branches plus jittered concentric chords between them; the chords are
 * what separate "spider web" from "asterisk".
 */
export function drawCrack(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale = 1,
  options: CrackOptions = {},
) {
  const bias = options.bias;
  ctx.save();
  ctx.translate(x, y);

  // Bruised shading under the web, plus a pale dust halo so the impact reads
  // against a dark page as well as a light one.
  blit(ctx, sprites().dent, 0, 0, 30 * scale, 0.2);
  blit(ctx, sprites().dust, 0, 0, 54 * scale, 0.09);
  ctx.globalAlpha = 1;

  const branches = Math.min(MAX_BRANCHES, 8 + Math.floor(Math.random() * 4));
  // Capped: repeated hits keep widening the web, but a branch that runs a third
  // of the way across the page stops reading as a fracture and starts reading
  // as a stray line.
  const span = Math.min(220, rand(64, 132) * scale);
  const radial = new Path2D();

  for (let i = 0; i < branches; i++) {
    const angle = (i / branches) * TAU + rand(-0.22, 0.22);
    // Bias lengthens the branches pointing away from the previous impact.
    const pull = bias === undefined ? 1 : 1 + 0.85 * Math.cos(angle - bias);
    const total = span * rand(0.6, 1) * pull;
    const segs = 5;
    let px = 0;
    let py = 0;
    let a = angle;
    let travelled = 0;
    let ring = 0;
    radial.moveTo(0, 0);
    for (let s = 0; s < segs; s++) {
      const segLen = total / segs;
      a += rand(-0.34, 0.34);
      px += Math.cos(a) * segLen;
      py += Math.sin(a) * segLen;
      travelled += segLen;
      radial.lineTo(px, py);
      // Sample where this branch crosses each chord radius.
      while (ring < RING_FRACTIONS.length && travelled >= total * RING_FRACTIONS[ring]) {
        webX[i * RING_FRACTIONS.length + ring] = px;
        webY[i * RING_FRACTIONS.length + ring] = py;
        ring++;
      }
      if (Math.random() < 0.5) {
        const twigA = a + rand(0.6, 1.5) * (Math.random() < 0.5 ? 1 : -1);
        const twigLen = segLen * rand(0.35, 0.85);
        radial.moveTo(px, py);
        radial.lineTo(px + Math.cos(twigA) * twigLen, py + Math.sin(twigA) * twigLen);
        radial.moveTo(px, py);
      }
    }
    // Branches that ended before the outermost ring still need a sample there.
    for (; ring < RING_FRACTIONS.length; ring++) {
      webX[i * RING_FRACTIONS.length + ring] = px;
      webY[i * RING_FRACTIONS.length + ring] = py;
    }
  }
  fractureStroke(ctx, radial, rand(1.3, 2.4) * scale, 0.72, 0.4);

  // Concentric chords: connect neighbouring branches at each ring radius. The
  // inner rings close fully, the outer one is left partial so the web frays.
  const chords = new Path2D();
  for (let r = 0; r < RING_FRACTIONS.length; r++) {
    const partial = r === RING_FRACTIONS.length - 1;
    const start = partial ? Math.floor(Math.random() * branches) : 0;
    const count = partial ? Math.floor(branches * rand(0.35, 0.7)) : branches;
    for (let k = 0; k <= count; k++) {
      const i = (start + k) % branches;
      const jitter = 1 + rand(-0.1, 0.1);
      const cx = webX[i * RING_FRACTIONS.length + r] * jitter;
      const cy = webY[i * RING_FRACTIONS.length + r] * jitter;
      if (k === 0) chords.moveTo(cx, cy);
      else chords.lineTo(cx, cy);
    }
  }
  fractureStroke(ctx, chords, rand(0.8, 1.5) * scale, 0.5, 0.3);

  // Pulverized centre: bright chips of displaced material.
  for (let i = 0; i < 9; i++) {
    const a = Math.random() * TAU;
    const d = rand(2, 13) * scale;
    ctx.fillStyle = `rgba(235, 230, 222, ${rand(0.12, 0.4)})`;
    ctx.beginPath();
    ctx.arc(Math.cos(a) * d, Math.sin(a) * d, rand(0.7, 2.4) * scale, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

/** Layered bullet hole: dark core, ragged rim, glass spiderweb around it. */
export function drawBulletHole(ctx: CanvasRenderingContext2D, x: number, y: number, scale = 1) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.random() * TAU);

  // Pale impact halo — powdered page around the entry wound.
  blit(ctx, sprites().dust, 0, 0, 26 * scale, 0.16);
  ctx.globalAlpha = 1;

  // Radial fractures, well past the hole itself.
  const cracks = 7 + Math.floor(Math.random() * 4);
  const radial = new Path2D();
  const tips: number[] = [];
  for (let i = 0; i < cracks; i++) {
    const angle = (i / cracks) * TAU + rand(-0.3, 0.3);
    const len = rand(16, 46) * scale;
    const mid = len * rand(0.4, 0.6);
    const kink = rand(-4, 4);
    const mx = Math.cos(angle) * mid + kink;
    const my = Math.sin(angle) * mid - kink;
    radial.moveTo(Math.cos(angle) * 4 * scale, Math.sin(angle) * 4 * scale);
    radial.lineTo(mx, my);
    radial.lineTo(Math.cos(angle) * len, Math.sin(angle) * len);
    tips.push(mx, my);
  }
  fractureStroke(ctx, radial, rand(0.9, 1.7) * scale, 0.6, 0.34);

  // One spiderweb ring threaded through the kinks.
  const web = new Path2D();
  for (let i = 0; i <= cracks; i++) {
    const k = (i % cracks) * 2;
    if (i === 0) web.moveTo(tips[k], tips[k + 1]);
    else web.lineTo(tips[k], tips[k + 1]);
  }
  fractureStroke(ctx, web, 0.9 * scale, 0.42, 0.26);

  // Ragged rim — grey ring of overlapping blobs.
  for (let i = 0; i < 10; i++) {
    const angle = (i / 10) * TAU;
    const r = rand(4.5, 6.5) * scale;
    ctx.fillStyle = `rgba(70, 66, 62, ${rand(0.5, 0.8)})`;
    ctx.beginPath();
    ctx.arc(Math.cos(angle) * r, Math.sin(angle) * r, rand(1.5, 3) * scale, 0, TAU);
    ctx.fill();
  }

  // Dark core with soft edge.
  blit(ctx, sprites().bulletCore, 0, 0, 6 * scale, 0.98);
  ctx.globalAlpha = 1;

  // Glint on the rim.
  ctx.fillStyle = "rgba(255, 255, 255, 0.25)";
  ctx.beginPath();
  ctx.arc(-2 * scale, -3 * scale, 1.2 * scale, 0, TAU);
  ctx.fill();
  ctx.restore();
}

/** Soft scorch mark accumulated under a flame. Alpha scales with intensity. */
export function drawScorch(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, alpha: number) {
  blit(ctx, sprites().scorch, x, y, radius, alpha);
  ctx.globalAlpha = 1;
}

/**
 * One chainsaw gash segment between two points.
 *
 * The cut is torn, not sliced: curled tabs peel back along alternating sides,
 * lit on their upper face and dark underneath, so the page reads as paper being
 * ripped rather than a line being drawn on it.
 */
export function drawGash(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 0.5) return;
  const nx = -dy / len;
  const ny = dx / len;
  ctx.save();

  // Curled torn edges. Drawn before the dark core so the core's shadow settles
  // into the crease where the tab lifts off the page.
  const tabs = Math.max(1, Math.floor(len / 9));
  for (let i = 0; i < tabs; i++) {
    const t = (i + rand(0.1, 0.9)) / tabs;
    const bx = x1 + dx * t;
    const by = y1 + dy * t;
    const side = Math.random() < 0.5 ? 1 : -1;
    const lift = rand(4, 11);
    const along = rand(5, 11);
    const ax = (dx / len) * along;
    const ay = (dy / len) * along;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.quadraticCurveTo(
      bx + ax * 0.5 + nx * lift * side * 1.4,
      by + ay * 0.5 + ny * lift * side * 1.4,
      bx + ax,
      by + ay,
    );
    ctx.quadraticCurveTo(bx + ax * 0.5 + nx * lift * side * 0.35, by + ay * 0.5 + ny * lift * side * 0.35, bx, by);
    ctx.fillStyle = `rgba(228, 222, 212, ${rand(0.3, 0.62)})`;
    ctx.fill();
    // Shadowed underside of the curl.
    ctx.strokeStyle = `rgba(16, 12, 9, ${rand(0.35, 0.6)})`;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Dark torn core.
  ctx.strokeStyle = "rgba(12, 9, 7, 0.9)";
  ctx.lineWidth = rand(5, 9);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  // Jagged fibres: short ticks perpendicular to the cut.
  const ticks = Math.max(2, Math.floor(len / 4));
  ctx.strokeStyle = "rgba(214, 206, 194, 0.34)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < ticks; i++) {
    const t = i / ticks;
    const px = x1 + dx * t + rand(-1, 1);
    const py = y1 + dy * t + rand(-1, 1);
    const side = Math.random() < 0.5 ? 1 : -1;
    const tick = rand(3, 9);
    ctx.moveTo(px, py);
    ctx.lineTo(px + nx * tick * side + rand(-2, 2), py + ny * tick * side + rand(-2, 2));
  }
  ctx.stroke();

  // Lit lip along one side so the gash reads as depth.
  ctx.strokeStyle = "rgba(190, 178, 162, 0.42)";
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(x1 + nx * 3, y1 + ny * 3);
  ctx.lineTo(x2 + nx * 3, y2 + ny * 3);
  ctx.stroke();
  ctx.restore();
}

/**
 * Paint palette. Each entry carries its own shade and tint rather than deriving
 * them at draw time — splats are hot enough (one per click, plus every landing
 * droplet) that parsing a hex string back into channels is wasted work.
 */
export const PAINT_COLORS: readonly (readonly [base: string, dark: string, light: string])[] = [
  ["#e63946", "#8d1f29", "#ff8a92"],
  ["#f4a300", "#9a6500", "#ffd166"],
  ["#2a9d8f", "#166058", "#7fe3d7"],
  ["#4361ee", "#22368f", "#93a7ff"],
  ["#b5179e", "#6d0d5f", "#f56fdd"],
  ["#70e000", "#3f8000", "#c1ff7a"],
];

export type Paint = readonly [base: string, dark: string, light: string];

export function randomPaint(): Paint {
  return PAINT_COLORS[Math.floor(Math.random() * PAINT_COLORS.length)];
}

/** A bare CSS colour still works as a splat colour; it just loses the shading. */
function toPaint(paint: Paint | string): Paint {
  return typeof paint === "string" ? [paint, paint, paint] : paint;
}

/**
 * Paintball splatter: thin outer wash, opaque core, satellite droplets, gloss.
 *
 * Returns the palette entry it used so the tool can throw matching particles.
 */
export function drawSplat(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  colour: Paint | string = randomPaint(),
): Paint {
  const paint = toPaint(colour);
  const [base, dark, light] = paint;
  ctx.save();
  ctx.translate(x, y);

  // Thin wash under the blob — real paint feathers out before it pools.
  ctx.fillStyle = dark;
  ctx.globalAlpha = 0.42;
  for (let i = 0; i < 6; i++) {
    const a = Math.random() * TAU;
    const d = rand(2, 13);
    ctx.beginPath();
    ctx.arc(Math.cos(a) * d, Math.sin(a) * d, rand(10, 20), 0, TAU);
    ctx.fill();
  }

  // Opaque core.
  ctx.fillStyle = base;
  ctx.globalAlpha = 0.94;
  for (let i = 0; i < 7; i++) {
    const a = Math.random() * TAU;
    const d = rand(0, 8);
    ctx.beginPath();
    ctx.arc(Math.cos(a) * d, Math.sin(a) * d, rand(6, 14), 0, TAU);
    ctx.fill();
  }

  // Satellite droplets flung outward, with teardrop tails aimed back at impact.
  const sats = 12 + Math.floor(Math.random() * 10);
  for (let i = 0; i < sats; i++) {
    const a = Math.random() * TAU;
    const d = rand(16, 68);
    const r = rand(1, 5) * (1 - d / 88);
    ctx.beginPath();
    ctx.arc(Math.cos(a) * d, Math.sin(a) * d, Math.max(0.8, r), 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(Math.cos(a) * (d - 5), Math.sin(a) * (d - 5), Math.max(0.6, r * 0.7), r * 2, a + Math.PI / 2, 0, TAU);
    ctx.fill();
  }

  // Wet gloss: an off-centre highlight sells the paint as still liquid.
  ctx.fillStyle = light;
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.ellipse(rand(-6, -2), rand(-7, -3), rand(2.5, 5), rand(1.6, 3.2), rand(-0.6, 0.6), 0, TAU);
  ctx.fill();
  ctx.restore();
  ctx.globalAlpha = 1;
  return paint;
}

/**
 * A run of paint left behind by a drip that has finished sliding. Stamped once,
 * when the drip particle dies, rather than repainting the page every frame.
 */
export function drawPaintStreak(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  length: number,
  width: number,
  base: string,
  light = base,
) {
  ctx.save();
  ctx.fillStyle = base;
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.ellipse(x, y - length / 2, width * 0.5, length / 2, 0, 0, TAU);
  ctx.fill();
  // Bead at the bottom, where the run pooled and stopped.
  ctx.beginPath();
  ctx.arc(x, y, width * 0.85, 0, TAU);
  ctx.fill();
  ctx.fillStyle = light;
  ctx.globalAlpha = 0.4;
  ctx.beginPath();
  ctx.ellipse(x - width * 0.25, y - length * 0.55, width * 0.16, length * 0.3, 0, 0, TAU);
  ctx.fill();
  ctx.restore();
  ctx.globalAlpha = 1;
}
