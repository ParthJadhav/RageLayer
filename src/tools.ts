import type { DestroyerEngineApi, Tool, ToolPointerEvent, Vec2 } from "./types";
import { drawBulletHole, drawCrack, drawGash, drawSplat, randomPaint } from "./decals";
import { emojiCursor } from "./cursors";

const TAU = Math.PI * 2;

function debris(engine: DestroyerEngineApi, x: number, y: number, count: number, color?: string) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * TAU;
    const speed = 60 + Math.random() * 220;
    engine.spawnParticle({
      kind: "debris",
      x,
      y,
      vx: Math.cos(a) * speed,
      vy: Math.sin(a) * speed - 120,
      life: 0,
      maxLife: 0.7 + Math.random() * 0.9,
      size: 1.5 + Math.random() * 3.5,
      color,
      angle: Math.random() * TAU,
      spin: (Math.random() - 0.5) * 20,
      // Chips of page fall out and come to rest instead of sinking forever.
      bounce: 0.35 + Math.random() * 0.25,
      restY: y + 60 + Math.random() * 180,
    });
  }
}

/**
 * Pale powdered page thrown up by an impact. Rises with the blast, then hangs
 * and drifts down — it is the slow part of a hit, and what keeps a wound
 * looking fresh for a second after the fast debris is gone.
 */
function dustPuff(engine: DestroyerEngineApi, x: number, y: number, count: number, spread: number, force = 1) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * TAU;
    const d = Math.random() * spread;
    engine.spawnParticle({
      kind: "dust",
      x: x + Math.cos(a) * d,
      y: y + Math.sin(a) * d,
      vx: Math.cos(a) * (20 + Math.random() * 90) * force,
      vy: Math.sin(a) * (14 + Math.random() * 60) * force - 24,
      life: 0,
      maxLife: 0.8 + Math.random() * 1.3,
      size: 5 + Math.random() * 11,
      gravity: 14,
      drag: 2.2,
    });
  }
}

/**
 * A smoothed aim direction taken from pointer motion.
 *
 * The jet tools need to point *somewhere*; a cone that always sprays straight
 * up ignores where you are actually painting. Motion direction is the only
 * signal a mouse gives, and smoothing it stops the cone snapping around on
 * every jittery pixel of movement.
 */
function makeAim(defaultX: number, defaultY: number) {
  return {
    x: defaultX,
    y: defaultY,
    lastX: -10000,
    lastY: -10000,
    update(pointer: Vec2, dt: number) {
      const dx = pointer.x - this.lastX;
      const dy = pointer.y - this.lastY;
      const moved = Math.hypot(dx, dy);
      if (this.lastX > -9999 && moved > 1.5) {
        // Snap harder the faster the pointer is moving, so a decisive sweep
        // redirects the jet immediately but a twitch barely nudges it.
        const k = Math.min(1, dt * (6 + moved * 0.6));
        this.x += (dx / moved - this.x) * k;
        this.y += (dy / moved - this.y) * k;
        const m = Math.hypot(this.x, this.y) || 1;
        this.x /= m;
        this.y /= m;
      }
      this.lastX = pointer.x;
      this.lastY = pointer.y;
    },
    reset() {
      this.lastX = this.lastY = -10000;
    },
  };
}

/** Recent hammer strikes, so a second blow beside the first widens the web. */
const impacts: { x: number; y: number; scale: number }[] = [];
const IMPACT_MEMORY = 10;
const IMPACT_RADIUS = 110;

export const hammer: Tool = {
  id: "hammer",
  name: "Hammer",
  icon: "🔨",
  hint: "click to smash",
  cursor: emojiCursor("🔨", { flip: true }),
  onDown(engine, e) {
    // Land the blow near an existing web and the fracture grows outward from it
    // rather than starting a fresh, symmetric star on top of the old one.
    let scale = 0.9 + Math.random() * 0.5;
    let bias: number | undefined;
    let nearest = -1;
    let nearestDist = IMPACT_RADIUS;
    for (let i = 0; i < impacts.length; i++) {
      const d = Math.hypot(impacts[i].x - e.x, impacts[i].y - e.y);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = i;
      }
    }
    if (nearest >= 0) {
      const prev = impacts[nearest];
      scale = Math.min(2.4, prev.scale + 0.5);
      bias = Math.atan2(e.y - prev.y, e.x - prev.x);
    }
    impacts.push({ x: e.x, y: e.y, scale });
    if (impacts.length > IMPACT_MEMORY) impacts.shift();

    // Crack web first, then knock real chunks of the page loose (the punch
    // inside shatter() must land last so the hole stays transparent).
    drawCrack(engine.surfaceCtx, e.x, e.y, scale, { bias });
    engine.shatter(e.x, e.y, 24 + scale * 8);

    // The instant of contact: a white pop and a shockwave ring rushing out well
    // past the hole, both gone within a fifth of a second.
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
    engine.sound.thunk();
    engine.sound.crack();
  },
};

