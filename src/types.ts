import type { ComboEvent, ComboTrackerOptions, InteractionKind } from "./combos";
import type { HistoryOptions, HistoryState } from "./history";
import type { SurfaceParams } from "./surface";

export type { SurfaceParams };

export interface Vec2 {
  x: number;
  y: number;
}

export interface ToolPointerEvent {
  x: number;
  y: number;
  /** Movement delta since last event (0 on down). */
  dx: number;
  dy: number;
  buttons: number;
}

/**
 * Everything a tool rendering needs to pose itself, computed fresh by the
 * engine each frame. Art functions stay stateless: the same state always
 * draws the same pixels (which is also what lets toolbars bake icons).
 */
export interface ToolArtState {
  /** Continuous clock, seconds — drives idle bob, chain crawl, flicker. */
  time: number;
  /** Pointer is currently down. */
  held: boolean;
  /** Seconds since the pointer last went down (Infinity before the first). */
  sinceDown: number;
  /** Seconds since the pointer last came up (Infinity before the first). */
  sinceUp: number;
  /** Smoothed pointer velocity, CSS px/s — bends bristles, swings the ball. */
  vx: number;
  vy: number;
  /**
   * Unit aim direction, fixed up-and-left. Art that has a bore or a working
   * edge orients to this so it points somewhere deliberate; it deliberately
   * does not follow the pointer, so the tool never spins under the cursor.
   */
  aimX: number;
  aimY: number;
}

/**
 * Draws a tool at the pointer. Called with the canvas origin translated to
 * the pointer hotspot (the impact point); the tool body should extend down
 * and to the right, the way a right hand holds it into the page.
 */
export type ToolArtFn = (ctx: CanvasRenderingContext2D, state: ToolArtState) => void;

/**
 * A destruction tool. Tools are stateless where possible — persistent damage
 * goes on the engine's damage canvas, transient effects are particles/entities
 * stepped by the engine loop.
 */
export interface Tool {
  id: string;
  name: string;
  /** Emoji used for toolbar buttons and the generated cursor. */
  icon: string;
  /** Short hint shown in the toolbar ("click", "hold", "drag"). */
  hint: string;
  /** Custom CSS cursor. Falls back to crosshair. */
  cursor?: string;
  /**
   * Hand-drawn rendering that follows the pointer in place of the CSS cursor.
   * When set, the engine hides the cursor and draws this on the effects layer
   * every frame — the drawn tool *is* the cursor. See `ToolArtFn`.
   */
  art?: ToolArtFn;
  onDown?(engine: DestroyerEngineApi, e: ToolPointerEvent): void;
  onMove?(engine: DestroyerEngineApi, e: ToolPointerEvent): void;
  onUp?(engine: DestroyerEngineApi, e: ToolPointerEvent): void;
  /** Called every frame while the tool is selected. `held` = pointer down. */
  tick?(engine: DestroyerEngineApi, dt: number, held: boolean, pointer: Vec2): void;
  /**
   * Continue autonomous work after another tool is selected. Pair with
   * `hasPendingWork`; the engine calls this only while that predicate is true.
   * Timed projectiles and fuses belong here, never held-pointer behavior.
   */
  backgroundTick?(engine: DestroyerEngineApi, dt: number): void;
  /**
   * Whether this tool currently owns autonomous work that needs animation
   * frames. Defining the predicate also opts the selected tool into idle
   * sleeping when it returns false and no pointer/effect work remains. Keep it
   * cheap and side-effect-free; the scheduler may ask outside the frame step.
   */
  hasPendingWork?(engine: DestroyerEngineApi): boolean;
  /**
   * Drop any retained state — in-flight projectiles, strike sites, spawn
   * debts. Tools are module-level singletons shared by every engine, so the
   * engine calls this on registration/replacement, unregister, history restore,
   * `clear()` and `dispose()`. The engine argument lets tools keep retained
   * state isolated when multiple layers are mounted at once; stateless tools
   * may ignore it.
   */
  reset?(engine?: DestroyerEngineApi): void;
}

