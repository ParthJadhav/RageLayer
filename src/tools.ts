import { emojiCursor } from "./cursors";
import { drawBulletHole, drawCrack, drawGash, drawSplat, randomPaint } from "./decals";
import { emit, TAU } from "./math";
import { scratchParticle } from "./particles";
import { createEngineState, debris, dustPuff } from "./tool-kit";
import {
  broomArt,
  chainsawArt,
  flamethrowerArt,
  gunArt,
  hammerArt,
  paintballArt,
  waterHoseArt,
} from "./toolart";
import { includeTopologySegment, surfaceRuns, type TopologyBounds } from "./topology";
import type { RageLayerEngineApi, Tool, ToolPointerEvent, Vec2 } from "./types";
import { WOOD } from "./wood.js";

/**
 * A spot the hammer is working on. The page doesn't give way on the first
 * blow: each site needs 1–4 hits (rolled when the first blow lands), and every
 * strike up the ladder looks and sounds different — a dent, a spreading crack
 * web, a deep splintering fault, and finally the breakthrough.
 */
interface StrikeSite {
  x: number;
  y: number;
  hits: number;
  needed: number;
  scale: number;
}

const SITE_MEMORY = 10;
const SITE_RADIUS = 64;
const hammerState = createEngineState(() => [] as StrikeSite[]);

export const hammer: Tool = {
  id: "hammer",
  name: "Hammer",
  icon: "🔨",
  hint: "click to smash — tough spots take a few blows",
  cursor: emojiCursor("🔨", { flip: true }),
  art: hammerArt,
  reset(engine) {
    hammerState.reset(engine);
  },
  onDown(engine, e) {
    // Swinging into the void: the head meets nothing. No crack, no dust, no
    // shudder — just the swish of a blow that didn't land.
    if (!engine.onPage(e.x, e.y)) {
      engine.sound.whoosh();
      return;
    }
    // Blows within reach of an earlier strike keep working the same site, so
    // the damage escalates instead of starting over one pixel to the left.
    const sites = hammerState.get(engine);
    let site: StrikeSite | undefined;
    let nearestDist = SITE_RADIUS;
    for (const s of sites) {
      const d = Math.hypot(s.x - e.x, s.y - e.y);
      if (d < nearestDist) {
        nearestDist = d;
        site = s;
      }
    }
    if (!site) {
      site = {
        x: e.x,
        y: e.y,
        hits: 0,
        needed: Math.min(6, 1 + Math.floor(Math.random() * 4 + Math.max(0, WOOD.toughness - 1))),
        scale: 0.8 + Math.random() * 0.4,
      };
      sites.push(site);
      if (sites.length > SITE_MEMORY) sites.shift();
    }
    site.hits++;
    const bias = site.hits > 1 ? Math.atan2(e.y - site.y, e.x - site.x) : undefined;
    const stage = site.hits;

    if (site.hits < site.needed) {
      // The material holds — but each blow up the ladder is its own event.
      const scale = site.scale + stage * 0.5;
      drawCrack(engine.surfaceCtx, e.x, e.y, scale, { bias });
      if (stage === 1) {
        // First blow: a dent and a cough of dust.
        dustPuff(engine, e.x, e.y, 10, 16, 1.1);
        debris(engine, e.x, e.y, 5);
      } else if (stage === 2) {
        // Second: the cracks run, chips fly.
        debris(engine, e.x, e.y, 12);
        dustPuff(engine, e.x, e.y, 12, 22, 1.3);
        engine.spawnParticle({
          kind: "ring",
          x: e.x,
          y: e.y,
          vx: 0,
          vy: 0,
          life: 0,
          maxLife: 0.35,
          size: 40,
        });
        engine.sound.crack();
      } else {
        // Third: deep splintering — pale fragments and a real shudder.
        debris(engine, e.x, e.y, 16, Math.random() < 0.5 ? "#d8d2c8" : "#8e8880");
        dustPuff(engine, e.x, e.y, 16, 28, 1.5);
        engine.spawnParticle({
          kind: "ring",
          x: e.x,
          y: e.y,
          vx: 0,
          vy: 0,
          life: 0,
          maxLife: 0.42,
          size: 54,
        });
        engine.sound.crack();
      }
      engine.shake(7 + stage * 3, (Math.random() - 0.5) * 0.5, 1);
      engine.sound.hammer(0.35 + stage * 0.15);
      return;
    }

    // Breaking blow. Crack web first, then knock real chunks of the page
    // loose (the punch must land last so the hole stays transparent).
    sites.splice(sites.indexOf(site), 1);
    const scale = Math.min(2.4, site.scale + stage * 0.45);
    drawCrack(engine.surfaceCtx, e.x, e.y, scale, { bias });
    // Prefer a real fracture: the struck region leaves the page as rigid
    // bodies that tumble and pile up. `shatter` — decorative shards on a fixed
    // arc — is the fallback for when physics or the page capture is off.
    if (engine.fracture(e.x, e.y, 26 + scale * 11, { power: 190 + scale * 60 }) === 0) {
      engine.shatter(e.x, e.y, 24 + scale * 8);
    }

    // The instant of giving way: a white pop and a shockwave ring rushing out
    // well past the hole, both gone within a fifth of a second.
    engine.spawnParticle({
      kind: "flash",
      x: e.x,
      y: e.y,
      vx: 0,
      vy: 0,
      life: 0,
      maxLife: 0.19,
      size: 62 * scale,
    });
    engine.spawnParticle({
      kind: "ring",
      x: e.x,
      y: e.y,
      vx: 0,
      vy: 0,
      life: 0,
      maxLife: 0.5,
      size: 62 * scale,
    });
    debris(engine, e.x, e.y, 18);
    dustPuff(engine, e.x, e.y, 14, 20 * scale, 1.4);
    // Sharp downward lurch: the hammer came from above.
    engine.shake(11 + scale * 7, (Math.random() - 0.5) * 0.5, 1);
    engine.sound.hammer(1);
    engine.sound.crack();
  },
};

