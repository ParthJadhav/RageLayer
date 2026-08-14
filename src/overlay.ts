/**
 * Overlay — the DOM the destroyer draws into, and every question about where
 * things are.
 *
 * Layer stack (bottom → top), all in document coordinates:
 *
 * - `voidLayer` — the dark "behind the page" backdrop revealed by holes.
 * - the content canvas — a rasterized copy of the real page, inserted here by
 *   the capture pipeline rather than owned by this class.
 * - `damageCanvas` — persistent overlay decals, and the fallback surface when
 *   page capture is unavailable. Allocated lazily: in content mode nothing
 *   usually draws on it, and a document-sized spare layer costs the compositor
 *   a full set of tiles even when empty.
 * - `fxCanvas` — cleared and redrawn every frame. Unlike the others it is only
 *   *viewport*-sized and rides the scroll position on a compositor-only CSS
 *   transform; effects are simulated in document coordinates and this canvas's
 *   drawing transform maps them into view.
 * - `vignette` — a CSS gradient parked over the viewport that deepens as the
 *   page gets wrecked. Its own compositor layer, animating only `opacity`.
 *
 * The camera shake lives here too, because it is the same thing: a transform on
 * the container. The engine says how hard it was hit; this decides where the
 * pixels end up.
 */

import { pickPixelRatio, RAGELAYER_IGNORE_ATTR } from "./capture";

/** Extra margin (CSS px) drawn beyond the viewport so nothing pops at the edge. */
export const FX_MARGIN = 120;

/** The document band the fx canvas currently covers. */
export interface FxView {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface OverlayOptions {
  zIndex: number;
  /** Suppress camera shake and the vignette's fade transition. */
  reducedMotion: boolean;
  /**
   * `desynchronized` on the fx context. It helps when that canvas is presented
   * directly, but is actively harmful when post-FX uploads it into WebGL:
   * Chrome then has to synchronize two independent IOSurfaces before every
   * `texSubImage2D`. Installations with post-FX off keep the low-latency path.
   */
  desynchronizedFx: boolean;
}

export class Overlay {
  readonly container: HTMLDivElement;
  readonly voidLayer: HTMLDivElement;
  readonly damageCanvas: HTMLCanvasElement;
  readonly fxCanvas: HTMLCanvasElement;
  readonly vignette: HTMLDivElement;
  readonly damageCtx: CanvasRenderingContext2D;
  readonly fxCtx: CanvasRenderingContext2D;

  /** Document size the layers are built for, and their backing-store ratio. */
  width = 0;
  height = 0;
  dpr = 1;
  /** Viewport size the fx canvas is currently sized for, and its own ratio. */
  fxWidth = 0;
  fxHeight = 0;
  fxDpr = 1;
  viewportHeight = 0;
  /**
   * Document offset of the container, captured without forcing layout on every
   * pointer event. Read via the `offsetParent` chain rather than
   * `getBoundingClientRect` for two reasons: it can be cached across pointer
   * events (the container's document anchor only moves on resize), and it
   * ignores the shake transform, which would otherwise make the cursor's hit
   * position jitter along with the screen.
   */
  originX = 0;
  originY = 0;
  /** Where the fx canvas is currently parked. -1 forces the next reposition. */
  fxOffsetX = -1;
  fxOffsetY = -1;

  /** The damage canvas only gets a backing store once something draws on it. */
  private damaged = false;
  private vignetteOffsetX = -1;
  private vignetteOffsetY = -1;
  private vignetteShown = -1;
  private shakeAmount = 0;
  /** Last transform-origin Y written for the shake; it only moves with scroll. */
  private shakeOriginY = -1;
  /** Directional lurch and roll layered on top of the omnidirectional rattle. */
  private kickX = 0;
  private kickY = 0;
  private shakeRoll = 0;
  private readonly reducedMotion: boolean;

