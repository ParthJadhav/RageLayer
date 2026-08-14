/**
 * A small 2D rigid-body solver, written for exactly one job: making torn-off
 * chunks of a web page fall, tumble, collide and *pile up* believably.
 *
 * Why hand-rolled rather than matter-js/planck: the package ships as a
 * dependency-light easter egg, the shapes are all small convex polygons, and
 * the interesting behaviour (debris settling into a heap at the bottom of the
 * viewport) needs a solver tuned for stacking rather than a general engine.
 *
 * It is a textbook sequential-impulse solver — the same shape as Box2D-lite:
 *
 * 1. integrate velocities (gravity, damping);
 * 2. build contacts once per step (SAT for the axis of least penetration, then
 *    reference/incident face clipping for up to two contact points);
 * 3. iterate normal + friction impulses over those contacts;
 * 4. integrate positions and push overlapping pairs apart (Baumgarte, with a
 *    slop so resting stacks don't jitter).
 *
 * Everything is in CSS pixels and document coordinates, matching the rest of
 * the engine. Bodies carry a pre-baked, alpha-masked sprite of the page pixels
 * they were cut from, so drawing one is a single rotated `drawImage`.
 */

import { collide, createManifold, type Manifold } from "./collision";
import { TAU } from "./math";

/** Hard safety cap for simulation, sprite memory, and worst-case dense contact work. */
export const MAX_BODIES = 190;

export interface BodyInit {
  /** World-space polygon in CSS px. Winding is normalized on construction. */
  points: number[];
  /** Pre-baked, alpha-masked page pixels for this chunk. */
  sprite?: HTMLCanvasElement | null;
  vx?: number;
  vy?: number;
  /** Angular velocity, rad/s. */
  av?: number;
  restitution?: number;
  friction?: number;
  /** Mass per unit area. Ice is light and skittery, plaster is heavy. */
  density?: number;
  /** Immovable (floor, walls). */
  fixed?: boolean;
  /** Seconds before the body starts fading out. Infinity = never. */
  ttl?: number;
}

export class Body {
  /** Local-space vertices relative to the centroid: x0,y0,x1,y1,… */
  readonly lv: Float64Array;
  readonly count: number;
  /** Bounding radius about the centroid — the broadphase test. */
  readonly radius: number;
  /** World-space vertex cache, rebuilt when the transform changes. */
  readonly wv: Float64Array;
  /** World-space outward face normals, parallel to `wv`. */
  readonly wn: Float64Array;
  /** Tight world-space AABB, rebuilt with the vertex cache. */
  minX = 0;
  minY = 0;
  maxX = 0;
  maxY = 0;

  x: number;
  y: number;
  angle = 0;
  vx: number;
  vy: number;
  av: number;

  invMass: number;
  invInertia: number;
  restitution: number;
  friction: number;
  fixed: boolean;

  sprite: HTMLCanvasElement | null;
  /** Slab underside, drawn beneath `sprite` at a small offset for thickness. */
  sideSprite: HTMLCanvasElement | null = null;
  /** Half-extents of the sprite in CSS px (it is baked over the local AABB). */
  spriteW = 0;
  spriteH = 0;
  /** Sprite centre offset from the centroid, in local space. */
  spriteX = 0;
  spriteY = 0;

  awake = true;
  /** Seconds spent below the sleep thresholds. */
  private idle = 0;
  /** Cached transform the world vertices were built for. */
  private cachedX = NaN;
  private cachedY = NaN;
  private cachedA = NaN;

  age = 0;
  ttl: number;
  /** 0..1, drawn straight into `globalAlpha`. Explosions fade their debris out. */
  alpha = 1;
  dead = false;
  /**
   * Skip contact resolution for one step. Set by the singularity's capture
   * funnel: a chunk being swallowed is on a kinematic infall and must not be
   * pinned by the pile it is being ripped out of. Cleared at the end of every
   * `step`, so it lasts exactly as long as something keeps asserting it.
   */
  ghost = false;