/** The bright filament down the barrel line. Every shot leaves one, hit or miss. */
function tracer(engine: RageLayerEngineApi, x: number, y: number, angle: number) {
  engine.spawnParticle({
    kind: "streak",
    x,
    y,
    vx: 0,
    vy: 0,
    life: 0,
    maxLife: 0.07,
    size: 7,
    angle,
    len: -(150 + Math.random() * 160),
  });
}

/** A shell out of the ejection port on the barrel's right side. */
function ejectCasing(engine: RageLayerEngineApi, x: number, y: number, aim: Vec2) {
  const speed = 140 + Math.random() * 110;
  engine.spawnParticle({
    kind: "casing",
    x: x - aim.y * 8,
    y: y + aim.x * 8,
    vx: -aim.y * speed,
    vy: aim.x * speed - 80,
    life: 0,
    maxLife: 1.6,
    size: 3,
    angle: Math.random() * TAU,
    spin: 18,
    bounce: 0.5,
    restY: y + 120 + Math.random() * 160,
  });
}

function fireShot(engine: RageLayerEngineApi, x: number, y: number, spread = 0) {
  const sx = x + (Math.random() - 0.5) * spread;
  const sy = y + (Math.random() - 0.5) * spread;

  // Everything directional about a shot follows the barrel. The drawn gun is
  // visibly aiming somewhere; a tracer arriving from a random compass point
  // every round would contradict the weapon on screen. Only a whisker of
  // jitter per shot — the gun wanders, the physics doesn't.
  const aim = engine.toolAim;
  const incoming = Math.atan2(aim.y, aim.x) + (Math.random() - 0.5) * 0.16;

  // A round fired into the void hits nothing: the gun still barks and kicks
  // and ejects its casing — that all happens at the muzzle — but there is no
  // impact. The tracer vanishes through the hole and the night keeps it.
  if (!engine.onPage(sx, sy)) {
    tracer(engine, sx, sy, incoming);
    ejectCasing(engine, sx, sy, aim);
    engine.shake(3, Math.cos(incoming), Math.sin(incoming));
    engine.sound.shot();
    return;
  }

  // Dress the rim first, then punch clean through the real page content —
  // order matters: punching last keeps the hole genuinely transparent.
  const penetrates = WOOD.toughness < 2;
  drawBulletHole(engine.surfaceCtx, sx, sy, penetrates ? 0.9 + Math.random() * 0.4 : 0.65);
  if (penetrates) engine.content?.punch(sx, sy, 5);
  else drawCrack(engine.surfaceCtx, sx, sy, 0.45);
  // A round is a perfectly good fly-swatter.
  engine.squashBugs(sx, sy, 12);

  // The round came from somewhere — from the gun: a tracer streak down the
  // barrel line, and a muzzle flare aligned with it, sell the shot as
  // travelling rather than just appearing.
  tracer(engine, sx, sy, incoming);
  engine.spawnParticle({
    kind: "flash",
    x: sx,
    y: sy,
    vx: 0,
    vy: 0,
    life: 0,
    maxLife: 0.13,
    size: 30 + Math.random() * 14,
  });
  for (let i = 0; i < 2; i++) {
    engine.spawnParticle({
      kind: "streak",
      x: sx,
      y: sy,
      vx: 0,
      vy: 0,
      life: 0,
      maxLife: 0.09,
      size: 12,
      angle: incoming + Math.PI + (Math.random() - 0.5) * 1.6,
      len: 26 + Math.random() * 34,
    });
  }
  engine.spawnParticle({
    kind: "ring",
    x: sx,
    y: sy,
    vx: 0,
    vy: 0,
    life: 0,
    maxLife: 0.26,
    size: 18,
  });

  // Sparks skitter off the impact and bounce before dying.
  for (let i = 0; i < 7; i++) {
    const a = Math.random() * TAU;
    const speed = 160 + Math.random() * 340;
    engine.spawnParticle({
      kind: "spark",
      x: sx,
      y: sy,
      vx: Math.cos(a) * speed,
      vy: Math.sin(a) * speed - 60,
      life: 0,
      maxLife: 0.24 + Math.random() * 0.3,
      size: 1.5 + Math.random() * 1.8,
      gravity: 420,
      bounce: 0.4,
      restY: sy + 40 + Math.random() * 90,
    });
  }

  // Every few rounds one glances off instead of biting clean: a tight fan of
  // hot sparks leaves along the deflected barrel line — the round's incoming
  // direction kicked sideways off the surface — with a bright exit streak and
  // an extra breath of dust where it grazed. The `tink` is the ricochet's
  // whine standing in over the shot's bark.
  if (Math.random() < 0.26) {
    const out = incoming + (Math.random() < 0.5 ? 1 : -1) * (0.55 + Math.random() * 0.75);
    engine.spawnParticle({
      kind: "streak",
      x: sx,
      y: sy,
      vx: 0,
      vy: 0,
      life: 0,
      maxLife: 0.12,
      size: 5,
      angle: out,
      len: 90 + Math.random() * 110,
    });
    for (let i = 0; i < 5; i++) {
      const a = out + (Math.random() - 0.5) * 0.42;
      const speed = 380 + Math.random() * 380;
      engine.spawnParticle({
        kind: "spark",
        x: sx,
        y: sy,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        life: 0,
        maxLife: 0.2 + Math.random() * 0.24,
        size: 1.4 + Math.random() * 1.6,
        gravity: 300,
        drag: 0.5,
      });
    }
    dustPuff(engine, sx, sy, 3, 8, 0.8);
    engine.sound.tink();
  }
  ejectCasing(engine, sx, sy, aim);
  debris(engine, sx, sy, 5);
  // Plaster: hangs in the air and settles long after the crack of the shot.
  dustPuff(engine, sx, sy, 6, 9);
  engine.shake(6, Math.cos(incoming), Math.sin(incoming));
  engine.sound.shot();
}

