/**
 * The heavy ordnance.
 *
 * Where the base toolset damages *pixels*, these tools use the engine's
 * physical layer: they fracture the page into rigid bodies, knock real DOM
 * elements loose as objects or bend matter into a singularity.
 *
 * Each one is still just a `Tool` — an object with pointer handlers and a tick.
 * Everything expensive lives behind `engine.fracture` / `explode` / `demolish`,
 * so a host app can write its own tool with the same reach.
 */

import { emojiCursor } from "./cursors";
import { drawBurnChannel } from "./decals";
import { emit, rand, TAU } from "./math";
import { createEngineState } from "./tool-kit";
import { blackHoleArt, bugsArt, demolitionArt, lightningArt, rocketArt } from "./toolart";
import type { DestroyerEngineApi, Tool, Vec2 } from "./types";
import { WOOD } from "./wood";

// ── Black hole ──────────────────────────────────────────────────────────────

/**
 * Open a singularity and hold it open. The engine does the physics — pulling
 * particles and debris in, eating the page, drawing the horizon and accretion
 * disc — so the tool's whole job is to spin one up, steer it, and detonate it
 * when you let go.
 */
const blackHoleStates = createEngineState(() => ({ rumble: 0 }));

export const blackHole: Tool = {
  id: "blackhole",
  name: "Black hole",
  icon: "🕳️",
  hint: "hold to open — release to collapse",
  cursor: emojiCursor("🕳️"),
  art: blackHoleArt,
  reset: (engine) => blackHoleStates.reset(engine),
  hasPendingWork: () => false,
  onDown(engine, e) {
    blackHoleStates.get(engine).rumble = 0;
    engine.setSingularity({ x: e.x, y: e.y, radius: 24, power: 900, charge: 0 });
    engine.sound.hiss();
  },
  onUp(engine) {
    collapseSingularity(engine);
  },
  tick(engine, dt, held, pointer) {
    const state = blackHoleStates.get(engine);
    const s = engine.singularity;
    if (!s) return;
    if (!held || pointer.x <= -100) {
      collapseSingularity(engine);
      return;
    }
    // Grows the longer you hold it, and pulls harder as it grows — the whole
    // tension of the tool is deciding when it has got too big to let go of.
    s.radius = Math.min(130, s.radius + dt * 30);
    s.power = 900 + (s.radius - 24) * 30;
    s.x = pointer.x;
    s.y = pointer.y;
    // A low constant tremor rather than a per-frame hit: it should feel like
    // something straining, without farming the combo meter.
    state.rumble += dt;
    if (state.rumble > 0.14) {
      state.rumble = 0;
      engine.shake(1.6 + s.radius * 0.03);
    }
  },
};

/** Let go and it collapses — everything it swallowed comes back out at once. */
function collapseSingularity(engine: DestroyerEngineApi) {
  const s = engine.singularity;
  if (!s) return;
  engine.setSingularity(null);
  const r = s.radius * s.charge;
  if (r < 6) return;
  // No fires: a collapsing singularity is a blast wave, not combustion — it
  // throws matter, it doesn't ignite it.
  engine.explode(s.x, s.y, r * 2.1 + 36, { power: 700 + r * 8, incendiary: false });
}

// ── Rocket launcher ─────────────────────────────────────────────────────────

interface Rocket {
  x: number;
  y: number;
  vx: number;
  vy: number;
  tx: number;
  ty: number;
  life: number;
  smokeDebt: number;
}

/** Motor smoke and embers per second while a rocket is under power. */
const ROCKET_SMOKE_PER_SECOND = 90;

/** In-flight rockets retained independently for every mounted engine. */
const rocketStates = createEngineState<Rocket[]>(() => []);

/**
 * Fire a rocket at the cursor. It leaves the shoulder tube along the way the
 * launcher is visibly pointing — backblast out the rear, recoil into the
 * page — arcs away as it climbs, then guidance wins and brings it back down
 * on the exact point that was clicked. Detonation on arrival: a blast that
 * fractures the page into physics debris and throws whatever was already loose.
 */
