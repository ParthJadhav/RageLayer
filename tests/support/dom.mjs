/**
 * Browser environment for unit tests.
 *
 * happy-dom supplies the DOM; it has no rasterizer, so every `getContext("2d")`
 * is backed by a real skia surface from `@napi-rs/canvas`. That matters more
 * than it sounds: `OpacityMap` decides whether page material survives with
 * `isPointInPath`/`isPointInStroke`, `ContentLayer` punches holes with
 * `destination-out`, and `buildTextMask` reads pixels back. Stubbing those out
 * would leave the destruction pipeline asserting against fiction, so the tests
 * run on an actual Canvas2D implementation instead.
 *
 * WebGL is deliberately absent by default: it exercises the documented
 * software fallback, which is the path every unaccelerated visitor takes.
 * `enableWebGL()` lets an individual test opt in to a stub context.
 */

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createCanvas,
  DOMMatrix as SkiaDOMMatrix,
  Image as SkiaImage,
  ImageData as SkiaImageData,
  Path2D as SkiaPath2D,
} from "@napi-rs/canvas";

if (!globalThis.__ddDomRegistered) {
  globalThis.__ddDomRegistered = true;
  GlobalRegistrator.register({ url: "https://desktop-destroyer.test/" });
  installCanvas();
  installMissingGlobals();
}

/** Live skia surfaces, keyed by the happy-dom element that owns them. */
const surfaces = new WeakMap();

/** Contexts we handed out, so repeated `getContext("2d")` calls agree. */
const contexts = new WeakMap();

let webglFactory = null;

function surfaceFor(element) {
  let surface = surfaces.get(element);
  if (!surface) {
    const width = Math.max(1, Math.floor(Number(element.getAttribute("width")) || 300));
    const height = Math.max(1, Math.floor(Number(element.getAttribute("height")) || 150));
    surface = createCanvas(width, height);
    surfaces.set(element, surface);
  }
  return surface;
}

/**
 * Translate a happy-dom drawable into the skia object that can actually be
 * sampled. Canvases are the common case; images resolve to their decoded skia
 * bitmap when a test loaded one.
 */
function unwrap(value) {
  if (!value || typeof value !== "object") return value;
  if (surfaces.has(value)) return surfaces.get(value);
  if (value.__skiaImage) return value.__skiaImage;
  return value;
}

function installCanvas() {
  const proto = globalThis.HTMLCanvasElement.prototype;

  // Size lives on the attribute (so `outerHTML` and CSS selectors keep working)
  // and is mirrored onto skia, where assigning either dimension resets the
  // surface exactly as the platform does.
  for (const dimension of ["width", "height"]) {
    const fallback = dimension === "width" ? 300 : 150;
    Object.defineProperty(proto, dimension, {
      configurable: true,
      get() {
        const raw = Number(this.getAttribute(dimension));
        return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback;
      },
      set(value) {
        const next = Math.max(0, Math.floor(Number(value) || 0));
        this.setAttribute(dimension, String(next));
        const surface = surfaces.get(this);
        // skia rejects zero-sized surfaces; the engine uses `width = 0` purely
        // to release backing memory, so keep a 1px placeholder alive.
        if (surface) surface[dimension] = Math.max(1, next);
      },
    });
  }

  proto.getContext = function getContext(kind) {
    if (kind === "2d") {
      let ctx = contexts.get(this);
      if (!ctx) {
        ctx = wrapContext(surfaceFor(this).getContext("2d"), this);
        contexts.set(this, ctx);
      }
      return ctx;
    }
    if (kind === "webgl" || kind === "webgl2") return webglFactory?.(kind, this) ?? null;
    return null;
  };

  proto.toDataURL = function toDataURL(type) {
    return surfaceFor(this).toDataURL(type ?? "image/png");
  };

  proto.toBlob = function toBlob(callback, type) {
    const buffer = surfaceFor(this).toBuffer(type === "image/jpeg" ? "image/jpeg" : "image/png");
    // Match the platform's asynchronous contract so callers that await a
    // microtask boundary behave the same here as in a browser.
    queueMicrotask(() => callback(new Blob([buffer], { type: type ?? "image/png" })));
  };
}

/**
 * skia contexts expose the right drawing surface but report their own canvas
 * object and only accept skia drawables. The proxy re-points `.canvas` at the
 * owning DOM element and unwraps arguments on the handful of methods that take
 * one, so production code can keep passing `HTMLCanvasElement` around.
 */
