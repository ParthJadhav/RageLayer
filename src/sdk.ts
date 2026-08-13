import type { DestroyerEngineApi, Tool, ToolArtFn, ToolPointerEvent, Vec2 } from "./types";

export type { ToolIconBounds } from "./icon-bounds";
export { registerToolIconBounds } from "./icon-bounds";

export interface CustomToolDefinition<State> {
  id: string;
  name: string;
  icon: string;
  hint: string;
  cursor?: string;
  art?: ToolArtFn;
  createState(): State;
  onDown?(state: State, engine: DestroyerEngineApi, event: ToolPointerEvent): void;
  onMove?(state: State, engine: DestroyerEngineApi, event: ToolPointerEvent): void;
  onUp?(state: State, engine: DestroyerEngineApi, event: ToolPointerEvent): void;
  /** Advance the selected tool. `held` is true only during an active gesture. */
  tick?(state: State, engine: DestroyerEngineApi, dt: number, held: boolean, pointer: Vec2): void;
  /** Advance retained work after this tool is no longer selected. Pair with `hasPendingWork`. */
  backgroundTick?(state: State, engine: DestroyerEngineApi, dt: number): void;
  /** Cheap, side-effect-free predicate that keeps frames alive only while retained work exists. */
  hasPendingWork?(state: State, engine: DestroyerEngineApi): boolean;
  /** Finalize the old state before the factory replaces it with a fresh `createState()` result. */
  reset?(state: State): void;
}

/**
 * Build independent Tool instances from a typed stateful definition. Prefer
 * this factory when more than one engine may coexist on a page.
 */
export function defineTool<State>(definition: CustomToolDefinition<State>): () => Tool {
  if (!definition.id.trim()) throw new TypeError("Tool id must not be empty");
  if (!definition.name.trim()) throw new TypeError("Tool name must not be empty");
  return () => {
    let state = definition.createState();
    return {
      id: definition.id,
      name: definition.name,
      icon: definition.icon,
      hint: definition.hint,
      cursor: definition.cursor,
      art: definition.art,
      onDown: definition.onDown
        ? (engine, event) => definition.onDown?.(state, engine, event)
        : undefined,
      onMove: definition.onMove
        ? (engine, event) => definition.onMove?.(state, engine, event)
        : undefined,
      onUp: definition.onUp
        ? (engine, event) => definition.onUp?.(state, engine, event)
        : undefined,
      tick: definition.tick
        ? (engine, dt, held, pointer) => definition.tick?.(state, engine, dt, held, pointer)
        : undefined,
      backgroundTick: definition.backgroundTick
        ? (engine, dt) => definition.backgroundTick?.(state, engine, dt)
        : undefined,
      hasPendingWork: definition.hasPendingWork
        ? (engine) => definition.hasPendingWork?.(state, engine) ?? false
        : undefined,
      reset() {
        definition.reset?.(state);
        state = definition.createState();
      },
    };
  };
}

/** Create one Tool from a typed definition for the common single-engine case. */
export function createTool<State>(definition: CustomToolDefinition<State>): Tool {
  return defineTool(definition)();
}

export interface RateLimiter {
  /** Accumulate time and return how many fixed-rate actions may run now. */
  take(dt: number): number;
  reset(): void;
}

/** Bounded fractional scheduler for particle sprays and other hold-to-use effects. */
export function createRateLimiter(ratePerSecond: number, maxBurst = 8): RateLimiter {
  const rate = Math.max(0, ratePerSecond);
  const limit = Math.max(1, Math.round(maxBurst));
  let debt = 0;
  return {
    take(dt) {
      debt = Math.min(limit, debt + Math.max(0, dt) * rate);
      const count = Math.floor(debt);
      debt -= count;
      return count;
    },
    reset() {
      debt = 0;
    },
  };
}
