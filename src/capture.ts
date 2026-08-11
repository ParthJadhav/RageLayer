/**
 * Capture fidelity helpers — everything needed to make the rasterized copy of
 * the page look identical to the page itself.
 *
 * Three things go wrong if you just hand `document.body` to html-to-image:
 *
 * 1. **The page backdrop is missing.** CSS propagates the *root* background to
 *    the viewport canvas, so a site that paints its background on `<html>`
 *    (or on `<body>`, which is then propagated and no longer painted inside
 *    body's own box) rasterizes to a partly transparent image. Composited over
 *    the destroyer's dark void that reads as a washed-out overlay.
 *    `resolvePageBackdrop` recovers the effective backdrop.
 * 2. **The capture origin drifts from the overlay origin.** The overlay canvas
 *    is anchored at the document origin, but the capture root's border box may
 *    start further in (body margins, centered layouts, a reserved scrollbar
 *    gutter). Rasterizing at the root's own box size and blitting it at the
 *    root's document offset keeps every pixel where the browser put it —
 *    otherwise you get a seam along the edge the offset came from.
 * 3. **Dev tooling gets baked in.** html-to-image walks *open* shadow roots, so
 *    framework dev overlays (Next.js's indicator badge, route announcers, …)
 *    are cloned into the snapshot and freeze there. `defaultCaptureFilter`
 *    drops them.
 * 4. **`position: fixed` lands in the wrong place.** The raster is a detached,
 *    document-sized box with no viewport of its own, so viewport-anchored
 *    elements resolve against *that* box instead: a fixed nav is baked at the
 *    top of the document rather than at the top of the screen, and
 *    `bottom`/`right`-anchored chrome is baked far below the fold.
 *    `pinFixedDescendants` re-anchors them first.
 */

/** Marker attribute: nodes carrying it are excluded from the page capture. */
export const RAGEKIT_IGNORE_ATTR = "data-ragekit-ignore";

/**
 * Device-pixel budget for a single document-sized canvas (≈80 MB of backing
 * store at 4 bytes per pixel). The destructible surface plus its pristine
 * snapshot are both this size, and both live for as long as the toy is open.
 */
const MAX_CANVAS_PIXELS = 20e6;

/**
 * Tallest document the destructible surface will cover.
 *
 * Beyond this the capture is truncated: a canvas that tall is both slow to
 * rasterize and enormous to hold, and leaving the content below it intact is a
 * better trade than degrading the fidelity of everything above.
 */
export const MAX_CAPTURE_HEIGHT = 12000;

/**
 * Pixel ratio for a document-sized canvas.
 *
 * Capped three ways: never above 2 (past that the extra fidelity is invisible
 * and the memory is not), stepped down on tall pages, and finally clamped by a
 * total pixel budget so a very long document can't allocate an enormous
 * texture. Ordinary page heights are unaffected by the budget.
 */
export function pickPixelRatio(width: number, height: number): number {
  const area = Math.max(1, width * height);
  return Math.min(
    window.devicePixelRatio || 1,
    height > 4500 ? 1.5 : 2,
    Math.sqrt(MAX_CANVAS_PIXELS / area),
  );
}

/**
 * Custom-element names that belong to framework dev tooling rather than to the
 * page. Matched case-insensitively as prefixes. Hosts can extend or replace
 * this by passing their own `captureFilter`.
 */
export const DEV_TOOL_ELEMENT_PREFIXES = [
  "nextjs-", // Next.js dev overlay / indicator portal
  "next-route-announcer",
  "next-build-watcher",
  "vite-error-overlay",
  "vite-plugin-checker-error-overlay",
  "astro-dev-toolbar",
  "astro-dev-overlay",
  "nuxt-devtools-",
  "vercel-live-feedback",
  "react-scan-",
];

function isDevToolElement(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  // Only custom elements can be dev-tool hosts; bail early on plain HTML.
  if (!tag.includes("-")) return false;
  if (DEV_TOOL_ELEMENT_PREFIXES.some((prefix) => tag.startsWith(prefix))) return true;
  // Generic heuristic: a custom element that renders nothing itself but owns a
  // shadow root is a mounting point for out-of-flow chrome (dev badges,
  // announcers, toasts injected by tooling). Real content custom elements
  // (charts, number tickers, …) occupy space in the layout.
  if (!el.shadowRoot) return false;
  const rect = el.getBoundingClientRect();
  return rect.width < 1 || rect.height < 1;
}

/**
 * Default `filter` handed to html-to-image. Keeps the destroyer's own DOM and
 * framework dev tooling out of the snapshot. Overridable via
 * `DestroyerOptions.captureFilter` — compose with it rather than replacing it
 * if you only want to add exclusions.
 */
