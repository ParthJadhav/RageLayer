import { SoundEngine } from "./audio";
import {
  DD_IGNORE_ATTR,
  defaultCaptureFilter,
  measureCapture,
  pickPixelRatio,
  resolvePageBackdrop,
} from "./capture";
import { ContentLayer } from "./content";
import { drawPaintStreak, drawScorch } from "./decals";
import { elementAt, elementsInBand, harvestElements, type PageElement } from "./elements";
import {
  type ChunkSource,
  convexHull,
  gridCells,
  makeChunk,
  shardBudget,
  voronoiCells,
} from "./fracture";
import { LiveContentSource, supportsLiveCapture } from "./live";
import {
  detectInitialQuality,
  PerformanceMonitor,
  QUALITY_PROFILES,
  type QualityProfile,
} from "./performance";
import { MAX_BODIES, PhysicsWorld } from "./physics";
import { PostFX } from "./postfx";
import { blit, blitRect, blitStreak, sprites } from "./sprites";
import { DEFAULT_SURFACE_PARAMS, type SurfaceParams } from "./surface";
import { buildTextMask } from "./textmask";
import type {
  CaptureMode,
  CaptureStatus,
  ContentApi,
  DestroyerEngineApi,
  DestroyerOptions,
  EngineEvent,
  ExplodeOptions,
  Flame,
  FractureOptions,
  Particle,
  PerformanceQuality,
  PerformanceQualityTier,
  PerformanceSnapshot,
  Singularity,
  Tool,
  Vec2,
} from "./types";

const TAU = Math.PI * 2;

export { DD_IGNORE_ATTR };

const MAX_CAPTURE_HEIGHT = 12000;
/** Extra margin (CSS px) drawn beyond the viewport so nothing pops at the edge. */
const FX_MARGIN = 120;
/**
 * Frost is tracked on a coarse document-wide grid rather than per pixel: the
 * only questions asked of it are "does fire take here" and "does this shatter
 * like glass", and both are regional.
 */
const FROST_CELL = 32;
/** The heat field feeding the shimmer shader, as a fraction of the fx canvas. */
const HEAT_SCALE = 8;
/**
 * Wood-fuel grid resolution, CSS px per cell.
 *
 * Fire treats the page as material with finite fuel rather than an infinite
 * wick: each cell holds a store that burning consumes, flames starve where it
 * runs out, and spread only takes hold where fuel remains. Coarse cells are
 * enough — the questions asked are "can fire live here" and "how hungry is
 * it", both regional, same reasoning as the frost grid.
 */
const FUEL_CELL = 26;
/** Crawling-bug population cap. */
const MAX_BUGS = 36;

/** One crawling bug: position, heading, and an appetite timer. */
interface BugState {
  x: number;
  y: number;
  /** Heading, radians. */
  a: number;
  speed: number;
  size: number;
  ttl: number;
  /** Countdown to the next bite taken out of the page. */
  chew: number;
  /** Countdown to the next deliberate change of direction. */
  turn: number;
  seed: number;
}

/**
 * Radius (CSS px) around the cursor re-shaded every frame a tool is held down.
 *
 * The content surface re-uploads by dirty rectangle, and a tool painting a
 * decal straight into `surfaceCtx` never tells it which pixels moved. Rather
 * than make that bookkeeping every tool author's problem, the engine assumes
 * anything a held tool paints lands within this reach of the pointer — true of
 * every built-in decal, and cheap enough to pay unconditionally. Marks that
 * land further out (paint splashes, lightning channels) call `markSurface`.
 */
const TOOL_DECAL_REACH = 96;

/**
 * DestroyerEngine owns the overlay DOM, the rAF loop, pointer input, and all
 * simulation state. It is framework-agnostic: the React wrapper is a thin
 * lifecycle shim around this class.
 *
 * Layer stack (bottom → top), all in document coordinates:
 * - `void` div: the dark "behind the page" backdrop revealed by holes.
 * - `content` canvas: rasterized copy of the real page (the destructible
 *   surface). While it's live the real DOM is hidden via `visibility` so
 *   layout and scrolling survive; destruction removes actual content pixels.
 * - `damage` canvas: persistent overlay decals (also the fallback surface
 *   when content capture is unavailable). Allocated lazily — in content mode
 *   nothing usually draws here, and a document-sized spare layer is expensive
 *   for the compositor even when it is empty.
 * - `fx` canvas: cleared and redrawn every frame (flames, smoke, particles,
 *   flying shards of page content). Unlike the others this one is only
 *   *viewport*-sized and rides the scroll position via a compositor-only CSS
 *   transform; particles are simulated in document coordinates and the canvas
 *   transform maps them into view.
 */
/**
 * Wrap a context so `source-atop` degrades to plain drawing.
 *
 * Decals hard-code `source-atop` — a mark is damage to the page, so it can only
 * exist where page pixels do (see decals.ts). The overlay damage canvas has no
 * page pixels at all: it is a transparent sheet over the intact DOM, used when
 * capture is off, and atop against it would draw nothing. There is also no void
 * to respect there — the page underneath is whole — so the translation loses
 * nothing. Mirrors the atop→over translation `teeContexts` does for live
 * mode's transparent decals buffer.
 */
function atopAsOver(ctx: CanvasRenderingContext2D): CanvasRenderingContext2D {
  return new Proxy(ctx, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, prop, value) {
      Reflect.set(
        target,
        prop,
        prop === "globalCompositeOperation" && value === "source-atop" ? "source-over" : value,
      );
      return true;
    },
  });
}

export class DestroyerEngine implements DestroyerEngineApi {
  readonly container: HTMLDivElement;
  readonly sound = new SoundEngine();
  /** Rigid-body debris: chunks of page that have physically come off. */
  readonly physics: PhysicsWorld;
  flames: Flame[] = [];

  /** Document-space rects of the real page's furniture (see `elements.ts`). */
  pageElements: PageElement[] = [];

  private voidLayer: HTMLDivElement;
  private contentLayer: ContentLayer | null = null;
  /** Shader settings for the destructible surface, applied on every capture. */
  private surfaceParams: SurfaceParams = { ...DEFAULT_SURFACE_PARAMS };
  /** False when the host asked for `surface: false` — mount the 2D canvas raw. */
  private surfaceShading = true;
  private contentRoot: HTMLElement | null = null;
  private prevRootVisibility: string | null = null;
  private damageCanvas: HTMLCanvasElement;
  private fxCanvas: HTMLCanvasElement;
  /** Viewport-parked darkening that deepens as the page gets wrecked. */
  private vignette: HTMLDivElement;
  private _damageCtx: CanvasRenderingContext2D;
  /** `_damageCtx` behind the atop→over wrapper; what the getters hand out. */
  private _damageToolCtx: CanvasRenderingContext2D | null = null;
  private _fxCtx: CanvasRenderingContext2D;
  /** The damage canvas only gets a backing store once something draws on it. */
  private damageReady = false;
  private particles: Particle[] = [];
  /** Round-robin slot to recycle when the particle cap is reached. */
  private recycleCursor = 0;
  /** Flat x,y pairs for splashes queued during the particle step. */
  private pendingSplashes: number[] = [];
  /** Paint drips that finished sliding this frame and owe the page a streak. */
  private pendingStamps: Particle[] = [];
  /** Per-frame render buckets, reused to keep the render path allocation-free. */
  private bucketWet: Particle[] = [];
  private bucketPuff: Particle[] = [];
  private bucketBit: Particle[] = [];
  private bucketHot: Particle[] = [];
  private tools = new Map<string, Tool>();
  private activeTool: Tool | null = null;
  private pointer: Vec2 = { x: -1000, y: -1000 };
  private lastPointer: Vec2 = { x: -1000, y: -1000 };
  private pointerDown = false;
  // ── Tool-art pose state ────────────────────────────────────────────────────
  // Everything the drawn-tool renderings derive their animation from: press/
  // release timestamps (seconds, on the rAF clock) and a smoothed read of
  // pointer motion. See `renderToolArt`.
  private artDownAt = -Infinity;
  private artUpAt = -Infinity;
  private artVX = 0;
  private artVY = 0;
  private artAimX = -0.55;
  private artAimY = -0.835;
  private artPrev: Vec2 = { x: -1000, y: -1000 };
  private raf = 0;
  private lastTime = 0;
  private lastRenderedAt = 0;
  private monitor: PerformanceMonitor;
  private qualityMode: PerformanceQuality;
  private qualityTier: PerformanceQualityTier;
  private qualityProfile: QualityProfile;
  private shakeAmount = 0;
  /** Directional lurch and roll layered on top of the omnidirectional rattle. */
  private kickX = 0;
  private kickY = 0;
  private shakeRoll = 0;
  /**
   * 0..1 running total of how wrecked the page is, fed by every `shake()` (which
   * every destructive tool already calls, scaled by how hard it hit). Drives the
   * vignette; repairs walk it back.
   */
  private destruction = 0;
  private vignetteShown = -1;
  /** Rate gates so repeated impacts don't stack into a buzz. */
  private nextTink = 0;
  private nextHiss = 0;
  private nextPop = 0;
  private dpr = 1;
  private w = 0;
  private h = 0;
  /** Viewport size the fx canvas is currently sized for. */
  private fxW = 0;
  private fxH = 0;
  private viewportH = 0;
  private fxOffsetX = -1;
  private fxOffsetY = -1;
  private vignetteOffsetX = -1;
  private vignetteOffsetY = -1;
  /** Whether the last frame put anything on the fx canvas (drives clear skips). */
  private fxPainted = false;
  /**
   * Cached scroll offset. Reading `window.scrollY` inside the render loop
   * forces a style/layout flush, because the previous frame's shake transform
   * is still pending — so it is tracked from a passive scroll listener, which
   * Chrome dispatches before rAF callbacks, instead.
   */
  private scrollX = 0;
  private scrollY = 0;
  /**
   * Document offset of the overlay container, captured without forcing layout
   * on every pointer event. See `toolEvent`.
   */
  private originX = 0;
  private originY = 0;
  private disposed = false;
  private listeners = new Map<EngineEvent, Set<() => void>>();
  private resizeTimer = 0;
  private capturing = false;
  private captureFilter: (node: HTMLElement) => boolean;
  /** Non-null only while live mode is actually in use. */
  private liveSource: LiveContentSource | null = null;
  private refreshTimer = 0;
  private refreshing = false;
  private _captureStatus: CaptureStatus = "idle";
  private _liveUnavailable = false;
  /** Post-processing chain. Null when disabled or WebGL is unavailable. */
  private postfx: PostFX | null = null;
  /** Whether the selected quality profile allows post-processing work. */
  private postfxEnabled = false;
  /** The GL output is mounted. False uses the identical plain 2D effects canvas. */
  private postfxActive = false;
  /** Avoid retrying a WebGL setup that already failed on this device. */
  private postfxTried = false;
  /** Post-FX slice of the most recent render, for the performance breakdown. */
  private postFXFrameMs = 0;
  /** Low-res heat field sampled by the shimmer shader. */
  private heatCanvas: HTMLCanvasElement | null = null;
  private heatCtx: CanvasRenderingContext2D | null = null;
  /** Whether the heat field has anything in it (skips an upload when cold). */
  private heatLevel = 0;
  /** Coarse frost grid over the document; lazily allocated on first freeze. */
  private frost: Float32Array | null = null;
  private frostCols = 0;
  private frostRows = 0;
  private _singularity: Singularity | null = null;
  /** Countdown to the singularity's next bite out of the page. */
  private singularityBite = 0;
  /** Countdown to the next page element the singularity rips loose. */
  private singularityFeed = 0;
  /** Wood fuel per grid cell, 0..255. Built lazily at the first flame. */
  private fuel: Uint8Array | null = null;
  private fuelCols = 0;
  private fuelRows = 0;
  /** Crawling bugs eating the page. */
  private bugs: BugState[] = [];
  /** Fractional accumulator for infalling-matter strands. */
  private spaghettiDebt = 0;
  /** Elements still queued to fall during a `collapse()`. */
  private collapseQueue: PageElement[] = [];
  private collapseTimer = 0;
  private opts: Required<
    Pick<
      DestroyerOptions,
      | "zIndex"
      | "maxFlames"
      | "maxParticles"
      | "captureContent"
      | "captureMode"
      | "liveRefreshMs"
      | "physics"
      | "postFX"
      | "harvestElements"
      | "textMask"
      | "toolStyle"
    >
  >;

