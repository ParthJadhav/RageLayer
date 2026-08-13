/**
 * BugSwarm — the infestation.
 *
 * Bugs live at engine level, like flames, so a swarm keeps gnawing while the
 * user switches tools to fight it. And fight back they can: fire burns a bug,
 * water washes it off, and every blast, fracture or black hole takes whatever
 * was underneath.
 *
 * The swarm owns its population, its stepping and its drawing, and reaches the
 * rest of the engine through the narrow `BugHost` slice below — every member of
 * which is already public engine API.
 */

import { TAU } from "./math";
import type { ContentApi, Flame, Particle, SoundApi } from "./types";

/** Population cap. */
const MAX_BUGS = 36;

/** One crawling bug: position, heading, and an appetite timer. */
interface BugState {
  x: number;
  y: number;
  /** Heading, radians. */
  a: number;
  speed: number;
  size: number;
  ttl: number;
  /** Countdown to the next bite taken out of the page. */
  chew: number;
  /** Countdown to the next deliberate change of direction. */
  turn: number;
  seed: number;
}

/** The slice of the engine an infestation touches. */
export interface BugHost {
  readonly width: number;
  readonly height: number;
  readonly flames: readonly Flame[];
  readonly surfaceCtx: CanvasRenderingContext2D;
  readonly content: ContentApi | null;
  readonly sound: SoundApi;
  onPage(x: number, y: number, threshold?: number): boolean;
  pageOpacityAt(x: number, y: number): number;
  spawnParticle(p: Particle): void;
  markSurface(x: number, y: number, radius: number): void;
}

export class BugSwarm {
  private readonly bugs: BugState[] = [];

  get count(): number {
    return this.bugs.length;
  }

  clear() {
    this.bugs.length = 0;
  }

  /**
   * Remove every bug inside a radius without ceremony — no smear, no smoke;
   * nothing comes back out of a black hole.
   */
  vanish(x: number, y: number, radius: number) {
    const r2 = radius * radius;
    for (let i = this.bugs.length - 1; i >= 0; i--) {
      const b = this.bugs[i];
      const dx = b.x - x;
      const dy = b.y - y;
      if (dx * dx + dy * dy < r2) this.bugs.splice(i, 1);
    }
  }

  /** Returns true when at least one bug was actually released. */
  spawn(host: BugHost, x: number, y: number, count = 1): boolean {
    // A bug needs page to stand on. Released over the void it has nothing to
    // crawl across or eat — so nothing is released, and nothing chirps.
    if (!host.onPage(x, y, 0.5)) return false;
    const before = this.bugs.length;
    for (let i = 0; i < count && this.bugs.length < MAX_BUGS; i++) {
      this.bugs.push({
        x: x + (Math.random() - 0.5) * 18,
        y: y + (Math.random() - 0.5) * 18,
        a: Math.random() * TAU,
        speed: 26 + Math.random() * 38,
        size: 3 + Math.random() * 2.2,
        ttl: 25 + Math.random() * 30,
        chew: Math.random() * 0.2,
        turn: Math.random() * 1.5,
        seed: Math.random() * TAU,
      });
    }
    // At the population cap nothing was released — so nothing chirps either.
    if (this.bugs.length === before) return false;
    host.sound.pop();
    return true;
  }

  squash(host: BugHost, x: number, y: number, radius: number): number {
    let squashed = 0;
    const r2 = radius * radius;
    for (let i = this.bugs.length - 1; i >= 0; i--) {
      const b = this.bugs[i];
      const dx = b.x - x;
      const dy = b.y - y;
      if (dx * dx + dy * dy > r2) continue;
      this.bugs.splice(i, 1);
      squashed++;
      // The smear a squashed bug leaves. Drawn through surfaceCtx so it
      // persists like any other decal.
      const ctx = host.surfaceCtx;
      ctx.save();
      // The smear is on the page, so it clips to the page — a bug squashed at
      // a hole's rim leaves its mark on the rim, not floating in the void.
      ctx.globalCompositeOperation = "source-atop";
      ctx.fillStyle = "rgba(58, 44, 26, 0.85)";
      for (let s = 0; s < 4; s++) {
        const a = Math.random() * TAU;
        const d = Math.random() * b.size * 1.6;
        ctx.beginPath();
        ctx.ellipse(
          b.x + Math.cos(a) * d,
          b.y + Math.sin(a) * d,
          b.size * (0.5 + Math.random() * 0.7),
          b.size * (0.3 + Math.random() * 0.4),
          Math.random() * TAU,
          0,
          TAU,
        );
        ctx.fill();
      }
      ctx.restore();
      host.markSurface(b.x, b.y, b.size * 4);
    }
    if (squashed > 0) host.sound.splat();
    return squashed;
  }

  /**
   * Bugs carried off the page by a jet of water. Unlike `squashBugs` there is
   * no smear — nothing was crushed — the bug tumbles away on the spray,
   * washed off the page rather than into it.
   */
  flush(host: BugHost, x: number, y: number, radius: number): number {
    let flushed = 0;
    const r2 = radius * radius;
    for (let i = this.bugs.length - 1; i >= 0; i--) {
      const b = this.bugs[i];
      const dx = b.x - x;
      const dy = b.y - y;
      if (dx * dx + dy * dy > r2) continue;
      this.bugs.splice(i, 1);
      flushed++;
      // The bug itself, tumbling downstream and off the heap...
      host.spawnParticle({
        kind: "debris",
        x: b.x,
        y: b.y,
        vx: dx * 5 + (Math.random() - 0.5) * 90,
        vy: 60 + Math.random() * 140,
        life: 0,
        maxLife: 0.9 + Math.random() * 0.5,
        size: b.size,
        color: "#3a2c1a",
        angle: Math.random() * TAU,
        spin: (Math.random() - 0.5) * 24,
        bounce: 0.2,
        restY: b.y + 180 + Math.random() * 220,
      });
      // ...in a burst of the water that took it.
      for (let s = 0; s < 5; s++) {
        const a = Math.random() * TAU;
        host.spawnParticle({
          kind: "water",
          x: b.x,
          y: b.y,
          vx: Math.cos(a) * (60 + Math.random() * 120),
          vy: Math.sin(a) * (60 + Math.random() * 120) - 40,
          life: 0,
          maxLife: 0.3 + Math.random() * 0.25,
          size: 2 + Math.random() * 2,
          gravity: 700,
          drag: 1.1,
        });
      }
    }
    return flushed;
  }