function fireShot(engine: DestroyerEngineApi, x: number, y: number, spread = 0) {
  const sx = x + (Math.random() - 0.5) * spread;
  const sy = y + (Math.random() - 0.5) * spread;
  // Dress the rim first, then punch clean through the real page content —
  // order matters: punching last keeps the hole genuinely transparent.
  drawBulletHole(engine.surfaceCtx, sx, sy, 0.9 + Math.random() * 0.4);
  engine.content?.punch(sx, sy, 5);

  // The round came from somewhere: a tracer streak, and a muzzle flare aligned
  // with it, sell the shot as travelling rather than just appearing.
  const incoming = Math.random() * TAU;
  engine.spawnParticle({
    kind: "streak",
    x: sx,
    y: sy,
    vx: 0,
    vy: 0,
    life: 0,
    maxLife: 0.07,
    size: 7,
    angle: incoming,
    len: -(150 + Math.random() * 160),
  });
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
  engine.spawnParticle({
    kind: "casing",
    x: sx + 8,
    y: sy,
    vx: 120 + Math.random() * 120,
    vy: -180 - Math.random() * 80,
    life: 0,
    maxLife: 1.6,
    size: 3,
    angle: Math.random() * TAU,
    spin: 18,
    bounce: 0.5,
    restY: sy + 120 + Math.random() * 160,
  });
  debris(engine, sx, sy, 5);
  // Plaster: hangs in the air and settles long after the crack of the shot.
  dustPuff(engine, sx, sy, 6, 9);
  engine.shake(6, Math.cos(incoming), Math.sin(incoming));
  engine.sound.shot();
}

export const pistol: Tool = {
  id: "pistol",
  name: "Pistol",
  icon: "🔫",
  hint: "click to shoot",
  cursor: emojiCursor("🔫", { flip: true }),
  onDown(engine, e) {
    fireShot(engine, e.x, e.y);
  },
};

/** Barrel smoke per second while the trigger is held. */
const BARREL_SMOKE_PER_SECOND = 14;

/** Machine gun: hold to auto-fire with spray. */
export const machineGun: Tool & { cooldown: number; smokeDebt: number } = {
  id: "machinegun",
  name: "Machine gun",
  icon: "🎯",
  hint: "hold to spray",
  cursor: emojiCursor("🎯"),
  cooldown: 0,
  smokeDebt: 0,
  onDown() {
    this.cooldown = 0;
  },
  tick(engine, dt, held, pointer) {
    const self = machineGun;
    self.cooldown -= dt;
    if (!held || pointer.x <= -100) {
      self.smokeDebt = 0;
      return;
    }
    if (self.cooldown <= 0) {
      self.cooldown = 0.085;
      fireShot(engine, pointer.x, pointer.y, 26);
      // Sustained rattle on top of the per-shot kick: automatic fire should
      // never let the page settle.
      engine.shake(9);
    }
    // Powder smoke pouring off a barrel that is not getting a chance to cool.
    self.smokeDebt += dt * BARREL_SMOKE_PER_SECOND;
    const puffs = Math.floor(self.smokeDebt);
    self.smokeDebt -= puffs;
    for (let i = 0; i < puffs; i++) {
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
    }
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
  hint: "hold to burn",
  cursor: emojiCursor("🔥"),
  cooldown: 0,
  emberDebt: 0,
  blobDebt: 0,
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
      engine.spawnFlame(pointer.x + (Math.random() - 0.5) * 22, pointer.y + (Math.random() - 0.5) * 16, 0.5);
      const reach = 26 + Math.random() * 46;
      engine.spawnFlame(pointer.x + aim.x * reach, pointer.y + aim.y * reach, 0.32);
    }

    // The jet itself: fuel launched hard along the aim, dragged down and lifted
    // by its own heat, so the spray fans into a cone that curls up at the tip.
    self.blobDebt += dt * JET_BLOBS_PER_SECOND;
    const blobs = Math.floor(self.blobDebt);
    self.blobDebt -= blobs;
    for (let i = 0; i < blobs; i++) {
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
    }

    // Jet sparks streaming from the nozzle for feedback.
    self.emberDebt += dt * JET_EMBERS_PER_SECOND;
    const embers = Math.floor(self.emberDebt);
    self.emberDebt -= embers;
    for (let i = 0; i < embers; i++) {
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
    }
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
  hint: "hold to spray",
  cursor: emojiCursor("💦"),
  spawnDebt: 0,
  streamDebt: 0,
  mistDebt: 0,
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

    // The solid part of the jet, before it breaks up into droplets. Without it
    // the hose is a cloud of dots with no pressure behind it.
    self.streamDebt += dt * STREAM_PER_SECOND;
    const segments = Math.floor(self.streamDebt);
    self.streamDebt -= segments;
    for (let i = 0; i < segments; i++) {
      engine.spawnParticle({
        kind: "stream",
        x: pointer.x,
        y: pointer.y,
        vx: 0,
        vy: 0,
        life: 0,
        maxLife: 0.12 + Math.random() * 0.08,
        size: 10 + Math.random() * 9,
        angle: base + (Math.random() - 0.5) * 0.22,
        len: 70 + Math.random() * 80,
      });
    }

    // Mist blowing back off the nozzle.
    self.mistDebt += dt * MIST_PER_SECOND;
    const mist = Math.floor(self.mistDebt);
    self.mistDebt -= mist;
    for (let i = 0; i < mist; i++) {
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
    }

    // Accumulate fractional droplets so the rate is the same at 60 and 120Hz.
    self.spawnDebt += dt * DROPS_PER_SECOND;
    const drops = Math.floor(self.spawnDebt);
    self.spawnDebt -= drops;
    for (let i = 0; i < drops; i++) {
      const a = base + (Math.random() - 0.5) * 0.85;
      const speed = 260 + Math.random() * 300;
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
    }
    // Direct dowse under the nozzle so aiming at a flame feels responsive. The
    // reach is generous because the droplets now leave the nozzle fast enough to
    // arc clear over a fire sitting right under the cursor.
    engine.dowseFlames(pointer.x, pointer.y, 64, dt * 2.2);
  },
};