export function defaultCaptureFilter(node: Node): boolean {
  if (node.nodeType !== 1) return true;
  const el = node as Element;
  if (el.hasAttribute(RAGEKIT_IGNORE_ATTR)) return false;
  return !isDevToolElement(el);
}

/**
 * Inline declarations `pinFixedDescendants` overwrites, and therefore has to
 * save and put back. Longhands only — restoring a shorthand like `margin` would
 * wipe longhands the page set inline itself. Margins need no override at all:
 * whatever they shift the box by is absorbed by the re-measure in pass 2.
 */
const PIN_PROPS = ["position", "left", "top", "right", "bottom", "box-sizing", "width", "height"];

/**
 * Re-anchor every `position: fixed` descendant of `root` to the document, so a
 * rasterizer that has no viewport puts it where the user currently sees it.
 *
 * html-to-image rasterizes into a foreignObject the size of the whole document,
 * and a fixed box resolves against *that* rather than against the viewport. So a
 * fixed nav captures at document y=0 and a `bottom: 24px` widget captures at the
 * bottom of the *document* — the moment the page is scrolled the snapshot stops
 * lining up with what was on screen.
 *
 * Used by the snapshot path only. The live path hits the same class of problem
 * (the mirror canvas is its viewport) but cannot use this fix: moving a
 * full-page overlay makes `drawElementImage` silently drop other content. See
 * HTML-IN-CANVAS.md and the comment in `live.ts`.
 *
 * The rewrite is deliberately containing-block-agnostic. Rather than working out
 * what an absolutely positioned box would resolve against (viewport, or the
 * nearest transformed/positioned ancestor, or a `contain` boundary), each
 * element is parked at `left/top: 0` in whatever containing block it lands in,
 * re-measured, and then offset by the delta to its original on-screen rect.
 * Because that offset is applied in document coordinates and `absolute` boxes
 * don't move with the scroll, the element renders in exactly the same place it
 * did while pinned — the live page is visually untouched — while the raster
 * finally sees it at the right document offset.
 *
 * Returns a restore function; call it as soon as the raster (or the clone) is
 * taken. Two things are deliberately out of scope:
 *
 * - `position: sticky`, which unlike fixed is *in-flow* — taking it out of flow
 *   would collapse the layout around it.
 * - Pseudo-elements. A `::before { position: fixed }` full-page grain or
 *   vignette can't be measured or styled per-element, so it still rasterizes
 *   against the whole document.
 */
type PinnedDecl = [property: string, value: string, priority: string];

export function pinFixedDescendants(root: HTMLElement): () => void {
  const pinned: { el: HTMLElement; prev: PinnedDecl[]; rect: DOMRect }[] = [];
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
    if (getComputedStyle(el).position !== "fixed") continue;
    // Our own overlay and toolbar are fixed too, and are excluded from the
    // capture anyway — moving them would only make them jump on screen.
    if (el.closest(`[${RAGEKIT_IGNORE_ATTR}]`)) continue;
    // Zero-size boxes (display:none subtrees, empty portals) contribute nothing.
    if (!el.offsetWidth && !el.offsetHeight) continue;
    // Only the declarations we are about to overwrite are remembered, so a
    // framework that writes its own inline styles mid-capture keeps them.
    const prev = PIN_PROPS.map(
      (p) => [p, el.style.getPropertyValue(p), el.style.getPropertyPriority(p)] as PinnedDecl,
    ).filter(([, value]) => value !== "");
    pinned.push({ el, prev, rect: el.getBoundingClientRect() });
  }
  if (pinned.length === 0) return () => {};

  // Pass 1: go absolute at the containing block's origin, keeping the used
  // border-box size — `right`/`bottom` anchoring is about to be dropped, and
  // without an explicit size an `inset: 0` backdrop would shrink to fit.
  for (const { el } of pinned) {
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    el.style.setProperty("position", "absolute", "important");
    el.style.setProperty("left", "0px", "important");
    el.style.setProperty("top", "0px", "important");
    el.style.setProperty("right", "auto", "important");
    el.style.setProperty("bottom", "auto", "important");
    el.style.setProperty("box-sizing", "border-box", "important");
    el.style.setProperty("width", `${width}px`, "important");
    el.style.setProperty("height", `${height}px`, "important");
  }
  // Pass 2: correct by however far that moved it. Split from pass 1 so the
  // whole batch costs one forced layout rather than one per element.
  for (const { el, rect } of pinned) {
    const now = el.getBoundingClientRect();
    el.style.setProperty("left", `${rect.left - now.left}px`, "important");
    el.style.setProperty("top", `${rect.top - now.top}px`, "important");
  }

  return () => {
    for (const { el, prev } of pinned) {
      for (const prop of PIN_PROPS) el.style.removeProperty(prop);
      for (const [prop, value, priority] of prev) el.style.setProperty(prop, value, priority);
    }
  };
}