export const rocketLauncher: Tool = {
  id: "rocket",
  name: "Rocket launcher",
  icon: "🚀",
  hint: "click to launch — detonates on return",
  cursor: emojiCursor("🚀"),
  art: rocketArt,
  reset: (engine) => rocketStates.reset(engine),
  hasPendingWork: (engine) => (rocketStates.peek(engine)?.length ?? 0) > 0,
  onDown(engine, e) {
    const rockets = rocketStates.get(engine);
    if (rockets.length > 5) return;
    // Out of the tube, along its axis. The rocket departs the cursor fast —
    // which is why it must not be allowed to detonate until it has actually
    // flown (see the arming gate in tick).
    const aim = engine.toolAim;
    const speed = 820;
    rockets.push({
      x: e.x,
      y: e.y,
      vx: aim.x * speed + rand(-40, 40),
      vy: aim.y * speed + rand(-40, 40),
      tx: e.x,
      ty: e.y,
      life: 0,
      smokeDebt: 0,
    });
    // Launch signature: a flash at the muzzle, backblast smoke out the rear
    // of the tube, and the recoil shoving the page the other way.
    engine.spawnParticle({
      kind: "flash",
      x: e.x,
      y: e.y,
      vx: 0,
      vy: 0,
      life: 0,
      maxLife: 0.12,
      size: 34,
    });
    for (let i = 0; i < 6; i++) {
      engine.spawnParticle({
        kind: "smoke",
        x: e.x - aim.x * 26,
        y: e.y - aim.y * 26,
        vx: -aim.x * rand(80, 240) + rand(-40, 40),
        vy: -aim.y * rand(80, 240) + rand(-40, 40),
        life: 0,
        maxLife: rand(0.8, 1.7),
        size: rand(6, 12),
        gravity: -10,
        drag: 1.9,
        phase: Math.random() * TAU,
      });
    }
    engine.sound.whoosh();
    engine.shake(4, -aim.x, -aim.y);
  },
  tick(engine, dt) {
    const rockets = rocketStates.get(engine);
    for (let i = rockets.length - 1; i >= 0; i--) {
      const r = rockets[i];
      r.life += dt;

      // Steer toward the target — but with guidance that ramps up over the
      // flight. Launched from the target point itself, the rocket must first
      // fly *out* along the tube's axis; weak early gain lets it climb away,
      // strong late gain turns it over and brings it back down on the mark.
      const dx = r.tx - r.x;
      const dy = r.ty - r.y;
      const d = Math.hypot(dx, dy) || 1;
      const speed = Math.hypot(r.vx, r.vy) || 1;
      const gain = Math.min(1, dt * (1.5 + r.life * 9));
      r.vx += ((dx / d) * speed - r.vx) * gain;
      r.vy += ((dy / d) * speed - r.vy) * gain;
      r.x += r.vx * dt;
      r.y += r.vy * dt;

      const angle = Math.atan2(r.vy, r.vx);
      // The rocket is drawn entirely out of particles: a hot core, a motor
      // flare behind it, and a smoke column that hangs in the air afterwards.
      engine.spawnParticle({
        kind: "flash",
        x: r.x,
        y: r.y,
        vx: 0,
        vy: 0,
        life: 0,
        maxLife: 0.09,
        size: 22,
      });
      engine.spawnParticle({
        kind: "streak",
        x: r.x,
        y: r.y,
        vx: 0,
        vy: 0,
        life: 0,
        maxLife: 0.1,
        size: 9,
        angle,
        len: -60,
      });
      r.smokeDebt = emit(r.smokeDebt, dt, ROCKET_SMOKE_PER_SECOND, () => {
        engine.spawnParticle({
          kind: "smoke",
          x: r.x - Math.cos(angle) * 10,
          y: r.y - Math.sin(angle) * 10,
          vx: -Math.cos(angle) * rand(20, 90) + rand(-30, 30),
          vy: -Math.sin(angle) * rand(20, 90) + rand(-30, 30),
          life: 0,
          maxLife: rand(1.1, 2.4),
          size: rand(5, 11),
          gravity: -14,
          drag: 1.7,
          phase: Math.random() * TAU,
        });
        engine.spawnParticle({
          kind: "ember",
          x: r.x - Math.cos(angle) * 8,
          y: r.y - Math.sin(angle) * 8,
          vx: -Math.cos(angle) * rand(60, 220),
          vy: -Math.sin(angle) * rand(60, 220),
          life: 0,
          maxLife: rand(0.15, 0.4),
          size: rand(1.5, 3.5),
          gravity: 0,
        });
      });
      engine.heat(r.x, r.y, 70, 0.4);

      // Detonate on arrival — but only once armed. The rocket starts life at
      // the target (it launches from the cursor), so distance alone would
      // detonate it in the tube; real launchers arm after a safe separation,
      // and so does this one. Bail out if it somehow overshoots for too long.
      const armed = r.life > 0.4;
      if ((armed && d < 26) || r.life > 2.6) {
        rockets.splice(i, 1);
        // The page may have opened up under the target while the rocket was in
        // flight. Aimed at a hole, it doesn't detonate — it flies straight
        // through and is swallowed, motor note trailing off into the void.
        if (engine.onPage(r.tx, r.ty)) {
          engine.explode(r.tx, r.ty, 96, { power: 720 });
        } else {
          engine.sound.whoosh();
        }
      }
    }
  },
  backgroundTick(engine, dt) {
    rocketLauncher.tick?.(engine, dt, false, { x: -1000, y: -1000 });
  },
};

