/**
 * ContentLayer — the "real destruction" pipeline, inspired by canvasui.dev's
 * html-in-canvas approach.
 *
 * The live DOM is rasterized into a canvas (via html-to-image's foreignObject
 * SVG technique, which works in all modern browsers — no experimental flags).
 * The real DOM is then hidden (visibility only, so layout and scrolling stay
 * intact) and the rasterized copy becomes the page. Destruction now literally
 * removes content pixels: holes are punched with `destination-out` and reveal
 * the void behind the page, char marks composite onto surviving pixels with
 * `source-atop`, and a pristine snapshot is kept so repairs can restore any
 * region to its original state.
 *
 * That 2D canvas is no longer what is on screen. Following the same split every
 * canvasui.dev component uses, it is demoted to a **source texture** and
 * `SurfaceRenderer` owns the canvas in the DOM, re-shading the page so tears
 * refract, fringe and catch the light instead of being flat alpha cutouts. All
 * the drawing below is unchanged — tools still see a plain
 * `CanvasRenderingContext2D` — but every mutation now also reports its bounds
 * so the renderer can re-upload and re-shade just that rectangle.
 *
 * When WebGL2 is unavailable the source canvas is presented directly and the
 * layer behaves exactly as it did before the renderer existed.
 */

import { type PageBackdrop, pickPixelRatio, pinFixedDescendants } from "./capture";
import { teeContexts } from "./ctx-proxy";
import { rand, TAU } from "./math";
import { type OpacityBounds, OpacityMap } from "./opacity-map";
import { blit, sprites } from "./sprites";
import { type SurfaceParams, SurfaceRenderer } from "./surface";
import { findDetachedPolygons, polygonMaterialArea, type TopologyBounds } from "./topology";
import type { ContentPatch } from "./types";

export type { ContentPatch };

export interface ContentCheckpoint {
  surface: HTMLCanvasElement;
  wounds: HTMLCanvasElement | null;
  decals: HTMLCanvasElement | null;
  pixelCost: number;
  dispose(): void;
}

export interface CaptureOptions {
  /**
   * Where the rasterized root's border box sits inside the layer, in CSS px.
   * Defaults to the whole layer. Supplying the root's real document offset is
   * what keeps the snapshot seam-free when the root is inset.
   */
  source?: { x: number; y: number; width: number; height: number };
  /**
   * The root's own resolved size, re-applied to the clone so html-to-image
   * doesn't stretch it to fill the rasterization box (see `measureCapture`).
   */
  rootSize?: { width: string; height: string };
  /** The backdrop the browser paints behind the root (see `resolvePageBackdrop`). */
  backdrop?: PageBackdrop;
}

export class ContentLayer {
  /**
   * The 2D page raster every tool draws into. Offscreen whenever the shader
   * renderer is up — read it for pixel truth (alpha is the wound field), but
   * mount `canvas` instead.
   */
  readonly surface: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  private readonly renderer = new SurfaceRenderer();
  private readonly opacity = new OpacityMap();
  /**
   * Pristine copy: the repair source, and — in live mode — the thing a refresh
   * swaps out for freshly captured page pixels.
   */
  private base: HTMLCanvasElement | null = null;
  /**
   * Live mode only. Destruction has to survive a base refresh, so it is kept
   * as its own layers rather than being burned into the visible canvas alone:
   * `wounds` is an opaque mask of everything removed, `decals` holds char
   * marks. `recompose` rebuilds the visible canvas from base + these two.
   *
   * Both stay null in snapshot mode — there is nothing to refresh, so the
   * visible canvas *is* the state and the extra document-sized buffers would
   * be pure cost.
   */
  private wounds: HTMLCanvasElement | null = null;
  private woundsCtx: CanvasRenderingContext2D | null = null;
  private decals: HTMLCanvasElement | null = null;
  private decalsCtx: CanvasRenderingContext2D | null = null;
  /** Tee of visible + decals contexts, built alongside the buffers. */
  private teeCtx: CanvasRenderingContext2D | null = null;
  /** Reused scratch for `restore` stamps (device px, grows to the largest brush). */
  private stampCtx: CanvasRenderingContext2D | null = null;
  /** Whether this layer keeps a refreshable base (see `wounds`). */
  live = false;
  dpr = 1;
  width = 0;
  height = 0;
  ready = false;
  private disposed = false;

