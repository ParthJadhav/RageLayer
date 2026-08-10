import {
  acidSprayerArt,
  glitchGunArt,
  gravityGunArt,
  laserCutterArt,
  stickyBombArt,
  wreckingBallArt,
} from "./advanced-toolart";
import { drawCrack, drawScorch, drawSplat } from "./decals";
import { TAU } from "./math";
import type { DestroyerEngineApi, Tool } from "./types";

function burst(
  engine: DestroyerEngineApi,
  kind: "spark" | "debris" | "smoke" | "ice",
  x: number,
  y: number,
  count: number,
  color?: string,
) {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * TAU;
    const speed = 45 + Math.random() * 210;
    engine.spawnParticle({
      kind,
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 55,
      life: 0,
      maxLife: 0.35 + Math.random() * 0.75,
      size: 1.5 + Math.random() * 4,
      color,
      gravity: kind === "smoke" ? -35 : 380,
      drag: kind === "smoke" ? 1.7 : 0.7,
      angle,
      spin: (Math.random() - 0.5) * 16,
    });
  }
}

let gravityCooldown = 0;
export const gravityGun: Tool = {
  id: "gravity-gun",
  name: "Gravity Gun",
  icon: "🌀",
  hint: "hold to pull, release to launch",
  art: gravityGunArt,
  reset() {
    gravityCooldown = 0;
  },
  onDown(engine, event) {
    if (
      engine.pullDebris(event.x, event.y, 170, 1_600, 1 / 30) === 0 &&
      engine.onPage(event.x, event.y)
    ) {
      engine.fracture(event.x, event.y, 24, { power: 60, count: 5 });
    }
    engine.signalInteraction("gravity", event.x, event.y);
  },
  onUp(engine, event) {
    const aim = engine.toolAim;
    if (engine.launchDebris(event.x, event.y, 190, aim.x, aim.y, 1_150)) {
      engine.spawnParticle({
        kind: "ring",
        x: event.x,
        y: event.y,
        vx: 0,
        vy: 0,
        life: 0,
        maxLife: 0.35,
        size: 70,
        color: "#7bdcff",
      });
      engine.sound.whoosh();
      engine.shake(5, -aim.x, -aim.y);
    }
  },
  tick(engine, dt, held, pointer) {
    gravityCooldown -= dt;
    engine.sound.loop("void", held ? 0.16 : 0);
    if (!held) return;
    const affected = engine.pullDebris(pointer.x, pointer.y, 260, 2_900, dt);
    engine.heat(pointer.x, pointer.y, 55, 0.08);
    if (affected > 0 && gravityCooldown <= 0) {
      gravityCooldown = 0.06;
      const angle = Math.random() * TAU;
      engine.spawnParticle({
        kind: "streak",
        x: pointer.x + Math.cos(angle) * 58,
        y: pointer.y + Math.sin(angle) * 58,
        vx: -Math.cos(angle) * 120,
        vy: -Math.sin(angle) * 120,
        life: 0,
        maxLife: 0.3,
        size: 2,
        len: 30,
        color: "#78d8ff",
      });
    }
  },
};

let laserLast: { x: number; y: number } | null = null;
let laserDebt = 0;
const laserProgress = new Map<string, number>();
export const laserCutter: Tool = {
  id: "laser-cutter",
  name: "Laser Cutter",
  icon: "🔴",
  hint: "drag to precision-cut",
  art: laserCutterArt,
  reset() {
    laserLast = null;
    laserDebt = 0;
    laserProgress.clear();
  },
  onDown(engine, event) {
    laserLast = { x: event.x, y: event.y };
    engine.signalInteraction("laser", event.x, event.y);
  },
  onMove(engine, event) {
    if (!(event.buttons & 1) || !laserLast) return;
    const dx = event.x - laserLast.x;
    const dy = event.y - laserLast.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 2) return;
    const material = engine.materialAt(event.x, event.y);
    const efficiency = 1 / Math.max(0.35, material.toughness);
    const cell = `${Math.round(event.x / 16)}:${Math.round(event.y / 16)}`;
    const progress = (laserProgress.get(cell) ?? 0) + distance;
    if (progress >= 7 * material.toughness) {
      engine.content?.cut(laserLast.x, laserLast.y, event.x, event.y);
      laserProgress.delete(cell);
    } else {
      laserProgress.set(cell, progress);
      if (laserProgress.size > 128) laserProgress.delete(laserProgress.keys().next().value!);
    }
    drawScorch(engine.surfaceCtx, event.x, event.y, 7 + efficiency * 4, 0.58);
    engine.markSurfaceSegment(laserLast.x, laserLast.y, event.x, event.y, 13);
    engine.heat(event.x, event.y, 35, 0.75);
    engine.signalInteraction("laser", event.x, event.y);
    laserDebt += distance * efficiency;
    while (laserDebt >= 11) {
      laserDebt -= 11;
      burst(
        engine,
        "spark",
        event.x,
        event.y,
        1,
        material.conductivity > 0.6 ? "#bfeaff" : "#ffb22e",
      );
    }
    laserLast = { x: event.x, y: event.y };
  },
  onUp() {
    laserLast = null;
  },
  tick(engine, _dt, held, pointer) {
    engine.sound.loop("saw", held ? 0.12 : 0);
    if (held) engine.heat(pointer.x, pointer.y, 28, 0.5);
  },
};

