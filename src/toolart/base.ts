/**
 * The everyday tools: hammer, gun, flamethrower, hose, chainsaw, paintball
 * marker and broom. See `./primitives` for the shared conventions (origin at
 * the pointer hotspot, light from the upper left, animation derived rather
 * than stored).
 */

import { TAU } from "../math";
import type { ToolArtFn } from "../types";
import {
  BRASS,
  castShadow,
  DARKMETAL,
  easeOut,
  glow,
  grad,
  hash,
  IRON,
  ORANGE,
  outline,
  RED,
  rivet,
  rod,
  STEEL,
  STRAW,
  TEAL,
  WOOD,
} from "./primitives";

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

  castShadow(ctx, 35, 39, 43, 14, 0.17);

  ctx.save();
  ctx.rotate(0.5 - kick * 0.13);
  ctx.translate(kick * 5, bob * 0.2);

  // Polymer frame: a defined dust cover and a slight beavertail give the
  // silhouette real pistol proportions instead of a rectangle on a stick.
  ctx.fillStyle = grad(ctx, 0, 2, 0, 18, DARKMETAL);
  ctx.beginPath();
  ctx.moveTo(5, 3);
  ctx.lineTo(55, 3);
  ctx.lineTo(59, 7);
  ctx.lineTo(55, 14);
  ctx.lineTo(39, 14);
  ctx.lineTo(34, 11);
  ctx.lineTo(5, 11);
  ctx.closePath();
  ctx.fill();
  outline(ctx);

  // Accessory rail cuts beneath the dust cover.
  ctx.strokeStyle = "rgba(180,188,198,0.42)";
  ctx.lineWidth = 1.1;
  for (let x = 12; x <= 24; x += 4) {
    ctx.beginPath();
    ctx.moveTo(x, 9);
    ctx.lineTo(x + 2, 11);
    ctx.stroke();
  }

  // Trigger guard: an open loop; trigger inside.
  ctx.strokeStyle = "#26282e";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(23, 12);
  ctx.quadraticCurveTo(22, 26, 37, 25);
  ctx.lineTo(41, 14);
  ctx.stroke();
  ctx.strokeStyle = "#a5abb3";
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.moveTo(32, 13);
  ctx.quadraticCurveTo(29, 19, 33, 22);
  ctx.stroke();

  // Raked grip with a palm swell, stipple field, and magazine floor plate.
  ctx.save();
  ctx.translate(41, 8);
  ctx.rotate(0.36);
  ctx.fillStyle = grad(ctx, 0, 0, 16, 0, [
    [0, "#17191d"],
    [0.38, "#42464d"],
    [0.72, "#292c31"],
    [1, "#101115"],
  ]);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(15, 0);
  ctx.lineTo(17, 30);
  ctx.quadraticCurveTo(10, 37, 1, 33);
  ctx.closePath();
  ctx.fill();
  outline(ctx);
  ctx.fillStyle = "rgba(5,6,8,0.6)";
  for (let r = 0; r < 5; r++)
    for (let c = 0; c < 3; c++) {
      ctx.beginPath();
      ctx.arc(4 + c * 4.2, 7 + r * 5.2, 0.85, 0, TAU);
      ctx.fill();
    }
  ctx.fillStyle = "#17191d";
  ctx.beginPath();
  ctx.roundRect(-1, 32, 19, 5, 2);
  ctx.fill();
  outline(ctx, 0.45);
  ctx.restore();

  // Barrel stays tied to the hotspot while the slide reciprocates around it.
  // That muzzle relationship is the visual promise that shots originate here.
  ctx.fillStyle = grad(ctx, 0, -5, 0, 5, IRON);
  ctx.beginPath();
  ctx.roundRect(-1, -5, 48, 10, 3);
  ctx.fill();

  // Slide: longer and lower than the frame, with beveled nose and rear mass.
  const slideBack = kick * 7;
  ctx.save();
  ctx.translate(slideBack, 0);
  ctx.fillStyle = grad(ctx, 0, -11, 0, 7, STEEL);
  ctx.beginPath();
  ctx.moveTo(-4, -7);
  ctx.quadraticCurveTo(-4, -10, 0, -11);
  ctx.lineTo(60, -11);
  ctx.quadraticCurveTo(64, -10, 64, -6);
  ctx.lineTo(64, 5);
  ctx.lineTo(1, 6);
  ctx.quadraticCurveTo(-4, 5, -4, 1);
  ctx.closePath();
  ctx.fill();
  outline(ctx);

  // Top bevel and front/rear serrations make the slide's direction readable.
  ctx.strokeStyle = "rgba(255,255,255,0.42)";
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(1, -8.5);
  ctx.lineTo(59, -8.5);
  ctx.stroke();
  // Rear serrations.
  ctx.strokeStyle = "rgba(15,16,20,0.7)";
  ctx.lineWidth = 1.35;
  for (let i = 0; i < 6; i++) {
    ctx.beginPath();
    ctx.moveTo(47 + i * 2.3, -8);
    ctx.lineTo(46 + i * 2.3, 3);
    ctx.stroke();
  }
  // Ejection port: open while cycling.
  ctx.fillStyle = kick > 0.35 ? "#0a0a0c" : "#31353c";
  ctx.beginPath();
  ctx.roundRect(27, -7.5, 15, 7, 1.5);
  ctx.fill();
  ctx.strokeStyle = "rgba(230,190,95,0.42)";
  ctx.lineWidth = 1;
  ctx.stroke();
  // Sights.
  ctx.fillStyle = "#15161a";
  ctx.fillRect(1, -14, 3.5, 3.5);
  ctx.fillRect(56, -14.5, 5, 4);
  ctx.fillStyle = "#d7e4cf";
  ctx.fillRect(2.2, -13.4, 1.2, 1.2);
  ctx.restore();

  // Front face and concentric barrel crown, centred exactly on the hotspot.
  ctx.fillStyle = grad(ctx, 0, -7, 0, 7, IRON);
  ctx.beginPath();
  ctx.ellipse(0, 0, 4.5, 6.2, 0, 0, TAU);
  ctx.fill();
  outline(ctx, 0.55);
  ctx.beginPath();
  ctx.arc(0, 0, 2.65, 0, TAU);
  ctx.fillStyle = "#050506";
  ctx.fill();

  // Barrel heat while hammering on auto.
  if (s.held && s.sinceDown > 0.4)
    glow(ctx, 0, 0, 14, "rgba(255,120,40,0.5)", Math.min(0.5, (s.sinceDown - 0.4) * 0.5));

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