  constructor() {
    this.surface = document.createElement("canvas");
    Object.assign(this.surface.style, {
      position: "absolute",
      top: "0",
      left: "0",
    } satisfies Partial<CSSStyleDeclaration>);
    // The visible surface stays GPU-friendly. Page-aware hit tests use the
    // compact CPU-side opacity map above instead of reading this canvas back.
    this.ctx = this.surface.getContext("2d")!;
  }

  /** The canvas to mount: the shaded output, or the raw surface as a fallback. */
  get canvas(): HTMLCanvasElement {
    return this.renderer.available ? this.renderer.canvas : this.surface;
  }

  /**
   * The context tools should paint decals into. In snapshot mode that is the
   * visible surface itself (nothing ever recomposites over it). In live mode it
   * is a tee that also lands every mark in the decals buffer, so cracks and
   * splats survive the ~1 Hz base refresh instead of flashing for a second and
   * vanishing with the next `recompose`.
   */
  get toolCtx(): CanvasRenderingContext2D {
    if (!this.live) return this.ctx;
    this.ensureLayers();
    return (this.teeCtx ??= teeContexts(this.ctx, this.decalsCtx!));
  }

  /** True when the page is being presented through the shader. */
  get shaded(): boolean {
    return this.renderer.available;
  }

  /** Live-tunable shader parameters (refraction, relief, rim, …). */
  get surfaceParams(): SurfaceParams {
    return this.renderer.params;
  }

  set surfaceParams(next: SurfaceParams) {
    this.renderer.params = next;
    this.renderer.markAllDirty();
  }

  /** Whether shaded presentation is wanted at all. Takes effect on next capture. */
  get shadingEnabled(): boolean {
    return this.renderer.enabled;
  }

  set shadingEnabled(on: boolean) {
    this.renderer.enabled = on;
  }

  /**
   * Install the page's text mask, so the shader can keep type crisp where a
   * tear runs through it. Safe to call with null.
   */
  setTextMask(mask: HTMLCanvasElement | null) {
    this.renderer.setTextMask(mask);
  }

  /**
   * Drive the singularity's gravitational lensing, in CSS px. Call each frame
   * while a black hole is open, and with null once it closes.
   */
  setWarp(x: number, y: number, r: number, strength: number): void;
  setWarp(clear: null): void;
  setWarp(x: number | null, y = 0, r = 0, strength = 0) {
    if (x === null) this.renderer.setWarp(null);
    else this.renderer.setWarp(x * this.dpr, y * this.dpr, r * this.dpr, strength);
  }

  /**
   * Push whatever changed since the last call to the screen. Cheap and a no-op
   * when nothing was damaged this frame; the engine calls it once per frame.
   */
  present(allowReconcile = true) {
    if (this.renderer.needsRender(allowReconcile)) this.renderer.render(this.surface);
  }

  /**
   * Report a region drawn straight into `ctx` by a tool, in CSS px.
   *
   * The layer's own ops mark themselves; this exists for decals painted through
   * `engine.surfaceCtx`, which the layer cannot see. Anything a tool paints at
   * the cursor is already covered by the engine's per-frame safety net — this
   * is for marks that land away from it (paint splashes, a lightning channel).
   */
  markSurface(x: number, y: number, r: number, reconcile = false) {
    if (!this.ready) return;
    this.touchDisc(x, y, r, reconcile);
  }

  /** As `markSurface`, for a mark that runs along a segment (a stroke, a bolt). */
  markSurfaceSegment(x1: number, y1: number, x2: number, y2: number, r: number) {
    if (!this.ready) return;
    this.touch(
      Math.min(x1, x2) - r,
      Math.min(y1, y2) - r,
      Math.max(x1, x2) + r,
      Math.max(y1, y2) + r,
    );
  }

  /** Flag a damaged region, in CSS px, for re-upload and re-shading. */
  private touch(x0: number, y0: number, x1: number, y1: number, reconcile = false) {
    if (!this.renderer.available) return;
    const d = this.dpr;
    this.renderer.markDirty(x0 * d, y0 * d, x1 * d, y1 * d, reconcile);
  }