// ── Lightning ───────────────────────────────────────────────────────────────

/** One jagged path from `(x0,y0)` to `(x1,y1)`, as a flat point list. */
function boltPath(x0: number, y0: number, x1: number, y1: number, segments: number, chaos: number) {
  const pts: number[] = [x0, y0];
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  // Displace perpendicular to the run, tapering to zero at the strike point so
  // the bolt actually lands where you clicked.
  const nx = -dy / len;
  const ny = dx / len;
  for (let i = 1; i < segments; i++) {
    const t = i / segments;
    const taper = Math.sin(t * Math.PI);
    const off = rand(-chaos, chaos) * taper;
    pts.push(x0 + dx * t + nx * off, y0 + dy * t + ny * off);
  }
  pts.push(x1, y1);
  return pts;
}

function drawBolt(engine: DestroyerEngineApi, pts: number[], thickness: number, life: number) {
  for (let i = 0; i < pts.length - 2; i += 2) {
    const ax = pts[i];
    const ay = pts[i + 1];
    const bx = pts[i + 2];
    const by = pts[i + 3];
    engine.spawnParticle({
      kind: "streak",
      x: ax,
      y: ay,
      vx: 0,
      vy: 0,
      life: 0,
      maxLife: life,
      size: thickness,
      angle: Math.atan2(by - ay, bx - ax),
      len: Math.hypot(bx - ax, by - ay),
    });
  }
}

/**
 * Restrikes queued by a bolt. Real lightning flickers — the channel re-fires
 * two or three times over ~150 ms down the ionized path — and that flicker is
 * most of the difference between "a lightning strike" and "a bright picture of
 * one". Module state, stepped in the tool's tick like the rockets are.
 */
interface Restrike {
  pts: number[];
  delay: number;
  impactX: number;
  impactY: number;
  grounded: boolean;
}

const lightningStates = createEngineState<Restrike[]>(() => []);

/**
 * Call down a lightning strike. The bolt is a jagged path with branches and
 * sub-branches, drawn as layered additive streaks; the channel re-fires twice
 * as it dies (restrike flicker); where it lands it ionizes a burnt channel
 * through the real content, arcs crawlers across the ground, sets fires and
 * blows a crater.
 */
