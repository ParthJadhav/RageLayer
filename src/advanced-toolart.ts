import { registerToolIconBounds } from "./icon-bounds";
import { TAU } from "./math";
import type { ToolArtFn } from "./types";

type Ctx = CanvasRenderingContext2D;
function metal(ctx: Ctx, x0: number, y0: number, x1: number, y1: number) {
  const gradient = ctx.createLinearGradient(x0, y0, x1, y1);
  gradient.addColorStop(0, "#151922");
  gradient.addColorStop(0.28, "#778397");
  gradient.addColorStop(0.46, "#e3e9f0");
  gradient.addColorStop(0.7, "#596273");
  gradient.addColorStop(1, "#11141b");
  return gradient;
}

function glow(ctx: Ctx, x: number, y: number, radius: number, color: string) {
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
  gradient.addColorStop(0, color);
  gradient.addColorStop(1, "transparent");
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, TAU);
  ctx.fill();
  ctx.restore();
}

function gunBody(ctx: Ctx, color: string) {
  ctx.fillStyle = metal(ctx, 8, 6, 8, 42);
  ctx.beginPath();
  ctx.roundRect(7, 7, 62, 29, 7);
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,.65)";
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(25, 13, 34, 15, 5);
  ctx.fill();
  ctx.fillStyle = "#202632";
  ctx.beginPath();
  ctx.moveTo(43, 34);
  ctx.lineTo(64, 70);
  ctx.lineTo(48, 78);
  ctx.lineTo(28, 34);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = "rgba(255,255,255,.28)";
  for (let y = 48; y < 69; y += 7) {
    ctx.beginPath();
    ctx.moveTo(43, y);
    ctx.lineTo(57, y - 5);
    ctx.stroke();
  }
}

export const gravityGunArt: ToolArtFn = (ctx, state) => {
  const pulse = 0.75 + Math.sin(state.time * 8) * 0.2 + (state.held ? 0.2 : 0);
  ctx.save();
  ctx.translate(2, 0);
  glow(ctx, 2, 12, 23 * pulse, "rgba(85,190,255,.75)");
  gunBody(ctx, "#2e7192");
  ctx.strokeStyle = "#8794a4";
  ctx.lineWidth = 4;
  for (const y of [9, 25]) {
    ctx.beginPath();
    ctx.moveTo(13, y);
    ctx.quadraticCurveTo(-3, y + (y < 15 ? -7 : 7), -8, 12);
    ctx.stroke();
  }
  ctx.fillStyle = "#bfeeff";
  ctx.beginPath();
  ctx.arc(-7, 12, 5, 0, TAU);
  ctx.fill();
  ctx.restore();
};

export const laserCutterArt: ToolArtFn = (ctx, state) => {
  const hot = state.held ? 1 : 0.55 + Math.sin(state.time * 5) * 0.08;
  glow(ctx, 0, 4, 16 + hot * 7, "rgba(255,40,15,.8)");
  ctx.save();
  ctx.rotate(-0.08);
  ctx.fillStyle = metal(ctx, 0, -3, 0, 22);
  ctx.beginPath();
  ctx.roundRect(0, -3, 70, 25, 7);
  ctx.fill();
  ctx.strokeStyle = "#090b0f";
  ctx.stroke();
  ctx.fillStyle = "#d54b2e";
  ctx.fillRect(23, 2, 28, 8);
  ctx.fillStyle = "#161b22";
  ctx.beginPath();
  ctx.moveTo(46, 20);
  ctx.lineTo(66, 64);
  ctx.lineTo(49, 70);
  ctx.lineTo(31, 21);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#fafafa";
  ctx.fillRect(-8, 2, 11, 4);
  ctx.restore();
  if (state.held) {
    ctx.strokeStyle = "rgba(255,55,20,.95)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-9, 4);
    ctx.lineTo(-28, 4);
    ctx.stroke();
  }
};