/** Torn strips are cut loose every this many px of travel. */
const STRIP_INTERVAL = 64;

/** Chainsaw: drag to tear gashes along the path. */
export const chainsaw: Tool & { lastCut: Vec2 | null; stripDebt: number } = {
  id: "chainsaw",
  name: "Chainsaw",
  icon: "🪚",
  hint: "drag to cut",
  cursor: emojiCursor("🪚"),
  lastCut: null,
  stripDebt: 0,
  onDown(engine, e) {
    this.lastCut = { x: e.x, y: e.y };
    this.stripDebt = 0;
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

    // Torn edges first, then slice through the actual content so the cut
    // itself stays a real gap.
    drawGash(engine.surfaceCtx, self.lastCut.x, self.lastCut.y, ex, ey);
    engine.content?.cut(self.lastCut.x, self.lastCut.y, ex, ey);

    // Sawdust sprays back along the blade; page-coloured confetti comes off with
    // it, so the debris looks like shredded page rather than generic grit.
    for (let i = 0; i < 12; i++) {
      const back = Math.atan2(-dy, -dx) + (Math.random() - 0.5) * 1.5;
      const speed = 120 + Math.random() * 320;
      engine.spawnParticle({
        kind: "sawdust",
        x: e.x + (Math.random() - 0.5) * 8,
        y: e.y + (Math.random() - 0.5) * 8,
        vx: Math.cos(back) * speed,
        vy: Math.sin(back) * speed - 60,
        life: 0,
        maxLife: 0.5 + Math.random() * 0.6,
        size: 1.5 + Math.random() * 2.5,
        angle: Math.random() * TAU,
        spin: (Math.random() - 0.5) * 25,
        bounce: 0.3,
        restY: e.y + 50 + Math.random() * 150,
      });
    }
    if (Math.random() < 0.7) {
      debris(engine, e.x, e.y, 3, Math.random() < 0.5 ? "#d8d2c8" : "#8e8880");
    }
    dustPuff(engine, e.x, e.y, 3, 10, 0.7);

    // Every so often a strip of page comes away entirely and falls.
    self.stripDebt += dist;
    if (self.stripDebt >= STRIP_INTERVAL) {
      self.stripDebt = 0;
      const size = 14 + Math.random() * 22;
      const patch = engine.content?.patch(ex, ey, size, size);
      if (patch) {
        engine.spawnParticle({
          kind: "shard",
          x: ex,
          y: ey,
          vx: (Math.random() - 0.5) * 90,
          vy: 30 + Math.random() * 80,
          life: 0,
          maxLife: 1.4 + Math.random() * 0.8,
          size,
          angle: Math.random() * TAU,
          spin: (Math.random() - 0.5) * 9,
          bounce: 0.3,
          restY: ey + 130 + Math.random() * 260,
          img: patch.img,
          sx: patch.sx,
          sy: patch.sy,
          sw: patch.sw,
          sh: patch.sh,
        });
      }
    }

    // Kickback shoves the page along the blade's own direction.
    engine.shake(5, nx, ny);
    self.lastCut = { x: ex, y: ey };
  },
  onUp() {
    this.lastCut = null;
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
  onDown(engine, e) {
    const paint = randomPaint();
    const [base, dark, light] = drawSplat(engine.surfaceCtx, e.x, e.y, paint);

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
  hint: "drag to clean",
  cursor: emojiCursor("🧹"),
  sweepDebt: 0,
  onDown(engine, e) {
    engine.eraseDamage(e.x, e.y, 42);
    engine.dowseFlames(e.x, e.y, 50, 1);
    engine.sound.sweep();
  },
  onMove(engine, e) {
    if (!e.buttons) return;
    engine.eraseDamage(e.x, e.y, 42);
    engine.dowseFlames(e.x, e.y, 50, 1);

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

export const defaultTools: Tool[] = [hammer, pistol, machineGun, flamethrower, waterHose, chainsaw, paintball, broom];