export const lightning: Tool = {
  id: "lightning",
  name: "Lightning",
  icon: "⚡",
  hint: "click to call down a strike",
  cursor: emojiCursor("⚡"),
  art: lightningArt,
  reset: (engine) => lightningStates.reset(engine),
  hasPendingWork: (engine) => (lightningStates.peek(engine)?.length ?? 0) > 0,
  onDown(engine, e) {
    const restrikes = lightningStates.get(engine);
    // A bolt aimed at a hole never grounds: it passes through the empty space
    // where the page used to be and is gone. The strike itself still happens —
    // the bolt and its branches are in the air in front of the page — but
    // nothing on the surface is touched: no channel, no crater, no crawlers,
    // no fires. Just light, and thunder.
    const grounded = engine.onPage(e.x, e.y);
    if (grounded) engine.signalInteraction("electricity", e.x, e.y);
    const startX = e.x + rand(-220, 220);
    const startY = e.y - rand(520, 860);
    const main = boltPath(startX, startY, e.x, e.y, 18, 96);

    // Four passes over the same path at different widths: an outer ionized
    // halo, a dim glow, the body, and a thin white core. That layering is the
    // whole difference between "lightning" and "a bright zigzag".
    drawBolt(engine, main, 40, 0.09);
    drawBolt(engine, main, 22, 0.13);
    drawBolt(engine, main, 10, 0.18);
    drawBolt(engine, main, 3.5, 0.26);

    // Branches peel off mid-path — and fork again. One level of forks reads
    // as decoration; the second level is what makes it read as electricity
    // finding its way down.
    for (let b = 0; b < 5; b++) {
      const i = (2 + Math.floor(Math.random() * 13)) * 2;
      const bx = main[i];
      const by = main[i + 1];
      const a = -Math.PI / 2 + rand(-1.5, 1.5);
      const len = rand(100, 300);
      const branch = boltPath(bx, by, bx + Math.cos(a) * len, by + Math.sin(a) * len, 7, 48);
      drawBolt(engine, branch, 5, 0.15);
      drawBolt(engine, branch, 2, 0.2);
      // Sub-forks off the branch's midpoint.
      if (Math.random() < 0.7) {
        const j = Math.floor(branch.length / 4) * 2;
        const fa = a + rand(-1.1, 1.1);
        const fl = len * rand(0.3, 0.6);
        drawBolt(
          engine,
          boltPath(
            branch[j],
            branch[j + 1],
            branch[j] + Math.cos(fa) * fl,
            branch[j + 1] + Math.sin(fa) * fl,
            5,
            30,
          ),
          2.5,
          0.16,
        );
      }
    }

    if (grounded) {
      // Burn the channel into the page itself, and cut through the last stretch
      // of it so the strike leaves a real wound and not just a scorch.
      drawBurnChannel(engine.surfaceCtx, main);
      // The channel runs the whole height of the strike, far outside the reach the
      // engine assumes around the cursor. Marked per *segment*, not per point: a
      // bolt's straight runs are longer than any per-point disc would cover, and
      // an unmarked stretch is a stretch that never reaches the screen.
      for (let i = 0; i < main.length - 2; i += 2) {
        engine.markSurfaceSegment(main[i], main[i + 1], main[i + 2], main[i + 3], 10);
      }
      for (let i = Math.max(0, main.length - 10); i < main.length - 2; i += 2) {
        engine.content?.cut(main[i], main[i + 1], main[i + 2], main[i + 3]);
      }

      // Ground crawlers: short arcs that skitter outward from the strike point
      // along the surface, the way a strike grounds itself in every direction.
      for (let c = 0; c < 6 + Math.round(WOOD.conductivity * 4); c++) {
        const a = rand(0, TAU);
        const len = rand(40, 130);
        const crawler = boltPath(
          e.x,
          e.y,
          e.x + Math.cos(a) * len,
          e.y + Math.sin(a) * len * 0.5,
          5,
          18,
        );
        drawBolt(engine, crawler, 2.5, 0.1 + Math.random() * 0.08);
      }
    }

    // Sky flash — the whole viewport blinks — then, if the bolt found page to
    // strike, the crater.
    engine.spawnParticle({
      kind: "flash",
      x: e.x,
      y: e.y - 160,
      vx: 0,
      vy: 0,
      life: 0,
      maxLife: 0.24,
      size: 640,
    });
    if (grounded) {
      const conduction = 1 + WOOD.conductivity * 0.4;
      engine.explode(e.x, e.y, 64 * Math.sqrt(conduction), {
        power: 460 * conduction,
        // The channel below owns ignition. Letting the generic explosion also
        // seed fires duplicated the persistent flame population on every hit.
        incendiary: false,
      });
      // Fires scattered up the strike path — the bolt lit everything it touched.
      for (let i = 8; i < main.length - 2; i += 4) {
        if (Math.random() < 0.45) engine.spawnFlame(main[i], main[i + 1], 0.4);
      }
      engine.heat(e.x, e.y, 260, 1);
    }
    // Thunder either way — but a bolt that found nothing to hit shakes the
    // page with sound alone, not with an impact.
    engine.shake(grounded ? 26 : 10, 0, 1);
    engine.sound.zap();

    // Queue the flicker: two restrikes down the same channel.
    restrikes.push(
      { pts: main, delay: 0.07 + rand(0, 0.05), impactX: e.x, impactY: e.y, grounded },
      { pts: main, delay: 0.17 + rand(0, 0.07), impactX: e.x, impactY: e.y, grounded },
    );
  },
  tick(engine, dt) {
    const restrikes = lightningStates.get(engine);
    for (let i = restrikes.length - 1; i >= 0; i--) {
      const r = restrikes[i];
      r.delay -= dt;
      if (r.delay > 0) continue;
      restrikes.splice(i, 1);
      // The channel re-fires dimmer and thinner — the air is already ionized,
      // so the re-strike follows the old path with a slight wobble.
      const pts = r.pts.map((v, k) => v + (k < 4 ? 0 : rand(-6, 6)));
      drawBolt(engine, pts, 12, 0.1);
      drawBolt(engine, pts, 4, 0.16);
      engine.spawnParticle({
        kind: "flash",
        x: r.impactX,
        y: r.impactY - 120,
        vx: 0,
        vy: 0,
        life: 0,
        maxLife: 0.14,
        size: 380,
      });
      if (r.grounded) engine.heat(r.impactX, r.impactY, 180, 0.5);
      engine.shake(6, 0, 0.5);
    }
  },
  backgroundTick(engine, dt) {
    lightning.tick?.(engine, dt, false, { x: -1000, y: -1000 });
  },
};