  constructor(init: BodyInit) {
    const pts = init.points;
    const n = pts.length >> 1;
    // Shoelace: area and centroid in one pass. A degenerate sliver gets a
    // fallback centroid so it still behaves like a (tiny) body rather than
    // dividing by zero.
    let area2 = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const x0 = pts[i * 2];
      const y0 = pts[i * 2 + 1];
      const x1 = pts[j * 2];
      const y1 = pts[j * 2 + 1];
      const cross = x0 * y1 - x1 * y0;
      area2 += cross;
      cx += (x0 + x1) * cross;
      cy += (y0 + y1) * cross;
    }
    let area = area2 / 2;
    if (Math.abs(area) < 1e-6) {
      cx = cy = 0;
      for (let i = 0; i < n; i++) {
        cx += pts[i * 2];
        cy += pts[i * 2 + 1];
      }
      cx /= n;
      cy /= n;
      area = 1;
    } else {
      cx /= 3 * area2;
      cy /= 3 * area2;
    }

    // Normalize to positive shoelace area so face normals are reliably outward
    // (in a y-down space the outward normal of edge d is then (dy, -dx)).
    const flip = area < 0;
    area = Math.abs(area);
    this.count = n;
    this.lv = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      const src = flip ? n - 1 - i : i;
      this.lv[i * 2] = pts[src * 2] - cx;
      this.lv[i * 2 + 1] = pts[src * 2 + 1] - cy;
    }
    this.wv = new Float64Array(n * 2);
    this.wn = new Float64Array(n * 2);

    let r2 = 0;
    for (let i = 0; i < n; i++) {
      const d = this.lv[i * 2] ** 2 + this.lv[i * 2 + 1] ** 2;
      if (d > r2) r2 = d;
    }
    this.radius = Math.sqrt(r2);

    this.x = cx;
    this.y = cy;
    this.vx = init.vx ?? 0;
    this.vy = init.vy ?? 0;
    this.av = init.av ?? 0;
    this.restitution = init.restitution ?? 0.16;
    this.friction = init.friction ?? 0.55;
    this.fixed = init.fixed ?? false;
    this.ttl = init.ttl ?? Infinity;
    this.sprite = init.sprite ?? null;

    if (this.fixed) {
      this.invMass = 0;
      this.invInertia = 0;
    } else {
      const mass = Math.max(0.6, area * (init.density ?? 0.0016));
      this.invMass = 1 / mass;
      // Polygon second moment about the centroid (Box2D's formulation).
      let num = 0;
      let den = 0;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = this.lv[i * 2];
        const ay = this.lv[i * 2 + 1];
        const bx = this.lv[j * 2];
        const by = this.lv[j * 2 + 1];
        const cross = Math.abs(ax * by - ay * bx);
        num += cross * (ax * ax + ax * bx + bx * bx + ay * ay + ay * by + by * by);
        den += cross;
      }
      const inertia = den > 0 ? (mass * num) / (6 * den) : mass;
      this.invInertia = inertia > 1e-6 ? 1 / inertia : 0;
    }
  }

  /** Rebuild the world-space vertex/normal cache if the transform moved. */
  sync() {
    if (this.x === this.cachedX && this.y === this.cachedY && this.angle === this.cachedA) return;
    this.cachedX = this.x;
    this.cachedY = this.y;
    this.cachedA = this.angle;
    const cos = Math.cos(this.angle);
    const sin = Math.sin(this.angle);
    const n = this.count;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const lx = this.lv[i * 2];
      const ly = this.lv[i * 2 + 1];
      const x = this.x + lx * cos - ly * sin;
      const y = this.y + lx * sin + ly * cos;
      this.wv[i * 2] = x;
      this.wv[i * 2 + 1] = y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    this.minX = minX;
    this.minY = minY;
    this.maxX = maxX;
    this.maxY = maxY;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const dx = this.wv[j * 2] - this.wv[i * 2];
      const dy = this.wv[j * 2 + 1] - this.wv[i * 2 + 1];
      const len = Math.hypot(dx, dy) || 1;
      this.wn[i * 2] = dy / len;
      this.wn[i * 2 + 1] = -dx / len;
    }
  }

  wake() {
    if (this.fixed) return;
    this.awake = true;
    this.idle = 0;
  }

  /** Impulse at a world point — the only way anything moves a body. */
  applyImpulse(ix: number, iy: number, px: number, py: number) {
    if (this.fixed) return;
    this.vx += ix * this.invMass;
    this.vy += iy * this.invMass;
    this.av += ((px - this.x) * iy - (py - this.y) * ix) * this.invInertia;
    this.wake();
  }

  /**
   * Settle test. Sleeping is what keeps a hundred-chunk heap free: a resting
   * body is skipped by integration entirely until something touches it.
   */
  updateSleep(dt: number) {
    if (this.fixed) return;
    if (Math.abs(this.vx) + Math.abs(this.vy) < 4 && Math.abs(this.av) < 0.12) {
      this.idle += dt;
      if (this.idle > 0.55) {
        this.awake = false;
        this.vx = this.vy = this.av = 0;
      }
    } else {
      this.idle = 0;
    }
  }

  /** Release backing stores as soon as a chunk leaves the world. */
  dispose() {
    // Every removal path (retirement, trim, cap eviction, clear) funnels
    // through here, so the flag doubles as the world's tombstone: the
    // persistent broadphase list drops flagged bodies on its next sync.
    this.dead = true;
    if (this.sprite) {
      this.sprite.width = 0;
      this.sprite.height = 0;
      this.sprite = null;
    }
    if (this.sideSprite) {
      this.sideSprite.width = 0;
      this.sideSprite.height = 0;
      this.sideSprite = null;
    }
  }
}