/** Barrel smoke per second while the trigger is held on auto. */
const BARREL_SMOKE_PER_SECOND = 14;
/** Holding the trigger past this long switches to full-auto. */
const AUTO_AFTER = 0.22;
const gunState = createEngineState(() => ({ cooldown: 0, heldFor: 0, smokeDebt: 0 }));

/**
 * The gun. One tool, both firearms: a click fires a single aimed round, and
 * holding the trigger past a beat opens up into full-auto with spray and
 * barrel smoke — no separate machine gun to switch to.
 */
export const gun: Tool = {
  id: "gun",
  name: "Gun",
  icon: "🔫",
  hint: "click to shoot — hold for full-auto",
  cursor: emojiCursor("🔫", { flip: true }),
  art: gunArt,
  reset(engine) {
    gunState.reset(engine);
  },
  hasPendingWork: () => false,
  onDown(engine, e) {
    const state = gunState.get(engine);
    state.heldFor = 0;
    // The first round is aimed, not sprayed.
    fireShot(engine, e.x, e.y);
    state.cooldown = 0.14;
  },
  tick(engine, dt, held, pointer) {
    const state = gunState.get(engine);
    state.cooldown -= dt;
    if (!held || pointer.x <= -100) {
      state.heldFor = 0;
      state.smokeDebt = 0;
      return;
    }
    state.heldFor += dt;
    if (state.heldFor < AUTO_AFTER) return;
    if (state.cooldown <= 0) {
      state.cooldown = 0.085;
      fireShot(engine, pointer.x, pointer.y, 26);
      // Sustained rattle on top of the per-shot kick: automatic fire should
      // never let the page settle.
      engine.shake(9);
    }
    // Powder smoke pouring off a barrel that is not getting a chance to cool.
    state.smokeDebt = emit(state.smokeDebt, dt, BARREL_SMOKE_PER_SECOND, () => {
      engine.spawnParticle({
        kind: "smoke",
        x: pointer.x + (Math.random() - 0.5) * 30,
        y: pointer.y + (Math.random() - 0.5) * 24,
        vx: (Math.random() - 0.5) * 70,
        vy: -40 - Math.random() * 50,
        life: 0,
        maxLife: 0.9 + Math.random() * 1.1,
        size: 6 + Math.random() * 9,
        gravity: -22,
        drag: 1.9,
        phase: Math.random() * TAU,
      });
    });
  },
};