  constructor(options: DestroyerOptions = {}) {
    this.qualityMode = options.quality ?? "auto";
    this.qualityTier = detectInitialQuality(this.qualityMode);
    this.qualityProfile = QUALITY_PROFILES[this.qualityTier];
    this.monitor = new PerformanceMonitor(
      options.performance,
      this.qualityTier,
      this.qualityMode === "auto",
    );
    this.opts = {
      zIndex: options.zIndex ?? 2147483000,
      // 32, down from 48: fire cost scales with the flame count (each flame is
      // ~9 blits a frame plus its own smoke budget), and a 32-flame blaze
      // already fills a viewport. The last 16 bought lag, not spectacle.
      maxFlames: options.maxFlames ?? 32,
      // Raised alongside the effects overhaul: jets, dust and rolling smoke all
      // want population, and the render path measures at a fraction of budget.
      maxParticles: options.maxParticles ?? 1400,
      captureContent: options.captureContent ?? true,
      captureMode: options.captureMode ?? "auto",
      liveRefreshMs: options.liveRefreshMs ?? 1000,
      physics: options.physics ?? true,
      postFX: options.postFX ?? true,
      harvestElements: options.harvestElements ?? true,
      textMask: options.textMask ?? true,
      toolStyle: options.toolStyle ?? "3d",
    };
    if (options.surface === false) this.surfaceShading = false;
    else if (options.surface) {
      // Applied before the first capture, so the very first frame is shaded the
      // way the host asked for rather than snapping to it a frame later.
      this.surfaceParams = { ...DEFAULT_SURFACE_PARAMS, ...options.surface };
    }
    this.physics = new PhysicsWorld({
      gravity: options.gravity,
      iterations: this.qualityProfile.physicsIterations,
    });
    this.physics.setBodyLimit(Math.max(24, Math.round(MAX_BODIES * this.qualityProfile.bodyScale)));
    // Asked for live on a browser without the flag: record it up front so the
    // toolbar can say *why* it is in snapshot mode.
    this._liveUnavailable = this.opts.captureMode === "live" && !supportsLiveCapture();
    this.captureFilter = options.captureFilter ?? defaultCaptureFilter;
    this.sound.enabled = options.soundEnabled ?? true;
    this.contentRoot = options.contentRoot ?? document.body;

    this.container = document.createElement("div");
    this.container.setAttribute(DD_IGNORE_ATTR, "");
    // Pure visual overlay: keep the canvases out of the accessibility tree.
    this.container.setAttribute("aria-hidden", "true");
    Object.assign(this.container.style, {
      position: "absolute",
      top: "0",
      left: "0",
      width: "100%",
      zIndex: String(this.opts.zIndex),
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
    this.fxCanvas = document.createElement("canvas");
    Object.assign(this.damageCanvas.style, {
      position: "absolute",
      top: "0",
      left: "0",
    } satisfies Partial<CSSStyleDeclaration>);
    this.container.appendChild(this.damageCanvas);
    // Start the damage canvas at zero size rather than the 300×150 default —
    // `ensureDamage` gives it a backing store the first time anything draws.
    this.damageCanvas.width = 0;
    this.damageCanvas.height = 0;

    // The raw FX canvas is the zero-cost presentation path. The WebGL chain is
    // created lazily when a tool is selected or effects are spawned, so merely
    // opening the destroyer does not compile shaders and allocate another set
    // of viewport-sized buffers.
    Object.assign(this.fxCanvas.style, {
      position: "absolute",
      top: "0",
      left: "0",
    } satisfies Partial<CSSStyleDeclaration>);
    this.container.appendChild(this.fxCanvas);
    // The fx canvas is re-drawn every frame and only ever shows the viewport,
    // so it is promoted to its own compositor layer and scrolled by transform.
    Object.assign(this.fxCanvas.style, {
      willChange: "transform",
      transformOrigin: "0 0",
    } satisfies Partial<CSSStyleDeclaration>);

    // Global "this page has been through something" darkening. A CSS gradient
    // on its own compositor layer, parked over the viewport exactly like the fx
    // canvas: no per-frame canvas fill, and it only ever animates `opacity`.
    this.vignette = document.createElement("div");
    Object.assign(this.vignette.style, {
      position: "absolute",
      top: "0",
      left: "0",
      opacity: "0",
      pointerEvents: "none",
      transformOrigin: "0 0",
      willChange: "opacity, transform",
      transition: "opacity 0.6s ease-out",
      background:
        "radial-gradient(ellipse 76% 70% at 50% 50%, rgba(0,0,0,0) 32%, rgba(0,0,0,0.45) 74%, rgba(0,0,0,0.88) 100%)",
    } satisfies Partial<CSSStyleDeclaration>);
    this.container.appendChild(this.vignette);
    this._damageCtx = this.damageCanvas.getContext("2d")!;
    // `desynchronized` helps when this canvas is presented directly, but it is
    // actively harmful when post-FX uploads the canvas into WebGL: Chrome has
    // to synchronize two independent IOSurfaces before every texSubImage2D.
    // Keep one compositor-owned surface for post-FX installations; packages
    // with post-FX disabled still get the low-latency direct-present path.
    this._fxCtx = this.fxCanvas.getContext("2d", { desynchronized: !this.opts.postFX })!;

    (options.target ?? document.body).appendChild(this.container);
    this.resize();
    this.onScroll();
    window.addEventListener("resize", this.onWindowResize);
    window.addEventListener("scroll", this.onScroll, { passive: true });

    this.container.addEventListener("pointerdown", this.onPointerDown);
    this.container.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    this.container.addEventListener("pointerleave", this.onPointerLeave);
    this.container.addEventListener("contextmenu", this.onContextMenu);

    this.lastTime = performance.now();
    this.requestFrame();

    if (this.opts.captureContent) {
      void this.captureContent();
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  get width() {
    return this.w;
  }
  get height() {
    return this.h;
  }
  get damageCtx() {
    this.ensureDamage();
    return (this._damageToolCtx ??= atopAsOver(this._damageCtx));
  }
  get fxCtx() {
    return this._fxCtx;
  }
  get surfaceCtx() {
    // `toolCtx`, not `ctx`: in live mode it tees every mark into the decals
    // buffer as well, which is what lets a crack outlive the next base refresh.
    if (this.contentLayer?.ready) return this.contentLayer.toolCtx;
    return this.damageCtx;
  }
  get content(): ContentApi | null {
    return this.contentLayer?.ready ? this.contentLayer : null;
  }
  get performanceSnapshot(): PerformanceSnapshot {
    return this.monitor.snapshot;
  }
  onPerformance(callback: (snapshot: PerformanceSnapshot) => void): () => void {
    return this.monitor.onSample(callback);
  }

  /**
   * Content alpha (0..1) at a document point — 1 where the page survives, 0 in
   * the void. Reports 1 when capture is off: without a destructible surface
   * there are no holes, so nothing is void.
   */
  pageOpacityAt(x: number, y: number): number {
    return this.contentLayer?.ready ? this.contentLayer.opacityAt(x, y) : 1;
  }

  /**
   * Whether the page still exists at (x, y).
   *
   * This is the question every tool asks before doing surface work. The void
   * is empty space: a hammer swung at a hole meets nothing, a paintball sails
   * through it, a saw spins free in it. Acting there produces no mark, no
   * impact, and no sound of contact — only airborne things (a tracer, smoke,
   * a passing bolt) belong in front of a hole.
   */
  onPage(x: number, y: number, threshold = 0.3): boolean {
    return this.pageOpacityAt(x, y) >= threshold;
  }

  /**
   * Tell the content surface that a tool painted into `surfaceCtx` at (x, y).
   *
   * Only needed for marks that land more than `TOOL_DECAL_REACH` from the
   * cursor — everything drawn under the pointer is covered automatically.
   * A no-op when the page is presented without the shader.
   */
  markSurface(x: number, y: number, radius: number) {
    this.contentLayer?.markSurface(x, y, radius);
    this.requestFrame();
  }

  /**
   * As `markSurface`, for a mark that runs along a segment — a stroke, a bolt.
   *
   * Prefer this over a disc per point: a long straight run between two points is
   * not covered by discs at its ends, and an unmarked stretch is one that never
   * reaches the screen until the next reconcile.
   */
  markSurfaceSegment(x1: number, y1: number, x2: number, y2: number, radius: number) {
    this.contentLayer?.markSurfaceSegment(x1, y1, x2, y2, radius);
    this.requestFrame();
  }

  /**
   * What the capture pipeline is doing. Changes fire a `"statuschange"` event,
   * which is what the toolbar's status chip listens to.
   */
  get captureStatus(): CaptureStatus {
    return this._captureStatus;
  }

  /** Live mode was requested but the experimental API isn't available. */
  get liveUnavailable(): boolean {
    return this._liveUnavailable;
  }

  /** The mode that was asked for (not necessarily the one in use). */
  get captureMode(): CaptureMode {
    return this.opts.captureMode;
  }

  /**
   * Live mode: re-capture the page now, keeping every wound. No-op in snapshot
   * mode, or while a capture/refresh is already in flight.
   */
  refreshContent(): Promise<void> {
    return this.refreshLive();
  }

  registerTool(tool: Tool) {
    this.tools.set(tool.id, tool);
  }

  getTools(): Tool[] {
    return [...this.tools.values()];
  }

  get tool(): Tool | null {
    return this.activeTool;
  }

  setTool(id: string | null) {
    const next = id ? (this.tools.get(id) ?? null) : null;
    if (next === this.activeTool) return;
    if (this.pointerDown && this.activeTool?.onUp) {
      this.activeTool.onUp(this, { ...this.pointer, dx: 0, dy: 0, buttons: 0 });
    }
    this.pointerDown = false;
    this.activeTool = next;
    this.container.style.pointerEvents = next ? "auto" : "none";
    // A tool with drawn art becomes its own cursor; the CSS one would be a
    // second, emoji-sized tool floating over the real one. In `"emoji"` tool
    // style the art never draws, so the CSS cursor stays in charge.
    const drawn = next?.art && this.opts.toolStyle === "3d";
    this.container.style.cursor = next ? (drawn ? "none" : (next.cursor ?? "crosshair")) : "";
    this.container.style.touchAction = next ? "none" : "";
    // Tool selection precedes the first destructive pointer action, making it
    // a safe time to warm the quality-preserving post-FX path without charging
    // the opening or capture path for it.
    if (next && this.opts.postFX && this.qualityProfile.postFX) this.setPostFXEnabled(true);
    this.emit("toolchange");
    this.requestFrame();
  }

  clear() {
    if (this.damageReady) this._damageCtx.clearRect(0, 0, this.w, this.h);
    this.contentLayer?.restoreAll();
    this.flames = [];
    this.particles.length = 0;
    this.destruction = 0;
    this.physics.clear();
    this.frost = null;
    // Repaired page, fresh wood: the fuel comes back with the pixels.
    this.fuel?.fill(255);
    this.bugs = [];
    this._singularity = null;
    this.collapseQueue.length = 0;
    // Elements go back on the board — the page they described is whole again.
    for (const el of this.pageElements) el.taken = false;
    this.emit("clear");
    this.requestFrame();
  }

  setSound(enabled: boolean) {
    this.sound.enabled = enabled;
    if (!enabled) {
      this.sound.loop("fire", 0);
      this.sound.loop("water", 0);
      this.sound.loop("saw", 0);
      this.sound.loop("flamethrower", 0);
      this.sound.loop("void", 0);
    }
  }

  /**
   * Composite the visible wreckage into a standalone image: the void backdrop,
   * the destroyed page, overlay decals, and the live effects layer, flattened
   * into one viewport-sized canvas.
   *
   * Deliberately not `html-to-image` again — everything needed is already
   * rasterized, so this is four blits and a `toBlob`.
   */
  async snapshot(type = "image/png"): Promise<Blob | null> {
    const w = Math.min(this.w, document.documentElement.clientWidth);
    const h = Math.min(this.h, this.viewportH);
    if (w <= 0 || h <= 0) return null;
    const out = document.createElement("canvas");
    out.width = Math.round(w * this.dpr);
    out.height = Math.round(h * this.dpr);
    const ctx = out.getContext("2d");
    if (!ctx) return null;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const sx = this.scrollX;
    const sy = Math.max(0, Math.min(this.scrollY, this.h - h));

    // The void behind the page, so holes read as holes and not as transparency.
    const bg = ctx.createRadialGradient(w / 2, 0, 0, w / 2, 0, Math.max(w, h) * 1.2);
    bg.addColorStop(0, "#17130f");
    bg.addColorStop(0.55, "#0c0a08");
    bg.addColorStop(1, "#060504");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    const layer = this.contentLayer;
    if (layer?.ready) {
      const d = layer.dpr;
      ctx.drawImage(layer.canvas, sx * d, sy * d, w * d, h * d, 0, 0, w, h);
    }
    if (this.damageReady) {
      const d = this.dpr;
      ctx.drawImage(this.damageCanvas, sx * d, sy * d, w * d, h * d, 0, 0, w, h);
    }
    // The effects layer is viewport-parked, so its source rect is relative to
    // wherever `positionFx` last left it.
    const presented = this.postfxActive ? this.postfx!.canvas : this.fxCanvas;
    if (this.fxPainted && presented.width > 0) {
      const d = this.dpr;
      ctx.drawImage(
        presented,
        (sx - this.fxOffsetX) * d,
        (sy - this.fxOffsetY) * d,
        w * d,
        h * d,
        0,
        0,
        w,
        h,
      );
    }

    return new Promise((resolve) => out.toBlob(resolve, type));
  }

  on(event: EngineEvent, cb: () => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(cb);
    return () => set.delete(cb);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    window.clearTimeout(this.resizeTimer);
    window.clearTimeout(this.refreshTimer);
    this.resizeTimer = 0;
    this.refreshTimer = 0;
    window.removeEventListener("resize", this.onWindowResize);
    window.removeEventListener("scroll", this.onScroll);
    window.removeEventListener("pointerup", this.onPointerUp);
    this.container.removeEventListener("pointerdown", this.onPointerDown);
    this.container.removeEventListener("pointermove", this.onPointerMove);
    this.container.removeEventListener("pointerleave", this.onPointerLeave);
    this.container.removeEventListener("contextmenu", this.onContextMenu);
    this.exitContentMode();
    this.contentLayer?.dispose();
    this.contentLayer = null;
    this.liveSource?.dispose();
    this.liveSource = null;
    this.physics.clear();
    this.postfx?.dispose();
    this.postfx = null;
    this.setStatus("idle");
    this.container.remove();
    this.container.replaceChildren();
    this.sound.dispose();
    this.emit("dispose");
    this.listeners.clear();
    this.monitor.dispose();

    // `dispose` must release the expensive state even when application code
    // intentionally keeps the engine object for inspection. In particular, a
    // detached high-DPI canvas keeps its whole pixel backing until it is reset.
    this.damageCanvas.width = 0;
    this.damageCanvas.height = 0;
    this.fxCanvas.width = 0;
    this.fxCanvas.height = 0;
    if (this.heatCanvas) {
      this.heatCanvas.width = 0;
      this.heatCanvas.height = 0;
      this.heatCanvas.remove();
    }
    this.heatCanvas = null;
    this.heatCtx = null;
    this.damageReady = false;
    this.fxPainted = false;

    this.flames.length = 0;
    this.particles.length = 0;
    this.pendingSplashes.length = 0;
    this.pendingStamps.length = 0;
    this.bucketWet.length = 0;
    this.bucketPuff.length = 0;
    this.bucketBit.length = 0;
    this.bucketHot.length = 0;
    this.bugs.length = 0;
    this.collapseQueue.length = 0;
    this.pageElements.length = 0;
    this.tools.clear();
    this.activeTool = null;
    this.pointerDown = false;
    this.frost = null;
    this.fuel = null;
    this._singularity = null;
    this.contentRoot = null;
    this.prevRootVisibility = null;
    this.captureFilter = defaultCaptureFilter;
  }

  // ── Content capture (the "destroy the real page" pipeline) ────────────────

  private setStatus(status: CaptureStatus) {
    if (this._captureStatus === status) return;
    this._captureStatus = status;
    this.emit("statuschange");
  }

  private async captureContent() {
    if (this.capturing || this.disposed || !this.contentRoot) return;
    const captureStartedAt = performance.now();
    this.capturing = true;
    this.setStatus("capturing");
    try {
      const layer = this.contentLayer ?? new ContentLayer();
      this.contentLayer = layer;
      // Set before the capture: `adopt` is what brings the renderer up, so this
      // has to be known by then rather than applied to it afterwards.
      layer.shadingEnabled = this.surfaceShading;
      // Match the overlay's own geometry so the destructible surface, the void
      // and the fx canvas share one coordinate space.
      const doc = this.docSize();
      const geometry = measureCapture(this.contentRoot, doc.width, doc.height, MAX_CAPTURE_HEIGHT);
      const backdrop = resolvePageBackdrop(this.contentRoot);

      // Map the page's furniture while the real layout still exists — after
      // `enterContentMode` there is nothing left to measure.
      if (this.opts.harvestElements && this.opts.physics) {
        try {
          this.pageElements = harvestElements(this.contentRoot, this.captureFilter);
        } catch (err) {
          // A hostile layout shouldn't cost the user the whole toy.
          console.warn("[desktop-destroyer] element harvest failed, demolition disabled:", err);
          this.pageElements = [];
        }
      }

      let live = false;
      if (this.opts.captureMode !== "snapshot" && supportsLiveCapture()) {
        try {
          await this.captureLive(layer, geometry, backdrop);
          live = true;
        } catch (err) {
          // "live" was best-effort or explicit; either way a working toy beats
          // a broken one, so drop to the snapshot path.
          if (this.opts.captureMode === "live") {
            this._liveUnavailable = true;
            console.warn(
              "[desktop-destroyer] live capture failed, falling back to snapshot mode:",
              err,
            );
          }
        }
      }
      if (this.disposed) return;

      if (!live) {
        layer.live = false;
        await layer.capture(this.contentRoot, geometry.width, geometry.height, this.captureFilter, {
          source: geometry.source,
          rootSize: geometry.rootSize,
          backdrop,
        });
        if (this.disposed) return;
        this.liveSource?.dispose();
        this.liveSource = null;
      }

      // The renderer is (re-)created by `adopt`, so its settings are re-applied
      // here rather than once at construction.
      layer.surfaceParams = { ...this.surfaceParams };

      // Map where the page has type on it, so the shader can keep glyphs crisp
      // where a tear runs through them. Built here — before `enterContentMode`
      // hides the real DOM — because it measures live line boxes.
      if (this.opts.textMask && layer.shaded) {
        try {
          layer.setTextMask(
            buildTextMask(this.contentRoot, geometry.width, geometry.height, this.captureFilter),
          );
        } catch (err) {
          // Purely an enhancement; a page that resists measurement still works.
          console.warn("[desktop-destroyer] text mask failed, shading uniformly:", err);
        }
      }

      // Content canvas sits between the void backdrop and the damage canvas.
      this.container.insertBefore(layer.canvas, this.damageCanvas);
      this.enterContentMode();
      this.setStatus(live ? "live" : "snapshot");
      if (live) this.scheduleRefresh();
    } catch (err) {
      // Capture can fail (e.g. CORS-tainted resources). Fall back to
      // overlay-only damage rather than breaking the toy.
      console.warn("[desktop-destroyer] page capture failed, using overlay mode:", err);
      this.contentLayer?.dispose();
      this.contentLayer = null;
      this.setStatus("idle");
    } finally {
      this.capturing = false;
      this.monitor.setCaptureDuration(performance.now() - captureStartedAt);
      this.requestFrame();
    }
  }

  /** First live capture: raster the page through `drawElementImage`. */
  private async captureLive(
    layer: ContentLayer,
    geometry: ReturnType<typeof measureCapture>,
    backdrop: ReturnType<typeof resolvePageBackdrop>,
  ) {
    const source = (this.liveSource ??= new LiveContentSource());
    layer.dpr = pickPixelRatio(geometry.width, geometry.height);
    const raster = await source.capture(
      this.contentRoot!,
      geometry.width,
      geometry.height,
      layer.dpr,
      {
        source: geometry.source,
        rootSize: geometry.rootSize,
        backdrop,
        filter: this.captureFilter,
      },
    );
    if (this.disposed) throw new Error("disposed");
    // Set before adopt: `adopt` resets the wound buffers, and `live` decides
    // whether damage is recorded into them at all.
    layer.live = true;
    layer.adopt(raster, geometry.width, geometry.height);
  }

  private scheduleRefresh() {
    clearTimeout(this.refreshTimer);
    if (this.opts.liveRefreshMs <= 0 || this.disposed) return;
    this.refreshTimer = window.setTimeout(() => {
      void this.refreshLive().then(() => this.scheduleRefresh());
    }, this.opts.liveRefreshMs);
  }

  /**
   * Re-capture the un-destroyed page into the layer's base while keeping every
   * wound. Cheap (~6 ms on a typical page) because it is one `drawElementImage`
   * rather than an SVG round-trip — which is the whole point of live mode.
   */
  private async refreshLive() {
    const layer = this.contentLayer;
    if (!this.liveSource || !layer?.ready || !layer.live) return;
    if (this.refreshing || this.capturing || this.disposed || !this.contentRoot) return;
    // A hidden tab still runs timers but its rAF is throttled to a crawl, and
    // the capture awaits two frames. Skip rather than pile up.
    if (document.hidden) return;
    this.refreshing = true;
    try {
      const doc = this.docSize();
      const geometry = measureCapture(this.contentRoot, doc.width, doc.height, MAX_CAPTURE_HEIGHT);
      // A reflow invalidates the whole capture; the resize handler owns that.
      if (geometry.width !== layer.width || geometry.height !== layer.height) return;

      // Fast path: the mirror is already mounted and its animations are running
      // in step with the page's, so a refresh is one draw call rather than a
      // clone of the whole DOM. Falls through to the full capture when the
      // browser has no paint events, or when the paint record went stale.
      const repainted = this.liveSource.repaint();
      if (repainted) {
        layer.refreshBase(repainted, {
          y0: this.scrollY - this.viewportH,
          y1: this.scrollY + this.viewportH * 2,
        });
        return;
      }

      const raster = await this.liveSource.capture(
        this.contentRoot,
        geometry.width,
        geometry.height,
        layer.dpr,
        {
          source: geometry.source,
          rootSize: geometry.rootSize,
          backdrop: resolvePageBackdrop(this.contentRoot),
          filter: this.captureFilter,
        },
      );
      if (this.disposed) return;
      // Refresh only what the user can see plus a screen either side — the
      // page below the fold keeps last refresh's (still pristine) pixels.
      layer.refreshBase(raster, {
        y0: this.scrollY - this.viewportH,
        y1: this.scrollY + this.viewportH * 2,
      });
    } catch (err) {
      // A failed refresh just means the base is a little stale — the existing
      // pixels and all the destruction are still on screen. Stop retrying.
      console.warn("[desktop-destroyer] live refresh failed, keeping last capture:", err);
      clearTimeout(this.refreshTimer);
      this.opts.liveRefreshMs = 0;
    } finally {
      this.refreshing = false;
    }
  }

  private enterContentMode() {
    if (!this.contentRoot || !this.contentLayer?.ready) return;
    if (this.prevRootVisibility === null) {
      this.prevRootVisibility = this.contentRoot.style.visibility;
    }
    // Hide the real DOM but keep its layout (scrollbars, page height). Our
    // own container un-hides itself — visibility, unlike display, can be
    // re-enabled on descendants.
    this.contentRoot.style.visibility = "hidden";
    this.container.style.visibility = "visible";
    this.voidLayer.style.display = "block";
  }

  private exitContentMode() {
    if (this.contentRoot && this.prevRootVisibility !== null) {
      this.contentRoot.style.visibility = this.prevRootVisibility;
      this.prevRootVisibility = null;
    }
    this.voidLayer.style.display = "none";
  }

  // ── DestroyerEngineApi (used by tools) ────────────────────────────────────

  random() {
    return Math.random();
  }

  spawnParticle(p: Particle) {
    const limit = Math.max(
      64,
      Math.round(this.opts.maxParticles * this.qualityProfile.particleScale),
    );
    if (this.particles.length >= limit) {
      // At the cap, recycle a slot round-robin instead of `shift()`-ing the
      // array (which memmoves every remaining particle, on every spawn, at the
      // exact moment the system is already saturated). Render order is decided
      // by particle kind, not array order, so the swap is invisible.
      this.recycleCursor = (this.recycleCursor + 1) % this.particles.length;
      this.particles[this.recycleCursor] = p;
      this.requestFrame();
      return;
    }
    this.particles.push(p);
    this.requestFrame();
  }

  spawnFlame(x: number, y: number, intensity = 0.35) {
    this.ensureFuel();
    // Frost fights fire. A well-iced region simply refuses to light, which is
    // what makes the freeze ray a defensive tool rather than a reskinned brush.
    const frost = this.frostAt(x, y);
    if (frost > 0.15) {
      intensity *= Math.max(0, 1 - frost * 1.4);
      this.meltFrost(x, y, 40);
      this.spawnParticle({
        kind: "steam",
        x,
        y,
        vx: (Math.random() - 0.5) * 40,
        vy: -50 - Math.random() * 50,
        life: 0,
        maxLife: 0.7 + Math.random() * 0.6,
        size: 8 + Math.random() * 10,
        drag: 1.5,
      });
      if (intensity <= 0.02) return;
    }
    // Fire needs a page to burn. Where the content is mostly gone the void
    // shows through, and the void is not a place — a flame floating on it
    // reads as a rendering bug, not as fire. Strict on purpose: half-eroded
    // ground barely holds a flame's footprint, and the render mask would clip
    // most of it away anyway.
    if (this.contentLayer?.ready && this.contentLayer.opacityAt(x, y) < 0.35) return;
    // Merge into a nearby flame instead of stacking duplicates.
    for (const f of this.flames) {
      if (Math.hypot(f.x - x, f.y - y) < f.radius * 0.6) {
        f.intensity = Math.min(1, f.intensity + intensity * 0.5);
        return;
      }
    }
    const limit = Math.max(4, Math.round(this.opts.maxFlames * this.qualityProfile.flameScale));
    if (this.flames.length >= limit) return;
    this.flames.push({
      x,
      y,
      intensity,
      radius: 17 + Math.random() * 21,
      age: 0,
      seed: Math.random() * 1000,
      spreadCooldown: 1.5 + Math.random() * 2,
      scorchCooldown: 0.4,
      popCooldown: 1 + Math.random() * 3,
    });
    this.requestFrame();
  }

  dowseFlames(x: number, y: number, radius: number, amount: number): number {
    let hits = 0;
    for (const f of this.flames) {
      // Called once per water droplet per frame against every flame, so the
      // reject path has to be cheap: axis test first, then squared distance —
      // no `Math.hypot`, no square root.
      const reach = radius + f.radius;
      const dx = f.x - x;
      if (dx > reach || dx < -reach) continue;
      const dy = f.y - y;
      if (dy > reach || dy < -reach) continue;
      if (dx * dx + dy * dy < reach * reach) {
        f.intensity -= amount;
        hits++;
        if (Math.random() < 0.4) {
          // Quenching steam boils *upward and outward* off the flame, so it gets
          // real lateral spread rather than the near-vertical wisp it had.
          this.spawnParticle({
            kind: "steam",
            x: f.x + (Math.random() - 0.5) * f.radius * 1.4,
            y: f.y - Math.random() * 10,
            vx: (Math.random() - 0.5) * 90,
            vy: -70 - Math.random() * 90,
            life: 0,
            maxLife: 1 + Math.random() * 1.1,
            size: 10 + Math.random() * 18,
            drag: 1.4,
          });
        }
      }
    }
    // The hiss belongs to the *event* of water meeting fire, not to each of the
    // hundred droplet/flame pairs that can register in a single frame.
    if (hits > 0 && this.lastTime > this.nextHiss) {
      this.nextHiss = this.lastTime + 260;
      this.sound.hiss();
    }
    return hits;
  }

  eraseDamage(x: number, y: number, radius: number) {
    // Sweeping is the one thing that un-wrecks the page, so it walks the
    // vignette back too.
    this.destruction = Math.max(0, this.destruction - 0.004);
    // Repair the real content from the pristine snapshot...
    this.contentLayer?.restore(x, y, radius);
    // ...and sweep any overlay decals (also the fallback path). Nothing to
    // sweep if the damage canvas was never painted on.
    if (!this.damageReady) return;
    const ctx = this._damageCtx;
    ctx.globalCompositeOperation = "destination-out";
    blit(ctx, sprites().erase, x, y, radius, 1);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  /**
   * Rinse stains off the page: paint, soot, smears and rime wash away, but
   * structural damage stays. Holes are beyond washing — `eraseDamage` (the
   * broom) repairs; water only cleans. Also rinses the frost field, so a
   * washed patch is genuinely no longer frozen.
   */
  washSurface(x: number, y: number, radius: number, strength = 1) {
    this.contentLayer?.wash(x, y, radius, strength);
    if (this.damageReady) {
      const ctx = this._damageCtx;
      ctx.globalCompositeOperation = "destination-out";
      blit(ctx, sprites().erase, x, y, radius, Math.min(1, strength));
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }
    this.meltFrost(x, y, radius, strength);
    this.markSurface(x, y, radius);
  }

  /** Knock chunks of real page content loose: hole + tumbling shards. */
  shatter(x: number, y: number, radius = 26) {
    const layer = this.contentLayer;
    if (!layer?.ready) return;
    // Shard textures come from the pristine base — shattering a region that is
    // already void would conjure page material out of empty space.
    if (!this.onPage(x, y)) return;
    const shards = 11 + Math.floor(Math.random() * 7);
    for (let i = 0; i < shards; i++) {
      const size = 6 + Math.random() * radius * 0.75;
      const patch = layer.patch(
        x + (Math.random() - 0.5) * radius * 1.4,
        y + (Math.random() - 0.5) * radius * 1.4,
        size,
        size,
      );
      if (!patch) continue;
      const a = Math.random() * TAU;
      const speed = 110 + Math.random() * 340;
      this.spawnParticle({
        kind: "shard",
        x,
        y,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed - 200,
        life: 0,
        maxLife: 1.3 + Math.random() * 0.9,
        size,
        angle: Math.random() * TAU,
        spin: (Math.random() - 0.5) * 26,
        // Shards fall out of the page and clatter onto whatever is below it.
        bounce: 0.42 + Math.random() * 0.2,
        restY: y + 70 + Math.random() * 220,
        img: patch.img,
        sx: patch.sx,
        sy: patch.sy,
        sw: patch.sw,
        sh: patch.sh,
      });
    }
    layer.punch(x, y, radius * 0.8);
  }

  shake(strength = 6, dirX = 0, dirY = 0) {
    this.shakeAmount = Math.max(this.shakeAmount, strength);
    if (dirX !== 0 || dirY !== 0) {
      const mag = Math.hypot(dirX, dirY) || 1;
      this.kickX += (dirX / mag) * strength * 0.5;
      this.kickY += (dirY / mag) * strength * 0.5;
    }
    // A little roll on every hit: pure translation reads as a rattle, a tilt
    // reads as the page taking the blow.
    this.shakeRoll += (Math.random() - 0.5) * strength * 0.00035;
    // Every destructive tool already calls shake(), scaled by how hard it hit —
    // which makes it the one honest measure of accumulated damage.
    this.destruction = Math.min(1, this.destruction + strength * 0.0012);
    this.requestFrame();
  }

  // ── Physical destruction ──────────────────────────────────────────────────

  get singularity(): Singularity | null {
    return this._singularity;
  }

  setSingularity(s: Singularity | null) {
    this._singularity = s;
    this.requestFrame();
  }

  /**
   * The smoothed direction the drawn tool is aiming (unit vector). Tools that
   * fire something directional — a tracer, a rocket, a jet — read this so
   * their effects line up with the way the tool is visibly pointing, instead
   * of picking a direction at random. Stepped every frame regardless of tool
   * style; steady while the pointer hovers.
   */
  get toolAim(): Vec2 {
    return { x: this.artAimX, y: this.artAimY };
  }

  /**
   * Where chunk textures come from: the *visible* content canvas, not the
   * pristine base. A shard broken off a scorched, half-burnt region should
   * carry that damage with it as it falls.
   */
  private get chunkSource(): ChunkSource | null {
    const layer = this.contentLayer;
    if (!this.opts.physics || !layer?.ready) return null;
    // The 2D surface, not the shaded output: it already carries the scorch and
    // the holes, and reading it needs no GPU round-trip.
    return { img: layer.surface, dpr: layer.dpr, width: layer.width, height: layer.height };
  }

  private static appendPoly(path: Path2D, cell: number[]) {
    path.moveTo(cell[0], cell[1]);
    for (let i = 2; i < cell.length; i += 2) path.lineTo(cell[i], cell[i + 1]);
    path.closePath();
  }

  private static polyArea2(points: number[]): number {
    let area2 = 0;
    const n = points.length >> 1;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      area2 += points[i * 2] * points[j * 2 + 1] - points[j * 2] * points[i * 2 + 1];
    }
    return area2;
  }

  fracture(x: number, y: number, radius: number, options: FractureOptions = {}): number {
    // Anything crawling in the struck region is crushed along with it.
    if (this.bugs.length > 0) this.squashBugs(x, y, radius);
    const src = this.chunkSource;
    if (!src) return 0;
    const icy = options.icy ?? this.frostAt(x, y) > 0.3;
    // Ice shatters finer and lighter than paper does.
    const count = options.count ?? shardBudget(radius, icy ? 2.2 : 1.4);
    const cells = voronoiCells(x, y, radius, count);
    const power = options.power ?? 240;
    const carve = new Path2D();
    const carvedCells: number[][] = [];
    let made = 0;

    for (const cell of cells) {
      const geometricArea = Math.abs(DestroyerEngine.polyArea2(cell)) * 0.5;
      const materialArea = this.contentLayer?.materialArea(cell) ?? geometricArea;
      // A cell grazing a pre-existing hole is fine; an empty cell is not a
      // shard. Requiring a little real coverage also prevents a huge collider
      // being attached to one surviving anti-aliased pixel at a torn rim.
      if (materialArea < Math.max(8, geometricArea * 0.06)) continue;
      const body = makeChunk(
        src,
        cell,
        {
          density: icy ? 0.0011 : 0.0018,
          restitution: icy ? 0.36 : 0.14,
          friction: icy ? 0.26 : 0.62,
          ttl: options.ttl ?? 10 + Math.random() * 8,
        },
        icy
          ? // Ice is thin and translucent — no wooden underside on the shards.
            {
              tint: "rgba(150, 214, 255, 0.3)",
              edge: "rgba(232, 248, 255, 0.85)",
              edgeWidth: 1.1,
              flat: true,
            }
          : { edge: "rgba(12, 9, 7, 0.45)" },
      );
      if (!body) continue;
      // Shards leave along the line from the impact through their own centre,
      // which is what makes a break look like it started somewhere.
      const dx = body.x - x;
      const dy = body.y - y;
      const d = Math.hypot(dx, dy) || 1;
      const speed = power * (0.35 + Math.random() * 0.9);
      body.vx = (dx / d) * speed + (options.dirX ?? 0) * power;
      body.vy = (dy / d) * speed + (options.dirY ?? 0) * power - 110;
      body.av = (Math.random() - 0.5) * 10;
      this.physics.add(body);
      DestroyerEngine.appendPoly(carve, cell);
      carvedCells.push(cell);
      made++;
    }
    if (made === 0) return 0;

    // The page loses exactly what the physics world gained.
    this.contentLayer?.carveShape(
      carve,
      {
        x: x - radius,
        y: y - radius,
        w: radius * 2,
        h: radius * 2,
      },
      carvedCells,
    );
    this.contentLayer?.char(x, y, radius * 1.2, icy ? 0.08 : 0.3);
    if (icy) {
      this.meltFrost(x, y, radius);
      this.sound.crack();
      for (let i = 0; i < 14; i++) {
        const a = Math.random() * TAU;
        const sp = 120 + Math.random() * 320;
        this.spawnParticle({
          kind: "ice",
          x,
          y,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp - 90,
          life: 0,
          maxLife: 0.6 + Math.random() * 0.7,
          size: 2 + Math.random() * 4,
          angle: Math.random() * TAU,
          spin: (Math.random() - 0.5) * 22,
        });
      }
    }
    return made;
  }

  explode(x: number, y: number, radius: number, options: ExplodeOptions = {}) {
    const power = options.power ?? 560;
    // The blast reaches further than the crater; so does what it does to bugs.
    if (this.bugs.length > 0) this.squashBugs(x, y, radius * 1.6);
    if (options.fracture !== false) {
      this.fracture(x, y, radius * 0.9, { power: power * 0.8, count: shardBudget(radius, 1.7) });
    }
    // Everything already loose gets thrown, including debris from earlier hits.
    this.physics.blast(x, y, radius * 2.2, power * 1.1);
    for (const p of this.particles) {
      const dx = p.x - x;
      const dy = p.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 > radius * radius * 6) continue;
      const d = Math.sqrt(d2) || 1;
      const f = (power * 2.2) / Math.max(40, d);
      p.vx += (dx / d) * f;
      p.vy += (dy / d) * f;
    }
    this.contentLayer?.char(x, y, radius * 1.7, 0.55);

    // Fireball: a white core, an expanding shock ring, then the boiling
    // smoke ball that is most of what an explosion actually looks like.
    this.spawnParticle({
      kind: "flash",
      x,
      y,
      vx: 0,
      vy: 0,
      life: 0,
      maxLife: 0.3,
      size: radius * 2.6,
    });
    this.spawnParticle({
      kind: "ring",
      x,
      y,
      vx: 0,
      vy: 0,
      life: 0,
      maxLife: 0.62,
      size: radius * 2.2,
    });
    for (let i = 0; i < 34; i++) {
      const a = Math.random() * TAU;
      const sp = 90 + Math.random() * 420;
      this.spawnParticle({
        kind: "jet",
        x: x + (Math.random() - 0.5) * radius * 0.6,
        y: y + (Math.random() - 0.5) * radius * 0.6,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 70,
        life: 0,
        maxLife: 0.35 + Math.random() * 0.4,
        size: radius * 0.16,
        gravity: -320,
        drag: 2.8,
      });
    }
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * TAU;
      const sp = 30 + Math.random() * 200;
      this.spawnParticle({
        kind: "smoke",
        x: x + (Math.random() - 0.5) * radius,
        y: y + (Math.random() - 0.5) * radius,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 60,
        life: 0,
        maxLife: 1.8 + Math.random() * 2.4,
        size: radius * (0.2 + Math.random() * 0.35),
        gravity: -26,
        drag: 1.5,
        spin: (Math.random() - 0.5) * 1.4,
        angle: Math.random() * TAU,
        phase: Math.random() * TAU,
      });
    }
    for (let i = 0; i < 30; i++) {
      const a = Math.random() * TAU;
      const sp = 240 + Math.random() * 620;
      this.spawnParticle({
        kind: "spark",
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 0,
        maxLife: 0.3 + Math.random() * 0.5,
        size: 1.6 + Math.random() * 2.4,
        gravity: 380,
        drag: 0.6,
      });
    }

    if (options.incendiary !== false) {
      const fires = 3 + Math.floor(Math.random() * 3);
      for (let i = 0; i < fires; i++) {
        const a = Math.random() * TAU;
        const d = Math.random() * radius;
        this.spawnFlame(x + Math.cos(a) * d, y + Math.sin(a) * d * 0.7, 0.55);
      }
    }
    this.heat(x, y, radius * 2, 1);
    this.shake(radius * 0.45, (Math.random() - 0.5) * 0.6, 0.4);
    this.sound.boom();
  }

  /**
   * Cut a traced polygon clean out of the page: the enclosed region leaves the
   * content layer and falls as one rigid piece carrying exactly those pixels.
   *
   * This is the chainsaw's closed-loop payoff — saw a square and a square drops
   * out — but it is exposed as engine API so custom tools can do the same.
   * The traced outline is rarely convex, and the solver's contact math assumes
   * convexity, so the piece collides as its convex hull while the sprite keeps
   * the true outline.
   */
  cutout(points: number[]): boolean {
    const src = this.chunkSource;
    if (!src || points.length < 8) return false;

    // Shoelace area: reject slivers (a doubled-back cut line encloses nothing
    // worth dropping, and a degenerate polygon makes a degenerate body).
    const area2 = DestroyerEngine.polyArea2(points);
    if (Math.abs(area2) / 2 < 320) return false;
    // The outline may span existing holes. Keep them in the falling sprite,
    // but never create a body when the outlined region is already effectively
    // empty. This is the shared guard for chainsaw loops and custom tools.
    if ((this.contentLayer?.materialArea(points) ?? 0) < 240) return false;

    const body = makeChunk(
      src,
      points,
      {
        density: 0.002,
        restitution: 0.12,
        friction: 0.7,
        ttl: 16 + Math.random() * 10,
      },
      // A sawn island may be as large as the captured page. Preserve its exact
      // geometry while bounding only the backing-store pixel cost; this avoids
      // turning a valid large loop into a no-op or a multi-megabyte frame spike.
      {
        edge: "rgba(12, 9, 7, 0.5)",
        maxSize: Math.max(src.width, src.height),
        maxPixels: 2_000_000,
      },
      convexHull(points),
    );
    if (!body) return false;
    // It drops — sawn free, not blasted: a nudge of spin and gravity's problem.
    body.vx = (Math.random() - 0.5) * 30;
    body.vy = 20 + Math.random() * 50;
    body.av = (Math.random() - 0.5) * 1.6;
    this.physics.add(body);

    const carve = new Path2D();
    DestroyerEngine.appendPoly(carve, points);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < points.length; i += 2) {
      minX = Math.min(minX, points[i]);
      maxX = Math.max(maxX, points[i]);
      minY = Math.min(minY, points[i + 1]);
      maxY = Math.max(maxY, points[i + 1]);
    }
    this.contentLayer?.carveShape(
      carve,
      {
        x: minX,
        y: minY,
        w: maxX - minX,
        h: maxY - minY,
      },
      [points],
    );

    this.sound.crack();
    return true;
  }

  dislodge(x0: number, y0: number, x1: number, y1: number): number {
    const layer = this.contentLayer;
    if (!layer?.ready || !this.opts.physics) return 0;
    const polygons = layer.detachedPolygons({
      x0: Math.min(x0, x1),
      y0: Math.min(y0, y1),
      x1: Math.max(x0, x1),
      y1: Math.max(y0, y1),
    });
    let released = 0;
    for (const polygon of polygons) {
      if (this.cutout(polygon)) released++;
    }
    return released;
  }

  demolish(x: number, y: number): boolean {
    // A wrecking blow delivered through an existing hole cannot couple to a
    // card merely because the card's old DOM rectangle still contains it.
    if (!this.onPage(x, y)) return false;
    // Deliberately forgiving: a direct hit always wins, but a near miss on a
    // 26 px line of text still takes the paragraph. See `elementAt`.
    const el = elementAt(this.pageElements, x, y, 16);
    return el ? this.dropElement(el, x, y) : false;
  }

  /**
   * Knock one harvested page element loose as rigid debris.
   *
   * Big elements are split first: a hero image arriving as a single 1200px slab
   * looks like a bug, where four panels tumbling apart looks like demolition.
   */
  private dropElement(el: PageElement, fromX: number, fromY: number): boolean {
    const src = this.chunkSource;
    if (!src) return false;
    const cols = Math.max(1, Math.min(5, Math.ceil(el.w / 300)));
    const rows = Math.max(1, Math.min(5, Math.ceil(el.h / 240)));
    const cells =
      cols * rows > 1
        ? gridCells(el.x, el.y, el.w, el.h, cols, rows, 0.22)
        : [[el.x, el.y, el.x + el.w, el.y, el.x + el.w, el.y + el.h, el.x, el.y + el.h]];

    const carve = new Path2D();
    const carvedCells: number[][] = [];
    let made = 0;
    for (const cell of cells) {
      const geometricArea = Math.abs(DestroyerEngine.polyArea2(cell)) * 0.5;
      const materialArea = this.contentLayer?.materialArea(cell) ?? geometricArea;
      if (materialArea < Math.max(8, geometricArea * 0.04)) continue;
      const body = makeChunk(
        src,
        cell,
        {
          density: el.solid ? 0.0024 : 0.0015,
          restitution: 0.1,
          friction: 0.72,
          ttl: 16 + Math.random() * 10,
        },
        { edge: "rgba(12, 9, 7, 0.5)" },
      );
      if (!body) continue;
      // A shove away from where it was hit, plus a small lift, so the piece
      // hinges off the page rather than dropping straight down like a lift.
      // The vertical term is what sells it: pieces further from the blow get
      // driven harder, so a struck card tips away instead of translating.
      body.vx = (body.x - fromX) * 0.75 + (Math.random() - 0.5) * 60;
      body.vy = -30 - Math.random() * 110 + (body.y - fromY) * 0.3;
      body.av = (Math.random() - 0.5) * 3.6;
      this.physics.add(body);
      DestroyerEngine.appendPoly(carve, cell);
      carvedCells.push(cell);
      made++;
    }
    if (made === 0) {
      // Another tool already removed this harvested DOM rectangle. Retire the
      // stale target so demolition and black-hole feeding can reach what is
      // actually still present instead of retrying empty geometry forever.
      el.taken = true;
      return false;
    }

    el.taken = true;
    // `gridCells` jitters cell corners by up to 22% of a cell, so the carved
    // outline can bulge past the element's own rect.
    const slack = Math.max(el.w / cols, el.h / rows) * 0.25;
    this.contentLayer?.carveShape(
      carve,
      {
        x: el.x - slack,
        y: el.y - slack,
        w: el.w + slack * 2,
        h: el.h + slack * 2,
      },
      carvedCells,
    );
    for (let i = 0; i < 12; i++) {
      this.spawnParticle({
        kind: "dust",
        x: el.x + Math.random() * el.w,
        y: el.y + Math.random() * el.h,
        vx: (Math.random() - 0.5) * 90,
        vy: -20 - Math.random() * 60,
        life: 0,
        maxLife: 0.9 + Math.random() * 1.2,
        size: 8 + Math.random() * 14,
        gravity: 18,
        drag: 2.1,
      });
    }
    this.shake(9, 0, 1);
    this.sound.thunk();
    return true;
  }

  collapse() {
    const top = this.scrollY - 240;
    const bottom = this.scrollY + this.viewportH + 240;
    this.collapseQueue = elementsInBand(
      this.pageElements,
      top,
      bottom,
      this.scrollY + this.viewportH * 0.35,
    );
    this.collapseTimer = 0;
    if (this.collapseQueue.length > 0) {
      this.requestFrame();
      return;
    }
    // No element map (harvesting off, or everything already down): bring the
    // visible band apart by brute force instead of doing nothing.
    for (let i = 0; i < 7; i++) {
      this.fracture(
        Math.random() * this.w,
        this.scrollY + Math.random() * this.viewportH,
        70 + Math.random() * 70,
        { power: 140 },
      );
    }
    this.shake(22, 0, 1);
    this.sound.boom();
  }

  // ── Frost ─────────────────────────────────────────────────────────────────

  private ensureFrost() {
    if (this.frost) return;
    this.frostCols = Math.max(1, Math.ceil(this.w / FROST_CELL));
    this.frostRows = Math.max(1, Math.ceil(this.h / FROST_CELL));
    this.frost = new Float32Array(this.frostCols * this.frostRows);
  }

  freeze(x: number, y: number, radius: number, amount: number) {
    this.ensureFrost();
    this.paintFrost(x, y, radius, amount, true);
  }

  private paintFrost(x: number, y: number, radius: number, amount: number, surfaceOnly = false) {
    const grid = this.frost!;
    const c0 = Math.max(0, Math.floor((x - radius) / FROST_CELL));
    const c1 = Math.min(this.frostCols - 1, Math.floor((x + radius) / FROST_CELL));
    const r0 = Math.max(0, Math.floor((y - radius) / FROST_CELL));
    const r1 = Math.min(this.frostRows - 1, Math.floor((y + radius) / FROST_CELL));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const dx = (c + 0.5) * FROST_CELL - x;
        const dy = (r + 0.5) * FROST_CELL - y;
        const d = Math.hypot(dx, dy);
        if (d > radius) continue;
        if (surfaceOnly && !this.onPage((c + 0.5) * FROST_CELL, (r + 0.5) * FROST_CELL)) continue;
        const i = r * this.frostCols + c;
        const next = grid[i] + amount * (1 - d / radius);
        grid[i] = Math.max(0, Math.min(1, next));
      }
    }
  }

  frostAt(x: number, y: number): number {
    if (!this.frost) return 0;
    const c = Math.floor(x / FROST_CELL);
    const r = Math.floor(y / FROST_CELL);
    if (c < 0 || r < 0 || c >= this.frostCols || r >= this.frostRows) return 0;
    return this.frost[r * this.frostCols + c];
  }

  /**
   * Melt frost — the other half of fire-vs-ice. Ignition does it to clear its
   * own ground, burning flames do it to the rime around them, shattering ice
   * consumes it, and the flamethrower's jet does it deliberately.
   */
  meltFrost(x: number, y: number, radius: number, amount = 1) {
    if (!this.frost) return;
    this.paintFrost(x, y, radius, -amount);
  }

  // ── Heat field (drives the post-processing shimmer) ───────────────────────

  heat(x: number, y: number, radius: number, amount: number) {
    if (!this.postfxEnabled) return;
    const ctx = this.heatCtx;
    if (!ctx || amount <= 0) return;
    const hx = (x - this.fxOffsetX) / HEAT_SCALE;
    const hy = (y - this.fxOffsetY) / HEAT_SCALE;
    const hr = radius / HEAT_SCALE;
    // Additive onto an opaque black field: the canvas composites in
    // premultiplied space, so `lighter` accumulates the gradient's *weighted*
    // colour and the resulting red channel is a real heat value rather than a
    // flat disc of full-strength orange.
    ctx.globalCompositeOperation = "lighter";
    blit(ctx, sprites().glow, hx, hy, hr, Math.min(1, amount));
    ctx.globalAlpha = 1;
    if (amount > this.heatLevel) this.heatLevel = Math.min(1, amount);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private emit(event: EngineEvent) {
    this.listeners.get(event)?.forEach((cb) => {
      cb();
    });
  }

  private applyQuality(tier: PerformanceQualityTier) {
    if (tier === this.qualityTier) return;
    this.qualityTier = tier;
    this.qualityProfile = QUALITY_PROFILES[tier];

    const particleLimit = Math.max(
      64,
      Math.round(this.opts.maxParticles * this.qualityProfile.particleScale),
    );
    if (this.particles.length > particleLimit) {
      // Keep the newest effects. This runs only on a profile transition, never
      // in the frame loop, so the one splice is preferable to ongoing churn.
      this.particles.splice(0, this.particles.length - particleLimit);
      this.recycleCursor %= this.particles.length;
    }
    const flameLimit = Math.max(
      4,
      Math.round(this.opts.maxFlames * this.qualityProfile.flameScale),
    );
    if (this.flames.length > flameLimit) this.flames.length = flameLimit;
    this.physics.setIterations(this.qualityProfile.physicsIterations);
    this.physics.setBodyLimit(Math.max(24, Math.round(MAX_BODIES * this.qualityProfile.bodyScale)));
    this.setPostFXEnabled(this.opts.postFX && this.qualityProfile.postFX);
  }

  private ensurePostFX() {
    if (this.postfx || this.postfxTried || this.disposed || !this.opts.postFX) return;
    this.postfxTried = true;
    const postfx = new PostFX();
    if (!postfx.available) {
      postfx.dispose();
      return;
    }
    this.postfx = postfx;
    this.heatCanvas = document.createElement("canvas");
    this.heatCtx = this.heatCanvas.getContext("2d", { willReadFrequently: false });
    postfx.resize(this.fxCanvas.width, this.fxCanvas.height, this.fxW, this.fxH);
    this.heatCanvas.width = Math.max(1, Math.round(this.fxW / HEAT_SCALE));
    this.heatCanvas.height = Math.max(1, Math.round(this.fxH / HEAT_SCALE));
  }

  private setPostFXEnabled(enabled: boolean) {
    if (enabled) this.ensurePostFX();
    const next = enabled && !!this.postfx;
    if (next === this.postfxEnabled) return;
    this.postfxEnabled = next;
    if (!next) this.setPostFXOutput(false);
  }

  /** Swap presentation only when the shader changes the frame's pixels. */
  private setPostFXOutput(active: boolean) {
    const postfx = this.postfx;
    const next = this.postfxEnabled && !!postfx && active;
    if (next === this.postfxActive) return;
    const outgoing = this.postfxActive ? postfx!.canvas : this.fxCanvas;
    const incoming = next ? postfx!.canvas : this.fxCanvas;
    incoming.style.transform = outgoing.style.transform;
    outgoing.replaceWith(incoming);
    this.postfxActive = next;
    if (!next) postfx?.clear();
    this.fxOffsetX = this.fxOffsetY = -1;
  }

  private docSize() {
    return {
      width: document.documentElement.clientWidth,
      height: Math.min(
        Math.max(document.documentElement.scrollHeight, document.documentElement.clientHeight),
        MAX_CAPTURE_HEIGHT,
      ),
    };
  }

  /**
   * Give the damage canvas a real backing store. Deferred until something
   * actually paints on it: with the page capture live every tool draws onto
   * the content canvas instead, and an empty document-sized layer still costs
   * the compositor a full set of tiles.
   */
  private ensureDamage() {
    if (this.damageReady || this.w === 0) return;
    this.damageReady = true;
    this.damageCanvas.width = Math.round(this.w * this.dpr);
    this.damageCanvas.height = Math.round(this.h * this.dpr);
    this.damageCanvas.style.width = `${this.w}px`;
    this.damageCanvas.style.height = `${this.h}px`;
    this._damageCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  /** Keep the fx canvas matched to the viewport (not the document). */
  private resizeFx() {
    const width = document.documentElement.clientWidth;
    this.viewportH = window.innerHeight;
    const height = Math.min(this.viewportH + FX_MARGIN * 2, this.h + FX_MARGIN * 2);
    this.vignette.style.width = `${width}px`;
    this.vignette.style.height = `${this.viewportH}px`;
    if (width === this.fxW && height === this.fxH) return;
    this.fxW = width;
    this.fxH = height;
    this.fxCanvas.width = Math.round(width * this.dpr);
    this.fxCanvas.height = Math.round(height * this.dpr);
    this.fxCanvas.style.width = `${width}px`;
    this.fxCanvas.style.height = `${height}px`;
    this.postfx?.resize(this.fxCanvas.width, this.fxCanvas.height, width, height);
    if (this.heatCanvas) {
      this.heatCanvas.width = Math.max(1, Math.round(width / HEAT_SCALE));
      this.heatCanvas.height = Math.max(1, Math.round(height / HEAT_SCALE));
    }
    // Force the transform to be re-applied against the new size.
    this.fxOffsetX = this.fxOffsetY = -1;
  }

  private resize() {
    const { width, height } = this.docSize();
    if (width === 0 || height === 0) return;
    const dpr = pickPixelRatio(width, height);
    if (width === this.w && height === this.h && dpr === this.dpr) {
      this.resizeFx();
      return;
    }

    // Preserve existing damage across resizes (top-left anchored). Only
    // meaningful once the damage canvas has actually been allocated — an
    // untouched one has no pixels worth carrying over.
    let prev: HTMLCanvasElement | null = null;
    const prevDpr = this.dpr;
    if (this.damageReady) {
      prev = document.createElement("canvas");
      prev.width = this.damageCanvas.width;
      prev.height = this.damageCanvas.height;
      prev.getContext("2d")!.drawImage(this.damageCanvas, 0, 0);
    }

    this.w = width;
    this.h = height;
    this.dpr = dpr;
    // The frost grid is indexed off the document size; a reflow invalidates it.
    this.frost = null;
    this.container.style.height = `${height}px`;
    this.measureOrigin();
    this.resizeFx();

    if (prev) {
      this.damageReady = false;
      this.ensureDamage();
      this._damageCtx.drawImage(prev, 0, 0, prev.width / prevDpr, prev.height / prevDpr);
    }
  }

  private onScroll = () => {
    this.scrollX = window.scrollX;
    this.scrollY = window.scrollY;
    this.requestFrame();
  };

  private onWindowResize = () => {
    this.onScroll();
    this.resize();
    this.requestFrame();
    // A width change invalidates the page capture (text reflows). Debounce a
    // fresh capture; the old one keeps showing until the new one lands.
    if (this.contentLayer?.ready) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(() => {
        if (this.disposed || !this.contentLayer) return;
        if (this.contentLayer.width !== document.documentElement.clientWidth) {
          clearTimeout(this.refreshTimer);
          this.exitContentMode();
          this.contentLayer.ready = false;
          void this.captureContent();
        }
      }, 350);
    }
  };

  /**
   * Document-space position of the overlay container.
   *
   * Read via the `offsetParent` chain rather than `getBoundingClientRect` for
   * two reasons: it can be cached across pointer events (the container's
   * document anchor only moves on resize), and it ignores the shake transform,
   * which would otherwise make the cursor's hit position jitter along with the
   * screen shake.
   */
  private measureOrigin() {
    let x = 0;
    let y = 0;
    let el: HTMLElement | null = this.container;
    while (el) {
      x += el.offsetLeft;
      y += el.offsetTop;
      el = el.offsetParent as HTMLElement | null;
    }
    this.originX = x;
    this.originY = y;
  }

  private toolEvent(e: PointerEvent) {
    // Equivalent to `clientX - container.getBoundingClientRect().left`, but
    // without forcing a layout on every pointermove.
    const x = e.clientX + window.scrollX - this.originX;
    const y = e.clientY + window.scrollY - this.originY;
    const ev = {
      x,
      y,
      dx: this.lastPointer.x < -100 ? 0 : x - this.lastPointer.x,
      dy: this.lastPointer.y < -100 ? 0 : y - this.lastPointer.y,
      buttons: e.buttons,
    };
    this.lastPointer.x = x;
    this.lastPointer.y = y;
    this.pointer.x = x;
    this.pointer.y = y;
    return ev;
  }

  private onPointerDown = (e: PointerEvent) => {
    if (!this.activeTool || e.button !== 0) return;
    e.preventDefault();
    this.pointerDown = true;
    this.artDownAt = performance.now() / 1000;
    this.lastPointer.x = this.lastPointer.y = -1000;
    // Always build the event (it updates this.pointer for tick-driven tools),
    // even when the tool has no onDown handler.
    const ev = this.toolEvent(e);
    this.activeTool.onDown?.(this, ev);
    this.requestFrame();
  };

  private onPointerMove = (e: PointerEvent) => {
    if (!this.activeTool) return;
    const ev = this.toolEvent(e);
    this.activeTool.onMove?.(this, ev);
    this.requestFrame();
  };

  private onPointerUp = (e: PointerEvent) => {
    if (!this.pointerDown) return;
    this.pointerDown = false;
    this.artUpAt = performance.now() / 1000;
    const ev = this.toolEvent(e);
    this.activeTool?.onUp?.(this, ev);
    this.requestFrame();
  };

  private onPointerLeave = () => {
    this.pointer.x = this.pointer.y = -1000;
    this.lastPointer.x = this.lastPointer.y = -1000;
    this.requestFrame();
  };

  private onContextMenu = (e: Event) => {
    if (this.activeTool) e.preventDefault();
  };

  private frame = (now: number) => {
    if (this.disposed) return;
    this.raf = 0;
    this.monitor.observeRaf(now);
    const minFrameInterval = this.qualityProfile.minFrameIntervalMs;
    if (minFrameInterval > 0 && now - this.lastRenderedAt < minFrameInterval) {
      this.requestFrame();
      return;
    }
    this.lastRenderedAt = now;
    const dt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;

    // Direct API users can spawn entities without selecting a tool. Lazily
    // bring up post-FX on the first frame that can actually use it as well.
    // Initialization happens outside the recurring CPU measurement so a
    // one-time shader compile cannot incorrectly downgrade adaptive quality.
    if (
      !this.postfxEnabled &&
      !this.postfxTried &&
      this.opts.postFX &&
      this.qualityProfile.postFX &&
      this.hasPostFXDemand()
    ) {
      this.setPostFXEnabled(true);
    }
    const frameStartedAt = performance.now();

    // The heat field is rebuilt from scratch every frame: it describes where
    // the air is hot *now*, and anything that accumulated would smear.
    this.resetHeat();
    const updateStartedAt = performance.now();
    this.activeTool?.tick?.(this, dt, this.pointerDown, this.pointer);
    this.stepToolArt(dt);
    this.stepCollapse(dt);
    this.stepFlames(dt);
    this.stepBugs(dt);
    this.stepSingularity(dt);
    this.stepParticles(dt);
    this.stepPhysics(dt);
    const updateMs = performance.now() - updateStartedAt;
    // Safety net for decals painted straight into `surfaceCtx` by a tool, which
    // the content layer cannot observe. Every built-in decal lands within this
    // reach of the cursor; anything further out marks itself via `markSurface`.
    if (this.pointerDown && this.activeTool && this.contentLayer?.ready) {
      this.contentLayer.markSurface(this.pointer.x, this.pointer.y, TOOL_DECAL_REACH, true);
    }
    // Push page damage to the screen before the effects layer draws over it.
    const surfaceStartedAt = performance.now();
    // A safety-net reconcile is a document-sized correctness sweep. Defer it
    // while a held tool is actively animating; its local dirty region is still
    // uploaded every frame, and the one full sweep runs immediately on release.
    this.contentLayer?.present(!this.pointerDown);
    const surfaceMs = performance.now() - surfaceStartedAt;
    const renderStartedAt = performance.now();
    this.render();
    const renderTotalMs = performance.now() - renderStartedAt;
    this.updateShake(dt);
    this.updateVignette();
    this.updateLoops();

    const frameMs = performance.now() - frameStartedAt;
    const nativeTarget = this.monitor.nativeTargetFps;
    const targetFps = this.qualityTier === "high" ? nativeTarget : Math.min(60, nativeTarget);
    const recommendation = this.monitor.record({
      cadenceMs: dt * 1_000,
      frameMs,
      updateMs,
      surfaceMs,
      renderMs: Math.max(0, renderTotalMs - this.postFXFrameMs),
      postFXMs: this.postFXFrameMs,
      entities: {
        particles: this.particles.length,
        flames: this.flames.length,
        bodies: this.physics.count,
        bugs: this.bugs.length,
      },
      quality: this.qualityTier,
      pixelRatio: this.dpr,
      targetFps,
    });
    if (recommendation && this.qualityMode === "auto") this.applyQuality(recommendation);

    if (this.hasActiveWork()) this.requestFrame();
  };

  private requestFrame() {
    if (this.disposed || this.raf) return;
    this.raf = requestAnimationFrame(this.frame);
  }

  private hasActiveWork() {
    return (
      this.particles.length > 0 ||
      this.flames.length > 0 ||
      this.physics.active ||
      this.bugs.length > 0 ||
      this.collapseQueue.length > 0 ||
      !!this._singularity ||
      !!this.activeTool ||
      this.shakeAmount > 0.2 ||
      Math.abs(this.kickX) >= 0.15 ||
      Math.abs(this.kickY) >= 0.15 ||
      Math.abs(this.shakeRoll) >= 0.00012
    );
  }

  private hasPostFXDemand() {
    if (this.flames.length > 0 || this.destruction > 0.016 || this._singularity) return true;
    for (const particle of this.particles) {
      if (particle.kind === "flash" || particle.kind === "jet") return true;
    }
    return false;
  }

  private resetHeat() {
    if (!this.postfxEnabled) {
      this.heatLevel = 0;
      return;
    }
    const ctx = this.heatCtx;
    const canvas = this.heatCanvas;
    if (!ctx || !canvas) return;
    this.heatLevel = 0;
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    // Opaque black, so `lighter` stamps accumulate against a known floor and
    // the uploaded texture needs no alpha handling in the shader.
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  /**
   * Smooth the pointer's motion for the drawn tool. Raw per-event deltas are
   * far too jittery to pose from — a broom's bristles would buzz — so the art
   * gets a low-passed velocity and, from it, a slow-turning aim direction.
   */
  private stepToolArt(dt: number) {
    const p = this.pointer;
    if (p.x <= -999) {
      this.artVX = this.artVY = 0;
      this.artPrev.x = this.artPrev.y = -1000;
      return;
    }
    if (this.artPrev.x > -999 && dt > 0) {
      const k = Math.min(1, dt * 14);
      this.artVX += ((p.x - this.artPrev.x) / dt - this.artVX) * k;
      this.artVY += ((p.y - this.artPrev.y) / dt - this.artVY) * k;
      const m = Math.hypot(this.artVX, this.artVY);
      // Only decisive motion re-aims; hovering keeps the last direction.
      if (m > 60) {
        const ka = Math.min(1, dt * (4 + m * 0.004));
        this.artAimX += (this.artVX / m - this.artAimX) * ka;
        this.artAimY += (this.artVY / m - this.artAimY) * ka;
        const am = Math.hypot(this.artAimX, this.artAimY) || 1;
        this.artAimX /= am;
        this.artAimY /= am;
      }
    }
    this.artPrev.x = p.x;
    this.artPrev.y = p.y;
  }

  /**
   * Draw the active tool at the pointer — the drawn tool is the cursor (the
   * CSS one is hidden while a tool with art is selected). Runs last in the
   * frame so the hammer is over its own dust, and on the fx canvas so the
   * post-processing chain (heat haze, bloom) treats it as part of the scene.
   */
  private renderToolArt(ctx: CanvasRenderingContext2D, time: number) {
    const art = this.activeTool!.art!;
    ctx.save();
    ctx.translate(this.pointer.x, this.pointer.y);
    art(ctx, {
      time,
      held: this.pointerDown,
      sinceDown: time - this.artDownAt,
      sinceUp: time - this.artUpAt,
      vx: this.artVX,
      vy: this.artVY,
      aimX: this.artAimX,
      aimY: this.artAimY,
    });
    ctx.restore();
    // Aim dot on the hotspot itself, so precision aiming survives the switch
    // from a CSS cursor to a drawn tool.
    ctx.beginPath();
    ctx.arc(this.pointer.x, this.pointer.y, 2.2, 0, TAU);
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  private stepPhysics(dt: number) {
    if (!this.opts.physics || this.physics.count === 0) return;
    // Debris settles at the bottom of the *window*. On a page ten screens tall,
    // a document-floor heap would simply be somewhere you are not looking.
    const floorY = Math.min(this.h, this.scrollY + this.viewportH) - 1;
    this.physics.setBounds(this.w, floorY);
    this.physics.step(dt);
  }

  /** Feed the collapse queue: one element every ~55 ms, so the page falls in a wave. */
  private stepCollapse(dt: number) {
    if (this.collapseQueue.length === 0) return;
    this.collapseTimer -= dt;
    while (this.collapseTimer <= 0 && this.collapseQueue.length > 0) {
      this.collapseTimer += 0.055;
      const el = this.collapseQueue.shift()!;
      if (!el.taken) this.dropElement(el, el.x + el.w / 2, el.y - 40);
    }
  }

  private stepSingularity(dt: number) {
    const s = this._singularity;
    if (!s) {
      // Clearing is idempotent and cheap; the renderer repaints the warped
      // region once so the page straightens back out.
      this.contentLayer?.setWarp(null);
      this.sound.loop("void", 0);
      return;
    }
    s.charge = Math.min(1, s.charge + dt * 1.8);
    const r = s.radius * s.charge;
    this.sound.loop("void", 0.45 * s.charge);

    // Spacetime around the hole: gravitational lensing + frame-dragging swirl
    // in the surface shader. Pure re-shading — no texture upload — so driving
    // it every frame costs only the warped rectangle's fill rate.
    this.contentLayer?.setWarp(s.x, s.y, Math.max(10, r * 0.9), s.charge);

    // A black hole doesn't nibble, it *accretes*: every so often it rips the
    // nearest intact page element loose whole, and the inverse-square pull
    // below drags the pieces across the page and swallows them. This is what
    // makes a held singularity consume the site rather than drill one hole.
    this.singularityFeed -= dt;
    if (this.singularityFeed <= 0 && s.charge > 0.6 && this.opts.physics) {
      this.singularityFeed = 0.55;
      let nearest: PageElement | null = null;
      let best = Infinity;
      const reach = r * 6;
      for (const el of this.pageElements) {
        if (el.taken) continue;
        const dx = el.x + el.w / 2 - s.x;
        const dy = el.y + el.h / 2 - s.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < best && d2 < reach * reach) {
          best = d2;
          nearest = el;
        }
      }
      if (nearest) this.dropElement(nearest, s.x, s.y);
    }

    // Bugs unlucky enough to crawl inside the horizon are simply gone — no
    // smear, no smoke; nothing comes back out of a black hole.
    for (let i = this.bugs.length - 1; i >= 0; i--) {
      const b = this.bugs[i];
      const dx = b.x - s.x;
      const dy = b.y - s.y;
      if (dx * dx + dy * dy < r * r) this.bugs.splice(i, 1);
    }

    // Eat the page. Throttled because each bite repaints a document-sized
    // canvas, and sixty bites a second is sixty full-page repaints.
    this.singularityBite -= dt;
    if (this.singularityBite <= 0 && this.contentLayer?.ready) {
      this.singularityBite = 0.07;
      this.contentLayer.punch(s.x, s.y, r * 0.92);
    }

    // Loose particles spiral in. The tangential term is what turns a vacuum
    // cleaner into something that looks like it has an accretion disc.
    for (const p of this.particles) {
      const dx = s.x - p.x;
      const dy = s.y - p.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > 810000) continue;
      const d = Math.sqrt(d2) || 1;
      const a = ((s.power * 30) / Math.max(3200, d2)) * dt;
      p.vx += (dx / d) * a - (dy / d) * a * 0.55;
      p.vy += (dy / d) * a + (dx / d) * a * 0.55;
      if (d < r * 0.55) p.life = p.maxLife;
    }

    // A held singularity is a vacuum for wreckage: everything the page has
    // already shed gets hauled across the screen and destroyed at the horizon.
    // `attract` pulls inverse-linearly, so with this strength a fully charged
    // hole moves debris at ~1700 px/s² even 600 px away — the whole visible
    // heap drains into the void in a couple of seconds — while the capture
    // funnel near the horizon guarantees pulled pieces are actually consumed.
    const eaten = this.physics.attract(s.x, s.y, s.power * 260 * s.charge, dt, r * 0.8);
    if (eaten.length > 0) {
      this.shake(3.5);
      // A gulp of light at the horizon per swallowed chunk — the one visual
      // acknowledgement that matter just left the simulation.
      this.spawnParticle({
        kind: "flash",
        x: s.x,
        y: s.y,
        vx: 0,
        vy: 0,
        life: 0,
        maxLife: 0.16,
        size: r * 1.5,
      });
    }

    // Infalling matter, spawned on a shell well outside the horizon so it has
    // room to visibly stretch and curve on the way down.
    this.spaghettiDebt += dt * 120 * s.charge;
    const strands = Math.floor(this.spaghettiDebt);
    this.spaghettiDebt -= strands;
    for (let i = 0; i < strands; i++) {
      const a = Math.random() * TAU;
      const d = r * (2.4 + Math.random() * 3.4);
      const tangent = a + Math.PI / 2;
      const speed = 120 + Math.random() * 220;
      this.spawnParticle({
        kind: "spaghetti",
        x: s.x + Math.cos(a) * d,
        y: s.y + Math.sin(a) * d,
        vx: Math.cos(tangent) * speed - Math.cos(a) * speed * 0.5,
        vy: Math.sin(tangent) * speed - Math.sin(a) * speed * 0.5,
        life: 0,
        maxLife: 0.5 + Math.random() * 0.7,
        size: 1.4 + Math.random() * 2.6,
        gravity: 0,
        color: Math.random() < 0.4 ? "#c98bff" : "#ffb066",
      });
    }
    this.heat(s.x, s.y, r * 2.4, 0.55 * s.charge);
  }

  // ── Fuel ────────────────────────────────────────────────────────────────

  private ensureFuel() {
    const cols = Math.max(1, Math.ceil(this.w / FUEL_CELL));
    const rows = Math.max(1, Math.ceil(this.h / FUEL_CELL));
    if (this.fuel && cols === this.fuelCols && rows === this.fuelRows) return;
    this.fuelCols = cols;
    this.fuelRows = rows;
    this.fuel = new Uint8Array(cols * rows).fill(255);
  }

  /** Remaining fuel under (x, y), 0..1. Unburnt page reads 1. */
  private fuelAt(x: number, y: number): number {
    if (!this.fuel) return 1;
    const cx = Math.min(this.fuelCols - 1, Math.max(0, Math.floor(x / FUEL_CELL)));
    const cy = Math.min(this.fuelRows - 1, Math.max(0, Math.floor(y / FUEL_CELL)));
    return this.fuel[cy * this.fuelCols + cx] / 255;
  }

  /** Burn away fuel under (x, y) and a little in the surrounding cells. */
  private consumeFuel(x: number, y: number, amount: number) {
    this.ensureFuel();
    const fuel = this.fuel!;
    const cx = Math.min(this.fuelCols - 1, Math.max(0, Math.floor(x / FUEL_CELL)));
    const cy = Math.min(this.fuelRows - 1, Math.max(0, Math.floor(y / FUEL_CELL)));
    const i = cy * this.fuelCols + cx;
    fuel[i] = Math.max(0, fuel[i] - amount);
    // Neighbours dry out at a quarter rate: a fire burning through one board
    // scorches the boards beside it before they catch.
    for (const [nx, ny] of [
      [cx - 1, cy],
      [cx + 1, cy],
      [cx, cy - 1],
      [cx, cy + 1],
    ] as const) {
      if (nx < 0 || ny < 0 || nx >= this.fuelCols || ny >= this.fuelRows) continue;
      const j = ny * this.fuelCols + nx;
      fuel[j] = Math.max(0, fuel[j] - amount * 0.25);
    }
  }

  // ── Bugs ────────────────────────────────────────────────────────────────

  spawnBugs(x: number, y: number, count = 1) {
    // A bug needs page to stand on. Released over the void it has nothing to
    // crawl across or eat — so nothing is released, and nothing chirps.
    if (!this.onPage(x, y, 0.5)) return;
    for (let i = 0; i < count && this.bugs.length < MAX_BUGS; i++) {
      this.bugs.push({
        x: x + (Math.random() - 0.5) * 18,
        y: y + (Math.random() - 0.5) * 18,
        a: Math.random() * TAU,
        speed: 26 + Math.random() * 38,
        size: 3 + Math.random() * 2.2,
        ttl: 25 + Math.random() * 30,
        chew: Math.random() * 0.2,
        turn: Math.random() * 1.5,
        seed: Math.random() * TAU,
      });
    }
    this.sound.pop();
    this.requestFrame();
  }

  squashBugs(x: number, y: number, radius: number): number {
    let squashed = 0;
    const r2 = radius * radius;
    for (let i = this.bugs.length - 1; i >= 0; i--) {
      const b = this.bugs[i];
      const dx = b.x - x;
      const dy = b.y - y;
      if (dx * dx + dy * dy > r2) continue;
      this.bugs.splice(i, 1);
      squashed++;
      // The smear a squashed bug leaves. Drawn through surfaceCtx so it
      // persists like any other decal.
      const ctx = this.surfaceCtx;
      ctx.save();
      // The smear is on the page, so it clips to the page — a bug squashed at
      // a hole's rim leaves its mark on the rim, not floating in the void.
      ctx.globalCompositeOperation = "source-atop";
      ctx.fillStyle = "rgba(58, 44, 26, 0.85)";
      for (let s = 0; s < 4; s++) {
        const a = Math.random() * TAU;
        const d = Math.random() * b.size * 1.6;
        ctx.beginPath();
        ctx.ellipse(
          b.x + Math.cos(a) * d,
          b.y + Math.sin(a) * d,
          b.size * (0.5 + Math.random() * 0.7),
          b.size * (0.3 + Math.random() * 0.4),
          Math.random() * TAU,
          0,
          TAU,
        );
        ctx.fill();
      }
      ctx.restore();
      this.markSurface(b.x, b.y, b.size * 4);
    }
    if (squashed > 0) this.sound.splat();
    return squashed;
  }

  /**
   * Bugs carried off the page by a jet of water. Unlike `squashBugs` there is
   * no smear — nothing was crushed — the bug tumbles away on the spray,
   * washed off the page rather than into it.
   */
  flushBugs(x: number, y: number, radius: number): number {
    let flushed = 0;
    const r2 = radius * radius;
    for (let i = this.bugs.length - 1; i >= 0; i--) {
      const b = this.bugs[i];
      const dx = b.x - x;
      const dy = b.y - y;
      if (dx * dx + dy * dy > r2) continue;
      this.bugs.splice(i, 1);
      flushed++;
      // The bug itself, tumbling downstream and off the heap...
      this.spawnParticle({
        kind: "debris",
        x: b.x,
        y: b.y,
        vx: dx * 5 + (Math.random() - 0.5) * 90,
        vy: 60 + Math.random() * 140,
        life: 0,
        maxLife: 0.9 + Math.random() * 0.5,
        size: b.size,
        color: "#3a2c1a",
        angle: Math.random() * TAU,
        spin: (Math.random() - 0.5) * 24,
        bounce: 0.2,
        restY: b.y + 180 + Math.random() * 220,
      });
      // ...in a burst of the water that took it.
      for (let s = 0; s < 5; s++) {
        const a = Math.random() * TAU;
        this.spawnParticle({
          kind: "water",
          x: b.x,
          y: b.y,
          vx: Math.cos(a) * (60 + Math.random() * 120),
          vy: Math.sin(a) * (60 + Math.random() * 120) - 40,
          life: 0,
          maxLife: 0.3 + Math.random() * 0.25,
          size: 2 + Math.random() * 2,
          gravity: 700,
          drag: 1.1,
        });
      }
    }
    return flushed;
  }

  /**
   * Bugs wander and eat. They live at engine level — like flames — so an
   * infestation keeps gnawing while the user switches tools to fight it.
   * And fight back they can: fire burns a bug that wanders into it, and every
   * blast or fracture squashes whatever was underneath (see `explode`/`fracture`).
   */
  private stepBugs(dt: number) {
    for (let i = this.bugs.length - 1; i >= 0; i--) {
      const b = this.bugs[i];
      // Fire kills: a bug that wanders into a burning region goes up with a
      // wisp of smoke and a tiny scorch, no smear — it burned, it wasn't hit.
      let burned = false;
      for (const f of this.flames) {
        const dx = f.x - b.x;
        const dy = f.y - b.y;
        if (f.intensity > 0.2 && dx * dx + dy * dy < f.radius * f.radius) {
          burned = true;
          break;
        }
      }
      // Cold kills the other way: frost stiffens a bug — it slows, stops
      // chewing (frozen page is too hard to gnaw) — and heavy rime freezes it
      // solid where it stands. It comes apart as ice, not as a smear.
      const chill = this.frost ? this.frostAt(b.x, b.y) : 0;
      if (chill > 0.7) {
        for (let s = 0; s < 6; s++) {
          this.spawnParticle({
            kind: "ice",
            x: b.x,
            y: b.y,
            vx: (Math.random() - 0.5) * 120,
            vy: -30 - Math.random() * 90,
            life: 0,
            maxLife: 0.5 + Math.random() * 0.5,
            size: 1.2 + Math.random() * 2.2,
            angle: Math.random() * TAU,
            spin: (Math.random() - 0.5) * 20,
            gravity: 260,
          });
        }
        this.bugs.splice(i, 1);
        continue;
      }
      if (burned) {
        this.contentLayer?.char(b.x, b.y, b.size * 2.5, 0.3);
        this.markSurface(b.x, b.y, b.size * 4);
        this.spawnParticle({
          kind: "smoke",
          x: b.x,
          y: b.y,
          vx: (Math.random() - 0.5) * 20,
          vy: -40 - Math.random() * 30,
          life: 0,
          maxLife: 0.8 + Math.random() * 0.5,
          size: 5 + Math.random() * 4,
          drag: 1.4,
        });
        this.bugs.splice(i, 1);
        continue;
      }
      b.ttl -= dt;
      if (b.ttl <= 0) {
        // Burrows away with a puff rather than blinking out.
        this.spawnParticle({
          kind: "dust",
          x: b.x,
          y: b.y,
          vx: 0,
          vy: -12,
          life: 0,
          maxLife: 0.5,
          size: 4,
        });
        this.bugs.splice(i, 1);
        continue;
      }
      // Skittering: constant jitter plus an occasional decisive turn.
      b.turn -= dt;
      if (b.turn <= 0) {
        b.turn = 0.5 + Math.random() * 1.6;
        b.a += (Math.random() - 0.5) * 2.4;
      }
      b.a += (Math.random() - 0.5) * 3.4 * dt;
      // A chilled bug moves like one: stiff, slow, and easier to catch.
      const mobility = 1 - chill * 0.85;
      b.x += Math.cos(b.a) * b.speed * mobility * dt;
      b.y += Math.sin(b.a) * b.speed * mobility * dt;
      // Turn back at the page edge instead of wandering into the void.
      if (b.x < 4 || b.x > this.w - 4 || b.y < 4 || b.y > this.h - 4) {
        b.a += Math.PI;
        b.x = Math.max(4, Math.min(this.w - 4, b.x));
        b.y = Math.max(4, Math.min(this.h - 4, b.y));
      }
      // Chewing: a small bite out of the page every fraction of a second, which
      // over a wander becomes the classic gnawed-trail look. The same timer
      // doubles as the hole check — a bug at the rim of a hole turns back onto
      // solid page, because it eats the site and the void has nothing to eat.
      b.chew -= dt;
      if (b.chew <= 0 && chill < 0.3 && this.contentLayer?.ready) {
        b.chew = 0.09 + Math.random() * 0.16;
        if (this.contentLayer.opacityAt(b.x, b.y) < 0.5) {
          b.a += Math.PI + (Math.random() - 0.5);
        } else {
          this.contentLayer.burn(b.x, b.y, 1.6 + Math.random() * 1.8);
          this.destruction = Math.min(1, this.destruction + 0.0001);
        }
      }
    }
  }

  /** Draw the bugs into the fx layer: dark segmented body, animated legs. */
  private renderBugs(ctx: CanvasRenderingContext2D, top: number, bottom: number, time: number) {
    for (const b of this.bugs) {
      if (b.y < top - 20 || b.y > bottom + 20) continue;
      const wiggle = Math.sin(time * 22 + b.seed) * 0.35;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.a + wiggle * 0.2);
      // Legs first, three per side, alternating with the gait.
      ctx.strokeStyle = "rgba(20, 14, 8, 0.9)";
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      for (let l = -1; l <= 1; l++) {
        const phase = Math.sin(time * 22 + b.seed + l * 2.1);
        const lx = l * b.size * 0.55;
        ctx.moveTo(lx, 0);
        ctx.lineTo(lx + phase * b.size * 0.4, b.size * 0.9);
        ctx.moveTo(lx, 0);
        ctx.lineTo(lx - phase * b.size * 0.4, -b.size * 0.9);
      }
      ctx.stroke();
      // Two body segments and a head.
      ctx.fillStyle = "rgba(38, 26, 14, 0.95)";
      ctx.beginPath();
      ctx.ellipse(-b.size * 0.35, 0, b.size * 0.62, b.size * 0.45, 0, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(b.size * 0.4, 0, b.size * 0.45, b.size * 0.36, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = "rgba(58, 40, 20, 0.95)";
      ctx.beginPath();
      ctx.arc(b.size * 0.85, 0, b.size * 0.24, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
  }

  private stepFlames(dt: number) {
    for (let i = this.flames.length - 1; i >= 0; i--) {
      const f = this.flames[i];
      f.age += dt;
      // Fire lives on fuel: a full flame over fresh wood, a starving flicker
      // over spent. Age still winds it down eventually, but exhausting the
      // cell underneath is what actually kills a fire now — which is why a
      // blaze gutters out where it has already eaten through instead of
      // burning in place forever.
      const fuel = this.fuelAt(f.x, f.y);
      const starved = fuel < 0.06;
      const target = f.age < 12 && !starved ? 0.35 + 0.65 * fuel : 0;
      f.intensity += (target - f.intensity) * dt * (f.age < 12 && !starved ? 0.35 : 0.12);

      // Fire consumes the page in stages: it catches (chars the surface),
      // burns (erodes into the material), deepens (heavy erosion, spent fuel),
      // and finally breaks through — the hole opens onto the void and the
      // flame dies with it, because the void has nothing left to burn.
      f.scorchCooldown -= dt;
      if (f.scorchCooldown <= 0 && f.intensity > 0.15) {
        // Jittered rather than a flat 0.3s: with a fixed period every flame
        // lit in the same frame stays in lockstep forever, so all of them
        // repaint the (document-sized) content canvas on the same frame.
        f.scorchCooldown = 0.26 + Math.random() * 0.14;
        // Fire returns frost's favour: rime stops a fire catching (see
        // `spawnFlame`), and an established flame steadily melts the rime
        // around it — boiling off as steam, so a frozen patch next to a blaze
        // doesn't stay improbably frozen.
        if (this.frost && this.frostAt(f.x, f.y) > 0.04) {
          this.meltFrost(f.x, f.y, f.radius * 1.8, 0.5);
          this.spawnParticle({
            kind: "steam",
            x: f.x + (Math.random() - 0.5) * f.radius * 1.6,
            y: f.y - Math.random() * 8,
            vx: (Math.random() - 0.5) * 60,
            vy: -60 - Math.random() * 70,
            life: 0,
            maxLife: 0.8 + Math.random() * 0.8,
            size: 8 + Math.random() * 12,
            drag: 1.5,
          });
        }
        const layer = this.contentLayer;
        if (layer?.ready) {
          const opacity = layer.opacityAt(f.x, f.y);
          if (opacity < 0.25 || (fuel < 0.05 && f.age > 1.5)) {
            // Stage 4 — breakthrough. The material under the flame is gone:
            // open the hole cleanly, throw one last gasp of embers and smoke,
            // and put the flame out. Fire never lives over the void.
            layer.punch(f.x, f.y, f.radius * 0.55);
            for (let s = 0; s < 6; s++) {
              const a = Math.random() * TAU;
              this.spawnParticle({
                kind: "ember",
                x: f.x + Math.cos(a) * f.radius * 0.5,
                y: f.y + Math.sin(a) * f.radius * 0.4,
                vx: Math.cos(a) * (30 + Math.random() * 60),
                vy: -40 - Math.random() * 80,
                life: 0,
                maxLife: 0.8 + Math.random() * 1,
                size: 1.5 + Math.random() * 2,
                gravity: 40,
                drag: 1.2,
              });
            }
            for (let s = 0; s < 3; s++) {
              this.spawnParticle({
                kind: "smoke",
                x: f.x + (Math.random() - 0.5) * f.radius,
                y: f.y - Math.random() * 8,
                vx: (Math.random() - 0.5) * 20,
                vy: -50 - Math.random() * 40,
                life: 0,
                maxLife: 1.4 + Math.random(),
                size: 8 + Math.random() * 8,
                drag: 1.3,
              });
            }
            this.flames.splice(i, 1);
            continue;
          }
          if (f.age < 0.8) {
            // Stage 1 — catching: the surface darkens but nothing is lost yet.
            layer.char(f.x, f.y + 2, f.radius * 0.5, 0.1);
          } else if (fuel > 0.5) {
            // Stage 2 — burning: the char deepens and erosion begins.
            layer.char(f.x, f.y + 2, f.radius * 0.85, 0.16);
            layer.burn(f.x, f.y + 2, f.radius * 0.22);
            this.consumeFuel(f.x, f.y, 9 + 13 * f.intensity);
          } else {
            // Stage 3 — deepening: the fire is inside the material now, eating
            // fast toward breakthrough, and the rim glows with thrown embers.
            layer.burn(f.x, f.y + 2, f.radius * (0.3 + f.intensity * 0.35));
            this.consumeFuel(f.x, f.y, 13 + 16 * f.intensity);
            if (Math.random() < 0.5) {
              const a = Math.random() * TAU;
              this.spawnParticle({
                kind: "ember",
                x: f.x + Math.cos(a) * f.radius * 0.6,
                y: f.y + Math.sin(a) * f.radius * 0.4,
                vx: (Math.random() - 0.5) * 30,
                vy: -20 - Math.random() * 40,
                life: 0,
                maxLife: 1 + Math.random(),
                size: 1.4 + Math.random() * 1.8,
                gravity: -6,
                drag: 1.6,
              });
            }
          }
        } else {
          drawScorch(
            this.damageCtx,
            f.x + (Math.random() - 0.5) * 8,
            f.y + 4 + (Math.random() - 0.5) * 6,
            f.radius * (0.5 + f.intensity * 0.5),
            0.05 + f.intensity * 0.06,
          );
        }
      }

      // Fire spreads: strong flames seed children nearby.
      f.spreadCooldown -= dt;
      if (f.spreadCooldown <= 0 && f.intensity > 0.75 && this.flames.length < this.opts.maxFlames) {
        f.spreadCooldown = 2 + Math.random() * 3;
        const angle = Math.random() * TAU;
        const dist = f.radius * (1.2 + Math.random());
        const nx = f.x + Math.cos(angle) * dist;
        // Heat rises: children bias upward, so a fire climbs the page the way
        // flame climbs a board rather than blooming symmetrically.
        const ny = f.y + Math.sin(angle) * dist * 0.6 - dist * 0.3;
        // And it only takes hold where there is still wood to take.
        if (nx > 0 && nx < this.w && ny > 0 && ny < this.h && this.fuelAt(nx, ny) > 0.22) {
          this.spawnFlame(nx, ny, 0.25);
        }
      }

      // Sap-pocket pops: an audible crack that throws a fistful of embers, so a
      // sustained fire keeps startling you instead of settling into wallpaper.
      f.popCooldown -= dt;
      if (f.popCooldown <= 0 && f.intensity > 0.55) {
        f.popCooldown = 1.8 + Math.random() * 4;
        for (let s = 0; s < 5 + Math.floor(Math.random() * 5); s++) {
          const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.4;
          const speed = 110 + Math.random() * 220;
          this.spawnParticle({
            kind: "ember",
            x: f.x,
            y: f.y - f.radius * 0.4,
            vx: Math.cos(a) * speed,
            vy: Math.sin(a) * speed,
            life: 0,
            maxLife: 0.7 + Math.random() * 0.8,
            size: 1.8 + Math.random() * 2.6,
            gravity: 130,
            drag: 1.1,
          });
        }
        if (this.lastTime > this.nextPop) {
          this.nextPop = this.lastTime + 280;
          this.sound.pop();
        }
      }

      // Smoke + embers. Rates are per *second* and scaled by dt: as per-frame
      // probabilities they doubled on a 120Hz display, which is exactly where
      // the frame budget is already halved — the particle cap then sat pinned
      // and every extra puff was overdraw nobody asked for.
      if (f.intensity > 0.2) {
        // Smoke is the single biggest particle cost of a big fire: each puff
        // lives for seconds and is drawn twice while warm. Fewer, larger, and
        // shorter-lived puffs keep the rolling-column look at a fraction of
        // the population — 14/s per flame, down from 34/s.
        if (Math.random() < f.intensity * 14 * dt) {
          // Rolling column: puffs are launched hard, then dragged to a crawl, so
          // they bunch up and billow overhead instead of streaming away as dots.
          this.spawnParticle({
            kind: "smoke",
            x: f.x + (Math.random() - 0.5) * f.radius,
            y: f.y - f.radius * 0.9,
            vx: (Math.random() - 0.5) * 55,
            vy: -70 - Math.random() * 90 * f.intensity,
            life: 0,
            maxLife: 1.7 + Math.random() * 1.7,
            size: 12 + Math.random() * 18 * f.intensity,
            gravity: -18,
            drag: 1.5,
            spin: (Math.random() - 0.5) * 1.2,
            angle: Math.random() * TAU,
            phase: Math.random() * TAU,
          });
        }
        if (Math.random() < f.intensity * 6 * dt) {
          this.spawnParticle({
            kind: "ember",
            x: f.x + (Math.random() - 0.5) * f.radius * 0.8,
            y: f.y - f.radius * 0.5,
            vx: (Math.random() - 0.5) * 50,
            vy: -60 - Math.random() * 80,
            life: 0,
            maxLife: 0.7 + Math.random() * 0.9,
            size: 1.5 + Math.random() * 2,
            gravity: 60,
          });
        }
      }

      if (f.intensity <= 0.02) {
        // Died — final char + a puff of smoke.
        if (this.contentLayer?.ready) {
          this.contentLayer.char(f.x, f.y, f.radius, 0.35);
        } else {
          drawScorch(this.damageCtx, f.x, f.y + 3, f.radius * 0.8, 0.15);
        }
        // Burnt through its wood: the spot smoulders — slow dim embers that
        // glow and die in place — instead of the fire just switching off.
        if (starved) {
          for (let s = 0; s < 3; s++) {
            this.spawnParticle({
              kind: "ember",
              x: f.x + (Math.random() - 0.5) * f.radius,
              y: f.y + (Math.random() - 0.5) * 6,
              vx: (Math.random() - 0.5) * 6,
              vy: -4 - Math.random() * 8,
              life: 0,
              maxLife: 2.5 + Math.random() * 2.5,
              size: 1.2 + Math.random() * 1.6,
              gravity: -2,
              drag: 2.2,
            });
          }
        }
        for (let s = 0; s < 4; s++) {
          this.spawnParticle({
            kind: "smoke",
            x: f.x + (Math.random() - 0.5) * f.radius,
            y: f.y - Math.random() * 8,
            vx: (Math.random() - 0.5) * 15,
            vy: -30 - Math.random() * 25,
            life: 0,
            maxLife: 1.5 + Math.random(),
            size: 7 + Math.random() * 8,
            drag: 1.2,
          });
        }
        // Cooling rim: the char edge keeps glowing for a moment after the flame
        // itself is out, which is what makes the burn look hot rather than drawn.
        for (let s = 0; s < 7; s++) {
          const a = Math.random() * TAU;
          const d = f.radius * (0.55 + Math.random() * 0.45);
          this.spawnParticle({
            kind: "ember",
            x: f.x + Math.cos(a) * d,
            y: f.y + Math.sin(a) * d * 0.6,
            vx: (Math.random() - 0.5) * 12,
            vy: -6 - Math.random() * 14,
            life: 0,
            maxLife: 1.1 + Math.random() * 1.4,
            size: 1.6 + Math.random() * 2.2,
            gravity: -4,
          });
        }
        this.flames.splice(i, 1);
      }
    }
  }

  private stepParticles(dt: number) {
    // Single compaction pass: survivors are written down over dead particles,
    // so removing hundreds of expiring droplets a second costs one linear walk
    // instead of a `splice` (O(n) memmove) per death.
    const list = this.particles;
    let write = 0;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      p.life += dt;
      if (p.life >= p.maxLife) {
        // A drip that has stopped moving leaves a permanent run on the page.
        // Queued, not stamped here: the content canvas is document-sized and
        // this pass is already the hot loop.
        if (p.kind === "paint" && this.onPage(p.x, p.y)) this.pendingStamps.push(p);
        continue;
      }

      const gravity =
        p.gravity ?? (p.kind === "smoke" || p.kind === "steam" || p.kind === "dust" ? -10 : 350);
      p.vy += gravity * dt;
      if (p.drag) {
        p.vx *= 1 - p.drag * dt;
        p.vy *= 1 - p.drag * dt;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.angle !== undefined && p.spin) p.angle += p.spin * dt;
      // Paint clings while there is a surface under it. Reaching a hole turns
      // the run into a falling drop; in this 2D layer that means it leaves the
      // page without stamping a bridge across the void.
      if (p.kind === "paint" && !this.onPage(p.x, p.y)) continue;
      // Runs trail behind whatever is sliding down the page — water rivulets
      // and paint drips both leave a tail as long as the distance they covered.
      if (p.kind === "rivulet" || p.kind === "paint") p.len = (p.len ?? 0) + Math.max(0, p.vy) * dt;

      // Landing. Solid bits fall out of the page and clatter onto whatever is
      // below; settling them (rather than letting them sink forever) is most of
      // what makes debris read as physical.
      if (p.bounce && p.restY !== undefined && p.vy > 0 && p.y >= p.restY) {
        p.y = p.restY;
        p.vy = -p.vy * p.bounce;
        p.vx *= 0.55;
        if (p.spin) p.spin *= 0.4;
        if (p.kind === "casing" && p.bounce > 0.35 && this.lastTime > this.nextTink) {
          this.nextTink = this.lastTime + 45;
          this.sound.tink();
        }
        p.bounce *= 0.42;
        if (p.bounce < 0.12) {
          p.bounce = 0;
          p.vx = p.vy = 0;
          p.gravity = 0;
          p.spin = 0;
        }
      }

      // Water droplets extinguish flames they touch.
      if (p.kind === "water") {
        if (this.flames.length > 0 && this.dowseFlames(p.x, p.y, 10, 0.12) > 0) continue;
        // Splash when a droplet "lands" (end of its arc). Deferred: spawning
        // mid-compaction could land a new particle in a slot this pass has
        // already walked past.
        if (p.life > p.maxLife * 0.85) {
          if (this.onPage(p.x, p.y)) this.pendingSplashes.push(p.x, p.y);
          continue;
        }
      }
      list[write++] = p;
    }
    list.length = write;
    if (this.recycleCursor >= write) this.recycleCursor = 0;

    for (let i = 0; i < this.pendingSplashes.length; i += 2) {
      this.spawnSplash(this.pendingSplashes[i], this.pendingSplashes[i + 1]);
    }
    this.pendingSplashes.length = 0;

    if (this.pendingStamps.length > 0) {
      const ctx = this.surfaceCtx;
      for (const p of this.pendingStamps) {
        drawPaintStreak(ctx, p.x, p.y, p.len ?? 8, p.size, p.color ?? "#e63946", p.color2);
        // Splashes land wherever the paint flew, not under the cursor.
        this.contentLayer?.markSurface(p.x, p.y, (p.len ?? 8) + p.size);
      }
      this.pendingStamps.length = 0;
    }
  }

  private spawnSplash(x: number, y: number) {
    for (let i = 0; i < 3; i++) {
      this.spawnParticle({
        kind: "splash",
        x,
        y,
        vx: (Math.random() - 0.5) * 90,
        vy: -Math.random() * 70,
        life: 0,
        maxLife: 0.25 + Math.random() * 0.2,
        size: 1 + Math.random() * 2,
      });
    }
    // Lingering wet mark.
    this.spawnParticle({
      kind: "wet",
      x,
      y,
      vx: 0,
      vy: 12,
      life: 0,
      maxLife: 2.5 + Math.random() * 2,
      size: 5 + Math.random() * 9,
      gravity: 0,
    });
    // Every few splashes, one gathers into a run that streaks down the page.
    if (Math.random() < 0.22) {
      this.spawnParticle({
        kind: "rivulet",
        x,
        y,
        vx: (Math.random() - 0.5) * 8,
        vy: 30 + Math.random() * 50,
        life: 0,
        maxLife: 1.1 + Math.random() * 1.2,
        size: 1.4 + Math.random() * 1.8,
        gravity: 90,
        drag: 1.6,
        len: 0,
      });
    }
  }

  /**
   * Park the (viewport-sized) fx canvas over the visible band and set up a
   * matching drawing transform, so the rest of the renderer keeps working in
   * document coordinates. Returns the visible document band for culling.
   */
  private positionFx() {
    const left = Math.max(0, this.scrollX);
    const top = Math.max(0, this.scrollY - FX_MARGIN);
    if (left !== this.fxOffsetX || top !== this.fxOffsetY) {
      this.fxOffsetX = left;
      this.fxOffsetY = top;
      // A transform (not `top`/`left`) so scrolling never re-rasters the layer.
      // Whichever canvas is actually in the DOM is the one that has to move.
      const presented = this.postfxActive ? this.postfx!.canvas : this.fxCanvas;
      presented.style.transform = `translate3d(${left}px, ${top}px, 0)`;
    }
    // The vignette tracks the viewport itself, not the fx band, so it needs its
    // own offset — `top` is clamped at the top of the document and would stick.
    const vTop = Math.max(0, Math.min(this.scrollY, this.h - this.viewportH));
    if (left !== this.vignetteOffsetX || vTop !== this.vignetteOffsetY) {
      this.vignetteOffsetX = left;
      this.vignetteOffsetY = vTop;
      this.vignette.style.transform = `translate3d(${left}px, ${vTop}px, 0)`;
    }
    const dpr = this.dpr;
    this._fxCtx.setTransform(dpr, 0, 0, dpr, -left * dpr, -top * dpr);
    return { left, top, right: left + this.fxW, bottom: top + this.fxH };
  }

  private render() {
    this.postFXFrameMs = 0;
    const time = this.lastTime / 1000;
    const ctx = this._fxCtx;
    const view = this.positionFx();

    // A tool with drawn art keeps the canvas live whenever the pointer is on
    // the page — the tool itself is being rendered, even with nothing else on.
    const artVisible =
      this.opts.toolStyle === "3d" && !!this.activeTool?.art && this.pointer.x > -999;
    const idle =
      this.particles.length === 0 &&
      this.flames.length === 0 &&
      this.physics.count === 0 &&
      this.bugs.length === 0 &&
      !this._singularity &&
      !artVisible;
    if (idle) {
      // Nothing to draw: clear once after the last active frame, then leave the
      // canvas (and the compositor) completely alone while idle.
      if (this.fxPainted) {
        ctx.clearRect(view.left, view.top, this.fxW, this.fxH);
        if (this.postfxActive) this.postfx?.clear();
        this.fxPainted = false;
      }
      return;
    }
    ctx.clearRect(view.left, view.top, this.fxW, this.fxH);
    this.fxPainted = true;

    // Bugs crawl *on* the page, under every particle and piece of debris.
    if (this.bugs.length > 0) this.renderBugs(ctx, view.top, view.bottom, time);

    // One classification pass. Particles live in document space and the page
    // can be far taller than the screen, so anything outside the fx band is
    // dropped here instead of being submitted and clipped by the canvas.
    const wet = this.bucketWet;
    const puff = this.bucketPuff;
    const bit = this.bucketBit;
    const hot = this.bucketHot;
    wet.length = puff.length = bit.length = hot.length = 0;
    for (const p of this.particles) {
      if (p.x < view.left - 200 || p.x > view.right + 200) continue;
      if (p.y < view.top - 200 || p.y > view.bottom + 200) continue;
      switch (p.kind) {
        case "wet":
        case "splash":
        case "water":
        case "rivulet":
        case "stream":
          wet.push(p);
          break;
        case "smoke":
        case "steam":
        case "dust":
          puff.push(p);
          break;
        case "debris":
        case "casing":
        case "sawdust":
        case "shard":
        case "paint":
        case "ice":
          bit.push(p);
          break;
        case "ember":
        case "spark":
        case "flash":
        case "ring":
        case "streak":
        case "jet":
        case "sparkle":
        case "spaghetti":
          hot.push(p);
          break;
      }
    }

    // Wet marks + splashes under everything else. Wet patches are a soft sheen
    // rather than a filled ellipse — a hard-edged blob reads as a grey stain on
    // a dark page, where a feathered one reads as a surface that is damp.
    const sprite = sprites();
    for (const p of wet) {
      if (p.kind !== "wet") continue;
      const t = p.life / p.maxLife;
      blitRect(ctx, sprite.mist, p.x, p.y, p.size * 1.5, p.size * 0.95, 0.16 * (1 - t));
    }
    ctx.globalAlpha = 1;
    for (const p of wet) {
      if (p.kind === "wet") continue;
      const t = p.life / p.maxLife;
      if (p.kind === "stream") {
        // The unbroken column of water leaving the nozzle, before it fans out
        // into droplets. Drawn opaque, not additively — water occludes.
        blitStreak(
          ctx,
          sprite.streakWater,
          p.x,
          p.y,
          p.angle ?? 0,
          p.len ?? 40,
          p.size,
          0.85 * (1 - t * 0.6),
        );
        continue;
      }
      if (p.kind === "rivulet") {
        // A run of water sliding down the page: a fading tail behind a bead.
        blitStreak(
          ctx,
          sprite.streakWater,
          p.x,
          p.y,
          Math.PI / 2,
          -(p.len ?? 0),
          p.size * 2.4,
          0.5 * (1 - t),
        );
        ctx.fillStyle = "rgb(150, 195, 240)";
        ctx.globalAlpha = 0.75 * (1 - t);
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, p.size * 0.8, p.size * 1.15, 0, 0, TAU);
        ctx.fill();
        continue;
      }
      ctx.fillStyle = p.kind === "water" ? "rgb(140, 190, 240)" : "rgb(160, 200, 240)";
      ctx.globalAlpha = p.kind === "water" ? 0.85 : 0.7 * (1 - t);
      ctx.beginPath();
      ctx.ellipse(
        p.x,
        p.y,
        p.size * 0.7,
        p.size * 1.3,
        Math.atan2(p.vy, p.vx) + Math.PI / 2,
        0,
        TAU,
      );
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Flames render here — with the other *surface-bound* effects, before the
    // mask below — not in the airborne additive pass at the end.
    ctx.globalCompositeOperation = "lighter";
    for (const f of this.flames) {
      if (f.y < view.top - 300 || f.y > view.bottom + 300) continue;
      if (f.x < view.left - 300 || f.x > view.right + 300) continue;
      this.renderFlame(ctx, f, time);
      // Air above a fire is what the shimmer shader distorts.
      this.heat(f.x, f.y - f.radius, f.radius * 3.2, 0.5 * f.intensity);
    }
    ctx.globalCompositeOperation = "source-over";

    // ── The void line ──────────────────────────────────────────────────────
    // Everything drawn so far lives ON the page: crawling bugs, water sheeting
    // down it, fire eating it. Clip all of it to the page's surviving pixels,
    // so a flame at the rim of a hole is cut off exactly at the rim and water
    // sprayed into a hole simply falls out of the world. The void is not a
    // place; nothing that happens on the site is visible in it. Airborne
    // effects (smoke, debris, shockwaves) draw *after* this and stay visible
    // over holes, because they fly in front of the page, not on it.
    if (this.bugs.length > 0 || wet.length > 0 || this.flames.length > 0) {
      this.maskFxToPage(ctx, view);
    }

    // Smoke, steam and dust (normal blending, soft grey/white).
    for (const p of puff) {
      const t = p.life / p.maxLife;
      if (p.kind === "dust") {
        blit(
          ctx,
          sprite.dust,
          p.x,
          p.y,
          p.size * (1 + t * 2.6),
          0.3 * (1 - t) * Math.min(1, t * 8),
        );
        continue;
      }
      if (p.kind === "steam") {
        blit(
          ctx,
          sprite.steam,
          p.x,
          p.y,
          p.size * (1 + t * 2.2),
          0.32 * (1 - t) * Math.min(1, t * 6),
        );
        continue;
      }
      // Smoke: born lit by the fire it came off, cooling to grey as it climbs,
      // and swaying so a column rolls rather than sliding straight up.
      const sway = Math.sin(time * 1.6 + (p.phase ?? 0)) * p.size * 0.5 * t;
      const fade = (1 - t) * Math.min(1, t * 5);
      if (t < 0.35)
        blit(
          ctx,
          sprite.smokeWarm,
          p.x + sway,
          p.y,
          p.size * (1 + t * 2.4),
          0.34 * fade * (1 - t / 0.35),
        );
      blit(ctx, sprite.smoke, p.x + sway, p.y, p.size * (1 + t * 2.6), 0.3 * fade);
    }
    ctx.globalAlpha = 1;

    // Solid bits: debris, casings, sawdust, paint drips, and flying page shards.
    for (const p of bit) {
      const t = p.life / p.maxLife;
      if (p.kind === "paint") {
        // The wet head of a drip; the run it leaves behind is stamped on death.
        ctx.globalAlpha = 0.92;
        ctx.fillStyle = p.color ?? "#e63946";
        ctx.beginPath();
        ctx.ellipse(
          p.x,
          p.y - (p.len ?? 0) * 0.5,
          p.size * 0.5,
          p.size * 0.5 + (p.len ?? 0) * 0.5,
          0,
          0,
          TAU,
        );
        ctx.fill();
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * 0.85, 0, TAU);
        ctx.fill();
        continue;
      }
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle ?? 0);
      ctx.globalAlpha = 1 - t * t;
      if (p.kind === "ice") {
        // A splinter of frozen page: a pale facet with one lit edge. Triangular
        // rather than square, because ice breaks along planes.
        ctx.fillStyle = "rgba(206, 238, 255, 0.9)";
        ctx.beginPath();
        ctx.moveTo(0, -p.size);
        ctx.lineTo(p.size * 0.8, p.size * 0.7);
        ctx.lineTo(-p.size * 0.7, p.size * 0.6);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
        ctx.lineWidth = 0.8;
        ctx.stroke();
      } else if (p.kind === "shard" && p.img) {
        // A torn-off chunk of the real page tumbling through the air. The ghost
        // behind it is a cheap motion blur — one extra blit, no filter.
        const speed = Math.abs(p.vx) + Math.abs(p.vy);
        if (speed > 200) {
          ctx.globalAlpha = (1 - t * t) * 0.28;
          ctx.drawImage(
            p.img,
            p.sx!,
            p.sy!,
            p.sw!,
            p.sh!,
            -p.size / 2 - p.vx * 0.012,
            -p.size / 2 - p.vy * 0.012,
            p.size,
            p.size,
          );
          ctx.globalAlpha = 1 - t * t;
        }
        ctx.drawImage(p.img, p.sx!, p.sy!, p.sw!, p.sh!, -p.size / 2, -p.size / 2, p.size, p.size);
        ctx.strokeStyle = "rgba(10, 8, 6, 0.55)";
        ctx.lineWidth = 1;
        ctx.strokeRect(-p.size / 2, -p.size / 2, p.size, p.size);
        // Lit top edge, so a tumbling shard catches the light as it spins.
        ctx.strokeStyle = "rgba(255, 252, 245, 0.4)";
        ctx.beginPath();
        ctx.moveTo(-p.size / 2, -p.size / 2);
        ctx.lineTo(p.size / 2, -p.size / 2);
        ctx.stroke();
      } else if (p.kind === "casing") {
        ctx.fillStyle = "#c9a227";
        ctx.fillRect(-p.size, -p.size * 0.4, p.size * 2, p.size * 0.8);
        ctx.fillStyle = "rgba(255, 240, 190, 0.7)";
        ctx.fillRect(-p.size, -p.size * 0.4, p.size * 2, p.size * 0.25);
      } else {
        ctx.fillStyle = p.color ?? (p.kind === "sawdust" ? "#a8865a" : "#55504b");
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
      }
      ctx.restore();
    }

    // Rigid debris. Opaque, and above the loose particles: a falling chunk of
    // page is a solid object and has to occlude the dust it kicked up.
    if (this.physics.count > 0) {
      this.physics.render(
        ctx,
        view.left - 200,
        view.top - 200,
        view.right + 200,
        view.bottom + 200,
      );
    }

    // The singularity's horizon. Drawn source-over, not additively — the one
    // thing on this layer whose job is to be a hole rather than a light.
    const sing = this._singularity;
    if (sing) {
      const r = sing.radius * sing.charge;
      blit(ctx, sprites().singularity, sing.x, sing.y, r, 1);
      ctx.globalAlpha = 1;
    }

    // Additive pass: flames, embers, sparks, muzzle flashes.
    ctx.globalCompositeOperation = "lighter";
    if (sing) {
      const r = sing.radius * sing.charge;
      // Accretion band, counter-rotating against the infall and pulsing, so the
      // horizon never sits still even when nothing is being eaten.
      const wobble = 0.9 + 0.1 * Math.sin(time * 9);
      blitRect(ctx, sprites().accretion, sing.x, sing.y, r * 2.1 * wobble, r * 1.5 * wobble, 0.85);
      blitRect(ctx, sprites().accretion, sing.x, sing.y, r * 2.9, r * 0.72, 0.5);
      blit(ctx, sprites().glow, sing.x, sing.y, r * 3.4, 0.16 * sing.charge);
      ctx.globalAlpha = 1;
    }
    for (const p of hot) {
      const t = p.life / p.maxLife;
      switch (p.kind) {
        case "ember":
          blit(
            ctx,
            t < 0.5 ? sprite.emberHot : sprite.emberCool,
            p.x,
            p.y,
            p.size * (1 - t * 0.5) * 1.6,
            1 - t,
          );
          break;
        case "spark":
          // Fast sparks smear into a streak; slow ones stay points.
          if (Math.abs(p.vx) + Math.abs(p.vy) > 260) {
            blitStreak(
              ctx,
              sprite.streakHot,
              p.x,
              p.y,
              Math.atan2(p.vy, p.vx),
              -(Math.abs(p.vx) + Math.abs(p.vy)) * 0.022,
              p.size * 2.6,
              (1 - t) * 0.8,
            );
          }
          blit(ctx, sprite.spark, p.x, p.y, p.size * (1 - t * 0.5) * 1.6, 1 - t);
          break;
        case "ring":
          // Expanding shockwave. Hollow by construction, so it rides over a
          // fresh hole without painting the void back in.
          blit(
            ctx,
            sprite.shockRing,
            p.x,
            p.y,
            p.size * (0.35 + t * 1.9),
            (1 - t) * (1 - t) * 0.85,
          );
          break;
        case "streak":
          blitStreak(
            ctx,
            sprite.streakHot,
            p.x,
            p.y,
            p.angle ?? 0,
            p.len ?? 40,
            p.size,
            (1 - t) * 0.9,
          );
          break;
        case "jet": {
          // Flamethrower fuel: white-hot at the nozzle, swelling and cooling as
          // it flies. The size ramp is what turns a line of dots into a cone.
          const r = p.size * (0.5 + t * 2.6);
          blit(ctx, t < 0.3 ? sprite.flameCore : sprite.flameHigh, p.x, p.y, r, (1 - t) * 0.62);
          blit(ctx, sprite.flameLow, p.x, p.y, r * 1.35, (1 - t) * 0.34);
          break;
        }
        case "spaghetti": {
          // Tidal stretching: the faster it falls, the longer it draws. Colour
          // splits between violet and amber so the disc looks like it has
          // temperature structure rather than being one glowing smear.
          const speed = Math.hypot(p.vx, p.vy);
          blitStreak(
            ctx,
            p.color === "#c98bff" ? sprite.streakWater : sprite.streakHot,
            p.x,
            p.y,
            Math.atan2(p.vy, p.vx),
            -Math.min(90, speed * 0.11),
            p.size * 2.2,
            (1 - t) * 0.7,
          );
          break;
        }
        case "sparkle": {
          // Twinkle: on/off rather than a smooth fade, so it reads as a glint.
          const tw = 0.5 + 0.5 * Math.sin(time * 22 + (p.phase ?? 0));
          blit(ctx, sprite.sparkle, p.x, p.y, p.size * (0.6 + tw * 0.8), (1 - t) * tw);
          break;
        }
        default:
          // Muzzle/impact flash: a warm halo with a white-hot centre. Warm alone
          // reads as a fireball; white alone reads as a lens flare.
          blit(ctx, sprite.flash, p.x, p.y, p.size, 0.55 * (1 - t));
          blit(ctx, sprite.flashWhite, p.x, p.y, p.size * 0.68, 1 - t);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";

    // The tool in hand, over everything it just did.
    if (artVisible) this.renderToolArt(ctx, time);

    this.postFXFrameMs = this.present(time);
  }

  /**
   * Erase every fx pixel that no longer has page under it.
   *
   * One `destination-in` draw of the content surface's visible band: the
   * page's alpha channel is already the authoritative record of what still
   * exists, so using it as a mask clips surface-bound effects to the surviving
   * page pixel-for-pixel — including the parts of the fx band that hang past
   * the document's edges, which have no source pixels and are erased outright.
   * GPU-to-GPU, no readback; costs one viewport-sized draw per frame and only
   * runs when the surface pass drew something.
   */
  private maskFxToPage(
    ctx: CanvasRenderingContext2D,
    view: { left: number; top: number; right: number; bottom: number },
  ) {
    const layer = this.contentLayer;
    if (!layer?.ready) return;
    const x0 = Math.max(0, view.left);
    const y0 = Math.max(0, view.top);
    const x1 = Math.min(layer.width, view.right);
    const y1 = Math.min(layer.height, view.bottom);
    if (x1 <= x0 || y1 <= y0) return;
    const d = layer.dpr;
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(
      layer.surface,
      x0 * d,
      y0 * d,
      (x1 - x0) * d,
      (y1 - y0) * d,
      x0,
      y0,
      x1 - x0,
      y1 - y0,
    );
    ctx.globalCompositeOperation = "source-over";
  }

  /**
   * Hand the finished effects frame to the post-processing chain.
   *
   * Bloom and aberration are scaled by what is actually happening: an idle page
   * with two paint splats gets neither, a page on fire gets both. That keeps
   * the shader honest about cost as well as taste — the blur passes are skipped
   * outright when the bloom weight is zero.
   */
  private present(time: number): number {
    const startedAt = performance.now();
    const postfx = this.postfx;
    if (!this.postfxEnabled || !postfx || !this.heatCanvas) {
      this.setPostFXOutput(false);
      return 0;
    }
    let bloom = 0;
    for (const f of this.flames) bloom += f.intensity;
    bloom = Math.min(0.85, bloom * 0.16 + (this._singularity ? 0.55 : 0));
    // Explosions and muzzle flashes are brief but very bright; let them bloom
    // even with no fire burning.
    for (const p of this.particles) {
      if (p.kind === "flash" || p.kind === "jet") {
        bloom = Math.max(bloom, 0.45);
        break;
      }
    }
    const heat = this.heatLevel * 0.012;
    const aberration = this.destruction * 0.006 + (this._singularity ? 0.004 : 0);

    // A plain particle/debris/tool-art frame has no bloom, heat refraction, or
    // chromatic split. Presenting the source canvas is bit-identical and avoids
    // a full-screen texture upload plus composite pass on those frames.
    if (bloom <= 0.01 && heat <= 0.0001 && aberration <= 0.0001) {
      this.setPostFXOutput(false);
      return performance.now() - startedAt;
    }

    this.setPostFXOutput(true);
    postfx.render(this.fxCanvas, this.heatCanvas, {
      bloom,
      heat,
      aberration,
      time,
    });
    return performance.now() - startedAt;
  }

  /**
   * Flickering multi-layer flame: glowing char rim, body, licking tongue, core.
   *
   * Baked sprites rather than freshly built radial gradients; the flicker lives
   * entirely in the per-draw scale and alpha, which are plain numbers.
   *
   * Two frequencies drive every offset — a slow sway and a fast jitter. One
   * frequency is a wobble; two is the shimmer that reads as heat.
   */
  private renderFlame(ctx: CanvasRenderingContext2D, f: Flame, time: number) {
    const flicker =
      0.85 + 0.15 * Math.sin(time * 13 + f.seed) + 0.08 * Math.sin(time * 29 + f.seed * 2);
    const r = f.radius * f.intensity * flicker;
    if (r < 1) return;
    const { x, y } = f;
    const sprite = sprites();

    // Ambient glow (taller than wide — light pools above a fire), then the hot
    // rim: the burnt edge of the hole glowing where the fire is still eating it.
    // The ring sprite is hollow and drawn flat to the page, so it lights the rim
    // without filling in the hole it surrounds or reading as a bubble.
    blitRect(ctx, sprite.glow, x, y - r * 0.5, r * 1.9, r * 2.5, 0.17 * f.intensity);
    blitRect(
      ctx,
      sprite.heatRing,
      x,
      y + r * 0.2,
      r * 1.85,
      r * 0.8,
      0.2 * f.intensity * (0.85 + 0.15 * Math.sin(time * 7 + f.seed)),
    );

    // Flame body — a column of vertical ellipses, narrower and hotter toward the
    // top, rising well clear of the hole so the fire licks upward. Five layers,
    // not seven: with dozens of flames alight this loop is the render path's
    // hottest blit site, and the two dropped layers were overdraw inside the
    // column, not silhouette.
    const layers = this.qualityProfile.flameLayers;
    for (let i = 0; i < layers; i++) {
      const t = i / (layers - 1);
      const ly = y - r * 2.9 * t;
      const lr = r * (0.82 - t * 0.58) * (0.88 + 0.18 * Math.sin(time * 17 + f.seed + i * 2.1));
      const wobble =
        Math.sin(time * 9 + f.seed + i * 1.7) * r * 0.36 * t +
        Math.sin(time * 24 + f.seed * 3 + i) * r * 0.12 * t;
      const hot = t >= 0.3;
      blitRect(
        ctx,
        hot ? sprite.flameHigh : sprite.flameLow,
        x + wobble,
        ly,
        lr,
        lr * 1.65,
        (hot ? 0.4 : 0.48) * f.intensity,
      );
    }

    // A tongue that detaches off the top and gutters out — the thing real fire
    // does that a stack of circles never will.
    const lick = 0.5 + 0.5 * Math.sin(time * 7.3 + f.seed * 1.7);
    if (lick > 0.42) {
      blitRect(
        ctx,
        sprite.flameHigh,
        x + Math.sin(time * 11 + f.seed) * r * 0.7,
        y - r * (3.1 + lick * 1.9),
        r * 0.26 * lick,
        r * 0.62 * lick,
        0.42 * f.intensity * lick,
      );
    }

    // White-hot core at the base.
    blitRect(ctx, sprite.flameCore, x, y - r * 0.3, r * 0.5, r * 0.86, 0.85 * f.intensity);
  }

  private updateShake(dt: number) {
    const settled =
      this.shakeAmount <= 0.2 &&
      Math.abs(this.kickX) < 0.15 &&
      Math.abs(this.kickY) < 0.15 &&
      Math.abs(this.shakeRoll) < 0.00012;
    if (!settled) {
      const s = this.shakeAmount;
      const tx = (Math.random() - 0.5) * s + this.kickX;
      const ty = (Math.random() - 0.5) * s + this.kickY;
      const roll = this.shakeRoll + (Math.random() - 0.5) * s * 0.00022;
      // Pivot around the middle of what the user is looking at. The container
      // spans the whole document, so the default 50%/50% origin would swing the
      // top of a long page by tens of pixels for a fraction of a degree.
      this.container.style.transformOrigin = `50% ${this.scrollY + this.viewportH * 0.5}px`;
      this.container.style.transform = `translate(${tx}px, ${ty}px) rotate(${roll}rad)`;
      const decay = Math.exp(-dt * 14);
      this.shakeAmount *= decay;
      this.kickX *= decay;
      this.kickY *= decay;
      // The roll unwinds more slowly than the rattle, so a big hit leaves the
      // page visibly tilting back rather than snapping straight.
      this.shakeRoll *= Math.exp(-dt * 8);
    } else if (this.container.style.transform) {
      this.container.style.transform = "";
      this.shakeAmount = 0;
      this.kickX = this.kickY = this.shakeRoll = 0;
    }
  }

  /**
   * Deepen the vignette as damage piles up. Only ever a CSS opacity change, and
   * only when it would actually be visible — the transition smooths the steps.
   */
  private updateVignette() {
    const target = Math.min(0.85, this.destruction);
    if (Math.abs(target - this.vignetteShown) < 0.02) return;
    this.vignetteShown = target;
    this.vignette.style.opacity = target.toFixed(3);
  }

  private updateLoops() {
    let total = 0;
    for (const flame of this.flames) total += flame.intensity;
    const heat = Math.min(1, total / 4);
    this.sound.loop("fire", heat * 0.5);
  }
}
