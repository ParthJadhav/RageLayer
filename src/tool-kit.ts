/**
 * Shared building blocks for the built-in tools.
 *
 * The things every second tool wants and nobody should re-derive: retained
 * per-engine state, a scatter of solid chips, and a puff of pale page dust.
 * Internal to the package — tool authors outside it use `engine.spawnParticle`
 * directly, or the `sdk` entry point. Anything that needs a direction reads
 * `engine.toolAim`, so the whole package points one way.
 */

import { TAU } from "./math";
import type { DestroyerEngineApi } from "./types";

/**
 * Retained tool state keyed by engine.
 *
 * Built-in tools are exported as shared singletons, so module-level cooldowns
 * or projectile arrays let one mounted layer advance or clear another one's
 * work. This tiny store gives singleton tools instance semantics without
 * exposing state on the public `Tool` object or retaining disposed engines.
 */
export function createEngineState<T>(create: () => T) {
  let states = new WeakMap<DestroyerEngineApi, T>();
  return {
    get(engine: DestroyerEngineApi): T {
      let state = states.get(engine);
      if (state === undefined) {
        state = create();
        states.set(engine, state);
      }
      return state;
    },
    /** Read existing state without allocating it solely for an idle-work check. */
    peek(engine: DestroyerEngineApi): T | undefined {
      return states.get(engine);
    },
    reset(engine?: DestroyerEngineApi) {
      if (engine) states.delete(engine);
      else states = new WeakMap();
    },
  };
}

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