/** Nozzle embers per second (was 3 per *frame*, i.e. double on a 120Hz screen). */
const JET_EMBERS_PER_SECOND = 90;
/** Fuel blobs per second — the body of the jet cone. */
const JET_BLOBS_PER_SECOND = 150;
const flamethrowerState = createEngineState(() => ({
  cooldown: 0,
  emberDebt: 0,
  blobDebt: 0,
}));

/** Flamethrower: hold to pour fire onto the page. Fire spreads on its own. */
export const flamethrower: Tool = {
  id: "flamethrower",
  name: "Flamethrower",
  icon: "🔥",
  hint: "hold to burn — fire creeps across wood",
  cursor: emojiCursor("🔥"),
  art: flamethrowerArt,
  reset(engine) {
    flamethrowerState.reset(engine);
  },
  hasPendingWork: () => false,
  tick(engine, dt, held, pointer) {
    const state = flamethrowerState.get(engine);
    state.cooldown -= dt;
    engine.sound.loop("flamethrower", held ? 0.35 : 0);
    if (!held || pointer.x <= -100) {
      state.emberDebt = 0;
      state.blobDebt = 0;
      return;
    }
    // Fire leaves the bore the tool is drawn pointing down, and that direction
    // never moves — the jet is as steady as the nozzle above it.
    const aim = engine.toolAim;
    const base = Math.atan2(aim.y, aim.x);

    if (state.cooldown <= 0) {
      state.cooldown = 0.1;
      // Always light directly under the nozzle, then throw a second seed further
      // down the cone so the fire creeps outward in the direction you are aiming.
      engine.spawnFlame(
        pointer.x + (Math.random() - 0.5) * 22,
        pointer.y + (Math.random() - 0.5) * 16,
        0.5,
      );
      const reach = 26 + Math.random() * 46;
      engine.spawnFlame(pointer.x + aim.x * reach, pointer.y + aim.y * reach, 0.32);
    }

    // The jet itself: fuel launched hard along the aim, dragged down and lifted
    // by its own heat, so the spray fans into a cone that curls up at the tip.
    state.blobDebt = emit(state.blobDebt, dt, JET_BLOBS_PER_SECOND, () => {
      const a = base + (Math.random() - 0.5) * 0.62;
      const speed = 300 + Math.random() * 380;
      engine.spawnParticle({
        kind: "jet",
        x: pointer.x + (Math.random() - 0.5) * 8,
        y: pointer.y + (Math.random() - 0.5) * 8,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        life: 0,
        maxLife: 0.24 + Math.random() * 0.26,
        size: 5 + Math.random() * 7,
        gravity: -260,
        drag: 3.6,
      });
    });

    // Jet sparks streaming from the nozzle for feedback.
    state.emberDebt = emit(state.emberDebt, dt, JET_EMBERS_PER_SECOND, () => {
      const a = base + (Math.random() - 0.5) * 1;
      engine.spawnParticle({
        kind: "ember",
        x: pointer.x + (Math.random() - 0.5) * 14,
        y: pointer.y + (Math.random() - 0.5) * 14,
        vx: Math.cos(a) * (90 + Math.random() * 220),
        vy: Math.sin(a) * (90 + Math.random() * 220) - 40,
        life: 0,
        maxLife: 0.35 + Math.random() * 0.4,
        size: 1.5 + Math.random() * 2,
        gravity: -60,
        drag: 1.4,
      });
    });
  },
};

