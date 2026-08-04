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
 */

import { pickPixelRatio, pinFixedDescendants, type PageBackdrop } from "./capture";
import { blit, sprites } from "./sprites";
import type { ContentPatch } from "./types";

export type { ContentPatch };

const TAU = Math.PI * 2;

function rand(min: number, max: number) {
  return min + Math.random() * (max - min);
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
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
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
  /** Whether this layer keeps a refreshable base (see `wounds`). */
  live = false;
  dpr = 1;
  width = 0;
  height = 0;
  ready = false;

  constructor() {
    this.canvas = document.createElement("canvas");
    Object.assign(this.canvas.style, {
      position: "absolute",
      top: "0",
      left: "0",
    } satisfies Partial<CSSStyleDeclaration>);
    this.ctx = this.canvas.getContext("2d")!;
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
    filter: (node: HTMLElement) => boolean,
    options: CaptureOptions = {},
  ) {
    const { toCanvas } = await import("html-to-image");
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
        style: { ...backdrop.image, ...options.rootSize } as unknown as Partial<CSSStyleDeclaration>,
      });
    } finally {
      unpin();
    }

    // Compose: backdrop across the whole layer, then the raster at the root's
    // document offset. Anything outside the root's box (body margins, a
    // reserved scrollbar gutter) keeps the page backdrop instead of falling
    // through to the void.
    const snap = document.createElement("canvas");
    snap.width = Math.round(width * this.dpr);
    snap.height = Math.round(height * this.dpr);
    const sctx = snap.getContext("2d")!;
    if (backdrop.color) {
      sctx.fillStyle = backdrop.color;
      sctx.fillRect(0, 0, snap.width, snap.height);
    }
    sctx.drawImage(raster, Math.round(source.x * this.dpr), Math.round(source.y * this.dpr));

    this.adopt(snap, width, height);
  }

  /**
   * Install `raster` as the pristine base and show it. Shared by both capture
   * modes — the html-to-image path composes its raster first, the live path
   * hands one straight over.
   */
  adopt(raster: HTMLCanvasElement, width: number, height: number) {
    // A full re-capture (first run, or a reflow) starts from an intact page, so
    // any accumulated wounds are stale — and possibly the wrong size.
    this.wounds = this.decals = null;
    this.woundsCtx = this.decalsCtx = null;
    this.base = raster;
    this.width = width;
    this.height = height;
    this.canvas.width = raster.width;
    this.canvas.height = raster.height;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.drawImage(raster, 0, 0);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ready = true;
  }

  /**
   * Live mode: swap in freshly captured page pixels while keeping every wound.
   * No-op unless the new raster matches the current geometry — a size change
   * means the page reflowed and the engine re-captures from scratch instead.
   */
  refreshBase(raster: HTMLCanvasElement) {
    if (!this.ready || !this.live) return;
    if (raster.width !== this.canvas.width || raster.height !== this.canvas.height) return;
    this.base = raster;
    this.recompose();
  }

  /** Rebuild the visible canvas from base + decals + wounds (live mode only). */
  private recompose() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.base!, 0, 0);
    // Char marks first, clipped to surviving pixels; then remove the holes.
    // The other order would let a hole's rim char paint over the void.
    if (this.decals) {
      ctx.globalCompositeOperation = "source-atop";
      ctx.drawImage(this.decals, 0, 0);
    }
    if (this.wounds) {
      ctx.globalCompositeOperation = "destination-out";
      ctx.drawImage(this.wounds, 0, 0);
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
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
      c.width = this.canvas.width;
      c.height = this.canvas.height;
      const cx = c.getContext("2d")!;
      cx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      return [c, cx] as const;
    };
    [this.wounds, this.woundsCtx] = make();
    [this.decals, this.decalsCtx] = make();
  }

  /**
   * Remove `path` from the content.
   *
   * The randomised geometry is built into a `Path2D` once and replayed against
   * both targets, so the visible canvas (immediate feedback) and the wound mask
   * (which survives a live refresh) can never drift apart.
   */
  private carve(path: Path2D) {
    const ctx = this.ctx;
    // Composite mode is set and reset by hand rather than via save/restore:
    // these run against a document-sized canvas many times a second while fire
    // is spreading, and a full state push/pop per wound is pure overhead.
    ctx.globalCompositeOperation = "destination-out";
    ctx.fill(path);
    ctx.globalCompositeOperation = "source-over";
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
    this.carve(path);
    this.char(x, y, r * 1.9, 0.45);
  }

  /** Darken surviving pixels around a wound (charred/bruised rim). */
  char(x: number, y: number, r: number, alpha: number) {
    if (!this.ready) return;
    const ctx = this.ctx;
    ctx.globalCompositeOperation = "source-atop";
    blit(ctx, sprites().char, x, y, r, alpha);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
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
    this.carve(path);
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
    if (this.live) {
      this.ensureLayers();
      const wctx = this.woundsCtx!;
      wctx.fillStyle = "#000";
      wctx.strokeStyle = "#000";
      stroke(wctx);
      wctx.fill(nicks);
    }

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

    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.clip();
    ctx.clearRect(x0, y0, w, h);
    ctx.drawImage(this.base, x0 * d, y0 * d, w * d, h * d, x0, y0, w, h);
    ctx.restore();

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

  /** Repair everything. */
  restoreAll() {
    if (!this.ready || !this.base) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();
    ctx.drawImage(this.base, 0, 0, this.width, this.height);
    this.clearLayers();
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
    this.ready = false;
    this.base = null;
    this.wounds = this.decals = null;
    this.woundsCtx = this.decalsCtx = null;
    this.canvas.remove();
  }
}