export type ParticleKind =
  | "debris"
  | "spark"
  | "smoke"
  | "steam"
  | "ember"
  | "water"
  | "splash"
  | "casing"
  | "sawdust"
  | "wet"
  | "flash"
  | "shard"
  /** Pale page dust: plaster from bullet holes, sawdust haze, broom sweep. */
  | "dust"
  /** Expanding impact shockwave (hollow, so it never fills a hole back in). */
  | "ring"
  /** Rotated filament: bullet tracers and motion trails (drawn additively). */
  | "streak"
  /** The solid, still-unbroken part of the water hose's jet. */
  | "stream"
  /** Flamethrower fuel blob — the thing that makes the jet read as a cone. */
  | "jet"
  /** Water running down the page after a splash. */
  | "rivulet"
  /** Wet paint sliding downward; stamps a permanent streak where it stops. */
  | "paint"
  /** Clean twinkle left behind by the broom. */
  | "sparkle"
  /** Matter being stretched into a black hole (drawn as a spiralling filament). */
  | "spaghetti";

export interface Particle {
  kind: ParticleKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color?: string;
  /** Secondary tint — paint drips carry their own gloss highlight. */
  color2?: string;
  spin?: number;
  angle?: number;
  gravity?: number;
  drag?: number;
  /**
   * Restitution for particles that land. Set together with `restY`: on
   * crossing it the particle bounces, loses most of its energy, and settles.
   */
  bounce?: number;
  restY?: number;
  /** Length of a "streak", and the growing tail of a "rivulet". */
  len?: number;
  /** Free-running phase for flicker/twinkle, so particles don't pulse in sync. */
  phase?: number;
  /** "shard" particles carry a chunk of the page snapshot. */
  img?: CanvasImageSource;
  sx?: number;
  sy?: number;
  sw?: number;
  sh?: number;
}

export interface Flame {
  x: number;
  y: number;
  /** 0..1 — visual + spreading strength. Water pushes it down. */
  intensity: number;
  /** Max visual radius in px. */
  radius: number;
  age: number;
  seed: number;
  /** Cooldown until this flame may spawn a child flame. */
  spreadCooldown: number;
  scorchCooldown: number;
  /** Cooldown until this flame may crack and throw a burst of embers. */
  popCooldown: number;
}

