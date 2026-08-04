/**
 * LiveContentSource — page capture via Chrome's experimental HTML-in-Canvas API
 * (`CanvasRenderingContext2D.drawElementImage`, behind
 * `chrome://flags/#canvas-draw-element`).
 *
 * See HTML-IN-CANVAS.md for the research this is built on. The short version:
 *
 * `drawElementImage()` only accepts an element that is an *immediate child of a
 * `<canvas layoutsubtree>`* and that generated boxes in the previous rendering
 * update. There is no way to point it at the live page, so we mirror a pruned
 * clone of the capture root into a host canvas and draw that. What the API buys
 * us is not live DOM — it is speed: ~6 ms per capture versus 0.5–2 s for the
 * html-to-image path, which is cheap enough to re-capture roughly once a second
 * and keep the page ticking underneath the destruction.
 *
 * Two non-obvious things this file has to do, both measured:
 *
 * - **Freeze animations.** A fresh clone restarts CSS animations from t=0, so
 *   anything mid- or post-animation (a faded-in hero) captures wrong or blank.
 *   `freezeAnimations` copies the live element's current computed values for
 *   every animated property onto its twin with `!important`, which outranks CSS
 *   animations in the cascade.
 * - **Keep the host canvas painted.** Chrome drops the paint record for a
 *   subtree whose canvas isn't being painted, so `opacity: 0`, off-screen
 *   offsets and `clip-path: inset(100%)` all silently capture nothing. The host
 *   sits at `opacity: 0.005` behind every other layer instead.
 */

import { DD_IGNORE_ATTR, type PageBackdrop } from "./capture";

/** Shape of the experimental 2D-context method we depend on. */
type DrawElementImageCtx = CanvasRenderingContext2D & {
  drawElementImage(element: Element, dx: number, dy: number): DOMMatrix;
};

/**
 * Is Chrome's HTML-in-Canvas API present?
 *
 * Note the name: the proposal was renamed from `drawElement` to
 * `drawElementImage`, and only the latter exists in shipping Chrome (verified
 * on 149). Detecting `drawElement` would report false on every browser that
 * actually has the feature.
 */
export function supportsLiveCapture(): boolean {
  return (
    typeof CanvasRenderingContext2D !== "undefined" &&
    typeof (CanvasRenderingContext2D.prototype as Partial<DrawElementImageCtx>).drawElementImage ===
      "function"
  );
}

/** Properties that appear in keyframe objects but aren't CSS properties. */
const NON_CSS_KEYFRAME_KEYS = new Set(["offset", "computedOffset", "easing", "composite"]);
const CAMEL = /[A-Z]/g;

function kebab(prop: string) {
  return prop.replace(CAMEL, (m) => `-${m.toLowerCase()}`);
}

/**
 * Child-index path from `root` down to `el`, or null if `el` isn't a
 * descendant. Indices are into `childNodes` (not `children`) so the path stays
 * valid for a `cloneNode(true)` twin, which preserves text nodes and comments.
 */
function pathTo(root: Node, el: Node): number[] | null {
  const path: number[] = [];
  let node: Node | null = el;
  while (node && node !== root) {
    const parent: Node | null = node.parentNode;
    if (!parent) return null;
    path.push(Array.prototype.indexOf.call(parent.childNodes, node));
    node = parent;
  }
  return node === root ? path.reverse() : null;
}

function nodeAt(root: Node, path: number[]): Node | null {
  let node: Node | null = root;
  for (const i of path) {
    node = node?.childNodes[i] ?? null;
    if (!node) return null;
  }
  return node;
}

/**
 * Pin every animated property to the value the *live* element currently shows.
 *
 * Without this the clone replays each animation from its start, so a page whose
 * content fades in on load captures as a blank page. Written with `!important`
 * because CSS animations outrank ordinary declarations — including inline ones.
 */
