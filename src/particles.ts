/**
 * ParticleSystem — the pool every transient effect lives in.
 *
 * Sparks, smoke, water, sawdust, paint drips, shockwave rings and flying page
 * shards are one flat array stepped once a frame. Two details keep a saturated
 * system cheap:
 *
 * - **Recycling, not shifting.** At the cap a new particle overwrites a slot
 *   round-robin; `shift()` would memmove the whole array on every spawn, at
 *   the moment the system is already the frame's biggest cost. Render order
 *   comes from particle *kind* (fx-render.ts), so the swap is invisible.
 * - **Compaction, not splicing.** The step writes survivors down over the
 *   dead in one linear walk.
 *
 * Live "flash"/"jet" particles are counted at each lifecycle site rather than
 * rescanned, because the post-FX bloom decision asks every frame.
 */

import type { Particle } from "./types";

/**
 * What the pool needs from the rest of the engine.
 *
 * Deliberately tiny: the step is a hot loop, and everything it reaches outside
 * itself is a genuine cross-system interaction (water meeting fire, paint
 * meeting the page) rather than a convenience.
 */
export interface ParticleWorld {
  /** Whether the page still exists at a point. Paint clings to it; splashes need it. */
  onPage(x: number, y: number): boolean;
  /** Flames currently alight — droplets skip the dowse test entirely at zero. */
  flameCount(): number;
  /** Damp flames a droplet has touched; returns how many it hit. */
  dowse(x: number, y: number, radius: number, amount: number): number;
  /** Stamp the permanent run a finished paint drip leaves on the page. */
  stampPaintRun(p: Particle): void;
  /** The metallic ping of a shell casing landing. */
  tink(): void;
}

/** Absolute floor for the population cap, whatever the quality profile says. */
const MIN_LIMIT = 64;

export class ParticleSystem {
  private readonly list: Particle[] = [];
  /**
   * Live "flash"/"jet" particles. Kinds never mutate after spawn, so exact
   * bookkeeping at the few lifecycle sites replaces the full-array scans the
   * post-FX demand and bloom checks used to make every frame.
   */
  private hotCount = 0;
  /** Round-robin slot to recycle when the cap is reached. */
  private recycleCursor = 0;
  private limit = MIN_LIMIT;
  /**
   * Flat x,y,vx triplets for splashes queued during the step. The incoming
   * horizontal velocity rides along so splashback leaves the impact biased
   * downstream, the way water actually glances off a surface.
   */
  private readonly pendingSplashes: number[] = [];
  /** Paint drips that finished sliding this step and owe the page a streak. */
  private readonly pendingStamps: Particle[] = [];
  /** Rate gate so a rain of casings doesn't stack into a buzz. */
  private nextTink = 0;

  /** The live particles. Callers may nudge a particle's velocity (a blast does). */
  get particles(): readonly Particle[] {
    return this.list;
  }

  get count(): number {
    return this.list.length;
  }

  /** How many bright "flash"/"jet" particles are alight (drives bloom). */
  get flashJetCount(): number {
    return this.hotCount;
  }

  /**
   * Set the population cap. Lowering it below the current population drops the
   * oldest effects, keeping the newest — this runs only on a quality-profile
   * transition, never in the frame loop, so the one splice beats ongoing churn.
   */
  setLimit(limit: number) {
    this.limit = Math.max(MIN_LIMIT, Math.round(limit));
    if (this.list.length <= this.limit) return;
    this.list.splice(0, this.list.length - this.limit);
    this.recycleCursor %= this.list.length;
    let hot = 0;
    for (const p of this.list) {
      if (isHot(p)) hot++;
    }
    this.hotCount = hot;
  }

  spawn(p: Particle) {
    const hot = isHot(p);
    if (this.list.length >= this.limit) {
      this.recycleCursor = (this.recycleCursor + 1) % this.list.length;
      const old = this.list[this.recycleCursor];
      if (isHot(old)) this.hotCount--;
      if (hot) this.hotCount++;
      this.list[this.recycleCursor] = p;
      return;
    }
    if (hot) this.hotCount++;
    this.list.push(p);
  }

  clear() {
    this.list.length = 0;
    this.hotCount = 0;
    this.pendingSplashes.length = 0;
    this.pendingStamps.length = 0;
  }

