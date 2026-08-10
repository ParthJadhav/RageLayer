import { emojiCursor } from "./cursors";
import { drawBulletHole, drawCrack, drawGash, drawSplat, randomPaint } from "./decals";
import { emit, TAU } from "./math";
import { debris, dustPuff, makeAim } from "./tool-kit";
import {
  broomArt,
  chainsawArt,
  flamethrowerArt,
  gunArt,
  hammerArt,
  paintballArt,
  waterHoseArt,
} from "./toolart";
import { surfaceRuns, type TopologyBounds } from "./topology";
import type { DestroyerEngineApi, Tool, ToolPointerEvent, Vec2 } from "./types";

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

const sites: StrikeSite[] = [];
const SITE_MEMORY = 10;
const SITE_RADIUS = 64;

export const hammer: Tool = {
  id: "hammer",
  name: "Hammer",
  icon: "🔨",
  hint: "smash — tough spots take a few blows",
  cursor: emojiCursor("🔨", { flip: true }),
  art: hammerArt,
  reset() {
    sites.length = 0;
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
        needed: Math.min(
          6,
          1 +
            Math.floor(Math.random() * 4 + Math.max(0, engine.materialAt(e.x, e.y).toughness - 1)),
        ),
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
function tracer(engine: DestroyerEngineApi, x: number, y: number, angle: number) {
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
function ejectCasing(engine: DestroyerEngineApi, x: number, y: number, aim: Vec2) {
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

function fireShot(engine: DestroyerEngineApi, x: number, y: number, spread = 0) {
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
  const material = engine.materialAt(sx, sy);
  const penetrates = material.toughness < 2;
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

/**
 * The gun. One tool, both firearms: a click fires a single aimed round, and
 * holding the trigger past a beat opens up into full-auto with spray and
 * barrel smoke — no separate machine gun to switch to.
 */
export const gun: Tool & { cooldown: number; heldFor: number; smokeDebt: number } = {
  id: "gun",
  name: "Gun",
  icon: "🔫",
  hint: "click to shoot — hold for full-auto",
  cursor: emojiCursor("🔫", { flip: true }),
  art: gunArt,
  cooldown: 0,
  heldFor: 0,
  smokeDebt: 0,
  reset() {
    gun.cooldown = 0;
    gun.heldFor = 0;
    gun.smokeDebt = 0;
  },
  onDown(engine, e) {
    gun.heldFor = 0;
    // The first round is aimed, not sprayed.
    fireShot(engine, e.x, e.y);
    gun.cooldown = 0.14;
  },
  tick(engine, dt, held, pointer) {
    const self = gun;
    self.cooldown -= dt;
    if (!held || pointer.x <= -100) {
      self.heldFor = 0;
      self.smokeDebt = 0;
      return;
    }
    self.heldFor += dt;
    if (self.heldFor < AUTO_AFTER) return;
    if (self.cooldown <= 0) {
      self.cooldown = 0.085;
      fireShot(engine, pointer.x, pointer.y, 26);
      // Sustained rattle on top of the per-shot kick: automatic fire should
      // never let the page settle.
      engine.shake(9);
    }
    // Powder smoke pouring off a barrel that is not getting a chance to cool.
    self.smokeDebt = emit(self.smokeDebt, dt, BARREL_SMOKE_PER_SECOND, () => {
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

const aim = makeAim(0.34, -0.94);
const waterAim = makeAim(0, -1);

/** Nozzle embers per second (was 3 per *frame*, i.e. double on a 120Hz screen). */
const JET_EMBERS_PER_SECOND = 90;
/** Fuel blobs per second — the body of the jet cone. */
const JET_BLOBS_PER_SECOND = 150;

/** Flamethrower: hold to pour fire onto the page. Fire spreads on its own. */
export const flamethrower: Tool & { cooldown: number; emberDebt: number; blobDebt: number } = {
  id: "flamethrower",
  name: "Flamethrower",
  icon: "🔥",
  hint: "hold to burn — melts ice",
  cursor: emojiCursor("🔥"),
  art: flamethrowerArt,
  cooldown: 0,
  emberDebt: 0,
  blobDebt: 0,
  reset() {
    flamethrower.cooldown = 0;
    flamethrower.emberDebt = 0;
    flamethrower.blobDebt = 0;
    aim.hardReset();
  },
  tick(engine, dt, held, pointer) {
    const self = flamethrower;
    self.cooldown -= dt;
    engine.sound.loop("flamethrower", held ? 0.35 : 0);
    if (!held || pointer.x <= -100) {
      self.emberDebt = 0;
      self.blobDebt = 0;
      aim.reset();
      return;
    }
    aim.update(pointer, dt);

    if (self.cooldown <= 0) {
      self.cooldown = 0.1;
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

    // The jet is heat before it is fire: it strips rime off the page even
    // where nothing has caught yet, boiling it away as steam — so a frozen
    // patch is thawed first and burns second, instead of the ice mutely
    // eating flame seeds forever.
    const meltX = pointer.x + aim.x * 22;
    const meltY = pointer.y + aim.y * 22;
    if (engine.frostAt(meltX, meltY) > 0.03 || engine.frostAt(pointer.x, pointer.y) > 0.03) {
      engine.meltFrost(pointer.x + aim.x * 12, pointer.y + aim.y * 12, 72, dt * 2.6);
      if (Math.random() < dt * 26) {
        engine.spawnParticle({
          kind: "steam",
          x: meltX + (Math.random() - 0.5) * 44,
          y: meltY + (Math.random() - 0.5) * 30,
          vx: (Math.random() - 0.5) * 50,
          vy: -70 - Math.random() * 60,
          life: 0,
          maxLife: 0.7 + Math.random() * 0.6,
          size: 9 + Math.random() * 10,
          drag: 1.6,
        });
      }
    }

    // The jet itself: fuel launched hard along the aim, dragged down and lifted
    // by its own heat, so the spray fans into a cone that curls up at the tip.
    self.blobDebt = emit(self.blobDebt, dt, JET_BLOBS_PER_SECOND, () => {
      const a = Math.atan2(aim.y, aim.x) + (Math.random() - 0.5) * 0.62;
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
    self.emberDebt = emit(self.emberDebt, dt, JET_EMBERS_PER_SECOND, () => {
      const a = Math.atan2(aim.y, aim.x) + (Math.random() - 0.5) * 1;
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
const DROPS_PER_SECOND = 130;
/** Stream segments and nozzle mist per second. */
const STREAM_PER_SECOND = 90;
const MIST_PER_SECOND = 44;

/** Water hose: hold to spray. Droplets douse flames; interaction lives in the engine. */
export const waterHose: Tool & { spawnDebt: number; streamDebt: number; mistDebt: number } = {
  id: "water",
  name: "Water hose",
  icon: "💦",
  hint: "hold to spray — puts out fires, washes stains off",
  cursor: emojiCursor("💦"),
  art: waterHoseArt,
  spawnDebt: 0,
  streamDebt: 0,
  mistDebt: 0,
  reset() {
    waterHose.spawnDebt = waterHose.streamDebt = waterHose.mistDebt = 0;
    waterAim.hardReset();
  },
  tick(engine, dt, held, pointer) {
    const self = waterHose;
    engine.sound.loop("water", held ? 0.3 : 0);
    if (!held || pointer.x < -100) {
      self.spawnDebt = self.streamDebt = self.mistDebt = 0;
      waterAim.reset();
      return;
    }
    waterAim.update(pointer, dt);
    const base = Math.atan2(waterAim.y, waterAim.x);

    // The solid part of the jet, before it breaks up into droplets. Segments
    // are placed *along the ballistic arc* a pressurized stream actually
    // follows — position and angle both come from projectile math — so the
    // hose reads as one curved rope of water leaving the nozzle, not a
    // straight laser of disconnected dashes.
    const jetSpeed = 430;
    const jetGravity = 780;
    self.streamDebt = emit(self.streamDebt, dt, STREAM_PER_SECOND, () => {
      const t = Math.random() * 0.28;
      const a = base + (Math.random() - 0.5) * 0.14;
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
        // The stream thins and frays the further from the nozzle it gets.
        size: (11 + Math.random() * 8) * (1 - t * 1.6),
        angle: Math.atan2(vy, vx),
        len: 34 + Math.random() * 30,
      });
    });

    // Mist blowing back off the nozzle.
    self.mistDebt = emit(self.mistDebt, dt, MIST_PER_SECOND, () => {
      const a = base + (Math.random() - 0.5) * 2.4;
      engine.spawnParticle({
        kind: "steam",
        x: pointer.x + (Math.random() - 0.5) * 12,
        y: pointer.y + (Math.random() - 0.5) * 12,
        vx: Math.cos(a) * (20 + Math.random() * 70),
        vy: Math.sin(a) * (20 + Math.random() * 70),
        life: 0,
        maxLife: 0.28 + Math.random() * 0.3,
        size: 4 + Math.random() * 7,
        drag: 2.6,
      });
    });

    // The cone is tight at the nozzle — pressure holds a hose stream together —
    // and only fans out where the arc's droplets naturally spread.
    self.spawnDebt = emit(self.spawnDebt, dt, DROPS_PER_SECOND, () => {
      const a = base + (Math.random() - 0.5) * 0.4;
      const speed = 330 + Math.random() * 280;
      engine.spawnParticle({
        kind: "water",
        x: pointer.x + (Math.random() - 0.5) * 10,
        y: pointer.y + (Math.random() - 0.5) * 10,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        life: 0,
        maxLife: 0.45 + Math.random() * 0.4,
        size: 3 + Math.random() * 2.6,
        gravity: 780,
        drag: 1.1,
      });
    });
    // Direct dowse under the nozzle so aiming at a flame feels responsive. The
    // reach is generous because the droplets now leave the nozzle fast enough to
    // arc clear over a fire sitting right under the cursor.
    engine.dowseFlames(pointer.x, pointer.y, 64, dt * 2.2);

    // Water cleans what it soaks: paint, soot, smears and rime rinse off the
    // surviving page under the spray. Gradually — a pass dulls a stain, a
    // held soak lifts it — and never structurally: holes stay holes, because
    // water washes, only the broom repairs. Bugs caught in the jet aren't
    // killed so much as carried: they tumble away downstream, no smear.
    engine.washSurface(pointer.x + waterAim.x * 24, pointer.y + waterAim.y * 24, 56, dt * 2.4);
    engine.flushBugs(pointer.x, pointer.y, 56);
  },
};

/** Torn strips are cut loose every this many px of travel. */
const STRIP_INTERVAL = 64;
/** Connectivity analysis is regional and only needs to run after real travel. */
const TOPOLOGY_INTERVAL = 24;

function includeCut(bounds: TopologyBounds | null, x1: number, y1: number, x2: number, y2: number) {
  if (!bounds) {
    return {
      x0: Math.min(x1, x2),
      y0: Math.min(y1, y2),
      x1: Math.max(x1, x2),
      y1: Math.max(y1, y2),
    };
  }
  bounds.x0 = Math.min(bounds.x0, x1, x2);
  bounds.y0 = Math.min(bounds.y0, y1, y2);
  bounds.x1 = Math.max(bounds.x1, x1, x2);
  bounds.y1 = Math.max(bounds.y1, y1, y2);
  return bounds;
}

function releaseSawIslands(
  engine: DestroyerEngineApi,
  state: { cutBounds: TopologyBounds | null; scanDebt: number },
) {
  const bounds = state.cutBounds;
  if (!bounds) return 0;
  state.scanDebt = 0;
  return engine.dislodge(bounds.x0, bounds.y0, bounds.x1, bounds.y1);
}

/** Chainsaw: drag to tear gashes along the path. */
export const chainsaw: Tool & {
  lastCut: Vec2 | null;
  stripDebt: number;
  scanDebt: number;
  cutBounds: TopologyBounds | null;
} = {
  id: "chainsaw",
  name: "Chainsaw",
  icon: "🪚",
  hint: "drag to cut — any isolated shape drops",
  cursor: emojiCursor("🪚"),
  art: chainsawArt,
  lastCut: null,
  stripDebt: 0,
  scanDebt: 0,
  cutBounds: null,
  reset() {
    chainsaw.lastCut = null;
    chainsaw.stripDebt = 0;
    chainsaw.scanDebt = 0;
    chainsaw.cutBounds = null;
  },
  onDown(_engine, e) {
    this.lastCut = { x: e.x, y: e.y };
    this.stripDebt = 0;
    this.scanDebt = 0;
    this.cutBounds = null;
  },
  onMove(engine: DestroyerEngineApi, e: ToolPointerEvent) {
    const self = chainsaw;
    if (!e.buttons || !self.lastCut) return;
    const dx = e.x - self.lastCut.x;
    const dy = e.y - self.lastCut.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 6) return;
    const nx = -dy / dist;
    const ny = dx / dist;
    // The blade chatters: the cut wanders perpendicular to the stroke instead of
    // tracking the pointer exactly, which is what a saw fighting material does.
    const jitter = 2.6;
    const ex = e.x + nx * (Math.random() - 0.5) * jitter;
    const ey = e.y + ny * (Math.random() - 0.5) * jitter;

    // Clip the blade stroke against current material. Crossing a hole produces
    // two independent rim cuts; empty space never receives a gash or sawdust.
    const runs = surfaceRuns(self.lastCut.x, self.lastCut.y, ex, ey, (x, y) => engine.onPage(x, y));
    let cutLength = 0;
    for (const run of runs) {
      drawGash(engine.surfaceCtx, run.x1, run.y1, run.x2, run.y2);
      engine.content?.cut(run.x1, run.y1, run.x2, run.y2);
      self.cutBounds = includeCut(self.cutBounds, run.x1, run.y1, run.x2, run.y2);
      cutLength += run.length;

      const mx = (run.x1 + run.x2) * 0.5;
      const my = (run.y1 + run.y2) * 0.5;
      const chips = Math.min(12, Math.max(3, Math.ceil(run.length * 0.55)));
      // Sawdust sprays back along the blade; page-coloured confetti comes off
      // with it, so debris exists only in proportion to material actually cut.
      for (let i = 0; i < chips; i++) {
        const back = Math.atan2(-dy, -dx) + (Math.random() - 0.5) * 1.5;
        const speed = 120 + Math.random() * 320;
        engine.spawnParticle({
          kind: "sawdust",
          x: mx + (Math.random() - 0.5) * 8,
          y: my + (Math.random() - 0.5) * 8,
          vx: Math.cos(back) * speed,
          vy: Math.sin(back) * speed - 60,
          life: 0,
          maxLife: 0.5 + Math.random() * 0.6,
          size: 1.5 + Math.random() * 2.5,
          angle: Math.random() * TAU,
          spin: (Math.random() - 0.5) * 25,
          bounce: 0.3,
          restY: my + 50 + Math.random() * 150,
        });
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
      self.stripDebt += run.length;
      if (self.stripDebt >= STRIP_INTERVAL) {
        self.stripDebt %= STRIP_INTERVAL;
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

    self.lastCut.x = ex;
    self.lastCut.y = ey;
    if (cutLength <= 0) return;

    // Kickback and connectivity both scale with actual contact, never cursor
    // travel through a hole. Connectivity—not pointer proximity—decides release.
    engine.shake(5, nx, ny);
    self.scanDebt += cutLength;
    if (self.scanDebt >= TOPOLOGY_INTERVAL) {
      const released = releaseSawIslands(engine, self);
      if (released > 0) {
        dustPuff(engine, ex, ey, 8 + released * 2, 18, 1);
        engine.shake(9 + released * 2);
      }
    }
  },
  onUp(engine) {
    const released = releaseSawIslands(engine, this);
    if (released > 0 && this.lastCut) {
      dustPuff(engine, this.lastCut.x, this.lastCut.y, 8 + released * 2, 18, 1);
      engine.shake(9 + released * 2);
    }
    this.lastCut = null;
    this.cutBounds = null;
    this.scanDebt = 0;
  },
  tick(engine, _dt, held) {
    engine.sound.loop("saw", held ? 0.28 : 0);
  },
};

export const paintball: Tool = {
  id: "paintball",
  name: "Paintball",
  icon: "🎨",
  hint: "click to splat",
  cursor: emojiCursor("🎨"),
  art: paintballArt,
  onDown(engine, e) {
    // A paintball needs a surface. Fired into a hole it flies straight
    // through and is gone — no splat, no drips, nothing to hear it hit.
    if (!engine.onPage(e.x, e.y)) {
      engine.sound.whoosh();
      return;
    }
    const paint = randomPaint();
    const [base, dark, light] = drawSplat(engine.surfaceCtx, e.x, e.y, paint);
    // Mark the splat's full reach explicitly. The engine's per-frame safety net
    // only covers a held pointer — a fast click can be up again before the next
    // frame, and an unmarked splat never reaches the shaded surface. Paint must
    // stay, so it reports itself instead of relying on the pointer.
    engine.markSurface(e.x, e.y, 120);

    // Runs that actually run: each drip slides down over the next second or two
    // and stamps its trail onto the page when it finally stops.
    const drips = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < drips; i++) {
      engine.spawnParticle({
        kind: "paint",
        x: e.x + (Math.random() - 0.5) * 26,
        y: e.y + (Math.random() - 0.5) * 12,
        vx: 0,
        vy: 10 + Math.random() * 26,
        life: 0,
        maxLife: 1.4 + Math.random() * 2.2,
        size: 2.4 + Math.random() * 2.6,
        // Heavy but heavily damped: paint creeps at a near-constant crawl rather
        // than accelerating away like a falling object.
        gravity: 70,
        drag: 1.3,
        len: 0,
        color: base,
        color2: light,
      });
    }
    // Wet flecks thrown clear of the impact, in the same paint.
    debris(engine, e.x, e.y, 10, Math.random() < 0.5 ? base : dark);
    engine.spawnParticle({
      kind: "ring",
      x: e.x,
      y: e.y,
      vx: 0,
      vy: 0,
      life: 0,
      maxLife: 0.2,
      size: 16,
    });
    engine.shake(5, 0, 1);
    engine.sound.splat();
  },
};

/** Broom: drag to sweep damage away and put out fires. */
export const broom: Tool & { sweepDebt: number } = {
  id: "broom",
  name: "Broom",
  icon: "🧹",
  hint: "drag to clean — swats bugs",
  cursor: emojiCursor("🧹"),
  art: broomArt,
  sweepDebt: 0,
  reset() {
    broom.sweepDebt = 0;
  },
  onDown(engine, e) {
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

    const self = broom;
    self.sweepDebt += Math.hypot(e.dx, e.dy);
    if (self.sweepDebt < 26) return;
    self.sweepDebt = 0;
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
 * `desktop-destroyer/tools` when startup size matters more than having every
 * effect available immediately.
 */
export const baseTools: Tool[] = [hammer, gun, flamethrower, waterHose, chainsaw, paintball, broom];