function wrapContext(ctx, element) {
  const unwrapping = {
    drawImage: true,
    createPattern: true,
  };

  return new Proxy(ctx, {
    get(target, property, receiver) {
      if (property === "canvas") return element;
      if (property === "__skia") return target;
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (unwrapping[property]) {
        return (...args) => value.apply(target, args.map(unwrap));
      }
      return value.bind(target);
    },
    set(target, property, value) {
      // Styles can be gradients/patterns produced by this same context, which
      // are already skia objects; everything else passes through untouched.
      Reflect.set(target, property, value);
      return true;
    },
    has(target, property) {
      return property === "canvas" || Reflect.has(target, property);
    },
  });
}

function installMissingGlobals() {
  globalThis.Path2D = SkiaPath2D;
  globalThis.ImageData = SkiaImageData;
  if (!globalThis.DOMMatrix) globalThis.DOMMatrix = SkiaDOMMatrix;

  // happy-dom supplies a ResizeObserver, but it can never fire: nothing lays
  // out, so no box ever changes. Replace it with a recording version so tests
  // can drive the SPA-reflow path deliberately via `flushResizeObservers`.
  globalThis.ResizeObserver = class ResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.targets = new Set();
      observers.add(this);
    }
    observe(target) {
      this.targets.add(target);
    }
    unobserve(target) {
      this.targets.delete(target);
    }
    disconnect() {
      this.targets.clear();
      observers.delete(this);
    }
  };

  // Likewise for media queries: happy-dom answers from a fixed viewport, and
  // `prefers-reduced-motion` is a user preference tests need to set directly.
  const matchMedia = (query) => ({
    matches: mediaMatches.get(query) ?? false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  });
  globalThis.matchMedia = matchMedia;
  if (typeof globalThis.window === "object") globalThis.window.matchMedia = matchMedia;

  installComputedStyleDefaults();
}

/**
 * Browsers resolve every computed property through the UA cascade, so an
 * ordinary `<div>` reports `opacity: "1"` and `visibility: "visible"`.
 * happy-dom returns `""` for anything not explicitly set, which reads as
 * "fully transparent" to code that does `Number(style.opacity) < 0.06` — every
 * element would look invisible. Fill in the initial values a browser would
 * report, without overriding anything actually declared.
 */
const COMPUTED_DEFAULTS = {
  opacity: "1",
  visibility: "visible",
  display: "block",
  position: "static",
  backgroundColor: "rgba(0, 0, 0, 0)",
  backgroundImage: "none",
  borderTopWidth: "0px",
  borderRightWidth: "0px",
  borderBottomWidth: "0px",
  borderLeftWidth: "0px",
  boxShadow: "none",
  overflow: "visible",
  transform: "none",
};

function installComputedStyleDefaults() {
  const original = globalThis.window.getComputedStyle.bind(globalThis.window);
  const patched = (element, pseudo) => {
    const style = original(element, pseudo);
    return new Proxy(style, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (typeof value === "function") return value.bind(target);
        if (value === "" && property in COMPUTED_DEFAULTS) return COMPUTED_DEFAULTS[property];
        return value;
      },
    });
  };
  globalThis.window.getComputedStyle = patched;
  globalThis.getComputedStyle = patched;
}

const observers = new Set();
const mediaMatches = new Map();

/** Force a media query result, e.g. `prefers-reduced-motion`. */
export function setMediaMatch(query, matches) {
  mediaMatches.set(query, matches);
}

export function resetMediaMatches() {
  mediaMatches.clear();
}

/** Build a primary mouse-style pointer event at a viewport coordinate. */
export function pointerEvent(type, x, y, init = {}) {
  return new globalThis.PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    pointerId: 1,
    isPrimary: true,
    pointerType: "mouse",
    button: 0,
    buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1,
    ...init,
  });
}

/** Put the page back at the top-left, as a fresh document would be. */
export function resetScroll() {
  const window_ = globalThis.window;
  window_.scrollTo?.(0, 0);
  for (const property of ["scrollX", "scrollY", "pageXOffset", "pageYOffset"]) {
    Object.defineProperty(window_, property, { configurable: true, value: 0, writable: true });
  }
}

/** Fire every live ResizeObserver, as a browser would after a reflow. */
export function flushResizeObservers() {
  for (const observer of observers) {
    const entries = [...observer.targets].map((target) => ({
      target,
      contentRect: target.getBoundingClientRect?.() ?? { width: 0, height: 0 },
    }));
    if (entries.length > 0) observer.callback(entries, observer);
  }
}