let acidDebt = 0;
export const acidSprayer: Tool = {
  id: "acid-sprayer",
  name: "Acid Sprayer",
  icon: "🧪",
  hint: "hold to corrode materials",
  art: acidSprayerArt,
  reset() {
    acidDebt = 0;
  },
  tick(engine, dt, held, pointer) {
    engine.sound.loop("water", held ? 0.17 : 0);
    if (!held) return;
    acidDebt += dt * 24;
    const aim = engine.toolAim;
    while (acidDebt >= 1) {
      acidDebt--;
      const distance = 14 + Math.random() * 48;
      const x = pointer.x + aim.x * distance + (Math.random() - 0.5) * 22;
      const y = pointer.y + aim.y * distance + (Math.random() - 0.5) * 22;
      engine.spawnParticle({
        kind: "paint",
        x,
        y,
        vx: aim.x * (100 + Math.random() * 170),
        vy: aim.y * (100 + Math.random() * 170),
        life: 0,
        maxLife: 0.45 + Math.random() * 0.45,
        size: 3 + Math.random() * 5,
        color: "#8de323",
        color2: "#dcff63",
        gravity: 260,
      });
      if (!engine.onPage(x, y)) continue;
      const material = engine.materialAt(x, y);
      const power = Math.max(0.08, 1 - material.corrosionResistance);
      const radius = 4 + power * 8;
      engine.content?.burn(x, y, radius);
      drawSplat(engine.surfaceCtx, x, y, ["#72b418", "#365d0d", "#dcff63"]);
      engine.markSurface(x, y, radius * 1.5);
      engine.signalInteraction("acid", x, y);
      if (Math.random() < power * 0.18) burst(engine, "smoke", x, y, 1, "#a8d84b");
    }
  },
};

let wreckLastX = -1_000;
let wreckLastY = -1_000;
let wreckCooldown = 0;
export const wreckingBall: Tool = {
  id: "wrecking-ball",
  name: "Wrecking Ball",
  icon: "⚫",
  hint: "swing the pointer to demolish",
  art: wreckingBallArt,
  reset() {
    wreckLastX = wreckLastY = -1_000;
    wreckCooldown = 0;
  },
  tick(engine, dt, held, pointer) {
    wreckCooldown -= dt;
    const swing = Math.sin((performance.now() / 1_000) * 1.8) * (held ? 0.22 : 0.07);
    const cos = Math.cos(swing);
    const sin = Math.sin(swing);
    const ballX = pointer.x + 49 * cos - 61 * sin;
    const ballY = pointer.y + 49 * sin + 61 * cos;
    if (wreckLastX < -999) {
      wreckLastX = pointer.x;
      wreckLastY = pointer.y;
      return;
    }
    const moveX = pointer.x - wreckLastX;
    const moveY = pointer.y - wreckLastY;
    const velocity = Math.hypot(moveX, moveY) / Math.max(dt, 0.001);
    wreckLastX = pointer.x;
    wreckLastY = pointer.y;
    if (!held || velocity < 210 || wreckCooldown > 0 || !engine.onPage(ballX, ballY)) return;
    wreckCooldown = 0.22;
    const material = engine.materialAt(ballX, ballY);
    const radius = 28 + Math.min(16, velocity / 90);
    drawCrack(engine.surfaceCtx, ballX, ballY, 1.6 + velocity / 900);
    engine.fracture(ballX, ballY, radius, {
      power: Math.min(640, 220 + velocity * 0.38) / Math.sqrt(material.density),
      count: Math.round(7 + radius / 5),
      dirX: moveX / Math.max(1, Math.hypot(moveX, moveY)),
      dirY: moveY / Math.max(1, Math.hypot(moveX, moveY)),
    });
    engine.signalInteraction("impact", ballX, ballY);
    engine.shake(Math.min(20, 8 + velocity / 100), moveX, moveY);
    engine.sound.hammer(1);
    burst(engine, "debris", ballX, ballY, 10);
  },
};

interface PlacedBomb {
  x: number;
  y: number;
  fuse: number;
  radius: number;
}

