/**
 * The heavy ordnance: demolition breaker, rocket launcher, storm rod, singularity
 * ring and specimen jar. Same conventions as `./base`.
 */

import { TAU } from "../math";
import type { ToolArtFn } from "../types";
import {
  BRASS,
  type Ctx,
  castShadow,
  DARKMETAL,
  glow,
  grad,
  hash,
  OLIVE,
  outline,
  RED,
  rivet,
  rod,
  STEEL,
} from "./primitives";

// ── Demolition breaker ───────────────────────────────────────────────────────

/** Compact hydraulic breaker with its chisel tip exactly on the pointer. */
export const demolitionArt: ToolArtFn = (ctx, s) => {
  const recoil = Number.isFinite(s.sinceDown) ? Math.exp(-s.sinceDown * 15) * 5 : 0;
  const vibration = s.held ? Math.sin(s.time * 75) * 1.2 : 0;
  ctx.save();
  ctx.translate(recoil + vibration, 0);
  castShadow(ctx, 52, 18, 50, 12, 0.2);

  // Hardened chisel: the point at (0, 0) is where the page is struck.
  ctx.fillStyle = grad(ctx, 0, -4, 0, 4, STEEL);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(28, -6);
  ctx.lineTo(35, -4);
  ctx.lineTo(35, 4);
  ctx.lineTo(28, 6);
  ctx.closePath();
  ctx.fill();
  outline(ctx, 0.6);

  // High-visibility hydraulic body with a dark steel collar.
  ctx.fillStyle = grad(ctx, 0, -15, 0, 15, [
    [0, "#6d4305"],
    [0.28, "#ffe26a"],
    [0.58, "#d59a16"],
    [1, "#704806"],
  ]);
  ctx.beginPath();
  ctx.roundRect(32, -15, 56, 30, 7);
  ctx.fill();
  outline(ctx);
  ctx.fillStyle = grad(ctx, 0, -13, 0, 13, DARKMETAL);
  ctx.beginPath();
  ctx.roundRect(28, -12, 12, 24, 3);
  ctx.fill();
  outline(ctx, 0.6);

  // Rear motor cap, vents and a stout two-hand grip.
  ctx.fillStyle = DARKMETAL[1][1];
  ctx.beginPath();
  ctx.roundRect(84, -12, 11, 24, 4);
  ctx.fill();
  outline(ctx, 0.6);
  ctx.fillStyle = "rgba(35,29,15,.55)";
  for (let x = 50; x <= 72; x += 7) ctx.fillRect(x, -10, 3, 20);
  ctx.fillStyle = grad(ctx, 0, -40, 0, -12, DARKMETAL);
  ctx.beginPath();
  ctx.roundRect(59, -39, 13, 27, 5);
  ctx.fill();
  outline(ctx, 0.6);
  ctx.fillStyle = "#f6c33a";
  ctx.beginPath();
  ctx.roundRect(72, -31, 17, 9, 4);
  ctx.fill();
  outline(ctx, 0.5);

  rivet(ctx, 44, 0, 2);
  rivet(ctx, 81, 0, 2);
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