  constructor(options: OverlayOptions) {
    this.reducedMotion = options.reducedMotion;

    this.container = document.createElement("div");
    this.container.setAttribute(RAGELAYER_IGNORE_ATTR, "");
    // Pure visual overlay: keep the canvases out of the accessibility tree.
    this.container.setAttribute("aria-hidden", "true");
    Object.assign(this.container.style, {
      position: "absolute",
      top: "0",
      left: "0",
      width: "100%",
      zIndex: String(options.zIndex),
      pointerEvents: "none",
      overflow: "hidden",
    } satisfies Partial<CSSStyleDeclaration>);

    this.voidLayer = document.createElement("div");
    Object.assign(this.voidLayer.style, {
      position: "absolute",
      inset: "0",
      display: "none",
      background:
        "radial-gradient(ellipse 120% 60% at 50% 0%, #17130f 0%, #0c0a08 55%, #060504 100%)",
    } satisfies Partial<CSSStyleDeclaration>);
    this.container.appendChild(this.voidLayer);

    this.damageCanvas = document.createElement("canvas");
    Object.assign(this.damageCanvas.style, {
      position: "absolute",
      top: "0",
      left: "0",
    } satisfies Partial<CSSStyleDeclaration>);
    this.container.appendChild(this.damageCanvas);
    // Start at zero size rather than the 300×150 default — `ensureDamage`
    // gives it a backing store the first time anything draws.
    this.damageCanvas.width = 0;
    this.damageCanvas.height = 0;

    // The raw fx canvas is the zero-cost presentation path; the WebGL chain is
    // created lazily elsewhere. Promoted to its own compositor layer, because
    // it is redrawn every frame and scrolled by transform.
    this.fxCanvas = document.createElement("canvas");
    Object.assign(this.fxCanvas.style, {
      position: "absolute",
      top: "0",
      left: "0",
      willChange: "transform",
      transformOrigin: "0 0",
    } satisfies Partial<CSSStyleDeclaration>);
    this.container.appendChild(this.fxCanvas);

    this.vignette = document.createElement("div");
    Object.assign(this.vignette.style, {
      position: "absolute",
      top: "0",
      left: "0",
      opacity: "0",
      pointerEvents: "none",
      transformOrigin: "0 0",
      willChange: "opacity, transform",
      transition: options.reducedMotion ? "none" : "opacity 0.6s ease-out",
      background:
        "radial-gradient(ellipse 76% 70% at 50% 50%, rgba(0,0,0,0) 32%, rgba(0,0,0,0.45) 74%, rgba(0,0,0,0.88) 100%)",
    } satisfies Partial<CSSStyleDeclaration>);
    this.container.appendChild(this.vignette);

    this.damageCtx = this.damageCanvas.getContext("2d")!;
    this.fxCtx = this.fxCanvas.getContext("2d", {
      desynchronized: options.desynchronizedFx,
    })!;
  }

  mount(target: HTMLElement) {
    target.appendChild(this.container);
  }

  /** Whether anything has ever been painted on the damage canvas. */
  get damageReady(): boolean {
    return this.damaged;
  }

  /** Reveal (or hide) the void backdrop behind the page. */
  showVoid(visible: boolean) {
    this.voidLayer.style.display = visible ? "block" : "none";
  }

  /**
   * Match the layers to a document of `width` × `height`. Returns true when the
   * document's own geometry changed, which invalidates anything indexed off it.
   */
  resize(width: number, height: number, effectsPixelRatio: number): boolean {
    if (width === 0 || height === 0) return false;
    const dpr = pickPixelRatio(width, height);
    if (width === this.width && height === this.height && dpr === this.dpr) {
      this.resizeFx(effectsPixelRatio);
      return false;
    }

    // Preserve existing damage across resizes (top-left anchored). Only
    // meaningful once the damage canvas has actually been allocated — an
    // untouched one has no pixels worth carrying over.
    let previous: HTMLCanvasElement | null = null;
    const previousDpr = this.dpr;
    if (this.damaged) {
      previous = document.createElement("canvas");
      previous.width = this.damageCanvas.width;
      previous.height = this.damageCanvas.height;
      previous.getContext("2d")!.drawImage(this.damageCanvas, 0, 0);
    }

    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.container.style.height = `${height}px`;
    this.measureOrigin();
    this.resizeFx(effectsPixelRatio);

    if (previous) {
      this.damaged = false;
      this.ensureDamage();
      this.damageCtx.drawImage(
        previous,
        0,
        0,
        previous.width / previousDpr,
        previous.height / previousDpr,
      );
      previous.width = 0;
      previous.height = 0;
    }
    return true;
  }