  /** Flag a circular region, in CSS px. */
  private touchDisc(x: number, y: number, r: number, reconcile = false) {
    this.touch(x - r, y - r, x + r, y + r, reconcile);
  }

  /**
   * Rasterize `root` into this layer. `filter` excludes the destroyer's own
   * DOM (overlay, toolbar) and framework dev tooling from the capture.
   *
   * `width`/`height` describe the *layer* (document coordinates); `options`
   * carries where the root actually sits inside it plus the page backdrop, so
   * the composed snapshot lines up with the live page pixel for pixel.
   */
  async capture(
    root: HTMLElement,
    width: number,
    height: number,
    filter: (node: Node) => boolean,
    options: CaptureOptions = {},
  ) {
    if (this.disposed) return;
    const { toCanvas } = await import("html-to-image");
    if (this.disposed) return;
    const source = options.source ?? { x: 0, y: 0, width, height };
    const backdrop = options.backdrop ?? {};
    // Tall documents get a lower pixel ratio to bound canvas memory. Must
    // match the overlay's own ratio so the layers stay pixel-aligned.
    this.dpr = pickPixelRatio(width, height);
    // html-to-image rasterizes into a foreignObject the size of the whole
    // document, which is what viewport-anchored boxes then resolve against.
    // Re-anchor them to the document first — invisibly, see the helper — and
    // put them back once the raster exists.
    const unpin = pinFixedDescendants(root);
    let raster: HTMLCanvasElement;
    try {
      raster = await toCanvas(root, {
        width: source.width,
        height: source.height,
        pixelRatio: this.dpr,
        filter,
        // Paints the page's real backdrop under the root, recovering a
        // background that CSS propagated to the viewport canvas (and which the
        // root therefore no longer paints inside its own box).
        backgroundColor: backdrop.color,
        // Applied after html-to-image's own width/height, so this wins: the
        // clone keeps its real size and margins inside the margin-box raster.
        style: {
          ...backdrop.image,
          ...options.rootSize,
        } as unknown as Partial<CSSStyleDeclaration>,
      });
    } finally {
      unpin();
    }
    if (this.disposed) {
      raster.width = 0;
      raster.height = 0;
      return;
    }

    const pixelWidth = Math.round(width * this.dpr);
    const pixelHeight = Math.round(height * this.dpr);
    const sourceX = Math.round(source.x * this.dpr);
    const sourceY = Math.round(source.y * this.dpr);

    // Most hosts capture <body> at the document origin and its raster already
    // is the final layer. Adopting it directly avoids allocating and copying a
    // second document-sized canvas during startup (up to 80 MB at the capture
    // budget) without changing a pixel of the result.
    const fillsLayer =
      sourceX === 0 &&
      sourceY === 0 &&
      raster.width === pixelWidth &&
      raster.height === pixelHeight;
    if (fillsLayer) {
      this.adopt(raster, width, height);
      return;
    }

    // Inset roots still need composition: backdrop across the whole layer,
    // then the raster at the root's document offset. Anything outside the
    // root's box (body margins, a reserved scrollbar gutter) keeps the page
    // backdrop instead of falling through to the void.
    const snap = document.createElement("canvas");
    snap.width = pixelWidth;
    snap.height = pixelHeight;
    const sctx = snap.getContext("2d")!;
    if (backdrop.color) {
      sctx.fillStyle = backdrop.color;
      sctx.fillRect(0, 0, snap.width, snap.height);
    }
    sctx.drawImage(raster, sourceX, sourceY);

    // The composed snapshot owns the pixels now. Reset the html-to-image
    // intermediate immediately instead of waiting for GC to notice an enormous
    // detached backing store during the rest of capture setup.
    raster.width = 0;
    raster.height = 0;

    this.adopt(snap, width, height);
  }