/** Install a minimal WebGL stub so the accelerated branch can be entered. */
export function enableWebGL(factory) {
  webglFactory = factory ?? (() => null);
}

export function disableWebGL() {
  webglFactory = null;
}

/** Read pixels back from any canvas element the code under test produced. */
export function readPixels(canvas, x = 0, y = 0, width = canvas.width, height = canvas.height) {
  return surfaceFor(canvas).getContext("2d").getImageData(x, y, width, height).data;
}

/** Alpha of a single pixel, the quickest way to assert a hole was punched. */
export function alphaAt(canvas, x, y) {
  return readPixels(canvas, Math.floor(x), Math.floor(y), 1, 1)[3];
}

/** Decode a PNG data URL into something `drawImage` accepts. */
export function loadImage(dataUrl) {
  const image = new SkiaImage();
  image.src = Buffer.from(dataUrl.split(",")[1], "base64");
  return image;
}

/**
 * Give the document a real size. happy-dom performs no layout, so
 * `clientWidth`/`scrollHeight` are zero and the engine's `resize()` bails out
 * before allocating anything — every size-dependent behaviour would silently
 * no-op without this.
 */
export function setViewport(width = 1024, height = 768, documentHeight = height) {
  // Bun shares one happy-dom instance across test files, so scroll position
  // set by one file is still there in the next. Anything that converts
  // viewport coordinates to document coordinates — the whole capture geometry
  // path — silently shifts by the leftover offset.
  resetScroll();
  const html = globalThis.document.documentElement;
  for (const [property, value] of [
    ["clientWidth", width],
    ["clientHeight", height],
    ["scrollWidth", width],
    ["scrollHeight", documentHeight],
  ]) {
    Object.defineProperty(html, property, { configurable: true, get: () => value });
  }
  Object.defineProperty(globalThis.window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(globalThis.window, "innerHeight", { configurable: true, value: height });
  stubRect(html, { x: 0, y: 0, width, height: documentHeight });
  return { width, height, documentHeight };
}

/**
 * Count the listeners a block leaves attached to `window` and `document`.
 *
 * The engine's teardown contract is "leave nothing behind on globals", and
 * that is only observable by bracketing the registrations themselves.
 */
export function trackGlobalListeners() {
  const targets = [globalThis.window, globalThis.document];
  const originals = targets.map((target) => ({
    target,
    add: target.addEventListener,
    remove: target.removeEventListener,
  }));
  let outstanding = 0;

  for (const entry of originals) {
    entry.target.addEventListener = function (...args) {
      outstanding++;
      return entry.add.apply(this, args);
    };
    entry.target.removeEventListener = function (...args) {
      outstanding--;
      return entry.remove.apply(this, args);
    };
  }

  return {
    get outstanding() {
      return outstanding;
    },
    restore() {
      for (const entry of originals) {
        entry.target.addEventListener = entry.add;
        entry.target.removeEventListener = entry.remove;
      }
    },
  };
}

/** Give an element a fixed layout box; happy-dom reports zeroes otherwise. */
export function stubRect(element, rect) {
  const box = {
    x: rect.x ?? rect.left ?? 0,
    y: rect.y ?? rect.top ?? 0,
    width: rect.width ?? 0,
    height: rect.height ?? 0,
  };
  const full = {
    ...box,
    left: box.x,
    top: box.y,
    right: box.x + box.width,
    bottom: box.y + box.height,
    toJSON: () => full,
  };
  element.getBoundingClientRect = () => full;
  // Offset dimensions come from layout too, and code that tests for a
  // zero-size box (collapsed subtrees, empty portals) reads them rather than
  // the rect.
  Object.defineProperty(element, "offsetWidth", {
    configurable: true,
    get: () => Math.round(full.width),
  });
  Object.defineProperty(element, "offsetHeight", {
    configurable: true,
    get: () => Math.round(full.height),
  });
  return element;
}

/**
 * Paint a recognisable page into a canvas: fully opaque, so any transparent
 * pixel afterwards is damage the code under test caused.
 */
export function paintOpaque(canvas, color = "#3366cc") {
  const ctx = canvas.getContext("2d");
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
  return canvas;
}

/** A detached, pre-painted canvas of a known size. */
export function makeCanvas(width, height, color) {
  const canvas = globalThis.document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  if (color) paintOpaque(canvas, color);
  return canvas;
}