/**
 * Droplets per second. Every live droplet is stepped *and* collision-tested
 * against every flame each frame, so the count is the hose's whole cost. The
 * old rate (260/s, spawned as `max(1, round(dt * 260))`) both overshot on
 * high-refresh displays and bought density that fewer, fatter droplets give
 * for a third of the work.
 */
const DROPS_PER_SECOND = 120;
/** Stream segments and nozzle mist per second. */
const STREAM_PER_SECOND = 96;
const MIST_PER_SECOND = 36;
const waterState = createEngineState(() => ({
  spawnDebt: 0,
  streamDebt: 0,
  mistDebt: 0,
}));

/** Water hose: hold to spray. Droplets douse flames; interaction lives in the engine. */
export const waterHose: Tool = {
  id: "water",
  name: "Water hose",
  icon: "💦",
  hint: "hold to spray — puts out fires, washes stains off",
  cursor: emojiCursor("💦"),
  art: waterHoseArt,
  reset(engine) {
    waterState.reset(engine);
  },
  hasPendingWork: () => false,
  tick(engine, dt, held, pointer) {
    const state = waterState.get(engine);
    engine.sound.loop("water", held ? 0.3 : 0);
    if (!held || pointer.x < -100) {
      state.spawnDebt = state.streamDebt = state.mistDebt = 0;
      return;
    }
    // The stream leaves the drawn outlet, which points one fixed way.
    const aim = engine.toolAim;
    const base = Math.atan2(aim.y, aim.x);

    // The solid part of the jet, before it breaks up into droplets. Segments
    // are placed *along the ballistic arc* a pressurized stream actually
    // follows — position and angle both come from projectile math — so the
    // hose reads as one curved rope of water leaving the nozzle, not a
    // straight laser of disconnected dashes.
    const jetSpeed = 500;
    const jetGravity = 720;
    state.streamDebt = emit(state.streamDebt, dt, STREAM_PER_SECOND, () => {
      const t = 0.015 + Math.random() * 0.235;
      const a = base + (Math.random() - 0.5) * 0.055;
      const vx = Math.cos(a) * jetSpeed;
      const vy0 = Math.sin(a) * jetSpeed;
      const vy = vy0 + jetGravity * t;
      engine.spawnParticle({
        kind: "stream",
        x: pointer.x + vx * t + (Math.random() - 0.5) * 3,
        y: pointer.y + vy0 * t + 0.5 * jetGravity * t * t + (Math.random() - 0.5) * 3,
        vx: 0,
        vy: 0,
        life: 0,
        maxLife: 0.1 + Math.random() * 0.07,
        // A compact pressure nozzle produces one readable core. It narrows
        // gradually, then hands off to the simulated droplets near the end.
        size: (12 + Math.random() * 5) * (1 - t * 1.45),
        angle: Math.atan2(vy, vx),
        len: 38 + Math.random() * 18,
      });
    });

    // Mist blowing back off the nozzle.
    state.mistDebt = emit(state.mistDebt, dt, MIST_PER_SECOND, () => {
      const a = base + Math.PI + (Math.random() - 0.5) * 1.7;
      engine.spawnParticle({
        kind: "steam",
        x: pointer.x - aim.x * 3 + (Math.random() - 0.5) * 7,
        y: pointer.y - aim.y * 3 + (Math.random() - 0.5) * 7,
        vx: Math.cos(a) * (16 + Math.random() * 42),
        vy: Math.sin(a) * (16 + Math.random() * 42) - 8,
        life: 0,
        maxLife: 0.22 + Math.random() * 0.24,
        size: 3 + Math.random() * 5,
        drag: 3,
      });
    });

    // The cone is tight at the nozzle — pressure holds a hose stream together —
    // and only fans out where the arc's droplets naturally spread.
    state.spawnDebt = emit(state.spawnDebt, dt, DROPS_PER_SECOND, () => {
      const a = base + (Math.random() - 0.5) * 0.2;
      const speed = 430 + Math.random() * 150;
      engine.spawnParticle({
        kind: "water",
        x: pointer.x + aim.x * 5 + (Math.random() - 0.5) * 5,
        y: pointer.y + aim.y * 5 + (Math.random() - 0.5) * 5,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        life: 0,
        maxLife: 0.42 + Math.random() * 0.3,
        size: 3.2 + Math.random() * 2.2,
        gravity: jetGravity,
        drag: 0.85,
      });
    });

    // Collision droplets provide the physical splash, while these overlapping
    // centre-line samples make the visible pressure core authoritative for
    // extinguishing. A narrow set of samples is more accurate than one broad
    // disc and remains frame-rate independent because every dose scales by dt.
    for (let i = 0; i < 4; i++) {
      const t = i * 0.075;
      const x = pointer.x + Math.cos(base) * jetSpeed * t;
      const y = pointer.y + Math.sin(base) * jetSpeed * t + 0.5 * jetGravity * t * t;
      engine.dowseFlames(x, y, 22 + i * 3, dt * 1.25);
      engine.washSurface(x, y, 22 + i * 4, dt * 1.35);
    }

    // Water cleans what it soaks: paint, soot, and smears rinse off the
    // surviving page under the spray. Gradually — a pass dulls a stain, a
    // held soak lifts it — and never structurally: holes stay holes, because
    // water washes, only the broom repairs. Bugs caught in the jet aren't
    // killed so much as carried: they tumble away downstream, no smear.
    engine.flushBugs(pointer.x + aim.x * 40, pointer.y + aim.y * 40, 48);
  },
};