function isTransparent(color: string): boolean {
  if (!color) return true;
  const c = color.replace(/\s/g, "").toLowerCase();
  if (c === "transparent") return true;
  // rgba(...)/hsla(...) with a zero alpha as the last component.
  const alpha = /^(?:rgba?|hsla?)\(([^)]+)\)$/.exec(c);
  if (alpha) {
    const parts = alpha[1].split(/[,/]/);
    if (parts.length === 4 && parseFloat(parts[3]) === 0) return true;
  }
  return false;
}

export interface PageBackdrop {
  /** Opaque colour the browser paints behind the page, if any. */
  color?: string;
  /**
   * Background *image* (gradient/texture) that belongs to the viewport canvas
   * but lives on an ancestor of the capture root, so html-to-image would miss
   * it. Applied to the cloned root when the root paints no image of its own.
   */
  image?: {
    backgroundImage: string;
    backgroundSize: string;
    backgroundPosition: string;
    backgroundRepeat: string;
  };
}

/**
 * Recover the backdrop the browser actually paints behind `root`.
 *
 * CSS background propagation means the viewport canvas is painted from
 * `<html>`'s background, falling back to `<body>`'s — and the element it came
 * from then paints nothing itself. Rasterizing a subtree therefore loses the
 * page background unless we put it back explicitly.
 */
export function resolvePageBackdrop(root: HTMLElement): PageBackdrop {
  const doc = root.ownerDocument;
  const chain: (HTMLElement | null)[] = [doc.documentElement, doc.body, root];
  const backdrop: PageBackdrop = {};
  const rootStyle = getComputedStyle(root);
  const rootPaintsImage = rootStyle.backgroundImage !== "none";

  for (const el of chain) {
    if (!el) continue;
    const style = getComputedStyle(el);
    if (!backdrop.color && !isTransparent(style.backgroundColor)) {
      backdrop.color = style.backgroundColor;
    }
    if (!backdrop.image && !rootPaintsImage && el !== root && style.backgroundImage !== "none") {
      backdrop.image = {
        backgroundImage: style.backgroundImage,
        backgroundSize: style.backgroundSize,
        backgroundPosition: style.backgroundPosition,
        backgroundRepeat: style.backgroundRepeat,
      };
    }
    if (backdrop.color && backdrop.image) break;
  }
  return backdrop;
}

export interface CaptureGeometry {
  /** Size of the destructible layer, in CSS px (document coordinates). */
  width: number;
  height: number;
  /**
   * The root's *margin* box within the layer: the area to rasterize, and where
   * to blit the result. Anchoring on the margin box (rather than the border
   * box) keeps out-of-flow descendants — `position: fixed` navs, noise and
   * grain overlays — resolved against the same origin they use on the page.
   */
  source: { x: number; y: number; width: number; height: number };
  /**
   * The root's own resolved size, re-applied to the clone. html-to-image would
   * otherwise stretch the clone to the rasterization width, which — with the
   * margin box as the raster — would push the root past the right edge.
   */
  rootSize: { width: string; height: string };
}

/**
 * Measure the capture root against the document so the raster can be blitted
 * exactly where the browser painted it. Measuring the root itself (instead of
 * assuming it fills `documentElement.clientWidth` from x=0) is what removes
 * edge seams when the root is inset — body margins, a centered `max-width`
 * shell, or a reserved scrollbar gutter.
 */
export function measureCapture(
  root: HTMLElement,
  layerWidth: number,
  layerHeight: number,
  maxHeight: number,
): CaptureGeometry {
  const rect = root.getBoundingClientRect();
  const style = getComputedStyle(root);
  const px = (value: string) => parseFloat(value) || 0;
  const [top, right, bottom, left] = [
    px(style.marginTop),
    px(style.marginRight),
    px(style.marginBottom),
    px(style.marginLeft),
  ];

  const borderHeight = Math.min(Math.round(rect.height) || root.scrollHeight, maxHeight);
  const x = Math.round(rect.left + window.scrollX - left);
  const y = Math.round(rect.top + window.scrollY - top);
  const width = Math.round((Math.round(rect.width) || layerWidth) + left + right);
  const height = Math.round(borderHeight + top + bottom);

  return {
    width: layerWidth,
    height: Math.min(Math.max(layerHeight, y + height), maxHeight),
    source: { x, y, width, height },
    rootSize: {
      width: style.width,
      height: borderHeight === Math.round(rect.height) ? style.height : `${borderHeight}px`,
    },
  };
}