const bombs: PlacedBomb[] = [];
export const stickyBombs: Tool = {
  id: "sticky-bombs",
  name: "Sticky Bombs",
  icon: "💣",
  hint: "click to stick; timed detonation",
  art: stickyBombArt,
  reset() {
    bombs.length = 0;
  },
  onDown(engine, event) {
    if (!engine.onPage(event.x, event.y)) return;
    if (bombs.length >= 8) bombs.shift();
    bombs.push({ x: event.x, y: event.y, fuse: 1.15, radius: 48 });
    const ctx = engine.surfaceCtx;
    ctx.save();
    ctx.fillStyle = "#202826";
    ctx.strokeStyle = "#080a09";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(event.x - 14, event.y - 9, 28, 18, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#ff3c20";
    ctx.beginPath();
    ctx.arc(event.x + 8, event.y - 4, 2.5, 0, TAU);
    ctx.fill();
    ctx.restore();
    engine.markSurface(event.x, event.y, 18);
    engine.sound.tink();
  },
  tick(engine, dt) {
    for (let i = bombs.length - 1; i >= 0; i--) {
      const bomb = bombs[i];
      bomb.fuse -= dt;
      if (bomb.fuse > 0) {
        if (bomb.fuse < 0.45 && Math.random() < dt * 10)
          burst(engine, "spark", bomb.x, bomb.y, 1, "#ff3b1f");
        continue;
      }
      bombs.splice(i, 1);
      engine.explode(bomb.x, bomb.y, bomb.radius, { power: 610, incendiary: true });
    }
  },
};

let glitchCooldown = 0;
export const glitchGun: Tool = {
  id: "glitch-gun",
  name: "Glitch Gun",
  icon: "👾",
  hint: "click or hold to corrupt reality",
  art: glitchGunArt,
  reset() {
    glitchCooldown = 0;
  },
  onDown(engine, event) {
    glitchCooldown = 0;
    corrupt(engine, event.x, event.y);
  },
  tick(engine, dt, held, pointer) {
    glitchCooldown -= dt;
    engine.sound.loop("void", held ? 0.11 : 0);
    if (held && glitchCooldown <= 0) {
      glitchCooldown = 0.085;
      corrupt(engine, pointer.x, pointer.y);
    }
  },
};

function corrupt(engine: DestroyerEngineApi, x: number, y: number) {
  if (!engine.onPage(x, y)) return;
  const ctx = engine.surfaceCtx;
  ctx.save();
  // Datamosh first: slices of the real page torn sideways, which reads on any
  // backdrop. Colored bars alone disappear into light themes.
  for (let i = 0; i < 6; i++) {
    const sliceW = 26 + Math.random() * 64;
    const sliceH = 3 + Math.random() * 7;
    const sliceX = x + (Math.random() - 0.5) * 30;
    const sliceY = y + (Math.random() - 0.5) * 56;
    const shift = (Math.random() < 0.5 ? -1 : 1) * (6 + Math.random() * 20);
    const patch = engine.content?.patch(sliceX, sliceY, sliceW, sliceH);
    if (patch) {
      ctx.drawImage(
        patch.img,
        patch.sx,
        patch.sy,
        patch.sw,
        patch.sh,
        sliceX - sliceW / 2 + shift,
        sliceY - sliceH / 2,
        sliceW,
        sliceH,
      );
    }
  }
  // Chromatic interference on top — `difference` inverts against light pixels
  // and passes through on dark ones, so it stays loud either way.
  const colors = ["rgba(0,238,255,.5)", "rgba(255,24,140,.48)", "rgba(196,255,24,.35)"];
  ctx.globalCompositeOperation = "difference";
  for (let i = 0; i < 5; i++) {
    const width = 8 + Math.random() * 48;
    const height = 2 + Math.random() * 7;
    ctx.fillStyle = colors[i % colors.length];
    ctx.fillRect(
      x - width / 2 + (Math.random() - 0.5) * 30,
      y + (Math.random() - 0.5) * 56,
      width,
      height,
    );
  }
  ctx.restore();
  engine.markSurface(x, y, 60);
  engine.signalInteraction("glitch", x, y);
  engine.spawnParticle({
    kind: "ring",
    x,
    y,
    vx: 0,
    vy: 0,
    life: 0,
    maxLife: 0.28,
    size: 44,
    color: "#e43cff",
  });
  if (Math.random() < 0.12) engine.content?.punch(x, y, 3 + Math.random() * 7);
  engine.sound.zap();
}

export const advancedTools: Tool[] = [
  gravityGun,
  laserCutter,
  acidSprayer,
  wreckingBall,
  stickyBombs,
  glitchGun,
];
