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
  const slosh = Math.sin(state.time * 3) * 2;
  ctx.save();
  ctx.fillStyle = "#242b2c";
  ctx.beginPath();
  ctx.roundRect(18, 3, 55, 25, 8);
  ctx.fill();
  ctx.strokeStyle = "#0a0d0d";
  ctx.stroke();
  ctx.fillStyle = "#a8b1b2";
  ctx.beginPath();
  ctx.moveTo(18, 9);
  ctx.lineTo(-6, 13);
  ctx.lineTo(18, 20);
  ctx.fill();
  ctx.fillStyle = "#253b26";
  ctx.beginPath();
  ctx.roundRect(34, 28, 32, 48, 9);
  ctx.fill();
  ctx.stroke();
  const liquid = ctx.createLinearGradient(0, 38, 0, 71);
  liquid.addColorStop(0, "#d8ff47");
  liquid.addColorStop(1, "#48a913");
  ctx.fillStyle = liquid;
  ctx.beginPath();
  ctx.roundRect(39, 38 + slosh, 22, 31 - slosh, 6);
  ctx.fill();
  glow(ctx, 50, 56, 18, "rgba(132,255,33,.35)");
  ctx.fillStyle = "#caff60";
  ctx.beginPath();
  ctx.arc(-7, 14, state.held ? 4 : 2, 0, TAU);
  ctx.fill();
  ctx.restore();
};

export const wreckingBallArt: ToolArtFn = (ctx, state) => {
  const swing = Math.sin(state.time * 1.8) * (state.held ? 0.22 : 0.07);
  ctx.save();
  ctx.rotate(swing);
  ctx.strokeStyle = "#4e555e";
  ctx.lineWidth = 4;
  ctx.setLineDash([3, 2]);
  ctx.beginPath();
  ctx.moveTo(4, -8);
  ctx.lineTo(45, 55);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = metal(ctx, 28, 42, 65, 73);
  ctx.beginPath();
  ctx.arc(49, 61, 18, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = "#090b0e";
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,.35)";
  ctx.beginPath();
  ctx.arc(43, 55, 5, 0, TAU);
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

export const glitchGunArt: ToolArtFn = (ctx, state) => {
  const jitter = state.held ? Math.sin(state.time * 70) * 2 : 0;
  ctx.save();
  ctx.translate(jitter, 0);
  glow(ctx, 2, 12, 17, "rgba(220,30,255,.65)");
  gunBody(ctx, "#7a268d");
  ctx.fillStyle = "#16e9ff";
  ctx.fillRect(-8, 7, 17, 3);
  ctx.fillStyle = "#ff2b82";
  ctx.fillRect(-12, 14, 21, 3);
  ctx.fillStyle = "#d7ff36";
  ctx.fillRect(-4, 20, 13, 2);
  ctx.fillStyle = "rgba(255,255,255,.7)";
  ctx.font = "bold 10px monospace";
  ctx.fillText("ERR", 31, 24);
  ctx.restore();
};

registerToolIconBounds(gravityGunArt, [40, 45, 140, 150]);
registerToolIconBounds(laserCutterArt, [34, 40, 135, 140]);
registerToolIconBounds(acidSprayerArt, [48, 50, 145, 148]);
registerToolIconBounds(wreckingBallArt, [55, 48, 140, 150]);
registerToolIconBounds(stickyBombArt, [60, 64, 133, 130]);
registerToolIconBounds(glitchGunArt, [42, 45, 142, 150]);