  /** Advance every particle. `now` is the rAF clock in ms, for the casing gate. */
  step(dt: number, now: number, world: ParticleWorld) {
    const list = this.list;
    let write = 0;
    let hotSurvivors = 0;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      p.life += dt;
      if (p.life >= p.maxLife) {
        // A drip that has stopped moving leaves a permanent run on the page.
        // Queued, not stamped here: the content canvas is document-sized and
        // this pass is already the hot loop.
        if (p.kind === "paint" && world.onPage(p.x, p.y)) this.pendingStamps.push(p);
        continue;
      }

      const gravity =
        p.gravity ?? (p.kind === "smoke" || p.kind === "steam" || p.kind === "dust" ? -10 : 350);
      p.vy += gravity * dt;
      if (p.drag) {
        p.vx *= 1 - p.drag * dt;
        p.vy *= 1 - p.drag * dt;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.angle !== undefined && p.spin) p.angle += p.spin * dt;
      // Paint clings while there is a surface under it. Reaching a hole turns
      // the run into a falling drop; in this 2D layer that means it leaves the
      // page without stamping a bridge across the void.
      if (p.kind === "paint" && !world.onPage(p.x, p.y)) continue;
      // Runs trail behind whatever is sliding down the page — water rivulets
      // and paint drips both leave a tail as long as the distance they covered.
      if (p.kind === "rivulet" || p.kind === "paint") p.len = (p.len ?? 0) + Math.max(0, p.vy) * dt;

      // Landing. Solid bits fall out of the page and clatter onto whatever is
      // below; settling them (rather than letting them sink forever) is most of
      // what makes debris read as physical.
      if (p.bounce && p.restY !== undefined && p.vy > 0 && p.y >= p.restY) {
        p.y = p.restY;
        p.vy = -p.vy * p.bounce;
        p.vx *= 0.55;
        if (p.spin) p.spin *= 0.4;
        if (p.kind === "casing" && p.bounce > 0.35 && now > this.nextTink) {
          this.nextTink = now + 45;
          world.tink();
        }
        p.bounce *= 0.42;
        if (p.bounce < 0.12) {
          p.bounce = 0;
          p.vx = p.vy = 0;
          p.gravity = 0;
          p.spin = 0;
        }
      }

      // Water droplets extinguish flames they touch.
      if (p.kind === "water") {
        if (world.flameCount() > 0 && world.dowse(p.x, p.y, 10, 0.12) > 0) continue;
        // Splash when a droplet "lands" (end of its arc). Deferred: spawning
        // mid-compaction could land a new particle in a slot this pass has
        // already walked past.
        if (p.life > p.maxLife * 0.85) {
          if (world.onPage(p.x, p.y)) this.pendingSplashes.push(p.x, p.y, p.vx);
          continue;
        }
      }
      if (isHot(p)) hotSurvivors++;
      list[write++] = p;
    }
    list.length = write;
    // Settle the exact count from what actually survived the walk; the deferred
    // splash spawns below go through `spawn` and count themselves.
    this.hotCount = hotSurvivors;
    if (this.recycleCursor >= write) this.recycleCursor = 0;

    for (let i = 0; i < this.pendingSplashes.length; i += 3) {
      this.splash(
        this.pendingSplashes[i],
        this.pendingSplashes[i + 1],
        this.pendingSplashes[i + 2],
      );
    }
    this.pendingSplashes.length = 0;

    for (const p of this.pendingStamps) world.stampPaintRun(p);
    this.pendingStamps.length = 0;
  }

  /** Everything a droplet does at the end of its arc. */
  private splash(x: number, y: number, inVx: number) {
    for (let i = 0; i < 3; i++) {
      this.spawn({
        kind: "splash",
        x,
        y,
        // Splashback keeps a quarter of the arriving sideways speed: the spray
        // glances downstream off the page instead of blooming symmetrically.
        vx: inVx * 0.25 + (Math.random() - 0.5) * 90,
        vy: -Math.random() * 70,
        life: 0,
        maxLife: 0.25 + Math.random() * 0.2,
        size: 1 + Math.random() * 2,
      });
    }
    // One droplet in three genuinely bounces: it leaps back off the surface,
    // arcs, and lands again a short way downstream — the "rain on pavement"
    // half of a hose stream hitting something solid.
    if (Math.random() < 0.34) {
      this.spawn({
        kind: "water",
        x,
        y,
        vx: inVx * 0.3 + (Math.random() - 0.5) * 60,
        vy: -90 - Math.random() * 130,
        life: 0,
        maxLife: 0.3 + Math.random() * 0.2,
        size: 1.6 + Math.random() * 1.8,
        gravity: 900,
        drag: 0.6,
      });
    }
    // Lingering wet mark.
    this.spawn({
      kind: "wet",
      x,
      y,
      vx: 0,
      vy: 12,
      life: 0,
      maxLife: 2.5 + Math.random() * 2,
      size: 5 + Math.random() * 9,
      gravity: 0,
    });
    // Every few splashes, one gathers into a run that streaks down the page.
    if (Math.random() < 0.22) {
      this.spawn({
        kind: "rivulet",
        x,
        y,
        vx: (Math.random() - 0.5) * 8,
        vy: 30 + Math.random() * 50,
        life: 0,
        maxLife: 1.1 + Math.random() * 1.2,
        size: 1.4 + Math.random() * 1.8,
        gravity: 90,
        drag: 1.6,
        len: 0,
      });
    }
  }

  /**
   * Throw every particle within reach of a blast outward. Lives here rather
   * than in the caller so nothing outside has to walk the pool by hand.
   */
  blast(x: number, y: number, radius: number, power: number) {
    for (const p of this.list) {
      const dx = p.x - x;
      const dy = p.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 > radius * radius * 6) continue;
      const d = Math.sqrt(d2) || 1;
      const f = power / Math.max(40, d);
      p.vx += (dx / d) * f;
      p.vy += (dy / d) * f;
    }
  }

  /**
   * Spiral loose particles into a singularity and consume the ones that reach
   * it. The tangential term is what turns a vacuum cleaner into something that
   * looks like it has an accretion disc.
   */
  attract(x: number, y: number, power: number, horizon: number, dt: number) {
    for (const p of this.list) {
      const dx = x - p.x;
      const dy = y - p.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > 810000) continue;
      const d = Math.sqrt(d2) || 1;
      const a = ((power * 30) / Math.max(3200, d2)) * dt;
      p.vx += (dx / d) * a - (dy / d) * a * 0.55;
      p.vy += (dy / d) * a + (dx / d) * a * 0.55;
      if (d < horizon) p.life = p.maxLife;
    }
  }
}

function isHot(p: Particle): boolean {
  return p.kind === "flash" || p.kind === "jet";
}
