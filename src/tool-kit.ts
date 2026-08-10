/**
 * Shared building blocks for the built-in tools.
 *
 * Three things every second tool wants and nobody should re-derive: a scatter
 * of solid chips, a puff of pale page dust, and a smoothed aim direction taken
 * from pointer motion. Internal to the package — tool authors outside it use
 * `engine.spawnParticle` directly, or the `sdk` entry point.
 */

import { TAU } from "./math";
import type { DestroyerEngineApi, Vec2 } from "./types";

export function debris(
  engine: DestroyerEngineApi,
  x: number,
  y: number,
  count: number,
  color?: string,
) {
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
export function dustPuff(
  engine: DestroyerEngineApi,
  x: number,
  y: number,
  count: number,
  spread: number,
  force = 1,
) {
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
export function makeAim(defaultX: number, defaultY: number) {
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
    /** Full reset for `Tool.reset`: forget the direction as well. */
    hardReset() {
      this.x = defaultX;
      this.y = defaultY;
      this.reset();
    },
  };
}