export interface WorldOptions {
  gravity?: number;
  /** Solver iterations. 8 is enough for heaps a few chunks deep. */
  iterations?: number;
}

/**
 * The physics world. The engine owns exactly one, steps it after the particle
 * pass, and draws its bodies onto the fx canvas.
 */
export class PhysicsWorld {
  bodies: Body[] = [];
  gravity: number;
  private maxBodies = MAX_BODIES;
  /** Velocity/position solver passes per step (see `WorldOptions.iterations`). */
  private iterations: number;
  /** Contact storage is pooled so a tumbling heap does not allocate every frame. */
  private manifolds: Manifold[] = [];
  /**
   * Persistent x-sorted candidate list for the sweep-and-prune broadphase.
   * Membership is maintained incrementally (`add` appends, disposed bodies are
   * dropped during `step`), so it keeps last step's near-sorted order and the
   * per-step re-sort is a handful of insertion-sort swaps instead of a full
   * comparator-callback sort.
   */
  private broadphase: Body[] = [];
  /** Scratch list returned by `attract`; valid until the next call. */
  private eaten: Body[] = [];
  /**
   * Cached answer for `active`, recomputed by the loop `step` already runs over
   * every body. External mutations that can wake or add bodies set it `true`
   * conservatively; the next step settles it, so the getter never has to
   * re-scan the whole heap once per frame.
   */
  private activeCache = false;

  /**
   * Hard contacts recorded during the last `step`, as flat (x, y, speed)
   * triplets — a chunk slamming into the floor or another chunk. The engine
   * turns these into a puff of paper dust at the impact point. Bounded (see
   * `step`), reused across frames, and free when nothing is falling.
   */
  readonly impacts: number[] = [];

  /** Static geometry: a floor that tracks the viewport, plus side walls. */
  private floor: Body | null = null;
  private leftWall: Body | null = null;
  private rightWall: Body | null = null;
  private statics: Body[] = [];
  private floorY = 0;

  constructor(options: WorldOptions = {}) {
    this.gravity = options.gravity ?? 1750;
    this.iterations = options.iterations ?? 8;
  }

  setIterations(iterations: number) {
    this.iterations = Math.max(2, Math.min(12, Math.round(iterations)));
  }

  setBodyLimit(limit: number) {
    this.maxBodies = Math.max(8, Math.min(MAX_BODIES, Math.round(limit)));
    this.trim(this.maxBodies);
  }

  trim(limit: number) {
    if (this.bodies.length <= limit) return;
    const retired = this.bodies.splice(0, this.bodies.length - limit);
    for (const body of retired) body.dispose();
  }