export const acidSprayerArt: ToolArtFn = (ctx, state) => {
  const slosh = Math.sin(state.time * 3) * 2.2;
  const aim = Math.atan2(state.aimY, state.aimX);
  ctx.save();
  // The open mouth is the pointer hotspot. The jar trails behind the pour so
  // the vessel, emitted liquid and affected surface remain collinear.
  ctx.rotate(aim + Math.PI);

  // A broad green pool inside the glass keeps the silhouette legible in the
  // 30px toolbar bake, where the old gun body collapsed into dark fragments.
  glow(ctx, 48, 0, 31, "rgba(132,255,33,.42)");

  // Soft contact shadow beneath the tilted jar.
  ctx.save();
  ctx.globalAlpha = 0.2;
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.ellipse(47, 20, 31, 8, 0, 0, TAU);
  ctx.fill();
  ctx.restore();

  // Thick glass jar: short neck, broad shoulder, rounded base.
  const vessel = new Path2D();
  vessel.moveTo(3, -8);
  vessel.lineTo(18, -8);
  vessel.bezierCurveTo(24, -8, 24, -21, 35, -22);
  vessel.lineTo(61, -22);
  vessel.quadraticCurveTo(72, -22, 72, -11);
  vessel.lineTo(72, 11);
  vessel.quadraticCurveTo(72, 22, 61, 22);
  vessel.lineTo(35, 22);
  vessel.bezierCurveTo(24, 21, 24, 8, 18, 8);
  vessel.lineTo(3, 8);
  vessel.closePath();
  const glass = ctx.createLinearGradient(0, -22, 0, 22);
  glass.addColorStop(0, "rgba(214,236,229,.78)");
  glass.addColorStop(0.28, "rgba(91,118,113,.52)");
  glass.addColorStop(0.72, "rgba(32,53,49,.72)");
  glass.addColorStop(1, "rgba(164,196,184,.58)");
  ctx.fillStyle = glass;
  ctx.fill(vessel);
  ctx.strokeStyle = "#08110e";
  ctx.lineWidth = 3;
  ctx.stroke(vessel);

  // Acid body and moving meniscus, clipped to the jar interior.
  ctx.save();
  ctx.clip(vessel);
  const liquid = ctx.createLinearGradient(27, -18, 68, 18);
  liquid.addColorStop(0, "#dcff54");
  liquid.addColorStop(0.45, "#85ed20");
  liquid.addColorStop(1, "#2e8d0b");
  ctx.fillStyle = liquid;
  ctx.beginPath();
  ctx.roundRect(27, -12 + slosh, 43, 31 - slosh, 10);
  ctx.fill();
  ctx.strokeStyle = "rgba(229,255,118,.9)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(30, -11 + slosh);
  ctx.quadraticCurveTo(49, -8 + slosh, 68, -12 + slosh);
  ctx.stroke();
  for (const [x, y, r] of [
    [42, 4, 2.3],
    [57, 8, 1.7],
    [62, -2, 1.2],
  ] as const) {
    ctx.fillStyle = "rgba(225,255,135,.72)";
    ctx.beginPath();
    ctx.arc(x, y + slosh * 0.3, r, 0, TAU);
    ctx.fill();
  }
  ctx.restore();

  // Glass rim, highlight, and an unmistakably open mouth.
  ctx.strokeStyle = "rgba(236,255,249,.72)";
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(34, -18);
  ctx.quadraticCurveTo(52, -24, 65, -17);
  ctx.stroke();
  ctx.fillStyle = "#192723";
  ctx.beginPath();
  ctx.roundRect(-2, -10, 11, 20, 4);
  ctx.fill();
  ctx.strokeStyle = "#08110e";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = "#75d91c";
  ctx.beginPath();
  ctx.ellipse(-1.5, 0, 2.3, 5.5, 0, 0, TAU);
  ctx.fill();

  // The held pose visibly pours; the rest pose keeps one bead at the lip.
  ctx.fillStyle = "#bdff43";
  ctx.beginPath();
  ctx.arc(state.held ? -8 : -4, 0, state.held ? 3.2 : 2, 0, TAU);
  ctx.fill();
  ctx.restore();
};

export const stickyBombArt: ToolArtFn = (ctx, state) => {
  const blink = Math.sin(state.time * 10) > 0;
  ctx.save();
  ctx.rotate(-0.18);
  ctx.fillStyle = "rgba(0,0,0,.2)";
  ctx.beginPath();
  ctx.ellipse(35, 48, 30, 13, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = "#2c3432";
  ctx.beginPath();
  ctx.roundRect(5, 8, 53, 40, 12);
  ctx.fill();
  ctx.strokeStyle = "#0a0c0b";
  ctx.stroke();
  ctx.fillStyle = "#59625d";
  ctx.fillRect(10, 17, 43, 6);
  ctx.fillRect(10, 34, 43, 5);
  ctx.fillStyle = blink || state.held ? "#ff3b24" : "#5f1711";
  ctx.beginPath();
  ctx.arc(46, 13, 4, 0, TAU);
  ctx.fill();
  ctx.restore();
};

registerToolIconBounds(gravityGunArt, [40, 45, 140, 150]);
registerToolIconBounds(laserCutterArt, [34, 40, 135, 140]);
registerToolIconBounds(acidSprayerArt, [55, 57, 119, 139]);
registerToolIconBounds(stickyBombArt, [60, 64, 133, 130]);