  /**
   * Keep the fx canvas matched to the viewport (not the document). Returns true
   * when its geometry changed, so the caller can re-size anything sampling it.
   */
  resizeFx(effectsPixelRatio: number): boolean {
    const width = document.documentElement.clientWidth;
    this.viewportHeight = window.innerHeight;
    const height = Math.min(this.viewportHeight + FX_MARGIN * 2, this.height + FX_MARGIN * 2);
    const dpr = Math.min(this.dpr, effectsPixelRatio);
    this.vignette.style.width = `${width}px`;
    this.vignette.style.height = `${this.viewportHeight}px`;
    if (width === this.fxWidth && height === this.fxHeight && dpr === this.fxDpr) return false;
    this.fxWidth = width;
    this.fxHeight = height;
    this.fxDpr = dpr;
    this.fxCanvas.width = Math.round(width * dpr);
    this.fxCanvas.height = Math.round(height * dpr);
    this.fxCanvas.style.width = `${width}px`;
    this.fxCanvas.style.height = `${height}px`;
    // Force the transform to be re-applied against the new size.
    this.invalidateFxTransform();
    return true;
  }

  /**
   * Give the damage canvas a real backing store. Deferred until something
   * actually paints on it: with the page capture live every tool draws onto the
   * content canvas instead.
   */
  ensureDamage() {
    if (this.damaged || this.width === 0) return;
    this.damaged = true;
    this.damageCanvas.width = Math.round(this.width * this.dpr);
    this.damageCanvas.height = Math.round(this.height * this.dpr);
    this.damageCanvas.style.width = `${this.width}px`;
    this.damageCanvas.style.height = `${this.height}px`;
    this.damageCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  /** Wipe the overlay decals, if any were ever drawn. */
  clearDamage() {
    if (this.damaged) this.damageCtx.clearRect(0, 0, this.width, this.height);
  }

  /** The next `positionFx` re-applies the transform even if nothing scrolled. */
  invalidateFxTransform() {
    this.fxOffsetX = this.fxOffsetY = -1;
  }

  /**
   * Park the (viewport-sized) fx canvas over the visible band and set up a
   * matching drawing transform, so the renderer keeps working in document
   * coordinates. `presented` is whichever canvas is actually in the DOM — the
   * raw one, or the post-processed output standing in for it.
   */
  positionFx(scrollX: number, scrollY: number, presented: HTMLCanvasElement): FxView {
    const left = Math.max(0, scrollX);
    const top = Math.max(0, scrollY - FX_MARGIN);
    if (left !== this.fxOffsetX || top !== this.fxOffsetY) {
      this.fxOffsetX = left;
      this.fxOffsetY = top;
      // A transform (not `top`/`left`) so scrolling never re-rasters the layer.
      presented.style.transform = `translate3d(${left}px, ${top}px, 0)`;
    }
    // The vignette tracks the viewport itself, not the fx band, so it needs its
    // own offset — `top` is clamped at the top of the document and would stick.
    const vignetteTop = Math.max(0, Math.min(scrollY, this.height - this.viewportHeight));
    if (left !== this.vignetteOffsetX || vignetteTop !== this.vignetteOffsetY) {
      this.vignetteOffsetX = left;
      this.vignetteOffsetY = vignetteTop;
      this.vignette.style.transform = `translate3d(${left}px, ${vignetteTop}px, 0)`;
    }
    const dpr = this.fxDpr;
    this.fxCtx.setTransform(dpr, 0, 0, dpr, -left * dpr, -top * dpr);
    return { left, top, right: left + this.fxWidth, bottom: top + this.fxHeight };
  }

  /** Deepen the vignette. Only ever a CSS opacity change, and only when visible. */
  setVignetteLevel(level: number) {
    const target = Math.min(0.85, level);
    if (Math.abs(target - this.vignetteShown) < 0.02) return;
    this.vignetteShown = target;
    this.vignette.style.opacity = target.toFixed(3);
  }

  /**
   * Kick the camera. `dirX`/`dirY` add a directional lurch on top of the
   * omnidirectional rattle — an impact should shove the page away from the
   * blow, not just vibrate it.
   */
  shake(strength: number, dirX: number, dirY: number) {
    if (this.reducedMotion) return;
    this.shakeAmount = Math.max(this.shakeAmount, strength);
    if (dirX !== 0 || dirY !== 0) {
      const magnitude = Math.hypot(dirX, dirY) || 1;
      this.kickX += (dirX / magnitude) * strength * 0.5;
      this.kickY += (dirY / magnitude) * strength * 0.5;
    }
    // A little roll on every hit: pure translation reads as a rattle, a tilt
    // reads as the page taking the blow.
    this.shakeRoll += (Math.random() - 0.5) * strength * 0.00035;
  }

  /** True while the camera is still moving (keeps the frame loop alive). */
  get isShaking(): boolean {
    return (
      this.shakeAmount > 0.2 ||
      Math.abs(this.kickX) >= 0.15 ||
      Math.abs(this.kickY) >= 0.15 ||
      Math.abs(this.shakeRoll) >= 0.00012
    );
  }

  /** Advance the shake and write it to the container transform. */
  stepShake(dt: number, scrollY: number) {
    if (!this.isShaking) {
      if (this.container.style.transform) {
        this.container.style.transform = "";
        this.shakeAmount = 0;
        this.kickX = this.kickY = this.shakeRoll = 0;
      }
      return;
    }
    const s = this.shakeAmount;
    const tx = (Math.random() - 0.5) * s + this.kickX;
    const ty = (Math.random() - 0.5) * s + this.kickY;
    const roll = this.shakeRoll + (Math.random() - 0.5) * s * 0.00022;
    // Pivot around the middle of what the user is looking at. The container
    // spans the whole document, so the default 50%/50% origin would swing the
    // top of a long page by tens of pixels for a fraction of a degree. The
    // origin only moves with scroll, so skip the style write while it holds.
    const originY = scrollY + this.viewportHeight * 0.5;
    if (originY !== this.shakeOriginY) {
      this.shakeOriginY = originY;
      this.container.style.transformOrigin = `50% ${originY}px`;
    }
    this.container.style.transform = `translate(${tx}px, ${ty}px) rotate(${roll}rad)`;
    const decay = Math.exp(-dt * 14);
    this.shakeAmount *= decay;
    this.kickX *= decay;
    this.kickY *= decay;
    // The roll unwinds more slowly than the rattle, so a big hit leaves the
    // page visibly tilting back rather than snapping straight.
    this.shakeRoll *= Math.exp(-dt * 8);
  }

  /** Re-read the container's document anchor (only moves on reflow). */
  measureOrigin() {
    let x = 0;
    let y = 0;
    let element: HTMLElement | null = this.container;
    while (element) {
      x += element.offsetLeft;
      y += element.offsetTop;
      element = element.offsetParent as HTMLElement | null;
    }
    this.originX = x;
    this.originY = y;
  }

  /**
   * Release everything. A detached high-DPI canvas keeps its whole pixel
   * backing until it is reset, so zeroing the sizes matters even though the
   * elements are about to be dropped.
   */
  dispose() {
    this.damageCanvas.width = 0;
    this.damageCanvas.height = 0;
    this.fxCanvas.width = 0;
    this.fxCanvas.height = 0;
    this.damaged = false;
    this.container.remove();
    this.container.replaceChildren();
  }
}
