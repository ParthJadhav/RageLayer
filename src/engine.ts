import { SoundEngine } from "./audio";
import { BugSwarm } from "./bugs-sim";
import {
  DD_IGNORE_ATTR,
  defaultCaptureFilter,
  measureCapture,
  pickPixelRatio,
  resolvePageBackdrop,
} from "./capture";
import { type ComboEvent, ComboTracker, type InteractionKind } from "./combos";
import { type ContentCheckpoint, ContentLayer } from "./content";
import { atopAsOver } from "./ctx-proxy";
import { drawPaintStreak } from "./decals";
import { elementAt, elementsInBand, harvestElements, type PageElement } from "./elements";
import { type FieldSnapshot, ScalarField } from "./fields";
import { FlameField } from "./flames";
import {
  type ChunkSource,
  convexHull,
  gridCells,
  makeChunk,
  shardBudget,
  voronoiCells,
} from "./fracture";
import {
  drawAccretionDisc,
  drawAimCursor,
  drawEventHorizon,
  drawFlame,
  FxPainter,
} from "./fx-render";
import { DestructionHistory, type DestructionHistoryEntry, type HistoryState } from "./history";
import { LiveContentSource, supportsLiveCapture } from "./live";
import { type MaterialDefinition, MaterialSystem } from "./materials";
import { TAU } from "./math";
import { ParticleSystem, type ParticleWorld } from "./particles";
import {
  detectInitialQuality,
  PerformanceMonitor,
  QUALITY_PROFILES,
  type QualityProfile,
} from "./performance";
import { MAX_BODIES, PhysicsWorld } from "./physics";
import { PostFX } from "./postfx";
import { blit, clearSpriteCache, sprites } from "./sprites";
import { DEFAULT_SURFACE_PARAMS, type SurfaceParams } from "./surface";
import { buildTextMask } from "./textmask";
import { polygonArea2 } from "./topology";
import type {
  CaptureMode,
  CaptureStatus,
  ContentApi,
  DestroyerEngineApi,
  DestroyerOptions,
  EngineError,
  EngineErrorScope,
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

/** Engines currently alive in this document — refcount for the sprite cache. */
let liveEngines = 0;

const MAX_CAPTURE_HEIGHT = 12000;
/** Extra margin (CSS px) drawn beyond the viewport so nothing pops at the edge. */
const FX_MARGIN = 120;
/** Soft transient effects default to CSS-pixel resolution; hosts can explicitly supersample. */
const DEFAULT_FX_DPR = 1;
/** The heat field feeding the shimmer shader, as a fraction of the fx canvas. */
const HEAT_SCALE = 8;
/**
 * Frost is tracked on a coarse document-wide grid rather than per pixel: the
 * only questions asked of it are "does fire take here" and "does this shatter
 * like glass", and both are regional.
 */
const FROST_CELL = 32;
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

interface EngineHistoryEntry extends DestructionHistoryEntry {
  content: ContentCheckpoint | null;
  damage: HTMLCanvasElement | null;
  frost: FieldSnapshot | null;
  fuel: FieldSnapshot | null;
  destruction: number;
  takenElements: boolean[];
}

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
export class DestroyerEngine implements DestroyerEngineApi {
  readonly materials = new MaterialSystem();
  private comboTracker: ComboTracker | null;
  private comboListeners = new Set<(event: ComboEvent) => void>();
  private errorListeners = new Set<(error: EngineError) => void>();
  private lastError: EngineError | null = null;
  /** Keyboard aiming cursor, in document coordinates. */
  private aimCursor: Vec2 | null = null;
  private applyingCombo = false;
  private readonly history: DestructionHistory<EngineHistoryEntry> | null;
  private restoringHistory = false;
  readonly container: HTMLDivElement;
  readonly sound = new SoundEngine();
  /** Rigid-body debris: chunks of page that have physically come off. */
  readonly physics: PhysicsWorld;
  /** Fire and the wood-fuel grid it consumes. */
  private readonly fire = new FlameField();

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
  /** Every transient effect: sparks, smoke, water, drips, flying page shards. */
  private readonly particles = new ParticleSystem();
  /** What the particle step reaches for outside itself; built once. */
  private readonly particleWorld: ParticleWorld = {
    onPage: (x, y) => this.onPage(x, y),
    flameCount: () => this.fire.count,
    dowse: (x, y, radius, amount) => this.dowseFlames(x, y, radius, amount),
    stampPaintRun: (p) => {
      drawPaintStreak(
        this.surfaceCtx,
        p.x,
        p.y,
        p.len ?? 8,
        p.size,
        p.color ?? "#e63946",
        p.color2,
      );
      // Splashes land wherever the paint flew, not under the cursor.
      this.contentLayer?.markSurface(p.x, p.y, (p.len ?? 8) + p.size);
    },
    tink: () => this.sound.tink(),
  };
  /** Drawing for the effects layer; owns the per-frame render buckets. */
  private readonly fx = new FxPainter();
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
  /** Resolved once at mount from the explicit option or the OS preference. */
  private reducedMotion = false;
  /**
   * 0..1 running total of how wrecked the page is, fed by every `shake()` (which
   * every destructive tool already calls, scaled by how hard it hit). Drives the
   * vignette; repairs walk it back.
   */
  private destruction = 0;
  private vignetteShown = -1;
  /**
   * Rate gate for debris-landing dust. A single chunk thudding down gets its
   * puff; a 150-body rain gets a sparse drizzle of them instead of a dust
   * storm that costs more than the debris it decorates.
   */
  private nextImpactDust = 0;
  private dpr = 1;
  private w = 0;
  private h = 0;
  /** Viewport size the fx canvas is currently sized for. */
  private fxW = 0;
  private fxH = 0;
  /** Effects have an independent DPR cap; page capture and damage retain full fidelity. */
  private fxDpr = 1;
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
  private pausedByHost = false;
  private pausedByVisibility = false;
  private activePointerId: number | null = null;
  private listeners = new Map<EngineEvent, Set<() => void>>();
  private resizeTimer = 0;
  private resizeObserver: ResizeObserver | null = null;
  private capturing = false;
  private captureFilter: (node: Node) => boolean;
  /** Non-null only while live mode is actually in use. */
  private liveSource: LiveContentSource | null = null;
  private refreshTimer = 0;
  private refreshing = false;
  /** Extra delay before the next live refresh after a failure; 0 when healthy. */
  private refreshBackoffMs = 0;
  private _captureStatus: CaptureStatus = "idle";
  private _liveUnavailable = false;
  /** One-shot: the MAX_CAPTURE_HEIGHT truncation is warned about only once. */
  private captureHeightWarned = false;
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
  /** Cell-centre page test, hoisted so freezing allocates no closure per call. */
  private readonly onPageCell = (x: number, y: number) => this.onPage(x, y);
  /** Coarse frost grid over the document; lazily allocated on first freeze. */
  private readonly frost = new ScalarField({
    cell: FROST_CELL,
    max: 1,
    initial: 0,
    outside: "zero",
  });
  private _singularity: Singularity | null = null;
  /** Countdown to the singularity's next bite out of the page. */
  private singularityBite = 0;
  /** Countdown to the next page element the singularity rips loose. */
  private singularityFeed = 0;
  /** Wood fuel per grid cell, 0..255. Built lazily at the first flame. */
  private readonly fuel = new ScalarField({
    cell: FUEL_CELL,
    max: 255,
    initial: 255,
    outside: "edge",
  });
  /** Crawling bugs eating the page. */
  private readonly bugs = new BugSwarm();
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
      | "effectsPixelRatio"
      | "harvestElements"
      | "textMask"
      | "toolStyle"
      | "pauseWhenHidden"
    >
  > & { toolScale: number };

  constructor(options: DestroyerOptions = {}) {
    if (options.materials) {
      for (const material of options.materials) this.materials.register(material);
    }
    this.comboTracker =
      options.combos === false
        ? null
        : new ComboTracker(typeof options.combos === "object" ? options.combos : undefined);
    this.history =
      options.history === undefined || options.history === false
        ? null
        : new DestructionHistory(typeof options.history === "object" ? options.history : undefined);
    this.reducedMotion =
      options.reducedMotion === true ||
      (options.reducedMotion !== false &&
        (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false));
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
      effectsPixelRatio: Math.min(2, Math.max(0.5, options.effectsPixelRatio ?? DEFAULT_FX_DPR)),
      harvestElements: options.harvestElements ?? true,
      textMask: options.textMask ?? true,
      toolStyle: options.toolStyle ?? "3d",
      toolScale: Math.min(2, Math.max(0.5, options.toolScale ?? 1)),
      pauseWhenHidden: options.pauseWhenHidden ?? true,
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
    this.applyEntityLimits();
    // Asked for live on a browser without the flag: record it up front so the
    // toolbar can say *why* it is in snapshot mode.
    this._liveUnavailable = this.opts.captureMode === "live" && !supportsLiveCapture();
    this.captureFilter = options.captureFilter ?? defaultCaptureFilter;
    // Registered before the constructor's `captureContent()` call, so a host
    // that passes `onError` sees capture failures — the most likely failure of
    // all, and the one that happens before it could subscribe afterwards.
    if (options.onError) this.errorListeners.add(options.onError);
    this.sound.enabled = options.soundEnabled ?? false;
    this.contentRoot = options.contentRoot ?? document.body;
    this.materials.scan(this.contentRoot);
    this.pausedByVisibility = this.opts.pauseWhenHidden && document.visibilityState === "hidden";

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
      transition: this.reducedMotion ? "none" : "opacity 0.6s ease-out",
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
    // Safety net: if the page navigates away (or is bfcached) while the real
    // DOM is hidden behind the destroyed copy, put its visibility back so a
    // restored document is never blank.
    window.addEventListener("pagehide", this.onPageHide);
    document.addEventListener("visibilitychange", this.onVisibilityChange);

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(this.onObservedResize);
      this.resizeObserver.observe(document.documentElement);
      if (this.contentRoot !== document.documentElement) {
        this.resizeObserver.observe(this.contentRoot);
      }
    }

    this.container.addEventListener("pointerdown", this.onPointerDown);
    this.container.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointercancel", this.onPointerCancel);
    this.container.addEventListener("pointerleave", this.onPointerLeave);
    this.container.addEventListener("contextmenu", this.onContextMenu);

    this.lastTime = performance.now();
    if (!this.paused) this.requestFrame();

    // Refcount the process-wide sprite cache: `dispose` frees it only when the
    // last engine goes away, so overlapping engines never rebuild mid-flight.
    liveEngines++;

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
  get flames(): Flame[] {
    return this.fire.list;
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

  get historyState(): HistoryState {
    return this.history?.state ?? { canUndo: false, canRedo: false, undoDepth: 0, redoDepth: 0 };
  }

  /**
   * Whether undo/redo was enabled for this engine.
   *
   * Distinct from `historyState.canUndo`: history that is on but still empty
   * looks identical from the state alone, and a toolbar needs to show its
   * undo controls (disabled) from the start rather than having them appear
   * after the first blow.
   */
  get historyEnabled(): boolean {
    return this.history !== null;
  }

  checkpoint(label?: string): boolean {
    if (!this.history || this.disposed || this.restoringHistory) return false;
    if (!this.history.canStore(this.estimateHistoryPixelCost())) return false;
    if (!this.history.push(this.createHistoryEntry(label))) return false;
    this.emit("historychange");
    return true;
  }

  undo(): boolean {
    if (!this.history?.state.canUndo) return false;
    const target = this.history.undo(this.createHistoryEntry("redo"));
    if (!target) return false;
    this.restoreHistoryEntry(target);
    target.dispose();
    this.emit("historychange");
    return true;
  }

  redo(): boolean {
    if (!this.history?.state.canRedo) return false;
    const target = this.history.redo(this.createHistoryEntry("undo"));
    if (!target) return false;
    this.restoreHistoryEntry(target);
    target.dispose();
    this.emit("historychange");
    return true;
  }

  clearHistory() {
    this.history?.clear();
    this.emit("historychange");
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

  materialAt(x: number, y: number): MaterialDefinition {
    return this.materials.at(x, y);
  }

  signalInteraction(kind: InteractionKind, x: number, y: number): ComboEvent[] {
    if (!this.comboTracker || this.applyingCombo) return [];
    const events = this.comboTracker.record(kind, x, y);
    for (const event of events) {
      this.applyingCombo = true;
      try {
        this.applyCombo(event);
      } finally {
        this.applyingCombo = false;
      }
      for (const callback of this.comboListeners) callback(event);
    }
    return events;
  }

  onCombo(callback: (event: ComboEvent) => void): () => void {
    this.comboListeners.add(callback);
    return () => this.comboListeners.delete(callback);
  }

  /**
   * Subscribe to degradation reports — capture failure, a missing text mask,
   * an unmeasurable layout. None of these throw, so this is the only way a
   * host can tell that visitors are getting a reduced experience.
   *
   * While at least one handler is registered the matching `console.warn` is
   * suppressed, so a host that forwards these to its own logging does not see
   * every failure twice.
   */
  onError(callback: (error: EngineError) => void): () => void {
    this.errorListeners.add(callback);
    return () => this.errorListeners.delete(callback);
  }

  /**
   * Report a survivable failure to the host, or to the console if nobody is
   * listening. `emit("error")` fires as well so plain `on()` subscribers
   * (framework adapters that only need to re-render) see it too.
   */
  private reportError(scope: EngineErrorScope, message: string, cause?: unknown) {
    this.lastError = { scope, message, ...(cause === undefined ? {} : { cause }) };
    if (this.errorListeners.size === 0) {
      if (cause === undefined) console.warn(`[desktop-destroyer] ${message}`);
      else console.warn(`[desktop-destroyer] ${message}`, cause);
    } else {
      for (const callback of this.errorListeners) callback(this.lastError);
    }
    this.emit("error");
  }

  /** The most recent degradation, or null if nothing has gone wrong. */
  get error(): EngineError | null {
    return this.lastError;
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
    // Tools are module-level singletons: shed whatever a previous engine (or a
    // previous mount of this one) left in them before this engine ticks them.
    tool.reset?.();
    this.tools.set(tool.id, tool);
  }

  /** Register a toolset in one operation; useful with the split and lazy entry points. */
  registerTools(tools: Iterable<Tool>): this {
    for (const tool of tools) this.registerTool(tool);
    return this;
  }

  /** Remove a tool at runtime. An active tool is safely released and deselected first. */
  unregisterTool(id: string): boolean {
    const tool = this.tools.get(id);
    if (!tool) return false;
    if (this.activeTool === tool) this.setTool(null);
    tool.reset?.();
    return this.tools.delete(id);
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
    if (this.pointerDown) this.endPointer();
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

  private createHistoryEntry(label?: string): EngineHistoryEntry {
    const content = this.contentLayer?.createCheckpoint() ?? null;
    let damage: HTMLCanvasElement | null = null;
    if (this.damageReady) {
      damage = document.createElement("canvas");
      damage.width = this.damageCanvas.width;
      damage.height = this.damageCanvas.height;
      damage.getContext("2d")?.drawImage(this.damageCanvas, 0, 0);
    }
    const frost = this.frost.snapshot();
    const fuel = this.fire.snapshotFuel();
    const pixelCost =
      (content?.pixelCost ?? 0) +
      (damage ? damage.width * damage.height : 0) +
      this.fieldPixelCost();
    return {
      label,
      timestamp: Date.now(),
      pixelCost,
      content,
      damage,
      frost,
      fuel,
      destruction: this.destruction,
      takenElements: this.pageElements.map((element) => element.taken),
      dispose() {
        content?.dispose();
        if (damage) {
          damage.width = 0;
          damage.height = 0;
        }
      },
    };
  }

  private estimateHistoryPixelCost(): number {
    return (
      (this.contentLayer?.checkpointPixelCost ?? 0) +
      (this.damageReady ? this.damageCanvas.width * this.damageCanvas.height : 0) +
      this.fieldPixelCost()
    );
  }

  /** The frost and fuel grids' share of a checkpoint, in notional RGBA pixels. */
  private fieldPixelCost(): number {
    return Math.ceil((this.frost.byteLength + this.fire.fuelBytes) / 4);
  }

  private restoreHistoryEntry(entry: EngineHistoryEntry) {
    this.restoringHistory = true;
    try {
      if (entry.content) this.contentLayer?.restoreCheckpoint(entry.content);
      else this.contentLayer?.restoreAll();
      if (entry.damage) {
        this.ensureDamage();
        this._damageCtx.save();
        this._damageCtx.setTransform(1, 0, 0, 1, 0, 0);
        this._damageCtx.clearRect(0, 0, this.damageCanvas.width, this.damageCanvas.height);
        this._damageCtx.drawImage(entry.damage, 0, 0);
        this._damageCtx.restore();
      } else if (this.damageReady) {
        this._damageCtx.clearRect(0, 0, this.w, this.h);
      }
      this.frost.restore(entry.frost);
      this.fire.restoreFuel(entry.fuel);
      this.destruction = entry.destruction;
      for (let i = 0; i < this.pageElements.length; i++) {
        this.pageElements[i].taken = entry.takenElements[i] ?? false;
      }
      this.fire.clear();
      this.particles.clear();
      this.physics.clear();
      this.bugs.clear();
      this._singularity = null;
      this.collapseQueue.length = 0;
      this.comboTracker?.clear();
      for (const tool of this.tools.values()) tool.reset?.();
      this.requestFrame();
    } finally {
      this.restoringHistory = false;
    }
  }

  clear() {
    if (!this.restoringHistory) this.checkpoint("clear");
    if (this.damageReady) this._damageCtx.clearRect(0, 0, this.w, this.h);
    this.contentLayer?.restoreAll();
    this.fire.clear();
    this.particles.clear();
    this.destruction = 0;
    this.physics.clear();
    this.frost.release();
    // Repaired page, fresh wood: the fuel comes back with the pixels.
    this.fire.refuel();
    this.bugs.clear();
    this._singularity = null;
    this.collapseQueue.length = 0;
    this.comboTracker?.clear();
    // Rockets in flight, queued restrikes, hammer sites: a repaired page owes
    // nothing to the destruction that was still in progress.
    for (const tool of this.tools.values()) tool.reset?.();
    // Elements go back on the board — the page they described is whole again.
    for (const el of this.pageElements) el.taken = false;
    this.emit("clear");
    this.requestFrame();
  }

  setSound(enabled: boolean) {
    this.sound.enabled = enabled;
    if (!enabled) this.silenceLoops();
  }

  /** True while explicitly paused or automatically suspended in a hidden tab. */
  get paused(): boolean {
    return this.pausedByHost || this.pausedByVisibility;
  }

  /** Freeze simulation and rendering without discarding the current destruction state. */
  pause() {
    if (this.pausedByHost || this.disposed) return;
    const wasPaused = this.paused;
    this.pausedByHost = true;
    this.applyPauseTransition(wasPaused);
  }

  /** Continue from a host-requested pause. Hidden tabs remain automatically suspended. */
  resume() {
    if (!this.pausedByHost || this.disposed) return;
    const wasPaused = this.paused;
    this.pausedByHost = false;
    this.applyPauseTransition(wasPaused);
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
    window.removeEventListener("pagehide", this.onPageHide);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerCancel);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
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
    this.history?.clear();
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
    this._damageToolCtx = null;
    this.damageReady = false;
    this.fxPainted = false;

    this.fire.clear();
    this.particles.clear();
    this.fx.clear();
    this.bugs.clear();
    this.collapseQueue.length = 0;
    this.pageElements.length = 0;
    this.comboTracker?.clear();
    this.comboTracker = null;
    this.comboListeners.clear();
    this.errorListeners.clear();
    this.materials.clearRegions();
    // Module-level tool state (in-flight rockets, restrikes, strike sites)
    // must not survive into whatever engine registers these tools next.
    for (const tool of this.tools.values()) tool.reset?.();
    this.tools.clear();
    this.activeTool = null;
    this.pointerDown = false;
    this.activePointerId = null;
    this.frost.release();
    this.fire.dispose();
    this._singularity = null;
    this.contentRoot = null;
    this.prevRootVisibility = null;

    // Last engine out releases the shared sprite atlas. Safe even if another
    // engine is created later — `sprites()` rebuilds lazily.
    liveEngines = Math.max(0, liveEngines - 1);
    if (liveEngines === 0) clearSpriteCache();
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
      this.materials.scan(this.contentRoot);

      // Map the page's furniture while the real layout still exists — after
      // `enterContentMode` there is nothing left to measure.
      if (this.opts.harvestElements && this.opts.physics) {
        try {
          this.pageElements = harvestElements(this.contentRoot, this.captureFilter);
        } catch (err) {
          // A hostile layout shouldn't cost the user the whole toy.
          this.reportError("element-harvest", "element harvest failed, demolition disabled", err);
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
            this.reportError(
              "live-capture",
              "live capture failed, falling back to snapshot mode",
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
          this.reportError("text-mask", "text mask failed, shading uniformly", err);
        }
      }

      // Content canvas sits between the void backdrop and the damage canvas.
      this.container.insertBefore(layer.canvas, this.damageCanvas);
      this.enterContentMode();
      // A fresh full capture can have different geometry and invalidates old
      // pixel checkpoints. Live refreshes do not pass through this path.
      if (this.history) this.clearHistory();
      this.setStatus(live ? "live" : "snapshot");
      if (live) this.scheduleRefresh();
    } catch (err) {
      // Capture can fail (e.g. CORS-tainted resources). Fall back to
      // overlay-only damage rather than breaking the toy.
      this.reportError("capture", "page capture failed, using overlay mode", err);
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
    this.refreshTimer = window.setTimeout(
      () => {
        void this.refreshLive().then(() => this.scheduleRefresh());
      },
      Math.max(this.opts.liveRefreshMs, this.refreshBackoffMs),
    );
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
      this.materials.scan(this.contentRoot);
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
        this.refreshBackoffMs = 0;
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
      this.refreshBackoffMs = 0;
    } catch (err) {
      // A failed refresh just means the base is a little stale — the existing
      // pixels and all the destruction are still on screen. Back off (doubling
      // up to a minute) and keep retrying rather than giving up forever; a
      // success resets the backoff. The configured interval is never mutated.
      this.refreshBackoffMs = Math.min(
        60_000,
        Math.max(this.opts.liveRefreshMs * 4, this.refreshBackoffMs * 2),
      );
      this.reportError("live-refresh", "live refresh failed, keeping last capture", err);
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
    this.particles.spawn(p);
    this.requestFrame();
  }

  spawnFlame(x: number, y: number, intensity = 0.35) {
    if (this.fire.spawn(this, x, y, intensity)) this.requestFrame();
  }

  dowseFlames(x: number, y: number, radius: number, amount: number): number {
    return this.fire.dowse(this, this.lastTime, x, y, radius, amount);
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
    this.signalInteraction("water", x, y);
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
    if (!this.reducedMotion) {
      this.shakeAmount = Math.max(this.shakeAmount, strength);
      if (dirX !== 0 || dirY !== 0) {
        const mag = Math.hypot(dirX, dirY) || 1;
        this.kickX += (dirX / mag) * strength * 0.5;
        this.kickY += (dirY / mag) * strength * 0.5;
      }
      // A little roll on every hit: pure translation reads as a rattle, a tilt
      // reads as the page taking the blow.
      this.shakeRoll += (Math.random() - 0.5) * strength * 0.00035;
    }
    // Every destructive tool already calls shake(), scaled by how hard it hit —
    // which makes it the one honest measure of accumulated damage.
    this.destruction = Math.min(1, this.destruction + strength * 0.0012);
    this.requestFrame();
  }

  pullDebris(x: number, y: number, radius: number, strength: number, dt: number): number {
    return this.opts.physics ? this.physics.pull(x, y, radius, strength, dt) : 0;
  }

  launchDebris(
    x: number,
    y: number,
    radius: number,
    dirX: number,
    dirY: number,
    speed: number,
  ): boolean {
    return this.opts.physics ? this.physics.launchNearest(x, y, radius, dirX, dirY, speed) : false;
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
   * Where the keyboard cursor is, or null when nothing is aiming.
   *
   * Drawn by the engine rather than by the toolbar because it has to sit over
   * the destruction, in document space, on the same canvas that scrolls with
   * the page — a DOM element would have to chase all of that.
   */
  get aim(): Vec2 | null {
    return this.aimCursor;
  }

  setAim(point: Vec2 | null) {
    this.aimCursor = point ? { x: point.x, y: point.y } : null;
    this.requestFrame();
  }

  /**
   * Use the active tool at a document point without a pointing device.
   *
   * The toolbar is fully keyboard-operable, but the canvas is not: without
   * this, a keyboard-only visitor can select the hammer and then do nothing
   * with it. `strike` runs the same `onDown`/`onUp` pair a click produces, so
   * a tool needs no special handling to be reachable this way.
   *
   * `holdMs` drives tools that do their work in `tick` while held — a
   * flamethrower or a freeze ray needs to be on for a moment to do anything.
   * The hold is simulated against the engine's own frame loop rather than
   * being wall-clock, so it behaves the same on a slow machine.
   *
   * Returns false when there is no tool selected or the engine is paused.
   */
  strike(x: number, y: number, { holdMs = 0 }: { holdMs?: number } = {}): boolean {
    const tool = this.activeTool;
    if (!tool || this.paused || this.disposed) return false;

    this.checkpoint(tool.id);
    const event = { x, y, dx: 0, dy: 0, buttons: 1 };
    this.pointer.x = x;
    this.pointer.y = y;
    this.lastPointer.x = x;
    this.lastPointer.y = y;
    this.artDownAt = performance.now() / 1000;
    this.pointerDown = true;
    tool.onDown?.(this, event);

    if (holdMs > 0) {
      const dt = 1 / 60;
      const steps = Math.min(600, Math.round(holdMs / (dt * 1000)));
      for (let i = 0; i < steps; i++) tool.tick?.(this, dt, true, this.pointer);
    }

    this.pointerDown = false;
    this.artUpAt = performance.now() / 1000;
    tool.onUp?.(this, { ...event, buttons: 0 });
    this.requestFrame();
    return true;
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

  fracture(x: number, y: number, radius: number, options: FractureOptions = {}): number {
    // Anything crawling in the struck region is crushed along with it.
    if (this.bugs.count > 0) this.squashBugs(x, y, radius);
    const src = this.chunkSource;
    if (!src) return 0;
    const material = this.materialAt(x, y);
    const icy = options.icy ?? (material.id === "ice" || this.frostAt(x, y) > 0.3);
    // Ice shatters finer and lighter than paper does.
    const count =
      options.count ?? shardBudget(radius, icy ? 2.2 : Math.max(0.55, 1.4 / material.toughness));
    const cells = voronoiCells(x, y, radius, count);
    const power = (options.power ?? 240) / Math.sqrt(material.density);
    const carve = new Path2D();
    const carvedCells: number[][] = [];
    let made = 0;

    for (const cell of cells) {
      const geometricArea = Math.abs(polygonArea2(cell)) * 0.5;
      const materialArea = this.contentLayer?.materialArea(cell) ?? geometricArea;
      // A cell grazing a pre-existing hole is fine; an empty cell is not a
      // shard. Requiring a little real coverage also prevents a huge collider
      // being attached to one surviving anti-aliased pixel at a torn rim.
      if (materialArea < Math.max(8, geometricArea * 0.06)) continue;
      const body = makeChunk(
        src,
        cell,
        {
          density: (icy ? 0.0011 : 0.0018) * material.density,
          restitution: icy ? 0.36 : Math.max(0.14, material.restitution),
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
    this.signalInteraction("impact", x, y);

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
      // Crystalline glint: breaking glass catches the light for an instant.
      // A handful of twinkles over the shatter site — brief, weightless, and
      // gone before the shards land — is the difference between ice breaking
      // and pale paper breaking.
      for (let i = 0; i < 8; i++) {
        this.spawnParticle({
          kind: "sparkle",
          x: x + (Math.random() - 0.5) * radius * 1.7,
          y: y + (Math.random() - 0.5) * radius * 1.3,
          vx: (Math.random() - 0.5) * 50,
          vy: -16 - Math.random() * 44,
          life: 0,
          maxLife: 0.45 + Math.random() * 0.45,
          size: 5 + Math.random() * 7,
          gravity: 0,
          phase: Math.random() * TAU,
        });
      }
    }
    return made;
  }

  explode(x: number, y: number, radius: number, options: ExplodeOptions = {}) {
    this.signalInteraction("explosion", x, y);
    const power = options.power ?? 560;
    // The blast reaches further than the crater; so does what it does to bugs.
    if (this.bugs.count > 0) this.squashBugs(x, y, radius * 1.6);
    if (options.fracture !== false) {
      this.fracture(x, y, radius * 0.9, { power: power * 0.8, count: shardBudget(radius, 1.7) });
    }
    // Everything already loose gets thrown, including debris from earlier hits.
    this.physics.blast(x, y, radius * 2.2, power * 1.1);
    this.particles.blast(x, y, radius, power * 2.2);
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
    const area2 = polygonArea2(points);
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
      const geometricArea = Math.abs(polygonArea2(cell)) * 0.5;
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

  freeze(x: number, y: number, radius: number, amount: number) {
    this.frost.ensure(this.w, this.h);
    // Rime belongs on the page, not floating in a hole.
    this.frost.paintDisc(x, y, radius, amount, this.onPageCell);
    this.signalInteraction("freeze", x, y);
  }

  frostAt(x: number, y: number): number {
    return this.frost.at(x, y);
  }

  /**
   * Melt frost — the other half of fire-vs-ice. Ignition does it to clear its
   * own ground, burning flames do it to the rime around them, shattering ice
   * consumes it, and the flamethrower's jet does it deliberately.
   */
  meltFrost(x: number, y: number, radius: number, amount = 1) {
    this.frost.paintDisc(x, y, radius, -amount);
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

  private applyCombo(event: ComboEvent) {
    const { x, y } = event;
    const burst = (kind: Particle["kind"], count: number, color?: string) => {
      for (let i = 0; i < count; i++) {
        const angle = Math.random() * TAU;
        const speed = 60 + Math.random() * 180;
        this.spawnParticle({
          kind,
          x,
          y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 60,
          life: 0,
          maxLife: 0.45 + Math.random() * 0.65,
          size: 2 + Math.random() * 5,
          color,
          gravity: kind === "steam" ? -35 : 260,
          phase: Math.random() * TAU,
        });
      }
    };

    switch (event.id) {
      case "steam-shock":
        this.dowseFlames(x, y, 72, 0.55);
        burst("steam", 12);
        this.sound.hiss();
        break;
      case "flash-freeze":
        this.freeze(x, y, 58, 0.65);
        burst("ice", 14, "#dff7ff");
        this.sound.freeze();
        break;
      case "conductive-surge":
        burst("spark", 18, "#bdeaff");
        this.squashBugs(x, y, 62);
        this.sound.zap();
        break;
      case "thermal-shock":
        this.fracture(x, y, 42, { power: 260, icy: true });
        burst("ice", 10, "#e8fbff");
        break;
      case "volatile-corrosion":
        this.explode(x, y, 42, { power: 390, incendiary: false });
        burst("smoke", 10, "#8bcf65");
        break;
      case "orbital-bomb":
        this.physics.blast(x, y, 180, 760);
        this.shake(12);
        break;
      case "reality-overload":
        burst("spark", 24, "#d68cff");
        this.shake(15);
        this.contentLayer?.char(x, y, 70, 0.35);
        this.markSurface(x, y, 80);
        break;
    }
    this.spawnParticle({
      kind: "ring",
      x,
      y,
      vx: 0,
      vy: 0,
      life: 0,
      maxLife: 0.5,
      size: 76,
    });
  }

  private applyPauseTransition(wasPaused: boolean) {
    if (wasPaused === this.paused) return;
    if (this.paused) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.endPointer();
      this.silenceLoops();
    } else {
      // Do not integrate the time spent suspended as one enormous simulation step.
      this.lastTime = performance.now();
      this.lastRenderedAt = 0;
      this.requestFrame();
    }
    this.emit("pausechange");
  }

  private silenceLoops() {
    this.sound.loop("fire", 0);
    this.sound.loop("water", 0);
    this.sound.loop("saw", 0);
    this.sound.loop("flamethrower", 0);
    this.sound.loop("void", 0);
  }

  private emit(event: EngineEvent) {
    this.listeners.get(event)?.forEach((cb) => {
      cb();
    });
  }

  private applyQuality(tier: PerformanceQualityTier) {
    if (tier === this.qualityTier) return;
    this.qualityTier = tier;
    this.qualityProfile = QUALITY_PROFILES[tier];

    this.applyEntityLimits();
    this.setPostFXEnabled(this.opts.postFX && this.qualityProfile.postFX);
  }

  /** Push the current quality profile's caps down into each subsystem. */
  private applyEntityLimits() {
    this.particles.setLimit(this.opts.maxParticles * this.qualityProfile.particleScale);
    this.fire.setLimit(this.opts.maxFlames * this.qualityProfile.flameScale);
    this.physics.setIterations(this.qualityProfile.physicsIterations);
    this.physics.setBodyLimit(Math.max(24, Math.round(MAX_BODIES * this.qualityProfile.bodyScale)));
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
    const height = Math.max(
      document.documentElement.scrollHeight,
      document.documentElement.clientHeight,
    );
    if (height > MAX_CAPTURE_HEIGHT && !this.captureHeightWarned) {
      this.captureHeightWarned = true;
      this.reportError(
        "page-height",
        `document is ${Math.round(height)}px tall; the destructible surface is capped at ${MAX_CAPTURE_HEIGHT}px, so content below that stays intact`,
      );
    }
    return {
      width: document.documentElement.clientWidth,
      height: Math.min(height, MAX_CAPTURE_HEIGHT),
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
    const dpr = Math.min(this.dpr, this.opts.effectsPixelRatio);
    this.vignette.style.width = `${width}px`;
    this.vignette.style.height = `${this.viewportH}px`;
    if (width === this.fxW && height === this.fxH && dpr === this.fxDpr) return;
    this.fxW = width;
    this.fxH = height;
    this.fxDpr = dpr;
    this.fxCanvas.width = Math.round(width * dpr);
    this.fxCanvas.height = Math.round(height * dpr);
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
    this.frost.release();
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

  /**
   * The document is going away (navigation, or into the bfcache) while the
   * real DOM may still be hidden behind the destroyed copy. Restore its
   * visibility so a bfcache-restored page never comes back blank.
   */
  private onPageHide = () => {
    this.exitContentMode();
  };

  private onVisibilityChange = () => {
    if (!this.opts.pauseWhenHidden || this.disposed) return;
    const wasPaused = this.paused;
    this.pausedByVisibility = document.visibilityState === "hidden";
    this.applyPauseTransition(wasPaused);
  };

  /** Catch SPA reflows and asynchronously-loaded content that do not resize the viewport. */
  private onObservedResize = () => {
    if (!this.disposed) this.onWindowResize();
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
        const next = this.docSize();
        if (this.contentLayer.width !== next.width || this.contentLayer.height !== next.height) {
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
    if (!this.activeTool || e.button !== 0 || !e.isPrimary || this.paused) return;
    e.preventDefault();
    this.checkpoint(this.activeTool.id);
    this.pointerDown = true;
    this.activePointerId = e.pointerId;
    try {
      this.container.setPointerCapture?.(e.pointerId);
    } catch {
      // Older Safari builds can reject capture even though Pointer Events exist.
    }
    this.artDownAt = performance.now() / 1000;
    this.lastPointer.x = this.lastPointer.y = -1000;
    // Always build the event (it updates this.pointer for tick-driven tools),
    // even when the tool has no onDown handler.
    const ev = this.toolEvent(e);
    this.activeTool.onDown?.(this, ev);
    this.requestFrame();
  };

  private onPointerMove = (e: PointerEvent) => {
    if (!this.activeTool || !e.isPrimary) return;
    if (this.activePointerId !== null && e.pointerId !== this.activePointerId) return;
    const ev = this.toolEvent(e);
    this.activeTool.onMove?.(this, ev);
    this.requestFrame();
  };

  private onPointerUp = (e: PointerEvent) => {
    this.endPointer(e);
  };

  private onPointerCancel = (e: PointerEvent) => {
    this.endPointer(e);
  };

  private endPointer(e?: PointerEvent) {
    if (!this.pointerDown) return;
    if (e && this.activePointerId !== null && e.pointerId !== this.activePointerId) return;
    this.pointerDown = false;
    this.artUpAt = performance.now() / 1000;
    const ev = e ? this.toolEvent(e) : { ...this.pointer, dx: 0, dy: 0, buttons: 0 };
    this.activeTool?.onUp?.(this, ev);
    if (this.activePointerId !== null) {
      try {
        this.container.releasePointerCapture?.(this.activePointerId);
      } catch {
        // Capture may already have been released by the browser on cancellation.
      }
    }
    this.activePointerId = null;
    this.requestFrame();
  }

  private onPointerLeave = () => {
    if (this.pointerDown) return;
    this.pointer.x = this.pointer.y = -1000;
    this.lastPointer.x = this.lastPointer.y = -1000;
    this.requestFrame();
  };

  private onContextMenu = (e: Event) => {
    if (this.activeTool) e.preventDefault();
  };

  private frame = (now: number) => {
    if (this.disposed || this.paused) return;
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
    this.fire.step(this, dt, this.lastTime);
    this.destruction = Math.min(1, this.destruction + this.bugs.step(this, dt));
    this.stepSingularity(dt);
    this.particles.step(dt, this.lastTime, this.particleWorld);
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
        particles: this.particles.count,
        flames: this.fire.count,
        bodies: this.physics.count,
        bugs: this.bugs.count,
      },
      quality: this.qualityTier,
      pixelRatio: this.dpr,
      effectsPixelRatio: this.fxDpr,
      targetFps,
    });
    if (recommendation && this.qualityMode === "auto") this.applyQuality(recommendation);

    if (this.hasActiveWork()) this.requestFrame();
  };

  private requestFrame() {
    if (this.disposed || this.paused || this.raf) return;
    this.raf = requestAnimationFrame(this.frame);
  }

  private hasActiveWork() {
    return (
      this.particles.count > 0 ||
      this.fire.count > 0 ||
      this.physics.active ||
      this.bugs.count > 0 ||
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
    return (
      this.fire.count > 0 ||
      this.destruction > 0.016 ||
      !!this._singularity ||
      this.particles.flashJetCount > 0
    );
  }

  /**
   * Smooth the pointer's motion for the drawn tool. Raw per-event deltas are
   * far too jittery to pose from — a broom's bristles would buzz — so the art
   * gets a low-passed velocity and, from it, a slow-turning aim direction.
   */
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
    ctx.scale(this.opts.toolScale, this.opts.toolScale);
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

    // Dust where debris landed hard. Wood chunks slamming into the floor (or
    // each other) knock a breath of pale paper dust loose — the cheap half of
    // an impact that sells the heavy half. The solver already found and capped
    // these contacts; only the strongest few per frame become particles, and
    // the count degrades with the quality profile like every other effect.
    const impacts = this.physics.impacts;
    if (impacts.length > 0 && this.lastTime > this.nextImpactDust) {
      this.nextImpactDust = this.lastTime + 55;
      const events = Math.min(impacts.length, 6);
      const puffs = Math.max(1, Math.round(2 * this.qualityProfile.particleScale));
      for (let i = 0; i < events; i += 3) {
        const ix = impacts[i];
        const iy = impacts[i + 1];
        // Impact speed scales the puff: a clatter breathes, a slam erupts.
        const force = Math.min(1, impacts[i + 2] / 900);
        for (let d = 0; d < puffs; d++) {
          this.spawnParticle({
            kind: "dust",
            x: ix + (Math.random() - 0.5) * 14,
            y: iy - Math.random() * 6,
            vx: (Math.random() - 0.5) * (50 + 90 * force),
            vy: -14 - Math.random() * 55 * force,
            life: 0,
            maxLife: 0.5 + Math.random() * (0.5 + force * 0.6),
            size: 4 + Math.random() * (5 + 8 * force),
            gravity: 16,
            drag: 2.4,
          });
        }
      }
    }
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

    // Bugs unlucky enough to crawl inside the horizon are simply gone.
    this.bugs.vanish(s.x, s.y, r);

    // Eat the page. Throttled because each bite repaints a document-sized
    // canvas, and sixty bites a second is sixty full-page repaints.
    this.singularityBite -= dt;
    if (this.singularityBite <= 0 && this.contentLayer?.ready) {
      this.singularityBite = 0.07;
      this.contentLayer.punch(s.x, s.y, r * 0.92);
    }

    // Loose particles spiral in.
    this.particles.attract(s.x, s.y, s.power, r * 0.55, dt);

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

  // ── Bugs ────────────────────────────────────────────────────────────────

  spawnBugs(x: number, y: number, count = 1) {
    if (this.bugs.spawn(this, x, y, count)) this.requestFrame();
  }

  squashBugs(x: number, y: number, radius: number): number {
    return this.bugs.squash(this, x, y, radius);
  }

  /**
   * Bugs carried off the page by a jet of water. Unlike `squashBugs` there is
   * no smear — nothing was crushed — the bug tumbles away on the spray,
   * washed off the page rather than into it.
   */
  flushBugs(x: number, y: number, radius: number): number {
    return this.bugs.flush(this, x, y, radius);
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
    const dpr = this.fxDpr;
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
      this.particles.count === 0 &&
      this.fire.count === 0 &&
      this.physics.count === 0 &&
      this.bugs.count === 0 &&
      !this._singularity &&
      !this.aimCursor &&
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
    if (this.bugs.count > 0) this.bugs.render(ctx, view.top, view.bottom, time);

    // One classification pass up front; the four passes below draw from it.
    this.fx.classify(this.particles.particles, view);
    this.fx.drawWet(ctx);

    // Flames render here — with the other *surface-bound* effects, before the
    // mask below — not in the airborne additive pass at the end.
    ctx.globalCompositeOperation = "lighter";
    for (const f of this.fire.list) {
      if (f.y < view.top - 300 || f.y > view.bottom + 300) continue;
      if (f.x < view.left - 300 || f.x > view.right + 300) continue;
      drawFlame(ctx, f, time, this.qualityProfile.flameLayers);
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
    if (this.bugs.count > 0 || this.fx.hasSurfaceParticles || this.fire.count > 0) {
      this.maskFxToPage(ctx, view);
    }

    this.fx.drawPuffs(ctx, time);
    this.fx.drawSolids(ctx);

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
    if (sing) drawEventHorizon(ctx, sing);

    // Additive pass: the accretion disc, then every glowing particle.
    ctx.globalCompositeOperation = "lighter";
    if (sing) drawAccretionDisc(ctx, sing, time);
    this.fx.drawHot(ctx, time);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";

    // The tool in hand, over everything it just did.
    if (artVisible) this.renderToolArt(ctx, time);

    // The keyboard cursor, above everything: it is a control, not an effect,
    // and a visitor steering by arrow keys has to be able to find it over a
    // page that is on fire.
    if (this.aimCursor) drawAimCursor(ctx, this.aimCursor, time);

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
   * Hand the finished effects frame to the post-processing stage.
   *
   * Bloom and aberration are scaled by what is actually happening: an idle page
   * with two paint splats gets neither, a page on fire gets both. That keeps
   * the shader honest about cost as well as taste — the stage skips the whole
   * chain when the numbers say it would change nothing.
   */
  private present(time: number): number {
    const startedAt = performance.now();
    const postfx = this.postfx;
    if (!this.postfxEnabled || !postfx || !this.heatCanvas) {
      this.setPostFXOutput(false);
      return 0;
    }
    let bloom = Math.min(0.85, this.fire.totalIntensity * 0.16 + (this._singularity ? 0.55 : 0));
    // Explosions and muzzle flashes are brief but very bright; let them bloom
    // even with no fire burning.
    if (this.particles.flashJetCount > 0) bloom = Math.max(bloom, 0.45);
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
    postfx.render(this.fxCanvas, this.heatCanvas, { bloom, heat, aberration, time });
    return performance.now() - startedAt;
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
    this.sound.loop("fire", Math.min(1, this.fire.totalIntensity / 4) * 0.5);
  }
}