  /**
   * Bugs wander and eat. They live at engine level — like flames — so an
   * infestation keeps gnawing while the user switches tools to fight it.
   * And fight back they can: fire burns a bug that wanders into it, and every
   * blast or fracture squashes whatever was underneath (see `explode`/`fracture`).
   */
  step(host: BugHost, dt: number): number {
    let chewed = 0;
    for (let i = this.bugs.length - 1; i >= 0; i--) {
      const b = this.bugs[i];
      // Fire kills: a bug that wanders into a burning region goes up with a
      // wisp of smoke and a tiny scorch, no smear — it burned, it wasn't hit.
      let burned = false;
      for (const f of host.flames) {
        const dx = f.x - b.x;
        const dy = f.y - b.y;
        if (f.intensity > 0.2 && dx * dx + dy * dy < f.radius * f.radius) {
          burned = true;
          break;
        }
      }
      if (burned) {
        host.content?.char(b.x, b.y, b.size * 2.5, 0.3);
        host.markSurface(b.x, b.y, b.size * 4);
        host.spawnParticle({
          kind: "smoke",
          x: b.x,
          y: b.y,
          vx: (Math.random() - 0.5) * 20,
          vy: -40 - Math.random() * 30,
          life: 0,
          maxLife: 0.8 + Math.random() * 0.5,
          size: 5 + Math.random() * 4,
          drag: 1.4,
        });
        this.bugs.splice(i, 1);
        continue;
      }
      b.ttl -= dt;
      if (b.ttl <= 0) {
        // Burrows away with a puff rather than blinking out.
        host.spawnParticle({
          kind: "dust",
          x: b.x,
          y: b.y,
          vx: 0,
          vy: -12,
          life: 0,
          maxLife: 0.5,
          size: 4,
        });
        this.bugs.splice(i, 1);
        continue;
      }
      // Skittering: constant jitter plus an occasional decisive turn.
      b.turn -= dt;
      if (b.turn <= 0) {
        b.turn = 0.5 + Math.random() * 1.6;
        b.a += (Math.random() - 0.5) * 2.4;
      }
      b.a += (Math.random() - 0.5) * 3.4 * dt;
      b.x += Math.cos(b.a) * b.speed * dt;
      b.y += Math.sin(b.a) * b.speed * dt;
      // Turn back at the page edge instead of wandering into the void.
      if (b.x < 4 || b.x > host.width - 4 || b.y < 4 || b.y > host.height - 4) {
        b.a += Math.PI;
        b.x = Math.max(4, Math.min(host.width - 4, b.x));
        b.y = Math.max(4, Math.min(host.height - 4, b.y));
      }
      // Chewing: a small bite out of the page every fraction of a second, which
      // over a wander becomes the classic gnawed-trail look. The same timer
      // doubles as the hole check — a bug at the rim of a hole turns back onto
      // solid page, because it eats the site and the void has nothing to eat.
      b.chew -= dt;
      const content = host.content;
      if (b.chew <= 0 && content?.ready) {
        b.chew = 0.09 + Math.random() * 0.16;
        if (host.pageOpacityAt(b.x, b.y) < 0.5) {
          b.a += Math.PI + (Math.random() - 0.5);
        } else {
          content.burn(b.x, b.y, 1.6 + Math.random() * 1.8);
          chewed += 0.0001;
        }
      }
    }
    return chewed;
  }

  /** Draw the bugs into the fx layer: dark segmented body, animated legs. */
  render(ctx: CanvasRenderingContext2D, top: number, bottom: number, time: number) {
    for (const b of this.bugs) {
      if (b.y < top - 20 || b.y > bottom + 20) continue;
      const wiggle = Math.sin(time * 22 + b.seed) * 0.35;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.a + wiggle * 0.2);
      // Legs first, three per side, alternating with the gait.
      ctx.strokeStyle = "rgba(20, 14, 8, 0.9)";
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      for (let l = -1; l <= 1; l++) {
        const phase = Math.sin(time * 22 + b.seed + l * 2.1);
        const lx = l * b.size * 0.55;
        ctx.moveTo(lx, 0);
        ctx.lineTo(lx + phase * b.size * 0.4, b.size * 0.9);
        ctx.moveTo(lx, 0);
        ctx.lineTo(lx - phase * b.size * 0.4, -b.size * 0.9);
      }
      ctx.stroke();
      // Two body segments and a head.
      ctx.fillStyle = "rgba(38, 26, 14, 0.95)";
      ctx.beginPath();
      ctx.ellipse(-b.size * 0.35, 0, b.size * 0.62, b.size * 0.45, 0, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(b.size * 0.4, 0, b.size * 0.45, b.size * 0.36, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = "rgba(58, 40, 20, 0.95)";
      ctx.beginPath();
      ctx.arc(b.size * 0.85, 0, b.size * 0.24, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
  }
}