function freezeAnimations(root: HTMLElement, clone: HTMLElement) {
  let animations: Animation[];
  try {
    animations = root.getAnimations({ subtree: true });
  } catch {
    return; // getAnimations is well supported, but never break capture over it
  }
  for (const animation of animations) {
    // Only KeyframeEffect carries a target and keyframes; CSSAnimation and
    // CSSTransition both use it, which is everything we care about.
    const effect = animation.effect;
    if (!(effect instanceof KeyframeEffect)) continue;
    const target = effect.target;
    if (!target || target === root || !(target instanceof Element)) continue;
    const path = pathTo(root, target);
    if (!path) continue;
    const twin = nodeAt(clone, path);
    if (!(twin instanceof HTMLElement)) continue;

    const props = new Set<string>();
    for (const frame of effect.getKeyframes()) {
      for (const key of Object.keys(frame)) {
        if (!NON_CSS_KEYFRAME_KEYS.has(key)) props.add(kebab(key));
      }
    }
    if (props.size === 0) continue;

    const computed = getComputedStyle(target);
    for (const prop of props) {
      const value = computed.getPropertyValue(prop);
      if (value) twin.style.setProperty(prop, value, "important");
    }
    // Stop the clone's own copy of the animation from overriding the pin on the
    // next frame, and kill transitions so nothing eases away from it either.
    twin.style.setProperty("animation-name", "none", "important");
    twin.style.setProperty("transition", "none", "important");
  }
}

/**
 * Drop from the clone everything `filter` rejects — the destroyer's own overlay
 * and toolbar, framework dev tooling, anything the host excluded. This is the
 * clone-path equivalent of the `filter` option we hand to html-to-image, so
 * both capture modes honour the same `captureFilter`.
 */
function prune(el: Element, filter: (node: HTMLElement) => boolean) {
  for (const child of Array.from(el.children)) {
    if (child instanceof HTMLElement && !filter(child)) child.remove();
    else prune(child, filter);
  }
}

export interface LiveCaptureOptions {
  /** Where the root's border box sits in the layer, in CSS px. */
  source: { x: number; y: number; width: number; height: number };
  rootSize?: { width: string; height: string };
  backdrop?: PageBackdrop;
  filter: (node: HTMLElement) => boolean;
}

/**
 * Owns the offscreen `<canvas layoutsubtree>` mirror and turns the live DOM
 * into a fresh raster on demand. Stateless with respect to destruction — the
 * caller composites wounds back on top.
 */
export class LiveContentSource {
  private host: HTMLCanvasElement | null = null;
  private ctx: DrawElementImageCtx | null = null;
  private mounted: HTMLElement | null = null;
  private disposed = false;

