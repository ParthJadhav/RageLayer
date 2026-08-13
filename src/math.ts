/**
 * The handful of numeric helpers the whole engine reaches for.
 *
 * Every one of these was previously re-declared in five to ten modules. They
 * are here not because the arithmetic is hard but because a constant with ten
 * definitions is ten places for one of them to drift.
 */

/** A full turn in radians. Canvas arcs are written in terms of it everywhere. */
export const TAU = Math.PI * 2;

/**
 * The one direction every drawn tool points: up and to the left, the way a
 * held tool reads in a screenshot. It is fixed rather than steered by pointer
 * motion — a nozzle that spins to chase the mouse turns the cursor into a
 * weathervane, and the tool's silhouette changes shape mid-stroke. Holding it
 * still also makes the drawn cursor match the baked toolbar icon exactly.
 *
 * A unit vector; directional effects (tracers, rockets, spray) read the same
 * one through `engine.toolAim`, so what fires stays collinear with the bore.
 */
export const REST_AIM_X = -0.55;
export const REST_AIM_Y = -0.835;

/** Uniform random in `[min, max)`. */
export function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Clamp to 0..1 — the range of every intensity, alpha and charge here. */
export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Clamp to an arbitrary range. */
export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * Fractional rate accumulator: emit `perSecond` events per second of `dt`,
 * carrying the remainder forward.
 *
 * Spawn rates are per *second*, but a frame is a fraction of one — rolling a
 * per-frame probability instead silently doubles the rate on a 120 Hz display,
 * which is exactly where the frame budget is already halved. Every jet, hose,
 * smoke column and drip in the codebase kept its own copy of the same three
 * lines plus a `…Debt` field; this is that pattern, once.
 *
 * Returns the new debt, which the caller stores back:
 *
 * ```ts
 * self.blobDebt = emit(self.blobDebt, dt, JET_BLOBS_PER_SECOND, () => spawnBlob());
 * ```
 */
export function emit(debt: number, dt: number, perSecond: number, spawn: () => void): number {
  const total = debt + dt * perSecond;
  const count = Math.floor(total);
  for (let i = 0; i < count; i++) spawn();
  return total - count;
}
