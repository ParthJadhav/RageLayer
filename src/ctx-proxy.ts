/**
 * The two `CanvasRenderingContext2D` proxies the engine hands to tools.
 *
 * Tools draw decals imperatively through a plain 2D context —
 * `drawCrack(engine.surfaceCtx, …)` — so anything the engine wants to happen
 * around those draws has to happen at the context level, or every tool
 * (including third-party ones) would have to opt in.
 *
 * Both proxies rewrite one thing. Decals hard-code `source-atop`: a mark is
 * damage to the page, so it can only exist where page pixels do (decals.ts).
 * Two targets have no page pixels — the overlay damage canvas over an intact
 * DOM, and live mode's transparent decals buffer — and atop against those
 * would draw nothing. The clip the tool asked for still happens: for the
 * overlay there is no void to respect, and for the decals buffer `recompose`
 * applies it once to the whole layer.
 */

type Ctx = CanvasRenderingContext2D;

/** `source-atop` is meaningless on a transparent target; see the module note. */
function withoutAtop(prop: string | symbol, value: unknown): unknown {
  return prop === "globalCompositeOperation" && value === "source-atop" ? "source-over" : value;
}

/**
 * Proxy `target`, deriving each method once and routing property writes.
 *
 * Context methods are stable, so `method` is consulted a single time per
 * property and the result cached. Deriving inside the `get` trap allocated a
 * fresh closure per property access, and decal-heavy tools touch the context
 * hundreds of times a frame.
 */
function proxyContext(
  target: Ctx,
  method: (bound: (...args: unknown[]) => unknown, prop: string | symbol) => unknown,
  assign: (prop: string | symbol, value: unknown) => void,
): Ctx {
  const derived = new Map<string | symbol, unknown>();
  return new Proxy(target, {
    get(object, prop) {
      const cached = derived.get(prop);
      if (cached !== undefined) return cached;
      const value = Reflect.get(object, prop);
      if (typeof value !== "function") return value;
      const fn = method(value.bind(object), prop);
      derived.set(prop, fn);
      return fn;
    },
    set(_object, prop, value) {
      assign(prop, value);
      return true;
    },
  });
}

/** Wrap a context so `source-atop` degrades to plain drawing. */
export function atopAsOver(ctx: Ctx): Ctx {
  return proxyContext(
    ctx,
    (bound) => bound,
    (prop, value) => {
      Reflect.set(ctx, prop, withoutAtop(prop, value));
    },
  );
}

/**
 * Members that read rather than draw. The tee mirrors everything else into the
 * decals buffer; running these twice would only burn time (and `getImageData`
 * on a document-sized buffer burns a lot of it).
 */
const READ_ONLY = new Set([
  "getImageData",
  "createImageData",
  "measureText",
  "isPointInPath",
  "isPointInStroke",
  "getTransform",
  "getLineDash",
  "getContextAttributes",
  "createLinearGradient",
  "createRadialGradient",
  "createConicGradient",
  "createPattern",
]);

/**
 * A context that draws to two canvases at once: the visible surface (immediate
 * feedback) and the decals buffer (what survives a live-mode base refresh).
 *
 * Without this, anything that only reaches the visible canvas in live mode is
 * erased by the next `recompose()`. Mirroring at the context level keeps every
 * tool persistent without changing how a single one of them draws.
 */
export function teeContexts(visible: Ctx, decals: Ctx): Ctx {
  return proxyContext(
    visible,
    (bound, prop) => {
      if (READ_ONLY.has(prop as string)) return bound;
      return (...args: unknown[]) => {
        const result = bound(...args);
        const twin = Reflect.get(decals, prop);
        if (typeof twin === "function") {
          try {
            twin.apply(decals, args);
          } catch {
            // A decals-side failure must never break the visible draw.
          }
        }
        return result;
      };
    },
    (prop, value) => {
      Reflect.set(visible, prop, value);
      try {
        Reflect.set(decals, prop, withoutAtop(prop, value));
      } catch {
        // see above
      }
    },
  );
}