  /**
   * Raster `root` at `dpr` into a canvas sized `width`×`height` CSS px.
   * Resolves with the canvas, or rejects if the experimental API refuses.
   */
  async capture(
    root: HTMLElement,
    width: number,
    height: number,
    dpr: number,
    options: LiveCaptureOptions,
  ): Promise<HTMLCanvasElement> {
    if (!supportsLiveCapture()) throw new Error("drawElementImage is unavailable");
    const host = this.ensureHost(width, height, dpr);
    const ctx = this.ctx!;

    // Clone first, then freeze, then prune: freezing walks child-index paths
    // from the live tree, so it has to run while the clone is still structurally
    // identical to it.
    //
    // Note what is *not* done here: the snapshot path re-anchors `position:
    // fixed` boxes to the document (`pinFixedDescendants`) so they capture where
    // the user sees them, and this path deliberately does not. Measured on
    // Chrome 149: moving a full-page `fixed inset(0)` overlay off the region it
    // used to cover makes `drawElementImage` silently drop the *other* content
    // there — the hero paragraph and every finished fade-in element vanish from
    // the raster while remaining `opacity: 1` in the clone's own DOM. Correcting
    // where a nav sits is not worth losing page content, so live mode keeps the
    // known caveat that viewport-anchored chrome captures at its document
    // position. See HTML-IN-CANVAS.md.
    const clone = root.cloneNode(true) as HTMLElement;
    freezeAnimations(root, clone);
    prune(clone, options.filter);

    // The engine hides the real root with `visibility: hidden` in content mode,
    // and cloneNode copies that inline style along with everything else.
    clone.style.visibility = "visible";
    if (options.rootSize) {
      clone.style.width = options.rootSize.width;
      clone.style.height = options.rootSize.height;
    } else {
      clone.style.width = `${options.source.width}px`;
    }
    if (options.backdrop?.image) Object.assign(clone.style, options.backdrop.image);

    if (this.mounted) host.replaceChild(clone, this.mounted);
    else host.appendChild(clone);
    this.mounted = clone;

    // `drawElementImage` needs the element to have generated boxes in the
    // *previous* rendering update — drawing in the same task throws
    // InvalidStateError ("No cached paint record for element"). Two frames is
    // one to lay the clone out and one to be safely past that update.
    await nextFrame();
    await nextFrame();
    if (this.disposed) throw new Error("disposed during capture");

    // Everything below is in *device* pixels, under an identity transform.
    //
    // `drawElementImage` does its own device-scaling: it rasterizes the element
    // at the host canvas's backing-store-to-CSS-size ratio, which is already
    // `dpr` here, and only then applies the CTM. Measured in Chrome 149 — a
    // 100x50 CSS element in a 300x200 CSS / 600x400 backing canvas comes out
    // 200x100 device px under an identity transform, and 400x200 under
    // `setTransform(2,…)`. So a dpr transform doesn't scale the raster to the
    // backing store, it double-scales it: exactly `dpr`x too big, which is
    // invisible on a 1x display and a 2x zoom on a retina one.
    //
    // The destination coordinates are in the current user space, so with the
    // transform gone they are device pixels too. Rounding them keeps the
    // raster on the pixel grid, matching the snapshot path's blit.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, host.width, host.height);
    // The page backdrop lives on the viewport canvas, not inside the root's own
    // box (CSS background propagation), so a bare draw comes out transparent.
    if (options.backdrop?.color) {
      ctx.fillStyle = options.backdrop.color;
      ctx.fillRect(0, 0, host.width, host.height);
    }
    ctx.drawElementImage(
      clone,
      Math.round(options.source.x * dpr),
      Math.round(options.source.y * dpr),
    );

    // Hand back a detached copy: the host canvas is reused by the next refresh,
    // and the caller keeps this one as its pristine base.
    const out = document.createElement("canvas");
    out.width = host.width;
    out.height = host.height;
    out.getContext("2d")!.drawImage(host, 0, 0);
    return out;
  }

  private ensureHost(width: number, height: number, dpr: number): HTMLCanvasElement {
    let host = this.host;
    if (!host) {
      host = document.createElement("canvas");
      host.setAttribute("layoutsubtree", "");
      host.setAttribute(DD_IGNORE_ATTR, "");
      Object.assign(host.style, {
        position: "fixed",
        left: "0",
        top: "0",
        pointerEvents: "none",
        // NOT `opacity: 0` / off-screen / clipped: Chrome discards the paint
        // record for a canvas subtree it isn't painting, and every one of those
        // produces a silently empty capture. 0.5% alpha behind every other
        // layer is invisible and keeps the record alive. See HTML-IN-CANVAS.md.
        opacity: "0.005",
        zIndex: "-2147483000",
      } satisfies Partial<CSSStyleDeclaration>);
      // Mounted on <html> rather than <body> so it can't end up inside the
      // subtree we clone (which would recurse a copy of the mirror into itself).
      document.documentElement.appendChild(host);
      this.host = host;
      this.ctx = host.getContext("2d") as DrawElementImageCtx;
    }
    const pw = Math.round(width * dpr);
    const ph = Math.round(height * dpr);
    if (host.width !== pw || host.height !== ph) {
      host.width = pw;
      host.height = ph;
    }
    host.style.width = `${width}px`;
    host.style.height = `${height}px`;
    return host;
  }

  dispose() {
    this.disposed = true;
    this.host?.remove();
    this.host = null;
    this.ctx = null;
    this.mounted = null;
  }
}

function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}
