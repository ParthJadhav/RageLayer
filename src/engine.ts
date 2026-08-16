import { SoundEngine } from "./audio";
import { BugSwarm } from "./bugs-sim";
import { defaultCaptureFilter } from "./capture";
import { CaptureController, type CaptureHost } from "./capture-controller";
import { type ComboEvent, ComboTracker, type InteractionKind } from "./combos";
import type { ContentCheckpoint, ContentLayer } from "./content";
import { atopAsOver } from "./ctx-proxy";
import { drawPaintStreak } from "./decals";
import { elementAt, elementsInBand, type PageElement } from "./elements";
import { type ResolvedEngineOptions, resolveEngineOptions } from "./engine-options";
import type { FieldSnapshot } from "./fields";
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
import { REST_AIM_X, REST_AIM_Y, TAU } from "./math";
import { Overlay } from "./overlay";
import { ParticleSystem, type ParticleWorld, scratchParticle } from "./particles";
import {
  detectInitialQuality,
  PerformanceMonitor,
  QUALITY_PROFILES,
  type QualityProfile,
} from "./performance";
import { MAX_BODIES, PhysicsWorld } from "./physics";
import { PostFX } from "./postfx";
import { blit, clearSpriteCache, sprites } from "./sprites";
import { polygonArea2 } from "./topology";
import type {
  CaptureMode,
  CaptureStatus,
  ContentApi,
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
  RageLayerEngineApi,
  RageLayerEngineOptions,
  Singularity,
  Tool,
  Vec2,
} from "./types";
import { WOOD } from "./wood";

/** Engines currently alive in this document — refcount for the sprite cache. */
let liveEngines = 0;

const MAX_CAPTURE_HEIGHT = 12000;
/** The heat field feeding the shimmer shader, as a fraction of the fx canvas. */
const HEAT_SCALE = 8;
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
 * Pointermove positions remembered between frames. Real pointers deliver a
 * handful of moves per frame at most; past this many the oldest geometry is
 * already sub-pixel noise and the newest slot is overwritten instead, keeping
 * the total displacement (and so every `dx`/`dy` sum) exact.
 */
const POINTER_RING_CAP = 32;

interface EngineHistoryEntry extends DestructionHistoryEntry {
  content: ContentCheckpoint | null;
  damage: HTMLCanvasElement | null;
  fuel: FieldSnapshot | null;
  destruction: number;
  takenElements: boolean[];
}