/** Torn strips are cut loose every this many px of travel. */
const STRIP_INTERVAL = 64;
/** Connectivity analysis is regional and only needs to run after real travel. */
const TOPOLOGY_INTERVAL = 24;

function releaseSawIslands(
  engine: RageLayerEngineApi,
  state: { cutBounds: TopologyBounds | null; scanDebt: number },
) {
  const bounds = state.cutBounds;
  if (!bounds) return 0;
  state.scanDebt = 0;
  return engine.dislodge(bounds.x0, bounds.y0, bounds.x1, bounds.y1);
}

interface ChainsawState {
  lastCut: Vec2 | null;
  stripDebt: number;
  scanDebt: number;
  cutBounds: TopologyBounds | null;
}

const chainsawState = createEngineState<ChainsawState>(() => ({
  lastCut: null,
  stripDebt: 0,
  scanDebt: 0,
  cutBounds: null,
}));

/** Chainsaw: drag to tear gashes along the path. */
export const chainsaw: Tool = {
  id: "chainsaw",
  name: "Chainsaw",
  icon: "🪚",
  hint: "drag to cut — any isolated shape drops",
  cursor: emojiCursor("🪚"),
  art: chainsawArt,
  reset(engine) {
    chainsawState.reset(engine);
  },
  hasPendingWork: () => false,
  onDown(engine, e) {
    const state = chainsawState.get(engine);
    state.lastCut = { x: e.x, y: e.y };
    state.stripDebt = 0;
    state.scanDebt = 0;
    state.cutBounds = null;
  },
  onMove(engine: RageLayerEngineApi, e: ToolPointerEvent) {
    const state = chainsawState.get(engine);
    if (!e.buttons || !state.lastCut) return;
    const dx = e.x - state.lastCut.x;
    const dy = e.y - state.lastCut.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 6) return;
    const nx = -dy / dist;
    const ny = dx / dist;
    // The blade chatters: the cut wanders perpendicular to the stroke instead of
    // tracking the pointer exactly, which is what a saw fighting material does.
    const jitter = 2.6;
    const ex = e.x + nx * (Math.random() - 0.5) * jitter;
    const ey = e.y + ny * (Math.random() - 0.5) * jitter;

    // Clip the blade stroke against the surviving surface. Crossing a hole produces
    // two independent rim cuts; empty space never receives a gash or sawdust.
    const runs = surfaceRuns(state.lastCut.x, state.lastCut.y, ex, ey, (x, y) =>
      engine.onPage(x, y),
    );
    let cutLength = 0;
    for (const run of runs) {
      const mx = (run.x1 + run.x2) * 0.5;
      const my = (run.y1 + run.y2) * 0.5;
      drawGash(engine.surfaceCtx, run.x1, run.y1, run.x2, run.y2);
      engine.content?.cut(run.x1, run.y1, run.x2, run.y2);
      state.cutBounds = includeTopologySegment(state.cutBounds, run.x1, run.y1, run.x2, run.y2);
      cutLength += run.length;

      const chips = Math.min(12, Math.max(3, Math.ceil(run.length * 0.55)));
      // Sawdust sprays back along the blade; page-coloured confetti comes off
      // with it, so debris exists only in proportion to material actually cut.
      for (let i = 0; i < chips; i++) {
        const back = Math.atan2(-dy, -dx) + (Math.random() - 0.5) * 1.5;
        const speed = 120 + Math.random() * 320;
        // The blade's highest-rate spawner: fill the pool's scratch particle
        // instead of allocating a literal per chip.
        const p = scratchParticle(
          "sawdust",
          mx + (Math.random() - 0.5) * 8,
          my + (Math.random() - 0.5) * 8,
          Math.cos(back) * speed,
          Math.sin(back) * speed - 60,
          0.5 + Math.random() * 0.6,
          1.5 + Math.random() * 2.5,
        );
        p.angle = Math.random() * TAU;
        p.spin = (Math.random() - 0.5) * 25;
        p.bounce = 0.3;
        p.restY = my + 50 + Math.random() * 150;
        engine.spawnParticle(p);
      }
      if (Math.random() < 0.7) {
        debris(
          engine,
          mx,
          my,
          Math.min(3, Math.ceil(run.length / 8)),
          Math.random() < 0.5 ? "#d8d2c8" : "#8e8880",
        );
      }
      dustPuff(engine, mx, my, Math.min(3, Math.ceil(run.length / 7)), 10, 0.7);

      // Every so often a real chip comes away. Sample just beside the kerf (the
      // centreline is now void), then remove the chip from the page before it
      // appears in flight so material is conserved.
      state.stripDebt += run.length;
      if (state.stripDebt >= STRIP_INTERVAL) {
        state.stripDebt %= STRIP_INTERVAL;
        const size = 14 + Math.random() * 22;
        const side = Math.random() < 0.5 ? -1 : 1;
        const chipX = mx + nx * side * 7;
        const chipY = my + ny * side * 7;
        if (engine.onPage(chipX, chipY)) {
          const patch = engine.content?.patch(chipX, chipY, size, size);
          if (patch) {
            engine.content?.punch(chipX, chipY, size * 0.22);
            engine.spawnParticle({
              kind: "shard",
              x: chipX,
              y: chipY,
              vx: nx * side * (35 + Math.random() * 80),
              vy: 30 + Math.random() * 80,
              life: 0,
              maxLife: 1.4 + Math.random() * 0.8,
              size,
              angle: Math.random() * TAU,
              spin: (Math.random() - 0.5) * 9,
              bounce: 0.3,
              restY: chipY + 130 + Math.random() * 260,
              img: patch.img,
              sx: patch.sx,
              sy: patch.sy,
              sw: patch.sw,
              sh: patch.sh,
            });
          }
        }
      }
    }

    state.lastCut.x = ex;
    state.lastCut.y = ey;
    if (cutLength <= 0) return;

    // Kickback and connectivity both scale with actual contact, never cursor
    // travel through a hole. Connectivity—not pointer proximity—decides release.
    engine.shake(5, nx, ny);
    state.scanDebt += cutLength;
    if (state.scanDebt >= TOPOLOGY_INTERVAL) {
      const released = releaseSawIslands(engine, state);
      if (released > 0) {
        dustPuff(engine, ex, ey, 8 + released * 2, 18, 1);
        engine.shake(9 + released * 2);
      }
    }
  },
  onUp(engine) {
    const state = chainsawState.get(engine);
    const released = releaseSawIslands(engine, state);
    if (released > 0 && state.lastCut) {
      dustPuff(engine, state.lastCut.x, state.lastCut.y, 8 + released * 2, 18, 1);
      engine.shake(9 + released * 2);
    }
    state.lastCut = null;
    state.cutBounds = null;
    state.scanDebt = 0;
  },
  tick(engine, _dt, held) {
    engine.sound.loop("saw", held ? 0.28 : 0);
  },
};