  /**
   * Install `raster` as the pristine base and show it. Shared by both capture
   * modes — the html-to-image path composes its raster first, the live path
   * hands one straight over.
   */
  adopt(raster: HTMLCanvasElement, width: number, height: number) {
    if (this.disposed) return;
    // A full re-capture (first run, or a reflow) starts from an intact page, so
    // any accumulated wounds are stale — and possibly the wrong size.
    this.wounds = this.decals = null;
    this.woundsCtx = this.decalsCtx = null;
    this.teeCtx = null;
    this.base = raster;
    this.width = width;
    this.height = height;
    this.surface.width = raster.width;
    this.surface.height = raster.height;
    this.surface.style.width = `${width}px`;
    this.surface.style.height = `${height}px`;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.drawImage(raster, 0, 0);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.opacity.reset(raster, width, height);
    // Sized from the raster's backing store, not from `width * dpr`: a tall
    // page has its ratio stepped down by `pickPixelRatio`, and the shader's
    // texel size has to match the texture it is actually sampling.
    this.renderer.pixelScale = this.dpr;
    this.renderer.init(raster.width, raster.height);
    this.renderer.setDisplaySize(width, height);
    // A re-capture can land on the other presentation path — a page that has
    // grown past `MAX_TEXTURE_SIZE`, or a context that came back after being
    // lost. The engine mounts `canvas` again either way, so the one that just
    // stopped being presented has to be taken out or it stays as a stale layer.
    (this.renderer.available ? this.surface : this.renderer.canvas).remove();
    this.ready = true;
  }