/** Compact pistol-grip pressure nozzle; the water connection ends at the grip. */
export const waterHoseArt: ToolArtFn = (ctx, s) => {
  const a = Math.atan2(s.aimY, s.aimX);
  const wob = s.held ? Math.sin(s.time * 23) * 1.2 : Math.sin(s.time * 2.1) * 0.35;

  castShadow(ctx, 28, 35, 34, 12, 0.15);

  ctx.save();
  ctx.rotate(a + Math.PI);
  ctx.translate(0, wob * 0.3);

  // Main pressure body: short enough to read as handheld, with the outlet
  // exactly at the pointer hotspot.
  rod(ctx, 9, 0, 39, 0, 13, BRASS);
  rod(ctx, 32, 0, 43, 0, 15, IRON, 0.42);

  // Knurled flow collar.
  ctx.strokeStyle = "rgba(60,42,10,0.6)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 5; i++) {
    ctx.beginPath();
    ctx.moveTo(23 + i * 2.2, -5.5);
    ctx.lineTo(25 + i * 2.2, 5.5);
    ctx.stroke();
  }

  // Tapered outlet and dark bore.
  ctx.fillStyle = grad(ctx, 0, -6, 0, 6, BRASS);
  ctx.beginPath();
  ctx.moveTo(11, -6);
  ctx.lineTo(1, -2.6);
  ctx.lineTo(1, 2.6);
  ctx.lineTo(11, 6);
  ctx.closePath();
  ctx.fill();
  outline(ctx);
  ctx.beginPath();
  ctx.arc(1.5, 0, 1.8, 0, TAU);
  ctx.fillStyle = "#0a1c26";
  ctx.fill();

  // Rubberized pistol grip and squeeze lever. The quick-connect fitting ends
  // beneath the hand; there is deliberately no long decorative pipe attached.
  ctx.save();
  ctx.translate(31, 5);
  ctx.rotate(0.42);
  ctx.fillStyle = grad(ctx, 0, 0, 13, 0, [
    [0, "#173c31"],
    [0.45, "#32715d"],
    [1, "#102b23"],
  ]);
  ctx.beginPath();
  ctx.roundRect(0, 0, 13, 27, 4);
  ctx.fill();
  outline(ctx);
  ctx.strokeStyle = "rgba(205,240,225,0.3)";
  ctx.lineWidth = 1.2;
  for (let y = 6; y < 24; y += 5) {
    ctx.beginPath();
    ctx.moveTo(3, y);
    ctx.lineTo(10, y);
    ctx.stroke();
  }
  ctx.restore();

  ctx.strokeStyle = "#20262a";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(20, 6);
  ctx.quadraticCurveTo(20, 17, 31, 17);
  ctx.stroke();
  ctx.strokeStyle = "#d5a939";
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.moveTo(27, 7);
  ctx.quadraticCurveTo(24, 12, 27, 15);
  ctx.stroke();

  // Small quick connector — a visual full stop, not a trailing hose.
  ctx.save();
  ctx.translate(42, 25);
  ctx.rotate(Math.PI / 2 + 0.42);
  rod(ctx, -5, 0, 5, 0, 10, IRON);
  ctx.restore();
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
  if (s.held && s.sinceDown > 0.12) {
    const pulse = (s.sinceDown % 0.16) / 0.16;
    kick = Math.max(kick, (1 - pulse) * 0.72);
  }
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