const PAINTBALL_INTERVAL = 0.16;
const paintballState = createEngineState(() => ({ cooldown: 0 }));

function firePaintball(engine: RageLayerEngineApi, x: number, y: number) {
  // A paintball needs a surface. Fired into a hole it flies straight through
  // and is gone — no splat, no drips, nothing to hear it hit.
  if (!engine.onPage(x, y)) {
    engine.sound.whoosh();
    return;
  }
  const [base, dark, light] = drawSplat(engine.surfaceCtx, x, y, randomPaint());
  engine.markSurface(x, y, 120);

  // Thick paint continues to creep after each automatic impact.
  const drips = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < drips; i++) {
    engine.spawnParticle({
      kind: "paint",
      x: x + (Math.random() - 0.5) * 26,
      y: y + (Math.random() - 0.5) * 12,
      vx: 0,
      vy: 10 + Math.random() * 26,
      life: 0,
      maxLife: 1.4 + Math.random() * 2.2,
      size: 2.4 + Math.random() * 2.6,
      gravity: 70,
      drag: 1.3,
      len: 0,
      color: base,
      color2: light,
    });
  }
  debris(engine, x, y, 10, Math.random() < 0.5 ? base : dark);
  engine.spawnParticle({
    kind: "ring",
    x,
    y,
    vx: 0,
    vy: 0,
    life: 0,
    maxLife: 0.2,
    size: 16,
  });
  engine.shake(5, 0, 1);
  engine.sound.splat();
}

