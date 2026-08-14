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
import type { PerfCounterSink } from "./performance";
import { blit, sprites } from "./sprites";
import { type SurfaceParams, SurfaceRenderer } from "./surface";
import { findDetachedPolygons, polygonMaterialArea, type TopologyBounds } from "./topology";
import type { ContentPatch, CutOptions } from "./types";

export type { ContentPatch };

export interface ContentCheckpoint {
  surface: HTMLCanvasElement;
  wounds: HTMLCanvasElement | null;
  decals: HTMLCanvasElement | null;
  /**
   * Where the wound/decal clones sit in the document, in device px. The live
   * buffers cover the damage rect rather than the whole page, so a checkpoint
   * has to remember its placement — by restore time the buffers may have grown
   * and moved.
   */
  layersOrigin: { x: number; y: number } | null;
  pixelCost: number;
  dispose(): void;
}

/** Padding (device px) around the damage rect when sizing the live buffers. */
const LAYER_PAD = 64;
/** Pending tee ops beyond this force a flush, bounding the log's memory. */
const DECAL_LOG_CAP = 4096;

/** One recorded call or property write against the tee's decals side. */
interface DecalOp {
  set: boolean;
  prop: string | symbol;
  args: unknown[];
  value: unknown;
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
  /** Telemetry sink for recompose cost; also fanned out to the sub-parts. */
  private counters: PerfCounterSink | null = null;
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
   * visible canvas *is* the state and the extra buffers would be pure cost.
   *
   * Sized to the damage rect (padded), not the document: `recompose` only ever
   * reads them through `damage`, so on a tall page two document-sized layers
   * were ~160 MB of mostly untouched pixels for a screenful of destruction.
   * `layersRect` is their placement, baked into both contexts' transforms so
   * every CSS-px draw site stays untouched; see `ensureLayers`.
   */
  private wounds: HTMLCanvasElement | null = null;
  private woundsCtx: CanvasRenderingContext2D | null = null;
  private decals: HTMLCanvasElement | null = null;
  private decalsCtx: CanvasRenderingContext2D | null = null;
  /** Placement (device px) of the wound/decal buffers inside the document. */
  private readonly layersRect = { x: 0, y: 0, w: 0, h: 0 };
  /** Tee of visible + decals contexts; the decals side records (see below). */
  private teeCtx: CanvasRenderingContext2D | null = null;
  /**
   * Tee decal ops recorded but not yet landed in the decals buffer, with the
   * recording context that captures them. Tools draw first and report bounds
   * after (`drawSplat(engine.surfaceCtx, …)` then `markSurface(…)`), so at
   * draw time the buffer may not cover the mark yet; applying immediately
   * would clip those pixels forever. The ops replay — in order, so state
   * writes interleave exactly as they would have live — once the mark lands
   * and grows the buffer, which happens in the same task (see `noteDamage`).
   * Entries are pooled; the hot path allocates nothing beyond what the tee
   * itself already does.
   */
  private readonly decalLog: DecalOp[] = [];
  private decalLogLength = 0;
  private decalRecorder: CanvasRenderingContext2D | null = null;
  /** Reused scratch for `restore`/`wash` stamps (device px, grows to the largest brush). */
  private stampCtx: CanvasRenderingContext2D | null = null;
  /**
   * Union of every region damage has ever touched, in device px. The wound and
   * decal buffers can only hold pixels inside it — every mutation reports its
   * bounds through `touch` (the same contract the dirty-rect uploads rely on)
   * — so `recompose` bounds its two damage passes to this rect instead of
   * compositing two document-wide, mostly transparent draws per refresh.
   */
  private readonly damage = { x0: 0, y0: 0, x1: 0, y1: 0 };
  private hasDamage = false;
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
    // The decals side is a recorder rather than the buffer context itself, so
    // the buffers can stay unallocated (and damage-rect sized) until a mark
    // reports where the pixels actually landed.
    return (this.teeCtx ??= teeContexts(
      this.ctx,
      (this.decalRecorder ??= this.makeDecalRecorder()),
    ));
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
   * Attach the engine's performance counters, fanning the sink out to the
   * surface renderer (uploads, GPU timing) and the opacity map (query counts).
   * Null detaches; instrumentation is a no-op without a sink.
   */
  setPerfCounters(sink: PerfCounterSink | null) {
    this.counters = sink;
    this.renderer.counters = sink;
    this.opacity.counters = sink;
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
    const d = this.dpr;
    this.noteDamage(x0 * d, y0 * d, x1 * d, y1 * d);
    if (!this.renderer.available) return;
    this.renderer.markDirty(x0 * d, y0 * d, x1 * d, y1 * d, reconcile);
  }