  /**
   * Position the static geometry.
   *
   * The floor sits at the bottom of the *viewport*, not the document: on a page
   * ten screens tall, debris that fell to the document floor would simply be
   * gone. Piling at the bottom of the window is both visible and what the toy
   * reads as — a heap of wreckage collecting at your feet.
   */
  setBounds(width: number, floorY: number) {
    const moved = Math.abs(floorY - this.floorY) > 0.5;
    this.floorY = floorY;
    if (!this.floor) {
      const fixed = { fixed: true, friction: 0.75, restitution: 0.05 } as const;
      this.floor = new Body({
        ...fixed,
        points: [-4000, 0, width + 4000, 0, width + 4000, 3000, -4000, 3000],
      });
      this.leftWall = new Body({
        ...fixed,
        points: [-3000, -6000, 0, -6000, 0, 6000, -3000, 6000],
      });
      this.rightWall = new Body({
        ...fixed,
        points: [width, -6000, width + 3000, -6000, width + 3000, 6000, width, 6000],
      });
      this.statics = [this.floor, this.leftWall, this.rightWall];
    }
    // Statics are repositioned by moving the centroid; the local shape is fixed.
    this.floor.x = width / 2;
    this.floor.y = floorY + 1500;
    this.leftWall!.x = -1500;
    this.rightWall!.x = width + 1500;
    this.leftWall!.y = this.rightWall!.y = floorY - 1000;
    if (moved) {
      // A scroll drags the floor through the heap; let it re-settle rather than
      // leaving bodies buried in (or hovering above) the new surface.
      for (const b of this.bodies) b.wake();
      if (this.bodies.length > 0) this.activeCache = true;
    }
  }

  add(body: Body): Body {
    if (this.bodies.length >= this.maxBodies) {
      // Retire the oldest *settled* chunk, so an explosion never deletes the
      // debris it just created. Falling back to index 0 keeps the cap hard.
      let victim = 0;
      let oldest = -1;
      for (let i = 0; i < this.bodies.length; i++) {
        const b = this.bodies[i];
        if (!b.awake && b.age > oldest) {
          oldest = b.age;
          victim = i;
        }
      }
      this.bodies.splice(victim, 1)[0]?.dispose();
    }
    this.bodies.push(body);
    this.broadphase.push(body);
    this.activeCache = true;
    return body;
  }

  clear() {
    for (const body of this.bodies) body.dispose();
    this.bodies.length = 0;
    this.broadphase.length = 0;
    this.activeCache = false;
  }

  get count() {
    return this.bodies.length;
  }

  /** Whether another simulation step can visibly change the heap. */
  get active() {
    return this.activeCache;
  }

  /** Radial blast: shove every body away from (x, y), waking the heap. */
  blast(x: number, y: number, radius: number, power: number) {
    if (this.bodies.length > 0) this.activeCache = true;
    for (const b of this.bodies) {
      const dx = b.x - x;
      const dy = b.y - y;
      const d = Math.hypot(dx, dy);
      if (d > radius + b.radius) continue;
      const falloff = 1 - Math.min(1, d / (radius + b.radius));
      const mag = (power * falloff * falloff) / Math.max(0.15, b.invMass ? 1 / b.invMass : 1);
      const inv = 1 / (d || 1);
      b.applyImpulse(dx * inv * mag, dy * inv * mag, b.x, b.y);
      b.av += (Math.random() - 0.5) * falloff * 18;
    }
  }

  /** Pull loose chunks toward a point without consuming them. */
  pull(x: number, y: number, radius: number, strength: number, dt: number): number {
    let affected = 0;
    for (const body of this.bodies) {
      const dx = x - body.x;
      const dy = y - body.y;
      const distance = Math.hypot(dx, dy) || 1;
      if (distance > radius + body.radius) continue;
      const falloff = 1 - Math.min(1, distance / (radius + body.radius));
      const acceleration = strength * (0.2 + falloff * 0.8);
      body.vx += (dx / distance) * acceleration * dt;
      body.vy += (dy / distance) * acceleration * dt - this.gravity * dt * falloff * 0.9;
      body.av += (Math.random() - 0.5) * falloff * dt * 8;
      body.wake();
      affected++;
    }
    if (affected > 0) this.activeCache = true;
    return affected;
  }