export const paintball: Tool = {
  id: "paintball",
  name: "Paintball",
  icon: "🎨",
  hint: "click once or hold for automatic fire",
  cursor: emojiCursor("🎨"),
  art: paintballArt,
  reset(engine) {
    paintballState.reset(engine);
  },
  hasPendingWork: () => false,
  onDown(engine, e) {
    const state = paintballState.get(engine);
    firePaintball(engine, e.x, e.y);
    state.cooldown = PAINTBALL_INTERVAL;
  },
  tick(engine, dt, held, pointer) {
    const state = paintballState.get(engine);
    if (!held || pointer.x <= -100) {
      state.cooldown = 0;
      return;
    }
    state.cooldown -= dt;
    // Preserve elapsed cadence across refresh rates. The catch-up bound avoids
    // a tab-resume frame dumping an unbounded hopper at once.
    let catchUp = 0;
    while (state.cooldown <= 0 && catchUp++ < 4) {
      firePaintball(engine, pointer.x, pointer.y);
      state.cooldown += PAINTBALL_INTERVAL;
    }
  },
};

const broomState = createEngineState(() => ({ sweepDebt: 0 }));

/** Broom: drag to sweep damage away and put out fires. */
export const broom: Tool = {
  id: "broom",
  name: "Broom",
  icon: "🧹",
  hint: "drag to clean — swats bugs",
  cursor: emojiCursor("🧹"),
  art: broomArt,
  reset(engine) {
    broomState.reset(engine);
  },
  onDown(engine, e) {
    // Distance debt belongs to one continuous sweep. A short stroke followed
    // by a fresh click must not inherit the previous gesture's almost-ready
    // dust/sound burst.
    broomState.get(engine).sweepDebt = 0;
    engine.eraseDamage(e.x, e.y, 42);
    engine.dowseFlames(e.x, e.y, 50, 1);
    // The oldest bug-control tool there is: anything under the bristles is
    // swatted flat (and, being a broom, the smear can be swept up after).
    engine.squashBugs(e.x, e.y, 46);
    engine.sound.sweep();
  },
  onMove(engine, e) {
    if (!e.buttons) return;
    engine.eraseDamage(e.x, e.y, 42);
    engine.dowseFlames(e.x, e.y, 50, 1);
    engine.squashBugs(e.x, e.y, 46);

    const state = broomState.get(engine);
    state.sweepDebt += Math.hypot(e.dx, e.dy);
    if (state.sweepDebt < 26) return;
    state.sweepDebt = 0;
    engine.sound.sweep();

    // Motes kicked up ahead of the bristles...
    for (let i = 0; i < 3; i++) {
      engine.spawnParticle({
        kind: "dust",
        x: e.x + (Math.random() - 0.5) * 46,
        y: e.y + (Math.random() - 0.5) * 34,
        vx: e.dx * 5 + (Math.random() - 0.5) * 40,
        vy: -20 - Math.random() * 40,
        life: 0,
        maxLife: 0.7 + Math.random() * 0.8,
        size: 4 + Math.random() * 7,
        gravity: 22,
        drag: 2.4,
      });
    }
    // ...and a clean glint left on the freshly restored page behind them.
    for (let i = 0; i < 2; i++) {
      engine.spawnParticle({
        kind: "sparkle",
        x: e.x + (Math.random() - 0.5) * 56,
        y: e.y + (Math.random() - 0.5) * 40,
        vx: 0,
        vy: -6,
        life: 0,
        maxLife: 0.45 + Math.random() * 0.4,
        size: 5 + Math.random() * 6,
        gravity: 0,
        phase: Math.random() * TAU,
      });
    }
  },
};

/**
 * The everyday tools without physics-heavy ordnance. Import this set from
 * `ragelayer/tools` when startup size matters more than having every
 * effect available immediately.
 */
export const baseTools: Tool[] = [hammer, gun, flamethrower, waterHose, chainsaw, paintball, broom];