  /** Grow the accumulated damage bounds (device px) — see `damage`. */
  private noteDamage(x0: number, y0: number, x1: number, y1: number) {
    const nx0 = Math.max(0, Math.floor(x0));
    const ny0 = Math.max(0, Math.floor(y0));
    const nx1 = Math.min(this.surface.width, Math.ceil(x1));
    const ny1 = Math.min(this.surface.height, Math.ceil(y1));
    if (nx1 <= nx0 || ny1 <= ny0) return;
    const dmg = this.damage;
    if (!this.hasDamage) {
      this.hasDamage = true;
      dmg.x0 = nx0;
      dmg.y0 = ny0;
      dmg.x1 = nx1;
      dmg.y1 = ny1;
    } else {
      dmg.x0 = Math.min(dmg.x0, nx0);
      dmg.y0 = Math.min(dmg.y0, ny0);
      dmg.x1 = Math.max(dmg.x1, nx1);
      dmg.y1 = Math.max(dmg.y1, ny1);
    }
    // The live buffers must always cover the damage rect — `recompose` reads
    // them through it — and a mark arrives in the same task as the draws it
    // reports: grow first, then land any recorded tee decals inside the new
    // extent. Both are cheap no-ops on the per-frame path.
    if (this.live && (this.wounds || this.decalLogLength > 0)) {
      this.ensureLayers();
      this.flushDecalLog();
    }
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
    this.releaseLayers();
    this.teeCtx = null;
    this.hasDamage = false;
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
    // Timed as one unit (base copy + recompose): the whole band refresh is what
    // a live page pays per refresh tick, and telemetry reports it that way.
    const startedAt = performance.now();
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
    this.counters?.count("recomposeMs", performance.now() - startedAt);
  }