  /** Launch the closest loose chunk in a direction. */
  launchNearest(
    x: number,
    y: number,
    radius: number,
    dirX: number,
    dirY: number,
    speed: number,
  ): boolean {
    let nearest: Body | undefined;
    let nearestDistance = radius;
    for (const body of this.bodies) {
      const distance = Math.hypot(body.x - x, body.y - y);
      if (distance < nearestDistance) {
        nearest = body;
        nearestDistance = distance;
      }
    }
    if (!nearest) return false;
    const length = Math.hypot(dirX, dirY) || 1;
    nearest.vx = (dirX / length) * speed;
    nearest.vy = (dirY / length) * speed;
    nearest.av += (Math.random() - 0.5) * 14;
    nearest.wake();
    this.activeCache = true;
    return true;
  }

  /**
   * Drag every body toward (x, y) — the black hole's grip.
   *
   * Inverse-*linear*, not inverse-square. With a true 1/r² falloff there is no
   * strength that both moves the far side of the viewport and doesn't hurl
   * nearby debris at absurd speeds — at 600 px the old pull was under
   * 2 px/s² against 1750 px/s² of gravity, so the heap just sat there. 1/r
   * keeps the pull overwhelming near the horizon and still decisive across
   * the whole screen, which is what makes a held singularity *drain* the
   * wreckage instead of stirring it.
   *
   * Inside `eatRadius * 3` a capture funnel takes over: velocity is blended
   * straight toward the hole, so a chunk that has crossed the point of no
   * return spirals in and dies instead of slingshotting past forever.
   *
   * The returned list is scratch reused across calls — read it before calling
   * `attract` again. It is called every frame a singularity is open, and the
   * usual answer is "nothing was eaten"; allocating a fresh array per frame
   * for that is pure GC noise.
   */
  attract(x: number, y: number, strength: number, dt: number, eatRadius: number): Body[] {
    if (this.bodies.length > 0) this.activeCache = true;
    const eaten = this.eaten;
    eaten.length = 0;
    for (const b of this.bodies) {
      if (b.fixed) continue;
      const dx = x - b.x;
      const dy = y - b.y;
      const d = Math.hypot(dx, dy) || 1;
      if (d < eatRadius) {
        b.dead = true;
        eaten.push(b);
        continue;
      }
      if (d < eatRadius * 5) {
        // Capture funnel — the region where the hole has genuinely won. A body
        // in a settled heap cannot be *forced* out of it: the contact solver
        // and Coulomb friction cancel any acceleration the pile disagrees
        // with, which is exactly what pins wreckage to the floor. So a gripped
        // chunk stops being contactable at all (`ghost`, re-asserted each
        // frame) and rides a kinematic infall with a sideways swirl — ripped
        // out of the pile, spiralling in, and eaten.
        b.ghost = true;
        const k = Math.min(1, dt * 10);
        const infall = 600 + strength * 0.0006;
        b.vx += ((dx / d) * infall + (-dy / d) * infall * 0.35 - b.vx) * k;
        b.vy += ((dy / d) * infall + (dx / d) * infall * 0.35 - b.vy) * k;
        // Fully counter the gravity `step` is about to add: an infall that
        // sags downward reads as falling debris, not as being swallowed.
        b.vy -= this.gravity * dt;
        b.av += (Math.random() - 0.5) * 6 * dt * 60;
        b.wake();
        continue;
      }
      const pull = strength / Math.max(90, d);
      const a = pull * dt;
      // Beyond the funnel: an inverse-linear tug, plus enough lift to unweight
      // the pile so floor friction cannot simply absorb the pull.
      if (pull > 200) b.vy -= this.gravity * dt * Math.min(1, pull / 700);
      b.vx += (dx / d) * a;
      b.vy += (dy / d) * a;
      // Everything orbits a little before it falls in, which is the whole
      // visual point of a singularity rather than a vacuum cleaner.
      b.vx += (-dy / d) * a * 0.3;
      b.vy += (dx / d) * a * 0.3;
      b.av += (Math.random() - 0.5) * 2 * dt * 60;
      b.wake();
    }
    return eaten;
  }