/** A source-rect handle into the pristine page snapshot (for flying shards). */
export interface ContentPatch {
  img: CanvasImageSource;
  /** Source rect in snapshot device pixels. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/** An open singularity. The engine steps and draws at most one at a time. */
export interface Singularity {
  x: number;
  y: number;
  /** Event-horizon radius in CSS px; grows while the tool is held. */
  radius: number;
  /** Pull strength fed to `PhysicsWorld.attract`. */
  power: number;
  /** 0..1 spin-up, so it opens and closes rather than popping into existence. */
  charge: number;
}

export interface FractureOptions {
  /** Shard count. Defaults to a budget derived from the radius. */
  count?: number;
  /** Outward launch speed, px/s. */
  power?: number;
  /** Extra directional shove, e.g. away from a blast. */
  dirX?: number;
  dirY?: number;
  /** Seconds before shards fade out. */
  ttl?: number;
}

export interface ExplodeOptions {
  /** Blast impulse applied to existing debris. */
  power?: number;
  /** Light fires in the crater. Default true. */
  incendiary?: boolean;
  /** Break the page inside the radius into physics chunks. Default true. */
  fracture?: boolean;
}

export type CaptureMode = "auto" | "snapshot" | "live";

/**
 * How tools present themselves at the pointer and in toolbars.
 *
 * - `"3d"` (default) — tools with `art` are drawn at the pointer as shaded
 *   pseudo-3D renderings (the CSS cursor hides), and toolbars bake their
 *   icons from that art.
 * - `"emoji"` — the classic look: every tool uses its emoji CSS `cursor` and
 *   its emoji `icon` in toolbars; `art` is ignored.
 */
export type ToolStyle = "3d" | "emoji";

/**
 * What the capture pipeline is doing, for status UI.
 *
 * `"idle"` — no capture requested or it failed (overlay-only damage);
 * `"capturing"` — rasterization in flight; `"snapshot"`/`"live"` — ready, in
 * that mode.
 */
export type CaptureStatus = "idle" | "capturing" | "snapshot" | "live";

export type PerformanceQualityTier = "high" | "balanced" | "low";
export type PerformanceQuality = "auto" | PerformanceQualityTier;

export interface PerformanceEntities {
  particles: number;
  flames: number;
  bodies: number;
  bugs: number;
}

export interface PerformanceFrameStats {
  average: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface PerformanceFrameBreakdown {
  updateMs: number;
  surfaceMs: number;
  renderMs: number;
  postFXMs: number;
  /** Tool ticks plus pointer tool-art posing (`stepTools` + `stepToolArt`). */
  toolsMs: number;
  /** Element-by-element page collapse queue (`stepCollapse`). */
  collapseMs: number;
  /** Fire spread, fuel consumption, and page erosion (`fire.step`). */
  flamesMs: number;
  /** Crawling bug simulation (`bugs.step`). */
  bugsMs: number;
  /** Singularity pull, feeding, and lensing bookkeeping (`stepSingularity`). */
  singularityMs: number;
  /** Transient particle simulation (`particles.step`). */
  particlesMs: number;
  /** Rigid-body debris solver (`stepPhysics`). */
  physicsMs: number;
}

/**
 * What the effects layer actually drew, averaged per frame over the sample
 * window. The four particle buckets mirror `FxPainter.classify`'s passes.
 */
export interface PerformanceRenderCounts {
  /** Surface-bound water particles (wet/splash/water/rivulet/stream pass). */
  wet: number;
  /** Smoke, steam, and dust particles (normal-blend puff pass). */
  puffs: number;
  /** Debris, casings, sawdust, paint, and page shards (solid pass). */
  solids: number;
  /** Additive particles: embers, sparks, flashes, rings, jets, streaks. */
  hot: number;
  /** Flames drawn after view culling. */
  flames: number;
  /** Rigid physics bodies submitted to the debris draw. */
  bodies: number;
}

/** Destructible-surface texture upload activity over the sample window. */
export interface PerformanceSurfaceStats {
  /** Incremental `texSubImage2D` dirty-rect uploads this window. */
  uploads: number;
  /** Total device pixels uploaded incrementally (sum of dirty-rect w×h). */
  uploadPixels: number;
  /** Whole-surface `texImage2D` safety-net reconciles this window. */
  reconciles: number;
  /** Average fraction of the page each upload covered (a reconcile counts as 1). */
  coverage: number;
}

/** CPU-side page-coverage query activity over the sample window. */
export interface PerformanceOpacityStats {
  /** `OpacityMap.sample()` calls this window. */
  samples: number;
  /** `isPointInPath`/`isPointInStroke` tests performed inside those walks. */
  pathTests: number;
  /** Cell flattens (retained wound geometry resolved into the raster plane). */
  flattens: number;
}

/**
 * GPU frame timing from the disjoint timer-query extensions, read
 * asynchronously so it never stalls the pipeline. All zeros with
 * `available: false` when no context exposes a timer extension.
 */
export interface PerformanceGpuStats {
  /** Average GPU time per surface-shader pass this window. */
  surfaceMs: number;
  /** Average GPU time per post-FX chain run this window. */
  postFXMs: number;
  /** At least one context reported a working timer-query extension. */
  available: boolean;
}

/** Live-mode base refresh (recompose) activity over the sample window. */
export interface PerformanceCaptureStats {
  /** Capture-band refreshes recomposed into the visible surface this window. */
  recomposes: number;
  /** Average main-thread cost of one of those refreshes. */
  recomposeMs: number;
}

export interface PerformanceSnapshot {
  timestamp: number;
  windowMs: number;
  /** Engine-rendered frames per second. */
  fps: number;
  targetFps: number;
  frames: number;
  /** Render cadence for the sample window. */
  frame: PerformanceFrameStats;
  /** Main-thread time spent inside the engine per rendered frame. */
  cpu: PerformanceFrameStats;
  breakdown: PerformanceFrameBreakdown;
  longFrames: number;
  longFrameRate: number;
  estimatedDroppedFrames: number;
  quality: PerformanceQualityTier;
  qualityReason: string;
  /** Device/capture backing ratio used by the destructible page. */
  pixelRatio: number;
  /** Backing ratio used by transient effects and pointer tool art. */
  effectsPixelRatio: number;
  entities: PerformanceEntities;
  /** Average per-frame draw composition for the effects layer. */
  render: PerformanceRenderCounts;
  /** Destructible-surface texture upload counters for this window. */
  surface: PerformanceSurfaceStats;
  /** Opacity-map query counters for this window. */
  opacity: PerformanceOpacityStats;
  /** Asynchronous GPU pass timing, when the driver exposes timer queries. */
  gpu: PerformanceGpuStats;
  /** Live-mode recompose counters for this window. */
  capture: PerformanceCaptureStats;
  /** Most recent page-capture duration, or null before capture. */
  captureMs: number | null;
  /** Chrome exposes this; other browsers report null. */
  memory: {
    usedJSHeapBytes: number;
    totalJSHeapBytes: number;
    heapLimitBytes: number;
  } | null;
}

export interface PerformanceOptions {
  /** Collect and expose runtime samples. Default true. */
  enabled?: boolean;
  /** Automatically move between high/balanced/low profiles. Default true. */
  adaptive?: boolean;
  /** Publication cadence. Default 1000 ms; minimum 250 ms. */
  sampleIntervalMs?: number;
  onSample?(snapshot: PerformanceSnapshot): void;
}

export interface DestroyerOptions {
  /** Element the overlay attaches to. Defaults to document.body. */
  target?: HTMLElement;
  zIndex?: number;
  /** Procedural WebAudio effects. Defaults to false so visitors opt in. */
  soundEnabled?: boolean;
  /**
   * Disable camera shake and nonessential UI transitions. `"system"` (the
   * default) follows `prefers-reduced-motion`; pass a boolean to override it.
   * Tool and physics motion remain because they are the product's core output.
   */
  reducedMotion?: boolean | "system";
  /** Rendering profile. `auto` (default) adapts from measured frame cost. */
  quality?: PerformanceQuality;
  /** Runtime telemetry and adaptive-quality settings. Pass false to disable metrics. */
  performance?: boolean | PerformanceOptions;
  /**
   * `"3d"` (default) draws each tool's pseudo-3D art at the pointer in place
   * of the CSS cursor; `"emoji"` keeps the classic emoji cursors and ignores
   * tool art. See `ToolStyle`.
   */
  toolStyle?: ToolStyle;
  /** Scale of procedural tool models at the pointer. Clamped to 0.5..2; default 1. */
  toolScale?: number;
  /** Suspend animation, simulation, and looped audio while the document is hidden. Default true. */
  pauseWhenHidden?: boolean;
  /** Cross-tool combo detection. Pass false to disable or options to tune its bounds. */
  combos?: boolean | ComboTrackerOptions;
  /** Hard cap on simultaneous flames (fire spread respects this). */
  maxFlames?: number;
  maxParticles?: number;
  /**
   * Rasterize the real page into a destructible canvas so tools destroy the
   * actual content (holes reveal the void behind the page, fire burns text
   * away, repairs restore from a pristine snapshot). Default true; falls back
   * to overlay-only damage if the capture fails.
   */
  captureContent?: boolean;
  /**
   * How the page is rasterized.
   *
   * - `"auto"` (default) — use Chrome's experimental HTML-in-Canvas API
   *   (`drawElementImage`) when it is available, else the html-to-image
   *   snapshot. On any browser without the flag this is exactly the snapshot
   *   behaviour.
   * - `"snapshot"` — always html-to-image. Works everywhere; the page is frozen
   *   at activation.
   * - `"live"` — require the experimental API. If it is missing or the capture
   *   throws, warns and falls back to `"snapshot"` (see `liveUnavailable`).
   *
   * Live mode re-captures the page roughly once a second (`liveRefreshMs`)
   * while preserving destruction, so the page keeps updating underneath.
   * Requires `chrome://flags/#canvas-draw-element`. See HTML-IN-CANVAS.md.
   */
  captureMode?: CaptureMode;
  /**
   * Live mode only: how often to re-capture the un-destroyed page, in ms.
   * Default 1000. Set 0 to refresh only via `refreshContent()`.
   */
  liveRefreshMs?: number;
  /** Root element to capture/destroy. Defaults to document.body. */
  contentRoot?: HTMLElement;
  /**
   * Decides which nodes make it into the page capture. Defaults to
   * `defaultCaptureFilter`, which drops `data-ragelayer-ignore` nodes and framework
   * dev-tooling custom elements (Next.js's indicator portal, route
   * announcers, Vite/Astro overlays, …). Replace it to capture everything, or
   * compose with the default to add your own exclusions.
   *
   * html-to-image calls this for every cloned node — element, text, comment —
   * so the parameter is a `Node`. Check `nodeType` (or `instanceof Element`)
   * before touching element-only APIs, and return `true` for non-elements
   * unless you mean to drop raw text from the capture.
   */
  captureFilter?(node: Node): boolean;
  /**
   * Called when part of the engine degrades — capture failed, the text mask
   * could not be built, and so on. Nothing here throws, so this is the only
   * way a host can notice and report that visitors are getting a reduced
   * experience.
   *
   * Registering a handler (here or via `onError`) also silences the matching
   * `console.warn`, so a host that reports these does not get them twice.
   */
  onError?(error: EngineError): void;
  /**
   * Simulate torn-off chunks of the page as rigid bodies that tumble, collide
   * and pile up at the bottom of the viewport. Default true; turning it off
   * leaves every tool working, just without the debris.
   */
  physics?: boolean;
  /** Downward acceleration for that simulation, px/s². Default 1750. */
  gravity?: number;
  /**
   * Run the effects layer through the WebGL post-processing chain (bloom, heat
   * haze, chromatic aberration). Default true, and silently ignored when the
   * browser has no usable WebGL context.
   */
  postFX?: boolean;
  /**
   * Maximum backing-store pixel ratio for transient effects and tool art.
   * Defaults to 1 because supersampling the soft effects layer multiplies its
   * Canvas2D-to-WebGL upload cost without improving the captured page itself.
   * Set up to 2 when visual supersampling matters more than frame rate.
   */
  effectsPixelRatio?: number;
  /**
   * Record the document-space rect of every heading/paragraph/image/card before
   * the DOM is hidden, so the demolition tool can knock real page elements
   * loose as single objects. Default true.
   */
  harvestElements?: boolean;
  /**
   * Shader settings for the destructible page surface — how far a tear refracts
   * the page behind it, how hard its edge catches the light, and so on. Merged
   * over the defaults. Ignored when WebGL2 is unavailable and the page is
   * presented as a plain 2D canvas.
   *
   * Pass `false` to turn shaded presentation off outright and mount the 2D
   * canvas directly, exactly as `postFX: false` does for the effects layer.
   * Useful for A/B-ing a rendering problem: if something still looks wrong with
   * this off, the surface shader is not what is causing it.
   */
  surface?: Partial<SurfaceParams> | false;
  /**
   * Map the page's text lines at capture time so the surface shader can keep
   * glyphs crisp where a tear runs through them. Default true. Costs one pass
   * over the document's text nodes during capture; turn it off on pages with
   * pathological amounts of text, at the price of slightly softer type along
   * torn edges.
   */
  textMask?: boolean;
  /**
   * Retain reversible destruction checkpoints. Disabled by default because a
   * full-page snapshot can be large; `true` uses bounded defaults.
   */
  history?: boolean | HistoryOptions;
}

/** Destructive operations on the rasterized page content. */
export interface ContentApi {
  readonly ready: boolean;
  punch(x: number, y: number, r: number): void;
  burn(x: number, y: number, r: number): void;
  cut(x1: number, y1: number, x2: number, y2: number, options?: CutOptions): void;
  char(x: number, y: number, r: number, alpha: number): void;
  restore(x: number, y: number, r: number): void;
  restoreAll(): void;
  /** Grab a chunk of the pristine page to fling around as a "shard" particle. */
  patch(x: number, y: number, w: number, h: number): ContentPatch | null;
}

/** How a linear cut should treat its edge. */
export interface CutOptions {
  /** `"torn"` chatters and nicks like a saw; `"clean"` keeps a constant laser kerf. */
  edge?: "torn" | "clean";
  /** Kerf width in CSS pixels. The tool-specific default is used when omitted. */
  width?: number;
}

export interface DestroyerEngineApi {
  readonly width: number;
  readonly height: number;
  readonly damageCtx: CanvasRenderingContext2D;
  /**
   * Where decals should be painted: the destructible content canvas when the
   * page capture is live, otherwise the overlay damage canvas.
   */
  readonly surfaceCtx: CanvasRenderingContext2D;
  readonly fxCtx: CanvasRenderingContext2D;
  /** Record a tool interaction and trigger any matching bounded combo. */
  signalInteraction(kind: InteractionKind, x: number, y: number): ComboEvent[];
  onCombo(callback: (event: ComboEvent) => void): () => void;
  readonly historyState: HistoryState;
  /** Save the current persistent page state as an undo checkpoint. */
  checkpoint(label?: string): boolean;
  undo(): boolean;
  redo(): boolean;
  clearHistory(): void;
  /** Real-content destruction ops; null until the page capture is ready. */
  readonly content: ContentApi | null;
  /** Latest once-per-second runtime measurement. */
  readonly performanceSnapshot: PerformanceSnapshot;
  onPerformance(callback: (snapshot: PerformanceSnapshot) => void): () => void;
  /**
   * Content alpha (0..1) at a document point — 1 where the page survives, 0 in
   * the void. Reports 1 when capture is off (no destructible surface, no void).
   */
  pageOpacityAt(x: number, y: number): number;
  /**
   * Whether the page still exists at (x, y). The void is empty space: every
   * tool should ask this before doing surface work, and treat a "no" the way
   * the real world would — a swing that meets nothing, a shot that sails
   * through, a splat with nothing to land on. Only airborne effects (tracers,
   * smoke, debris flying in front of the page) belong over a hole.
   */
  onPage(x: number, y: number, threshold?: number): boolean;
  /**
   * Report a decal painted into `surfaceCtx`, so the shaded page picks it up.
   *
   * Only needed for marks that land well away from the cursor — anything drawn
   * under the pointer while a tool is held is already re-shaded each frame.
   * Harmless to call when the page is presented without the shader.
   */
  markSurface(x: number, y: number, radius: number): void;
  /** As `markSurface`, for a mark that runs along a segment (a stroke, a bolt). */
  markSurfaceSegment(x1: number, y1: number, x2: number, y2: number, radius: number): void;
  /**
   * Cut a traced polygon (x0,y0,x1,y1,… document CSS px) clean out of the page;
   * the enclosed region falls as one rigid piece carrying those pixels.
   * Returns false when the region has too little surviving material or capture
   * isn't ready. Large valid regions are baked with a bounded pixel budget.
   */
  cutout(points: number[]): boolean;
  /**
   * Release every island of surviving page material disconnected inside this
   * document-space region. Unlike `cutout`, this derives shapes from current
   * material connectivity, so earlier holes and page edges participate.
   */
  dislodge(x0: number, y0: number, x1: number, y1: number): number;
  /**
   * Release a crawling bug (default one) that wanders and eats the page.
   * Bugs die to fire, gunshots, fractures, explosions, and black holes —
   * or to `squashBugs`.
   */
  spawnBugs(x: number, y: number, count?: number): void;
  /** Squash bugs within `radius` of (x, y). Returns how many were hit. */
  squashBugs(x: number, y: number, radius: number): number;
  /**
   * Wash bugs off the page within `radius` of (x, y) — they tumble away on
   * the spray instead of leaving a smear. Returns how many were flushed.
   */
  flushBugs(x: number, y: number, radius: number): number;
  readonly flames: Flame[];
  readonly sound: SoundApi;
  /**
   * The unit direction the drawn tool is aiming. Directional effects (a
   * tracer, a rocket, a jet) read this so they line up with the way the tool
   * is visibly pointing. Fixed, because the art holds one pose rather than
   * turning to follow the pointer. Valid in every tool style.
   */
  readonly toolAim: Vec2;
  spawnParticle(p: Particle): void;
  spawnFlame(x: number, y: number, intensity?: number): void;
  /** Damp every flame within `radius` of (x, y) by `amount`. Returns hits. */
  dowseFlames(x: number, y: number, radius: number, amount: number): number;
  /** Repair damage in a circle (broom): restores content + erases overlay marks. */
  eraseDamage(x: number, y: number, radius: number): void;
  /**
   * Rinse stains (paint, soot, smears, rime) off surviving page. Unlike
   * `eraseDamage` this never repairs structure: holes stay holes — water
   * cleans, it doesn't rebuild. `strength` < 1 fades stains gradually.
   */
  washSurface(x: number, y: number, radius: number, strength?: number): void;
  /** Blast content shards out of (x, y) — chunks of the real page fly off. */
  shatter(x: number, y: number, radius?: number): void;
  /**
   * Kick the screen. `dirX`/`dirY` add a directional lurch on top of the
   * omnidirectional rattle — an impact should shove the page away from the
   * blow, not just vibrate it.
   */
  shake(strength?: number, dirX?: number, dirY?: number): void;
  /** Pull loose rigid-body debris toward a document point. Returns the number affected. */
  pullDebris(x: number, y: number, radius: number, strength: number, dt: number): number;
  /** Launch the nearest loose chunk. Returns false when no debris is in range. */
  launchDebris(
    x: number,
    y: number,
    radius: number,
    dirX: number,
    dirY: number,
    speed: number,
  ): boolean;
  clear(): void;
  random(): number;