/**
 * RageLayerEngine owns the overlay DOM, the rAF loop, pointer input, and all
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
export class RageLayerEngine implements RageLayerEngineApi {
  private comboTracker: ComboTracker | null;
  private comboListeners = new Set<(event: ComboEvent) => void>();
  private errorListeners = new Set<(error: EngineError) => void>();
  private lastError: EngineError | null = null;
  /** Keyboard aiming cursor, in document coordinates. */
  private aimCursor: Vec2 | null = null;
  private applyingCombo = false;
  private readonly history: DestructionHistory<EngineHistoryEntry> | null;
  private restoringHistory = false;
  /** The overlay DOM and every question about where things are. */
  private readonly overlay: Overlay;
  readonly sound = new SoundEngine();
  /** Rigid-body debris: chunks of page that have physically come off. */
  readonly physics: PhysicsWorld;
  /** Fire and the wood-fuel grid it consumes. */
  private readonly fire = new FlameField();

  /** Document-space rects of the real page's furniture (see `elements.ts`). */
  pageElements: PageElement[] = [];

  /** Rasterizing the real page, and keeping the copy current. */
  private readonly capture: CaptureController;

  /** The destructible page, or null until a capture has succeeded. */
  private get contentLayer(): ContentLayer | null {
    return this.capture.content;
  }

  private set contentLayer(layer: ContentLayer | null) {
    this.capture.install(layer);
  }
  /** `_damageCtx` behind the atop→over wrapper; what the getters hand out. */
  private _damageToolCtx: CanvasRenderingContext2D | null = null;
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
  /**
   * Pointermove ring, filled cheaply by `onPointerMove` and replayed through
   * the active tool once per frame by `flushPointerMoves`. Slots are reused
   * frame to frame, so a coalesced-event storm allocates nothing.
   */
  private readonly pendingMoves: { x: number; y: number; buttons: number }[] = [];
  private pendingMoveCount = 0;
  /** Reused `onMove` event object; tools read it synchronously during a flush. */
  private readonly moveScratch = { x: 0, y: 0, dx: 0, dy: 0, buttons: 0 };
  // ── Tool-art pose state ────────────────────────────────────────────────────
  // Everything the drawn-tool renderings derive their animation from: press/
  // release timestamps (seconds, on the rAF clock) and a smoothed read of
  // pointer motion. See `renderToolArt`.
  // Stamped from `lastTime`, the frame clock, never `performance.now()`:
  // renderToolArt subtracts them from the frame timestamp, and a host driving
  // `frame()` with its own clock must not see the two time bases diverge.
  private artDownAt = -Infinity;
  private artUpAt = -Infinity;
  private artVX = 0;
  private artVY = 0;
  private readonly artAimX = REST_AIM_X;
  private readonly artAimY = REST_AIM_Y;
  private artPrev: Vec2 = { x: -1000, y: -1000 };
  private raf = 0;
  /** True after the loop deliberately stopped, so its next wake starts from a fresh clock. */
  private frameClockSleeping = true;
  private lastTime = 0;
  private lastRenderedAt = 0;
  private monitor: PerformanceMonitor;
  private qualityMode: PerformanceQuality;
  private qualityTier: PerformanceQualityTier;
  private qualityProfile: QualityProfile;
  /** Resolved once at mount from the explicit option or the OS preference. */
  private reducedMotion = false;
  /**
   * 0..1 running total of how wrecked the page is, fed by every `shake()` (which
   * every destructive tool already calls, scaled by how hard it hit). Drives the
   * vignette; repairs walk it back.
   */
  private destruction = 0;
  /**
   * Rate gate for debris-landing dust. A single chunk thudding down gets its
   * puff; a 150-body rain gets a sparse drizzle of them instead of a dust
   * storm that costs more than the debris it decorates.
   */
  private nextImpactDust = 0;
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
  private disposed = false;
  private pausedByHost = false;
  private pausedByVisibility = false;
  private activePointerId: number | null = null;
  private listeners = new Map<EngineEvent, Set<() => void>>();
  private resizeTimer = 0;
  private resizeObserver: ResizeObserver | null = null;
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
  /**
   * What the most recent render pass drew, for telemetry. One reused object:
   * the monitor copies the values into its ring buffers synchronously, so the
   * frame loop never allocates for it.
   */
  private readonly frameRender = { wet: 0, puffs: 0, solids: 0, hot: 0, flames: 0, bodies: 0 };
  /** Low-res heat field sampled by the shimmer shader. */
  private heatCanvas: HTMLCanvasElement | null = null;
  private heatCtx: CanvasRenderingContext2D | null = null;
  /** Whether the heat field has anything in it (skips an upload when cold). */
  private heatLevel = 0;
  /**
   * Whether anything has stamped the heat canvas since it was last cleared.
   * Starts true so a freshly (re)allocated, transparent canvas gets its first
   * opaque-black fill; a cold field skips the per-frame `fillRect` entirely.
   */
  private heatDirty = true;
  private _singularity: Singularity | null = null;
  /** Countdown to the singularity's next bite out of the page. */
  private singularityBite = 0;
  /** Countdown to the next page element the singularity rips loose. */
  private singularityFeed = 0;
  /** Crawling bugs eating the page. */
  private readonly bugs = new BugSwarm();
  /** Fractional accumulator for infalling-matter strands. */
  private spaghettiDebt = 0;
  /** Elements still queued to fall during a `collapse()`. */
  private collapseQueue: PageElement[] = [];
  private collapseTimer = 0;
  private opts: ResolvedEngineOptions;

  constructor(options: RageLayerEngineOptions = {}) {
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
    this.opts = resolveEngineOptions(options);
    this.physics = new PhysicsWorld({
      gravity: this.opts.gravity,
      iterations: this.qualityProfile.physicsIterations,
    });
    this.applyEntityLimits();
    // Asked for live on a browser without the flag: record it up front so the
    // toolbar can say *why* it is in snapshot mode.
    // Registered before the constructor's `captureContent()` call, so a host
    // that passes `onError` sees capture failures — the most likely failure of
    // all, and the one that happens before it could subscribe afterwards.
    if (options.onError) this.errorListeners.add(options.onError);
    this.sound.enabled = options.soundEnabled ?? false;
    const contentRoot = options.contentRoot ?? document.body;
    this.pausedByVisibility = this.opts.pauseWhenHidden && document.visibilityState === "hidden";

    this.overlay = new Overlay({
      zIndex: this.opts.zIndex,
      reducedMotion: this.reducedMotion,
      desynchronizedFx: !this.opts.postFX,
    });
    this.overlay.mount(options.target ?? document.body);

    // A literal rather than `this`: these callbacks are internal plumbing, and
    // putting them on the engine would widen its public API.
    const captureHost: CaptureHost = {
      overlay: this.overlay,
      docSize: () => this.docSize(),
      refreshBand: () => this.refreshBand(),
      onElements: (elements) => {
        this.pageElements = elements;
      },
      onStatusChange: () => this.emit("statuschange"),
      onError: (scope, message, cause) => this.reportError(scope, message, cause),
      onCaptureLanded: () => {
        // A fresh full capture can have different geometry and invalidates old
        // pixel checkpoints. Live refreshes do not pass through this path.
        if (this.history) this.clearHistory();
      },
      onCaptureSettled: (durationMs) => {
        this.monitor.setCaptureDuration(durationMs);
        this.requestFrame();
      },
    };
    this.capture = new CaptureController(captureHost, {
      root: contentRoot,
      mode: this.opts.captureMode,
      liveRefreshMs: this.opts.liveRefreshMs,
      harvestElements: this.opts.harvestElements,
      physics: this.opts.physics,
      textMask: this.opts.textMask,
      filter: options.captureFilter ?? defaultCaptureFilter,
      surface: options.surface,
      perfCounters: this.monitor,
    });
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
      if (contentRoot !== document.documentElement) {
        this.resizeObserver.observe(contentRoot);
      }
    }

    this.overlay.container.addEventListener("pointerdown", this.onPointerDown);
    this.overlay.container.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointercancel", this.onPointerCancel);
    this.overlay.container.addEventListener("pointerleave", this.onPointerLeave);
    this.overlay.container.addEventListener("contextmenu", this.onContextMenu);

    this.lastTime = performance.now();
    if (!this.paused) this.requestFrame();

    // Refcount the process-wide sprite cache: `dispose` frees it only when the
    // last engine goes away, so overlapping engines never rebuild mid-flight.
    liveEngines++;

    if (this.opts.captureContent) {
      void this.capture.capture();
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** The overlay's root element, spanning the whole document. */
  get container(): HTMLDivElement {
    return this.overlay.container;
  }
  get width() {
    return this.overlay.width;
  }
  get height() {
    return this.overlay.height;
  }
  get damageCtx() {
    this.overlay.ensureDamage();
    return (this._damageToolCtx ??= atopAsOver(this.overlay.damageCtx));
  }
  get fxCtx() {
    return this.overlay.fxCtx;
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
    // History is an administrative action, not a pointer release. In
    // particular, undoing while a black hole is held must not detonate it, and
    // the held tool must not resume against the restored page next frame.
    this.cancelPointer();
    const target = this.history.undo(this.createHistoryEntry("redo"));
    if (!target) return false;
    this.restoreHistoryEntry(target);
    target.dispose();
    this.emit("historychange");
    return true;
  }

  redo(): boolean {
    if (!this.history?.state.canRedo) return false;
    this.cancelPointer();
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
      if (cause === undefined) console.warn(`[RageLayer] ${message}`);
      else console.warn(`[RageLayer] ${message}`, cause);
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
    return this.capture.captureStatus;
  }

  /** Live mode was requested but the experimental API isn't available. */
  get liveUnavailable(): boolean {
    return this.capture.liveUnavailable;
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
    return this.capture.refresh();
  }

  registerTool(tool: Tool) {
    const previous = this.tools.get(tool.id);
    const replacingActive = previous === this.activeTool;

    // Replacing an id is an atomic hot swap. Leaving the old object selected
    // while the registry points at the new one makes `tool`, `getTools()` and
    // `unregisterTool()` disagree, and a held old tool can keep ticking after
    // its replacement has apparently landed.
    if (replacingActive) this.flushPointerMoves();
    if (replacingActive && this.pointerDown) this.endPointer();
    if (previous && previous !== tool) previous.reset?.(this);

    // Give shared tools a chance to initialize this engine's isolated state.
    tool.reset?.(this);
    this.tools.set(tool.id, tool);

    if (replacingActive && previous !== tool) {
      this.activeTool = tool;
      this.syncToolPresentation();
      this.emit("toolchange");
      this.requestFrame();
    }
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
    tool.reset?.(this);
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
    // Pending hover moves were aimed at the outgoing tool.
    this.flushPointerMoves();
    if (this.pointerDown) this.endPointer();
    this.activeTool = next;
    this.syncToolPresentation();
    this.emit("toolchange");
    this.requestFrame();
  }

  /** Keep hit testing and cursor presentation derived from the selected tool. */
  private syncToolPresentation() {
    const next = this.activeTool;
    this.overlay.container.style.pointerEvents = next ? "auto" : "none";
    // A tool with drawn art becomes its own cursor; the CSS one would be a
    // second, emoji-sized tool floating over the real one. In `"emoji"` tool
    // style the art never draws, so the CSS cursor stays in charge.
    const drawn = next?.art && this.opts.toolStyle === "3d";
    this.overlay.container.style.cursor = next
      ? drawn
        ? "none"
        : (next.cursor ?? "crosshair")
      : "";
    this.overlay.container.style.touchAction = next ? "none" : "";
    // Tool selection precedes the first destructive pointer action, making it
    // a safe time to warm the quality-preserving post-FX path without charging
    // the opening or capture path for it.
    if (next && this.opts.postFX && this.qualityProfile.postFX) this.setPostFXEnabled(true);
  }

  private createHistoryEntry(label?: string): EngineHistoryEntry {
    const content = this.contentLayer?.createCheckpoint() ?? null;
    let damage: HTMLCanvasElement | null = null;
    if (this.overlay.damageReady) {
      damage = document.createElement("canvas");
      damage.width = this.overlay.damageCanvas.width;
      damage.height = this.overlay.damageCanvas.height;
      damage.getContext("2d")?.drawImage(this.overlay.damageCanvas, 0, 0);
    }
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
      (this.overlay.damageReady
        ? this.overlay.damageCanvas.width * this.overlay.damageCanvas.height
        : 0) +
      this.fieldPixelCost()
    );
  }

  /** The fuel grid's share of a checkpoint, in notional RGBA pixels. */
  private fieldPixelCost(): number {
    return Math.ceil(this.fire.fuelBytes / 4);
  }

  private restoreHistoryEntry(entry: EngineHistoryEntry) {
    this.restoringHistory = true;
    try {
      if (entry.content) this.contentLayer?.restoreCheckpoint(entry.content);
      else this.contentLayer?.restoreAll();
      if (entry.damage) {
        this.overlay.ensureDamage();
        this.overlay.damageCtx.save();
        this.overlay.damageCtx.setTransform(1, 0, 0, 1, 0, 0);
        this.overlay.damageCtx.clearRect(
          0,
          0,
          this.overlay.damageCanvas.width,
          this.overlay.damageCanvas.height,
        );
        this.overlay.damageCtx.drawImage(entry.damage, 0, 0);
        this.overlay.damageCtx.restore();
      } else if (this.overlay.damageReady) {
        this.overlay.damageCtx.clearRect(0, 0, this.overlay.width, this.overlay.height);
      }
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
      for (const tool of this.tools.values()) tool.reset?.(this);
      this.requestFrame();
    } finally {
      this.restoringHistory = false;
    }
  }

  clear() {
    // Cancel before the checkpoint so undo restores exactly the pre-clear
    // page, without synthesizing an onUp action such as a singularity collapse.
    this.cancelPointer();
    if (!this.restoringHistory) this.checkpoint("clear");
    if (this.overlay.damageReady)
      this.overlay.damageCtx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    this.contentLayer?.restoreAll();
    this.fire.clear();
    this.particles.clear();
    this.destruction = 0;
    this.physics.clear();
    // Repaired page, fresh wood: the fuel comes back with the pixels.
    this.fire.refuel();
    this.bugs.clear();
    this._singularity = null;
    this.collapseQueue.length = 0;
    this.comboTracker?.clear();
    // Rockets in flight, queued restrikes, hammer sites: a repaired page owes
    // nothing to the destruction that was still in progress.
    for (const tool of this.tools.values()) tool.reset?.(this);
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
    const w = Math.min(this.overlay.width, document.documentElement.clientWidth);
    const h = Math.min(this.overlay.height, this.overlay.viewportHeight);
    if (w <= 0 || h <= 0) return null;
    const out = document.createElement("canvas");
    out.width = Math.round(w * this.overlay.dpr);
    out.height = Math.round(h * this.overlay.dpr);
    const ctx = out.getContext("2d");
    if (!ctx) return null;
    ctx.setTransform(this.overlay.dpr, 0, 0, this.overlay.dpr, 0, 0);

    const sx = this.scrollX;
    const sy = Math.max(0, Math.min(this.scrollY, this.overlay.height - h));

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
    if (this.overlay.damageReady) {
      const d = this.overlay.dpr;
      ctx.drawImage(this.overlay.damageCanvas, sx * d, sy * d, w * d, h * d, 0, 0, w, h);
    }
    // The effects layer is viewport-parked, so its source rect is relative to
    // wherever `positionFx` last left it.
    const presented = this.postfxActive ? this.postfx!.canvas : this.overlay.fxCanvas;
    if (this.fxPainted && presented.width > 0) {
      const d = this.overlay.dpr;
      ctx.drawImage(
        presented,
        (sx - this.overlay.fxOffsetX) * d,
        (sy - this.overlay.fxOffsetY) * d,
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

    this.resizeTimer = 0;

    window.removeEventListener("resize", this.onWindowResize);
    window.removeEventListener("scroll", this.onScroll);
    window.removeEventListener("pagehide", this.onPageHide);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerCancel);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.overlay.container.removeEventListener("pointerdown", this.onPointerDown);
    this.overlay.container.removeEventListener("pointermove", this.onPointerMove);
    this.overlay.container.removeEventListener("pointerleave", this.onPointerLeave);
    this.overlay.container.removeEventListener("contextmenu", this.onContextMenu);
    this.capture.dispose();
    this.physics.clear();
    this.postfx?.dispose();
    this.postfx = null;
    this.overlay.container.remove();
    this.overlay.container.replaceChildren();
    this.sound.dispose();
    this.history?.clear();
    this.emit("dispose");
    this.listeners.clear();
    this.monitor.dispose();

    // `dispose` must release the expensive state even when application code
    // intentionally keeps the engine object for inspection. In particular, a
    // detached high-DPI canvas keeps its whole pixel backing until it is reset.
    this.overlay.damageCanvas.width = 0;
    this.overlay.damageCanvas.height = 0;
    this.overlay.fxCanvas.width = 0;
    this.overlay.fxCanvas.height = 0;
    if (this.heatCanvas) {
      this.heatCanvas.width = 0;
      this.heatCanvas.height = 0;
      this.heatCanvas.remove();
    }
    this.heatCanvas = null;
    this.heatCtx = null;
    this._damageToolCtx = null;
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
    // Pending tool state must not survive disposal.
    for (const tool of this.tools.values()) tool.reset?.(this);
    this.tools.clear();
    this.activeTool = null;
    this.pointerDown = false;
    this.activePointerId = null;
    this.fire.dispose();
    this._singularity = null;

    // Last engine out releases the shared sprite atlas. Safe even if another
    // engine is created later — `sprites()` rebuilds lazily.
    liveEngines = Math.max(0, liveEngines - 1);
    if (liveEngines === 0) clearSpriteCache();
  }

  // ── Content capture (the "destroy the real page" pipeline) ────────────────

  /** The document rows a live refresh covers: what the user can see, plus a screen either side. */
  private refreshBand() {
    const viewport = this.overlay.viewportHeight;
    return { y0: this.scrollY - viewport, y1: this.scrollY + viewport * 2 };
  }

  // ── RageLayerEngineApi (used by tools) ────────────────────────────────────

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
    if (!this.overlay.damageReady) return;
    const ctx = this.overlay.damageCtx;
    ctx.globalCompositeOperation = "destination-out";
    blit(ctx, sprites().erase, x, y, radius, 1);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  /**
   * Rinse stains off the page: paint, soot and smears wash away, but structural
   * damage stays. Holes are beyond washing — `eraseDamage` (the broom)
   * repairs; water only cleans.
   */
  washSurface(x: number, y: number, radius: number, strength = 1) {
    this.contentLayer?.wash(x, y, radius, strength);
    if (this.overlay.damageReady) {
      const ctx = this.overlay.damageCtx;
      ctx.globalCompositeOperation = "destination-out";
      blit(ctx, sprites().erase, x, y, radius, Math.min(1, strength));
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }
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
    this.overlay.shake(strength, dirX, dirY);
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
   * The direction the drawn tool is aiming (unit vector). Tools that fire
   * something directional — a tracer, a rocket, a jet — read this so their
   * effects line up with the way the tool is visibly pointing, instead of
   * picking a direction at random.
   *
   * Constant: the art holds one pose rather than swinging to follow the
   * pointer, so this never turns either (see `REST_AIM_X`).
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
   * flamethrower or chainsaw needs to be on for a moment to do anything.
   * The hold is simulated against the engine's own frame loop rather than
   * being wall-clock, so it behaves the same on a slow machine.
   *
   * Returns false when there is no tool selected or the engine is paused.
   */
  strike(x: number, y: number, { holdMs = 0 }: { holdMs?: number } = {}): boolean {
    const tool = this.activeTool;
    if (!tool || this.paused || this.disposed) return false;

    // Recorded pointer moves precede the synthetic gesture, as they would a real one.
    this.flushPointerMoves();
    this.checkpoint(tool.id);
    const event = { x, y, dx: 0, dy: 0, buttons: 1 };
    this.pointer.x = x;
    this.pointer.y = y;
    this.lastPointer.x = x;
    this.lastPointer.y = y;
    this.artDownAt = this.lastTime / 1000;
    this.pointerDown = true;
    tool.onDown?.(this, event);

    if (holdMs > 0) {
      const dt = 1 / 60;
      const steps = Math.min(600, Math.round(holdMs / (dt * 1000)));
      for (let i = 0; i < steps; i++) tool.tick?.(this, dt, true, this.pointer);
    }

    this.pointerDown = false;
    this.artUpAt = this.lastTime / 1000;
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
    const count = options.count ?? shardBudget(radius, Math.max(0.55, 1.4 / WOOD.toughness));
    const cells = voronoiCells(x, y, radius, count);
    const power = (options.power ?? 240) / Math.sqrt(WOOD.density);
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
          density: 0.0018 * WOOD.density,
          restitution: Math.max(0.14, WOOD.restitution),
          friction: 0.62,
          ttl: options.ttl ?? 10 + Math.random() * 8,
        },
        { edge: "rgba(12, 9, 7, 0.45)" },
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
      RageLayerEngine.appendPoly(carve, cell);
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
    this.contentLayer?.char(x, y, radius * 1.2, 0.3);
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
    RageLayerEngine.appendPoly(carve, points);
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
    // A demolition blow delivered through an existing hole cannot couple to a
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
      RageLayerEngine.appendPoly(carve, cell);
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
    const bottom = this.scrollY + this.overlay.viewportHeight + 240;
    this.collapseQueue = elementsInBand(
      this.pageElements,
      top,
      bottom,
      this.scrollY + this.overlay.viewportHeight * 0.35,
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
        Math.random() * this.overlay.width,
        this.scrollY + Math.random() * this.overlay.viewportHeight,
        70 + Math.random() * 70,
        { power: 140 },
      );
    }
    this.shake(22, 0, 1);
    this.sound.boom();
  }

  // ── Heat field (drives the post-processing shimmer) ───────────────────────

  heat(x: number, y: number, radius: number, amount: number) {
    if (!this.postfxEnabled) return;
    const ctx = this.heatCtx;
    if (!ctx || amount <= 0) return;
    const hx = (x - this.overlay.fxOffsetX) / HEAT_SCALE;
    const hy = (y - this.overlay.fxOffsetY) / HEAT_SCALE;
    const hr = radius / HEAT_SCALE;
    // Additive onto an opaque black field: the canvas composites in
    // premultiplied space, so `lighter` accumulates the gradient's *weighted*
    // colour and the resulting red channel is a real heat value rather than a
    // flat disc of full-strength orange.
    ctx.globalCompositeOperation = "lighter";
    blit(ctx, sprites().glow, hx, hy, hr, Math.min(1, amount));
    ctx.globalAlpha = 1;
    this.heatDirty = true;
    if (amount > this.heatLevel) this.heatLevel = Math.min(1, amount);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private applyCombo(event: ComboEvent) {
    const { x, y } = event;
    const burst = (kind: Particle["kind"], count: number, color?: string) => {
      for (let i = 0; i < count; i++) {
        const angle = Math.random() * TAU;
        const speed = 60 + Math.random() * 180;
        const p = scratchParticle(
          kind,
          x,
          y,
          Math.cos(angle) * speed,
          Math.sin(angle) * speed - 60,
          0.45 + Math.random() * 0.65,
          2 + Math.random() * 5,
        );
        p.color = color;
        p.gravity = kind === "steam" ? -35 : 260;
        p.phase = Math.random() * TAU;
        this.spawnParticle(p);
      }
    };

    switch (event.id) {
      case "steam-shock":
        this.dowseFlames(x, y, 72, 0.55);
        burst("steam", 12);
        this.sound.hiss();
        break;
      case "conductive-surge":
        burst("spark", 18, "#bdeaff");
        this.squashBugs(x, y, 62);
        this.sound.zap();
        break;
      case "volatile-corrosion":
        this.explode(x, y, 42, { power: 390, incendiary: false });
        burst("smoke", 10, "#8bcf65");
        break;
      case "orbital-bomb":
        this.physics.blast(x, y, 180, 760);
        this.shake(12);
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
    this.silenceToolLoops();
  }

  /** Loops driven by a held tool, distinct from persistent ambient fire. */
  private silenceToolLoops() {
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
    postfx.counters = this.monitor;
    this.heatCanvas = document.createElement("canvas");
    this.heatCtx = this.heatCanvas.getContext("2d", { willReadFrequently: false });
    postfx.resize(
      this.overlay.fxCanvas.width,
      this.overlay.fxCanvas.height,
      this.overlay.fxWidth,
      this.overlay.fxHeight,
    );
    this.heatCanvas.width = Math.max(1, Math.round(this.overlay.fxWidth / HEAT_SCALE));
    this.heatCanvas.height = Math.max(1, Math.round(this.overlay.fxHeight / HEAT_SCALE));
    // A resized canvas is transparent again; the next `resetHeat` must fill it.
    this.heatDirty = true;
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
    const outgoing = this.postfxActive ? postfx!.canvas : this.overlay.fxCanvas;
    const incoming = next ? postfx!.canvas : this.overlay.fxCanvas;
    incoming.style.transform = outgoing.style.transform;
    outgoing.replaceWith(incoming);
    this.postfxActive = next;
    if (!next) postfx?.clear();
    this.overlay.fxOffsetX = this.overlay.fxOffsetY = -1;
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
   * Re-measure the overlay against the document and push the new fx geometry
   * into the post-processing chain.
   */
  private resize() {
    const { width, height } = this.docSize();
    const overlay = this.overlay;
    overlay.resize(width, height, this.opts.effectsPixelRatio);
    this.postfx?.resize(
      overlay.fxCanvas.width,
      overlay.fxCanvas.height,
      overlay.fxWidth,
      overlay.fxHeight,
    );
    if (this.heatCanvas) {
      this.heatCanvas.width = Math.max(1, Math.round(overlay.fxWidth / HEAT_SCALE));
      this.heatCanvas.height = Math.max(1, Math.round(overlay.fxHeight / HEAT_SCALE));
      // A resized canvas is transparent again; the next `resetHeat` must fill it.
      this.heatDirty = true;
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
    this.capture.exitContentMode();
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
        if (!this.disposed) this.capture.recaptureAfterReflow();
      }, 350);
    }
  };

  private toolEvent(e: PointerEvent) {
    // Equivalent to `clientX - container.getBoundingClientRect().left`, but
    // without forcing a layout on every pointermove. The scroll offset comes
    // from the same passive-listener cache the render loop trusts — two fewer
    // browser-boundary reads per event.
    const x = e.clientX + this.scrollX - this.overlay.originX;
    const y = e.clientY + this.scrollY - this.overlay.originY;
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
    // Hover moves recorded before the press belong before it.
    this.flushPointerMoves();
    this.checkpoint(this.activeTool.id);
    this.pointerDown = true;
    this.activePointerId = e.pointerId;
    try {
      this.overlay.container.setPointerCapture?.(e.pointerId);
    } catch {
      // Older Safari builds can reject capture even though Pointer Events exist.
    }
    this.artDownAt = this.lastTime / 1000;
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
    // Record-only: pointermove can outrun the frame rate by an order of
    // magnitude, so the event does the cheap coordinate conversion and defers
    // the tool's response to `flushPointerMoves`, which replays the whole path
    // in the frame this wakes — same-frame, so no added input latency.
    const x = e.clientX + this.scrollX - this.overlay.originX;
    const y = e.clientY + this.scrollY - this.overlay.originY;
    this.pointer.x = x;
    this.pointer.y = y;
    const at =
      this.pendingMoveCount < POINTER_RING_CAP ? this.pendingMoveCount++ : POINTER_RING_CAP - 1;
    let slot = this.pendingMoves[at];
    if (!slot) {
      slot = { x: 0, y: 0, buttons: 0 };
      this.pendingMoves[at] = slot;
    }
    slot.x = x;
    slot.y = y;
    slot.buttons = e.buttons;
    this.requestFrame();
    // Paused engines schedule no frame, but tools always saw moves (a broom
    // can still sweep a paused page). Keep that by flushing in the event.
    if (this.paused) this.flushPointerMoves();
  };

  /**
   * Replay every pointer position recorded since the last flush through the
   * active tool's `onMove`, in order. Path-integrating tools (chainsaw, laser,
   * broom, demolition) still see every intermediate position; the per-event
   * cost is just the ring write above.
   */
  private flushPointerMoves() {
    const count = this.pendingMoveCount;
    if (count === 0) return;
    this.pendingMoveCount = 0;
    const tool = this.activeTool;
    const ev = this.moveScratch;
    const last = this.lastPointer;
    for (let i = 0; i < count; i++) {
      const move = this.pendingMoves[i];
      ev.x = move.x;
      ev.y = move.y;
      ev.dx = last.x < -100 ? 0 : move.x - last.x;
      ev.dy = last.y < -100 ? 0 : move.y - last.y;
      ev.buttons = move.buttons;
      last.x = move.x;
      last.y = move.y;
      tool?.onMove?.(this, ev);
    }
  }

  private onPointerUp = (e: PointerEvent) => {
    this.endPointer(e);
  };

  private onPointerCancel = (e: PointerEvent) => {
    this.endPointer(e);
  };

  private endPointer(e?: PointerEvent) {
    if (!this.pointerDown) return;
    if (e && this.activePointerId !== null && e.pointerId !== this.activePointerId) return;
    // Moves recorded before the release belong before it.
    this.flushPointerMoves();
    this.pointerDown = false;
    this.artUpAt = this.lastTime / 1000;
    const ev = e ? this.toolEvent(e) : { ...this.pointer, dx: 0, dy: 0, buttons: 0 };
    this.activeTool?.onUp?.(this, ev);
    this.silenceToolLoops();
    this.releaseActivePointerCapture();
    this.requestFrame();
  }

  /** Stop a gesture without invoking the tool's destructive release action. */
  private cancelPointer() {
    if (!this.pointerDown) return;
    this.pointerDown = false;
    this.artUpAt = this.lastTime / 1000;
    this.silenceToolLoops();
    this.releaseActivePointerCapture();
    this.requestFrame();
  }

  private releaseActivePointerCapture() {
    if (this.activePointerId !== null) {
      try {
        this.overlay.container.releasePointerCapture?.(this.activePointerId);
      } catch {
        // Capture may already have been released by the browser on cancellation.
      }
    }
    this.activePointerId = null;
  }

  private onPointerLeave = () => {
    // Deliver anything recorded on the way out before parking the sentinel.
    this.flushPointerMoves();
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
    this.frameClockSleeping = false;
    this.monitor.observeRaf(now);
    // The 60 fps rate cap borrows the balanced tier's frame-skip interval:
    // full visual quality, half the cadence on >90 Hz displays.
    const minFrameInterval =
      this.qualityTier === "high" && this.monitor.rateCap60
        ? QUALITY_PROFILES.balanced.minFrameIntervalMs
        : this.qualityProfile.minFrameIntervalMs;
    if (minFrameInterval > 0 && now - this.lastRenderedAt < minFrameInterval) {
      this.requestFrame();
      return;
    }
    this.lastRenderedAt = now;
    // Clamped below at zero: `lastTime` starts from `performance.now()` and the
    // first host-supplied timestamp may precede it (rAF vsync stamps do; test
    // clocks can by much more). A backwards step must not run physics in
    // reverse.
    const dt = Math.min(0.05, Math.max(0, (now - this.lastTime) / 1000));
    this.lastTime = now;

    // Coalesced pointer input lands first — exactly where the events used to
    // run — so everything below (the post-FX demand check, heat reset, tool
    // ticks, rendering) sees the same state it did when moves were per-event.
    this.flushPointerMoves();

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
    // One timestamp between consecutive steps: each subsystem's slice is the
    // difference of adjacent stamps, so the whole breakdown costs eight
    // `performance.now()` calls regardless of how much work ran.
    const updateStartedAt = performance.now();
    const toolWorkPending = this.stepTools(dt);
    this.stepToolArt(dt);
    const toolsDoneAt = performance.now();
    this.stepCollapse(dt);
    const collapseDoneAt = performance.now();
    this.fire.step(this, dt, this.lastTime);
    const flamesDoneAt = performance.now();
    this.destruction = Math.min(1, this.destruction + this.bugs.step(this, dt));
    const bugsDoneAt = performance.now();
    this.stepSingularity(dt);
    const singularityDoneAt = performance.now();
    this.particles.step(dt, this.lastTime, this.particleWorld);
    const particlesDoneAt = performance.now();
    this.stepPhysics(dt);
    const updateEndedAt = performance.now();
    const updateMs = updateEndedAt - updateStartedAt;
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
    // One stamp is both the surface slice's end and the render slice's start.
    const renderStartedAt = performance.now();
    const surfaceMs = renderStartedAt - surfaceStartedAt;
    this.render();
    const renderTotalMs = performance.now() - renderStartedAt;
    this.overlay.stepShake(dt, this.scrollY);
    this.overlay.setVignetteLevel(this.destruction);
    this.updateLoops();

    const frameMs = performance.now() - frameStartedAt;
    const nativeTarget = this.monitor.nativeTargetFps;
    const targetFps =
      this.qualityTier === "high" && !this.monitor.rateCap60
        ? nativeTarget
        : Math.min(60, nativeTarget);
    const recommendation = this.monitor.record({
      cadenceMs: dt * 1_000,
      frameMs,
      updateMs,
      surfaceMs,
      renderMs: Math.max(0, renderTotalMs - this.postFXFrameMs),
      postFXMs: this.postFXFrameMs,
      toolsMs: toolsDoneAt - updateStartedAt,
      collapseMs: collapseDoneAt - toolsDoneAt,
      flamesMs: flamesDoneAt - collapseDoneAt,
      bugsMs: bugsDoneAt - flamesDoneAt,
      singularityMs: singularityDoneAt - bugsDoneAt,
      particlesMs: particlesDoneAt - singularityDoneAt,
      physicsMs: updateEndedAt - particlesDoneAt,
      render: this.frameRender,
      entities: {
        particles: this.particles.count,
        flames: this.fire.count,
        bodies: this.physics.count,
        bugs: this.bugs.count,
      },
      quality: this.qualityTier,
      pixelRatio: this.overlay.dpr,
      effectsPixelRatio: this.overlay.fxDpr,
      targetFps,
    });
    if (recommendation && this.qualityMode === "auto") this.applyQuality(recommendation);

    if (this.hasActiveWork(toolWorkPending)) this.requestFrame();
    else this.frameClockSleeping = true;
  };

  private requestFrame() {
    if (this.disposed || this.paused || this.raf) return;
    // No simulation time passes while the event-driven loop is asleep. Without
    // rebasing here, the first pointer press after a quiet period receives the
    // 50ms catch-up clamp and telemetry reports the intentional sleep as jank.
    if (this.frameClockSleeping) {
      this.lastTime = performance.now();
      this.frameClockSleeping = false;
    }
    this.raf = requestAnimationFrame(this.frame);
  }

  private hasActiveWork(toolWorkPending = this.toolsHavePendingWork()) {
    const active = this.activeTool;
    // Tools published before `hasPendingWork` existed were documented as
    // receiving continuous selected ticks. Preserve that contract; built-ins
    // opt into event-driven sleeping by defining the predicate explicitly.
    const legacySelectedTick = !!active?.tick && active.hasPendingWork === undefined;
    return (
      this.particles.count > 0 ||
      this.fire.count > 0 ||
      this.physics.active ||
      this.bugs.count > 0 ||
      this.collapseQueue.length > 0 ||
      !!this._singularity ||
      this.pointerDown ||
      legacySelectedTick ||
      toolWorkPending ||
      this.overlay.isShaking
    );
  }

  /** Advance the selected interaction plus autonomous work owned by other tools. */
  private stepTools(dt: number) {
    const active = this.activeTool;
    active?.tick?.(this, dt, this.pointerDown, this.pointer);
    let pending = false;
    for (const tool of this.tools.values()) {
      const hasPendingWork = tool.hasPendingWork?.(this) ?? false;
      pending ||= hasPendingWork;
      if (tool !== active && tool.backgroundTick && hasPendingWork) tool.backgroundTick(this, dt);
    }
    // An inactive background tick may have completed its final item. Keeping
    // this pre-tick result schedules at most one drain frame, which is cheaper
    // than re-running every custom predicate in the same frame and guarantees
    // the effect it just emitted reaches presentation.
    return pending;
  }

  private toolsHavePendingWork() {
    for (const tool of this.tools.values()) {
      if (tool.hasPendingWork?.(this)) return true;
    }
    return false;
  }

  private hasPostFXDemand() {
    return (
      this.fire.count > 0 ||
      this.destruction > 0.016 ||
      !!this._singularity ||
      this.particles.flashJetCount > 0
    );
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
    // A field nothing stamped since the last clear is still opaque black; the
    // full-canvas fill would repaint what is already there.
    if (!this.heatDirty) return;
    this.heatDirty = false;
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
   * gets a low-passed velocity to lean and flex against.
   *
   * Velocity only: the tool's aim is fixed (`REST_AIM_X`), so motion bends
   * details without ever turning the tool itself.
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
      // Hold durations can never be negative, whatever clock stamped them: a
      // press recorded moments "after" this frame's timestamp is a hold of 0.
      sinceDown: Math.max(0, time - this.artDownAt),
      sinceUp: Math.max(0, time - this.artUpAt),
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
    const floorY = Math.min(this.overlay.height, this.scrollY + this.overlay.viewportHeight) - 1;
    this.physics.setBounds(this.overlay.width, floorY);
    this.physics.step(dt);

    const impacts = this.physics.impacts;
    if (
      impacts.length > 0 &&
      this.lastTime > this.nextImpactDust &&
      Math.random() <= this.qualityProfile.particleScale
    ) {
      this.nextImpactDust = this.lastTime + 90;
      // One restrained puff at the strongest contact is enough to sell the
      // weight. Drawing every collision in a settling pile makes dust look
      // like a second explosion and scales cost with contact-pair count.
      let strongest = 0;
      for (let i = 3; i < Math.min(impacts.length, 18); i += 3) {
        if (impacts[i + 2] > impacts[strongest + 2]) strongest = i;
      }
      const force = Math.min(1, impacts[strongest + 2] / 900);
      this.spawnParticle({
        kind: "dust",
        x: impacts[strongest] + (Math.random() - 0.5) * 10,
        y: impacts[strongest + 1] - Math.random() * 4,
        vx: (Math.random() - 0.5) * (36 + 54 * force),
        vy: -10 - Math.random() * 38 * force,
        life: 0,
        maxLife: 0.4 + Math.random() * (0.25 + force * 0.25),
        size: 3 + Math.random() * (3 + 4 * force),
        gravity: 12,
        drag: 2.8,
      });
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

  private render() {
    this.postFXFrameMs = 0;
    const time = this.lastTime / 1000;
    const ctx = this.overlay.fxCtx;
    const presented = this.postfxActive ? this.postfx!.canvas : this.overlay.fxCanvas;
    const view = this.overlay.positionFx(this.scrollX, this.scrollY, presented);

    // Pointer events request their own frame, so a visible but motionless tool
    // can stay as the last retained canvas image without keeping rAF alive.
    // Held gestures and live effects still animate through `hasActiveWork`.
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
    const drew = this.frameRender;
    if (idle) {
      drew.wet = drew.puffs = drew.solids = drew.hot = drew.flames = drew.bodies = 0;
      // Nothing to draw: clear once after the last active frame, then leave the
      // canvas (and the compositor) completely alone while idle.
      if (this.fxPainted) {
        this.clearFxCanvas(ctx);
        if (this.postfxActive) this.postfx?.clear();
        this.fxPainted = false;
      }
      return;
    }
    this.clearFxCanvas(ctx);
    this.fxPainted = true;

    // Bugs crawl *on* the page, under every particle and piece of debris.
    if (this.bugs.count > 0) this.bugs.render(ctx, view.top, view.bottom, time);

    // One classification pass up front; the four passes below draw from it.
    this.fx.classify(this.particles.particles, view);
    drew.wet = this.fx.wetCount;
    drew.puffs = this.fx.puffCount;
    drew.solids = this.fx.solidCount;
    drew.hot = this.fx.hotCount;
    this.fx.drawWet(ctx);

    // Flames render here — with the other *surface-bound* effects, before the
    // mask below — not in the airborne additive pass at the end.
    let flamesDrawn = 0;
    ctx.globalCompositeOperation = "lighter";
    for (const f of this.fire.list) {
      if (f.y < view.top - 300 || f.y > view.bottom + 300) continue;
      if (f.x < view.left - 300 || f.x > view.right + 300) continue;
      flamesDrawn++;
      drawFlame(ctx, f, time, this.qualityProfile.flameLayers);
      // Air above a fire is what the shimmer shader distorts.
      this.heat(f.x, f.y - f.radius, f.radius * 3.2, 0.5 * f.intensity);
    }
    ctx.globalCompositeOperation = "source-over";
    drew.flames = flamesDrawn;
    // Submitted bodies; the debris renderer culls to the view internally.
    drew.bodies = this.physics.count;

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

  /** Clear every backing-store pixel regardless of the document-space transform. */
  private clearFxCanvas(ctx: CanvasRenderingContext2D) {
    // Re-apply `positionFx`'s document-space transform directly instead of
    // paying a save/restore state push per frame. Callers only run after
    // `positionFx`, so the overlay's parked offsets are always current.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    const overlay = this.overlay;
    const dpr = overlay.fxDpr;
    ctx.setTransform(dpr, 0, 0, dpr, -overlay.fxOffsetX * dpr, -overlay.fxOffsetY * dpr);
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
    // heatDirty doubles as "the heat canvas has content this frame": resetHeat
    // clears it at frame start and every heat() stamp re-arms it, so a cold
    // frame lets post-FX skip the heat texture upload entirely.
    postfx.render(this.overlay.fxCanvas, this.heatCanvas, {
      bloom,
      heat,
      aberration,
      time,
      heatDrawn: this.heatDirty,
    });
    return performance.now() - startedAt;
  }

  private updateLoops() {
    this.sound.loop("fire", Math.min(1, this.fire.totalIntensity / 4) * 0.5);
  }
}