  step(dt: number) {
    const bodies = this.bodies;
    this.impacts.length = 0;

    // Retire finished bodies (faded out, eaten, or fallen far past the floor).
    let write = 0;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      b.age += dt;
      if (b.age > b.ttl) b.alpha -= dt * 1.6;
      if (b.dead || b.alpha <= 0 || b.y > this.floorY + 2600) {
        b.dispose();
        continue;
      }
      bodies[write++] = b;
    }
    bodies.length = write;

    const statics = this.statics;
    for (const s of statics) s.sync();

    // 1 — integrate velocities.
    for (const b of bodies) {
      if (b.fixed || !b.awake) continue;
      b.vy += this.gravity * dt;
      // Light air drag: without it a tumbling chunk spins forever.
      const damp = 1 - Math.min(0.4, 0.22 * dt);
      b.vx *= damp;
      b.vy *= damp;
      b.av *= 1 - Math.min(0.5, 1.1 * dt);
      b.sync();
    }
    for (const b of bodies) if (!b.awake) b.sync();

    // 2 — broadphase + manifolds. Sweep tight world AABBs along x and stop as
    // soon as the next body's left edge clears the current right edge. This
    // produces the exact same SAT candidates as the old all-pairs circle test,
    // without visiting thousands of impossible pairs in a wide debris field.
    const manifolds = this.manifolds;
    let manifoldCount = 0;
    // The candidate list persists across steps (`add` appended any newcomers);
    // drop bodies retired above, then restore x-order with a stable insertion
    // sort. Bodies move a fraction of their extent per step, so the list is
    // near-sorted and the sort is O(n) plus a few swaps — versus rebuilding
    // and `.sort()`ing with a fresh comparator closure every frame. The order
    // matches the old stable `.sort((a, b) => a.minX - b.minX)` exactly: minX
    // keys only tie for chunks spawned along the same column edge, those enter
    // both lists in creation order, and insertion sort (strict `>`) never
    // reorders ties — so the narrowphase visits pairs identically and the
    // solver sees the same contacts in the same order.
    const broadphase = this.broadphase;
    let alive = 0;
    for (let i = 0; i < broadphase.length; i++) {
      const b = broadphase[i];
      if (!b.dead) broadphase[alive++] = b;
    }
    broadphase.length = alive;
    for (let i = 1; i < alive; i++) {
      const body = broadphase[i];
      const key = body.minX;
      let j = i - 1;
      while (j >= 0 && broadphase[j].minX > key) {
        broadphase[j + 1] = broadphase[j];
        j--;
      }
      broadphase[j + 1] = body;
    }
    for (let i = 0; i < broadphase.length; i++) {
      const a = broadphase[i];
      // Ghosts are mid-swallow: they collide with nothing on the way down.
      if (a.ghost) continue;
      for (let j = i + 1; j < broadphase.length; j++) {
        const b = broadphase[j];
        if (b.minX > a.maxX) break;
        if (b.ghost) continue;
        if (!a.awake && !b.awake) continue;
        if (b.maxY < a.minY || b.minY > a.maxY) continue;
        // Preserve the old circle reject inside the much smaller sweep window;
        // it is especially effective for rotated shards whose AABBs meet only
        // at opposite corners.
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const reach = a.radius + b.radius;
        if (dx * dx + dy * dy > reach * reach) continue;
        const m = manifolds[manifoldCount] ?? (manifolds[manifoldCount] = createManifold(a, b));
        if (collide(a, b, m)) {
          manifoldCount++;
          // Anything touching a moving body joins the simulation again.
          a.wake();
          b.wake();
        }
      }
      for (const s of statics) {
        if (!a.awake) continue;
        if (a.maxX < s.minX || a.minX > s.maxX || a.maxY < s.minY || a.minY > s.maxY) continue;
        const m = manifolds[manifoldCount] ?? (manifolds[manifoldCount] = createManifold(a, s));
        if (collide(a, s, m)) manifoldCount++;
      }
    }
    // 3 — prepare contacts: effective masses and the restitution target. Both
    // are captured from pre-impulse velocities, so a bounce doesn't compound.
    for (let mi = 0; mi < manifoldCount; mi++) {
      const m = manifolds[mi];
      const { a, b, nx, ny } = m;
      const tx = -ny;
      const ty = nx;
      for (let pi = 0; pi < m.pointCount; pi++) {
        const p = m.points[pi];
        const rax = p.px - a.x;
        const ray = p.py - a.y;
        const rbx = p.px - b.x;
        const rby = p.py - b.y;
        const rnA = rax * ny - ray * nx;
        const rnB = rbx * ny - rby * nx;
        p.mn = 1 / (a.invMass + b.invMass + a.invInertia * rnA * rnA + b.invInertia * rnB * rnB);
        const rtA = rax * ty - ray * tx;
        const rtB = rbx * ty - rby * tx;
        p.mt = 1 / (a.invMass + b.invMass + a.invInertia * rtA * rtA + b.invInertia * rtB * rtB);
        const rvx = b.vx - b.av * rby - (a.vx - a.av * ray);
        const rvy = b.vy + b.av * rbx - (a.vy + a.av * rax);
        const rvn = rvx * nx + rvy * ny;
        // Only a real approach speed bounces; slow settling contacts must not,
        // or a heap breathes forever.
        p.bias = rvn < -55 ? m.restitution * rvn : 0;
        // A genuinely hard arrival kicks up dust. The threshold keeps resting
        // and settling contacts silent, and the cap bounds a mass landing to a
        // fixed handful of entries rather than one per chunk.
        if (rvn < -260 && this.impacts.length < 24) this.impacts.push(p.px, p.py, -rvn);
        p.pn = 0;
        p.pt = 0;
      }
    }

