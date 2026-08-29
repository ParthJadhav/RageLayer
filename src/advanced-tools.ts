import { acidSprayerArt, gravityGunArt, laserCutterArt, stickyBombArt } from "./advanced-toolart";
import { TAU } from "./math";
import { createEngineState } from "./tool-kit";
import { includeTopologySegment, surfaceRuns, type TopologyBounds } from "./topology";
import type { RageLayerEngineApi, Tool } from "./types";
import { WOOD } from "./wood";

function sparkBurst(
  engine: RageLayerEngineApi,
  x: number,
  y: number,
  count: number,
  color?: string,
) {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * TAU;
    const speed = 45 + Math.random() * 210;
    engine.spawnParticle({
      kind: "spark",
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 55,
      life: 0,
      maxLife: 0.35 + Math.random() * 0.75,
      size: 1.5 + Math.random() * 4,
      color,
      gravity: 380,
      drag: 0.7,
      angle,
      spin: (Math.random() - 0.5) * 16,
    });
  }
}

const gravityStates = createEngineState(() => ({ cooldown: 0 }));
export const gravityGun: Tool = {
  id: "gravity-gun",
  name: "Gravity Gun",
  icon: "🌀",
  hint: "hold to pull, release to launch",
  art: gravityGunArt,
  reset: (engine) => gravityStates.reset(engine),
  hasPendingWork: () => false,
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
    const state = gravityStates.get(engine);
    state.cooldown -= dt;
    engine.sound.loop("void", held ? 0.16 : 0);
    if (!held) return;
    const affected = engine.pullDebris(pointer.x, pointer.y, 260, 2_900, dt);
    engine.heat(pointer.x, pointer.y, 55, 0.08);
    if (affected > 0 && state.cooldown <= 0) {
      state.cooldown = 0.06;
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

interface LaserState {
  last: { x: number; y: number } | null;
  sparkDebt: number;
  scanDebt: number;
  cutBounds: TopologyBounds | null;
}

const laserStates = createEngineState<LaserState>(() => ({
  last: null,
  sparkDebt: 0,
  scanDebt: 0,
  cutBounds: null,
}));
const LASER_TOPOLOGY_INTERVAL = 24;

function releaseLaserIslands(engine: RageLayerEngineApi, state: LaserState) {
  if (!state.cutBounds) return 0;
  state.scanDebt = 0;
  return engine.dislodge(
    state.cutBounds.x0,
    state.cutBounds.y0,
    state.cutBounds.x1,
    state.cutBounds.y1,
  );
}

export const laserCutter: Tool = {
  id: "laser-cutter",
  name: "Laser Cutter",
  icon: "🔴",
  hint: "drag a clean cut — any isolated shape drops",
  art: laserCutterArt,
  reset: (engine) => laserStates.reset(engine),
  hasPendingWork: () => false,
  onDown(engine, event) {
    const state = laserStates.get(engine);
    state.last = { x: event.x, y: event.y };
    state.sparkDebt = 0;
    state.scanDebt = 0;
    state.cutBounds = null;
  },
  onMove(engine, event) {
    const state = laserStates.get(engine);
    if (!(event.buttons & 1) || !state.last) return;
    const dx = event.x - state.last.x;
    const dy = event.y - state.last.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 1) return;

    // Clip the beam against current material, exactly as the chainsaw does.
    // Each surviving run is one constant-width Path2D cut, so sparse pointer
    // events still produce a straight, continuous kerf without dwell cells or
    // dashed catch-up passes.
    const runs = surfaceRuns(state.last.x, state.last.y, event.x, event.y, (x, y) =>
      engine.onPage(x, y),
    );
    let cutLength = 0;
    let contactX = event.x;
    let contactY = event.y;
    for (const run of runs) {
      engine.content?.cut(run.x1, run.y1, run.x2, run.y2, { edge: "clean", width: 3 });
      state.cutBounds = includeTopologySegment(state.cutBounds, run.x1, run.y1, run.x2, run.y2);
      state.scanDebt += run.length;
      cutLength += run.length;
      contactX = run.x2;
      contactY = run.y2;
    }

    state.last = { x: event.x, y: event.y };
    if (cutLength <= 0) return;

    engine.signalInteraction("laser", contactX, contactY);
    engine.heat(contactX, contactY, 35, 0.75);
    state.sparkDebt += cutLength;
    while (state.sparkDebt >= 11) {
      state.sparkDebt -= 11;
      sparkBurst(engine, contactX, contactY, 1, "#ffb22e");
    }
    if (state.scanDebt >= LASER_TOPOLOGY_INTERVAL) {
      const released = releaseLaserIslands(engine, state);
      if (released > 0) engine.shake(7 + released * 2);
    }
  },
  onUp(engine) {
    const state = laserStates.get(engine);
    const released = releaseLaserIslands(engine, state);
    if (released > 0) engine.shake(7 + released * 2);
    state.last = null;
    state.scanDebt = 0;
    state.cutBounds = null;
  },
  tick(engine, _dt, held, pointer) {
    engine.sound.loop("saw", held ? 0.12 : 0);
    if (held) engine.heat(pointer.x, pointer.y, 28, 0.5);
  },
};

const ACID_DROPS_PER_SECOND = 24;
const ACID_DEPOSIT_LIMIT = 48;
const ACID_CREEP_LIFETIME = 3.2;
const ACID_CREEP_PER_SECOND = 3;
const ACID_CREEP_REACH = 28;
const ACID_POWER = 1 - WOOD.corrosionResistance;
const ACID_IMPACT_RADIUS = 3 + ACID_POWER * 4;

interface AcidDeposit {
  x: number;
  y: number;
  seed: number;
  age: number;
  creepDebt: number;
  creepStep: number;
  phase: number;
}

interface AcidState {
  debt: number;
  sequence: number;
  deposits: AcidDeposit[];
}

const acidStates = createEngineState<AcidState>(() => ({ debt: 0, sequence: 0, deposits: [] }));

/** Stable 0..1 noise for bounded spread; independent of frame subdivision. */
function acidNoise(seed: number) {
  const value = Math.sin(seed * 12.9898 + 78.233) * 43_758.5453;
  return value - Math.floor(value);
}

function drawAcidStain(
  engine: RageLayerEngineApi,
  x: number,
  y: number,
  radius: number,
  seed: number,
) {
  const ctx = engine.surfaceCtx;
  const angle = acidNoise(seed + 2) * TAU;
  const offset = radius * 0.45;
  ctx.save();
  ctx.globalCompositeOperation = "source-atop";
  const stain = ctx.createRadialGradient(x, y, 0, x, y, radius * 1.8);
  stain.addColorStop(0, "rgba(210, 255, 74, 0.78)");
  stain.addColorStop(0.42, "rgba(104, 174, 24, 0.66)");
  stain.addColorStop(1, "rgba(37, 73, 10, 0)");
  ctx.fillStyle = stain;
  ctx.beginPath();
  ctx.arc(x, y, radius * 1.8, 0, TAU);
  ctx.arc(x + Math.cos(angle) * offset, y + Math.sin(angle) * offset, radius * 0.8, 0, TAU);
  ctx.fill();

  // The burn clears the wet centre, so leave a bright reaction rim on the
  // surviving wood. Without this edge a settled acid mark reads as an
  // ordinary black puncture once its short-lived droplets have evaporated.
  // `source-atop` keeps the ring off transparent holes.
  ctx.strokeStyle = "rgba(190, 255, 65, 0.82)";
  ctx.lineWidth = Math.max(1.2, radius * 0.28);
  ctx.beginPath();
  ctx.arc(x, y, radius * (1.18 + acidNoise(seed + 4) * 0.22), 0, TAU);
  ctx.stroke();
  ctx.strokeStyle = "rgba(42, 78, 10, 0.92)";
  ctx.lineWidth = Math.max(1, radius * 0.18);
  ctx.beginPath();
  ctx.arc(x, y, radius * (1.55 + acidNoise(seed + 5) * 0.18), 0, TAU);
  ctx.stroke();
  ctx.restore();
  engine.markSurface(x, y, radius * 2.4);
}

/** Damage, stain and reaction effects all share this exact impact coordinate. */
function reactAcid(engine: RageLayerEngineApi, x: number, y: number, radius: number, seed: number) {
  if (!engine.onPage(x, y)) return false;
  engine.content?.burn(x, y, radius);
  drawAcidStain(engine, x, y, radius, seed);
  engine.signalInteraction("acid", x, y);

  // The wet head starts at the corrosion site, then clings and runs down the
  // surviving surface. Its longer life and growing tail make the spray read
  // as a viscous liquid instead of a sequence of short-lived green dots.
  engine.spawnParticle({
    kind: "acid",
    x,
    y,
    vx: (acidNoise(seed + 21) - 0.5) * 5,
    vy: 5 + acidNoise(seed + 22) * 7,
    life: 0,
    maxLife: 1.8 + acidNoise(seed + 23) * 0.8,
    size: Math.max(1.8, radius * 0.5),
    color: "#8de323",
    color2: "#dcff63",
    gravity: 18,
    drag: 0.35,
    len: 0,
  });
  engine.spawnParticle({
    kind: "spark",
    x,
    y,
    vx: (acidNoise(seed + 11) - 0.5) * 34,
    vy: -12 - acidNoise(seed + 12) * 26,
    life: 0,
    maxLife: 0.16 + acidNoise(seed + 13) * 0.1,
    size: 1 + acidNoise(seed + 14),
    color: "#d7ff4d",
    gravity: 70,
  });
  if (acidNoise(seed + 15) < 0.34) {
    engine.spawnParticle({
      kind: "smoke",
      x,
      y,
      vx: (acidNoise(seed + 16) - 0.5) * 18,
      vy: -15 - acidNoise(seed + 17) * 18,
      life: 0,
      maxLife: 0.55 + acidNoise(seed + 18) * 0.4,
      size: 2.5 + acidNoise(seed + 19) * 2.5,
      color: "#a8d84b",
      gravity: -20,
      drag: 1.5,
      phase: acidNoise(seed + 20) * TAU,
    });
  }
  return true;
}

function depositAcid(
  engine: RageLayerEngineApi,
  state: AcidState,
  pointer: { x: number; y: number },
) {
  const aim = engine.toolAim;
  const seed = ++state.sequence;
  const distance = 7 + acidNoise(seed) * 9;
  const sideways = (acidNoise(seed + 1) - 0.5) * 12;
  const x = pointer.x + aim.x * distance - aim.y * sideways;
  const y = pointer.y + aim.y * distance + aim.x * sideways;
  if (!reactAcid(engine, x, y, ACID_IMPACT_RADIUS, seed)) return;

  if (state.deposits.length >= ACID_DEPOSIT_LIMIT) state.deposits.shift();
  state.deposits.push({
    x,
    y,
    seed,
    age: 0,
    creepDebt: 0,
    creepStep: 0,
    phase: acidNoise(seed + 3) * TAU,
  });
}

function creepAcid(engine: RageLayerEngineApi, state: AcidState, dt: number) {
  for (let i = state.deposits.length - 1; i >= 0; i--) {
    const deposit = state.deposits[i];
    const activeDt = Math.min(dt, Math.max(0, ACID_CREEP_LIFETIME - deposit.age));
    deposit.age += dt;
    deposit.creepDebt += activeDt * ACID_CREEP_PER_SECOND;
    while (deposit.creepDebt >= 1) {
      deposit.creepDebt--;
      deposit.creepStep++;
      // A gravity-biased, gently meandering run reads as liquid on a vertical
      // page. Every step stays capped from the original impact, so corrosion
      // flows without recursively ballooning across the surface.
      const distance = Math.min(ACID_CREEP_REACH, 5 + deposit.creepStep * 3.25);
      const wobble = Math.sin(deposit.phase + deposit.creepStep * 1.35);
      const x = deposit.x + wobble * distance * 0.32;
      const y = deposit.y + distance * (0.78 + acidNoise(deposit.seed + deposit.creepStep) * 0.22);
      reactAcid(engine, x, y, ACID_IMPACT_RADIUS * 0.54, deposit.seed + deposit.creepStep * 101);
    }
    if (deposit.age >= ACID_CREEP_LIFETIME) state.deposits.splice(i, 1);
  }
}

export const acidSprayer: Tool = {
  id: "acid-sprayer",
  name: "Acid Jar",
  icon: "🫙",
  hint: "hold to pour — acid runs and corrodes",
  art: acidSprayerArt,
  reset: (engine) => acidStates.reset(engine),
  hasPendingWork: (engine) => (acidStates.peek(engine)?.deposits.length ?? 0) > 0,
  tick(engine, dt, held, pointer) {
    const state = acidStates.get(engine);
    engine.sound.loop("water", held ? 0.17 : 0);
    creepAcid(engine, state, dt);
    if (held) {
      state.debt += dt * ACID_DROPS_PER_SECOND;
      while (state.debt >= 1) {
        state.debt--;
        depositAcid(engine, state, pointer);
      }
    }
  },
  backgroundTick(engine, dt) {
    creepAcid(engine, acidStates.get(engine), dt);
  },
};

interface PlacedBomb {
  x: number;
  y: number;
  fuse: number;
  radius: number;
}

const bombStates = createEngineState<PlacedBomb[]>(() => []);
export const stickyBombs: Tool = {
  id: "sticky-bombs",
  name: "Sticky Bombs",
  icon: "💣",
  hint: "click to stick — detonates on a timer",
  art: stickyBombArt,
  reset: (engine) => bombStates.reset(engine),
  hasPendingWork: (engine) => (bombStates.peek(engine)?.length ?? 0) > 0,
  onDown(engine, event) {
    if (!engine.onPage(event.x, event.y)) return;
    const bombs = bombStates.get(engine);
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
    const bombs = bombStates.get(engine);
    for (let i = bombs.length - 1; i >= 0; i--) {
      const bomb = bombs[i];
      bomb.fuse -= dt;
      if (bomb.fuse > 0) {
        if (bomb.fuse < 0.45 && Math.random() < dt * 10)
          sparkBurst(engine, bomb.x, bomb.y, 1, "#ff3b1f");
        continue;
      }
      bombs.splice(i, 1);
      engine.explode(bomb.x, bomb.y, bomb.radius, { power: 610, incendiary: true });
    }
  },
  backgroundTick(engine, dt) {
    stickyBombs.tick?.(engine, dt, false, { x: -1000, y: -1000 });
  },
};

export const advancedTools: Tool[] = [laserCutter, acidSprayer, stickyBombs];