// ── Demolition ──────────────────────────────────────────────────────────────

const demolitionStates = createEngineState<{ last: Vec2 | null }>(() => ({ last: null }));

/**
 * Knock real page elements loose.
 *
 * This is the one tool that knows the page is a page: the engine harvested
 * every heading, paragraph, image and card before hiding the DOM, so clicking
 * one takes that whole thing off the page as a rigid body that tumbles and
 * lands on the heap. Click empty space and it just breaks the surface instead.
 */
export const demolition: Tool = {
  id: "demolition",
  name: "Demolition",
  icon: "🏗️",
  hint: "click elements to knock them loose",
  cursor: emojiCursor("🏗️"),
  art: demolitionArt,
  reset: (engine) => demolitionStates.reset(engine),
  onDown(engine, e) {
    demolitionStates.get(engine).last = { x: e.x, y: e.y };
    if (!engine.demolish(e.x, e.y)) {
      // Nothing structural here — take a bite out of the surface instead, so
      // the tool never feels dead. Unless there is no surface: in the void the
      // fracture yields nothing, and striking empty space makes no sound.
      if (engine.fracture(e.x, e.y, 46, { power: 210 }) > 0) {
        engine.shake(7, 0, 1);
        engine.sound.crack();
      }
    }
  },
  onMove(engine, e) {
    const state = demolitionStates.get(engine);
    if (!e.buttons || !state.last) return;
    // Dragging tears out a swathe, but only every 40 px so a fast sweep doesn't
    // try to demolish the entire page in one frame.
    if (Math.hypot(e.x - state.last.x, e.y - state.last.y) < 40) return;
    state.last = { x: e.x, y: e.y };
    if (!engine.demolish(e.x, e.y)) engine.fracture(e.x, e.y, 34, { power: 170 });
  },
  onUp(engine) {
    demolitionStates.get(engine).last = null;
  },
};

/**
 * The classic RageLayer pest: each click releases one bug that
 * wanders and gnaws trails through the page until it is dealt with. Bugs live
 * in the engine (like flames do), so switching to another tool doesn't pause
 * the eating — and every other tool is a valid exterminator: shoot it, burn
 * it, blow it up, or click it again to squash it.
 */
export const bugs: Tool = {
  id: "bugs",
  name: "Bugs",
  icon: "🐛",
  hint: "click to release a bug — shoot, squash, or sweep it",
  cursor: emojiCursor("🐛"),
  art: bugsArt,
  onDown(engine, e) {
    // One click, one meaning: squash what's underfoot, otherwise release one.
    if (engine.squashBugs(e.x, e.y, 24) === 0) {
      engine.spawnBugs(e.x, e.y, 1);
    }
  },
};

export const heavyTools: Tool[] = [demolition, rocketLauncher, lightning, blackHole, bugs];