    // 4 — solve velocity constraints.
    for (let it = 0; it < this.iterations; it++) {
      for (let mi = 0; mi < manifoldCount; mi++) {
        const m = manifolds[mi];
        const { a, b, nx, ny } = m;
        const tx = -ny;
        const ty = nx;
        for (let pi = 0; pi < m.pointCount; pi++) {
          const p = m.points[pi];
          const rax = p.px - a.x;
          const ray = p.py - a.y;
          const rbx = p.px - b.x;
          const rby = p.py - b.y;
          let rvx = b.vx - b.av * rby - (a.vx - a.av * ray);
          let rvy = b.vy + b.av * rbx - (a.vy + a.av * rax);

          // Normal: non-penetration, accumulated and clamped to be push-only.
          const rvn = rvx * nx + rvy * ny;
          let dPn = p.mn * -(rvn + p.bias);
          const oldPn = p.pn;
          p.pn = Math.max(0, oldPn + dPn);
          dPn = p.pn - oldPn;
          applyPair(a, b, nx * dPn, ny * dPn, rax, ray, rbx, rby);

          // Friction, clamped to the Coulomb cone of the normal impulse so far.
          rvx = b.vx - b.av * rby - (a.vx - a.av * ray);
          rvy = b.vy + b.av * rbx - (a.vy + a.av * rax);
          const rvt = rvx * tx + rvy * ty;
          let dPt = p.mt * -rvt;
          const maxPt = m.friction * p.pn;
          const oldPt = p.pt;
          p.pt = Math.max(-maxPt, Math.min(maxPt, oldPt + dPt));
          dPt = p.pt - oldPt;
          applyPair(a, b, tx * dPt, ty * dPt, rax, ray, rbx, rby);
        }
      }
    }

    // 5 — integrate positions.
    for (const b of bodies) {
      if (b.fixed || !b.awake) continue;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.angle += b.av * dt;
      if (b.angle > TAU || b.angle < -TAU) b.angle %= TAU;
      b.updateSleep(dt);
    }