  // ── Physical destruction ──────────────────────────────────────────────────

  /**
   * Shatter a disc of the page into rigid bodies that fall, collide and settle.
   *
   * Unlike `shatter` (which throws short-lived decorative shards) this removes
   * the region from the page and hands it to the physics world. Returns how
   * many chunks were actually created — 0 if the page capture isn't ready.
   */
  fracture(x: number, y: number, radius: number, options?: FractureOptions): number;
  /** Fracture + blast wave + fireball + fires. The loud one. */
  explode(x: number, y: number, radius: number, options?: ExplodeOptions): void;
  /**
   * Knock the real page element under (x, y) loose as a rigid body — a whole
   * heading, image or card, not a random fragment. False if nothing is there.
   */
  demolish(x: number, y: number): boolean;
  /** Bring the whole visible page down, element by element, over ~2 seconds. */
  collapse(): void;
  /**
   * Add to the heat field that drives the post-processing shimmer. Flames do
   * this automatically; explosions and jets add their own.
   */
  heat(x: number, y: number, radius: number, amount: number): void;
  /** Open, move, or (with null) collapse the singularity. */
  setSingularity(s: Singularity | null): void;
  /** Live singularity, if one is open. */
  readonly singularity: Singularity | null;
}

export interface SoundApi {
  enabled: boolean;
  shot(): void;
  thunk(): void;
  /** Hammer blow: sub-bass punch + woody knock + splinter. `weight` 0..1 scales the low end. */
  hammer(weight?: number): void;
  splat(): void;
  hiss(): void;
  /** Metallic ping of a shell casing hitting something. */
  tink(): void;
  /** Sap-pocket pop inside a fire. */
  pop(): void;
  /** Dry, brittle fracture — glass and plaster giving way. */
  crack(): void;
  /** Soft bristle sweep. */
  sweep(): void;
  /** Deep detonation with a long tail — rockets, black-hole collapse. */
  boom(): void;
  /** Lightning: a bright crack over a rolling rumble. */
  zap(): void;
  /** Rocket motor lighting and leaving. */
  whoosh(): void;
  /** Continuous loops keyed by name; engine calls with target gain each frame. */
  loop(name: "fire" | "water" | "saw" | "flamethrower" | "void", gain: number): void;
}

export type EngineEvent =
  | "toolchange"
  | "clear"
  | "dispose"
  | "statuschange"
  | "pausechange"
  | "historychange"
  | "error";

/**
 * Which part of the engine degraded.
 *
 * Every one of these is survivable — the toy keeps working with less — which
 * is exactly why they are worth reporting: nothing throws, so without this
 * channel a host has no way to tell that visitors are silently getting the
 * overlay-only experience.
 */
export type EngineErrorScope =
  /** Page capture failed; damage falls back to an overlay over the live DOM. */
  | "capture"
  /** Live mode was unavailable or failed; snapshot mode is used instead. */
  | "live-capture"
  /** A live re-capture failed; the previous capture stays on screen. */
  | "live-refresh"
  /** Page furniture could not be measured; the demolition tool has no targets. */
  | "element-harvest"
  /** The text mask could not be built; the shader shades type uniformly. */
  | "text-mask"
  /** The document is taller than the capture cap; content below stays intact. */
  | "page-height";

export interface EngineError {
  scope: EngineErrorScope;
  /** Human-readable summary of what stopped working, and what happens now. */
  message: string;
  /** The underlying failure, when there was one. */
  cause?: unknown;
}