  /**
   * Live mode: swap in freshly captured page pixels while keeping every wound.
   * No-op unless the new raster matches the current geometry — a size change
   * means the page reflowed and the engine re-captures from scratch instead.
   */
  refreshBase(raster: HTMLCanvasElement, band?: { y0: number; y1: number }) {
    if (!this.ready || !this.live || !this.base) return;
    if (raster.width !== this.surface.width || raster.height !== this.surface.height) return;
    // The band (CSS px rows) scopes the whole refresh to what the user can see
    // plus margin. A refresh exists so on-screen animation keeps moving — the
    // nine screens below the fold don't need a 12M-pixel recomposite-and-upload
    // every second to stay convincing, and the next refresh after a scroll
    // covers them within `liveRefreshMs` anyway. Off-band pixels keep the last
    // refresh's base, which is still a pristine page — just a beat older.
    const d = this.dpr;
    const y0 = Math.max(0, Math.floor((band?.y0 ?? 0) * d));
    const y1 = Math.min(this.surface.height, Math.ceil((band?.y1 ?? this.height) * d));
    if (y1 <= y0) return;
    // Copied into the layer's own base rather than adopted by reference. The
    // repaint path hands over its *live* host canvas, which it clears and
    // redraws on the next refresh — and `base` outlives any single refresh: it
    // is the broom's repair source and backs every `patch` handle a flying
    // shard is still drawing from.
    if (raster !== this.base) {
      const ctx = this.base.getContext("2d")!;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, y0, this.base.width, y1 - y0);
      ctx.drawImage(raster, 0, y0, raster.width, y1 - y0, 0, y0, raster.width, y1 - y0);
    }
    this.recompose(y0, y1);
  }

  /**
   * Rebuild rows y0..y1 (device px) of the visible canvas from base + decals +
   * wounds (live mode only).
   */
  private recompose(y0: number, y1: number) {
    const ctx = this.ctx;
    const w = this.surface.width;
    const h = y1 - y0;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, y0, w, h);
    ctx.drawImage(this.base!, 0, y0, w, h, 0, y0, w, h);
    // Char marks first, clipped to surviving pixels; then remove the holes.
    // The other order would let a hole's rim char paint over the void.
    if (this.decals) {
      ctx.globalCompositeOperation = "source-atop";
      ctx.drawImage(this.decals, 0, y0, w, h, 0, y0, w, h);
    }
    if (this.wounds) {
      ctx.globalCompositeOperation = "destination-out";
      ctx.drawImage(this.wounds, 0, y0, w, h, 0, y0, w, h);
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // Every pixel in the band was replaced; upload exactly that band.
    this.renderer.markDirty(0, y0, w, y1);
  }

  /**
   * Allocate a wound/decal buffer on first damage. Live mode only, and lazy for
   * the same reason the engine's damage canvas is: an untouched document-sized
   * layer still costs a full set of tiles.
   */
  private ensureLayers() {
    if (!this.live || this.wounds) return;
    const make = () => {
      const c = document.createElement("canvas");
      c.width = this.surface.width;
      c.height = this.surface.height;
      const cx = c.getContext("2d")!;
      cx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      return [c, cx] as const;
    };
    [this.wounds, this.woundsCtx] = make();
    [this.decals, this.decalsCtx] = make();
  }

  /** The pristine raster, for tools that want undamaged pixels. */
  get baseImage(): HTMLCanvasElement | null {
    return this.base;
  }

  get checkpointPixelCost(): number {
    if (!this.ready) return 0;
    return [this.surface, this.wounds, this.decals].reduce(
      (total, canvas) => total + (canvas ? canvas.width * canvas.height : 0),
      0,
    );
  }

  /** Capture the persistent page state. Transient particles and debris are intentionally excluded. */
  createCheckpoint(): ContentCheckpoint | null {
    if (!this.ready) return null;
    const clone = (source: HTMLCanvasElement | null) => {
      if (!source) return null;
      const canvas = document.createElement("canvas");
      canvas.width = source.width;
      canvas.height = source.height;
      canvas.getContext("2d")?.drawImage(source, 0, 0);
      return canvas;
    };
    const surface = clone(this.surface)!;
    const wounds = clone(this.wounds);
    const decals = clone(this.decals);
    const canvases = [surface, wounds, decals].filter(
      (canvas): canvas is HTMLCanvasElement => canvas !== null,
    );
    return {
      surface,
      wounds,
      decals,
      pixelCost: canvases.reduce((total, canvas) => total + canvas.width * canvas.height, 0),
      dispose() {
        for (const canvas of canvases) {
          canvas.width = 0;
          canvas.height = 0;
        }
      },
    };
  }

  restoreCheckpoint(checkpoint: ContentCheckpoint) {
    if (!this.ready || checkpoint.surface.width !== this.surface.width) return false;
    if (checkpoint.surface.height !== this.surface.height) return false;
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.surface.width, this.surface.height);
    this.ctx.drawImage(checkpoint.surface, 0, 0);
    this.ctx.restore();
    if (this.live) {
      if (checkpoint.wounds || checkpoint.decals) this.ensureLayers();
      this.clearLayers();
      for (const [source, target] of [
        [checkpoint.wounds, this.woundsCtx],
        [checkpoint.decals, this.decalsCtx],
      ] as const) {
        if (!source || !target) continue;
        target.save();
        target.setTransform(1, 0, 0, 1, 0, 0);
        target.drawImage(source, 0, 0);
        target.restore();
      }
    }
    this.opacity.restoreState(checkpoint.surface);
    this.renderer.markAllDirty();
    return true;
  }

  /**
   * Remove an arbitrary shape from the content — used when a region is not
   * eroded but *taken away*, because it has just become a physics body falling
   * down the screen.
   */
  carveShape(
    path: Path2D,
    bounds?: { x: number; y: number; w: number; h: number },
    topologyPolygons?: number[][],
  ) {
    if (!this.ready) return;
    this.carve(
      path,
      bounds
        ? { x0: bounds.x, y0: bounds.y, x1: bounds.x + bounds.w, y1: bounds.y + bounds.h }
        : { x0: 0, y0: 0, x1: this.width, y1: this.height },
      topologyPolygons,
    );
    // `Path2D` exposes no bounds, so the caller supplies them. Without them the
    // whole page has to be re-shaded, which is correct but costs a full upload.
    if (bounds) this.touch(bounds.x, bounds.y, bounds.x + bounds.w, bounds.y + bounds.h);
    else this.renderer.markAllDirty();
  }

  /**
   * Remove `path` from the content.
   *
   * The randomised geometry is built into a `Path2D` once and replayed against
   * both targets, so the visible canvas (immediate feedback) and the wound mask
   * (which survives a live refresh) can never drift apart.
   */
  private carve(path: Path2D, bounds: OpacityBounds, topologyPolygons?: number[][]) {
    const ctx = this.ctx;
    // Composite mode is set and reset by hand rather than via save/restore:
    // these run against a document-sized canvas many times a second while fire
    // is spreading, and a full state push/pop per wound is pure overhead.
    ctx.globalCompositeOperation = "destination-out";
    ctx.fill(path);
    ctx.globalCompositeOperation = "source-over";
    this.opacity.remove(path, bounds, topologyPolygons);
    if (!this.live) return;
    this.ensureLayers();
    const wctx = this.woundsCtx!;
    wctx.fillStyle = "#000";
    wctx.fill(path);
  }

  /** Punch a ragged hole clean through the content. */
  punch(x: number, y: number, r: number) {
    if (!this.ready) return;
    const path = new Path2D();
    path.arc(x, y, r, 0, TAU);
    // Ragged rim bites, batched into the same path as the core.
    for (let i = 0; i < 7; i++) {
      const a = Math.random() * TAU;
      const d = r * rand(0.7, 1.1);
      const br = r * rand(0.25, 0.55);
      path.moveTo(x + Math.cos(a) * d + br, y + Math.sin(a) * d);
      path.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, br, 0, TAU);
    }
    const bounds = { x0: x - r * 1.7, y0: y - r * 1.7, x1: x + r * 1.7, y1: y + r * 1.7 };
    const ctx = this.ctx;
    ctx.globalCompositeOperation = "destination-out";
    ctx.fill(path);
    ctx.globalCompositeOperation = "source-over";
    this.opacity.removeDisc(path, bounds, x, y, r);
    if (this.live) {
      this.ensureLayers();
      const wctx = this.woundsCtx!;
      wctx.fillStyle = "#000";
      wctx.fill(path);
    }
    // Rim bites reach ~1.65r; the char below reaches 1.9r and marks its own.
    this.touchDisc(x, y, r * 1.7);
    this.char(x, y, r * 1.9, 0.45);
  }

  /** Content alpha (0..1) at a document point, without a visible-canvas readback. */
  opacityAt(x: number, y: number): number {
    if (!this.ready) return 1;
    return this.opacity.sample(x, y);
  }

  /** Approximate surviving material area inside an arbitrary polygon. */
  materialArea(points: number[]): number {
    if (!this.ready) return 0;
    return polygonMaterialArea(points, (x, y) => this.opacity.sample(x, y));
  }

  /**
   * Find pieces that recent damage has disconnected from the surrounding page.
   * Used by the chainsaw after each meaningful stretch of real cutting.
   */
  detachedPolygons(bounds: TopologyBounds): number[][] {
    if (!this.ready) return [];
    return findDetachedPolygons(
      {
        width: this.width,
        height: this.height,
        stateAt: (x, y) => this.opacity.stateAt(x, y),
      },
      bounds,
    );
  }

  /** Darken surviving pixels around a wound (charred/bruised rim). */
  char(x: number, y: number, r: number, alpha: number) {
    if (!this.ready) return;
    const ctx = this.ctx;
    ctx.globalCompositeOperation = "source-atop";
    blit(ctx, sprites().char, x, y, r, alpha);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    this.touchDisc(x, y, r);
    if (!this.live) return;
    // Accumulated plainly here; `recompose` re-applies the source-atop clip.
    this.ensureLayers();
    blit(this.decalsCtx!, sprites().char, x, y, r, alpha);
    this.decalsCtx!.globalAlpha = 1;
  }

  /**
   * One tick of fire erosion: nibble pixels away with noisy blobs and char
   * the surviving edge, so flames eat a growing, irregular hole in the page.
   */
  burn(x: number, y: number, r: number) {
    if (!this.ready) return;
    const path = new Path2D();
    for (let i = 0; i < 4; i++) {
      const a = Math.random() * TAU;
      const d = rand(0, r);
      const bx = x + Math.cos(a) * d;
      const by = y + Math.sin(a) * d * 0.7;
      const br = rand(2, 3 + r * 0.35);
      path.moveTo(bx + br, by);
      path.arc(bx, by, br, 0, TAU);
    }
    const reach = r * 1.35 + 3;
    this.carve(path, { x0: x - reach, y0: y - reach, x1: x + reach, y1: y + reach });
    // Blobs sit within r of the centre and are themselves up to 3 + 0.35r wide.
    this.touchDisc(x, y, reach);
    this.char(x, y, r * 2.2, 0.28);
  }

  /** Slice through content along a segment (chainsaw). */
  cut(x1: number, y1: number, x2: number, y2: number) {
    if (!this.ready) return;
    const lineWidth = rand(4, 7);
    const kerf = new Path2D();
    kerf.moveTo(x1, y1);
    kerf.lineTo(x2, y2);
    // Torn nicks along the cut, batched into a single path.
    const len = Math.hypot(x2 - x1, y2 - y1);
    const steps = Math.max(2, Math.floor(len / 6));
    const nicks = new Path2D();
    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      const nx = x1 + (x2 - x1) * t + rand(-3, 3);
      const ny = y1 + (y2 - y1) * t + rand(-3, 3);
      const nr = rand(1, 4);
      nicks.moveTo(nx + nr, ny);
      nicks.arc(nx, ny, nr, 0, TAU);
    }

    const stroke = (ctx: CanvasRenderingContext2D) => {
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineWidth = lineWidth;
      ctx.stroke(kerf);
      ctx.restore();
    };
    const ctx = this.ctx;
    ctx.globalCompositeOperation = "destination-out";
    stroke(ctx);
    ctx.fill(nicks);
    ctx.globalCompositeOperation = "source-over";
    // Kerf half-width plus the widest nick and its jitter.
    const reach = lineWidth / 2 + 7;
    this.opacity.removeCut(kerf, nicks, lineWidth, {
      x0: Math.min(x1, x2) - reach,
      y0: Math.min(y1, y2) - reach,
      x1: Math.max(x1, x2) + reach,
      y1: Math.max(y1, y2) + reach,
    });
    if (this.live) {
      this.ensureLayers();
      const wctx = this.woundsCtx!;
      wctx.fillStyle = "#000";
      wctx.strokeStyle = "#000";
      stroke(wctx);
      wctx.fill(nicks);
    }

    this.touch(
      Math.min(x1, x2) - reach,
      Math.min(y1, y2) - reach,
      Math.max(x1, x2) + reach,
      Math.max(y1, y2) + reach,
    );

    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    this.char(mx, my, Math.max(10, len * 0.7), 0.3);
  }

  /** Grab a source-rect handle into the pristine snapshot (for flying shards). */
  patch(x: number, y: number, w: number, h: number): ContentPatch | null {
    if (!this.ready || !this.base) return null;
    return {
      img: this.base,
      sx: Math.max(0, (x - w / 2) * this.dpr),
      sy: Math.max(0, (y - h / 2) * this.dpr),
      sw: w * this.dpr,
      sh: h * this.dpr,
    };
  }

  /** Repair a circular region back to the pristine base. */
  restore(x: number, y: number, r: number) {
    if (!this.ready || !this.base) return;
    // Blit only the wound's bounding box. Re-drawing the whole document-sized
    // snapshot (clipped) on every broom pointermove was the same work as a
    // full-page repaint, dozens of times a second.
    const x0 = Math.max(0, x - r);
    const y0 = Math.max(0, y - r);
    const x1 = Math.min(this.width, x + r);
    const y1 = Math.min(this.height, y + r);
    if (x1 <= x0 || y1 <= y0) return;
    const w = x1 - x0;
    const h = y1 - y0;
    const d = this.dpr;

    // Compose the pristine disc on a scratch canvas — mask once with
    // `destination-in` — then stamp it with a single source-over draw. The
    // obvious clip + clearRect + drawImage antialiases the rim twice, which
    // leaves a ring of partial alpha (1 - c + c²) on an intact page; the
    // surface shader reads any alpha gradient as a wound and shades every
    // sweep of the broom with a trail of phantom torn edges.
    const sw = Math.ceil(w * d);
    const sh = Math.ceil(h * d);
    let stamp = this.stampCtx;
    if (!stamp || stamp.canvas.width < sw || stamp.canvas.height < sh) {
      const canvas = stamp?.canvas ?? document.createElement("canvas");
      canvas.width = Math.max(sw, canvas.width);
      canvas.height = Math.max(sh, canvas.height);
      stamp = this.stampCtx = canvas.getContext("2d")!;
    }
    stamp.clearRect(0, 0, stamp.canvas.width, stamp.canvas.height);
    stamp.drawImage(this.base, x0 * d, y0 * d, w * d, h * d, 0, 0, sw, sh);
    stamp.globalCompositeOperation = "destination-in";
    stamp.beginPath();
    stamp.arc((x - x0) * d, (y - y0) * d, r * d, 0, TAU);
    stamp.fill();
    stamp.globalCompositeOperation = "source-over";
    this.ctx.drawImage(stamp.canvas, 0, 0, sw, sh, x0, y0, w, h);
    this.opacity.restoreDisc(x, y, r);
    this.touch(x0, y0, x1, y1);

    // Live mode: forget the wound too, or the next base refresh reopens it.
    if (!this.wounds) return;
    for (const cx of [this.woundsCtx!, this.decalsCtx!]) {
      cx.save();
      cx.beginPath();
      cx.arc(x, y, r, 0, TAU);
      cx.clip();
      cx.clearRect(x0, y0, w, h);
      cx.restore();
    }
  }

  /**
   * Rinse stains off the page: repaint the pristine base over *surviving*
   * pixels only. `source-atop` keeps the destination's alpha, so holes stay
   * holes and eroded rims stay eroded — washing cleans paint, soot and rime,
   * it does not repair structure (that is `restore`, the broom's move).
   * `strength` < 1 fades stains gradually, so cleaning takes a moment of
   * sustained spray rather than one wet touch.
   */
  wash(x: number, y: number, r: number, strength = 1) {
    if (!this.ready || !this.base) return;
    const x0 = Math.max(0, x - r);
    const y0 = Math.max(0, y - r);
    const x1 = Math.min(this.width, x + r);
    const y1 = Math.min(this.height, y + r);
    if (x1 <= x0 || y1 <= y0) return;
    const w = x1 - x0;
    const h = y1 - y0;
    const d = this.dpr;
    const alpha = Math.min(1, strength);

    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.clip();
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = "source-atop";
    ctx.drawImage(this.base, x0 * d, y0 * d, w * d, h * d, x0, y0, w, h);
    ctx.restore();
    this.touch(x0, y0, x1, y1);

    // Live mode: fade the recorded decals too, or the next base refresh
    // re-applies exactly the stains that were just washed off. The wound mask
    // is left alone — holes are not wash-away damage.
    if (!this.decals) return;
    const cx = this.decalsCtx!;
    cx.save();
    cx.beginPath();
    cx.arc(x, y, r, 0, TAU);
    cx.clip();
    cx.globalAlpha = alpha;
    cx.globalCompositeOperation = "destination-out";
    cx.fillStyle = "#000";
    cx.fillRect(x0, y0, w, h);
    cx.restore();
  }

  /** Repair everything. */
  restoreAll() {
    if (!this.ready || !this.base) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.surface.width, this.surface.height);
    ctx.restore();
    ctx.drawImage(this.base, 0, 0, this.width, this.height);
    this.opacity.restoreAll();
    this.clearLayers();
    this.renderer.markAllDirty();
  }

  /** Wipe the wound/decal buffers (device space — they carry a dpr transform). */
  private clearLayers() {
    if (!this.wounds) return;
    for (const cx of [this.woundsCtx!, this.decalsCtx!]) {
      cx.save();
      cx.setTransform(1, 0, 0, 1, 0, 0);
      cx.clearRect(0, 0, this.wounds.width, this.wounds.height);
      cx.restore();
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.ready = false;
    for (const canvas of [this.base, this.wounds, this.decals]) {
      if (!canvas) continue;
      canvas.width = 0;
      canvas.height = 0;
      canvas.remove();
    }
    this.base = null;
    this.wounds = this.decals = null;
    this.woundsCtx = this.decalsCtx = null;
    this.teeCtx = null;
    if (this.stampCtx) {
      this.stampCtx.canvas.width = 0;
      this.stampCtx.canvas.height = 0;
      this.stampCtx = null;
    }
    this.renderer.dispose();
    this.opacity.dispose();
    this.surface.width = 0;
    this.surface.height = 0;
    this.surface.remove();
    this.width = 0;
    this.height = 0;
    this.live = false;
  }
}