    // 6 — positional correction. Velocity impulses alone leave stacks sunk into
    // each other; this pushes the residual overlap out without adding energy.
    for (let mi = 0; mi < manifoldCount; mi++) {
      const m = manifolds[mi];
      const { a, b, nx, ny } = m;
      const invSum = a.invMass + b.invMass;
      if (invSum <= 0) continue;
      let deepest = 0;
      for (let pi = 0; pi < m.pointCount; pi++) {
        const p = m.points[pi];
        if (p.sep < deepest) deepest = p.sep;
      }
      const correction = (Math.min(0, deepest + 0.6) * -0.42) / invSum;
      if (correction <= 0) continue;
      a.x -= nx * correction * a.invMass;
      a.y -= ny * correction * a.invMass;
      b.x += nx * correction * b.invMass;
      b.y += ny * correction * b.invMass;
    }

    // Ghosting lasts one step: whatever grips a body must re-assert it every
    // frame, so a released singularity leaves no permanently intangible debris.
    // The same walk settles the `active` cache from real post-step state.
    let active = false;
    for (const b of bodies) {
      b.ghost = false;
      if (b.awake || Number.isFinite(b.ttl)) active = true;
    }
    this.activeCache = active;
  }

  /**
   * Draw every body. Each carries an alpha-masked sprite of the page pixels it
   * was cut from, so this is one rotated blit per chunk — the same cost as a
   * particle, for something that behaves like an object.
   */
  render(ctx: CanvasRenderingContext2D, left: number, top: number, right: number, bottom: number) {
    // One matrix write per blit instead of save/translate/rotate/restore per
    // body: the caller's document-space transform is captured once and each
    // body's translate·rotate is composed against it by hand, so the canvas
    // state stack is never touched. `globalAlpha` is only written when it
    // changes — for a heap of fully opaque chunks that is a single write.
    const base = ctx.getTransform();
    const ba = base.a;
    const bb = base.b;
    const bc = base.c;
    const bd = base.d;
    const be = base.e;
    const bf = base.f;
    let alpha = -1;
    for (const b of this.bodies) {
      if (b.fixed || !b.sprite) continue;
      if (b.x + b.radius < left || b.x - b.radius > right) continue;
      if (b.y + b.radius < top || b.y - b.radius > bottom) continue;
      const a = Math.max(0, Math.min(1, b.alpha));
      if (a !== alpha) {
        ctx.globalAlpha = a;
        alpha = a;
      }
      const cos = Math.cos(b.angle);
      const sin = Math.sin(b.angle);
      const ma = ba * cos + bc * sin;
      const mb = bb * cos + bd * sin;
      const mc = bc * cos - ba * sin;
      const md = bd * cos - bb * sin;
      const dx = b.spriteX - b.spriteW / 2;
      const dy = b.spriteY - b.spriteH / 2;
      // Thickness: the underside drawn at a small *world-space* downward
      // offset, so the sliver that peeks past the face's silhouette always
      // hangs below regardless of how the chunk has rotated — which is where a
      // board's edge sits when seen from slightly above. Same rotation as the
      // face, so only the translation column differs between the two blits.
      if (b.sideSprite) {
        const sy = b.y + 3;
        ctx.setTransform(ma, mb, mc, md, ba * b.x + bc * sy + be, bb * b.x + bd * sy + bf);
        ctx.drawImage(b.sideSprite, dx, dy, b.spriteW, b.spriteH);
      }
      ctx.setTransform(ma, mb, mc, md, ba * b.x + bc * b.y + be, bb * b.x + bd * b.y + bf);
      ctx.drawImage(b.sprite, dx, dy, b.spriteW, b.spriteH);
    }
    ctx.setTransform(ba, bb, bc, bd, be, bf);
    ctx.globalAlpha = 1;
  }
}

/** Equal and opposite impulse on a contact pair. */
function applyPair(
  a: Body,
  b: Body,
  ix: number,
  iy: number,
  rax: number,
  ray: number,
  rbx: number,
  rby: number,
) {
  if (!a.fixed) {
    a.vx -= ix * a.invMass;
    a.vy -= iy * a.invMass;
    a.av -= (rax * iy - ray * ix) * a.invInertia;
  }
  if (!b.fixed) {
    b.vx += ix * b.invMass;
    b.vy += iy * b.invMass;
    b.av += (rbx * iy - rby * ix) * b.invInertia;
  }
}