  /**
   * Rebuild rows y0..y1 (device px) of the visible canvas from base + decals +
   * wounds (live mode only).
   */
  private recompose(y0: number, y1: number) {
    // Recorded tee decals land first, so the rebuild sees every mark.
    this.flushDecalLog();
    const ctx = this.ctx;
    const w = this.surface.width;
    const h = y1 - y0;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, y0, w, h);
    ctx.drawImage(this.base!, 0, y0, w, h, 0, y0, w, h);
    // The two damage passes are bounded to where damage has ever landed: both
    // buffers are fully transparent outside `damage`, and `source-atop` /
    // `destination-out` with a transparent source are no-ops, so skipping the
    // rest of the band draws the same pixels for a fraction of the blit work.
    const dmg = this.damage;
    const dy0 = Math.max(y0, dmg.y0);
    const dy1 = Math.min(y1, dmg.y1);
    if (this.hasDamage && dy1 > dy0) {
      const dx0 = dmg.x0;
      const dw = dmg.x1 - dmg.x0;
      const dh = dy1 - dy0;
      // Char marks first, clipped to surviving pixels; then remove the holes.
      // The other order would let a hole's rim char paint over the void.
      // Source coordinates shift by the buffers' placement: they cover the
      // damage rect, not the document, and damage never escapes them.
      const rect = this.layersRect;
      if (this.decals) {
        ctx.globalCompositeOperation = "source-atop";
        ctx.drawImage(this.decals, dx0 - rect.x, dy0 - rect.y, dw, dh, dx0, dy0, dw, dh);
      }
      if (this.wounds) {
        ctx.globalCompositeOperation = "destination-out";
        ctx.drawImage(this.wounds, dx0 - rect.x, dy0 - rect.y, dw, dh, dx0, dy0, dw, dh);
      }
      ctx.globalCompositeOperation = "source-over";
    }
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // Every pixel in the band was replaced; upload exactly that band.
    this.renderer.markDirty(0, y0, w, y1);
  }

  /**
   * Allocate or grow the wound/decal buffers. Live mode only, lazy for the
   * same reason the engine's damage canvas is, and sized to the damage rect
   * rather than the document — the only region `recompose` ever reads.
   *
   * `bounds` (CSS px) is what a caller is about to draw, so the pixels land
   * inside the buffer before the damage rect catches up. Growth unions the
   * requirement with the current placement, pads by 25% of the diagonal
   * (`LAYER_PAD` minimum) so steady outward damage does not reallocate per
   * hit, and re-blits the old contents 1:1 at the same dpr — a grow must not
   * change a single existing pixel. The buffer origin is baked into both
   * contexts' transforms, which keeps every CSS-px draw site untouched.
   */
  private ensureLayers(bounds?: OpacityBounds) {
    if (!this.live) return;
    const dmg = this.damage;
    let nx0 = this.hasDamage ? dmg.x0 : Infinity;
    let ny0 = this.hasDamage ? dmg.y0 : Infinity;
    let nx1 = this.hasDamage ? dmg.x1 : -Infinity;
    let ny1 = this.hasDamage ? dmg.y1 : -Infinity;
    if (bounds) {
      const d = this.dpr;
      nx0 = Math.min(nx0, Math.floor(bounds.x0 * d));
      ny0 = Math.min(ny0, Math.floor(bounds.y0 * d));
      nx1 = Math.max(nx1, Math.ceil(bounds.x1 * d));
      ny1 = Math.max(ny1, Math.ceil(bounds.y1 * d));
    }
    nx0 = Math.max(0, nx0);
    ny0 = Math.max(0, ny0);
    nx1 = Math.min(this.surface.width, nx1);
    ny1 = Math.min(this.surface.height, ny1);
    if (nx1 <= nx0 || ny1 <= ny0) return;
    const rect = this.layersRect;
    if (
      this.wounds &&
      nx0 >= rect.x &&
      ny0 >= rect.y &&
      nx1 <= rect.x + rect.w &&
      ny1 <= rect.y + rect.h
    ) {
      return;
    }
    if (this.wounds) {
      nx0 = Math.min(nx0, rect.x);
      ny0 = Math.min(ny0, rect.y);
      nx1 = Math.max(nx1, rect.x + rect.w);
      ny1 = Math.max(ny1, rect.y + rect.h);
    }
    const pad = Math.max(LAYER_PAD, Math.ceil(Math.hypot(nx1 - nx0, ny1 - ny0) * 0.25));
    const x = Math.max(0, nx0 - pad);
    const y = Math.max(0, ny0 - pad);
    const w = Math.min(this.surface.width, nx1 + pad) - x;
    const h = Math.min(this.surface.height, ny1 + pad) - y;
    const make = (previous: HTMLCanvasElement | null) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const cx = c.getContext("2d")!;
      if (previous) {
        cx.drawImage(previous, rect.x - x, rect.y - y);
        // Release the old backing store now, not at the GC's leisure.
        previous.width = 0;
        previous.height = 0;
      }
      cx.setTransform(this.dpr, 0, 0, this.dpr, -x, -y);
      return [c, cx] as const;
    };
    [this.wounds, this.woundsCtx] = make(this.wounds);
    [this.decals, this.decalsCtx] = make(this.decals);
    rect.x = x;
    rect.y = y;
    rect.w = w;
    rect.h = h;
  }

  /** Drop the live buffers, releasing their backing stores immediately. */
  private releaseLayers() {
    for (const canvas of [this.wounds, this.decals]) {
      if (!canvas) continue;
      canvas.width = 0;
      canvas.height = 0;
    }
    this.wounds = this.decals = null;
    this.woundsCtx = this.decalsCtx = null;
    this.layersRect.x = this.layersRect.y = this.layersRect.w = this.layersRect.h = 0;
    this.discardDecalLog();
  }

  /**
   * The decals side handed to the tee: records every mirrored call and
   * property write instead of applying it — see `decalLog` for why. The proxy
   * borrows the visible context purely as a shape reference, so it mirrors
   * whatever the platform's context exposes.
   */
  private makeDecalRecorder(): CanvasRenderingContext2D {
    const methods = new Map<string | symbol, unknown>();
    return new Proxy(this.ctx, {
      get: (target, prop) => {
        let method = methods.get(prop);
        if (method === undefined) {
          const value = Reflect.get(target, prop);
          if (typeof value !== "function") return value;
          method = (...args: unknown[]) => this.recordDecalOp(false, prop, args, null);
          methods.set(prop, method);
        }
        return method;
      },
      set: (_target, prop, value) => {
        this.recordDecalOp(true, prop, null, value);
        return true;
      },
    });
  }

  private recordDecalOp(
    set: boolean,
    prop: string | symbol,
    args: unknown[] | null,
    value: unknown,
  ) {
    const log = this.decalLog;
    let op = log[this.decalLogLength];
    if (!op) log[this.decalLogLength] = op = { set: false, prop: "", args: [], value: null };
    this.decalLogLength++;
    op.set = set;
    op.prop = prop;
    op.value = value;
    op.args.length = 0;
    if (args) for (const arg of args) op.args.push(arg);
    // A tool that draws forever without reporting bounds must not grow the
    // log without limit; landing what fits in the current buffers is exactly
    // what `recompose` would have kept of it anyway.
    if (this.decalLogLength >= DECAL_LOG_CAP) {
      this.ensureLayers();
      this.flushDecalLog();
    }
  }

  /** Replay recorded tee ops into the decals buffer; see `decalLog`. */
  private flushDecalLog() {
    const count = this.decalLogLength;
    if (count === 0) return;
    this.decalLogLength = 0;
    if (!this.decalsCtx) this.ensureLayers();
    const ctx = this.decalsCtx;
    for (let i = 0; i < count; i++) {
      const op = this.decalLog[i];
      if (ctx) {
        try {
          if (op.set) {
            Reflect.set(ctx, op.prop, op.value);
          } else if (op.prop === "setTransform" || op.prop === "resetTransform") {
            this.replayDecalTransform(ctx, op.args);
          } else {
            const method = (ctx as unknown as Record<string | symbol, unknown>)[op.prop];
            if (typeof method === "function") method.apply(ctx, op.args);
          }
        } catch {
          // A decals-side failure must never break the visible draw, which
          // already happened (see ctx-proxy).
        }
      }
      // Drop references (sprite canvases, gradients) as soon as they land.
      op.args.length = 0;
      op.value = null;
    }
  }

  /** Forget recorded tee ops without applying them (rewinds and teardown). */
  private discardDecalLog() {
    const count = this.decalLogLength;
    this.decalLogLength = 0;
    for (let i = 0; i < count; i++) {
      const op = this.decalLog[i];
      op.args.length = 0;
      op.value = null;
    }
  }

  /**
   * An absolute transform through the tee would discard the buffer-origin
   * mapping the decals context bakes into its own; re-express it relative to
   * the origin so the pixels land where they would on the visible canvas.
   */
  private replayDecalTransform(ctx: CanvasRenderingContext2D, args: unknown[]) {
    const rect = this.layersRect;
    ctx.setTransform(1, 0, 0, 1, -rect.x, -rect.y);
    if (args.length >= 6) {
      const [a, b, c, d, e, f] = args as number[];
      ctx.transform(a, b, c, d, e, f);
    } else if (args.length === 1 && args[0]) {
      const m = args[0] as DOMMatrix2DInit;
      ctx.transform(m.a ?? 1, m.b ?? 0, m.c ?? 0, m.d ?? 1, m.e ?? 0, m.f ?? 0);
    }
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
    // Recorded tee decals are part of the state being captured.
    this.flushDecalLog();
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
      layersOrigin: wounds || decals ? { x: this.layersRect.x, y: this.layersRect.y } : null,
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
      // Recorded-but-unlanded tee decals belong to the state being rewound.
      this.discardDecalLog();
      this.clearLayers();
      const extent = checkpoint.wounds ?? checkpoint.decals;
      if (extent) {
        // The checkpoint's buffer rect bounds everything it holds, so it
        // becomes the damage extent: the buffers grow to cover it and
        // `recompose` sweeps exactly that far.
        const origin = checkpoint.layersOrigin ?? { x: 0, y: 0 };
        this.hasDamage = false;
        this.noteDamage(origin.x, origin.y, origin.x + extent.width, origin.y + extent.height);
        this.ensureLayers();
        const rect = this.layersRect;
        for (const [source, target] of [
          [checkpoint.wounds, this.woundsCtx],
          [checkpoint.decals, this.decalsCtx],
        ] as const) {
          if (!source || !target) continue;
          target.save();
          target.setTransform(1, 0, 0, 1, 0, 0);
          target.drawImage(source, origin.x - rect.x, origin.y - rect.y);
          target.restore();
        }
      } else {
        this.hasDamage = false;
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
    if (bounds) {
      this.touch(bounds.x, bounds.y, bounds.x + bounds.w, bounds.y + bounds.h);
    } else {
      this.noteDamage(0, 0, this.surface.width, this.surface.height);
      this.renderer.markAllDirty();
    }
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
    this.ensureLayers(bounds);
    const wctx = this.woundsCtx;
    if (!wctx) return;
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
      this.ensureLayers(bounds);
      const wctx = this.woundsCtx;
      if (wctx) {
        wctx.fillStyle = "#000";
        wctx.fill(path);
      }
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
    // `touchDisc` above already grew the buffers over this disc; the call
    // here only covers the very first damage being a char.
    this.ensureLayers();
    const dctx = this.decalsCtx;
    if (!dctx) return;
    blit(dctx, sprites().char, x, y, r, alpha);
    dctx.globalAlpha = 1;
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

  /** Slice through content along a segment, with either a torn or precise edge. */
  cut(x1: number, y1: number, x2: number, y2: number, options: CutOptions = {}) {
    if (!this.ready) return;
    const clean = options.edge === "clean";
    const lineWidth = Math.max(1, options.width ?? (clean ? 3 : rand(4, 7)));
    const kerf = new Path2D();
    kerf.moveTo(x1, y1);
    kerf.lineTo(x2, y2);
    // A saw tears irregular nicks out beside its blade. A laser gets no
    // randomness at all: one constant-width path is its entire physical edge.
    const len = Math.hypot(x2 - x1, y2 - y1);
    const nicks = new Path2D();
    if (!clean) {
      const steps = Math.max(2, Math.floor(len / 6));
      for (let i = 0; i < steps; i++) {
        const t = i / steps;
        const nx = x1 + (x2 - x1) * t + rand(-3, 3);
        const ny = y1 + (y2 - y1) * t + rand(-3, 3);
        const nr = rand(1, 4);
        nicks.moveTo(nx + nr, ny);
        nicks.arc(nx, ny, nr, 0, TAU);
      }
    }

    const stroke = (ctx: CanvasRenderingContext2D, width = lineWidth) => {
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = width;
      ctx.stroke(kerf);
      ctx.restore();
    };
    const ctx = this.ctx;
    if (clean) {
      // A narrow, even heat-affected rim. Drawing it before removing the core
      // leaves two crisp lips instead of the laser's old sequence of scorch
      // blobs, whose random overlap made a straight drag look ragged.
      ctx.globalCompositeOperation = "source-atop";
      ctx.strokeStyle = "rgba(64, 12, 5, 0.72)";
      stroke(ctx, lineWidth + 5);
      ctx.strokeStyle = "rgba(232, 70, 20, 0.62)";
      stroke(ctx, lineWidth + 2);
    }
    ctx.globalCompositeOperation = "destination-out";
    stroke(ctx);
    if (!clean) ctx.fill(nicks);
    ctx.globalCompositeOperation = "source-over";
    // Torn cuts include the widest nick plus jitter; a precise kerf needs only
    // enough room for its narrow heat rim.
    const reach = clean ? lineWidth / 2 + 3 : lineWidth / 2 + 7;
    const box = {
      x0: Math.min(x1, x2) - reach,
      y0: Math.min(y1, y2) - reach,
      x1: Math.max(x1, x2) + reach,
      y1: Math.max(y1, y2) + reach,
    };
    this.opacity.removeCut(kerf, nicks, lineWidth, box);
    if (this.live) {
      this.ensureLayers(box);
      const wctx = this.woundsCtx;
      if (wctx) {
        wctx.fillStyle = "#000";
        wctx.strokeStyle = "#000";
        stroke(wctx);
        if (!clean) wctx.fill(nicks);
        if (clean) {
          const dctx = this.decalsCtx!;
          dctx.strokeStyle = "rgba(64, 12, 5, 0.72)";
          stroke(dctx, lineWidth + 5);
          dctx.strokeStyle = "rgba(232, 70, 20, 0.62)";
          stroke(dctx, lineWidth + 2);
        }
      }
    }

    this.touch(box.x0, box.y0, box.x1, box.y1);

    if (!clean) {
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      this.char(mx, my, Math.max(10, len * 0.7), 0.3);
    }
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
    const stamp = this.stamp(sw, sh);
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
    // An opaque `destination-out` disc leaves dest·(1−coverage), exactly what
    // the old clip + clearRect pair produced — without the clip, and without
    // the `restore` that dominated broom-drag profiles popping it.
    if (!this.wounds) return;
    for (const cx of [this.woundsCtx!, this.decalsCtx!]) {
      cx.globalCompositeOperation = "destination-out";
      cx.fillStyle = "#000";
      cx.beginPath();
      cx.arc(x, y, r, 0, TAU);
      cx.fill();
      cx.globalCompositeOperation = "source-over";
    }
  }

  /** Grow-and-reuse scratch context for pristine-base stamps (device px). */
  private stamp(sw: number, sh: number): CanvasRenderingContext2D {
    let stamp = this.stampCtx;
    if (!stamp || stamp.canvas.width < sw || stamp.canvas.height < sh) {
      const canvas = stamp?.canvas ?? document.createElement("canvas");
      canvas.width = Math.max(sw, canvas.width);
      canvas.height = Math.max(sh, canvas.height);
      stamp = this.stampCtx = canvas.getContext("2d")!;
    }
    return stamp;
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

    // Clip + one blit of the pristine base. A scratch-canvas mask (compose the
    // disc off-screen, lay it down with `source-atop`) was tried here and lost:
    // the extra clearRect + two blits per call cost ~2.5x what the clip pop
    // does in the flood stress profile.
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
    // is left alone — holes are not wash-away damage. A `destination-out` disc
    // is the old clip + fillRect pair without the clip.
    if (!this.decals) return;
    const cx = this.decalsCtx!;
    cx.globalAlpha = alpha;
    cx.globalCompositeOperation = "destination-out";
    cx.fillStyle = "#000";
    cx.beginPath();
    cx.arc(x, y, r, 0, TAU);
    cx.fill();
    cx.globalAlpha = 1;
    cx.globalCompositeOperation = "source-over";
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
    // A fully repaired page has no damage for the buffers to hold — release
    // them (and any recorded tee decals) instead of merely wiping them.
    this.releaseLayers();
    this.hasDamage = false;
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
    this.releaseLayers();
    if (this.base) {
      this.base.width = 0;
      this.base.height = 0;
      this.base.remove();
      this.base = null;
    }
    this.teeCtx = null;
    this.decalRecorder = null;
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
